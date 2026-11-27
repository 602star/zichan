import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' });
test.beforeEach(async ({ page }) => page.setDefaultTimeout(12_000));
const nav = (page, id) => page.locator(`.zc-sidebar [data-destination="${id}"] .zc-sidebar-nav-item`);
const go = (page, screen, tab) => page.evaluate((detail) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail })), { screen, tab });
const detail = (page) => page.locator('.zc-account-workspace-detail');

async function choose(page, scope, label, choice) {
  const control = scope.getByRole('combobox', { name: label, exact: true });
  await expect(control).toHaveJSProperty('tagName', page.viewportSize().width < 768 ? 'BUTTON' : 'SELECT');
  if (await control.evaluate((node) => node.tagName) === 'SELECT') await control.selectOption({ label: choice });
  else {
    await control.click();
    await page.getByRole('dialog').last().getByRole('option', { name: choice, exact: true }).click();
  }
}

async function addAccount(page, name, amount, kind = 'bank') {
  await page.getByRole('button', { name: '添加银行卡 / 钱包', exact: true }).click();
  const form = page.getByRole('dialog', { name: '添加银行卡或钱包', exact: true });
  await expect(form).toHaveAttribute('aria-modal', 'false');
  await form.getByRole('combobox', { name: '账户类型', exact: true }).selectOption(kind);
  await form.getByLabel('账户名称', { exact: true }).fill(name);
  await form.getByLabel('当前余额', { exact: true }).fill(amount);
  await form.getByLabel('余额截至', { exact: true }).fill('2026-11-15T08:00');
  await form.getByRole('button', { name: '保存并开始使用', exact: true }).click();
  await expect(form).toBeHidden();
}

