import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

test.use({ hasTouch: true, isMobile: true });

for (const width of [320, 360, 390]) test(`mobile ${width}px supports login, initialization, entry, protection and sync`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  const setup = 'test-mobile-owner-00000000000000000';
  const server = createSyncServer({ webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken: setup });
  const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  try {
    await server.ready;
    await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'owner', 'owner-test-password', { ownerSetupToken: setup });
    await registerAccount(url, 'mobile-user', 'account-test-password');
    await page.goto(`${url}/app/`);
    await page.getByLabel('服务器用户名').fill('mobile-user');
    await page.getByLabel('服务器账号密码').fill('account-test-password');
    await fits();
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '创建个人账本' })).toBeVisible();
    await fits();
    await page.getByRole('button', { name: '创建个人账本' }).click();
    const firstRunTitle = page.getByRole('heading', { name: '你希望怎样开始记账？' });
    await expect(firstRunTitle).toBeVisible();
    const titleLines = await firstRunTitle.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    });
    expect(titleLines).toBe(1);
    await fits();
    await page.screenshot({ path: testInfo.outputPath('mobile-first-run.png') });
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(page.getByRole('region', { name: '首次记账引导' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '新增 · 日常收支' })).toBeHidden();
    await fits();
    await page.screenshot({ path: testInfo.outputPath('mobile-first-entry-guide.png') });
    await page.getByRole('button', { name: '记第一笔' }).click();
    const entry = page.getByRole('dialog', { name: '新增 · 日常收支' });
    await expect(entry).toBeVisible();
    await entry.getByRole('button', { name: '取消', exact: true }).click();
    const nav = page.getByRole('navigation', { name: '移动端主导航' });
    // Data protection remains reachable from the account page on small screens.
    await nav.getByRole('button', { name: /更多$/ }).click();
    await page.getByRole('dialog', { name: '更多功能' }).getByRole('button', { name: /我的账号$/ }).click();
    await page.getByRole('button', { name: '查看服务器上的账本' }).click();
    await page.getByRole('tab', { name: '解锁与安全' }).click();
    const panel = page.getByRole('region', { name: '账本保护' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('本机离线访问已准备好');
    await fits();
    await panel.screenshot({ path: testInfo.outputPath('mobile-protection.png') });
    await page.getByRole('tab', { name: '本机备份' }).click();
    await expect(page.getByRole('region', { name: '当前设备' })).toBeVisible();
    await page.getByRole('tab', { name: '服务器与同步' }).click();
    await expect(page.getByRole('region', { name: '服务器', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '解锁与安全' }).click();
    await expect(page.getByRole('region', { name: '账本保护' })).toBeVisible();
    await fits();
    await page.screenshot({ path: testInfo.outputPath('mobile-sync.png') });
  } finally { await page.close(); const closing = server.close(); server.server.closeAllConnections(); await closing; }
});
