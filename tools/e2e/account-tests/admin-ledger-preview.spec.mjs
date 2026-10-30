import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

/**
 * Administrator ledger preview, end to end.
 *
 * The preview is assembled from three parts that are individually tested — the server decrypts
 * and replays a user's commits into memory, the read-only driver refuses writes, and the ledger
 * app renders a `LedgerBackup`. None of those proves the parts fit together: a mismatch in the
 * backup shape, a migration that never ran, or a screen that writes on mount would only show up
 * with a real browser driving the real console.
 *
 * So this test records a transaction as a user, then looks at it as the administrator.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'account-test-password';
const setupToken = 'test-preview-owner-000000000000000000';
const userPassword = 'preview-user-password';

async function listen(options = {}) {
  const instance = createSyncServer({
    webDir: resolve(root, 'apps/web/dist'),
    enableWeb: true,
    registrationMode: 'open',
    ownerSetupToken: setupToken,
    ...options,
  });
  await instance.ready;
  await instance.started;
  await new Promise((done) => instance.server.listen(0, '127.0.0.1', done));
  return instance;
}

async function signIn(page, origin, username = 'owner') {
  await page.goto(`${origin}/e2e-private-entry/admin/`);
  await page.getByLabel('管理账号用户名').fill(username);
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('link', { name: '运行概览' })).toBeVisible();
}

/** Records one expense as the user, so the server holds commits worth previewing. */
async function recordExpenseAs(page, origin, username, amount) {
  await page.goto(`${origin}/app/`);
  await page.getByLabel('服务器用户名').fill(username);
  await page.getByLabel('服务器账号密码', { exact: true }).fill(userPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  // A brand-new account starts on the first-run wizard.
  await page.getByRole('button', { name: '开始记账', exact: true }).click();
  await page.getByRole('button', { name: '记第一笔', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支' });
  await form.getByLabel('金额*').fill(amount);
  await form.getByRole('button', { name: '保存' }).first().click();
  await expect(form).toHaveCount(0);
  await page.locator('.zc-sidebar').getByRole('button', { name: /我的账号$/ }).click();
  await page.getByRole('button', { name: '查看服务器上的账本' }).click();
  const syncSettings = page.getByRole('button', { name: /^客户端同步与服务器连接/ });
  if (await syncSettings.getAttribute('aria-expanded') !== 'true') await syncSettings.click();
  await page.getByRole('button', { name: '同步账本', exact: true }).first().click();
  await expect(page.getByText(/^(?:本机提交已|本次同步：|已完成 \d+ 轮同步)/).first()).toBeVisible();
}

test('an administrator opens a user ledger as a read-only preview and can close it', async ({ page }) => {
  const server = await listen();
  const origin = `http://127.0.0.1:${server.server.address().port}`;
  try {
    await registerAccount(origin, 'owner', password, { ownerSetupToken: setupToken });
    await registerAccount(origin, 'preview-user', userPassword);

    await recordExpenseAs(page, origin, 'preview-user', '42.50');
    // The explicit sync above must have pushed a commit before the preview opens.
    const ownerSession = await loginAccount(origin, 'owner', password, { sessionContext: 'admin' });
    await expect.poll(async () => {
      const response = await fetch(`${origin}/api/admin/users?search=preview-user`, {
        headers: { Authorization: `Bearer ${ownerSession.accessToken}` },
      });
      const result = await response.json();
      return result.users.find((user) => user.username === 'preview-user')?.commitBytes ?? 0;
    }, { timeout: 30_000 }).toBeGreaterThan(0);

    await signIn(page, origin);

    // The user list offers the preview on the account card.
    await page.goto(`${origin}/e2e-private-entry/admin/users`);
    const card = page.locator('.zc-admin-user-card').filter({ hasText: 'preview-user' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: '预览账本' })).toBeVisible();

    // Opening decrypts the user's ledger, so the console asks for a reason and says why.
    await card.getByRole('button', { name: '预览账本', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/e2e-private-entry/admin/preview?username=preview-user`);
    await expect(page.getByRole('heading', { name: /预览用户记账/ })).toBeVisible();
    await page.getByLabel('查看原因').fill('核对用户反馈的金额差异');
    await page.getByRole('button', { name: '打开预览' }).click();

    // The ledger UI itself must appear: this is the whole point of reusing it.
    await expect(page.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });
    const banner = page.getByRole('status', { name: '只读预览' });
    await expect(banner).toContainText('preview-user');
    await expect(banner).toContainText('剩余');
    // The administrator's own name is on the banner, so a screenshot cannot be mistaken for the
    // user's own screen.
    await expect(banner).toContainText('owner');

    // 同步 and 设置 describe the operator's own machine, so a preview does not offer them.
    const sidebar = page.locator('.zc-sidebar');
    await expect(sidebar.getByRole('button', { name: /设置$/ })).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: /数据保护$/ })).toHaveCount(0);
    await sidebar.getByRole('button', { name: /日常收支$/ }).click();
    await expect(page.getByText('42.5', { exact: false }).first()).toBeVisible();

    // Export writes the user's ledger to the operator's disk, so the preview has no such control.
    await expect(page.getByRole('button', { name: '导出', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '导入', exact: true })).toHaveCount(0);

    // Closing drops the plaintext and returns to the console.
    await page.getByRole('button', { name: '退出预览' }).click();
    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();

    // And the session is really gone, not just off screen: revisiting asks for a reason again
    // instead of handing back the ledger the operator just closed. (The 410 the server answers
    // for a closed preview id is covered by the route tests.)
    await card.getByRole('button', { name: '账号详情', exact: true }).click();
    await page.getByRole('button', { name: '预览记账数据', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/e2e-private-entry/admin/preview?username=preview-user`);
    await page.reload();
    await expect(page.getByLabel('查看原因')).toBeVisible();
    await expect(page.locator('.zc-app-shell')).toHaveCount(0);
  } finally {
    server.server.closeAllConnections();
    await server.close();
  }
});

test('a private-mode account is refused with a reason instead of an empty ledger', async ({ page }) => {
  // A private deployment keeps every recovery code with its user, so the server holds nothing it
  // could decrypt — which is exactly the state this refusal has to describe.
  const server = await listen({ accountProtection: 'private' });
  const origin = `http://127.0.0.1:${server.server.address().port}`;
  try {
    await registerAccount(origin, 'owner', password, { ownerSetupToken: setupToken });
    await registerAccount(origin, 'private-user', userPassword);

    await signIn(page, origin);
    await page.goto(`${origin}/e2e-private-entry/admin/preview?username=private-user`);
    await page.getByLabel('查看原因').fill('排查同步问题');
    await page.getByRole('button', { name: '打开预览' }).click();

    // An empty ledger would read as "this user has no data", which is a different and false
    // statement. The refusal must say what is actually wrong.
    await expect(page.getByRole('alert')).toContainText('托管');
    await expect(page.locator('.zc-app-shell')).toHaveCount(0);
  } finally {
    server.server.closeAllConnections();
    await server.close();
  }
});
