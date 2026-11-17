import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { clickAdminLink } from '../admin-navigation.mjs';

// Exercise the maximum accepted username against a real authenticated account.
const username = `operations-owner-${'x'.repeat(47)}`;
const password = 'admin-chrome-test-password';
const test = base.extend({
  baseURL: async ({}, use) => {
    const ownerSetupToken = 'admin-chrome-test-owner-000000000000000000';
    const server = createSyncServer({ enableWeb: true, webDir: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)), registrationMode: 'open', ownerSetupToken });
    try {
      await server.ready;
      await listenOnSafePort(server.server, '127.0.0.1');
      const url = `http://127.0.0.1:${server.server.address().port}`;
      await registerAccount(url, username, password, { ownerSetupToken });
      await use(url);
    } finally { await closeTestSyncServer(server); }
  },
});

test('keeps the ink rail through long pages and preserves header actions at narrow widths', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/e2e-private-entry/admin/');
  await page.getByLabel('管理账号用户名').fill(username);
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览', exact: true })).toBeVisible();
  await clickAdminLink(page, '访问与请求');
  await expect(page.getByText('正在读取…', { exact: true })).toHaveCount(0);
  const header = page.locator('.zc-admin-topbar');
  const sidebar = page.getByRole('navigation', { name: '管理后台导航' });
  for (const width of [3744, 1920, 1280, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width === 3744 ? 1012 : 900 });
    await page.evaluate(() => scrollTo(0, 0));
    await expect(header.getByRole('button', { name: '退出', exact: true })).toBeVisible();
    expect((await header.locator('.zc-admin-brand-copy').boundingBox()).width).toBeGreaterThan(width >= 768 ? 60 : 30);
    expect(await header.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`admin-chrome-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight / 2));
  const scrollY = await page.evaluate(() => window.scrollY);
  await sidebar.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await expect(sidebar.getByRole('link', { name: '系统设置', exact: true })).toBeInViewport();
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('admin-chrome-scroll-middle.png') });
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => Boolean(document.elementFromPoint(8, innerHeight - 2)?.closest('.zc-admin-nav-rail')))).toBe(true);
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('admin-chrome-scroll-bottom.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('admin-chrome-1280-dark.png') });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('admin-chrome-320-dark.png') });
  const menu = page.getByRole('button', { name: '菜单', exact: true });
  await menu.click();
  await sidebar.getByRole('link', { name: '账号安全', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('admin-chrome-drawer-320-dark.png') });
  await sidebar.getByRole('link', { name: '账号安全', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号安全', exact: true })).toBeVisible();
  await menu.click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await page.evaluate(() => scrollTo(0, 0));
  await header.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录管理后台', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('admin-chrome-login-320-dark.png') });
  expect(errors).toEqual([]);
});
