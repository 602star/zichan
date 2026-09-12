import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

for (const width of [360, 390]) test(`mobile ${width}px supports login, initialization, entry, protection and sync`, async ({ page }, testInfo) => {
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
    await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
    await expect(page.getByRole('button', { name: '直接开始记支出', exact: true })).toBeVisible();
    await fits();
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '记一笔支出' })).toBeVisible();
    await fits();
    await page.getByRole('button', { name: '关闭快速记账' }).click();
    const nav = page.getByRole('navigation', { name: '移动端主导航' });
    await nav.getByRole('button', { name: /设置$/ }).click();
    const panel = page.getByRole('region', { name: '账本保护' });
    await expect(panel).toBeVisible();
    await panel.getByText('此设备的离线访问', { exact: true }).click();
    await panel.getByLabel('设置离线密码').fill('mobile-offline-password');
    await panel.getByLabel('确认离线密码').fill('mobile-offline-password');
    await panel.getByRole('button', { name: '设置离线密码', exact: true }).click();
    await expect(panel).toContainText('离线密码已设置');
    await fits();
    await panel.screenshot({ path: testInfo.outputPath('mobile-protection.png') });
    await page.getByRole('checkbox', { name: /显示同步/ }).click();
    await expect(page.getByRole('checkbox', { name: /显示同步/ })).toBeChecked();
    await nav.getByRole('button', { name: /同步$/ }).click();
    await expect(page.getByRole('region', { name: '账本保护' })).toBeVisible();
    await fits();
    await page.screenshot({ path: testInfo.outputPath('mobile-sync.png') });
  } finally { await page.close(); const closing = server.close(); server.server.closeAllConnections(); await closing; }
});
