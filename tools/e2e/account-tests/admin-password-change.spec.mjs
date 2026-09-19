/**
 * The console's "change my own password" entry point in a real browser.
 *
 * The unit tests pin the client's call sequence and the server tests pin the authorization
 * rules; this pins what an operator actually gets: a form on the account-security page, a clear
 * refusal for a wrong current password that does not throw them out of the console, and — on
 * success — being returned to the login card with an explanation, because the change revoked
 * every session including the one on screen.
 */
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const accountPassword = ['admin', 'change', 'browser', '0001'].join('-');
const nextPassword = ['admin', 'change', 'browser', '0002'].join('-');
const setupToken = 'e2e-admin-password-change-setup-token-0001';

async function fixture() {
  const server = createSyncServer({
    webDir: resolve(root, 'apps/web/dist'),
    enableWeb: true,
    registrationMode: 'open',
    ownerSetupToken: setupToken,
  });
  await server.ready;
  await server.started;
  await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.server.address().port}`;
  try {
    await registerAccount(url, 'operator', accountPassword, { ownerSetupToken: setupToken });
  } catch (error) {
    server.server.closeAllConnections(); await server.close(); throw error;
  }
  return { url, close: async () => { server.server.closeAllConnections(); await server.close(); } };
}

async function signIn(page, url, password = accountPassword) {
  await page.goto(`${url}/admin/`);
  await page.getByLabel('管理账号用户名').fill('operator');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
}

test('changes the administrator password from the console and signs the console out', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    await page.getByRole('link', { name: '账号安全' }).click();
    await expect(page.getByRole('heading', { name: '账号安全' })).toBeVisible();
    await expect(page.getByText('我的账号密码')).toBeVisible();

    // A wrong current password is refused in the page and must not end the console session: the
    // operator stays on the page and can correct the typo.
    await page.getByLabel('当前账号密码').fill('not-the-current-password');
    await page.getByLabel('新账号密码').fill(nextPassword);
    await page.getByLabel('再次输入新密码').fill(nextPassword);
    await page.getByRole('button', { name: '确认修改账号密码' }).click();
    await expect(page.getByText(/同步用户名或密码错误/)).toBeVisible();
    await expect(page.getByRole('heading', { name: '账号安全' })).toBeVisible();

    // The real change: the console ends up signed out with an explanation, because the change
    // revokes every session of the account, this console's included.
    await page.getByLabel('当前账号密码').fill(accountPassword);
    await page.getByRole('button', { name: '确认修改账号密码' }).click();
    await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('账号密码已修改');

    // The new password works and the old one does not, checked against the server itself.
    await expect(loginAccount(f.url, 'operator', accountPassword)).rejects.toThrow();
    await expect(loginAccount(f.url, 'operator', nextPassword)).resolves.toBeDefined();

    // And the console can log back in with the new password. The URL is still the account page
    // from before the change, so this asserts the console shell came back rather than the
    // overview: the console restores whatever page the operator was on.
    await page.getByLabel('管理账号密码').fill(nextPassword);
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出管理后台' })).toBeVisible();
    await expect(page.getByText('operator · 所有者')).toBeVisible();
  } finally { await f.close(); }
});
