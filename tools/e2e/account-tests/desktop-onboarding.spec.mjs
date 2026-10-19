import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

test('desktop account ledger shows the same optional guide without opening a modal', async ({ page }) => {
  const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist');
  const server = createSyncServer({ webDir: root, enableWeb: true, registrationMode: 'open', ownerSetupToken: 'test-desktop-onboarding-owner-00000' });
  try {
    await server.ready;
    await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'owner', 'owner-test-password', { ownerSetupToken: 'test-desktop-onboarding-owner-00000' });
    await registerAccount(url, 'desktop-user', 'account-test-password');
    await page.goto(`${url}/app/`);
    await page.getByLabel('服务器用户名').fill('desktop-user');
    await page.getByLabel('服务器账号密码').fill('account-test-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '创建个人账本' }).click();
    await page.getByRole('button', { name: '添加常用账户' }).click();
    const guide = page.getByRole('region', { name: '首次记账引导' });
    await expect(guide).toBeVisible();
    await expect(guide.getByRole('button', { name: '添加账户' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.reload();
    await expect(guide).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(guide).toContainText('新手引导 · 1/4');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await guide.getByRole('button', { name: '添加账户' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  } finally {
    await page.close();
    const closing = server.close();
    server.server.closeAllConnections();
    await closing;
  }
});
