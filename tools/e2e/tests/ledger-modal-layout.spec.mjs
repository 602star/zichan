import { test, expect } from './fixtures.mjs';
import { openTransactions } from './helpers.mjs';

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' });
test.beforeEach(async ({ page }) => { page.setDefaultTimeout(12_000); await page.clock.setFixedTime(new Date('2026-11-16T11:00:00Z')); });
const entry = (page, title = '新增 · 日常收支') => page.getByRole('dialog', { name: title, exact: true });
const row = (page, title) => page.locator('.zc-transaction-row').filter({ has: page.getByText(title, { exact: true }) });
const go = (page, screen, tab) => page.evaluate((data) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: data })), { screen, tab });
async function startExpense(page, title, amount) {
  await page.getByRole('button', { name: '+ 记账', exact: true }).click();
  await expect(entry(page)).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.zc-workspace-editor')).toHaveCount(0);
  await entry(page).getByLabel(/^金额/).fill(amount);
  await entry(page).getByLabel('描述', { exact: true }).fill(title);
}
async function save(page, modal) { await modal.getByRole('button', { name: '保存', exact: true }).click(); await expect(modal).toBeHidden(); }
async function startRefund(page, sourceRow) {
  if (!(await sourceRow.locator('xpath=following-sibling::tr[1]').locator('.zc-record-expansion').count())) await sourceRow.locator('.zc-transaction-summary-title').click();
  await sourceRow.locator('xpath=following-sibling::tr[1]').getByRole('button', { name: '记录退款', exact: true }).click();
  const modal = entry(page, '新增 · 记录退款');
  await expect(modal).toHaveAttribute('aria-modal', 'true');
  return modal;
}

test('refund editing hydrates an original excluded by filters and enforces the remaining refundable amount', async ({ page }) => {
  await openTransactions(page);
  await startExpense(page, '分次退款原消费', '100'); await save(page, entry(page));
  const original = row(page, '分次退款原消费');
  let refund = await startRefund(page, original);
  await refund.getByLabel(/^金额/).fill('30'); await save(page, refund);
  await expect(original.locator('td.is-numeric .zc-refund-chip')).toHaveText('部分退款 +30.00 CNY');
  await expect(original.locator('.zc-refund-net')).toHaveText('净支出 70.00 CNY');
  await expect(original.locator('td:has(.zc-transaction-summary-title) .zc-refund-chip')).toHaveCount(0);
  await page.getByRole('button', { name: /^筛选/ }).click();
  await page.getByRole('combobox', { name: '流水类型', exact: true }).selectOption('refund');
  await expect(original).toHaveCount(0);
  const refunded = row(page, '退款 · 分次退款原消费');
  await refunded.locator('.zc-transaction-summary-title').click();
  await page.locator('.zc-record-expansion').getByRole('button', { name: '编辑流水', exact: true }).click();
  const edit = entry(page, '编辑 · 记录退款');
  await expect(edit).toBeVisible();
  await expect(edit.getByLabel('退款关联原支出', { exact: true }).locator('option:checked')).toContainText('分次退款原消费');
  await expect(edit).toContainText('剩余可退 100');
  await edit.getByLabel(/^金额/).fill('20'); await save(page, edit);
  await expect(refunded.locator('.zc-transaction-amount-original')).toHaveText('+20.00 CNY');
  await page.getByRole('combobox', { name: '流水类型', exact: true }).selectOption('expense');
  await expect(original.locator('.zc-refund-net')).toHaveText('净支出 80.00 CNY');
  refund = await startRefund(page, original);
  await expect(refund.getByLabel(/^金额/)).toHaveValue('80');
  await refund.getByLabel(/^金额/).fill('81');
  await refund.getByRole('button', { name: '保存', exact: true }).click();
  await expect(refund.getByText('退款金额不能超过剩余可退 80', { exact: true })).toBeVisible();
  await expect(refund.getByLabel(/^金额/)).toBeFocused();
  await refund.getByLabel(/^金额/).fill('80'); await save(page, refund);
  await expect(original.locator('.zc-refund-chip')).toHaveText('全额退款 +100.00 CNY');
  await expect(original.locator('.zc-transaction-amount-original')).toHaveText('-100.00 CNY');
  await expect(original.locator('.zc-refund-net')).toHaveText('净支出 0.00 CNY');
  await original.locator('.zc-refund-chip').click();
  const history = page.getByRole('dialog', { name: '退款记录', exact: true });
  await expect(history.locator('.zc-refund-row')).toHaveCount(2);
  await history.locator('.zc-refund-row').filter({ hasText: '到账 20 CNY' }).getByRole('button', { name: '编辑', exact: true }).click();
  await expect(edit).toContainText('剩余可退 20');
  await expect(edit.getByLabel(/^金额/)).toHaveValue('20');
});

test('custom category paths remain fully visible and refunds occupy the amount column across paper themes', async ({ page }) => {
  await openTransactions(page);
  await page.getByText('更多操作', { exact: true }).click();
  await page.getByRole('button', { name: '新增分类', exact: true }).click();
  const category = page.getByRole('dialog', { name: '新增 · 收支分类', exact: true });
  const name = '跨城市演出交通住宿费用与超长自定义分类名称完整查看';
  await category.getByLabel(/^名称/).fill(name);
  await category.getByLabel('父级分类', { exact: true }).selectOption({ label: '交通出行' });
  await save(page, category);
  await startExpense(page, '超长分类流水摘要', '1234.56');
  await entry(page).getByLabel(/^分类/).click();
  const picker = page.getByRole('dialog', { name: '选择分类', exact: true });
  await picker.getByLabel('搜索分类', { exact: true }).fill(name);
  await picker.getByRole('option', { name: new RegExp(name) }).click();
  await save(page, entry(page));
  const original = row(page, '超长分类流水摘要');
  let refund = await startRefund(page, original);
  await refund.getByLabel(/^金额/).fill('400'); await save(page, refund);
  await expect(original.locator('.zc-refund-net')).toHaveText('净支出 834.56 CNY');
  await original.locator('.zc-transaction-summary-title').click();
  await expect(page.locator('.zc-undo-toast')).toHaveCount(0, { timeout: 15_000 });
  for (const paper of ['文献纸 · 墨朱', '青灰纸 · 墨朱', '紫灰纸 · 墨朱']) for (const mode of ['浅色', '深色']) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, 'settings', 'appearance');
    await page.getByRole('tab', { name: '外观', exact: true }).click();
    await page.getByRole('radio', { name: paper, exact: true }).click();
    await page.getByRole('radio', { name: mode, exact: true }).click();
    await go(page, 'transactions', 'records');
    for (const width of [1280, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const label = original.locator('.zc-transaction-category-label');
      await expect(label).toHaveText(`交通出行 / ${name}`);
      await expect(label).toHaveCSS('text-overflow', 'clip');
      expect(await label.evaluate((node) => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1)).toBe(true);
      await expect(original.locator('.zc-transaction-category')).toHaveAttribute('title', new RegExp(name));
      await expect(original.locator('td.is-numeric .zc-refund-chip')).toContainText('400.00 CNY');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${paper}/${mode}/${width}`).toBe(true);
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: test.info().outputPath(`${paper}-${mode}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '+ 记账', exact: true }).click();
  await expect(entry(page)).toHaveAttribute('aria-modal', 'true');
  await expect(entry(page).getByLabel(/^金额/)).toBeFocused();
  const bounds = await entry(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.width).toBeLessThan(1280);
  await page.screenshot({ path: test.info().outputPath('ledger-entry-modal.png') });
});
