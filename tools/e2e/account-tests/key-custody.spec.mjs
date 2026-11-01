import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount, loginAccount } from '../../../packages/db/dist/index.js';

test('managed account opens on another device and prepares offline access automatically', async ({ page, browser }) => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const setup = 'test-custody-owner-000000000000000000';
  const server = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true,
    registrationMode: 'open', ownerSetupToken: setup });
  const second = await browser.newContext();
  try {
    await server.ready;
    await listenOnSafePort(server.server, '127.0.0.1');
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'owner', 'owner-test-password', { ownerSetupToken: setup });
    await registerAccount(url, 'managed-user', 'account-test-password');
    const login = async (target) => {
      await target.goto(`${url}/app/`);
      await target.getByLabel('服务器用户名').fill('managed-user');
      await target.getByLabel('服务器账号密码', { exact: true }).fill('account-test-password');
      await target.getByRole('button', { name: '登录', exact: true }).click();
    };
    await login(page);
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    const session = await loginAccount(url, 'managed-user', 'account-test-password');
    const protection = await (await fetch(`${url}/api/v3/protection`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })).json();
    expect(protection.mode).toBe('managed');
    expect(protection.secret).toEqual(expect.any(String));
    const other = await second.newPage();
    await login(other);
    await expect(other.locator('.zc-app-shell')).toBeVisible();
    await other.close();
    await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'offline' } }));
    await page.reload();
    await page.getByRole('button', { name: '离线解锁 managed-user 的缓存' }).click();
    await page.getByLabel('账号密码', { exact: true }).fill('account-test-password');
    await page.getByRole('button', { name: '解锁缓存' }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
  } finally {
    await second.close(); await page.close();
    await closeTestSyncServer(server);
  }
});
