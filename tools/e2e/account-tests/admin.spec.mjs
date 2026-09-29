import { clickAdminLink } from '../admin-navigation.mjs';
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { currentStep, totpAtStep } from '../../../apps/sync-server/dist/totp.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'correct horse battery staple';
const setupToken = 'e2e-owner-setup-token-0000000000000000';
let server;
let baseUrl;

async function listen(options) {
  const instance = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true, ownerSetupToken: setupToken, ...options });
  await instance.ready;
  await instance.started;
  await new Promise((done) => instance.server.listen(0, '127.0.0.1', done));
  return instance;
}

/** The code an authenticator would show right now. */
function codeForStep(secret, offset) {
  const code = totpAtStep(secret, currentStep(Date.now()) + offset);
  if (!code) throw new Error('could not compute a code');
  return code;
}

/** The confirming code spends its step, so the login has to use the next one. */
const currentCode = (secret) => codeForStep(secret, 0);
const nextStepCode = (secret) => codeForStep(secret, 1);

async function signIn(page, origin, username = 'owner') {
  await page.goto(`${origin}/admin/`);
  await page.getByLabel('管理账号用户名').fill(username);
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('link', { name: '运行概览' })).toBeVisible();
}

test.beforeAll(async () => {
  server = await listen({ basePath: '/ledger', registrationMode: 'open' });
  baseUrl = `http://127.0.0.1:${server.server.address().port}/ledger`;
  await registerAccount(baseUrl, 'owner', password, { ownerSetupToken: setupToken });
  await registerAccount(baseUrl, 'member-one', password);
  // A member no other test touches: the rejection test must not depend on another test's
  // role change or account state.
  await registerAccount(baseUrl, 'member-plain', password);
  await registerAccount(baseUrl, 'viewer-one', password);
  // The second-factor case owns this account; the other cases keep signing in as the bare owner.
  await registerAccount(baseUrl, 'mfa-admin', password);
});
test.afterAll(async () => { server?.server.closeAllConnections(); await server?.close(); });

test('initializes the owner in the browser, then keeps every management page on its own URL', async ({ page }) => {
  // A server without an owner shows the initialization form; no setup secret is required.
  const fresh = await listen({ basePath: '/ledger' });
  const origin = `http://127.0.0.1:${fresh.server.address().port}/ledger`;
  try {
    await page.goto(`${origin}/admin/`);
    await expect(page.getByRole('heading', { name: '初始化服务器所有者' })).toBeVisible();
    await page.getByLabel('管理账号用户名').fill('owner');
    await page.getByLabel('管理账号密码').fill(password);
    await page.getByRole('button', { name: '创建所有者并进入后台' }).click();
    await expect(page.getByRole('link', { name: '运行概览' })).toBeVisible();
    // The bare console URL canonicalises to the overview page.
    await expect(page).toHaveURL(/\/ledger\/admin\/overview$/);
    await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
    // The overview states that an idle account is not an online user.
    await expect(page.getByText('有效会话不代表在线人数')).toBeVisible();

    // A direct visit to a deep URL restores that page and its filters after a reload.
    await page.goto(`${origin}/admin/users?quota=over`);
    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
    await expect(page.getByLabel('配额状态')).toHaveValue('over');
    await page.getByLabel('配额状态').selectOption('');
    await expect(page).toHaveURL(/\/ledger\/admin\/users$/);

    // Navigation keeps the URL in sync and back/forward works.
    await clickAdminLink(page, '设备与会话');
    await expect(page).toHaveURL(/\/ledger\/admin\/sessions$/);
    await expect(page.getByRole('heading', { name: '设备与会话' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
  } finally { fresh.server.closeAllConnections(); await fresh.close(); }
});

test('runs the daily management work: policy, invites, roles, quotas and audit', async ({ page }) => {
  await signIn(page, baseUrl);

  await clickAdminLink(page, '注册与邀请');
  await expect(page.getByLabel('当前策略')).toHaveValue('open');
  const policy = page.waitForResponse((response) => response.url().includes('/api/admin/registration') && response.request().method() === 'POST');
  await page.getByLabel('当前策略').selectOption('closed');
  expect((await policy).status()).toBe(200);
  await expect(page.getByLabel('当前策略')).toHaveValue('closed');
  await expect(page.getByText('当前已关闭注册')).toBeVisible();
  const restore = page.waitForResponse((response) => response.url().includes('/api/admin/registration') && response.request().method() === 'POST');
  await page.getByLabel('当前策略').selectOption('invite');
  expect((await restore).status()).toBe(200);

  const created = page.waitForResponse((response) => response.url().endsWith('/api/admin/invites') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '生成一次性邀请码' }).click();
  const invite = (await (await created).json()).invite;
  // The fresh code is shown once above the list and stays visible as a row in it.
  await expect(page.getByRole('button', { name: '复制' })).toBeVisible();
  await expect(page.getByRole('cell', { name: invite.code, exact: true })).toBeVisible();

  // User detail: roles, quotas and capacity, with a readable audit sentence afterwards.
  await page.getByRole('link', { name: '用户管理' }).click();
  await page.getByRole('row').filter({ has: page.getByText('member-one', { exact: true }) }).getByRole('button', { name: '详情' }).click();
  await expect(page.getByRole('heading', { name: /用户详情/ })).toBeVisible();
  await page.getByRole('button', { name: '修改角色' }).click();
  await page.getByLabel('角色').selectOption('admin');
  await page.getByLabel('原因（会写入审计）').fill('协助处理容量申请');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('操作已完成。')).toBeVisible();
  await page.getByRole('button', { name: '调整附件配额' }).click();
  await page.getByLabel('新的上限（GiB）').fill('5');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('操作已完成。')).toBeVisible();

  await clickAdminLink(page, '管理审计');
  await expect(page.getByRole('cell', { name: /附件配额调整为 5 GiB/ })).toBeVisible();
  // The readable sentence and the structured reason column both stay searchable.
  await expect(page.getByRole('row').filter({ hasText: '附件配额调整为 5 GiB' }).getByRole('cell', { name: '协助处理容量申请', exact: true })).toBeVisible();

  // Disabling an account states how many sessions are revoked before it is confirmed.
  await page.getByRole('link', { name: '用户管理' }).click();
  await page.getByRole('row').filter({ has: page.getByText('member-one', { exact: true }) }).getByRole('button', { name: '详情' }).click();
  await page.getByRole('button', { name: '禁用账号' }).click();
  await expect(page.getByText(/将立即撤销该账号的 \d+ 个有效会话/)).toBeVisible();
  await page.getByRole('button', { name: '确认禁用' }).click();
  await expect(page.getByText('操作已完成。')).toBeVisible();

  // The shell collapses to a menu at phone width.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByRole('link', { name: '运行概览' })).toBeVisible();
});

