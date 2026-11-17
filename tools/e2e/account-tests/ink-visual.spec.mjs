import { test, expect } from '../tests/fixtures.mjs';
import { registerAccount } from '../../../packages/db/dist/index.js';

test('ink and vermilion ledger renders at desktop and phone widths', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`));
  await registerAccount(baseURL, 'ink-visual-user', 'ink-visual-password');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(baseURL);
  await page.getByLabel('服务器用户名').fill('ink-visual-user');
  await page.getByLabel('服务器账号密码').fill('ink-visual-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '开始记账', exact: true }).click();
  await expect(page.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });
  const dismissGuide = page.getByRole('button', { name: '暂时收起' });
  if (await dismissGuide.isVisible().catch(() => false)) await dismissGuide.click();

  await page.locator('.zc-sidebar-nav-item').filter({ hasText: '工作台' }).click();
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  await expect(page.locator('.zc-dashboard-overview-band')).toBeVisible({ timeout: 45_000 });
  await page.screenshot({ path: test.info().outputPath('ink-dashboard-desktop.png'), fullPage: true });
  await page.locator('.zc-sidebar-nav-item').filter({ hasText: '流水' }).click();
  await expect(page.locator('.zc-transaction-summary-grid')).toBeVisible();
  await page.getByRole('button', { name: '+ 记账' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支' });
  await form.getByRole('textbox', { name: /^金额/ }).fill('128.50');
  await form.getByLabel('描述').fill('墨朱视觉核对');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('table').filter({ hasText: '墨朱视觉核对' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '金额' })).toBeVisible();
  await expect(page.getByText('已保存流水', { exact: true })).toBeHidden({ timeout: 15_000 });
  const filterToggle = page.locator('.zc-ledger-searchbar .zc-transaction-filter-toggle');
  await filterToggle.click();
  await expect(page.locator('#transaction-filter-panel')).toBeVisible();
  await filterToggle.click();
  await expect(page.locator('#transaction-filter-panel')).toBeHidden();
  await page.screenshot({ path: test.info().outputPath('ink-transactions-desktop.png'), fullPage: true });
  await page.locator('.zc-sidebar-nav-item').filter({ hasText: '物品资产' }).click();
  await expect(page.getByText('记录第一件真实物品')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('ink-fixed-desktop.png'), fullPage: true });
  await page.locator('.zc-sidebar-nav-item').filter({ hasText: '设置' }).click();
  await page.getByRole('tab', { name: '外观', exact: true }).or(page.getByRole('button', { name: '外观', exact: true })).click();
  await expect(page.getByRole('radiogroup', { name: '视觉方案' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('ink-settings-desktop.png'), fullPage: true });
  await page.locator('.zc-sidebar-nav-item').filter({ hasText: '流水' }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.zc-transaction-row')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('ink-transactions-phone.png'), fullPage: true });
  await page.locator('#transaction-records').evaluate((node) => node.scrollIntoView({ block: 'start' }));
  const mobileFold = await page.evaluate(() => ({
    search: document.querySelector('.zc-ledger-searchbar')?.getBoundingClientRect().top,
    row: document.querySelector('.zc-transaction-row')?.getBoundingClientRect().top,
    nav: document.querySelector('.zc-mobile-bottom-nav')?.getBoundingClientRect().top,
  }));
  expect(mobileFold.search, 'search should be visible before the bottom bar').toBeLessThan(mobileFold.nav);
  expect(mobileFold.row + 70, 'first record should be readable before the bottom bar').toBeLessThan(mobileFold.nav);
  await page.locator('.zc-mobile-bottom-nav').getByRole('button', { name: '总览' }).click();
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
  await expect(page.locator('.zc-dashboard-overview-band')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('ink-dashboard-phone.png'), fullPage: true });
  await page.locator('.zc-mobile-bottom-nav').getByRole('button', { name: '更多' }).click();
  await page.getByRole('dialog', { name: '更多功能' }).getByRole('button', { name: /设置/ }).click();
  await page.getByRole('tab', { name: '外观', exact: true }).or(page.getByRole('button', { name: '外观', exact: true })).click();
  await page.getByRole('radio', { name: '深色', exact: true }).click();
  const touchHeights = await page.getByRole('radiogroup').locator('[role="radio"]').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  expect(Math.min(...touchHeights)).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: test.info().outputPath('ink-settings-dark-phone.png'), fullPage: true });
});
