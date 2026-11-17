import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Shanghai' });
test.describe.configure({ mode: 'parallel' });
test.setTimeout(240_000);
test.beforeEach(async ({ page }) => { page.setDefaultTimeout(12_000); });

async function go(page, screen, tab, id) {
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail })), { screen, tab, id });
  await expect(page.locator('h1')).toHaveText(({ dashboard: '总览', assets: '资产', transactions: '收支', fixed: '物品资产', convert: '资产转换', reports: '报表', game: '游戏赛季', manage: '资料管理', history: '操作历史', settings: '设置', account: '我的账号' })[screen]);
}

async function capture(page, name) {
  if (await page.locator('.zc-page-content').count()) await expect.poll(() => page.locator('.zc-page-content').innerText()).toMatch(/\S/);
  await expect(page.locator('.zc-page-content [role="status"]').filter({ hasText: /^正在(?:读取|载入|加载)/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name).toBe(true);
  await expect(page.locator('.zc-page-content .zc-card .zc-card')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

async function back(page) { await page.evaluate(() => history.back()); }

async function select(page, form, label, choice) {
  const control = form.getByRole('combobox', { name: label, exact: typeof label === 'string' });
  if (await control.evaluate((node) => node.tagName) === 'SELECT') await control.selectOption({ label: choice });
  else {
    await control.click();
    await page.getByRole('dialog').last().getByRole('option', { name: choice, exact: true }).click();
  }
}

test('mobile task directories, quick entry and browser back use real pages', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openLedger(page);
  const nav = page.getByRole('navigation', { name: '移动端主导航' });
  await expect(nav.getByRole('button')).toHaveCount(5);
  await nav.getByRole('button', { name: '更多', exact: true }).click();
  let more = page.getByRole('dialog', { name: '更多功能', exact: true });
  await expect(more.getByRole('button', { name: '预算', exact: true })).toBeVisible();
  await capture(page, 'more-task-directory');
  await more.getByRole('button', { name: '报表', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('报表');
  await nav.getByRole('button', { name: '快速记账', exact: true }).click();
  const entry = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  await expect(entry).toBeVisible();
  await expect(page.locator('h1')).toHaveText('报表');
  await entry.getByLabel(/^金额/).fill('12.34');
  await entry.getByLabel('描述', { exact: true }).fill('从报表记一笔');
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry).toBeHidden();
  await expect(page.locator('h1')).toHaveText('报表');
  await go(page, 'transactions');
  const row = page.locator('.zc-transaction-row').filter({ hasText: '从报表记一笔' });
  await expect(row).toContainText('12.34 CNY');
  await row.locator('.zc-transaction-summary-title').tap();
  await expect(page.getByRole('dialog', { name: '流水详情', exact: true })).toBeVisible();
  await back(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('h1')).toHaveText('收支');

  await nav.getByRole('button', { name: '更多', exact: true }).click();
  more = page.getByRole('dialog', { name: '更多功能', exact: true });
  await more.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await expect(page.getByRole('radio', { name: '紫灰纸 · 墨朱', exact: true })).toBeVisible();
  await back(page);
  await expect(page.getByRole('button', { name: '记账', exact: true })).toBeVisible();
  await back(page);
  await expect(page.locator('h1')).toHaveText('收支');

  await go(page, 'manage');
  for (const label of ['收支分类', '标签与交易对象', '记账模板', '资产', '账户', '价格标记', '物品分类', '定投计划', '游戏资料', '附件']) {
    await page.locator('.zc-page-content').getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('.zc-mobile-page-head h2')).toHaveText(label);
    await capture(page, `manage-${label}`);
    await page.getByRole('button', { name: '返回资料', exact: true }).click();
    await expect(page.getByRole('button', { name: '记账模板', exact: true })).toBeVisible();
  }
  await go(page, 'account');
  for (const label of ['个人资料', '邮箱', '账号安全', '存储配额']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('.zc-mobile-page-head h2')).toHaveText(label);
    await capture(page, `account-${label}`);
    await page.getByRole('button', { name: '返回账号', exact: true }).click();
    await expect(page.getByRole('button', { name: '个人资料', exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('item details, usage and game records keep their real editors', async ({ page }) => {
  await openLedger(page);
  await go(page, 'fixed');
  await page.getByRole('button', { name: '+ 新增物品', exact: true }).click();
  let form = page.getByRole('dialog', { name: '新增 · 物品资产', exact: true });
  await form.getByLabel(/^名称/).fill('随身相机');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: '随身相机', exact: true }).click();
  await expect(page.getByRole('tab', { name: '概况', exact: true })).toHaveAttribute('aria-selected', 'true');
  await capture(page, 'item-overview');
  await page.getByRole('tab', { name: '使用与成本', exact: true }).click();
  await page.getByRole('button', { name: '添加使用指标', exact: true }).click();
  form = page.getByRole('dialog').last();
  await form.getByLabel(/^指标名称/).fill('拍摄次数');
  await select(page, form, '单位', '次数');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  const metric = page.locator('.zc-fixed-location-row').filter({ hasText: '拍摄次数' });
  await expect(metric).toBeVisible();
  await metric.getByRole('button', { name: '记录使用', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 使用量记录', exact: true });
  await form.getByLabel(/^本次增加量/).fill('2');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.locator('.zc-fixed-record-row').filter({ hasText: '拍摄次数' })).toContainText('增加 2');
  await capture(page, 'item-usage');
  await page.getByRole('tab', { name: '记录与凭证', exact: true }).click();
  await capture(page, 'item-events');
  await page.getByRole('button', { name: '记录生命周期事件', exact: true }).click();
  await page.getByRole('dialog', { name: '记录物品事件', exact: true }).getByRole('button', { name: '保养', exact: false }).click();
  await expect(page.getByRole('dialog').last().getByRole('button', { name: '保存', exact: true })).toBeVisible();
  await page.getByRole('dialog').last().getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '返回物品', exact: true }).click();
  await expect(page.getByRole('button', { name: '随身相机', exact: true })).toBeVisible();

  await go(page, 'game');
  await page.getByLabel('游戏名称', { exact: true }).fill('移动端赛季');
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  await page.getByRole('button', { name: '+ 记录', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 游戏记录', exact: true });
  await form.getByLabel(/^新游戏币名称/).fill('金币');
  await form.getByLabel(/^游戏币数量/).fill('100');
  await form.getByLabel('历史价格', { exact: true }).click();
  const unknown = page.getByRole('dialog').last().getByRole('option').filter({ hasText: /未知|不确定/ }).first();
  await unknown.click();
  await form.getByLabel('备注', { exact: true }).fill('移动端游戏记录');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: /查看游戏记录/ }).first().click();
  await expect(page.getByRole('button', { name: '编辑游戏记录', exact: true })).toBeVisible();
  await capture(page, 'game-record-detail');
  await page.getByRole('button', { name: '编辑游戏记录', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '编辑 · 游戏记录', exact: true })).toBeVisible();
});

test('backup details rehearse a real archive and settings remain usable at 320px', async ({ page }) => {
  await openLedger(page);
  await go(page, 'settings');
  for (const label of ['记账', '外观', '服务器与同步', '恢复数据', '解锁与安全']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('.zc-mobile-page-head h2')).toHaveText(label);
    await capture(page, `settings-${label}`);
    await page.getByRole('button', { name: '返回设置', exact: true }).click();
  }
  await page.getByRole('button', { name: '本机备份', exact: true }).click();
  await page.getByRole('button', { name: '创建手动备份', exact: true }).click();
  const points = page.getByRole('region', { name: '本机恢复点', exact: true });
  await expect(points.getByRole('button').first()).toBeVisible();
  await points.getByRole('button').first().click();
  let sheet = page.getByRole('dialog', { name: '备份详情', exact: true });
  await expect(sheet.getByRole('button', { name: '恢复演练', exact: true })).toBeVisible();
  await capture(page, 'backup-details');
  await sheet.getByRole('button', { name: '恢复演练', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(points).toContainText('已通过恢复演练', { timeout: 30_000 });
  await points.getByRole('button').first().click();
  sheet = page.getByRole('dialog', { name: '备份详情', exact: true });
  await sheet.getByRole('button', { name: '选择此恢复点', exact: true }).click();
  const restore = page.getByRole('dialog', { name: '恢复数据', exact: true });
  await expect(restore.getByRole('button', { name: '检查并继续', exact: true })).toBeEnabled();
  await capture(page, 'restore-source');
  await restore.getByRole('button', { name: '取消', exact: true }).click();
  await go(page, 'settings', 'appearance');
  await page.getByRole('radio', { name: '紫灰纸 · 墨朱', exact: true }).click();
  await page.getByRole('radio', { name: '深色', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  for (const screen of ['dashboard', 'assets', 'reports', 'fixed', 'game', 'history', 'manage', 'account', 'settings']) {
    await go(page, screen);
    await capture(page, `dark-320-${screen}`);
  }
});

test('accounts, budgets, bills and conversion review connect to the ledger', async ({ page }) => {
  await openLedger(page);
  await go(page, 'manage', 'accounts');
  await page.getByRole('button', { name: '+ 新增账户', exact: true }).click();
  let form = page.getByRole('dialog', { name: '添加银行卡或钱包', exact: true });
  await form.getByLabel('账户名称', { exact: true }).fill('日常钱包');
  await form.getByLabel('当前余额', { exact: true }).fill('100');
  await select(page, form, '币种', 'CNY');
  await form.getByRole('button', { name: '保存并开始使用', exact: true }).click();
  await expect(form).toBeHidden();
  await go(page, 'assets');
  await page.getByRole('button', { name: '日常钱包', exact: true }).click();
  await expect(page.getByRole('region', { name: '账户详情', exact: true })).toContainText('100.00 CNY');
  await capture(page, 'asset-account-detail');
  await page.getByRole('button', { name: '查看账户流水', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('收支');
  await expect(page.getByRole('button', { name: '账户', exact: true })).toHaveClass(/zc-btn--primary/);
  await capture(page, 'asset-account-ledger');

  await go(page, 'transactions', 'budget');
  await page.getByRole('button', { name: '+ 预算', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 分类预算', exact: true });
  await form.getByLabel(/^预算金额/).fill('500');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await page.locator('.zc-budget-row').first().click();
  let sheet = page.getByRole('dialog', { name: '预算详情', exact: true });
  await expect(sheet).toContainText('500');
  await capture(page, 'budget-detail');
  await sheet.getByRole('button', { name: '编辑预算', exact: true }).click();
  form = page.getByRole('dialog', { name: '编辑 · 分类预算', exact: true });
  await form.getByLabel(/^预算金额/).fill('600');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.locator('.zc-budget-row').first()).toContainText('600');

  await go(page, 'transactions', 'bills');
  await page.getByRole('button', { name: '+ 新增账单', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 账单计划', exact: true });
  await form.getByLabel(/^名称/).fill('手机月费');
  await form.getByLabel(/^金额/).fill('20');
  await capture(page, 'bill-grouped-form');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: '手机月费', exact: true }).click();
  sheet = page.getByRole('dialog', { name: '账单详情', exact: true });
  await expect(sheet).toContainText('20');
  await capture(page, 'bill-detail');
  await sheet.getByRole('button', { name: '生成本期流水', exact: true }).click();
  await expect(sheet).toBeHidden();
  await go(page, 'transactions', 'records');
  await expect(page.locator('.zc-transaction-row').filter({ hasText: '手机月费' })).toBeVisible();

  await go(page, 'convert');
  await page.getByRole('button', { name: '+ 新增转换', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增资产转换', exact: true });
  await form.getByRole('button', { name: /USDT · 泰达币/ }).click();
  await form.getByLabel('标题', { exact: true }).fill('移动端转换核对');
  await form.getByLabel('来源数量', { exact: true }).fill('7');
  await form.getByLabel('目标数量', { exact: true }).fill('1');
  await form.getByRole('button', { name: '核对转换', exact: true }).click();
  const review = page.getByRole('dialog').last();
  await expect(review).toContainText(/账户实扣|各资产净变化/);
  await capture(page, 'conversion-review');
  await review.getByRole('button', { name: /确认保存转换|确认保存/ }).click();
  await expect(form).toBeHidden();
  await go(page, 'assets');
  await page.getByRole('tab', { name: '持仓', exact: true }).click();
  await page.getByRole('button', { name: 'USDT', exact: true }).click();
  await expect(page.getByRole('region', { name: '持仓详情', exact: true })).toContainText('1.000000');
  await capture(page, 'asset-holding-detail');
});

test('login, registration and recovery have separate mobile tasks', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '账号登录', exact: true })).toBeVisible();
  await capture(page, 'auth-login');
  await page.getByRole('button', { name: '注册新账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '注册账号', exact: true })).toBeVisible();
  await capture(page, 'auth-register');
  await back(page);
  await expect(page.getByRole('heading', { name: '账号登录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '忘记账号密码', exact: true }).click();
  await expect(page.getByLabel('找回账号用户名')).toBeVisible();
  await capture(page, 'auth-recovery');
  await page.getByRole('button', { name: '返回登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号登录', exact: true })).toBeVisible();
});

test('browser back protects a dirty quick entry and its encrypted draft', async ({ page }) => {
  await openLedger(page);
  await go(page, 'reports');
  await page.getByRole('button', { name: '快速记账', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  await form.getByLabel(/^金额/).fill('3.21');
  await form.getByLabel('描述', { exact: true }).fill('返回后继续的草稿');
  await back(page);
  let guard = page.getByRole('dialog', { name: '关闭未保存表单', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(guard).toBeHidden();
  await expect(form.getByLabel(/^金额/)).toHaveValue('3.21');
  await back(page);
  guard = page.getByRole('dialog', { name: '关闭未保存表单', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '保留草稿并关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('h1')).toHaveText('报表');
  await page.getByRole('button', { name: '快速记账', exact: true }).click();
  await form.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(form.getByLabel(/^金额/)).toHaveValue('3.21');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await go(page, 'history');
  const row = page.locator('[data-history-table] tbody tr[role="button"]').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('.zc-mobile-page-head h2')).toHaveText('记录详情');
  await capture(page, 'history-detail');
  await page.getByRole('button', { name: '返回历史', exact: true }).click();
  await expect(row).toBeVisible();
});
