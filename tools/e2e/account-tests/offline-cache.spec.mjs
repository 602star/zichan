import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

for (const backendFailure of ['disconnected', 'http503']) test(`unlocks an account cache with ${backendFailure} when the app shell is available, then reconnects`, async ({ page }) => {
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
    await page.addInitScript((online) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online }), backendFailure === 'http503');
    await page.route('**/api/**', (route) => backendFailure === 'http503'
      ? route.fulfill({ status: 503, contentType: 'text/html', body: '<html>Server unavailable</html>' })
      : route.abort('internetdisconnected'));
    await page.reload();
    await page.getByRole('button', { name: '离线解锁 offline-user 的缓存' }).click();
    await page.getByLabel('本机数据密码', { exact: true }).fill('offline-cache-password');
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await page.unroute('**/api/**');
    const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/auth/refresh') && response.status() === 200);
    if (backendFailure === 'http503') await page.reload();
    else await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); });
    await refreshed;
    if (backendFailure === 'http503') {
      for (const status of [401, 403]) {
        await page.route('**/api/auth/refresh', (route) => route.fulfill({ status, json: { error: 'denied' } }));
        await page.reload();
        await expect(page.getByRole('heading', { name: '账号登录', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '离线解锁 offline-user 的缓存' })).toHaveCount(0);
        await page.unroute('**/api/auth/refresh');
      }
      await page.route('**/api/health', (route) => route.fulfill({ json: { serverId: 'different-server', serverPublicKey: 'changed-key' } }));
      await page.reload();
      await expect(page.getByText(/服务器身份已变化，请联系部署者/)).toBeVisible();
      await expect(page.getByRole('button', { name: '离线解锁 offline-user 的缓存' })).toHaveCount(0);
    }
  } finally { await page.close(); server.server.closeAllConnections(); await server.close(); }
});
