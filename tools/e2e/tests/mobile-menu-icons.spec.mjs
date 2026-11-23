import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.use({ hasTouch: true, isMobile: true, timezoneId: 'Asia/Shanghai' });
test.setTimeout(60_000);

for (const width of [320, 390]) test(`mobile menu has budget and bill icons without desktop controls at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ colorScheme: width === 320 ? 'dark' : 'light' });
  await openLedger(page);
  const nav = page.getByRole('navigation', { name: '移动端主导航', exact: true });
  await nav.getByRole('button', { name: '更多', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '更多功能', exact: true });
  for (const [name, icon] of [['预算', 'lucide-chart-pie'], ['账单与还款', 'lucide-receipt-text']]) {
    const entry = menu.getByRole('button', { name, exact: true });
    await expect(entry).toBeVisible();
    await expect(entry.locator(`svg.zc-task-list-icon.${icon}`)).toHaveCount(1);
  }
  for (const entry of await menu.locator('.zc-task-list button').all()) await expect(entry.locator('svg.zc-task-list-icon')).toHaveCount(1);
  await expect(menu.getByText('添加到桌面侧栏', { exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: '资料管理', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: '报表', exact: true })).toBeVisible();
  expect(await menu.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`more-${width}.png`) });
  await menu.getByRole('button', { name: '预算', exact: true }).click();
  await expect(page.locator('.zc-ledger-page')).toHaveClass(/is-budget/);
  await nav.getByRole('button', { name: '更多', exact: true }).click();
  await menu.getByRole('button', { name: '账单与还款', exact: true }).click();
  await expect(page.locator('.zc-ledger-page')).toHaveClass(/is-bills/);
  await nav.getByRole('button', { name: '更多', exact: true }).click();
  await menu.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '记账', exact: true }).click();
  await expect(page.getByRole('heading', { name: '侧边栏与模块', exact: true })).toHaveCount(0);
  await expect(page.locator('input[aria-label^="在侧边栏显示"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(上移|下移)/ })).toHaveCount(0);
  await expect(nav.getByRole('button')).toHaveText(['总览', '收支', '记一笔', '资产', '更多']);
  await page.screenshot({ path: test.info().outputPath(`settings-${width}.png`) });
});
