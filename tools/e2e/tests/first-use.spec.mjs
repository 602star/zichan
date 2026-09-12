import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.setTimeout(90_000);

test('ignores old local mode and key envelopes and always starts at account login', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('zichan.firstUse.mode.v1', 'local');
    localStorage.setItem('zichan.device.storageEnvelope.v1', 'legacy-envelope-not-to-read');
  });
  await page.goto('/app/');
  await expect(page.getByRole('heading', { name: '账号登录' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^纯本地使用/ })).toHaveCount(0);
  await expect(page.getByLabel('完整服务器地址')).toHaveCount(0);
  await expect(page.getByLabel('本机数据密码', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  await openLedger(page);
  expect(await page.evaluate(() => localStorage.getItem('zichan.device.storageEnvelope.v1'))).toBe('legacy-envelope-not-to-read');
});

test('does not require persistent storage permission for an authenticated account cache', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperties(navigator.storage, {
    persisted: { configurable: true, value: async () => false },
    persist: { configurable: true, value: async () => false },
  }));
  await openLedger(page, { grantPersistentStorage: false });
  await expect(page.getByRole('button', { name: '确认风险，继续本地使用' })).toHaveCount(0);
  await page.reload();
  await openLedger(page, { grantPersistentStorage: false });
  await expect(page.locator('.zc-app-shell')).toBeVisible();
});

test('does not open a cached ledger after the account session is revoked', async ({ page, context }) => {
  await openLedger(page);
  await context.clearCookies();
  await page.reload();
  await expect(page.getByRole('heading', { name: '账号登录' })).toBeVisible();
  await expect(page.getByLabel('本机数据密码', { exact: true })).toHaveCount(0);
  await expect(page.locator('.zc-app-shell')).toHaveCount(0);
});

test('keeps administration separate while allowing additional sync servers', async ({ page }) => {
  await openLedger(page);
  await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
  await page.getByLabel('在侧边栏显示同步').click();
  await expect(page.getByLabel('在侧边栏显示同步')).toBeChecked();
  await page.locator('.zc-sidebar').getByRole('button', { name: /同步$/ }).click();
  await expect(page.getByRole('button', { name: '新增服务器', exact: true })).toBeVisible();
  await expect(page.getByLabel('完整服务器地址')).toBeDisabled();
  await expect(page.getByLabel('用户名', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /管理后台/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
  await expect(page.getByRole('button', { name: /启动.*服务器|停止.*服务器/ })).toHaveCount(0);
});
