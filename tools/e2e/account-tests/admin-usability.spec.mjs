import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'correct horse battery staple';

async function fixture() {
  const setup = 'test-admin-usability-owner-secret-000000';
  const server = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken: setup });
  await server.ready;
  await server.started;
  await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.server.address().port}`;
  try {
    await registerAccount(url, 'operator', password, { ownerSetupToken: setup });
  } catch (error) {
    server.server.closeAllConnections(); await server.close(); throw error;
  }
  const owner = await loginAccount(url, 'operator', password);
  const api = (path, body) => fetch(`${url}/api/admin${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return { url, api, close: async () => { server.server.closeAllConnections(); await server.close(); } };
}

async function signIn(page, url) {
  await page.goto(`${url}/admin/`);
  await page.getByLabel('管理账号用户名').fill('operator');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
}

test('reflects the stored registration policy and paginates and filters invitations', async ({ page }) => {
  const f = await fixture();
  try {
    const codes = [];
    for (let index = 0; index < 51; index += 1) {
      const response = await f.api('/invites', { days: 7 });
      expect(response.status).toBe(200);
      codes.push((await response.json()).invite.code);
    }
    await f.api(`/invites/${codes[0]}/disable`, { disabled: true });
    await signIn(page, f.url);
    await page.getByRole('link', { name: '注册与邀请' }).click();
    // The select reflects the server value; a policy change saves immediately.
    await expect(page.getByLabel('当前策略')).toHaveValue('open');
    // Scoped to the invitation list: the growth panel above it has a batch table with rows too,
    // so a bare `tbody tr` would count both.
    const list = page.locator('table').filter({ has: page.getByText('邀请码', { exact: true }) });
    await expect(list.locator('tbody tr')).toHaveCount(25);
    await expect(page.getByText('第 1 页')).toBeVisible();
    await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
    // Three pages forward, then back: the cursor history must survive every step.
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.getByText('第 2 页')).toBeVisible();
    await expect(list.locator('tbody tr')).toHaveCount(25);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.getByText('第 3 页')).toBeVisible();
    await expect(list.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByRole('cell', { name: codes[0], exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await expect(page.getByText('第 2 页')).toBeVisible();
    await expect(list.locator('tbody tr')).toHaveCount(25);
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await expect(page.getByText('第 1 页')).toBeVisible();
    await expect(list.locator('tbody tr')).toHaveCount(25);
    await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
    await page.getByLabel('状态').selectOption('revoked');
    await expect(page.getByText('第 1 页')).toBeVisible();
    await expect(list.locator('tbody tr')).toHaveCount(1);
    const saved = page.waitForResponse((response) => response.url().includes('/api/admin/registration') && response.request().method() === 'POST');
    await page.getByLabel('当前策略').selectOption('closed');
    expect((await saved).status()).toBe(200);
    await expect(page.getByText('当前已关闭注册：即使持有邀请码也无法注册。')).toBeVisible();
    // Revisiting the page reads the effective value back from the server.
    await page.getByRole('link', { name: '运行概览' }).click();
    await page.getByRole('link', { name: '注册与邀请' }).click();
    await expect(page.getByLabel('当前策略')).toHaveValue('closed');
    await page.screenshot({ path: test.info().outputPath('admin-invitations.png'), fullPage: true });
  } finally { await f.close(); }
});

test('retries a failed initial connection without reloading the page', async ({ page }) => {
  const f = await fixture();
  try {
    await page.route('**/api/health', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
    await page.goto(`${f.url}/admin/`);
    await expect(page.getByRole('alert')).toContainText('HTTP 503');
    await page.getByRole('button', { name: '重新连接服务器' }).click();
    await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录管理后台', exact: true })).toBeEnabled();
  } finally { await f.close(); }
});

test('reports a failed account read, revokes a member session and shows verification details', async ({ page }) => {
  const f = await fixture();
  try {
    await registerAccount(f.url, 'device-user', password);
    await loginAccount(f.url, 'device-user', password, { deviceName: 'Browser under review' });
    await signIn(page, f.url);
    // A failed detail read must surface as an error instead of an empty or editable form.
    await page.route('**/api/admin/accounts/*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'usage temporarily unavailable' }) }), { times: 1 });
    await page.getByRole('link', { name: '用户管理' }).click();
    await page.getByRole('row').filter({ has: page.getByText('device-user', { exact: true }) }).getByRole('button', { name: '详情' }).click();
    await expect(page.getByText('usage temporarily unavailable')).toBeVisible();
    await expect(page.getByRole('button', { name: '调整附件配额' })).toHaveCount(0);
    await page.getByRole('button', { name: '返回用户列表' }).click();
    await page.getByRole('row').filter({ has: page.getByText('device-user', { exact: true }) }).getByRole('button', { name: '详情' }).click();
    await expect(page.getByRole('button', { name: '调整附件配额' })).toBeEnabled();
    await page.getByRole('button', { name: '调整附件配额' }).click();
    await page.getByLabel('新的上限（GiB）').fill('0.03125');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('操作已完成。')).toBeVisible();

    // The device list is filtered and the session can be revoked from the detail page.
    const row = page.getByRole('row').filter({ hasText: 'Browser under review' });
    await expect(row).toContainText('记账');
    await expect(row).toContainText('有效');
    await row.getByRole('button', { name: '撤销' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Browser under review' })).toContainText('已撤销');
    await page.screenshot({ path: test.info().outputPath('admin-devices.png'), fullPage: true });

    // Verification is a maintenance job now, so the console lists jobs and shows the result
    // detail of the one under review.
    const job = { jobId: 'job-e2e', type: 'blobs.verify', params: {}, status: 'queued', createdAt: new Date().toISOString(), createdBy: 'operator', processed: 0, total: 0, cancelRequested: false };
    const finished = {
      ...job, status: 'succeeded', processed: 1, total: 1,
      result: { checkedObjects: 1, checkedChunks: 2, issueCount: 1, issues: [{ username: 'device-user', blobId: 'test-blob', detail: 'chunk missing' }] },
    };
    // A glob keeps `**` inside one path segment, so the detail URL needs a regex: this matches
    // the list (with query), the create endpoint and `/jobs/<id>`.
    await page.route(/\/api\/admin\/jobs(\/|\?|$)/, (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST') return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ job }) });
      if (path.endsWith('/api/admin/jobs/job-e2e')) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ job: finished, events: [{ id: 1, jobId: 'job-e2e', at: new Date().toISOString(), level: 'error', message: '附件校验完成：1 个对象、2 个分块、1 个问题' }] }) });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobs: [finished] }) });
    });
    await page.getByRole('link', { name: '任务中心' }).click();
    await page.getByRole('button', { name: '创建任务' }).click();
    await page.getByRole('button', { name: '查看', exact: true }).first().click();
    await expect(page.getByText('附件校验完成：1 个对象、2 个分块、1 个问题')).toBeVisible();
    await expect(page.locator('pre')).toContainText('chunk missing');

  } finally { await f.close(); }
});
