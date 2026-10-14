import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

test('two browser tabs can write the same ledger and see each other’s records', async ({ page, context }) => {
  const setup = 'multi-tab-owner-setup-0000000000000000';
  const server = createSyncServer({
    webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'),
    enableWeb: true, registrationMode: 'open', ownerSetupToken: setup,
  });
  let second;
  try {
    await server.ready;
    await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'owner', 'owner-test-password', { ownerSetupToken: setup });
    await registerAccount(url, 'multi-tab-user', 'account-test-password');
    await page.goto(`${url}/app/`);
    await page.getByLabel('服务器用户名').fill('multi-tab-user');
    await page.getByLabel('服务器账号密码').fill('account-test-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '创建个人账本' }).click();
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });
    if (await page.getByRole('dialog').isVisible()) await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();

    second = await context.newPage();
    await second.goto(`${url}/app/`);
    await expect(second.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });
    if (await second.getByRole('dialog').isVisible()) await second.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();

    async function record(target, description, amount) {
      await target.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
      await target.getByRole('button', { name: /^\+ 记(支出|账)$/ }).click();
      await target.getByRole('textbox', { name: /^金额/ }).fill(amount);
      await target.getByLabel('描述').fill(description);
      await target.getByRole('button', { name: '保存', exact: true }).click();
      await expect(target.getByText(description, { exact: true })).toBeVisible();
    }
    await record(page, '第一页记账', '12.34');
    await expect(second.getByText('第一页记账', { exact: true })).toBeVisible({ timeout: 15_000 });
    await record(second, '第二页记账', '56.78');
    await expect(page.getByText('第二页记账', { exact: true })).toBeVisible({ timeout: 15_000 });
    await Promise.all([
      record(page, '同时记账甲', '8.10'),
      record(second, '同时记账乙', '9.20'),
    ]);
    await expect(page.getByText('同时记账乙', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(second.getByText('同时记账甲', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByText('第一页记账', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('第二页记账', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_500);
    let idleSyncRequests = 0;
    const countSync = (request) => {
      if (request.url().includes('/api/v3/commits?')) idleSyncRequests += 1;
    };
    page.on('request', countSync);
    await page.waitForTimeout(6_000);
    page.off('request', countSync);
    expect(idleSyncRequests).toBeLessThan(2);
    await page.close();
    await record(second, '关闭第一页后继续', '10.30');
    await second.reload();
    await expect(second.getByText('关闭第一页后继续', { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await second?.close().catch(() => undefined);
    await page.close().catch(() => undefined);
    server.server.closeAllConnections();
    await server.close();
  }
});
