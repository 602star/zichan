import { test, expect } from './fixtures.mjs';
import { openTransactions } from './helpers.mjs';

test.setTimeout(360_000);

/** One expense row, located by its description. */
function rowFor(page, description) {
  return page.locator('.zc-transaction-row').filter({ hasText: description });
}

async function recordExpense(page, { amount, description }) {
  await page.getByRole('button', { name: '+ 记账' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支' });
  await expect(form).toBeVisible();
  await page.getByRole('textbox', { name: /^金额/ }).fill(amount);
  await page.getByLabel('描述').fill(description);
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(description, { exact: true })).toBeVisible();
}

/** The amount cell of a row, so its strike-through can be measured. */
async function amountDecoration(row) {
  return row.locator('span').filter({ hasText: /CNY$/ }).last()
    .evaluate((el) => getComputedStyle(el).textDecorationLine);
}

test('a refund in the same currency never asks for a second amount', async ({ page }) => {
  await openTransactions(page);
  await recordExpense(page, { amount: '100', description: '退款可见性' });
  const row = rowFor(page, '退款可见性');

  await row.getByRole('button', { name: '退款', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 记录退款' });
  await expect(form).toBeVisible();
  // 同币种时到账金额就是冲减金额，第二个字段只是让人把两个数填岔。
  await expect(form.getByLabel('冲减原消费金额')).toHaveCount(0);
  await expect(form.getByText(/本次到账金额；剩余可退 100/)).toBeVisible();

  await form.getByRole('textbox', { name: /^金额/ }).fill('30');
  await form.getByRole('button', { name: '保存', exact: true }).click();

  // 部分退款：行上写明已退多少，仍然能继续退，金额不画掉。
  await expect(row.locator('.zc-refund-chip')).toHaveText('部分退款 · 已退 30 / 100 CNY');
  await expect(row.getByRole('button', { name: '退款', exact: true })).toBeVisible();
  expect(await amountDecoration(row)).not.toContain('line-through');

  // 两张卡片必须读同一个口径：100 - 30 = 70。
  const summary = page.locator('.zc-transaction-summary-grid');
  await expect(summary).toContainText('本月支出');
  await expect(summary).toContainText('¥70.00');
  await expect(summary.locator('.zc-transaction-summary-metric').nth(1)).toContainText('¥70.00');
  await expect(summary.locator('.zc-transaction-summary-metric').nth(3)).toContainText('¥70.00');
});

test('a full refund settles the row instead of leaving it looking unpaid', async ({ page }) => {
  await openTransactions(page);
  await recordExpense(page, { amount: '80', description: '全额退款可见性' });
  const row = rowFor(page, '全额退款可见性');

  await row.getByRole('button', { name: '退款', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 记录退款' });
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: '保存', exact: true }).click();

  // 原支出留在列表里（历史要留），但要读成已结清：金额划线、不再有“退款”入口。
  await expect(row.locator('.zc-refund-chip')).toHaveText('已退 80 / 80 CNY');
  await expect(row.getByRole('button', { name: '退款', exact: true })).toHaveCount(0);
  expect(await amountDecoration(row)).toContain('line-through');

  // 同一屏的两个数字不再互相矛盾。
  const summary = page.locator('.zc-transaction-summary-grid');
  await expect(summary).toContainText('¥0.00');
  await expect(summary.locator('.zc-transaction-summary-metric').nth(1)).toContainText('¥0.00');
  await expect(summary.locator('.zc-transaction-summary-metric').nth(3)).toContainText('¥0.00');
});

test('a fully refunded expense keeps a way into its refunds, and voiding restores it', async ({ page }) => {
  await openTransactions(page);
  await recordExpense(page, { amount: '80', description: '退款后仍可管理' });
  const row = rowFor(page, '退款后仍可管理');

  await row.getByRole('button', { name: '退款', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 记录退款' });
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(row.locator('.zc-refund-chip')).toBeVisible();

  // 退款行本身不在“支出”列表里，所以全额退款后这个入口是唯一的去处；
  // 没有它，用户既作废不了原支出（“请先作废关联退款”）也碰不到那笔退款。
  await row.locator('.zc-refund-chip').click();
  const history = page.getByRole('dialog', { name: '退款记录' });
  await expect(history).toBeVisible();
  await expect(history).toContainText('已退 80 CNY');
  await expect(history).toContainText('剩余可退 0 CNY');

  await history.getByRole('button', { name: '作废' }).click();
  const confirm = page.getByRole('dialog', { name: '作废退款' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '作废', exact: true }).click();

  // 作废退款后原支出回到未退款状态，两个入口各自复位。
  await expect(row.locator('.zc-refund-chip')).toHaveCount(0);
  await expect(row.getByRole('button', { name: '退款', exact: true })).toBeVisible();
  const summary = page.locator('.zc-transaction-summary-grid');
  await expect(summary.locator('.zc-transaction-summary-metric').nth(1)).toContainText('¥80.00');
  await expect(summary.locator('.zc-transaction-summary-metric').nth(3)).toContainText('¥80.00');
});
