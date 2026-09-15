import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.setTimeout(120_000);

test('filters daily transactions with the same category control as the record dialog', async ({ page }) => {
  await openLedger(page);
  const sidebar = page.locator('.zc-sidebar');

  // 日常流水（以及整行筛选器）只在非「轻量记账」模式下出现，所以先切到完整资产账本。
  await sidebar.getByRole('button', { name: /设置$/ }).click();
  await page.getByLabel('记账模式 · 录入深度').selectOption('assets');
  await sidebar.getByRole('button', { name: /日常收支$/ }).click();
  await expect(page.getByText('日常流水', { exact: true }).first()).toBeVisible();

  // 分类筛选走标准分类控件（两级+搜索），而不是一个上百项的原生下拉。
  const filter = page.getByLabel('流水分类');
  await expect(filter).toHaveRole('button');
  await expect(filter).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(filter).toContainText('全部分类');

  await filter.click();
  const panel = page.locator('.zc-category-picker-panel');
  await expect(panel).toBeVisible();
  // 一级分类分栏存在（标准控件是两栏，不是平铺列表）。
  await expect(panel.getByRole('button', { name: '交通出行' })).toBeVisible();

  await panel.getByPlaceholder('查找分类，输入可搜索隐藏分类').fill('加油');
  await panel.getByRole('option').first().click();
  await expect(filter).toContainText('加油 / 充电');

  // 「全部分类」= 清空筛选，恢复默认状态。
  await filter.click();
  await panel.getByRole('button', { name: '全部分类' }).click();
  await expect(filter).toContainText('全部分类');

  // 目录里尚未写入账本的分类不能作为筛选项：没有任何流水会引用它们。
  await filter.click();
  await panel.getByPlaceholder('查找分类，输入可搜索隐藏分类').fill('违章');
  await expect(panel.getByRole('option')).toHaveCount(0);
});