async function addEntry(page, description, amount, type, expectedAccount) {
  await nav(page, 'records').click();
  await page.locator('#transaction-records').getByRole('button', { name: '+ 记账', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  await form.getByLabel(/^类型/).selectOption(type);
  if (expectedAccount) await expect(form.getByRole('combobox', { name: '收付款账户', exact: true }).locator('option:checked')).toHaveText(expectedAccount);
  await form.getByLabel(/^金额/).fill(amount);
  await form.getByLabel('描述', { exact: true }).fill(description);
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
}

test('account workspace applies separate defaults, preserves old records and works on phones and papers', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-11-15T11:00:00Z'));
  await openLedger(page);
  await addEntry(page, '未细分来源的旧记录', '50', 'expense');
  await nav(page, 'accounts').click();
  await expect(page.getByRole('region', { name: '资金账户', exact: true }).getByRole('row').filter({ hasText: '默认支出账户' })).toContainText('其他');
  await addAccount(page, '日常零钱', '1000', 'wallet');
  await addAccount(page, '工资银行卡', '2000');
  await addAccount(page, '备用银行卡', '0');
  await page.getByRole('button', { name: '收起添加提示', exact: true }).click();
  const list = page.getByRole('region', { name: '资金账户', exact: true });
  await expect(list.getByRole('row').filter({ hasText: '备用银行卡' })).toContainText('0.00 CNY');
  const defaults = page.getByRole('region', { name: '默认收支账户', exact: true });
  await choose(page, defaults, '默认支出账户', '日常零钱');
  await choose(page, defaults, '默认收入账户', '工资银行卡');
  await defaults.getByRole('button', { name: '保存默认设置', exact: true }).click();
  await expect(defaults.getByRole('status')).toHaveText('默认收支账户已保存');
  await expect(list.getByRole('row').filter({ hasText: '日常零钱' })).toContainText('默认支出');
  await expect(list.getByRole('row').filter({ hasText: '工资银行卡' })).toContainText('默认收入');
  await addEntry(page, '默认钱包消费', '123.45', 'expense', '日常零钱');
  await addEntry(page, '默认银行卡工资', '500', 'income', '工资银行卡');
  await nav(page, 'accounts').click();
  await list.getByRole('button', { name: '日常零钱', exact: true }).click();
  await expect(detail(page)).toContainText('876.55 CNY');
  await expect(detail(page)).toContainText('默认钱包消费');
  await expect(detail(page)).not.toContainText('未细分来源的旧记录');
  await list.getByRole('button', { name: '工资银行卡', exact: true }).click();
  await expect(detail(page)).toContainText('2,500.00 CNY');
  await expect(detail(page)).toContainText('默认银行卡工资');
  await expect(detail(page)).not.toContainText('默认钱包消费');
  await list.getByRole('button', { name: '默认支出账户', exact: true }).click();
  await expect(detail(page)).toContainText('−50 CNY');
  await detail(page).getByRole('button', { name: '在流水页筛选查看', exact: true }).click();
  await expect(page.locator('.zc-transaction-row')).toHaveCount(1);
  await expect(page.locator('.zc-transaction-row')).toContainText('未细分来源的旧记录');
  await nav(page, 'accounts').click();
  await list.getByRole('button', { name: '日常零钱', exact: true }).click();
  await detail(page).getByRole('button', { name: '编辑账户', exact: true }).click();
  let edit = page.getByRole('dialog', { name: '编辑账户', exact: true });
  await edit.getByLabel('账户名称', { exact: true }).fill('未保存的账户名');
  await nav(page, 'records').click();
  const guard = page.getByRole('dialog', { name: '关闭未保存账户', exact: true });
  await guard.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(edit.getByLabel('账户名称', { exact: true })).toHaveValue('未保存的账户名');
  await edit.getByRole('button', { name: '取消', exact: true }).click();
  await guard.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(detail(page).getByRole('heading', { name: '日常零钱', exact: true })).toBeVisible();
  await detail(page).getByRole('button', { name: '编辑账户', exact: true }).click();
  edit = page.getByRole('dialog', { name: '编辑账户', exact: true });
  await edit.locator('summary').filter({ hasText: '更多信息' }).click();
  await edit.getByLabel('平台', { exact: true }).fill('微信');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(detail(page)).toContainText('876.55 CNY');
  await detail(page).getByRole('tab', { name: '账户资料', exact: true }).click();
  await expect(detail(page)).toContainText('1,000.00 CNY');
  await expect(detail(page)).toContainText('微信');
  await expect(detail(page).getByRole('button', { name: '从更早日期核算', exact: true })).toBeVisible();
  await detail(page).getByRole('tab', { name: '对账记录', exact: true }).click();
  await expect(detail(page)).toContainText('这个账户在所选期间没有对账记录');
  await detail(page).getByRole('button', { name: '核对账单', exact: true }).click();
  const reconcile = page.getByRole('dialog', { name: '核对账单', exact: true });
  await expect(reconcile.getByRole('combobox', { name: '账户', exact: true }).locator('option:checked')).toHaveText('日常零钱');
  await reconcile.getByLabel('账单期末余额', { exact: true }).fill('876.55');
  await reconcile.getByRole('button', { name: '勾选当前列表', exact: true }).click();
  await expect(reconcile.getByRole('button', { name: '完成对账', exact: true })).toBeEnabled();
  await reconcile.getByRole('button', { name: '完成对账', exact: true }).click();
  await expect(reconcile).toBeHidden();
  await expect(detail(page).getByRole('button', { name: '查看对账', exact: true })).toHaveCount(1);
  await expect(detail(page)).toContainText('876.55 CNY');
  await list.getByRole('button', { name: '工资银行卡', exact: true }).click();
  await detail(page).getByRole('tab', { name: '对账记录', exact: true }).click();
  await expect(detail(page).getByRole('button', { name: '查看对账', exact: true })).toHaveCount(0);
  await expect(detail(page)).toContainText('这个账户在所选期间没有对账记录');
  await list.getByRole('button', { name: '日常零钱', exact: true }).click();
  await detail(page).getByRole('tab', { name: '账户流水', exact: true }).click();
  await expect(page.locator('.zc-undo-toast')).toHaveCount(0, { timeout: 15_000 });
  await detail(page).screenshot({ path: test.info().outputPath('accounts-desktop-workspace.png') });
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: test.info().outputPath('accounts-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await choose(page, defaults, '默认收入账户', '日常零钱');
  await defaults.getByRole('button', { name: '保存默认设置', exact: true }).click();
  await expect(defaults.getByRole('status')).toHaveText('默认收支账户已保存');
  await expect(list.getByRole('button', { name: /备用银行卡/ })).toBeVisible();
  await list.getByRole('button', { name: /工资银行卡/ }).click();
  await expect(detail(page)).toContainText('2,500.00 CNY');
  await expect(detail(page)).toContainText('默认银行卡工资');
  await page.screenshot({ path: test.info().outputPath('accounts-mobile-workspace.png') });
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: test.info().outputPath('accounts-mobile.png'), fullPage: true });
  await go(page, 'assets', 'accounts');
  await page.getByRole('button', { name: '账户管理与默认收支', exact: true }).click();
  await expect(page.getByRole('heading', { name: '默认收支账户', exact: true })).toBeVisible();

  for (const paper of ['文献纸 · 墨朱', '青灰纸 · 墨朱', '紫灰纸 · 墨朱']) for (const mode of ['浅色', '深色']) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, 'settings', 'appearance');
    await page.getByRole('tab', { name: '外观', exact: true }).click();
    await page.getByRole('radio', { name: paper, exact: true }).click();
    await page.getByRole('radio', { name: mode, exact: true }).click();
    await go(page, 'transactions', 'accounts');
    for (const width of [1280, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(detail(page)).toContainText('默认银行卡工资');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${paper}/${mode}/${width}`).toBe(true);
      await expect(page.locator('.zc-page-content .zc-card .zc-card')).toHaveCount(0);
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: test.info().outputPath(`${paper}-${mode}-${width}.png`), fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});

test('seeded accounts keep editing and transfers while only their reconciliation entry is removed', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-15T11:00:00Z'));
  await openLedger(page);
  await nav(page, 'accounts').click();
  const list = page.getByRole('region', { name: '资金账户', exact: true });
  await expect(list.getByRole('row')).toHaveCount(3);
  await expect(list.getByRole('row').filter({ hasText: '默认支出账户' })).toContainText('其他');
  await expect(list.getByRole('row').filter({ hasText: '默认收入账户' })).toContainText('其他');
  await expect(page.getByText('系统归集', { exact: false })).toHaveCount(0);
  const defaults = page.getByRole('region', { name: '默认收支账户', exact: true });
  await choose(page, defaults, '默认收入账户', '默认支出账户');
  await defaults.getByRole('button', { name: '保存默认设置', exact: true }).click();
  await expect(defaults.getByRole('status')).toHaveText('默认收支账户已保存');
  await addEntry(page, '普通默认账户消费', '20', 'expense', '默认支出账户');
  await addEntry(page, '普通默认账户收入', '100', 'income', '默认支出账户');
  await nav(page, 'records').click();
  await page.locator('#transaction-records').getByRole('button', { name: '+ 记账', exact: true }).click();
  const entry = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  await entry.getByLabel(/^类型/).selectOption('transfer');
  await choose(page, entry, '收付款账户', '默认支出账户');
  await choose(page, entry, '转入账户', '默认收入账户');
  await choose(page, entry, '转入币种', 'CNY');
  await entry.getByLabel(/^金额/).fill('5');
  await entry.getByLabel(/^转入金额/).fill('5');
  await entry.getByLabel('描述', { exact: true }).fill('普通账户间转账');
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry).toBeHidden();
  await nav(page, 'accounts').click();
  await list.getByRole('button', { name: '默认收入账户', exact: true }).click();
  await expect(detail(page)).toContainText('5.00 CNY');
  await list.getByRole('button', { name: '默认支出账户', exact: true }).click();
  await expect(detail(page)).toContainText('75.00 CNY');
  await expect(detail(page)).toContainText('普通账户间转账');
  await expect(detail(page).getByRole('button', { name: '核对账单', exact: true })).toHaveCount(0);
  await expect(detail(page).getByRole('tab', { name: '对账记录', exact: true })).toHaveCount(0);
  await detail(page).getByRole('button', { name: '编辑账户', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑账户', exact: true });
  await expect(edit.getByRole('combobox', { name: '账户类型', exact: true }).locator('option:checked')).toHaveText('其他');
  await edit.getByLabel('账户名称', { exact: true }).fill('日常综合账户');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(list.getByRole('row').filter({ hasText: '日常综合账户' })).toContainText('默认支出');
  await expect(list.getByRole('row').filter({ hasText: '日常综合账户' })).toContainText('默认收入');
  await expect(detail(page).getByRole('button', { name: '核对账单', exact: true })).toHaveCount(0);
  await expect(detail(page)).toContainText('75.00 CNY');
  await expect(page.locator('.zc-undo-toast')).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: test.info().outputPath('ordinary-default-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await list.getByRole('button', { name: '日常综合账户', exact: true }).click();
  await expect(detail(page)).toContainText('75.00 CNY');
  await expect.poll(async () => (await detail(page).boundingBox()).y).toBeGreaterThanOrEqual(64);
  await expect.poll(async () => (await detail(page).boundingBox()).y).toBeLessThan(180);
  await page.screenshot({ path: test.info().outputPath('ordinary-default-mobile.png') });
});
