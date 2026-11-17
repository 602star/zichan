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
        const toggle = page.getByRole('button', { name: '模块设置' });
        if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
        await expect(page.locator('.zc-mobile-bottom-nav button')).toHaveText(['总览', '收支', '记一笔', '资产', '更多']);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect((await page.getByRole('button', { name: '下移报表', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
      await list.locator('section').first().evaluate((node) => { node.scrollIntoView({ block: 'start' }); window.scrollBy(0, -document.querySelector('.zc-app-header').getBoundingClientRect().height - 12); });
      await page.screenshot({ path: test.info().outputPath(`navigation-${mode}-${width}.png`) });
      await list.locator('section').last().evaluate((node) => { node.scrollIntoView({ block: 'start' }); window.scrollBy(0, -document.querySelector('.zc-app-header').getBoundingClientRect().height - 12); });
      await page.screenshot({ path: test.info().outputPath(`navigation-tools-${mode}-${width}.png`) });
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
  await expect(guide).toContainText('记第一笔 · 已完成'); await expect(guide.getByRole('button', { name: '创建自己的模板', exact: true })).toBeVisible();
  await guide.getByRole('button', { name: '暂时收起', exact: true }).click();
  await page.getByRole('button', { name: '查看新手指南', exact: true }).click(); await expect(guide).toContainText('记第一笔 · 已完成');
  await guide.getByRole('button', { name: '查看资料管理', exact: true }).click();
  await expect(page.locator('.zc-app-header')).toContainText('资料管理');
  await page.getByRole('button', { name: '返回新手指南', exact: true }).click(); await expect(guide).toContainText('记第一笔 · 已完成');
  await page.screenshot({ path: test.info().outputPath('desktop-guide-completed.png'), fullPage: true });
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
  await page.screenshot({ path: test.info().outputPath('phone-guide-navigation.png'), fullPage: true });
  await guide.getByRole('button', { name: '查看账单与还款', exact: true }).click(); await expect(page.locator('.zc-ledger-page')).toHaveClass(/is-bills/);
  await go(page, 'settings', 'ledger'); await page.getByRole('button', { name: '查看新手指南', exact: true }).click();
  await expect(guide.getByRole('heading', { name: '找到常用功能', exact: true })).toBeVisible();
  await guide.getByRole('button', { name: '查看物品资产', exact: true }).click(); await expect(page.locator('.zc-fixed-inventory')).toBeVisible();
});
