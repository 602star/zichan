import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';
import { enableEveryNavigationModule } from '../account-tests/mobile-onboarding.mjs';

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' });
test.beforeEach(async ({ page }) => { page.setDefaultTimeout(15_000); });
const go = (page, screen, tab) => page.evaluate((detail) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail })), { screen, tab });

test('settings uses real sidebar names, group ordering, phone names and 44px controls', async ({ page }) => {
  await openLedger(page); await go(page, 'settings', 'ledger'); await enableEveryNavigationModule(page);
  const list = page.locator('.zc-navigation-settings-list');
  await expect(list.locator('h3')).toHaveText(['日常', '资产与分析', '账本工具']);
  for (const label of ['工作台', '流水', '资料管理', '操作历史']) await expect(page.getByLabel(`在侧边栏显示${label}`, { exact: true })).toBeVisible();
  for (const label of ['总览', '日常收支', '管理', '历史', '资产']) await expect(page.getByLabel(`在侧边栏显示${label}`, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '上移资产转换', exact: true })).toBeDisabled();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '上移报表', exact: true }).click();
  const order = () => page.locator('.zc-sidebar [data-destination]').evaluateAll((rows) => rows.filter((node) => ['reports', 'convert', 'fixed', 'game'].includes(node.dataset.destination)).map((node) => node.dataset.destination));
  await expect.poll(order).toEqual(['reports', 'convert', 'fixed', 'game']);
  await page.reload(); await openLedger(page); await go(page, 'settings', 'ledger'); await expect.poll(order).toEqual(['reports', 'convert', 'fixed', 'game']);
  for (const mode of ['浅色', '深色']) {
    await go(page, 'settings', 'appearance'); await page.getByRole('tab', { name: '外观', exact: true }).click(); await page.getByRole('radio', { name: mode, exact: true }).click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 }); await go(page, 'settings', 'ledger');
      if (width < 768) {
        await expect(list).toHaveCount(0);
        await expect(page.getByRole('heading', { name: '侧边栏与模块', exact: true })).toHaveCount(0);
        await expect(page.locator('.zc-mobile-bottom-nav button')).toHaveText(['总览', '收支', '记一笔', '资产', '更多']);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (width >= 768) {
        expect((await page.getByRole('button', { name: '下移报表', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
        await list.locator('section').first().evaluate((node) => { node.scrollIntoView({ block: 'start' }); window.scrollBy(0, -document.querySelector('.zc-app-header').getBoundingClientRect().height - 12); });
        await page.screenshot({ path: test.info().outputPath(`navigation-${mode}-${width}.png`) });
        await list.locator('section').last().evaluate((node) => { node.scrollIntoView({ block: 'start' }); window.scrollBy(0, -document.querySelector('.zc-app-header').getBoundingClientRect().height - 12); });
        await page.screenshot({ path: test.info().outputPath(`navigation-tools-${mode}-${width}.png`) });
      } else {
        await page.screenshot({ path: test.info().outputPath(`navigation-phone-${mode}-${width}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  }
});

test('desktop guide stays useful after the first record and reopens with completed progress', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await openLedger(page); await go(page, 'settings', 'ledger');
  await page.getByRole('button', { name: '查看新手指南', exact: true }).click();
  const guide = page.getByRole('region', { name: '首次记账引导', exact: true });
  await expect(guide).toBeVisible(); await expect(guide).toContainText('保存并继续');
  await guide.getByRole('button', { name: '记第一笔', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  await form.getByLabel(/^金额/).fill('18'); await form.getByLabel('描述', { exact: true }).fill('新手指南首笔');
  await form.locator('.zc-dialog-foot').getByRole('button', { name: '保存', exact: true }).click(); await expect(form).toBeHidden();
  await expect(guide).toBeHidden(); await page.getByRole('button', { name: '查看新手指南', exact: true }).click();
  await expect(guide).toContainText('记第一笔 · 已完成');
  await guide.getByRole('button', { name: '暂时收起', exact: true }).click();
  await page.getByRole('button', { name: '查看新手指南', exact: true }).click(); await expect(guide).toContainText('记第一笔 · 已完成');
  await guide.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(guide).toContainText('按场景补充分类');
  await guide.getByRole('button', { name: '暂不需要', exact: true }).click();
  await expect(guide.getByRole('button', { name: '创建自己的模板', exact: true })).toBeVisible();
  await guide.getByRole('button', { name: '下一步', exact: true }).click();
  await guide.getByText('账单、物品和备份怎么用？', { exact: true }).click();
  await guide.getByRole('button', { name: '查看资料管理', exact: true }).click();
  await expect(page.locator('.zc-app-header')).toContainText('资料管理');
  await page.getByRole('button', { name: '返回新手指南', exact: true }).click(); await expect(guide).toContainText('找到常用功能');
  await page.screenshot({ path: test.info().outputPath('desktop-guide-completed.png'), fullPage: true });
  await guide.getByRole('button', { name: '完成引导', exact: true }).click();
  await expect(guide).toBeHidden();
  await expect(page.getByRole('button', { name: '查看新手指南', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await go(page, 'transactions', 'records');
  await expect(guide).toBeHidden();
  await expect(page.getByRole('button', { name: '查看新手指南', exact: true })).toHaveCount(0);
  await go(page, 'settings', 'ledger');
  await page.getByRole('button', { name: '查看新手指南', exact: true }).click();
  await expect(guide).toContainText('找到常用功能');
  await guide.getByRole('button', { name: '上一步', exact: true }).click();
  await guide.getByRole('button', { name: '上一步', exact: true }).click();
  await guide.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(guide).toContainText('记第一笔 · 已完成');
  await page.screenshot({ path: test.info().outputPath('desktop-guide-first-record.png') });
  await guide.getByRole('button', { name: '暂时收起', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看新手指南', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('settings starts a guide for an existing ledger and mobile tutorial links open current tasks', async ({ page }) => {
  await openLedger(page); await go(page, 'transactions', 'records');
  await page.getByRole('button', { name: '+ 记账', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  await form.getByLabel(/^金额/).fill('25'); await form.locator('.zc-dialog-foot').getByRole('button', { name: '保存', exact: true }).click(); await expect(form).toBeHidden();
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.includes('zichan.onboarding.v1')) localStorage.removeItem(key); });
  await page.setViewportSize({ width: 390, height: 900 }); await go(page, 'settings', 'ledger');
  await page.getByRole('button', { name: '查看新手指南', exact: true }).click();
  const guide = page.getByRole('region', { name: '首次记账引导', exact: true }); await expect(guide).toContainText('记第一笔 · 已完成');
  for (let i = 0; i < 3; i++) await guide.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(guide.getByRole('heading', { name: '找到常用功能', exact: true })).toBeVisible(); await expect(guide).toContainText('长按或左右滑动');
  await guide.getByText('账单、物品和备份怎么用？', { exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('phone-guide-navigation.png'), fullPage: true });
  await guide.getByRole('button', { name: '查看账单与还款', exact: true }).click(); await expect(page.locator('.zc-ledger-page')).toHaveClass(/is-bills/);
  await go(page, 'settings', 'ledger'); await page.getByRole('button', { name: '查看新手指南', exact: true }).click();
  await expect(guide.getByRole('heading', { name: '找到常用功能', exact: true })).toBeVisible();
  await guide.getByText('账单、物品和备份怎么用？', { exact: true }).click();
  await guide.getByRole('button', { name: '查看物品资产', exact: true }).click(); await expect(page.locator('.zc-fixed-inventory')).toBeVisible();
});

for (const width of [1280, 768, 390, 320]) test(`guide ${width}px can be skipped and completed without a transaction`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await openLedger(page);
  await go(page, 'settings', 'ledger');
  const entry = page.getByRole('region', { name: '新手指南', exact: true });
  await expect(entry).toBeVisible();
  await entry.screenshot({ path: test.info().outputPath(`settings-guide-entry-${width}.png`) });
  await page.getByRole('button', { name: '查看新手指南', exact: true }).click();
  const guide = page.getByRole('region', { name: '首次记账引导', exact: true });
  await expect(guide).toContainText('新手指南 · 1/4');
  await guide.getByRole('button', { name: '稍后再记，下一步', exact: true }).click();
  await expect(guide).toContainText('新手指南 · 2/4');
  await guide.getByRole('button', { name: '暂时收起', exact: true }).click();
  await page.reload();
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await go(page, 'transactions', 'records');
  await expect(guide).toBeHidden();
  await page.getByRole('button', { name: '查看新手指南', exact: true }).click();
  await expect(guide).toContainText('新手指南 · 2/4');
  await guide.getByRole('button', { name: '暂不需要', exact: true }).click();
  await expect(guide).toContainText('新手指南 · 3/4');
  await page.screenshot({ path: test.info().outputPath(`guide-template-${width}.png`) });
  await page.setViewportSize({ width: width < 768 ? 1280 : 390, height: 900 });
  await expect(guide).toContainText('新手指南 · 3/4');
  await page.setViewportSize({ width, height: 900 });
  await guide.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(guide).toContainText('基础操作已介绍完');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const mode of ['浅色', '深色']) {
    await go(page, 'settings', 'appearance');
    await page.getByRole('radio', { name: mode, exact: true }).click();
    await go(page, 'transactions', 'records');
    await expect(guide).toContainText('新手指南 · 4/4');
    await page.screenshot({ path: test.info().outputPath(`guide-finish-${mode}-${width}.png`) });
  }
  await guide.getByRole('button', { name: '完成引导', exact: true }).click();
  await expect(guide).toBeHidden();
  await expect(page.getByRole('button', { name: '查看新手指南', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await go(page, 'transactions', 'records');
  await expect(guide).toBeHidden();
  await expect(page.getByRole('button', { name: '查看新手指南', exact: true })).toHaveCount(0);
});

test('mobile guide confirms a saved entry and marks a template only after saving it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openLedger(page);
  await go(page, 'settings', 'ledger');
  await page.getByRole('button', { name: '查看新手指南', exact: true }).click();
  const guide = page.getByRole('region', { name: '首次记账引导', exact: true });
  await guide.getByRole('button', { name: '记第一笔', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  await form.getByLabel(/^金额/).fill('18');
  await form.locator('.zc-dialog-foot').getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(guide).toContainText('记第一笔 · 已完成');
  await expect(guide).toContainText('第一笔已经保存');
  await guide.getByRole('button', { name: '下一步', exact: true }).click();
  await guide.getByRole('button', { name: '查看扩展包', exact: true }).click();
  await page.getByRole('button', { name: '启用养宠扩展包', exact: true }).click();
  await expect(page.getByTestId('category-pack-pet')).toContainText('已启用');
  await page.getByRole('button', { name: '返回新手指南', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('mobile-guide-return.png') });
  await page.getByRole('button', { name: '返回新手指南', exact: true }).click();
  await expect(guide).toContainText('按场景补充分类 · 已启用');
  await guide.getByRole('button', { name: '下一步', exact: true }).click();
  await guide.getByRole('button', { name: /试用.*模板/ }).click();
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await expect(guide).not.toContainText('用模板快速记账 · 已体验');
  await guide.getByRole('button', { name: /试用.*模板/ }).click();
  await form.getByLabel(/^金额/).fill('20');
  await form.locator('.zc-dialog-foot').getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(guide).toContainText('用模板快速记账 · 已体验');
  await page.reload();
  await expect(guide).toContainText('用模板快速记账 · 已体验');
  await page.screenshot({ path: test.info().outputPath('mobile-template-saved.png') });
  await guide.getByRole('button', { name: '下一步', exact: true }).click();
  await guide.getByRole('button', { name: '完成引导', exact: true }).click();
  await expect(guide).toBeHidden();
  await go(page, 'manage');
  await expect(page.getByRole('button', { name: '返回新手指南', exact: true })).toHaveCount(0);
});
