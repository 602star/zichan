import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { enableEveryNavigationModule, openSpendingLedger } from './mobile-onboarding.mjs';

test.use({ hasTouch: true, isMobile: true });

test('populated mobile cards keep amounts and actions within the phone viewport', async ({ page }) => {
  test.setTimeout(120_000);
  const ownerSetupToken = 'e2e-mobile-card-owner-setup-0000000';
  const server = createSyncServer({
    enableWeb: true,
    webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'),
    registrationMode: 'open',
    ownerSetupToken,
  });
  try {
    await server.ready;
    await listenOnSafePort(server.server, '127.0.0.1');
    const base = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(base, 'mobile-card-owner', 'mobile-card-owner-password', { ownerSetupToken });
    await registerAccount(base, 'mobile-card-user', 'mobile-card-user-password');
    await page.setViewportSize({ width: 320, height: 844 });
    await openSpendingLedger(page, base, 'mobile-card-user', 'mobile-card-user-password');
    await enableEveryNavigationModule(page);

    const navigate = async (screen) => {
      await page.evaluate((name) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: name } })), screen);
      await page.waitForTimeout(180);
    };
    const viewportFit = async (width, screen) => {
      const actual = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        navRight: document.querySelector('.zc-mobile-bottom-nav')?.getBoundingClientRect().right,
      }));
      expect(actual.client, `${width}px ${screen} viewport`).toBe(width);
      expect(actual.scroll, `${width}px ${screen} document overflow`).toBeLessThanOrEqual(width + 1);
      expect(actual.navRight, `${width}px ${screen} bottom navigation`).toBeLessThanOrEqual(width + 1);
    };

    await navigate('transactions');
    await page.getByRole('button', { name: '+ 记账' }).click();
    const form = page.getByRole('dialog', { name: '新增 · 日常收支' });
    await expect(form).toBeVisible();
    await form.getByRole('textbox', { name: /^金额/ }).fill('1280246.79');
    await form.getByLabel('描述').fill('大额支出');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(form).toBeHidden();
    await viewportFit(320, 'transactions after save');

    for (const width of [320, 390, 414]) {
      await page.setViewportSize({ width, height: 844 });
      for (const screen of ['dashboard', 'transactions', 'reports', 'convert', 'fixed', 'history', 'manage']) {
        await navigate(screen);
        await viewportFit(width, screen);
        if (width === 320 && ['dashboard', 'reports', 'history'].includes(screen)) {
          const [from, to] = await page.locator('.zc-date-range-bar').first().locator('.zc-date-boundary').evaluateAll((nodes) =>
            nodes.slice(0, 2).map((node) => Math.round(node.getBoundingClientRect().top)));
          expect(to, `320px ${screen} date inputs should be stacked`).toBeGreaterThan(from);
        }
        if (screen === 'transactions') {
          await expect(page.locator('#transaction-records .zc-date-boundary').first(), `${width}px transaction preset dates stay tucked away`).toBeHidden();
        }
        if (screen === 'transactions') {
          const clipped = await page.locator('.zc-transaction-summary-metric > div:nth-child(2)').evaluateAll((nodes) =>
            nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent));
          expect(clipped, `${width}px transaction amounts`).toEqual([]);
        }
        if (screen === 'reports') {
          const clipped = await page.locator('.zc-summary-value').evaluateAll((nodes) =>
            nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent));
          expect(clipped, `${width}px report amounts`).toEqual([]);
        }
        if (screen === 'reports' || screen === 'transactions') {
          const totals = await page.locator('.zc-donut-total').evaluateAll((nodes) => nodes.map((node) => {
            const visual = node.parentElement.getBoundingClientRect();
            const ring = node.parentElement.querySelector('.zc-donut-ring').getBoundingClientRect();
            const amount = node.getBoundingClientRect();
            return { text: node.textContent, left: amount.left, right: amount.right, top: amount.top, visualLeft: visual.left, visualRight: visual.right, ringBottom: ring.bottom, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
          }));
          expect(totals.length, `${width}px ${screen} donut totals`).toBeGreaterThan(0);
          for (const total of totals) {
            expect(total.left, `${width}px ${screen} ${total.text} left edge`).toBeGreaterThanOrEqual(total.visualLeft - 1);
            expect(total.right, `${width}px ${screen} ${total.text} right edge`).toBeLessThanOrEqual(total.visualRight + 1);
            expect(total.top, `${width}px ${screen} ${total.text} stays below the ring`).toBeGreaterThanOrEqual(total.ringBottom);
            expect(total.scrollWidth, `${width}px ${screen} ${total.text} full width`).toBeLessThanOrEqual(total.clientWidth + 1);
            expect(total.scrollHeight, `${width}px ${screen} ${total.text} full text`).toBeLessThanOrEqual(total.clientHeight + 1);
          }
        }
        if (screen === 'manage') {
          const actions = await page.locator('.zc-category-summary-actions').first().locator('button').evaluateAll((nodes) =>
            nodes.map((node) => ({ top: Math.round(node.getBoundingClientRect().top), right: Math.round(node.getBoundingClientRect().right) })));
          expect(actions).toHaveLength(2);
          expect(actions[0].top, `${width}px category actions share a row`).toBe(actions[1].top);
          expect(actions[1].right, `${width}px category actions fit`).toBeLessThanOrEqual(width);
        }
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await navigate('transactions');
    const filterToggle = page.getByRole('button', { name: /筛选与搜索/ });
    await expect(filterToggle).toBeVisible();
    await expect(filterToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('textbox', { name: '流水搜索' })).toBeHidden();
    await filterToggle.click();
    await expect(page.getByRole('textbox', { name: '流水搜索' })).toBeVisible();
    await page.getByRole('textbox', { name: '流水搜索' }).fill('没有这笔流水');
    await filterToggle.click();
    await expect(filterToggle).toContainText('已启用 1 项');
    await expect(page.getByRole('textbox', { name: '流水搜索' })).toBeHidden();
    await page.getByRole('combobox', { name: '快捷时间范围' }).first().selectOption('custom');
    await expect(page.locator('#transaction-records .zc-date-boundary').first()).toBeVisible();

    await navigate('settings');
    await expect(page.getByRole('combobox', { name: '默认卖出匹配方式' })).toBeHidden();
    await expect(page.getByRole('combobox', { name: '记账弹窗默认分类范围' })).toBeHidden();
    await expect(page.getByRole('button', { name: '恢复推荐布局' })).toBeHidden();
    await page.getByRole('button', { name: /更多结算选项/ }).click();
    await expect(page.getByRole('combobox', { name: '默认卖出匹配方式' })).toBeVisible();
    await page.getByRole('button', { name: /分类设置/ }).click();
    await expect(page.getByRole('combobox', { name: '记账弹窗默认分类范围' })).toBeVisible();
    await page.getByRole('button', { name: /字段设置/ }).click();
    await expect(page.getByRole('button', { name: '仅核心' })).toBeVisible();
    await page.getByRole('button', { name: /模块设置/ }).click();
    await expect(page.getByRole('button', { name: '恢复推荐布局' })).toBeVisible();
    await page.getByRole('button', { name: /更多结算选项/ }).click();
    await page.getByRole('button', { name: /分类设置/ }).click();
    await page.getByRole('button', { name: /字段设置/ }).click();
    await page.getByRole('button', { name: /模块设置/ }).click();
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.getByRole('button', { name: /更多结算选项/ })).toBeHidden();
    await expect(page.getByRole('combobox', { name: '默认卖出匹配方式' })).toBeVisible();
    await expect(page.getByRole('button', { name: '进入分类中心' })).toBeVisible();
    await expect(page.getByRole('button', { name: '恢复推荐布局' })).toBeVisible();
  } finally {
    await page.close();
    await closeTestSyncServer(server);
  }
});
