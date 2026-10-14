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

async function postAdmin(node, token, path, body) {
  const response = await fetch(`${node.url}/api/admin${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.status, text).toBe(201);
  return JSON.parse(text);
}

test.setTimeout(120_000);

test('a new user sees simple server-copy status after administrators join three nodes', async ({ page }) => {
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
    await page.locator('.zc-sidebar').getByRole('button', { name: /我的账号$/ }).click();
    await page.getByRole('button', { name: '查看服务器上的账本' }).click();
    const replica = page.getByRole('region', { name: '服务器上的账本' });
    await expect(replica).toContainText('当前服务器未加入同步组');
    await expect(replica.getByLabel('加入节点')).toHaveCount(0);

    const owner = await loginAccount(hub.url, 'ledger-owner', password);
    await postAdmin(hub, owner.accessToken, '/sync-group/create', { mainUrl: hub.url });
    for (const [node, username] of [[home, 'home-admin'], [office, 'office-admin']]) {
      const code = await postAdmin(hub, owner.accessToken, '/sync-group/join-token', {});
      const admin = await loginAccount(node.url, username, password);
      await postAdmin(node, admin.accessToken, '/sync-group/join', {
        mainUrl: hub.url, localUrl: node.url, token: code.token,
      });
    }
    for (const node of nodes) {
      const store = new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId);
      stores.push(store);
      await store.ready;
    }
    const source = await stores[0].getReplica('ledger-owner');
    expect(source).toBeTruthy();
    await expect.poll(async () => {
      await Promise.all([home.flushGroupReplication(), office.flushGroupReplication()]);
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      const sourceInventory = await stores[0].replicaInventory('ledger-owner', source.ledgerId);
      for (const store of stores.slice(1)) {
        const links = await store.listNodeReplicationLinks();
        if (links.length !== 1 || links[0].ledgerId !== source.ledgerId) return false;
        const target = await store.replicaInventory(links[0].username, source.ledgerId);
        if (target.commitHash !== sourceInventory.commitHash) return false;
      }
      return true;
    }, { timeout: 45_000 }).toBe(true);
    await replica.getByRole('button', { name: '刷新状态' }).click();
    await expect(replica).toContainText(/\d\/3 台服务器已就绪/);
    await expect(replica).toContainText(new URL(home.url).host);
    await expect(replica).toContainText(new URL(office.url).host);
    await expect(replica.getByRole('button', { name: '重扫并补传' })).toHaveCount(0);
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
