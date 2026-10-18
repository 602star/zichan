import { test, expect } from '@playwright/test';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

const lanAddress = Object.values(networkInterfaces()).flat()
  .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;

test('new account opens its ledger over plain LAN HTTP without a device password prompt', async ({ page }) => {
  test.skip(!lanAddress, 'No non-loopback IPv4 address is available');
  test.setTimeout(120_000);
  const ownerSetupToken = 'e2e-lan-http-owner-setup-00000000';
  const server = createSyncServer({
    enableWeb: true,
    webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'),
    registrationMode: 'open',
    ownerSetupToken,
    allowInsecureHttp: true,
  });
  try {
    await server.ready;
    await new Promise((done, reject) => {
      server.server.once('error', reject);
      server.server.listen(0, '0.0.0.0', done);
    });
    const base = `http://${lanAddress}:${server.server.address().port}`;
    await registerAccount(base, 'lan-owner', 'lan-owner-password', { ownerSetupToken });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/`);
    const cryptoCapabilities = await page.evaluate(() => ({
      secure: isSecureContext,
      randomUUID: typeof crypto.randomUUID,
      randomValues: typeof crypto.getRandomValues,
    }));
    expect(cryptoCapabilities).toEqual({ secure: false, randomUUID: 'undefined', randomValues: 'function' });

    await page.getByRole('button', { name: '注册新账号' }).click();
    await page.getByLabel('昵称').fill('手机新用户');
    await page.getByLabel('服务器用户名').fill('lan-mobile-user');
    await page.getByLabel('服务器账号密码').fill('lan-mobile-password');
    await page.getByLabel('确认账号密码').fill('lan-mobile-password');
    await page.getByRole('button', { name: '注册并登录' }).click();
    await page.getByRole('button', { name: '创建个人账本' }).click();
    await expect(page.getByRole('button', { name: '开始记账', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(page.getByRole('region', { name: '首次记账引导' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '新增 · 日常收支' })).toBeHidden();
    await page.reload();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await expect(page.getByText('数据库初始化失败')).toHaveCount(0);
    await expect(page.getByText('解锁本机账本')).toHaveCount(0);
  } finally {
    server.server.closeAllConnections();
    await server.close();
  }
});
