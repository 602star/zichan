import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { clickAdminLink } from '../admin-navigation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'admin-clarity-fixture-0001';
const token = 'admin-clarity-owner-setup-000000000';

async function fixture(page) {
  const server = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken: token });
  await server.ready;
  await server.started;
  await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.server.address().port}`;
  const close = async () => { await page.close(); server.server.closeAllConnections(); await server.close(); };
  try {
    await registerAccount(url, 'operator', password, { ownerSetupToken: token });
    await registerAccount(url, 'support-user', password);
    await page.goto(`${url}/e2e-private-entry/admin/`);
    await page.getByLabel('管理账号用户名').fill('operator');
    await page.getByLabel('管理账号密码').fill(password);
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
    return { url, close };
  } catch (error) { await close(); throw error; }
}

for (const width of [1280, 390]) {
  test(`operator finds issues, user support and backup evidence at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    try {
      await expect(page.locator('#section-待处理事项')).toBeVisible();
      await expect(page.getByText('状态未知', { exact: true })).toHaveCount(0);
      expect(await page.locator('#section-待处理事项').evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(900);
      await expect(page.locator('#section-核心指标')).toBeVisible();
      await expect(page.locator('.zc-admin-nav details')).toHaveCount(0);
      const navigation = page.getByRole('navigation', { name: '管理后台导航' });
      if (width <= 767) await page.getByRole('button', { name: '菜单' }).click();
      for (const link of await navigation.getByRole('link').all()) await expect(link).toBeVisible();
      if (width <= 767) await page.keyboard.press('Escape');
      await expect(page.locator('.zc-admin-dashboard details')).toHaveCount(0);
      await expect(page.locator('#section-维护窗口')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`overview-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '查找用户与预览记账' }).click();
      await page.locator('.zc-admin-user-card').filter({ hasText: 'support-user' }).getByRole('button', { name: '账号详情', exact: true }).click();
      await expect(page.getByRole('button', { name: '预览记账数据', exact: true })).toBeVisible();
      expect(await page.getByRole('button', { name: '预览记账数据', exact: true }).evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(900);
      const support = page.locator('#section-用户支持摘要');
      await expect(support).toContainText('暂无同步记录');
      await expect(support).toContainText('尚未设置账本保护');
      await page.screenshot({ path: testInfo.outputPath(`user-support-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '该账号的同步诊断', exact: true }).click();
      await expect(page).toHaveURL(/accountId=.*username=support-user/);
      await expect(page.getByRole('heading', { name: '同步诊断' })).toBeVisible();
      await clickAdminLink(page, '存储与备份');
      const evidence = page.locator('#section-备份执行状态');
      await expect(evidence).toContainText('尚无执行记录');
      await expect(evidence).toContainText('运行状态未知');
      await page.screenshot({ path: testInfo.outputPath(`backup-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '配置备份计划' }).click();
      await expect(page).toHaveURL(/settings\?group=backup$/);
      await expect(page.getByRole('tab', { name: '备份计划' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.zc-admin-setting-reference').first()).toBeVisible();
      await expect(page.locator('.zc-admin-setting-reference summary')).toHaveCount(0);
      await page.getByRole('tab', { name: '记录保留', exact: true }).click();
      await page.getByLabel('运行日志保留条数', { exact: true }).fill('6000');
      await page.getByRole('tab', { name: '备份计划', exact: true }).click();
      await page.getByLabel('保留的成功备份份数', { exact: true }).fill('4');
      await page.getByLabel('备份位置（部署侧实际路径）', { exact: true }).fill(' D:/fixture-backups ');
      const saveResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/admin/settings'));
      await page.getByRole('button', { name: '保存本组设置', exact: true }).click();
      const saved = await saveResponse;
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON().settings).toEqual({ backupRetentionCount: 4, backupDirectory: ' D:/fixture-backups ' });
      await expect(page.getByText('本组没有未保存的修改。')).toBeVisible();
      await expect(page.getByLabel('备份位置（部署侧实际路径）', { exact: true })).toHaveValue('D:/fixture-backups');
      await page.getByRole('tab', { name: '记录保留', exact: true }).click();
      await expect(page.getByLabel('运行日志保留条数', { exact: true })).toHaveValue('6000');
      await page.getByRole('button', { name: '放弃本组改动', exact: true }).click();
      await expect(page.getByLabel('运行日志保留条数', { exact: true })).toHaveValue('5000');
      await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`), fullPage: true });
      await page.reload();
      await expect(page.getByRole('tab', { name: '记录保留' })).toHaveAttribute('aria-selected', 'true');
      await clickAdminLink(page, '任务中心');
      await expect(page.getByRole('heading', { name: '任务中心', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await f.close(); }
  });
}

test('missing overview data is unknown rather than healthy', async ({ page }) => {
  await page.route('**/api/admin/overview', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test sampling unavailable' }) }));
  const f = await fixture(page);
  try {
    await expect(page.getByText('状态未知', { exact: true })).toBeVisible();
    await expect(page.getByText('运行正常', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/当前没有检测到待处理事项/)).toHaveCount(0);
  } finally { await f.close(); }
});

test('dark console keeps direct navigation and returns to the same page', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await fixture(page);
  try {
    await expect(page.locator('.zc-admin-root')).toHaveAttribute('data-mode', 'dark');
    await page.screenshot({ path: testInfo.outputPath('overview-dark.png'), fullPage: true });
    await clickAdminLink(page, '任务中心');
    await expect(page.getByRole('heading', { name: '任务中心', exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
    await clickAdminLink(page, '系统设置');
    await page.getByRole('tab', { name: '备份计划' }).click();
    await expect(page.locator('.zc-admin-deployment')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('settings-dark.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await f.close(); }
});
