import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { enableEveryNavigationModule, openSpendingLedger } from './mobile-onboarding.mjs';

test.use({ hasTouch: true, isMobile: true });

test('audit short Chinese labels on phone screens', async ({ page }) => {
  test.setTimeout(720_000);
  const ownerSetupToken = 'e2e-wrap-audit-owner-setup-00000000';
  const server = createSyncServer({
    enableWeb: true,
    webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'),
    registrationMode: 'open', ownerSetupToken,
  });
  try {
    await server.ready;
    await listenOnSafePort(server.server, '127.0.0.1');
    const base = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(base, 'wrap-owner', 'wrap-owner-password', { ownerSetupToken });
    await registerAccount(base, 'wrap-user', 'wrap-user-password');
    await page.setViewportSize({ width: 390, height: 844 });
    await openSpendingLedger(page, base, 'wrap-user', 'wrap-user-password');
    await enableEveryNavigationModule(page);
    const output = resolve(fileURLToPath(new URL('../test-results/wrap-audit/', import.meta.url)));
    mkdirSync(output, { recursive: true });
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const screen of ['dashboard', 'convert', 'transactions', 'game', 'fixed', 'reports', 'history', 'manage', 'settings']) {
        await page.evaluate((name) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: name } })), screen);
        await page.waitForTimeout(220);
        const wrapped = await page.evaluate(() => {
          const issues = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent.trim();
            if (!/^[\p{Script=Han}]{3,8}$/u.test(text)) continue;
            const parent = node.parentElement;
            if (!parent || parent.closest('[aria-hidden="true"]')) continue;
            const element = parent.getBoundingClientRect();
            const style = getComputedStyle(parent);
            if (!element.width || !element.height || style.display === 'none' || style.visibility === 'hidden') continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const lines = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
            const positions = new Set(lines.map((rect) => Math.round(rect.top)));
            if (positions.size <= 1) continue;
            issues.push({ text, lines: positions.size, width: Math.round(element.width), tag: parent.tagName.toLowerCase(), className: String(parent.className).slice(0, 100), html: parent.outerHTML.slice(0, 240) });
          }
          return issues;
        });
        expect(wrapped.filter(({ text, tag }) => text.length === 4 || (tag === 'button' && text.length <= 6)), `${width}px ${screen} short labels must stay on one line`).toEqual([]);
        if (width === 390) await page.screenshot({ path: resolve(output, `${screen}.png`), fullPage: true });
        if (screen === 'manage') {
          await page.locator('.zc-category-group-summary').first().evaluate((summary) => summary.click());
          await expect(page.locator('.zc-manage-category-item').first()).toBeVisible({ timeout: 5000 });
          await page.locator('.zc-manage-category-more > summary').first().evaluate((summary) => summary.click());
          const compactItems = await page.locator('.zc-manage-category-item').first().evaluate((item) => {
            const values = [];
            for (const node of item.querySelectorAll('strong, summary, button')) {
              const text = node.textContent.trim();
              if (!/^[\p{Script=Han}]{3,6}$/u.test(text)) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              const tops = new Set([...range.getClientRects()].filter((rect) => rect.width && rect.height).map((rect) => Math.round(rect.top)));
              if (tops.size > 1) values.push({ text, lines: tops.size });
            }
            return values;
          });
          expect(compactItems, `${width}px expanded mobile category actions must stay on one line`).toEqual([]);
          if (width === 390) await page.screenshot({ path: resolve(output, 'manage-expanded.png'), fullPage: true });
        }
      }
    }
  } finally {
    await closeTestSyncServer(server);
  }
});
