import { closeTestSyncServer } from '../safe-listen.mjs';
import { test, expect } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { SyncServerStore } from '../../../apps/sync-server/dist/store.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'three-site-owner-password';
const setupToken = 'three-site-owner-setup-secret-000000';

async function listen(node, host) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = randomInt(20_000, 49_000);
    try {
      await new Promise((done, fail) => {
        const onError = (error) => { node.server.off('listening', onListening); fail(error); };
        const onListening = () => { node.server.off('error', onError); done(); };
        node.server.once('error', onError);
        node.server.once('listening', onListening);
        node.server.listen(port, host);
      });
      return `http://${host}:${port}`;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No available test port on ${host}`);
}

async function openSync(page) {
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await page.locator('.zc-sidebar').getByRole('button', { name: /我的账号$/ }).click();
  await page.getByRole('button', { name: '查看服务器上的账本' }).click();
  const settings = page.getByRole('button', { name: /^客户端同步与服务器连接/ });
  if (await settings.getAttribute('aria-expanded') !== 'true') await settings.click();
}

async function addNodeAdmin(page, url, alias, username) {
  await page.getByRole('button', { name: '新增服务器' }).click();
  await page.getByLabel('完整服务器地址').fill(url);
  await page.getByRole('button', { name: '保存地址', exact: true }).click();
  await page.getByLabel('中文别名').fill(alias);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('服务器账号密码', { exact: true })).toHaveValue('');
  await expect(page.getByLabel(`启用 ${alias}`, { exact: true })).not.toBeChecked();
}

async function postAdmin(node, token, path, body) {
  const response = await fetch(`${node.url}/api/admin${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.status, text).toBe(201);
  return JSON.parse(text);
}

async function syncCurrentSite(page) {
  await openSync(page);
  const sync = page.getByRole('button', { name: '同步账本', exact: true }).first();
  await sync.click();
  const outcome = page.getByText(/^(?:本机提交已|已完成 \d+ 轮同步|同步失败：|本次同步：)/).first();
  await expect(outcome).toBeVisible({ timeout: 20_000 });
  const outcomeText = await outcome.innerText();
  expect(outcomeText).not.toMatch(/^同步失败：/);
  if (outcomeText.startsWith('本次同步：')) expect(outcomeText).toContain('已收敛');
  await expect(sync).toBeEnabled();
}

async function saveExpense(page, amount, note) {
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await page.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
  await page.getByRole('button', { name: /^\+ 记(支出|账)$/ }).click();
  await page.getByRole('textbox', { name: /^金额/ }).fill(amount);
  await page.getByLabel('描述').fill(note);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
}

async function inventory(store, username, ledgerId) {
  return store.replicaInventory(username, ledgerId);
}

async function revisitSite(page, url) {
  await page.goto(`${url}/`);
  await expect(page.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });
}

// This exercises several real HTTP servers, browser databases and replication rounds.
test.setTimeout(300_000);

