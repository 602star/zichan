import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.setTimeout(120_000);

test('game season saves an optional in-game fee and a paid record without a cash fee', async ({ page }) => {
  await openLedger(page);
  await page.locator('.zc-sidebar nav button').filter({ hasText: '设置' }).click();
  await page.getByLabel('在侧边栏显示游戏赛季').click();
  await expect(page.getByLabel('在侧边栏显示游戏赛季')).toBeChecked();
  await page.locator('.zc-sidebar nav button').filter({ hasText: '游戏赛季' }).click();
  await page.getByLabel('游戏名称').fill('通货记账测试');
  await page.getByRole('button', { name: '开始记录', exact: true }).click();

  await page.getByRole('button', { name: '+ 记录', exact: true }).click();
  let form = page.getByRole('dialog', { name: '新增 · 游戏记录', exact: true });
  await form.getByLabel('新游戏币名称').fill('通货');
  await form.getByLabel('游戏币数量').fill('1000');
  await form.getByLabel('历史价格').selectOption('unknown');
  await form.getByLabel('游戏币手续费（可选）').fill('0');
  await form.getByLabel('备注', { exact: true }).fill('到账900通货');
  await expect(form.getByLabel('手续费账户')).toHaveCount(0);
  await expect(form.getByLabel('结算账户')).toHaveCount(0);
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByRole('alert').first()).toBeVisible();
  await form.getByLabel('游戏币手续费（可选）').fill('100');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('button', { name: '编辑游戏记录 到账900通货', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '+ 记录', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 游戏记录', exact: true });
  await form.getByLabel('游戏币名称').selectOption('通货');
  await form.getByLabel('游戏币数量').fill('1000');
  await form.getByLabel('游戏币手续费（可选）').fill('100');
  const currency = form.getByLabel('实际收支币种');
  const assetId = await currency.locator('option').nth(1).getAttribute('value');
  await currency.selectOption(assetId);
  await form.getByLabel('实际收支金额').fill('20');
  await expect(form.getByRole('status')).toContainText('成交汇率：1 元 ≈ 50 通货；到账汇率：1 元 ≈ 45 通货');
  await expect(form.getByLabel('收支资金处理')).toHaveValue('create_transaction');
  await expect(form.getByLabel('结算账户')).toHaveCount(0);
  await expect(form.getByLabel('手续费账户')).toHaveCount(0);
  await form.getByLabel('备注', { exact: true }).fill('付20元到账900通货');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('button', { name: '编辑游戏记录 付20元到账900通货', exact: true })).toBeVisible();

  for (const [recordType, quantity, rate, note, valuation] of [
    ['buy_equipment', '100', '2', '赛季初装备', '估值 50'],
    ['sell_equipment', '10', '10', '贬值后卖出装备', '估值 1'],
  ]) {
    await page.getByRole('button', { name: '+ 记录', exact: true }).click();
    form = page.getByRole('dialog', { name: '新增 · 游戏记录', exact: true });
    await form.getByLabel('记录类型').selectOption(recordType);
    await form.getByLabel('游戏币名称').selectOption('通货');
    await form.getByLabel('游戏币数量').fill(quantity);
    await form.getByLabel('当时汇率：1 计价币种可换游戏币').fill(rate);
    await form.getByLabel('汇率计价币种').selectOption(assetId);
    await expect(form.getByRole('status')).toContainText(valuation.replace('估值 ', '本次 '));
    await form.getByLabel('备注', { exact: true }).fill(note);
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(form).toBeHidden();
    await expect(page.getByRole('button', { name: `编辑游戏记录 ${note}`, exact: true })).toContainText(valuation);
  }
});
