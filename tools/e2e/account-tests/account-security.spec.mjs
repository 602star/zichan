import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount, loginAccount } from '../../../packages/db/dist/index.js';

test('changes account password and revokes only a selected own device', async ({ page }) => {
  const setup = 'test-security-owner-000000000000000';
  const server = createSyncServer({ webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken: setup });
  try {
    await server.ready;
    await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'owner', 'owner-test-password', { ownerSetupToken: setup });
    await registerAccount(url, 'security-user', 'account-test-password');
    const other = await loginAccount(url, 'security-user', 'account-test-password', { deviceName: '另一部手机' });
    await page.goto(`${url}/app/`);
    await page.getByLabel('服务器用户名').fill('security-user');
    await page.getByLabel('服务器账号密码').fill('account-test-password');
    await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).click();
    await page.getByRole('button', { name: '关闭快速记账' }).click();
    await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
    const panel = page.getByRole('region', { name: '账号安全', exact: true });
    await panel.getByText('登录设备', { exact: true }).click();
    await panel.getByRole('button', { name: '刷新登录设备' }).click();
    await expect(panel).toContainText('另一部手机');
    await panel.getByRole('button', { name: '退出此设备' }).click();
    await expect(panel).toContainText('已撤销该设备');
    expect((await fetch(`${url}/api/auth/me`, { headers: { Authorization: `Bearer ${other.accessToken}` } })).status).toBe(401);
    await panel.getByText('修改账号密码', { exact: true }).click();
    await panel.getByLabel('当前账号密码', { exact: true }).fill('account-test-password');
    await panel.getByLabel('修改后的账号密码').fill('new-account-password');
    await panel.getByLabel('再次输入新密码').fill('new-account-password');
    await panel.getByRole('button', { name: '确认修改账号密码' }).click();
    await expect(page.getByRole('button', { name: '登录已有账号', exact: true })).toBeVisible();
    await page.getByLabel('服务器用户名').fill('security-user');
    await page.getByLabel('服务器账号密码').fill('new-account-password');
    await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await expect(page.getByRole('button', { name: '直接开始记支出', exact: true })).toHaveCount(0);
  } finally { await page.close(); const closing = server.close(); server.server.closeAllConnections(); await closing; }
});