test('records on three separate websites and converges their server replicas', async ({ page }) => {
  page.setDefaultTimeout(20_000);
  const dataRoot = mkdtempSync(join(tmpdir(), 'zichan-three-site-web-'));
  const nodes = [];
  const stores = [];
  try {
    const hosts = ['127.0.0.1', '127.0.0.2', '127.0.0.3'];
    for (const [index, name] of ['hub', 'home', 'office'].entries()) {
      const node = createSyncServer({ dataDir: join(dataRoot, name), registrationMode: 'open',
        ownerSetupToken: setupToken, allowInsecureHttp: true,
        webDir: resolve(root, 'apps/web/dist'), enableWeb: true });
      nodes.push(node);
      await node.ready;
      node.url = await listen(node, hosts[index]);
    }
    const [hub, home, office] = nodes;
    await registerAccount(hub.url, 'owner', password, { ownerSetupToken: setupToken });
    await registerAccount(home.url, 'home-admin', password, { ownerSetupToken: setupToken });
    await registerAccount(office.url, 'office-admin', password, { ownerSetupToken: setupToken });
    await page.goto(`${hub.url}/`);
    await page.getByLabel('服务器用户名').fill('owner');
    await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await saveExpense(page, '10.01', 'hub-entry');
    await syncCurrentSite(page);

    for (const node of nodes) {
      const store = new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId);
      stores.push(store);
      await store.ready;
    }
    const owner = await loginAccount(hub.url, 'owner', password);
    const protectionResponse = await fetch(`${hub.url}/api/v3/protection`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    });
    expect(protectionResponse.ok).toBe(true);
    const protection = await protectionResponse.json();
    expect(protection.mode).toBe('managed');
    expect(protection.secret).toBeTruthy();
    const ledgerId = protection.replica.ledgerId;
    await expect.poll(async () => (await inventory(stores[0], 'owner', ledgerId)).commitCount).toBeGreaterThan(0);
    await postAdmin(hub, owner.accessToken, '/sync-group/create', { mainUrl: hub.url });
    for (const [node, username] of [[home, 'home-admin'], [office, 'office-admin']]) {
      const code = await postAdmin(hub, owner.accessToken, '/sync-group/join-token', {});
      const admin = await loginAccount(node.url, username, password);
      await postAdmin(node, admin.accessToken, '/sync-group/join', {
        mainUrl: hub.url, localUrl: node.url, token: code.token,
      });
    }
    await Promise.all([home.flushGroupReplication(), office.flushGroupReplication()]);
    await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
    await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);

    for (const [index, node, amount, note] of [
      [1, home, '20.02', 'home-entry'], [2, office, '30.03', 'office-entry'],
    ]) {
      await page.goto(`${node.url}/`);
      await page.getByLabel('服务器用户名').fill('owner');
      await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });
      await saveExpense(page, amount, note);
      await syncCurrentSite(page);
      await expect.poll(async () => (await inventory(stores[index],
        (await stores[index].listNodeReplicationLinks())[0].username, ledgerId)).commitCount)
        .toBeGreaterThan(1);
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
    }
    await expect.poll(async () => {
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      const inventories = await Promise.all(stores.map(async (store, index) =>
        inventory(store, index === 0 ? 'owner'
          : (await store.listNodeReplicationLinks())[0].username, ledgerId)));
      const counts = inventories.map((item) => item.commitCount);
      const hashes = inventories.map((item) => item.commitHash);
      return new Set(counts).size === 1 && new Set(hashes).size === 1 && counts[0] >= 4 ? counts[0] : 0;
    }, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
    await syncCurrentSite(page);
    await page.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    for (const note of ['hub-entry', 'home-entry', 'office-entry']) {
      await expect(page.getByText(note, { exact: true })).toBeVisible();
    }
    await page.goto(`${hub.url}/`);
    await syncCurrentSite(page);
    await page.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    for (const note of ['hub-entry', 'home-entry', 'office-entry']) {
      await expect(page.getByText(note, { exact: true })).toBeVisible();
    }

    await revisitSite(page, home.url);
    const hubAddress = new URL(hub.url);
    const closeHub = new Promise((done, fail) => hub.server.close((error) => error ? fail(error) : done()));
    hub.server.closeAllConnections();
    await closeHub;
    await expect(fetch(`${hub.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    const homeUsername = (await stores[1].listNodeReplicationLinks())[0].username;
    const officeUsername = (await stores[2].listNodeReplicationLinks())[0].username;
    const homeBefore = (await inventory(stores[1], homeUsername, ledgerId)).commitCount;
    await saveExpense(page, '40.04', 'home-hub-offline');
    await syncCurrentSite(page);
    await expect.poll(async () => (await inventory(stores[1], homeUsername, ledgerId)).commitCount)
      .toBeGreaterThan(homeBefore);
    await revisitSite(page, office.url);
    const officeBefore = (await inventory(stores[2], officeUsername, ledgerId)).commitCount;
    await saveExpense(page, '50.05', 'office-hub-offline');
    await syncCurrentSite(page);
    await expect.poll(async () => (await inventory(stores[2], officeUsername, ledgerId)).commitCount)
      .toBeGreaterThan(officeBefore);
    await new Promise((done, fail) => {
      hub.server.once('error', fail);
      hub.server.listen(Number(hubAddress.port), hubAddress.hostname, () => {
        hub.server.off('error', fail);
        done();
      });
    });
    await expect.poll(async () => {
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      const inventories = await Promise.all([
        inventory(stores[0], 'owner', ledgerId),
        inventory(stores[1], homeUsername, ledgerId),
        inventory(stores[2], officeUsername, ledgerId),
      ]);
      return inventories.every((item) => item.commitCount === inventories[0].commitCount
        && item.commitHash === inventories[0].commitHash)
        ? inventories[0].commitCount : 0;
    }, { timeout: 45_000 }).toBeGreaterThanOrEqual(6);
    await syncCurrentSite(page);
    await page.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    for (const note of ['hub-entry', 'home-entry', 'office-entry',
      'home-hub-offline', 'office-hub-offline']) {
      await expect(page.getByText(note, { exact: true })).toBeVisible();
    }
    await revisitSite(page, hub.url);
    await syncCurrentSite(page);
    await page.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    for (const note of ['hub-entry', 'home-entry', 'office-entry',
      'home-hub-offline', 'office-hub-offline']) {
      await expect(page.getByText(note, { exact: true })).toBeVisible();
    }
    for (const node of [home, office, hub]) {
      await revisitSite(page, node.url);
      await syncCurrentSite(page);
    }
    await expect.poll(async () => {
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      const response = await fetch(`${hub.url}/api/v4/ledger/group-health`, {
        headers: { Authorization: `Bearer ${owner.accessToken}` },
      });
      expect(response.status).toBe(200);
      return response.json();
    }, { timeout: 30_000 }).toMatchObject({ state: 'READY', memberCount: 3, readyCount: 3, issues: [] });

    // A saved site may still be open after its node is removed. With another
    // configured member, its pending client commit must use that member.
    await revisitSite(page, home.url);
    await openSync(page);
    await addNodeAdmin(page, hub.url, '公网节点', 'owner');
    await page.getByLabel('启用 公网节点', { exact: true }).check();
    const oldReplica = await stores[1].getReplicaForLedger(homeUsername, ledgerId);
    expect(oldReplica).toBeTruthy();
    const hubReplica = await stores[0].getReplicaForLedger('owner', ledgerId);
    expect(hubReplica).toBeTruthy();
    expect(await stores[0].retireReplicaGroupMember('owner', hubReplica.replicaId, home.serverId)).toBe(true);
    await expect.poll(async () => {
      await home.flushNodeReplication();
      return stores[1].replicaRetirement(oldReplica.replicaId);
    }, { timeout: 20_000 }).toMatchObject({ sourceNodeId: hub.serverId });
    const oldCount = (await inventory(stores[1], homeUsername, ledgerId)).commitCount;
    const hubCount = (await inventory(stores[0], 'owner', ledgerId)).commitCount;
    await saveExpense(page, '60.06', 'home-site-after-retirement');
    await syncCurrentSite(page);
    await expect(page.getByRole('cell', { name: '已移出副本组' })).toBeVisible();
    await expect.poll(async () => (await inventory(stores[0], 'owner', ledgerId)).commitCount,
      { timeout: 30_000 }).toBeGreaterThan(hubCount);
    expect((await inventory(stores[1], homeUsername, ledgerId)).commitCount).toBe(oldCount);
    await expect.poll(async () => {
      await office.flushNodeReplication();
      const [publicInventory, officeInventory] = await Promise.all([
        inventory(stores[0], 'owner', ledgerId),
        inventory(stores[2], officeUsername, ledgerId),
      ]);
      return publicInventory.commitCount > hubCount
        && publicInventory.commitCount === officeInventory.commitCount
        && publicInventory.commitHash === officeInventory.commitHash
        ? publicInventory.commitCount : 0;
    }, { timeout: 30_000 }).toBeGreaterThan(hubCount);
    await revisitSite(page, hub.url);
    await syncCurrentSite(page);
    await page.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    await expect(page.getByText('home-site-after-retirement', { exact: true })).toBeVisible();
  } finally {
    await page.close();
    await Promise.all(stores.map((store) => store.close()));
    await Promise.all(nodes.map((node) => closeTestSyncServer(node)));
    const safePrefix = `${resolve(tmpdir())}${sep}zichan-three-site-web-`;
    if (!resolve(dataRoot).startsWith(safePrefix)) throw new Error('unsafe three-site test directory');
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
