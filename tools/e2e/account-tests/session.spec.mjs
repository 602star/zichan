import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let server;
let baseUrl;

test.beforeAll(async () => {
  server = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true, basePath: '/ledger' });
  await server.ready;
  await listenOnSafePort(server.server, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${server.server.address().port}`;
});

test.afterAll(async () => { if (server) await closeTestSyncServer(server); });

test('uses real same-origin browser cookies without storing account passwords or exposing refresh secrets', async ({ page, context }) => {
  const password = 'browser-test-account-password';
  await page.goto(`${baseUrl}/ledger/app/`);
  await expect(page.getByRole('heading', { name: '账号登录' })).toBeVisible();
  await expect(page.getByLabel('完整服务器地址')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^纯本地使用/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '初始化管理员' })).toHaveCount(0);
  await page.goto(`${baseUrl}/ledger/e2e-private-entry/admin/`);
  await page.getByLabel('管理账号用户名').fill('browser-owner');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '创建所有者并进入后台' }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
  await page.getByRole('link', { name: '打开记账应用' }).click();
  await expect(page.getByRole('heading', { name: '账号登录' })).toBeVisible();
  await page.getByLabel('服务器用户名').fill('browser-owner');
  await page.getByLabel('服务器账号密码').fill(password);
  const loginResponse = page.waitForResponse((response) => response.url().endsWith('/api/auth/login/finish'));
  await page.getByRole('button', { name: '登录' }).click();
  const response = await loginResponse;
  expect(response.status()).toBe(200);
  const session = await response.json();
  expect(session.sessionTransport).toBe('cookie');
  expect(session.refreshToken).toBeUndefined();
  expect(session.accountId).toMatch(/^account-[a-f0-9]{32}$/);
  await expect(page.getByRole('button', { name: '开始记账', exact: true })).toBeVisible();
  const cookie = (await context.cookies()).find((row) => row.name === 'zichan_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  expect(cookie?.path).toBe('/ledger/api/auth');
  const storage = await page.evaluate(() => ({
    cookies: document.cookie,
    values: JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  }));
  expect(storage.cookies).not.toContain('zichan_session');
  expect(storage.values).not.toContain(password);
  expect(storage.values).not.toContain(session.accessToken);
  expect(storage.values).not.toContain(cookie.value);
  const refreshed = await page.evaluate(async () => {
    const response = await fetch('/ledger/api/auth/refresh', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Zichan-Session': 'cookie' }, body: '{}',
    });
    return { status: response.status, body: await response.json() };
  });
  expect(refreshed.status).toBe(200);
  expect(refreshed.body.refreshToken).toBeUndefined();
  expect(refreshed.body.accountId).toBe(session.accountId);
  await page.getByRole('button', { name: '开始记账', exact: true }).click();
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await page.locator('.zc-sidebar').getByRole('button', { name: /我的账号$/ }).click();
  const other = await context.newPage();
  await other.goto(`${baseUrl}/ledger/app/`);
  await page.getByRole('button', { name: '退出记账账号', exact: true }).click();
  await page.getByRole('button', { name: '确认退出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号登录' })).toBeVisible();
  await expect(other.getByRole('heading', { name: '账号登录' })).toBeVisible();
  await other.close();
  await expect(page.getByText(/服务器会话已撤销/)).toBeVisible();
  expect((await context.cookies()).some((value) => value.name === 'zichan_admin_session')).toBe(true);
  await page.getByLabel('服务器用户名').fill('different-user');
  await page.getByLabel('服务器账号密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('服务器用户名').fill('browser-owner');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  const revoked = await page.evaluate(async ({ token }) => {
    const logout = await fetch('/ledger/api/auth/logout', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'X-Zichan-Session': 'cookie', Authorization: `Bearer ${token}` },
    });
    const refresh = await fetch('/ledger/api/auth/refresh', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Zichan-Session': 'cookie' }, body: '{}',
    });
    return { logout: logout.status, refresh: refresh.status };
  }, { token: refreshed.body.accessToken });
  expect(revoked).toEqual({ logout: 200, refresh: 401 });
});
