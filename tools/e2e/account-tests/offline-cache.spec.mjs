import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

test('unlocks an account cache with APIs offline when the app shell is available, then reconnects', async ({ page }) => {
  const setup = 'test-offline-cache-owner-00000000000';
  const server = createSyncServer({ webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken: setup });
  try {
    await server.ready;
    await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'owner', 'owner-test-password', { ownerSetupToken: setup });
    await registerAccount(url, 'offline-user', 'account-test-password');
    await page.goto(`${url}/app/`);
    await page.getByLabel('服务器用户名').fill('offline-user');
    await page.getByLabel('服务器账号密码').fill('account-test-password');
    await page.getByRole('button', { name: '登录已有账号' }).click();
    await page.getByLabel('本机数据密码', { exact: true }).fill('offline-cache-password');
    await page.getByLabel('再输入一次', { exact: true }).fill('offline-cache-password');
    await page.getByRole('button', { name: '创建并打开' }).click();
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    // Deliberately leave document/assets available: this tests the offline data path, not SW cold start.
    await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
    await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
    await page.reload();
    await page.getByRole('button', { name: '离线解锁 offline-user 的缓存' }).click();
    await page.getByLabel('本机数据密码', { exact: true }).fill('offline-cache-password');
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await page.unroute('**/api/**');
    const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/auth/refresh') && response.status() === 200);
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); });
    await refreshed;
  } finally { server.server.closeAllConnections(); await server.close(); }
});
