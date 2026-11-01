import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { clickAdminLink } from '../admin-navigation.mjs';
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
  await listenOnSafePort(server.server, '127.0.0.1');
  const url = `http://127.0.0.1:${server.server.address().port}`;
  try {
    await registerAccount(url, 'operator', password, { ownerSetupToken: setup });
  } catch (error) {
    await closeTestSyncServer(server); throw error;
  }
  const owner = await loginAccount(url, 'operator', password);
  const api = (path, body) => fetch(`${url}/api/admin${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return { url, api, close: async () => { await closeTestSyncServer(server); } };
}

async function signIn(page, url) {
  await page.goto(`${url}/e2e-private-entry/admin/`);
  await page.getByLabel('管理账号用户名').fill('operator');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible({ timeout: 30_000 });
}

test('quota typos never reset overrides and settings reject a mixed invalid batch', async ({ page }) => {
  const f = await fixture();
  try {
    await registerAccount(f.url, 'quota-target', password);
    await signIn(page, f.url);
    await page.getByRole('link', { name: '用户管理', exact: true }).click();
    await page.locator('.zc-admin-user-card').filter({ hasText: 'quota-target' }).getByRole('button', { name: '账号详情', exact: true }).click();
    const sent = [];
    page.on('request', (request) => { if (request.method() === 'POST' && /\/accounts\/[^/]+\/(commits|blobs)$/.test(request.url())) sent.push(request.postDataJSON()); });
    for (const [label, field] of [['调整提交配额', 'commitQuotaBytes'], ['调整附件配额', 'quotaBytes']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const input = page.getByLabel('新的上限（GiB）', { exact: true });
      const before = sent.length;
      for (const invalid of ['abc', '1GiB', '', '1e999', '1025']) {
        await input.fill(invalid);
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.getByText(/请输入纯数字|配额范围为/)).toBeVisible();
        expect(sent.length).toBe(before);
      }
      const save = page.waitForResponse((response) => response.request().method() === 'POST' && /\/(commits|blobs)$/.test(response.url()));
      const refreshed = page.waitForResponse((response) => response.request().method() === 'GET' && /\/api\/admin\/accounts\/account-[^/]+$/.test(response.url()));
      await input.fill('1.5');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      expect((await save).status()).toBe(200);
      await expect(page.getByText('操作已完成。', { exact: true })).toBeVisible();
      expect(sent.at(-1)[field]).toBe(1610612736);
      await refreshed;
      await page.getByRole('button', { name: label, exact: true }).click();
      const reset = page.waitForResponse((response) => response.request().method() === 'POST' && /\/(commits|blobs)$/.test(response.url()));
      const resetRefreshed = page.waitForResponse((response) => response.request().method() === 'GET' && /\/api\/admin\/accounts\/account-[^/]+$/.test(response.url()));
      await page.getByRole('button', { name: '恢复服务器默认', exact: true }).click();
      expect((await reset).status()).toBe(200);
      expect(sent.at(-1)[field]).toBeNull();
      await resetRefreshed;
    }
    const settingsResponse = page.waitForResponse((response) => response.url().endsWith('/api/admin/settings') && response.request().method() === 'GET');
    await page.getByRole('link', { name: '系统设置', exact: true }).click();
    const fields = (await (await settingsResponse).json()).settings.filter((field) => field.editable && ['backupRetentionCount', 'backupIntervalHours'].includes(field.name));
    await page.getByRole('tab', { name: '备份计划' }).click();
    const [bad, good] = fields;
    const valid = good.value === good.minimum ? good.maximum : good.minimum;
    let saves = 0;
    page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/api/admin/settings')) saves += 1; });
    await page.getByLabel(bad.label, { exact: true }).fill('abc');
    await page.getByLabel(good.label, { exact: true }).fill(String(valid));
    await page.getByRole('button', { name: '保存本组设置', exact: true }).click();
    await expect(page.getByText('请修正标记的设置项；本次没有保存任何改动。')).toBeVisible();
    await expect(page.getByLabel(bad.label, { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel(good.label, { exact: true })).toHaveValue(String(valid));
    expect(saves).toBe(0);
    await page.getByLabel(bad.label, { exact: true }).fill(String(bad.value));
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/admin/settings') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存本组设置', exact: true }).click();
    expect((await saved).status()).toBe(200);
  } finally { await f.close(); }
});

test('account session links use exact identity and compose with search filters', async ({ page }) => {
  const f = await fixture();
  try {
    for (const name of ['alice', 'alice2']) { await registerAccount(f.url, name, password); await loginAccount(f.url, name, password); }
    await signIn(page, f.url);
    await page.getByRole('link', { name: '用户管理', exact: true }).click();
    await page.locator('.zc-admin-user-card').filter({ has: page.getByRole('button', { name: 'alice', exact: true }) }).getByRole('button', { name: '账号详情', exact: true }).click();
    const accountId = new URL(page.url()).pathname.split('/').at(-1);
    await page.getByRole('button', { name: '该账号的会话', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('accountId')).toBe(accountId);
    const rows = (name) => page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });
    await expect(rows('alice').first()).toBeVisible();
    await expect(rows('alice2')).toHaveCount(0);
    await page.getByLabel('用户名、accountId 或设备名', { exact: true }).fill('alice2');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(rows('alice')).toHaveCount(0);
    await expect(rows('alice2')).toHaveCount(0);
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(rows('alice').first()).toBeVisible();
    await expect(rows('alice2').first()).toBeVisible();
    await page.goBack();
    await page.reload();
    await expect(rows('alice2')).toHaveCount(0);
  } finally { await f.close(); }
});

for (const view of [
  { path: 'users', label: '用户管理', input: '登录账号、昵称或账号 ID' },
  { path: 'sessions', label: '设备与会话', input: '用户名、accountId 或设备名' },
]) {
  test(`${view.path} search follows browser back and forward without submitting drafts`, async ({ page }) => {
    const f = await fixture();
    try {
      for (const name of ['history-alpha', 'history-beta']) {
        await registerAccount(f.url, name, password);
        await loginAccount(f.url, name, password);
      }
      await signIn(page, f.url);
      await clickAdminLink(page, view.label);
      const input = page.getByLabel(view.input, { exact: true });
      const rowsFor = (name) => view.path === 'users'
        ? page.locator('.zc-admin-user-card').filter({ has: page.getByRole('button', { name, exact: true }) })
        : page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });
      const assertSearch = async (name, excluded) => {
        await expect.poll(() => new URL(page.url()).searchParams.get('search') ?? '').toBe(name);
        await expect(input).toHaveValue(name);
        await expect(rowsFor(name).first()).toBeVisible();
        await expect(rowsFor(excluded)).toHaveCount(0);
      };
      await input.fill('history-alpha');
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      await assertSearch('history-alpha', 'history-beta');
      await input.fill('history-beta');
      await input.press('Enter');
      await assertSearch('history-beta', 'history-alpha');
      // A local draft must not filter the list or create browser history.
      await input.fill('unsaved-draft');
      await expect(rowsFor('history-beta').first()).toBeVisible();
      expect(new URL(page.url()).searchParams.get('search')).toBe('history-beta');
      await page.goBack();
      await assertSearch('history-alpha', 'history-beta');
      await page.goBack();
      await expect(input).toHaveValue('');
      await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBeNull();
      await expect(rowsFor('history-alpha').first()).toBeVisible();
      await expect(rowsFor('history-beta').first()).toBeVisible();
      await page.goForward();
      await assertSearch('history-alpha', 'history-beta');
      await page.goForward();
      await assertSearch('history-beta', 'history-alpha');
    } finally { await f.close(); }
  });
}

test('revoking all account sessions requires confirmation and blocks duplicate requests', async ({ page }) => {
  const f = await fixture();
  let release;
  try {
    await registerAccount(f.url, 'session-target', password);
    await loginAccount(f.url, 'session-target', password);
    await signIn(page, f.url);
    await page.getByRole('link', { name: '用户管理', exact: true }).click();
    const detailResponse = page.waitForResponse((response) => /\/api\/admin\/accounts\/account-[^/]+$/.test(response.url()) && response.request().method() === 'GET');
    await page.locator('.zc-admin-user-card').filter({ hasText: 'session-target' }).getByRole('button', { name: '账号详情', exact: true }).click();
    const detail = await (await detailResponse).json();
    expect(detail.activeSessionCount).toBeGreaterThan(0);
    let requests = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/admin/accounts/*/sessions/revoke', async (route) => {
      requests += 1;
      if (requests === 1) {
        await gate;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试暂时失败' }) });
      } else await route.continue();
    });
    const trigger = page.getByRole('button', { name: '撤销全部可管理会话', exact: true });
    const confirmation = page.getByRole('region', { name: '确认撤销全部会话', exact: true });
    await trigger.click();
    await expect(confirmation).toContainText('session-target');
    await expect(confirmation).toContainText(detail.account.accountId);
    await expect(confirmation).toContainText(`将影响 ${detail.activeSessionCount} 个有效会话`);
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await expect(confirmation).toBeHidden();
    expect(requests).toBe(0);
    await trigger.click();
    await confirmation.getByRole('button', { name: '确认撤销', exact: true }).click();
    await expect.poll(() => requests).toBe(1);
    await expect(trigger).toBeDisabled();
    await expect(confirmation.getByRole('button', { name: '正在撤销…', exact: true })).toBeDisabled();
    await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await confirmation.getByRole('button', { name: '正在撤销…', exact: true }).evaluate((button) => { button.click(); button.click(); });
    expect(requests).toBe(1);
    release();
    await expect(page.getByText(/测试暂时失败/)).toBeVisible();
    await expect(confirmation.getByRole('button', { name: '确认撤销', exact: true })).toBeEnabled();
    const refreshed = page.waitForResponse((response) => response.url().endsWith(`/api/admin/accounts/${detail.account.accountId}`) && response.request().method() === 'GET');
    await confirmation.getByRole('button', { name: '确认撤销', exact: true }).click();
    expect((await (await refreshed).json()).activeSessionCount).toBe(0);
    await expect(confirmation).toBeHidden();
    await expect(page.getByText('操作已完成。', { exact: true })).toBeVisible();
    expect(requests).toBe(2);
  } finally { release?.(); await f.close(); }
});

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
    await clickAdminLink(page, '注册与邀请');
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
    await clickAdminLink(page, '注册与邀请');
    await expect(page.getByLabel('当前策略')).toHaveValue('closed');
    await page.screenshot({ path: test.info().outputPath('admin-invitations.png'), fullPage: true });
  } finally { await f.close(); }
});

test('retries a failed initial connection without reloading the page', async ({ page }) => {
  const f = await fixture();
  try {
    let unavailable = true;
    await page.route('**/api/health', (route) => unavailable
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      : route.continue());
    await page.goto(`${f.url}/e2e-private-entry/admin/`);
    await expect(page.getByRole('alert')).toContainText('无法确定管理服务器地址');
    unavailable = false;
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
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
    await page.locator('.zc-admin-user-card').filter({ hasText: 'device-user' }).getByRole('button', { name: '账号详情' }).click();
    await expect(page.getByText('usage temporarily unavailable')).toBeVisible();
    await expect(page.getByRole('button', { name: '调整附件配额' })).toHaveCount(0);
    await page.getByRole('button', { name: '返回用户列表' }).click();
    await page.locator('.zc-admin-user-card').filter({ hasText: 'device-user' }).getByRole('button', { name: '账号详情' }).click();
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
    await clickAdminLink(page, '任务中心');
    await page.getByRole('button', { name: '创建任务' }).click();
    await page.getByRole('button', { name: '查看', exact: true }).first().click();
    await expect(page.getByText('附件校验完成：1 个对象、2 个分块、1 个问题')).toBeVisible();
    await expect(page.locator('pre')).toContainText('chunk missing');

  } finally { await f.close(); }
});
