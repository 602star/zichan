import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';

test('changing proxy hops allows both sessions and expired login states show an actionable message', async ({ browser }) => {
  const setup = 'login-source-browser-setup-000000000000';
  const server = createSyncServer({ enableWeb: true, registrationMode: 'open', ownerSetupToken: setup,
    webDir: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
    trustedProxies: ['loopback'], allowInsecureHttp: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await server.ready; await listenOnSafePort(server.server, '127.0.0.1');
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'source-owner', 'source-test-password', { ownerSetupToken: setup });
    let expireNext = true;
    await context.route('**/api/auth/login/**', route => {
      const finish = route.request().url().endsWith('/finish');
      if (finish && expireNext) {
        expireNext = false;
        return route.fulfill({ status: 410, json: { code: 'LOGIN_STATE_EXPIRED', error: '登录验证已超时，请重新登录' } });
      }
      return route.continue({ headers: { ...route.request().headers(),
        'x-forwarded-for': finish ? '104.22.101.161' : '104.22.101.160' } });
    });
    const ledger = await context.newPage();
    await ledger.goto(url);
    await ledger.getByLabel('服务器用户名').fill('source-owner');
    await ledger.getByLabel('服务器账号密码', { exact: true }).fill('source-test-password');
    await ledger.getByRole('button', { name: '登录', exact: true }).click();
    await expect(ledger.getByRole('alert')).toHaveText('登录验证已超时，请重新登录');
    await ledger.getByRole('button', { name: '登录', exact: true }).click();
    await ledger.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(ledger.locator('.zc-app-shell')).toBeVisible();

    const admin = await context.newPage();
    await admin.goto(`${url}/e2e-private-entry/admin/`);
    await admin.getByLabel('管理账号用户名').fill('source-owner');
    await admin.getByLabel('管理账号密码').fill('source-test-password');
    await admin.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(admin.getByRole('heading', { name: '运行概览', exact: true })).toBeVisible();
    expect((await context.cookies()).map(cookie => cookie.name))
      .toEqual(expect.arrayContaining(['zichan_session_v2', 'zichan_admin_session']));
    for (const [page, transport] of [[ledger, 'cookie'], [admin, 'admin-cookie']]) {
      expect(await page.evaluate(async transport => {
        const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Zichan-Session': transport }, body: '{}' });
        return response.status;
      }, transport)).toBe(200);
    }
    await ledger.reload();
    await expect(ledger.locator('.zc-app-shell')).toBeVisible();
    await admin.reload();
    await expect(admin.getByRole('heading', { name: '运行概览', exact: true })).toBeVisible();
  } finally { await context.close(); await closeTestSyncServer(server); }
});