test('keeps the management console out of the ledger and rejects non-administrators', async ({ page, context, browser }) => {
  await signIn(page, baseUrl);
  const databases = await page.evaluate(() => indexedDB.databases().then((rows) => rows.map((row) => row.name)));
  expect(databases.filter((name) => name && name.includes('ledger'))).toEqual([]);

  await page.goto(`${baseUrl}/app/`);
  const ledgerMe = await page.evaluate(async (origin) => {
    const response = await fetch(`${origin}/api/auth/me`, { headers: { 'X-Zichan-Session': 'cookie' }, credentials: 'same-origin' });
    return response.status;
  }, baseUrl);
  // The management login is not a ledger session: the ledger API stays unauthenticated.
  expect(ledgerMe).toBe(401);

  // A member cannot enter the console. A clean context is required too: this one already
  // holds the owner's management cookie, so a new tab would simply restore that session.
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    await member.goto(`${baseUrl}/admin/`);
    await member.getByLabel('管理账号用户名').fill('member-plain');
    await member.getByLabel('管理账号密码').fill(password);
    await member.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(member.getByRole('alert')).toContainText('没有服务器管理权限');
  } finally { await memberContext.close(); }
});


test('a read-only operator reaches every page but gets no write control', async ({ page, browser }) => {
  // The owner grants the read-only role through the same control an administrator uses.
  await signIn(page, baseUrl);
  await page.goto(`${baseUrl}/admin/users?search=viewer-one`);
  await page.getByRole('button', { name: '详情', exact: true }).first().click();
  await page.getByRole('button', { name: '修改角色' }).click();
  await page.getByLabel('角色').selectOption('viewer');
  await page.getByLabel('原因（会写入审计）').fill('只读运维值班');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('操作已完成。')).toBeVisible();
  // The role now shows up in the account header and the note explains what it may do.
  await expect(page.getByText('只读运维').first()).toBeVisible();

  // A clean context: this one already holds the owner's management cookie.
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  try {
    await signIn(viewer, baseUrl, 'viewer-one');
    // The shell states the role up front instead of letting the first refused click explain it.
    await expect(viewer.getByRole('status')).toContainText('只读运维角色');
    // Reads stay available everywhere.
    await expect(viewer.getByRole('heading', { name: '运行概览' })).toBeVisible();
    await clickAdminLink(viewer, '任务中心');
    await expect(viewer.getByRole('button', { name: '创建任务' })).toBeDisabled();
    await viewer.getByRole('link', { name: '存储与备份' }).click();
    await expect(viewer.getByRole('button', { name: '立即清理回收站与暂存上传' })).toBeDisabled();
    await viewer.getByRole('link', { name: '系统设置' }).click();
    await expect(viewer.getByRole('button', { name: '保存本组设置' })).toBeDisabled();
  } finally { await viewerContext.close(); }
});

