import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { openSpendingLedger } from './mobile-onboarding.mjs';

test.use({ hasTouch: true, isMobile: true });

test('other master data opens one focused category at a time on phone and desktop', async ({ page }, testInfo) => {
  const ownerSetupToken = 'e2e-manage-tabs-owner-setup-000000000';
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
    await registerAccount(base, 'manage-tabs-owner', 'manage-tabs-owner-password', { ownerSetupToken });
    await registerAccount(base, 'manage-tabs-user', 'manage-tabs-user-password');
    await page.setViewportSize({ width: 320, height: 844 });
    await openSpendingLedger(page, base, 'manage-tabs-user', 'manage-tabs-user-password');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'manage' } })));
    const panel = page.locator('.zc-manage-other-panel');
    const categories = [
      { id: 'accounts', label: '账户', actions: ['+ 新增账户'] },
      { id: 'templates', label: '记账模板', actions: ['+ 新增交易模板'] },
      { id: 'prices', label: '价格标记', actions: ['+ 新增价格与折算率'] },
      { id: 'plans', label: '定投计划', actions: ['+ 新增定投计划', '+ 新增分类预算', '+ 新增定期交易'] },
      { id: 'games', label: '游戏资料', actions: ['+ 新增游戏', '+ 新增游戏账号', '+ 新增游戏赛季'] },
      { id: 'attachments', label: '附件', actions: [] },
    ];
    for (const { label, actions } of categories) {
      await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
      await expect(panel.getByRole('button', { name: /^\+ 新增/ })).toHaveCount(actions.length);
      for (const action of actions) await expect(panel.getByRole('button', { name: action, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} should fit phone width`).toBe(true);
      if (label !== '附件') await page.getByRole('button', { name: '返回资料', exact: true }).click();
    }
    await expect(panel.getByLabel('搜索附件')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('manage-other-phone.png') });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('navigation', { name: '资料管理' }).getByRole('button', { name: '交易模板', exact: true }).click();
    await expect(panel.getByRole('button', { name: '+ 新增交易模板', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '+ 新增账户', exact: true })).toHaveCount(0);
  } finally {
    await closeTestSyncServer(server);
  }
});
