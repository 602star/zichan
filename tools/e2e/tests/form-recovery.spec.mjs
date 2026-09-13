import { test, expect } from './fixtures.mjs';
import { openLedger, openTransactions } from './helpers.mjs';

test.setTimeout(120_000);

test('points at the field that blocks a save instead of only refusing', async ({ page }) => {
  await openTransactions(page);
  await page.getByRole('button', { name: '+ 记支出' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await expect(form).toBeVisible();

  const amount = form.getByRole('textbox', { name: /^金额/ });
  await expect(amount).toHaveValue('');
  await page.getByRole('button', { name: '保存', exact: true }).click();

  // The refusal now names the fields and offers a jump, instead of a bare "请检查标出的必填项".
  const recovery = form.getByRole('alert');
  await expect(recovery).toContainText('需要处理');
  await expect(form.getByText('金额必须大于 0', { exact: true })).toBeVisible();
  await expect(amount).toBeFocused();

  // Moving away and clicking the chip comes back to the same field.
  await form.getByLabel('描述').click();
  await expect(amount).not.toBeFocused();
  await recovery.getByRole('button', { name: '金额', exact: true }).click();
  await expect(amount).toBeFocused();

  // 描述 is no longer mandatory, so the amount alone is enough to save.
  await amount.fill('42');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText('暂无流水')).toHaveCount(0);
});

test('saves an item asset that only registers the purchase', async ({ page }) => {
  await openLedger(page);
  const sidebar = page.locator('.zc-sidebar');
  await sidebar.getByRole('button', { name: /物品资产$/ }).click();
  await page.getByRole('button', { name: '+ 新增物品' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 物品资产' });
  await expect(form).toBeVisible();

  await form.getByLabel('名称').fill('Playwright 记录用相机');
  await page.getByRole('button', { name: '保存', exact: true }).click();

  /*
   * The three cashflow fields are required only while 同时创建支出 is selected.
   * 仅登记物品 must save without them, and without a jump prompt.
   */
  await expect(form).toBeHidden();
  await expect(page.getByText('Playwright 记录用相机', { exact: true })).toBeVisible();
});
