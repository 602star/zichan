import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let server;
let baseUrl;
test.beforeAll(async () => {
  server = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true, basePath: '/ledger' });
  await server.ready;
  await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${server.server.address().port}/ledger`;
});
test.afterAll(async () => { server?.server.closeAllConnections(); await server?.close(); });

test('manages the server independently of ledger initialization, with isolated cookies and cross-tab logout', async ({ page, context, browser }) => {
  await page.addInitScript(() => {
    window.__persistRequests = 0;
    navigator.storage.persist = async () => { window.__persistRequests++; return false; };
  });
  await page.goto(`${baseUrl}/admin/`);
  await expect(page.getByRole('heading', { name: '初始化服务器所有者' })).toBeVisible();
  await expect(page.getByRole('region', { name: '管理后台权限与存储说明' })).toContainText('不申请');
  await page.screenshot({ path: test.info().outputPath('admin-login.png'), fullPage: true });
  await page.getByLabel('管理账号用户名').fill('operator');
  await page.getByLabel('管理账号密码').fill('operator-test-password');
  await expect(page.getByLabel('部署者初始化密钥')).toHaveCount(0);
  const loggedIn = page.waitForResponse((response) => response.url().endsWith('/api/auth/login/finish'));
  await page.getByRole('button', { name: '创建所有者并进入后台' }).click();
  const login = await (await loggedIn).json();
  await expect(page.getByRole('heading', { name: '服务器概览' })).toBeVisible();
  expect(login.role).toBe('owner');
  expect(login.ledgerId).toBeUndefined();
  expect(login.refreshToken).toBeUndefined();
  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === 'zichan_admin_session')).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/ledger/api/auth' });
  expect(cookies.some((cookie) => cookie.name === 'zichan_session')).toBe(false);
  const storage = await page.evaluate(async () => ({ persist: window.__persistRequests, databases: await indexedDB.databases(), local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).toEqual({ persist: 0, databases: [], local: {}, session: {} });

  await page.getByRole('button', { name: '注册与邀请', exact: true }).click();
  await expect(page.getByText('当前策略：仅邀请注册')).toBeVisible();
  const inviteResponse = page.waitForResponse((response) => response.url().endsWith('/api/admin/invites') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '生成邀请码' }).click();
  await page.getByRole('button', { name: '确认执行' }).click();
  const { invite } = await (await inviteResponse).json();
  await registerAccount(baseUrl, 'managed-user', 'member-test-password', { inviteCode: invite.code });
  await page.getByRole('button', { name: '用户管理', exact: true }).click();
  const ownerRow = page.getByRole('table').first().getByRole('row').filter({ has: page.getByText('operator', { exact: true }) });
  await ownerRow.getByRole('button', { name: '设备与配额' }).click();
  await page.getByLabel('提交配额 MiB').fill('128');
  await page.getByRole('button', { name: '保存提交配额' }).click();
  await page.getByRole('button', { name: '确认执行' }).click();
  await expect(ownerRow).toContainText('128.0 MiB');
  await page.getByRole('button', { name: '恢复默认提交配额' }).click();
  await page.getByRole('button', { name: '确认执行' }).click();
  await expect(ownerRow).not.toContainText('128.0 MiB');
  await expect(ownerRow.getByRole('button', { name: '禁用', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭详情' }).click();
  const row = page.getByRole('table').first().getByRole('row').filter({ has: page.getByText('managed-user', { exact: true }) });
  await expect(row).toContainText('普通用户');
  await row.getByRole('button', { name: '授予管理员' }).click();
  await page.getByRole('button', { name: '确认执行' }).click();
  await expect(row).toContainText('管理员');
  await page.screenshot({ path: test.info().outputPath('admin-users.png'), fullPage: true });

  const managerContext = await browser.newContext();
  const manager = await managerContext.newPage();
  try {
    await manager.goto(`${baseUrl}/admin/`);
    await manager.getByLabel('管理账号用户名').fill('managed-user');
    await manager.getByLabel('管理账号密码').fill('member-test-password');
    await manager.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(manager.getByRole('heading', { name: '服务器概览' })).toBeVisible();
    await manager.getByRole('button', { name: '注册与邀请', exact: true }).click();
    await expect(manager.getByText('只有所有者可以改变注册策略。')).toBeVisible();
    await expect(manager.getByRole('button', { name: '保存注册策略' })).toHaveCount(0);
    await row.getByRole('button', { name: '撤销管理员' }).click();
    await page.getByRole('button', { name: '确认执行' }).click();
    await expect(row).toContainText('普通用户');
    await manager.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(manager.getByRole('heading', { name: '管理员登录' })).toBeVisible();
    await manager.getByLabel('管理账号密码').fill('member-test-password');
    await manager.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(manager.getByRole('alert')).toContainText('没有服务器管理权限');
  } finally { await managerContext.close(); }

  await row.getByRole('button', { name: '设备与配额' }).click();
  await page.getByLabel('提交配额 MiB').fill('64');
  await page.getByRole('button', { name: '保存提交配额' }).click();
  await page.getByRole('button', { name: '确认执行' }).click();
  await expect(row).toContainText('64.0 MiB');
  await row.getByRole('button', { name: '禁用', exact: true }).click();
  await page.getByRole('button', { name: '确认执行' }).click();
  await expect(row).toContainText('已禁用');
  await page.getByRole('button', { name: '审计日志', exact: true }).click();
  await expect(page.getByRole('cell', { name: '账号状态', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('admin-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });

  const regular = await loginAccount(baseUrl, 'operator', 'operator-test-password');
  await context.addCookies([{ name: 'zichan_session', value: regular.refreshToken, domain: new URL(baseUrl).hostname, path: '/ledger/api/auth', httpOnly: true, sameSite: 'Strict' }]);

  const second = await context.newPage();
  await second.goto(`${baseUrl}/admin/`);
  await expect(second.getByRole('heading', { name: '服务器概览' })).toBeVisible();
  await page.getByRole('button', { name: '退出管理后台' }).click();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await expect(second.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await expect(second.getByText('其他标签页已改变管理会话，请重新登录。')).toBeVisible();
  await second.reload();
  await expect(second.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  expect((await context.cookies()).some((cookie) => cookie.name === 'zichan_session')).toBe(true);
  const ledgerRefresh = await page.evaluate(async (url) => {
    const response = await fetch(`${url}/api/auth/refresh`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Zichan-Session': 'cookie' }, body: '{}' });
    return response.status;
  }, baseUrl);
  expect(ledgerRefresh).toBe(200);
  await second.close();
});
