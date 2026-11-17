import { test, expect } from './fixtures.mjs';
import { openTransactions } from './helpers.mjs';

test('daily cards keep complete totals, recent dates open, and expose bulk disclosure on desktop and phone', async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 10, 17, 12));
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openTransactions(page);
  const guide = page.getByRole('button', { name: '暂时收起', exact: true });
  if (await guide.isVisible()) await guide.click();
  for (const [date, amount, title] of [
    ['2026-11-17', '28.50', '今天的午餐'], ['2026-11-11', '32', '七天边界晚餐'],
    ['2026-11-10', '78', '更早电影记录'], ['2026-11-01', '110', '月初生活用品'],
  ]) {
    await page.locator('#transaction-records').getByRole('button', { name: '+ 记账', exact: true }).click();
    const form = page.getByRole('dialog', { name: '新增 · 日常收支' });
    await form.getByRole('textbox', { name: /^金额/ }).fill(amount);
    await form.getByLabel('描述', { exact: true }).fill(title);
    await form.getByLabel('日期', { exact: true }).fill(date);
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(form).toBeHidden();
  }
  const records = page.locator('#transaction-records');
  await expect(records.locator('.zc-transaction-load-status')).toHaveText('已加载当前范围全部 4 笔');
  await expect(records.getByRole('button', { name: /继续加载/ })).toHaveCount(0);
  await expect(records.locator('.zc-transaction-day')).toHaveCount(4);
  await expect(records.getByText('今天的午餐', { exact: true })).toBeVisible();
  await expect(records.getByText('七天边界晚餐', { exact: true })).toBeVisible();
  await expect(records.getByText('更早电影记录', { exact: true })).toHaveCount(0);
  await expect(page.locator('.zc-transaction-summary-grid')).toContainText('¥248.50');
  const today = records.locator('.zc-transaction-row').filter({ hasText: '今天的午餐' });
  expect(await today.locator('td').evaluateAll((cells) => cells.map((cell) => cell.className))).toEqual([
    'zc-transaction-select', 'zc-transaction-date', 'zc-transaction-category', 'is-numeric zc-transaction-amount',
    'zc-transaction-summary', 'zc-transaction-account', 'zc-transaction-actions',
  ]);
  expect(await today.locator('td').first().evaluate((cell) => getComputedStyle(cell).borderBottomWidth)).toBe('0px');
  await expect(page.getByText('已保存流水', { exact: true })).toBeHidden({ timeout: 15_000 });
  await page.screenshot({ path: test.info().outputPath('ledger-day-cards-desktop.png'), fullPage: true });
  await records.screenshot({ path: test.info().outputPath('ledger-day-cards-records.png') });
  await records.getByRole('button', { name: '全部折叠', exact: true }).click();
  await expect(records.locator('.zc-transaction-row')).toHaveCount(0);
  await expect(records.locator('.zc-transaction-day')).toHaveCount(4);
  await expect(records.locator('.zc-transaction-day-summary').last()).toContainText('110.00');
  await records.getByRole('button', { name: '全部展开', exact: true }).click();
  await expect(records.locator('.zc-transaction-row')).toHaveCount(4);
  await records.getByRole('button', { name: '全部折叠', exact: true }).click();
  const search = records.locator('.zc-ledger-searchbar input');
  await search.fill('更早电影');
  await expect(records.getByText('更早电影记录', { exact: true })).toBeVisible();
  await search.fill('');
  await expect(records.locator('.zc-transaction-day')).toHaveCount(4);
  await expect(records.getByText('今天的午餐', { exact: true })).toBeVisible();
  for (const width of [1024, 820, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(records.getByRole('button', { name: '全部展开', exact: true })).toBeVisible();
    const overflow = await records.evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      return [...el.querySelectorAll('.zc-transaction-day, .zc-transaction-day-controls, .zc-transaction-row td')]
        .filter((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && (box.right > bounds.right + 1 || box.left < bounds.left - 1 || node.scrollWidth > node.clientWidth + 1); })
        .map((node) => ({ className: node.className, text: node.textContent }));
    });
    expect(overflow).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`ledger-day-cards-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: test.info().outputPath('ledger-day-cards-dark.png'), fullPage: true });
});
