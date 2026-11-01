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
    await page.getByRole('tab', { name: '其他资料', exact: true }).click();

    const primaryTabs = page.getByRole('tablist', { name: '资产与资料中心' });
    const primaryBounds = await primaryTabs.getByRole('tab').evaluateAll((nodes) => nodes.map((node) => ({
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
      textFits: node.scrollWidth <= node.clientWidth + 1,
    })));
    expect(primaryBounds.every((item, index) => item.textFits && (!index || item.left >= primaryBounds[index - 1].right - 1))).toBe(true);
    const selectedBounds = await primaryTabs.evaluate((list) => ({
      listRight: list.getBoundingClientRect().right,
      selectedRight: list.querySelector('[aria-selected="true"]').getBoundingClientRect().right,
    }));
    expect(selectedBounds.selectedRight).toBeLessThanOrEqual(selectedBounds.listRight + 1);

    const tabs = page.getByRole('tablist', { name: '其他资料类别' });
    const panel = page.locator('.zc-manage-other-panel');
    await expect(tabs.getByRole('tab')).toHaveCount(6);
    const positions = await tabs.getByRole('tab').evaluateAll((nodes) => nodes.map((node) => ({
      top: Math.round(node.getBoundingClientRect().top),
      clipped: node.scrollWidth > node.clientWidth + 1,
    })));
    expect(positions.slice(0, 3).map((item) => item.top)).toEqual([positions[0].top, positions[0].top, positions[0].top]);
    expect(positions.slice(3).every((item) => item.top > positions[0].top)).toBe(true);
    expect(positions.every((item) => !item.clipped)).toBe(true);

    const categories = [
      { id: 'accounts', label: '账户', actions: ['+ 新增账户'] },
      { id: 'templates', label: '交易模板', actions: ['+ 新增交易模板'] },
      { id: 'prices', label: '价格汇率', actions: ['+ 新增价格与折算率'] },
      { id: 'plans', label: '计划预算', actions: ['+ 新增定投计划', '+ 新增分类预算', '+ 新增定期交易'] },
      { id: 'games', label: '游戏资料', actions: ['+ 新增游戏', '+ 新增游戏账号', '+ 新增游戏赛季'] },
      { id: 'attachments', label: '附件', actions: [] },
    ];
    for (const { label, actions } of categories) {
      const selectedTab = tabs.getByRole('tab', { name: label, exact: true });
      await selectedTab.click();
      await expect(panel).toHaveAttribute('aria-labelledby', await selectedTab.getAttribute('id'));
      await expect(panel.getByRole('button', { name: /^\+ 新增/ })).toHaveCount(actions.length);
      for (const action of actions) await expect(panel.getByRole('button', { name: action, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} should fit phone width`).toBe(true);
    }
    await expect(panel.getByLabel('搜索附件')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('manage-other-phone.png') });

    await page.setViewportSize({ width: 1280, height: 900 });
    await tabs.getByRole('tab', { name: '交易模板', exact: true }).click();
    await expect(panel.getByRole('button', { name: '+ 新增交易模板', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '+ 新增账户', exact: true })).toHaveCount(0);
  } finally {
    await closeTestSyncServer(server);
  }
});
