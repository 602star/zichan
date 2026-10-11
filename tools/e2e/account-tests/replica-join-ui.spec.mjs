import { test, expect } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { SyncServerStore } from '../../../apps/sync-server/dist/store.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'replica-join-browser-password';
const setupToken = 'replica-join-setup-secret-000000';

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
  await page.getByRole('button', { name: '查看数据保护与副本状态' }).click();
  const replica = page.getByRole('region', { name: '账本副本' });
  await expect(replica).toBeVisible();
  const settings = page.getByRole('button', { name: /^客户端同步与服务器连接/ });
  if (await settings.getAttribute('aria-expanded') !== 'true') {
    await replica.getByRole('button', { name: '配置节点连接' }).click();
  }
  await expect(settings).toHaveAttribute('aria-expanded', 'true');
}

async function addAdminProfile(page, url, alias, username) {
  await page.getByRole('button', { name: '新增服务器' }).click();
  await page.getByLabel('完整服务器地址').fill(url);
  await page.getByRole('button', { name: '保存地址', exact: true }).click();
  await page.getByLabel('中文别名').fill(alias);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('服务器账号密码', { exact: true })).toHaveValue('');
  await expect(page.getByText(`${alias}（${username}）登录未完成：`, { exact: false })).toHaveCount(0);
  await expect(page.getByLabel(`启用 ${alias}`, { exact: true })).not.toBeChecked();
}

test.setTimeout(120_000);

test('admin joins two empty nodes through the browser replica controls', async ({ page }) => {
  page.setDefaultTimeout(20_000);
  const dataRoot = mkdtempSync(join(tmpdir(), 'zichan-replica-join-ui-'));
  const nodes = [];
  const stores = [];
  try {
    for (const [index, name] of ['hub', 'home', 'office'].entries()) {
      const node = createSyncServer({ dataDir: join(dataRoot, name), registrationMode: 'open',
        ownerSetupToken: setupToken, allowInsecureHttp: true,
        webDir: resolve(root, 'apps/web/dist'), enableWeb: true });
      nodes.push(node);
      await node.ready;
      node.url = await listen(node, `127.0.0.${index + 1}`);
    }
    const [hub, home, office] = nodes;
    await registerAccount(hub.url, 'ledger-owner', password, { ownerSetupToken: setupToken });
    await registerAccount(home.url, 'home-admin', password, { ownerSetupToken: setupToken });
    await registerAccount(office.url, 'office-admin', password, { ownerSetupToken: setupToken });
    await page.goto(`${hub.url}/app/`);
    await page.getByLabel('服务器用户名').fill('ledger-owner');
    await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录已有账号' }).click();
    await page.getByRole('button', { name: '创建个人账本' }).click();
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await page.keyboard.press('Escape');
    await openSync(page);
    await page.getByRole('button', { name: '同步此服务器', exact: true }).click();
    await expect(page.getByRole('button', { name: '同步此服务器', exact: true })).toBeEnabled();

    await addAdminProfile(page, home.url, '家庭节点', 'home-admin');
    await addAdminProfile(page, office.url, '办公节点', 'office-admin');
    const replica = page.getByRole('region', { name: '账本副本' });
    const hubHealth = await (await fetch(`${hub.url}/api/health`)).json();
    for (const [node, alias] of [[home, '家庭节点'], [office, '办公节点']]) {
      const targetHealth = await (await fetch(`${node.url}/api/health`)).json();
      await replica.getByLabel('加入节点').selectOption({ label: alias });
      await replica.getByRole('button', { name: '建立 / 续签复制' }).click();
      await expect(replica).toContainText('请在两台服务器本机核对节点签名公钥');
      await expect(replica).toContainText(hubHealth.nodePublicKey);
      await expect(replica).toContainText(targetHealth.nodePublicKey);
      await replica.getByRole('button', { name: '确认身份并建立复制' }).click();
      await expect(replica).toContainText(`${alias} 已加入`);
    }

    for (const node of nodes) {
      const store = new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId);
      stores.push(store);
      await store.ready;
    }
    const source = await stores[0].getReplica('ledger-owner');
    expect(source).toBeTruthy();
    await expect.poll(async () => {
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      const sourceInventory = await stores[0].replicaInventory('ledger-owner', source.ledgerId);
      if (!sourceInventory.commitCount) return false;
      for (const store of stores.slice(1)) {
        const links = await store.listNodeReplicationLinks();
        if (links.length !== 1 || links[0].ledgerId !== source.ledgerId) return false;
        const targetInventory = await store.replicaInventory(links[0].username, source.ledgerId);
        if (targetInventory.commitHash !== sourceInventory.commitHash) return false;
      }
      return true;
    }, { timeout: 45_000 }).toBe(true);
    const owner = await loginAccount(hub.url, 'ledger-owner', password);
    await expect.poll(async () => {
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      const response = await fetch(`${hub.url}/api/v4/ledger/group-health`, {
        headers: { Authorization: `Bearer ${owner.accessToken}` },
      });
      expect(response.status).toBe(200);
      return response.json();
    }, { timeout: 45_000 }).toMatchObject({
      state: 'READY', memberCount: 3, readyCount: 3, issues: [],
    });
    await replica.getByRole('button', { name: '刷新状态' }).click();
    await expect(replica).toContainText('看到的副本组： READY · 3/3 节点就绪');
    await expect(replica).toContainText('家庭节点');
    await expect(replica).toContainText('办公节点');
    await replica.getByRole('button', { name: '重扫并补传' }).click();
    await expect(replica).toContainText('已从头重扫这条链路');
    await expect.poll(async () => {
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      const response = await fetch(`${hub.url}/api/v4/ledger/group-health`, {
        headers: { Authorization: `Bearer ${owner.accessToken}` },
      });
      expect(response.status).toBe(200);
      return response.json();
    }, { timeout: 45_000 }).toMatchObject({
      state: 'READY', memberCount: 3, readyCount: 3, issues: [],
    });
  } finally {
    await page.close();
    await Promise.all(stores.map((store) => store.close()));
    for (const node of nodes) node.server.closeAllConnections();
    await Promise.all(nodes.map((node) => node.close()));
    const safePrefix = `${resolve(tmpdir())}${sep}zichan-replica-join-ui-`;
    if (!resolve(dataRoot).startsWith(safePrefix)) throw new Error('unsafe replica join test directory');
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
