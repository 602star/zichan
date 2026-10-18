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
    await new Promise((done, reject) => {
      server.server.once('error', reject);
      server.server.listen(0, '127.0.0.1', done);
    });
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
        if (screen === 'transactions') {
          const clipped = await page.locator('.zc-transaction-summary-metric > div:nth-child(2)').evaluateAll((nodes) =>
            nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent));
          expect(clipped, `${width}px transaction amounts`).toEqual([]);
        }
        if (screen === 'reports') {
          const clipped = await page.locator('.zc-summary-value').evaluateAll((nodes) =>
            nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent));
          expect(clipped, `${width}px report amounts`).toEqual([]);
          if (width === 320) {
            const [from, to] = await page.locator('.zc-date-boundary').evaluateAll((nodes) =>
              nodes.slice(0, 2).map((node) => Math.round(node.getBoundingClientRect().top)));
            expect(to, '320px date inputs should be stacked').toBeGreaterThan(from);
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
  } finally {
    await page.close();
    server.server.closeAllConnections();
    await server.close();
  }
});
