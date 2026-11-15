import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';
import { enableEveryNavigationModule } from '../account-tests/mobile-onboarding.mjs';

async function navigate(page, screen) {
  await page.evaluate((screen) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen } })), screen);
  await expect.poll(() => page.locator('.zc-page-content').innerText()).toMatch(/\S/);
  await expect(page.locator('.zc-page-content [role="status"]').filter({ hasText: /^正在(?:读取|载入|加载)/ })).toHaveCount(0);
}

async function assertStructure(page) {
  // Rendered DOM catches nesting introduced across component boundaries too.
  await expect(page.locator('.zc-page-content .zc-card .zc-card')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

for (const width of [1280, 390]) {
  test(`card system across papers and modes at ${width}px`, async ({ page }) => {
    test.setTimeout(360_000);
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.clock.setFixedTime(new Date('2026-11-14T12:00:00+08:00'));
    await openLedger(page);
    await navigate(page, 'settings');
    await enableEveryNavigationModule(page);
    await navigate(page, 'transactions');
    for (const [amount, text] of [['38.50', '午餐'], ['6', '地铁通勤'], ['1280246.79', '年度资产核对与长说明测试']]) {
      await page.locator('#transaction-records').getByRole('button', { name: '+ 记账', exact: true }).click();
      const form = page.getByRole('dialog', { name: '新增 · 日常收支' });
      await form.getByRole('textbox', { name: /^金额/ }).fill(amount);
      await form.getByLabel('描述').fill(text);
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await expect(form).toBeHidden();
    }
    await navigate(page, 'fixed');
    await page.getByRole('button', { name: '+ 新增物品', exact: true }).click();
    const item = page.getByRole('dialog', { name: /新增 · 物品资产/ });
    await item.getByLabel('名称').fill('日常使用的相机与长名称镜头组合');
    await item.getByRole('button', { name: '保存', exact: true }).click();
    await expect(item).toBeHidden();
    await navigate(page, 'convert');
    await page.getByRole('button', { name: '+ 新增转换', exact: true }).click();
    const conversion = page.getByRole('dialog', { name: '新增资产转换' });
    await conversion.getByRole('button', { name: /USDT · 泰达币/ }).click();
    await conversion.getByLabel('标题', { exact: true }).fill('换算步骤与记账明细核对');
    await conversion.getByLabel('来源数量', { exact: true }).fill('700');
    await conversion.getByLabel('目标数量', { exact: true }).fill('100');
    await conversion.getByRole('button', { name: '保存转换', exact: true }).click();
    await expect(conversion).toBeHidden();
    await navigate(page, 'game');
    await page.getByLabel('游戏名称', { exact: true }).fill('休闲赛季');
    await page.getByRole('button', { name: '开始记录', exact: true }).click();
    await expect(page.getByRole('button', { name: '+ 记录', exact: true })).toBeVisible();
    await expect(page.locator('.zc-undo-toast')).toBeHidden({ timeout: 15_000 });
    const guide = page.getByRole('button', { name: '暂时收起', exact: true });
    if (await guide.isVisible()) await guide.click();

    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const theme of ['terracotta', 'sage', 'plum']) {
      for (const mode of ['light', 'dark']) {
        await navigate(page, 'settings');
        await page.getByRole(width === 390 ? 'button' : 'tab', { name: '外观', exact: true }).click();
        const paper = page.getByRole('radio', { name: { terracotta: '文献纸 · 墨朱', sage: '青灰纸 · 墨朱', plum: '紫灰纸 · 墨朱' }[theme], exact: true });
        await paper.click();
        await expect(paper).toBeChecked();
        await page.getByRole('radio', { name: mode === 'dark' ? '深色' : '浅色', exact: true }).click();
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(mode);
        for (const screen of ['dashboard', 'assets', 'fixed', 'convert', 'transactions', 'reports', 'history', 'manage', 'account', 'game', 'settings']) {
          await navigate(page, screen);
          if (screen === 'dashboard') {
            await expect(page.locator('.zc-dashboard-kpi-grid')).toBeVisible();
            expect(await page.locator('.zc-dashboard-kpi-grid').evaluate((node) => getComputedStyle(node).gap)).toMatch(/^(normal|0px)$/);
            if (width === 390) await page.getByRole('button', { name: '查看完整指标', exact: true }).click();
            await expect(page.locator('.zc-dashboard-kpi-grid > .zc-card-metric')).toHaveCount(5);
          }
          if (screen === 'fixed' && width === 390) await page.getByRole('button', { name: '日常使用的相机与长名称镜头组合', exact: true }).click();
          if (screen === 'convert') {
            await page.getByRole('tab', { name: '持仓概览', exact: true }).click();
            const record = page.getByText('换算步骤与记账明细核对', { exact: true });
            if (!await record.isVisible()) await page.locator('.zc-convert-asset-header').first().click();
            await record.click();
            await expect(page.getByText('换算步骤', { exact: true })).toBeVisible();
            await expect(page.locator('.zc-convert-step')).toHaveCount(1);
          }
          if (screen === 'reports') {
            const summary = page.locator('.zc-card-summary');
            if (await summary.count()) await summary.click();
          }
          await assertStructure(page);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: test.info().outputPath(`${theme}-${mode}-${width}-${screen}.png`), fullPage: true });
        }
      }
    }
    await navigate(page, 'settings');
    await page.getByRole(width === 390 ? 'button' : 'tab', { name: '服务器与同步', exact: true }).click();
    await page.getByRole('button', { name: /^客户端同步与服务器连接/ }).click();
    await expect(page.getByRole('button', { name: '新增服务器', exact: true })).toBeVisible();
    await assertStructure(page);
    await page.screenshot({ path: test.info().outputPath(`sync-expanded-${width}.png`), fullPage: true });
    await navigate(page, 'transactions');
    if (width === 1280) await page.locator('.zc-sidebar [data-destination="plans"] .zc-sidebar-nav-item').click();
    else await page.getByRole('button', { name: '预算', exact: true }).click();
    await page.getByRole('button', { name: '年度', exact: true }).click();
    await expect(page.locator('.zc-budget-row').first()).toBeVisible();
    await page.locator('.zc-budget-row').first().click();
    await expect(page.getByRole('button', { name: '月份', exact: true })).toBeVisible();
    await assertStructure(page);
    expect(errors).toEqual([]);
  });
}
