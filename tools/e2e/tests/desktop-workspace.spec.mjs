import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';
import { enableEveryNavigationModule } from '../account-tests/mobile-onboarding.mjs';

test.use({ viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Shanghai' });
test.setTimeout(300_000);
test.beforeEach(async ({ page }) => page.setDefaultTimeout(15_000));
const go = async (page, screen, tab) => page.evaluate((detail) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail })), { screen, tab });
const nav = (page, id) => page.locator(`.zc-sidebar [data-destination="${id}"] .zc-sidebar-nav-item`);
const entry = (page) => page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });

test('desktop avoids a duplicate asset overview while mobile keeps its fixed asset entry', async ({ page }) => {
  await openLedger(page);
  await go(page, 'settings');
  await page.getByRole('tab', { name: '记账', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '在侧边栏显示资产', exact: true })).toHaveCount(0);
  await enableEveryNavigationModule(page);
  await expect(nav(page, 'assets')).toHaveCount(0);
  for (const id of ['convert', 'fixed', 'game', 'reports']) await expect(nav(page, id)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('desktop-navigation.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = page.getByRole('navigation', { name: '移动端主导航' });
  await mobile.getByRole('button', { name: '资产', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('资产');
  await page.screenshot({ path: test.info().outputPath('mobile-assets.png') });
});

test('desktop modal records, continuous entry and safe closing use the real ledger', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await openLedger(page);
  await nav(page, 'records').click();
  await page.locator('#transaction-records').getByRole('button', { name: '+ 记账', exact: true }).click();
  await expect(entry(page)).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#transaction-records')).toBeVisible();
  for (let n = 0; n < 10; n += 1) {
    await entry(page).getByLabel(/^金额/).fill(`${n + 1}.23`);
    await entry(page).getByLabel('描述', { exact: true }).fill(`桌面连续记账 ${n}`);
    if (n === 0) await entry(page).getByLabel('描述', { exact: true }).press('Control+Enter');
    else await entry(page).getByRole('button', { name: '保存并继续', exact: true }).click();
    await expect(entry(page).getByLabel(/^金额/)).toHaveValue('');
    await expect(entry(page).getByLabel(/^金额/)).toBeFocused();
    await expect(page.locator('.zc-transaction-summary-title').filter({ hasText: `桌面连续记账 ${n}` })).toBeVisible();
  }
  await entry(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(entry(page)).toBeHidden();
  await expect(page.locator('.zc-first-entry-guide')).toHaveCount(0);
  await expect(page.locator('.zc-transaction-row')).toHaveCount(10);
  const visibleRows = await page.locator('.zc-transaction-row').evaluateAll((rows) => rows.filter((row) => row.getBoundingClientRect().bottom <= innerHeight).length);
  // Readable 16px records take priority over the previous 13px density target.
  expect(visibleRows).toBeGreaterThanOrEqual(7);
  expect(await page.locator('.zc-transaction-row td.is-numeric').first().evaluate((cell) => parseFloat(getComputedStyle(cell).fontSize))).toBeGreaterThanOrEqual(16);
  await page.screenshot({ path: test.info().outputPath('desktop-ledger-1280.png') });
  await page.getByLabel('快速搜索流水', { exact: true }).fill('桌面连续记账 9');
  const row = page.locator('.zc-transaction-row').filter({ hasText: '桌面连续记账 9' });
  await row.locator('.zc-transaction-summary-title').click();
  await expect(page.locator('.zc-record-expansion')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('#transaction-records').getByRole('button', { name: '+ 记账', exact: true }).click();
  await entry(page).getByLabel(/^金额/).fill('99.99');
  await entry(page).getByRole('button', { name: '取消', exact: true }).click();
  let guard = page.getByRole('dialog', { name: '关闭未保存表单', exact: true });
  await guard.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(entry(page).getByLabel(/^金额/)).toHaveValue('99.99');
  await entry(page).getByLabel(/^金额/).fill('');
  await entry(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(entry(page)).toBeHidden();
  await page.locator('.zc-record-expansion').getByRole('button', { name: '编辑流水', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑 · 日常收支', exact: true });
  await expect(edit).toHaveAttribute('aria-modal', 'true');
  await edit.getByLabel(/^金额/).fill('11.11');
  await edit.getByRole('button', { name: '取消', exact: true }).click();
  guard = page.getByRole('dialog', { name: '关闭未保存表单', exact: true });
  await guard.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(edit.getByLabel(/^金额/)).toHaveValue('11.11');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByLabel('快速搜索流水', { exact: true })).toHaveValue('桌面连续记账 9');
  await expect(row).toContainText('11.11 CNY');
  await nav(page, 'accounts').click();
  await expect(page.locator('h1')).toHaveText('账户与核对');
  await nav(page, 'plans').click();
  await expect(page.locator('h1')).toHaveText('计划');
  await expect(page.getByRole('button', { name: '预算', exact: true })).toBeVisible();
  await expect(nav(page, 'bills')).toBeVisible();
  await go(page, 'history');
  await page.getByRole('button', { name: /^查看详情：保存流水/ }).first().click();
  await expect(page.locator('.zc-history-detail')).toBeVisible();
  await expect(page.locator('.zc-history-layout')).toHaveCSS('grid-template-columns', /^\d+(?:\.\d+)?px$/);
  await nav(page, 'records').click();
  await expect(page.getByLabel('快速搜索流水', { exact: true })).toHaveValue('桌面连续记账 9');
  expect(errors).toEqual([]);
});

test('desktop task directories, item details and responsive papers share product controls', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await openLedger(page);
  await go(page, 'settings');
  await enableEveryNavigationModule(page);
  await go(page, 'fixed');
  await page.getByRole('button', { name: '+ 新增物品', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 物品资产', exact: true });
  await form.getByLabel(/^名称/).fill('桌面物品与长名称镜头组合');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: '桌面物品与长名称镜头组合', exact: true }).click();
  for (const label of ['概况', '使用与成本', '配件耗材', '记录与凭证']) { await page.getByRole('tab', { name: label, exact: true }).click(); await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true'); }
  await page.getByRole('button', { name: '返回物品', exact: true }).click();
  await go(page, 'manage');
  await page.getByRole('navigation', { name: '资产与资料中心', exact: true }).getByRole('button', { name: '交易模板', exact: true }).click();
  await expect(page.locator('.zc-page-content')).toContainText('交易模板');
  for (const paper of ['文献纸 · 墨朱', '青灰纸 · 墨朱', '紫灰纸 · 墨朱']) for (const mode of ['浅色', '深色']) {
    await go(page, 'settings', 'appearance');
    await page.getByRole('tab', { name: '外观', exact: true }).click();
    await page.getByRole('radio', { name: paper, exact: true }).click();
    await page.getByRole('radio', { name: mode, exact: true }).click();
    for (const width of [1024,1280,1440,1920]) {
      await page.setViewportSize({ width, height: 900 });
      for (const screen of ['dashboard','assets','transactions','fixed','convert','game','reports','manage','history','account','settings']) {
        await go(page, screen);
        await expect(page.locator('.zc-page-body [role="status"]').filter({ hasText: /^正在(?:读取|载入|加载)/ })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${paper}/${mode}/${width}/${screen}`).toBe(true);
        await expect(page.locator('.zc-page-content .zc-card .zc-card')).toHaveCount(0);
      }
      await page.screenshot({ path: test.info().outputPath(`${paper}-${mode}-${width}-settings.png`) });
    }
  }
  expect(errors).toEqual([]);
});

test('a desktop investment plan opens the existing conversion form with its real defaults', async ({ page }) => {
  await openLedger(page);
  await go(page, 'convert');
  await page.getByRole('button', { name: '+ 新增转换', exact: true }).click();
  let form = page.getByRole('dialog', { name: '新增资产转换', exact: true });
  await form.getByRole('button', { name: /USDT · 泰达币/ }).click();
  await form.getByRole('button', { name: '关闭', exact: true }).click();
  const closeGuard = page.getByRole('dialog', { name: '保留未完成的转换？', exact: true });
  if (await closeGuard.isVisible()) await closeGuard.getByRole('button', { name: '放弃草稿并关闭', exact: true }).click();
  await expect(form).toBeHidden();
  await nav(page, 'plans').click();
  await page.getByRole('button', { name: '定投', exact: true }).click();
  await page.getByRole('button', { name: '新增定投计划', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 定投计划', exact: true });
  await form.getByLabel(/^名称/).fill('每月稳定币投入');
  await form.getByLabel('目标资产', { exact: true }).selectOption({ label: 'USDT' });
  await form.getByLabel(/^计划金额/).fill('500');
  await form.getByLabel('频率', { exact: true }).selectOption('monthly');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: '每月稳定币投入', exact: true }).click();
  await expect(page.locator('.zc-page-body')).toContainText('500.00 CNY');
  await page.getByRole('button', { name: '登记本次买入', exact: true }).click();
  const conversion = page.getByRole('dialog', { name: '新增资产转换', exact: true });
  await expect(conversion.getByLabel('来源数量', { exact: true })).toHaveValue('500');
  await expect(conversion.getByLabel('目标资产', { exact: true }).locator('option:checked')).toContainText('USDT');
});
