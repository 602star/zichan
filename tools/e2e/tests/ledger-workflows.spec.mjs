import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.mjs';
import { openLedger, openTransactions } from './helpers.mjs';

test.setTimeout(90_000);

test('records a detailed expense and keeps it visible after reload', async ({ page }) => {
  await openTransactions(page);
  await page.getByRole('button', { name: '+ 记支出' }).click();
  const expenseForm = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await expect(expenseForm).toBeVisible();
  await expect(expenseForm.getByLabel('类型')).toHaveCount(0);
  await expect(expenseForm.getByLabel('附件 / 图片')).toBeVisible();
  await expect(expenseForm.getByLabel('新商户名称')).toBeVisible();
  await expect(expenseForm.getByLabel('标签')).toBeVisible();
  await page.getByRole('textbox', { name: /^金额/ }).fill('68');
  await page.getByLabel('描述').fill('Playwright 午餐');
  await page.getByLabel('新商户名称').fill('Playwright 食堂');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('Playwright 午餐', { exact: true })).toBeVisible();
  await page.reload();
  await openLedger(page);
  await page.getByText('日常支出', { exact: true }).first().click();
  await expect(page.getByText('Playwright 午餐', { exact: true })).toBeVisible();
});

test('opens templates in the full expense form without saving immediately', async ({ page }) => {
  await openTransactions(page);
  await page.getByRole('button', { name: '午餐', exact: true }).click();
  const expenseForm = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await expect(expenseForm).toBeVisible();
  await expect(expenseForm.getByLabel('描述')).toHaveValue('午餐');
  await expect(expenseForm.getByRole('textbox', { name: /^金额/ })).toHaveValue('0');
  await expenseForm.getByRole('button', { name: '取消', exact: true }).click();
});

test('keeps the compact modal on the explicit quick-entry action', async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 8, 1, 12, 15));
  await openTransactions(page);
  await page.getByRole('button', { name: '快速记账', exact: true }).click();
  const quickExpense = page.getByRole('dialog', { name: '记一笔支出' });
  await expect(quickExpense).toBeVisible();
  await expect(quickExpense).toHaveCSS('background-color', 'rgb(255, 252, 246)');
  await expect(quickExpense.getByTestId('quick-expense-recommendation')).toContainText('已推荐：午餐');
  await expect(quickExpense.getByTestId('quick-expense-recommendation')).toContainText('当前时间 12:15');
  const quickCategory = quickExpense.getByLabel('分类', { exact: true });
  await expect(quickCategory).toContainText('食品餐饮');
  await expect(quickCategory).toContainText('堂食餐饮');
  await quickCategory.click();
  await expect(page.getByRole('dialog', { name: '选择分类', exact: true }).getByLabel('搜索分类', { exact: true })).toBeVisible();
  await expect(page.locator('.zc-category-picker-grid')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(quickExpense.getByLabel('支出备注')).toHaveValue('午餐');
  await expect(quickExpense.getByRole('textbox', { name: '支出金额' })).toHaveValue('');
  await page.getByRole('textbox', { name: '支出金额' }).fill('12.50');
  await page.getByLabel('支出备注').fill('明确使用快记');
  await page.getByRole('button', { name: '保存支出', exact: true }).click();
  await expect(page.getByText('明确使用快记', { exact: true })).toBeVisible();
});

test('auto-saves a form draft and restores it on the next open', async ({ page }) => {
  await openTransactions(page);
  await page.getByRole('button', { name: '+ 记支出' }).click();
  await page.getByRole('textbox', { name: /^金额/ }).fill('23.50');
  await page.getByLabel('描述').fill('未提交草稿');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿并关闭' }).click();
  await page.getByRole('button', { name: '+ 记支出' }).click();
  await expect(page.getByRole('status')).toContainText('已恢复');
  await expect(page.getByRole('textbox', { name: /^金额/ })).toHaveValue('23.50');
  await expect(page.getByLabel('描述')).toHaveValue('未提交草稿');
});

