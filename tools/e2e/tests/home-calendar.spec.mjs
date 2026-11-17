import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.use({ viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Shanghai' });
test.setTimeout(90_000);
test.beforeEach(async ({ page }) => page.setDefaultTimeout(15_000));
async function home(page) {
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'dashboard' } })));
  await expect(page.locator('.zc-home-calendar')).toBeVisible();
  await page.locator('.zc-home-calendar').getByRole('button', { name: '放大日历', exact: true }).click();
  return page.locator('.zc-home-calendar');
}
async function editor(page) { return page.getByRole('dialog', { name: '新增日历事项', exact: true }); }
async function save(page, form) { await form.getByRole('button', { name: '保存事项', exact: true }).click(); await expect(form).toBeHidden(); }

test('home calendar persists lunar birthdays, recurrence exceptions, completion and display preferences', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-16T12:00:00+08:00'));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openLedger(page);
  let calendar = await home(page);
  await calendar.getByRole('button', { name: '记生日', exact: true }).click();
  let form = await editor(page);
  await form.getByLabel('标题', { exact: true }).fill('家人的农历生日');
  await form.getByRole('combobox', { name: '历法', exact: true }).selectOption('lunar');
  await form.getByRole('combobox', { name: '农历月', exact: true }).selectOption('1');
  await form.getByRole('combobox', { name: '农历日', exact: true }).selectOption('1');
  await form.getByLabel('出生年份（可不填）', { exact: true }).fill('1990');
  await save(page, form);
  await expect(calendar.locator('.zc-home-calendar-period')).toContainText('2026 年 2 月');
  await expect(calendar.locator('.zc-home-calendar-selected')).toContainText('家人的农历生日');
  await calendar.getByRole('button', { name: '年', exact: true }).click();
  await calendar.getByRole('button', { name: '日历下一期间' }).click();
  await calendar.getByRole('button', { name: /^2027-02-06，/ }).click();
  await expect(calendar.locator('.zc-home-calendar-selected')).toContainText('家人的农历生日');
  await calendar.locator('.zc-home-calendar-selected .zc-home-calendar-item').filter({ hasText: '家人的农历生日' }).click();
  let detail = page.getByRole('dialog', { name: '家人的农历生日', exact: true });
  await expect(detail).toContainText('37 岁');
  await detail.getByRole('button', { name: '完成本次', exact: true }).click();
  await expect(detail).toBeHidden();
  await expect(calendar.locator('.zc-home-calendar-selected .zc-home-calendar-item.is-completed')).toContainText('家人的农历生日');
  await calendar.locator('.zc-home-calendar-selected .zc-home-calendar-item').filter({ hasText: '家人的农历生日' }).click();
  detail = page.getByRole('dialog', { name: '家人的农历生日', exact: true });
  await detail.getByRole('button', { name: '仅编辑本次', exact: true }).click();
  form = await editor(page);
  await form.getByLabel('标题', { exact: true }).fill('这次生日改为家人聚餐');
  await save(page, form);
  await expect(calendar.locator('.zc-home-calendar-selected')).toContainText('这次生日改为家人聚餐');
  await expect(calendar.locator('.zc-home-calendar-selected')).not.toContainText('家人的农历生日');
  await calendar.getByText('日历显示与导入导出', { exact: true }).click();
  await calendar.getByRole('checkbox', { name: '农历', exact: true }).uncheck();
  await expect(calendar.getByRole('checkbox', { name: '农历', exact: true })).not.toBeChecked();
  await calendar.getByRole('checkbox', { name: '节日与节气', exact: true }).uncheck();
  await expect(calendar.locator('.zc-home-calendar-subdate')).toHaveCount(0);
  await expect(calendar.getByRole('status').filter({ hasText: '日历显示设置已保存到本机' })).toBeVisible();
  await page.reload(); calendar = await home(page);
  await calendar.getByText('日历显示与导入导出', { exact: true }).click();
  await expect(calendar.getByRole('checkbox', { name: '农历', exact: true })).not.toBeChecked();
  await expect(calendar.getByRole('checkbox', { name: '节日与节气', exact: true })).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('home calendar works offline, renders all views and imports daily events without duplicating UIDs', async ({ page, context }) => {
  await page.clock.setFixedTime(new Date('2026-11-16T12:00:00+08:00'));
  await openLedger(page); const calendar = await home(page);
  await calendar.getByRole('button', { name: '新增事项', exact: true }).click();
  let form = await editor(page); await form.getByLabel('标题', { exact: true }).fill('整理账单和日常安排');
  await form.getByRole('combobox', { name: '重复', exact: true }).selectOption('daily');
  await form.getByLabel('重复次数（留空不限）', { exact: true }).fill('5');
  await save(page, form);
  await context.setOffline(true);
  await calendar.getByRole('button', { name: '写随记', exact: true }).click();
  form = await editor(page); await form.getByLabel('标题', { exact: true }).fill('离线随记');
  await form.getByLabel('随记正文', { exact: true }).fill('今天整理了订阅和还款计划。');
  await save(page, form);
  await expect(calendar.locator('.zc-home-calendar-selected')).toContainText('离线随记');
  for (const view of ['周', '日', '年', '议程', '月']) {
    await calendar.getByRole('button', { name: view, exact: true }).click();
    await expect(calendar.getByRole('button', { name: view, exact: true })).toHaveAttribute('aria-pressed', 'true');
    if (view !== '月') { await calendar.evaluate(node => window.scrollTo({ top: window.scrollY + node.getBoundingClientRect().top - 120 })); await page.screenshot({ path: test.info().outputPath(`calendar-view-${view}.png`) }); }
  }
  await context.setOffline(false);
  await calendar.getByText('日历显示与导入导出', { exact: true }).click();
  await calendar.locator('.zc-home-calendar-selected').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('calendar-selected-day.png') });
  const buffer = Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:calendar-e2e-import\r\nSUMMARY:导入的安排\r\nDTSTART;VALUE=DATE:20261116\r\nDTEND;VALUE=DATE:20261117\r\nEND:VEVENT\r\nEND:VCALENDAR');
  for (let i = 0; i < 2; i++) {
    await calendar.getByLabel('导入日历文件').setInputFiles({ name: 'calendar.ics', mimeType: 'text/calendar', buffer });
    await expect(calendar.getByRole('status').filter({ hasText: '已导入 1 条' })).toBeVisible();
  }
  await expect(calendar.locator('.zc-home-calendar-selected .zc-home-calendar-item').filter({ hasText: '导入的安排' })).toHaveCount(1);
  await calendar.getByText('日历显示与导入导出', { exact: true }).click();
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await calendar.evaluate(node => window.scrollTo({ top: window.scrollY + node.getBoundingClientRect().top - 120 }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`home-calendar-${width}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: test.info().outputPath('home-calendar-320-dark.png') });
  await calendar.getByRole('button', { name: '新增事项', exact: true }).click();
  form = await editor(page);
  await expect(form).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('calendar-editor-320.png') });
  await form.getByRole('button', { name: '取消', exact: true }).click();
});

test('Sunday-first weeks include selected Sundays and agenda filters reset pagination', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-16T12:00:00+08:00'));
  await openLedger(page); const calendar = await home(page);
  await calendar.getByText('日历显示与导入导出', { exact: true }).click();
  const file = Buffer.from('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:agenda-regression\nSUMMARY:每日安排\nDTSTART;VALUE=DATE:20261116\nDTEND;VALUE=DATE:20261117\nRRULE:FREQ=DAILY;COUNT=40\nEND:VEVENT\nEND:VCALENDAR');
  await calendar.getByLabel('导入日历文件').setInputFiles({ name: 'agenda.ics', mimeType: 'text/calendar', buffer: file });
  await expect(calendar.getByRole('status').filter({ hasText: '已导入 1 条' })).toBeVisible();
  await calendar.getByRole('combobox', { name: '每周开始', exact: true }).selectOption('0');
  await expect(calendar.getByRole('status').filter({ hasText: '日历显示设置已保存到本机' })).toBeVisible();
  await calendar.getByRole('button', { name: '日历定位日期', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '日历定位日期', exact: true });
  await expect(picker.locator('.weekday').first()).toHaveText('日');
  await picker.getByRole('button', { name: '2026-11-22', exact: true }).click();
  await calendar.getByRole('button', { name: '周', exact: true }).click();
  await expect(calendar.locator('.zc-home-calendar-period')).toContainText('2026-11-22 — 2026-11-28');
  await expect(calendar.locator('.zc-home-calendar-selected')).toContainText('每日安排');
  await calendar.getByRole('button', { name: '议程', exact: true }).click();
  const agenda = calendar.locator('.zc-home-calendar-agenda');
  await agenda.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(agenda).toContainText('第 2 页');
  await calendar.getByRole('checkbox', { name: '个人事项', exact: true }).uncheck();
  await expect(agenda).toContainText('第 1 页');
  await calendar.getByRole('checkbox', { name: '个人事项', exact: true }).check();
  await expect(agenda.locator('.zc-home-calendar-agenda-row')).toHaveCount(20);
  await agenda.getByRole('button', { name: '下一页', exact: true }).click();
  await calendar.getByRole('checkbox', { name: '显示已完成', exact: true }).uncheck();
  await expect(agenda).toContainText('第 1 页');
  await calendar.getByRole('button', { name: '日历定位日期', exact: true }).click();
  await picker.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(picker.getByRole('button', { name: '2026-10-01', exact: true })).toHaveAccessibleDescription(/国庆节.*放假/);
  await page.screenshot({ path: test.info().outputPath('calendar-picker-lunar-holiday.png') });
});

test('home starts compact, expands in place and preserves the selected date and filters', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-16T12:00:00+08:00'));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openLedger(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'dashboard' } })));
  const calendar = page.getByRole('region', { name: '日历', exact: true });
  await expect(calendar).toHaveClass(/is-condensed/);
  await expect(calendar.getByRole('textbox', { name: '搜索日历事项' })).toBeHidden();
  const compact = await calendar.boundingBox();
  expect(compact.height).toBeLessThan(560);
  const positions = await calendar.evaluate(node => ({ board: node.querySelector('.zc-home-calendar-board').getBoundingClientRect().right, selected: node.querySelector('.zc-home-calendar-selected').getBoundingClientRect().left }));
  expect(positions.selected).toBeGreaterThan(positions.board);
  await calendar.getByText('日历显示与导入导出', { exact: true }).click();
  const events = Array.from({ length: 6 }, (_, i) => `BEGIN:VEVENT\nUID:compact-${i}\nSUMMARY:紧凑布局测试安排${i + 1}${i === 0 ? '，包含较长的日常安排说明以检查换行和内容边界' : ''}\nDTSTART;VALUE=DATE:20261117\nDTEND;VALUE=DATE:20261118\nEND:VEVENT`).join('\n');
  await calendar.getByLabel('导入日历文件').setInputFiles({ name: 'compact.ics', mimeType: 'text/calendar', buffer: Buffer.from(`BEGIN:VCALENDAR\n${events}\nEND:VCALENDAR`) });
  await expect(calendar.getByRole('status').filter({ hasText: '已导入 6 条' })).toBeVisible();
  await calendar.getByText('日历显示与导入导出', { exact: true }).click();
  await calendar.getByRole('button', { name: /^2026-11-17，/ }).click();
  await expect(calendar.locator('.zc-home-calendar-selected .zc-home-calendar-item')).toHaveCount(3);
  await calendar.getByRole('button', { name: '筛选事项', exact: true }).click();
  await calendar.getByRole('textbox', { name: '搜索日历事项' }).fill('紧凑布局');
  await calendar.getByRole('button', { name: '查看全部 6 项安排', exact: true }).click();
  await expect(calendar).toHaveClass(/is-expanded/);
  await expect(calendar.locator('.zc-home-calendar-selected .zc-home-calendar-item')).toHaveCount(6);
  expect((await calendar.boundingBox()).height).toBeGreaterThan(compact.height + 250);
  await calendar.evaluate(node => window.scrollTo({ top: window.scrollY + node.getBoundingClientRect().top - 120 }));
  await page.screenshot({ path: test.info().outputPath('home-expanded-1280.png') });
  await calendar.getByRole('button', { name: '收起日历', exact: true }).click();
  await expect(calendar.locator('.zc-home-calendar-selected h3').first()).toHaveText('2026-11-17');
  await expect(calendar.getByRole('textbox', { name: '搜索日历事项' })).toHaveValue('紧凑布局');
  await page.screenshot({ path: test.info().outputPath('home-compact-selected-1280.png') });
  await calendar.getByRole('textbox', { name: '搜索日历事项' }).fill('');
  await calendar.getByRole('button', { name: '收起筛选', exact: true }).click();
  await calendar.getByRole('button', { name: '议程', exact: true }).click();
  await expect(calendar.locator('.zc-home-calendar-agenda-row')).toHaveCount(5);
  await calendar.getByRole('button', { name: '展开全部 6 项议程', exact: true }).click();
  await expect(calendar.locator('.zc-home-calendar-agenda-row')).toHaveCount(6);
  await calendar.getByRole('button', { name: '年', exact: true }).click();
  const largeYearHeight = (await calendar.locator('.zc-home-calendar-year').boundingBox()).height;
  await calendar.getByRole('button', { name: '收起日历', exact: true }).click();
  await expect(calendar.getByRole('button', { name: '年', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await calendar.locator('.zc-home-calendar-year').boundingBox()).height).toBeLessThan(largeYearHeight * .8);
  await page.screenshot({ path: test.info().outputPath('home-compact-year-1280.png') });
  await calendar.getByRole('button', { name: '月', exact: true }).click();
  await page.reload();
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'dashboard' } })));
  await expect(calendar).toHaveClass(/is-condensed/);
  for (const width of [1440, 1280, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const day = calendar.getByRole('button', { name: '2026-11-16', exact: true });
    const bounds = await day.boundingBox(); expect(bounds.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: test.info().outputPath(`home-compact-${width}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByRole('button', { name: '开始日期', exact: true })).toBeHidden();
  await page.getByRole('combobox', { name: '快捷时间范围', exact: true }).selectOption('custom');
  await expect(page.getByRole('button', { name: '开始日期', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '结束日期', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '快捷时间范围', exact: true }).selectOption('this_month');
  await calendar.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('home-compact-320-dark.png') });
  await calendar.getByRole('button', { name: /^2026-11-17，/ }).click();
  await calendar.locator('.zc-home-calendar-selected').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('home-compact-selected-320-dark.png') });
  await calendar.getByRole('button', { name: '放大日历', exact: true }).click();
  await expect(calendar).toHaveClass(/is-expanded/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('home-expanded-320-dark.png') });
  expect(errors).toEqual([]);
});
