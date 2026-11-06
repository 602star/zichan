import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

test('opens backup, sync, recovery and security as settings tabs', async ({ page }) => {
  test.setTimeout(30_000);
  page.setDefaultTimeout(10_000);
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const server = createSyncServer({
    webDir: resolve(root, 'apps/web/dist'),
    enableWeb: true,
    registrationMode: 'open',
    ownerSetupToken: 'test-data-protection-owner-0000000',
  });
  try {
    await server.ready;
    await listenOnSafePort(server.server, '127.0.0.1');
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'owner', 'owner-test-password', { ownerSetupToken: 'test-data-protection-owner-0000000' });
    await registerAccount(url, 'protection-user', 'account-test-password');
    await page.goto(`${url}/`);
    await page.getByLabel('服务器用户名').fill('protection-user');
    await page.getByLabel('服务器账号密码').fill('account-test-password');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible({ timeout: 20_000 });

    await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
    await expect(page.getByRole('tab', { name: '记账' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.zc-sidebar').getByRole('button', { name: /数据保护$/ })).toHaveCount(0);
    await page.locator('.zc-sidebar').getByRole('button', { name: /我的账号$/ }).click();
    await page.getByRole('button', { name: '查看服务器上的账本' }).click();
    await expect(page.locator('.zc-header-title')).toContainText('设置');
    await expect(page.getByRole('tab', { name: '服务器与同步' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: '服务器', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '服务器', exact: true })).not.toContainText('刷新服务器备份');
    await expect(page.getByRole('region', { name: '当前设备' })).toHaveCount(0);
    await page.getByRole('tab', { name: '解锁与安全' }).click();
    await expect(page.getByRole('region', { name: '解锁与安全' })).toBeVisible();

    await page.getByRole('tab', { name: '本机备份' }).click();
    await expect(page.getByRole('region', { name: '当前设备' })).toContainText('本机备份');
    await page.getByRole('button', { name: '创建手动备份' }).click();
    await expect(page.getByRole('region', { name: '当前设备' })).toContainText('手动');
    await page.getByRole('tab', { name: '恢复数据' }).click();
    await page.getByText('管理服务器备份', { exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新服务器备份' })).toBeVisible();
    await page.getByRole('button', { name: '选择恢复点' }).click();
    const restore = page.getByRole('dialog', { name: '恢复数据' });
    await expect(restore.getByLabel('备份来源')).toHaveValue(/^local:/);
    await expect(restore.getByRole('radiogroup', { name: '恢复方式' })).toContainText('精确恢复');
    await restore.getByRole('radio', { name: /合并导入/ }).check();
    await expect(restore.getByRole('radio', { name: /合并导入/ })).toBeChecked();
    await restore.getByRole('button', { name: '取消' }).click();
  } finally {
    await page.close();
    await closeTestSyncServer(server);
  }
});