test('traps modal focus and preserves the parent lock across nested confirmation', async ({ page }) => {
  await openTransactions(page);
  const trigger = page.getByRole('button', { name: '+ 记支出' });
  await trigger.click();
  const form = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await expect(form).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

  await page.getByLabel('描述').fill('嵌套弹窗焦点验证');
  await page.keyboard.press('Escape');
  const confirmation = page.getByRole('dialog', { name: '关闭未保存表单' });
  await expect(confirmation).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await expect(page.getByRole('button', { name: '继续编辑' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: '保留草稿并关闭' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '继续编辑' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(confirmation).toBeHidden();
  await expect(form).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await expect(page.getByLabel('描述')).toBeFocused();

  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿并关闭' }).click();
  await expect(form).toBeHidden();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await expect(trigger).toBeFocused();
});

test('customizes sidebar modules and keeps their order after reload', async ({ page }) => {
  await openLedger(page);
  const sidebar = page.locator('.zc-sidebar');
  await sidebar.getByRole('button', { name: /设置$/ }).click();
  await expect(page.getByText('侧边栏与模块', { exact: true })).toBeVisible();
  // 记账模式 no longer drives module visibility, so the field says what it does.
  await expect(page.getByLabel('记账模式 · 录入深度')).toBeVisible();
  await expect(page.getByText('不决定显示哪些模块', { exact: false })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: /管理$/ })).toHaveCount(0);

  await page.getByLabel('在侧边栏显示管理').click();
  await expect(page.getByLabel('在侧边栏显示管理')).toBeChecked();
  await expect(sidebar.getByRole('button', { name: /管理$/ })).toBeVisible();
  await page.getByRole('button', { name: '上移管理', exact: true }).click();
  await page.getByRole('button', { name: '上移管理', exact: true }).click();
  await page.getByRole('button', { name: '上移管理', exact: true }).click();

  const sidebarLabels = async () => page.locator('.zc-sidebar nav > div > button:first-child .zc-sidebar-nav-label').allTextContents();
  await expect.poll(sidebarLabels).toEqual(['总览', '日常支出', '管理', '物品资产', '设置']);

  await page.reload();
  await openLedger(page);
  await expect.poll(sidebarLabels).toEqual(['总览', '日常支出', '管理', '物品资产', '设置']);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileNavigation = page.getByRole('navigation', { name: '移动端主导航' });
  await expect(mobileNavigation.getByRole('button', { name: /管理$/ })).toBeVisible();
  await mobileNavigation.getByRole('button', { name: /更多$/ }).click();
  const moreDrawer = page.getByRole('dialog', { name: '更多功能' });
  await expect(moreDrawer.getByRole('button', { name: /设置$/ })).toBeVisible();
  await moreDrawer.getByRole('button', { name: /设置$/ }).click();
  await page.getByLabel('在侧边栏显示管理').click();
  await expect(page.getByLabel('在侧边栏显示管理')).not.toBeChecked();
  await expect(mobileNavigation.getByRole('button', { name: /管理$/ })).toHaveCount(0);
});

test('enables and disables an extension pack for new entries and restores it when re-enabled', async ({ page }) => {
  await openLedger(page);
  const sidebar = page.locator('.zc-sidebar');
  await sidebar.getByRole('button', { name: /设置$/ }).click();
  await page.getByLabel('在侧边栏显示管理').click();
  await expect(page.getByLabel('在侧边栏显示管理')).toBeChecked();
  await sidebar.getByRole('button', { name: /管理$/ }).click();
  await expect(page.getByText('资产与资料中心', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '快捷显示与排序', exact: true }).click();

  const studentPack = page.getByTestId('category-pack-student');
  // Extension packs only ship optional categories, so a fresh ledger starts at zero
  // instead of listing the default categories the pack used to carry.
  await expect(studentPack.getByText('未启用 · 可选 7 项', { exact: true })).toBeVisible();
  await studentPack.getByRole('button', { name: '查看学生扩展包成员', exact: true }).click();
  const members = studentPack.getByTestId('category-pack-members-student');
  await expect(members.getByText(/食堂/)).toBeVisible();
  await expect(members.getByText('未加入').first()).toBeVisible();
  await studentPack.getByRole('button', { name: '查看学生扩展包成员', exact: true }).click();
  await expect(members).toHaveCount(0);

  await studentPack.getByRole('button', { name: '启用学生扩展包', exact: true }).click();
  await expect(studentPack.getByText('7 项全部可用', { exact: true })).toBeVisible();
  await expect(page.getByText(/已启用「学生」扩展包 7 项分类/)).toBeVisible();

  await studentPack.getByRole('button', { name: '停用学生扩展包', exact: true }).click();
  await expect(studentPack.getByText('未启用 · 可选 7 项', { exact: true })).toBeVisible();
  await expect(page.getByText(/已停用「学生」扩展包 7 项分类；新增记账将不再显示/)).toBeVisible();

  // The pack toggle is undoable from the toast without leaving the page.
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(studentPack.getByText('7 项全部可用', { exact: true })).toBeVisible();
  await studentPack.getByRole('button', { name: '停用学生扩展包', exact: true }).click();
  await expect(studentPack.getByText('未启用 · 可选 7 项', { exact: true })).toBeVisible();

  await page.getByText('日常支出', { exact: true }).first().click();
  await page.getByRole('button', { name: '+ 记支出' }).click();
  const expenseForm = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await expenseForm.getByLabel('二级分类').click();
  await page.getByRole('dialog', { name: '选择分类', exact: true }).getByLabel('搜索分类', { exact: true }).fill('食堂');
  await expect(page.getByRole('dialog', { name: '选择分类', exact: true }).getByRole('option', { name: /食堂/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expenseForm.getByRole('button', { name: '关闭', exact: true }).click();

  await sidebar.getByRole('button', { name: /管理$/ }).click();
  await page.getByRole('button', { name: '快捷显示与排序', exact: true }).click();
  const disabledStudentPack = page.getByTestId('category-pack-student');
  await disabledStudentPack.getByRole('button', { name: '启用学生扩展包', exact: true }).click();
  await expect(disabledStudentPack.getByText('7 项全部可用', { exact: true })).toBeVisible();

  await page.getByText('日常支出', { exact: true }).first().click();
  await page.getByRole('button', { name: '+ 记支出' }).click();
  const restoredForm = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await restoredForm.getByLabel('二级分类').click();
  await page.getByRole('dialog', { name: '选择分类', exact: true }).getByLabel('搜索分类', { exact: true }).fill('食堂');
  await expect(page.getByRole('dialog', { name: '选择分类', exact: true }).getByRole('option', { name: /食堂/ })).toBeVisible();
});

test('adds a catalog sub-category from the structure list without enabling a whole pack', async ({ page }) => {
  await openLedger(page);
  const sidebar = page.locator('.zc-sidebar');
  await sidebar.getByRole('button', { name: /设置$/ }).click();
  await page.getByLabel('在侧边栏显示管理').click();
  await expect(page.getByLabel('在侧边栏显示管理')).toBeChecked();
  await sidebar.getByRole('button', { name: /管理$/ }).click();
  await expect(page.getByText('资产与资料中心', { exact: true })).toBeVisible();

  // 结构管理默认打开。目录里存在、但账本里还没有的细分分类应当可浏览：
  // 搜索 KTV 会把它所在的「休闲娱乐」连这一项一起展开。
  await page.getByLabel('搜索收支分类').fill('KTV');
  const addKtv = page.getByRole('button', { name: '添加细分分类 KTV', exact: true });
  await expect(addKtv).toBeVisible();
  await addKtv.click();
  await expect(page.getByText(/已添加分类“KTV”（1 项）/)).toBeVisible();

  // 加入后就不再作为“可添加”重复提供。
  await page.getByLabel('搜索收支分类').fill('');
  await expect(page.getByRole('button', { name: '添加细分分类 KTV', exact: true })).toHaveCount(0);

  // 并且出现在新增记账的二级分类里。
  await page.getByText('日常支出', { exact: true }).first().click();
  await page.getByRole('button', { name: '+ 记支出' }).click();
  const expenseForm = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await expenseForm.getByLabel('二级分类').click();
  await page.getByRole('dialog', { name: '选择分类', exact: true }).getByLabel('搜索分类', { exact: true }).fill('KTV');
  await expect(page.getByRole('dialog', { name: '选择分类', exact: true }).getByRole('option', { name: /KTV/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expenseForm.getByRole('button', { name: '关闭', exact: true }).click();

  // 撤销后回到未添加状态：单项添加不会留下“幽灵分类”。
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await sidebar.getByRole('button', { name: /管理$/ }).click();
  await page.getByLabel('搜索收支分类').fill('KTV');
  await expect(page.getByRole('button', { name: '添加细分分类 KTV', exact: true })).toBeVisible();
});

test('exports a real PDF report with a valid PDF header', async ({ page }) => {
  await openLedger(page);
  // Reports is not part of the recommended starting layout, so enable it first.
  await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
  await page.getByLabel('在侧边栏显示支出报表').click();
  await expect(page.getByLabel('在侧边栏显示支出报表')).toBeChecked();
  // Scope to the sidebar: the settings rows own 上移/下移支出报表 buttons too.
  await page.locator('.zc-sidebar').getByRole('button', { name: /支出报表$/ }).click();
  const downloadPromise = page.waitForEvent('download');
  // Exports now sit behind a single menu rather than a row of buttons.
  await page.getByRole('button', { name: '导出报表' }).click();
  await page.getByRole('button', { name: '导出 PDF' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
});