test('clears the management session in other tabs when one tab signs out', async ({ page, context }) => {
  await signIn(page, baseUrl);
  const second = await context.newPage();
  await second.goto(`${baseUrl}/admin/`);
  // A second tab restores the same management session instead of asking for credentials again.
  await expect(second.getByRole('link', { name: '运行概览' })).toBeVisible();
  await second.getByRole('button', { name: '退出管理后台' }).click();
  // Signing out in one tab clears the console everywhere else.
  await expect(page.getByRole('alert')).toContainText('其他标签页已改变管理会话');
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await second.close();
});

test('signs an administrator in with a second factor and shows the recovery codes once', async ({ page }) => {
  // Promote the dedicated account while the owner is signed in.
  await signIn(page, baseUrl);
  await page.getByRole('link', { name: '用户管理' }).click();
  await page.getByRole('row').filter({ has: page.getByText('mfa-admin', { exact: true }) }).getByRole('button', { name: '详情' }).click();
  await page.getByRole('button', { name: '修改角色' }).click();
  await page.getByLabel('角色').selectOption('admin');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('操作已完成。')).toBeVisible();
  await page.getByRole('button', { name: '退出管理后台' }).click();

  // The administrator enrolls their own factor: nobody can do it for them.
  await page.goto(`${baseUrl}/admin/security`);
  await page.getByLabel('管理账号用户名').fill('mfa-admin');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号安全' })).toBeVisible();
  await expect(page.getByText('未启用', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '生成绑定密钥' }).click();
  const secret = await page.getByLabel('绑定密钥（手动输入时使用）').inputValue();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await expect(page.getByText('未确认前不会生效')).toBeVisible();

  // A wrong code is refused, and the half-finished enrollment still does not gate the login.
  await page.getByLabel('两步验证码').fill('000000');
  await page.getByRole('button', { name: '确认并启用' }).click();
  await expect(page.getByText(/验证码不正确/)).toBeVisible();
  await expect(page.getByText('未启用', { exact: true })).toBeVisible();

  // The code from the authenticator activates the factor and hands out the recovery codes once.
  await page.getByLabel('两步验证码').fill(currentCode(secret));
  await page.getByRole('button', { name: '确认并启用' }).click();
  await expect(page.getByText('已启用', { exact: true })).toBeVisible();
  const pre = page.locator('pre');
  await expect(pre).toBeVisible();
  const codes = (await pre.innerText()).split(/\n/).map((line) => line.trim()).filter(Boolean);
  expect(codes).toHaveLength(10);
  expect(codes[0]).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  await page.getByRole('button', { name: '我已保存，隐藏恢复码' }).click();
  await expect(page.getByText('恢复码已从页面隐藏')).toBeVisible();

  // After a reload the secret and the codes are gone: the page never returns them again.
  await page.reload();
  await expect(page.getByText('已启用', { exact: true })).toBeVisible();
  await expect(page.getByLabel('绑定密钥（手动输入时使用）')).toHaveCount(0);
  await expect(page.locator('pre')).toHaveCount(0);

  // Signing in now stops at the second factor, and the console says so instead of failing.
  await page.getByRole('button', { name: '退出管理后台' }).click();
  await page.getByLabel('管理账号用户名').fill('mfa-admin');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByText(/账号密码已验证/)).toBeVisible();
  await expect(page.getByRole('link', { name: '运行概览' })).toHaveCount(0);
  await page.getByLabel('两步验证码').fill('000000');
  await page.getByRole('button', { name: '验证并进入后台' }).click();
  await expect(page.getByText(/两步验证未通过/)).toBeVisible();
  // The wrong code kept the challenge: the same screen still finishes the login.
  await page.getByLabel('两步验证码').fill(nextStepCode(secret));
  await page.getByRole('button', { name: '验证并进入后台' }).click();
  await expect(page.getByRole('link', { name: '运行概览' })).toBeVisible();

  // A recovery code works in the same field, which is all a lost device leaves behind.
  await page.getByRole('button', { name: '退出管理后台' }).click();
  await page.getByLabel('管理账号用户名').fill('mfa-admin');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('button', { name: '返回账号密码' })).toBeVisible();
  await page.getByLabel('两步验证码').fill(codes[0]);
  await page.getByRole('button', { name: '验证并进入后台' }).click();
  await expect(page.getByRole('link', { name: '运行概览' })).toBeVisible();

  // The spent code is gone: the page reports nine left, and no tenth chance exists.
  await page.getByRole('link', { name: '账号安全' }).click();
  await expect(page.getByText('9 个')).toBeVisible();
});
