/**
 * Bulk account actions in a real browser.
 *
 * The unit tests pin the partition and the reporting. This pins what an operator sees and what the
 * server ends up with: the scope is shown before the write, the run reports each account, and a
 * protected account in the selection is skipped rather than aborting the rest.
 */
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = ['bulk', 'actions', 'password', '0001'].join('-');
const setupToken = 'test-admin-bulk-owner-secret-0000000000';

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
    await registerAccount(url, 'operator', password, { ownerSetupToken: setupToken });
    // Three members and one administrator: the owner can manage all of them, so a skip here means
    // the skip logic ran, not that the server refused everything.
    for (const name of ['member-one', 'member-two', 'member-three']) {
      await registerAccount(url, name, password);
    }
    await registerAccount(url, 'peer-admin', password);
  } catch (error) {
    server.server.closeAllConnections(); await server.close(); throw error;
  }
  const owner = await loginAccount(url, 'operator', password);
  const api = (path, body) => fetch(`${url}/api/admin${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const read = (path) => fetch(`${url}/api/admin${path}`, { headers: { Authorization: `Bearer ${owner.accessToken}` } });
  return { url, api, read, close: async () => { server.server.closeAllConnections(); await server.close(); } };
}

async function signIn(page, url) {
  await page.goto(`${url}/e2e-private-entry/admin/`);
  await page.getByLabel('管理账号用户名').fill('operator');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
}

test('states the scope before writing, then reports each account', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    await page.getByRole('link', { name: '用户管理' }).click();
    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();

    const table = page.locator('section').filter({ has: page.getByText('用户列表', { exact: true }) }).locator('table');
    // The owner is in the list and is not selectable; its checkbox says why.
    const ownerRow = table.locator('tbody tr').filter({ hasText: 'operator' }).first();
    await expect(ownerRow.getByRole('checkbox')).toBeDisabled();
    await expect(ownerRow.getByRole('checkbox')).toHaveAttribute('title', '所有者账号不可批量处理');

    // Select two members.
    await table.locator('tbody tr').filter({ hasText: 'member-one' }).first().getByRole('checkbox').check();
    await table.locator('tbody tr').filter({ hasText: 'member-two' }).first().getByRole('checkbox').check();
    await expect(page.getByText('已选 2 个账号（仅当前页）')).toBeVisible();

    // Choosing an action shows the scope *before* the write, naming the accounts. The order is the
    // table's (newest first), so this checks the set rather than a sequence.
    await page.getByLabel('批量操作', { exact: true }).selectOption('disable');
    await expect(page.getByText('禁用账号：确认范围')).toBeVisible();
    const scope = page.getByText(/^将处理 2 个：/);
    await expect(scope).toContainText('member-one');
    await expect(scope).toContainText('member-two');
    await page.getByRole('button', { name: '确认执行' }).click();

    // The report names the outcome per group rather than only a count. It renders as one block, so
    // the text is read and checked as a whole; the account order is the table's, not ours.
    const report = page.locator('p').filter({ hasText: '动作：禁用账号' });
    await expect(report).toContainText('动作：禁用账号。范围：已选 2 个账号，其中可处理 2 个、跳过 0 个。');
    await expect(report).toContainText('成功 2 个：');
    await expect(report).toContainText('member-one');
    await expect(report).toContainText('member-two');
    await expect(report).toContainText('失败 0 个。');
    await expect(report).toContainText('跳过 0 个。');

    // The server really has them disabled, and the third member is untouched.
    const listed = await (await f.read('/users?limit=100')).json();
    const byName = Object.fromEntries(listed.users.map((user) => [user.username, user.disabled]));
    expect(byName['member-one']).toBe(true);
    expect(byName['member-two']).toBe(true);
    expect(byName['member-three']).toBe(false);
    expect(byName['operator']).toBe(false);
  } finally { await f.close(); }
});

test('skips an account that is already in the target state and still handles the rest', async ({ page }) => {
  const f = await fixture();
  try {
    // Pre-disable one member through the API, so the selection mixes states.
    const listed = await (await f.read('/users?limit=100')).json();
    const target = listed.users.find((user) => user.username === 'member-two');
    await f.api(`/users/member-two/disable`, { disabled: true, expectedVersion: target.revision });

    await signIn(page, f.url);
    await page.getByRole('link', { name: '用户管理' }).click();
    const table = page.locator('section').filter({ has: page.getByText('用户列表', { exact: true }) }).locator('table');
    await table.locator('tbody tr').filter({ hasText: 'member-one' }).first().getByRole('checkbox').check();
    await table.locator('tbody tr').filter({ hasText: 'member-two' }).first().getByRole('checkbox').check();

    await page.getByLabel('批量操作', { exact: true }).selectOption('disable');
    // The already-disabled account is called out before the write, with the reason.
    await expect(page.getByText('将跳过 1 个：member-two（账号已是禁用状态）')).toBeVisible();
    await expect(page.getByText('将处理 1 个：member-one')).toBeVisible();
    await page.getByRole('button', { name: '确认执行' }).click();

    const report = page.locator('p').filter({ hasText: '动作：禁用账号' });
    await expect(report).toContainText('成功 1 个：');
    await expect(report).toContainText('member-one');
    await expect(report).toContainText('跳过 1 个：member-two（账号已是禁用状态）。');
    // A skipped account must not be counted as succeeded: the server sees no second write.
    await expect(report).toContainText('失败 0 个。');
  } finally { await f.close(); }
});

test('re-enables the selected accounts and reports a session revoke honestly', async ({ page }) => {
  const f = await fixture();
  try {
    // Pre-disable both members through the API, so the enable action is the one that applies.
    const listed = await (await f.read('/users?limit=100')).json();
    for (const username of ['member-one', 'member-two']) {
      const target = listed.users.find((user) => user.username === username);
      await f.api(`/users/${username}/disable`, { disabled: true, expectedVersion: target.revision });
    }

    await signIn(page, f.url);
    await page.getByRole('link', { name: '用户管理' }).click();
    const table = page.locator('section').filter({ has: page.getByText('用户列表', { exact: true }) }).locator('table');
    await table.locator('tbody tr').filter({ hasText: 'member-one' }).first().getByRole('checkbox').check();
    await table.locator('tbody tr').filter({ hasText: 'member-two' }).first().getByRole('checkbox').check();

    await page.getByLabel('批量操作', { exact: true }).selectOption('enable');
    await page.getByRole('button', { name: '确认执行' }).click();

    const enabled = page.locator('p').filter({ hasText: '动作：启用账号' });
    await expect(enabled).toContainText('动作：启用账号。范围：已选 2 个账号，其中可处理 2 个、跳过 0 个。');
    await expect(enabled).toContainText('成功 2 个：');
    await expect(enabled).toContainText('失败 0 个。');

    // The server really has them enabled again.
    const after = await (await f.read('/users?limit=100')).json();
    const byName = Object.fromEntries(after.users.map((user) => [user.username, user.disabled]));
    expect(byName['member-one']).toBe(false);
    expect(byName['member-two']).toBe(false);

    // Ending sessions is offered as well. These accounts never signed in, so every one of them has
    // nothing to end: the scope says so before the write and the confirm button stays disabled
    // rather than running a no-op that would report success for work that did not happen.
    await page.getByRole('button', { name: '刷新' }).click();
    await table.locator('tbody tr').filter({ hasText: 'member-one' }).first().getByRole('checkbox').check();
    await page.getByLabel('批量操作', { exact: true }).selectOption('revoke-sessions');
    await expect(page.getByText('将跳过 1 个：member-one（没有有效会话）')).toBeVisible();
    await expect(page.getByText('将处理 0 个：（无）')).toBeVisible();
    await expect(page.getByRole('button', { name: '确认执行' })).toBeDisabled();
  } finally { await f.close(); }
});
