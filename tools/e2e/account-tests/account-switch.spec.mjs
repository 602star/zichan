import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('registers distinct accounts and keeps their database, keys and caches isolated', async ({ page, context }) => {
  const setup = 'test-account-switch-owner-000000000000';
  const server = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken: setup });
  try {
    await server.ready;
    await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'owner', 'test-owner-password', { ownerSetupToken: setup });
    async function register(username) {
      await page.getByRole('button', { name: '注册新账号', exact: true }).click();
      await page.getByLabel('服务器用户名').fill(username);
      await page.getByLabel('服务器账号密码', { exact: true }).fill('account-test-password');
      await page.getByLabel('确认账号密码').fill('different-password');
      await page.getByRole('button', { name: '注册并登录', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('两次输入');
      await page.getByLabel('确认账号密码').fill('account-test-password');
      await page.getByRole('button', { name: '注册并登录', exact: true }).click();
      await expect(page.getByLabel('本机数据密码', { exact: true })).toBeVisible();
    }
    async function createCache(password) {
      await page.getByLabel('本机数据密码', { exact: true }).fill(password);
      await page.getByLabel('再输入一次', { exact: true }).fill(password);
      await page.getByRole('button', { name: '创建并打开', exact: true }).click();
      await page.getByRole('button', { name: '直接开始记支出', exact: true }).click();
      await expect(page.locator('.zc-app-shell')).toBeVisible();
      await page.getByRole('button', { name: '关闭快速记账' }).click();
    }
    async function logout() {
      await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
      await page.getByRole('button', { name: '退出记账账号', exact: true }).click();
      await page.getByRole('button', { name: '确认退出', exact: true }).click();
      await expect(page.getByRole('heading', { name: '账号登录' })).toBeVisible();
    }
    await page.goto(`${url}/app/`);
    await register('alice'); await createCache('alice-cache-password');
    const alice = await page.evaluate(() => ({ binding: JSON.parse(localStorage.getItem('zichan.web-account.v2.binding')), envelopes: Object.keys(localStorage).filter((key) => key.endsWith('zichan.device.storageEnvelope.v1')), databases: [] }));
    const namesA = await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name));
    expect(namesA).toHaveLength(1);
    await logout();
    await register('bob'); await createCache('bob-cache-password');
    const namesB = await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name));
    expect(namesB).toHaveLength(2);
    expect(namesB).toEqual(expect.arrayContaining(namesA));
    expect((await page.evaluate(() => Object.keys(localStorage).filter((key) => key.endsWith('zichan.device.storageEnvelope.v1'))))).toHaveLength(2);
    await logout();
    await page.getByLabel('服务器用户名').fill('alice');
    await page.getByLabel('服务器账号密码', { exact: true }).fill('account-test-password');
    await page.getByRole('button', { name: '登录已有账号' }).click();
    await expect(page.getByRole('button', { name: '解锁', exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zichan.web-account.v2.binding')).accountId)).toBe(alice.binding.accountId);
    await page.getByLabel('本机数据密码', { exact: true }).fill('bob-cache-password');
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toHaveCount(0);
    await page.getByLabel('本机数据密码', { exact: true }).fill('alice-cache-password');
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await context.clearCookies();
    await page.reload();
    await expect(page.getByRole('heading', { name: '账号登录' })).toBeVisible();
    await expect(page.getByLabel('本机数据密码', { exact: true })).toHaveCount(0);
  } finally { server.server.closeAllConnections(); await server.close(); }
});
