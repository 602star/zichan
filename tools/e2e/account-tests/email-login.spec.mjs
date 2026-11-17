import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'email-browser-password';

async function fixture(delivery = false) {
  const setup = 'email-browser-owner-setup-000000000000';
  const sent = [];
  const server = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true,
    registrationMode: 'open', ownerSetupToken: setup,
    ...(delivery ? { accountEmailSender: async (_to, _subject, body) => { sent.push(body); } } : {}),
  });
  await server.ready;
  await listenOnSafePort(server.server);
  const url = `http://127.0.0.1:${server.server.address().port}`;
  await registerAccount(url, 'owner', password, { ownerSetupToken: setup });
  await registerAccount(url, 'email-user', password);
  return { url, sent, close: () => closeTestSyncServer(server) };
}

async function signIn(page, url, identifier = 'email-user') {
  await page.goto(url);
  await page.getByLabel('服务器用户名').fill(identifier);
  await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

async function openEmail(page) {
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await page.locator('.zc-sidebar').getByRole('button', { name: /我的账号$/ }).click();
  await page.getByRole('navigation', { name: '账号分类' }).getByRole('button', { name: '邮箱', exact: true }).click();
  const panel = page.getByRole('region', { name: '邮箱与通知', exact: true });
  await expect(panel.getByLabel('邮箱地址', { exact: true })).toBeVisible();
  return panel;
}

test('binds without SMTP and uses the email to reopen the same account and cache', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    const original = await page.evaluate(() => JSON.parse(localStorage.getItem('zichan.web-account.v2.binding')));
    let panel = await openEmail(page);
    await expect(panel).toContainText('仍可绑定邮箱并登录');
    await panel.getByLabel('邮箱地址', { exact: true }).fill('USER@example.com');
    await panel.getByRole('button', { name: '绑定邮箱', exact: true }).click();
    await expect(panel).toContainText('user@example.com（未验证）');
    await expect(panel.getByRole('checkbox')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '发送验证邮件' })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/email-login-desktop.png', fullPage: true });
    await page.reload();
    panel = await openEmail(page);
    await expect(panel).toContainText('user@example.com（未验证）');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'account', tab: 'security' } })));
    await page.getByRole('button', { name: '退出记账账号', exact: true }).click();
    await page.getByRole('button', { name: '确认退出', exact: true }).click();
    await expect(page.getByText('登录账号或邮箱', { exact: true })).toBeVisible();
    await page.getByLabel('服务器用户名').fill('USER@example.com');
    await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
    await page.screenshot({ path: 'test-results/email-login-form.png', fullPage: true });
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('zichan.web-account.v2.binding')));
    expect(restored.accountId).toBe(original.accountId);
    expect(restored.username).toBe('email-user');
    const names = await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name).filter((name) => name.endsWith(':database')));
    expect(names).toHaveLength(1);
    panel = await openEmail(page);
    await panel.getByLabel('邮箱地址', { exact: true }).fill('replacement@example.com');
    await panel.getByRole('button', { name: '更换绑定邮箱', exact: true }).click();
    await expect(panel).toContainText('replacement@example.com（未验证）');
    await expect(loginAccount(f.url, 'user@example.com', password)).rejects.toThrow();
    await panel.getByRole('button', { name: '移除邮箱', exact: true }).click();
    await page.getByRole('button', { name: '确认移除', exact: true }).click();
    await expect(panel).toContainText('尚未绑定邮箱');
    await expect(loginAccount(f.url, 'replacement@example.com', password)).rejects.toThrow();
  } finally { await page.close(); await f.close(); }
});

test('verifies a direct binding and shows usable email settings at narrow widths', async ({ page }) => {
  const f = await fixture(true);
  try {
    await signIn(page, f.url);
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    const panel = await openEmail(page);
    await panel.getByLabel('邮箱地址', { exact: true }).fill('verified@example.com');
    await panel.getByRole('button', { name: '绑定邮箱', exact: true }).click();
    await panel.getByRole('button', { name: '发送验证邮件', exact: true }).click();
    await expect(panel.getByLabel('邮箱验证码')).toBeVisible();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel.getByRole('button', { name: '验证邮箱', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/email-verification-${width}.png`, fullPage: true });
    }
    await panel.getByLabel('邮箱验证码').fill(/\d{8}/.exec(f.sent[0])[0]);
    await panel.getByRole('button', { name: '验证邮箱', exact: true }).click();
    await expect(panel).toContainText('verified@example.com（已验证）');
    const notifications = panel.getByRole('checkbox', { name: '配额接近上限时发送邮件提醒' });
    await notifications.click();
    await expect(panel).toContainText('通知偏好已保存');
    await expect(notifications).toBeChecked();
    await page.screenshot({ path: 'test-results/email-verified-320.png', fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel).toContainText('verified@example.com（已验证）');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/email-verified-dark-${width}.png`, fullPage: true });
    }
    await panel.getByLabel('邮箱地址', { exact: true }).fill('changed@example.com');
    await panel.getByRole('button', { name: '更换绑定邮箱', exact: true }).click();
    await expect(panel).toContainText('changed@example.com（未验证）');
    await expect(panel.getByRole('checkbox')).toHaveCount(0);
    await expect(panel.getByLabel('邮箱验证码')).toHaveCount(0);
  } finally { await page.close(); await f.close(); }
});

test('accepts a bound email in the management login', async ({ page }) => {
  const f = await fixture();
  try {
    const owner = await loginAccount(f.url, 'owner', password);
    const binding = await fetch(`${f.url}/api/auth/email`, { method: 'PUT', headers: {
      Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ email: 'operator@example.com' }) });
    expect(binding.status).toBe(200);
    await page.goto(`${f.url}/e2e-private-entry/admin/`);
    await expect(page.getByText('登录账号或邮箱', { exact: true })).toBeVisible();
    await page.getByLabel('管理账号用户名').fill('OPERATOR@example.com');
    await page.getByLabel('管理账号密码').fill(password);
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
    await expect(page.locator('.zc-admin-operator')).toContainText('owner');
  } finally { await page.close(); await f.close(); }
});
