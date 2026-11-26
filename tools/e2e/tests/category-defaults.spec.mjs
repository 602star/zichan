import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';
import { openLedgerSection, selectValue } from '../ledger-navigation.mjs';

test.use({ timezoneId: 'Asia/Shanghai' });
test.setTimeout(90_000);

for (const [width, scheme] of [[1280, 'light'], [390, 'dark']]) {
  test(`noon defaults, manual selection, draft and local preferences at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.clock.setFixedTime(new Date('2026-11-24T12:00:00+08:00'));
    await openLedger(page);
    await openLedgerSection(page, 'transactions', 'records');
    const entry = page.locator('#transaction-records').getByRole('button', { name: /^\+ 记(账|支出)$/ });
    await entry.click();
    const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
    const category = form.getByRole('button', { name: /^分类\*?$/ });
    await expect(category).toContainText('外卖');
    await expect(form.getByText('按午间时段预选', { exact: true })).toBeVisible();
    await expect(form.getByLabel('描述', { exact: true })).toHaveValue('');
    await category.click();
    const picker = page.getByRole('dialog', { name: '选择分类', exact: true });
    await picker.getByRole('textbox').fill('公交');
    await picker.getByRole('option').filter({ hasText: '公交' }).first().click();
    await expect(category).toContainText('公交');
    await form.getByLabel('交易时间', { exact: true }).fill('18:00');
    await expect(category).toContainText('公交');
    await form.getByLabel(/^金额/).fill('12.50');
    await form.getByLabel('描述', { exact: true }).fill('分类草稿验收');
    await page.screenshot({ path: test.info().outputPath(`category-default-${width}.png`) });
    await form.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '保留草稿并关闭', exact: true }).click();
    await entry.click();
    await form.locator('.zc-entry-draft-list > summary').click();
  await form.getByRole('button', { name: '恢复这份草稿', exact: true }).first().click();
    await expect(category).toContainText('公交');
    await form.getByLabel('交易时间', { exact: true }).fill('12:00');
    await expect(category).toContainText('公交');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(form).toBeHidden();
    await openLedgerSection(page, 'settings', 'ledger');
    const settings = page.getByRole('region', { name: '智能预选分类', exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole('checkbox', { name: '按时段和习惯预选分类', exact: true }).uncheck();
    await settings.getByRole('button', { name: '保存本机预选设置', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('已保存在本机');
    await page.screenshot({ path: test.info().outputPath(`category-settings-${width}.png`) });
    await page.reload();
    await openLedgerSection(page, 'settings', 'ledger');
    await expect(settings.getByRole('checkbox', { name: '按时段和习惯预选分类', exact: true })).not.toBeChecked();
    await openLedgerSection(page, 'transactions', 'records');
    await entry.click();
    await expect(category).not.toContainText('外卖');
    await expect(category).toContainText('待分类');
  });
}

test('normal saved transactions teach noon habits and an explicit time rule takes precedence', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.clock.setFixedTime(new Date('2026-11-24T12:00:00+08:00'));
  await openLedger(page);
  await openLedgerSection(page, 'transactions', 'records');
  const entry = page.locator('#transaction-records').getByRole('button', { name: /^\+ 记(账|支出)$/ });
  const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  const category = form.getByRole('button', { name: /^分类\*?$/ });
  for (let index = 0; index < 5; index++) {
    await entry.click();
    await category.click();
    const picker = page.getByRole('dialog', { name: '选择分类', exact: true });
    await picker.getByRole('textbox').fill('堂食餐饮');
    await picker.getByRole('option').filter({ hasText: '堂食餐饮' }).click();
    await form.getByLabel(/^金额/).fill('20');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(form).toBeHidden();
  }
  await entry.click();
  await expect(category).toContainText('堂食餐饮');
  await expect(form.getByText('按你近 60 天同时段的 5 笔记录预选', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(form).toBeHidden();
  await openLedgerSection(page, 'settings', 'ledger');
  const settings = page.getByRole('region', { name: '智能预选分类', exact: true });
  await settings.getByRole('button', { name: '添加时段规则', exact: true }).click();
  await settings.getByRole('button', { name: '保存本机预选设置', exact: true }).click();
  await expect(settings.getByRole('status')).toHaveText('已保存在本机');
  expect(await settings.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('time-rule-settings.png') });
  await openLedgerSection(page, 'transactions', 'records');
  await entry.click();
  await expect(category).toContainText('外卖');
  await expect(form.getByText('按你的 11:00–14:00 时段规则预选', { exact: true })).toBeVisible();
  await selectValue(page, form.getByLabel('类型', { exact: true }), 'income', '收入');
  await expect(category).not.toContainText('外卖');
  await selectValue(page, form.getByLabel('类型', { exact: true }), 'refund', '退款');
  await expect(category).toContainText('待分类');
  const originalExpense = form.getByRole('combobox', { name: '退款关联原支出', exact: true });
  if (await originalExpense.evaluate((node) => node.tagName === 'SELECT')) await originalExpense.selectOption({ index: 1 });
  else { await originalExpense.click(); await page.getByRole('option').filter({ hasText: '20' }).first().click(); }
  await expect(category).toContainText('堂食餐饮');
});
