import { test, expect } from './fixtures.mjs';
import { openLedger, openTransactions } from './helpers.mjs';

test.setTimeout(120_000);

/** 日常流水（以及整行筛选器、高级查询）只在非「轻量记账」模式下出现。 */
async function openDailyTransactions(page) {
  const sidebar = page.locator('.zc-sidebar');
  await sidebar.getByRole('button', { name: /设置$/ }).click();
  await page.getByLabel('记账模式 · 录入深度').selectOption('assets');
  await sidebar.getByRole('button', { name: /日常收支$/ }).click();
  await expect(page.getByText('日常流水', { exact: true }).first()).toBeVisible();
}

test('filters daily transactions with the same category control as the record dialog', async ({ page }) => {
  await openLedger(page);
  await openDailyTransactions(page);

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

test('picks an advanced-query category value with the searchable category control', async ({ page }) => {
  await openLedger(page);
  await openDailyTransactions(page);

  await page.getByRole('button', { name: /^高级查询/ }).click();
  await page.getByRole('button', { name: '+ 条件' }).click();
  const row = page.locator('.zc-advanced-condition-row').first();
  await row.getByLabel('高级查询字段').selectOption('category');

  const value = row.getByLabel('高级查询值');
  await expect(value).toHaveRole('button');
  await expect(value).toContainText('请选择');

  await value.click();
  const panel = page.locator('.zc-category-picker-panel');
  await expect(panel).toBeVisible();
  await panel.getByPlaceholder('查找分类，输入可搜索隐藏分类').fill('加油');
  await panel.getByRole('option').first().click();
  await expect(value).toContainText('加油 / 充电');

  // 查询预览用的还是同一套标签，说明选项集没有换掉。
  await expect(page.getByText(/当前查询：.*加油\s*\/\s*充电/)).toBeVisible();
});

test('picks a batch-modify category with the searchable category control', async ({ page }) => {
  await openTransactions(page);
  // 轻量记账模式下记一笔，才有可供批量修改的流水。
  await page.getByRole('button', { name: '+ 记支出' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await page.getByRole('textbox', { name: /^金额/ }).fill('12');
  await page.getByLabel('描述').fill('批量修改目标');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('批量修改目标', { exact: true })).toBeVisible();

  await page.getByRole('checkbox', { name: '选择 批量修改目标' }).check();
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  const modal = page.getByRole('dialog', { name: /批量修改流水/ });
  await expect(modal).toBeVisible();

  const value = modal.getByLabel('批量修改分类');
  await expect(value).toHaveRole('button');
  // 未选择时的提示语与原来原生下拉的占位项一致。
  await expect(value).toContainText('不改分类');

  await value.click();
  const panel = modal.locator('.zc-category-picker-panel');
  await expect(panel).toBeVisible();
  await panel.getByPlaceholder('查找分类，输入可搜索隐藏分类').fill('咖啡');
  await panel.getByRole('option').first().click();
  await expect(value).toContainText('咖啡');
});
