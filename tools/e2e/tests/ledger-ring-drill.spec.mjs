import { test, expect } from './fixtures.mjs';
import { openTransactions } from './helpers.mjs';

test.setTimeout(180_000);

/** 流水列表里的行（不含「最近使用」模板条）。 */
function rows(page) {
  return page.locator('#transaction-records .zc-transaction-row');
}

/** 在轻量记账模式下记一笔支出（只填二级分类、描述、金额）。 */
async function recordExpense(page, { category, description, amount }) {
  await page.getByRole('button', { name: '+ 记支出' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await form.getByLabel('二级分类').click();
  const panel = form.locator('.zc-category-picker-panel');
  await panel.getByPlaceholder('查找分类，输入可搜索隐藏分类').fill(category);
  await panel.getByRole('option', { name: new RegExp(category) }).first().click();
  await form.getByLabel('描述').fill(description);
  await page.getByRole('textbox', { name: /^金额/ }).fill(amount);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(rows(page).getByText(description, { exact: true })).toBeVisible();
}

/**
 * 构成环是「点一段就按这个分类筛」，而轻量模式根本不渲染筛选行（`Filters` 只在资产
 * 模式出现）。所以环写进去的那条分类筛选必须自带出口：一个「清除分类下钻」按钮，
 * 以及再点同一段直接取消——否则点一下环就把账本锁进一个看不见的筛选里，只能刷新
 * 页面才回得去。
 */
test('the composition ring drill can be undone, with the range it overwrote', async ({ page }) => {
  await openTransactions(page);
  await recordExpense(page, { category: '堂食餐饮', description: '午餐', amount: '38.50' });
  await recordExpense(page, { category: '公交地铁', description: '通勤', amount: '6' });

  const lunch = rows(page).getByText('午餐', { exact: true });
  const commute = rows(page).getByText('通勤', { exact: true });
  const slice = page.locator('.zc-donut-legend-row.is-drillable', { hasText: '堂食餐饮' });
  const chip = page.getByRole('button', { name: /清除分类下钻/ });
  const preset = page.getByLabel('快捷时间范围');

  await expect(lunch).toBeVisible();
  await expect(commute).toBeVisible();
  await expect(chip).toBeHidden();

  // 把区间先拨到「全部时间」，这样才看得出下钻顺手改掉的区间有没有还回来。
  await preset.selectOption('all');
  await slice.click();
  await expect(lunch).toBeVisible();
  await expect(commute).toBeHidden();
  await expect(slice).toHaveClass(/is-selected/);
  await expect(preset).toHaveValue('this_month');

  await expect(chip).toBeVisible();
  await chip.click();
  await expect(commute).toBeVisible();
  await expect(slice).not.toHaveClass(/is-selected/);
  await expect(chip).toBeHidden();
  await expect(preset).toHaveValue('all');

  // 再点同一段环就是取消，不必先去找按钮。
  await slice.click();
  await expect(commute).toBeHidden();
  await expect(chip).toBeVisible();
  await slice.click();
  await expect(commute).toBeVisible();
  await expect(chip).toBeHidden();
});

/**
 * 报表页的同一道题：它的下钻自带一个「清除分类下钻」chip（在日期行右侧），这里锁住它
 * 真的能把流水明细放回来——用户报的若是这一页，先要确定它现在是好的。
 */
test('the reports composition ring clear chip undoes the drill', async ({ page }) => {
  await openTransactions(page);
  await recordExpense(page, { category: '堂食餐饮', description: '午餐', amount: '38.50' });
  await recordExpense(page, { category: '公交地铁', description: '通勤', amount: '6' });

  await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
  // 报表默认不在侧边栏；滑块包裹在 <label> 里，点输入框会被标签再激活一次（状态回到原样），
  // 所以用键盘激活这一次——与用户按空格同一条路。
  const reportsNav = page.getByRole('checkbox', { name: /在侧边栏显示.*支出报表/ });
  await reportsNav.focus();
  await reportsNav.press('Space');
  await expect(reportsNav).toBeChecked();
  await page.locator('.zc-sidebar').getByRole('button', { name: /报表$/ }).click();
  const details = page.locator('#transaction-report-details');
  const lunch = details.getByText('午餐', { exact: true });
  const commute = details.getByText('通勤', { exact: true });
  const chip = page.getByRole('button', { name: /清除分类下钻/ });

  await expect(details).toContainText('流水明细');
  await expect(chip).toBeHidden();

  await page.locator('.zc-donut-legend-row.is-drillable', { hasText: '堂食餐饮' }).click();
  await expect(details).toContainText('已按分类下钻');
  await expect(lunch).toBeVisible();
  await expect(commute).toBeHidden();

  await expect(chip).toBeVisible();
  await chip.click();
  await expect(details).not.toContainText('已按分类下钻');
  await expect(commute).toBeVisible();
  await expect(chip).toBeHidden();
});
