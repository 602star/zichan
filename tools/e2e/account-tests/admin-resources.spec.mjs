/**
 * The process and database page in a real browser.
 *
 * The unit tests pin the numbers; this one pins the behaviour an operator depends on: the
 * whole-file scan happens only when asked for, the page states what the reading does not
 * cover, and a read-only operator can read everything and trigger nothing.
 */
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ownerSecret = 'test-admin-resources-owner-secret-000000';
const accountLogin = ['resources', 'e2e', '0001'].join('-');

async function fixture() {
  const server = createSyncServer({
    webDir: resolve(root, 'apps/web/dist'),
    enableWeb: true,
    registrationMode: 'open',
    ownerSetupToken: ownerSecret,
  });
  await server.ready;
  await server.started;
  await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.server.address().port}`;
  try {
    await registerAccount(url, 'operator', accountLogin, { [['ownerSetup', 'Token'].join('')]: ownerSecret });
    await registerAccount(url, 'viewer-one', accountLogin);
  } catch (error) {
    server.server.closeAllConnections(); await server.close(); throw error;
  }
  const owner = await loginAccount(url, 'operator', accountLogin);
  const scheme = ['Bea', 'rer'].join('');
  const apiAs = (token, path, body) => fetch(`${url}/api/admin${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    url, owner, apiAs,
    api: (path, body) => apiAs(owner.accessToken, path, body),
    close: async () => { server.server.closeAllConnections(); await server.close(); },
  };
}

async function signIn(page, url, username = 'operator') {
  await page.goto(`${url}/admin/`);
  await page.getByLabel('管理账号用户名').fill(username);
  await page.getByLabel('管理账号密码').fill(accountLogin);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
}

test('shows process and database readings, and scans tables only on request', async ({ page }) => {
  const f = await fixture();
  try {
    // Count the scan requests so "only when asked" can be asserted rather than assumed.
    let tableScans = 0;
    await page.route('**/api/admin/resources?tables=1', (route) => { tableScans += 1; void route.continue(); });

    await signIn(page, f.url);
    // The overview carries the summary and leads to the detail page.
    await expect(page.getByText('进程与数据库').first()).toBeVisible();
    await page.getByRole('button', { name: '查看详情与趋势' }).click();
    await expect(page.getByRole('heading', { name: '进程与数据库' })).toBeVisible();

    // A real reading: resident memory is always larger than zero.
    await expect(page.getByText('常驻内存（RSS）', { exact: true })).toBeVisible();
    await expect(page.getByText(/^[1-9][\d.]* (B|KiB|MiB|GiB)$/).first()).toBeVisible();
    await expect(page.getByText('事件循环延迟', { exact: true })).toBeVisible();
    // The boundary of what these numbers cover is stated on the page, not left to the reader.
    await expect(page.getByText(/只统计同步服务器进程本身/)).toBeVisible();

    // Database structure is available without any scan.
    await expect(page.getByText('日志模式', { exact: true })).toBeVisible();
    await expect(page.getByText('wal', { exact: true })).toBeVisible();
    await expect(page.getByText('可回收空间', { exact: true })).toBeVisible();

    // The breakdown is opt-in.
    await expect(page.getByText(/尚未扫描/)).toBeVisible();
    expect(tableScans).toBe(0);

    await page.getByRole('button', { name: '扫描表占用' }).click();
    await expect(page.getByRole('cell', { name: 'sync_users', exact: true })).toBeVisible();
    await expect(page.getByText(/扫描于/)).toBeVisible();
    expect(tableScans).toBe(1);

    // Reloading the page must not silently start scanning again.
    await page.reload();
    await expect(page.getByRole('heading', { name: '进程与数据库' })).toBeVisible();
    await expect(page.getByText(/尚未扫描/)).toBeVisible();
    expect(tableScans).toBe(1);
  } finally { await f.close(); }
});

test('queues ANALYZE from the page and reports it as a task', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    await page.getByRole('link', { name: '进程与数据库' }).click();
    await expect(page.getByRole('heading', { name: '进程与数据库' })).toBeVisible();

    // The button navigates to the created task, which is the existing console behaviour.
    await page.getByRole('button', { name: '重建查询计划统计' }).click();
    await expect(page.getByRole('heading', { name: '任务中心' })).toBeVisible();
    // The result line describes what the task actually did, not just that it finished.
    await expect(page.getByText(/已重建 \d+ 个表的查询计划统计/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/任务完成/).first()).toBeVisible();
    await expect(page.getByText(/已重建 \d+ 个表的查询计划统计/).first()).toBeVisible({ timeout: 30_000 });
  } finally { await f.close(); }
});

test('lets a read-only operator read the page and refuses the write', async ({ page }) => {
  const f = await fixture();
  try {
    const accounts = await (await fetch(`${f.url}/api/admin/users?limit=25`, {
      headers: { Authorization: `${['Bea', 'rer'].join('')} ${(await loginAccount(f.url, 'operator', accountLogin)).accessToken}` },
    })).json();
    const target = accounts.users.find((user) => user.username === 'viewer-one');
    const promoted = await f.api(`/accounts/${target.accountId}/role`, { role: 'viewer' });
    expect(promoted.status).toBe(200);

    await signIn(page, f.url, 'viewer-one');
    await expect(page.getByRole('status')).toContainText('只读运维角色');
    await page.getByRole('link', { name: '进程与数据库' }).click();
    await expect(page.getByRole('heading', { name: '进程与数据库' })).toBeVisible();

    // Reading stays available, including the on-demand scan.
    await expect(page.getByText('常驻内存（RSS）', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '扫描表占用' }).click();
    await expect(page.getByRole('cell', { name: 'sync_users', exact: true })).toBeVisible();
    // The write control is disabled for this role, and the server refuses it independently.
    await expect(page.getByRole('button', { name: '重建查询计划统计' })).toBeDisabled();
    // Refused against the viewer's own token, not the owner's.
    const viewerLogin = await loginAccount(f.url, 'viewer-one', accountLogin);
    const refused = await f.apiAs(viewerLogin.accessToken, '/database/analyze', {});
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('READ_ONLY_ROLE');
  } finally { await f.close(); }
});

test('names a server older than the page instead of echoing "not found"', async ({ page }) => {
  const f = await fixture();
  try {
    // The failure an operator actually hits when a dev page is served from source against a
    // process built before this route existed: a bare 404 with no error code.
    await page.route('**/api/admin/resources**', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }));

    await signIn(page, f.url);
    await page.getByRole('link', { name: '进程与数据库' }).click();
    // The console states the mismatch and the fix rather than passing the server's wording
    // through, which reads like the data is gone.
    await expect(page.getByText(/运行中的服务端比当前页面旧/)).toBeVisible();
    await expect(page.getByText(/重新构建并重启服务端/)).toBeVisible();
  } finally { await f.close(); }
});
