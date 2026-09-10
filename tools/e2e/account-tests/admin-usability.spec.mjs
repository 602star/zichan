import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'admin-usability-test-password';

async function fixture() {
  const setup = 'test-admin-usability-owner-secret-000000';
  const server = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken: setup });
  await server.ready;
  await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.server.address().port}`;
  try {
    await registerAccount(url, 'operator', password, { ownerSetupToken: setup });
  } catch (error) {
    server.server.closeAllConnections(); await server.close(); throw error;
  }
  const owner = await loginAccount(url, 'operator', password);
  const api = (path, body) => fetch(`${url}/api/admin${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { url, api, close: async () => { server.server.closeAllConnections(); await server.close(); } };
}

async function signIn(page, url) {
  await page.goto(`${url}/admin/`);
  await page.getByLabel('管理账号用户名').fill('operator');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '服务器概览' })).toBeVisible();
}

test('reflects the stored registration policy and paginates and filters invitations', async ({ page }) => {
  const f = await fixture();
  try {
    const codes = [];
    for (let i = 0; i < 26; i++) {
      const response = await f.api('/invites', { days: 7 });
      expect(response.status).toBe(200);
      codes.push((await response.json()).invite.code);
    }
    await f.api(`/invites/${codes[0]}/disable`, { disabled: true });
    await signIn(page, f.url);
    await page.getByRole('button', { name: '注册与邀请', exact: true }).click();
    await expect(page.getByLabel('新注册策略')).toHaveValue('open');
    await expect(page.getByRole('button', { name: '保存注册策略' })).toBeDisabled();
    await expect(page.locator('tbody tr')).toHaveCount(25);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByRole('cell', { name: codes[0], exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await page.getByLabel('邀请状态筛选').selectOption('revoked');
    await expect(page.getByText('第 1 页', { exact: true })).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.getByLabel('新注册策略').selectOption('closed');
    await page.getByRole('button', { name: '保存注册策略' }).click();
    await page.getByRole('button', { name: '确认执行' }).click();
    await expect(page.getByText('当前策略：关闭注册')).toBeVisible();
    await page.getByRole('button', { name: '概览', exact: true }).click();
    await page.getByRole('button', { name: '注册与邀请', exact: true }).click();
    await expect(page.getByLabel('新注册策略')).toHaveValue('closed');
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

test('guards failed quota loads, revokes a member session and shows verification details', async ({ page }) => {
  const f = await fixture();
  try {
    await registerAccount(f.url, 'device-user', password);
    const member = await loginAccount(f.url, 'device-user', password, { deviceName: 'Browser under review' });
    await signIn(page, f.url);
    await page.route('**/api/admin/accounts/*/usage', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'usage temporarily unavailable' }) }));
    await page.getByRole('button', { name: '用户管理', exact: true }).click();
    await page.getByRole('row').filter({ has: page.getByText('device-user', { exact: true }) }).getByRole('button', { name: '设备与配额' }).click();
    await expect(page.getByRole('alert')).toContainText('usage temporarily unavailable');
    await expect(page.getByRole('button', { name: '保存附件配额' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '恢复默认附件配额' })).toBeDisabled();
    await page.unroute('**/api/admin/accounts/*/usage');
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存附件配额' })).toBeEnabled();
    await page.getByLabel('附件配额 MiB').fill('32');
    await page.getByRole('button', { name: '保存附件配额' }).click();
    await page.getByRole('button', { name: '确认执行' }).click();
    await expect(page.getByLabel('附件配额 MiB')).toHaveValue('32');
    await page.getByRole('button', { name: '设备与安全', exact: true }).click();
    await page.getByLabel('搜索设备所属账号').fill('device-user');
    await page.getByRole('button', { name: '查询设备' }).click();
    const row = page.getByRole('row').filter({ hasText: 'Browser under review' });
    await expect(row).toContainText('device-user');
    await row.getByRole('button', { name: '撤销会话' }).click();
    await page.getByRole('button', { name: '确认执行' }).click();
    await expect(row.getByRole('button', { name: '撤销会话' })).toBeDisabled();
    expect((await fetch(`${f.url}/api/auth/me`, { headers: { Authorization: `Bearer ${member.accessToken}` } })).status).toBe(401);
    await page.screenshot({ path: test.info().outputPath('admin-devices.png'), fullPage: true });
    await page.getByRole('button', { name: '存储维护', exact: true }).click();
    // Simulate corrupt encrypted storage without damaging the test database.
    await page.route('**/api/admin/quotas/blobs/verify', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ verification: { checkedObjects: 1, checkedChunks: 2, issues: [{ username: 'device-user', blobId: 'test-blob', detail: 'chunk missing' }] } }) }));
    await page.getByRole('button', { name: '校验附件分块' }).click();
    await page.getByRole('button', { name: '确认执行' }).click();
    await expect(page.getByText('已检查 1 个对象、2 个分块，发现 1 个问题。')).toBeVisible();
    await page.getByText('查看问题详情（1 项）').click();
    await expect(page.locator('pre')).toContainText('chunk missing');
  } finally { await f.close(); }
});
