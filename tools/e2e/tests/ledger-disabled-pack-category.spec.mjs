import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.setTimeout(180_000);

/** 在轻量记账模式下记一笔支出（只填金额、分类、描述）。 */
async function recordExpense(page, { category, description, amount, dialogName }) {
  await page.getByRole('button', { name: '+ 记支出' }).click();
  const form = page.getByRole('dialog', { name: dialogName });
  await form.getByLabel('二级分类').click();
  const panel = page.locator('.zc-category-picker-panel');
  await panel.getByLabel('搜索分类', { exact: true }).fill(category);
  await panel.getByRole('option', { name: new RegExp(category) }).first().click();
  await form.getByLabel('描述').fill(description);
  await page.getByRole('textbox', { name: /^金额/ }).fill(amount);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(description, { exact: true })).toBeVisible();
}

/**
 * 停用扩展包会把成员分类写成 isActive:false + isHidden:true。那些分类下的旧流水
 * 在列表里照常显示分类名，但筛选和高级查询里根本没有这一项——只能把扩展包重新
 * 启用才查得了。这条同时锁住：读路径查得到、写路径仍然选不到。
 */
test('keeps transactions of a disabled pack filterable without re-enabling it', async ({ page }) => {
  await openLedger(page);
  const sidebar = page.locator('.zc-sidebar');

  // 1. 启用「学生」扩展包，用其中的「食堂」记一笔，另记一笔普通分类作对照。
  await sidebar.getByRole('button', { name: /设置$/ }).click();
  await page.getByLabel('在侧边栏显示管理').click();
  await sidebar.getByRole('button', { name: /管理$/ }).click();
  await page.getByRole('button', { name: '快捷显示与排序', exact: true }).click();
  const studentPack = page.getByTestId('category-pack-student');
  await studentPack.getByRole('button', { name: '启用学生扩展包', exact: true }).click();
  await expect(studentPack.getByText('7 项全部可用', { exact: true })).toBeVisible();

  await page.getByText('日常支出', { exact: true }).first().click();
  await recordExpense(page, { category: '食堂', description: '停用前的食堂消费', amount: '42', dialogName: '新增 · 日常支出' });
  await recordExpense(page, { category: '堂食餐饮', description: '普通午餐', amount: '18', dialogName: '新增 · 日常支出' });

  // 2. 停用扩展包：这会把「食堂」停用，即使它已经被引用过。
  await sidebar.getByRole('button', { name: /管理$/ }).click();
  await page.getByRole('button', { name: '快捷显示与排序', exact: true }).click();
  await page.getByTestId('category-pack-student').getByRole('button', { name: '停用学生扩展包', exact: true }).click();
  await expect(page.getByText(/已停用「学生」扩展包/).first()).toBeVisible();
  // 已用过的分类仍然被停用（只是提示「仍保留历史引用」），这正是问题的来源。
  await expect(page.getByText(/仍保留历史引用/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0, { timeout: 20_000 });

  // 3. 切到完整资产账本——日常流水的筛选行只在非轻量模式下出现。
  await sidebar.getByRole('button', { name: /设置$/ }).click();
  await page.getByLabel('记账模式 · 录入深度').selectOption('assets');
  await sidebar.getByRole('button', { name: /日常收支$/ }).click();
  await expect(page.getByText('日常流水', { exact: true }).first()).toBeVisible();

  // 旧流水还在，分类名照常显示。
  await expect(page.getByText('停用前的食堂消费', { exact: true })).toBeVisible();
  await expect(page.getByText('普通午餐', { exact: true })).toBeVisible();

  // 4. 读路径：停用分类跟「隐藏」同一套行为——默认列表里不占位置，
  //    但搜得到，也能用「显示隐藏」翻出来，并带「已停用」徽标（不是「隐藏」）。
  const filter = page.getByLabel('流水分类');
  const panel = page.locator('.zc-category-picker-panel');
  await filter.click();
  await expect(panel.getByRole('option', { name: /食堂/ })).toHaveCount(0);
  await panel.getByRole('button', { name: /显示隐藏/ }).click();
  await expect(panel.getByRole('option', { name: /食堂/ }).first()).toContainText('已停用');
  await panel.getByRole('button', { name: '只看高频' }).click();
  await panel.getByLabel('搜索分类', { exact: true }).fill('食堂');
  const option = panel.getByRole('option', { name: /食堂/ }).first();
  await expect(option).toBeVisible();
  await expect(option).toContainText('已停用');
  await option.click();
  await expect(filter).toContainText('食堂');

  // 5. 选中后确实能筛出那笔流水，对照流水被排除。
  await expect(page.getByText('停用前的食堂消费', { exact: true })).toBeVisible();
  await expect(page.getByText('普通午餐', { exact: true })).toBeHidden();

  // 6. 「全部分类」回到不筛选，对照流水回来。
  await filter.click();
  await panel.getByRole('button', { name: '全部分类' }).click();
  await expect(page.getByText('普通午餐', { exact: true })).toBeVisible();

  // 6b. 写路径（记账弹窗）仍然搜不到停用分类。
  await page.getByRole('button', { name: '+ 记账' }).click();
  const entryForm = page.getByRole('dialog', { name: /新增/ });
  await entryForm.getByLabel('二级分类').click();
  const entryPanel = page.locator('.zc-category-picker-panel');
  await entryPanel.getByLabel('搜索分类', { exact: true }).fill('食堂');
  await expect(entryPanel.getByRole('option', { name: /食堂/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await entryForm.getByRole('button', { name: '取消', exact: true }).click();

  // 7. 高级查询的「二级分类」也能取到停用分类。
  await page.getByRole('button', { name: /^高级查询/ }).click();
  await page.getByRole('button', { name: '+ 条件组 OR', exact: true }).click();
  const row = page.locator('.zc-advanced-condition-row').first();
  await row.getByLabel('高级查询字段').selectOption('category');
  await row.getByLabel('高级查询值').click();
  await panel.getByLabel('搜索分类', { exact: true }).fill('食堂');
  await expect(panel.getByRole('option', { name: /食堂/ }).first()).toContainText('已停用');
  await panel.getByRole('option', { name: /食堂/ }).first().click();
  await expect(row.getByLabel('高级查询值')).toContainText('食堂');
  await expect(page.getByText(/当前查询：/)).toContainText('食堂');

  // 8. 写路径仍然不给选：批量修改是目标值，不能把停用分类当新引用。
  await row.getByTitle('删除条件').click();
  await page.getByRole('button', { name: /^高级查询/ }).click();
  await page.getByLabel('选择 停用前的食堂消费').check();
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  const batch = page.getByRole('dialog', { name: '批量修改流水' });
  await batch.getByLabel('批量修改分类').click();
  await page.getByRole('dialog', { name: '选择分类', exact: true }).getByLabel('搜索分类', { exact: true }).fill('食堂');
  await expect(page.getByRole('dialog', { name: '选择分类', exact: true }).getByRole('option', { name: /食堂/ })).toHaveCount(0);
});
