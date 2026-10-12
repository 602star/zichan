import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

test('a private ledger opens with the account password on a new browser', async ({ browser }) => {
  test.setTimeout(120_000);
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), 'zichan-private-password-'));
  const server = createSyncServer({ dataDir, webDir: resolve(root, 'apps/web/dist'), enableWeb: true,
    registrationMode: 'open', accountProtection: 'private', custodyEnabled: false,
    ownerSetupToken: 'test-private-password-owner-0000000' });
  const contexts = [];
  try {
    await server.ready;
    await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'owner', 'owner-test-password',
      { ownerSetupToken: 'test-private-password-owner-0000000' });
    await registerAccount(url, 'private-user', 'account-test-password');
    const login = async () => {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(`${url}/app/`);
      await page.getByLabel('服务器用户名').fill('private-user');
      await page.getByLabel('服务器账号密码').fill('account-test-password');
      await page.getByRole('button', { name: '登录已有账号' }).click();
      return page;
    };
    const first = await login();
    await first.getByRole('button', { name: '创建个人账本' }).click();
    await expect(first.getByRole('heading', { name: '创建私密账本' })).toBeVisible();
    await first.getByLabel('我已把恢复码保存在此设备以外').check();
    await first.getByRole('button', { name: '创建私密账本' }).click();
    const start = first.getByRole('button', { name: '开始记账', exact: true });
    await expect(start).toBeVisible({ timeout: 20_000 });
    await start.click();
    await expect(first.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });

    const second = await login();
    await expect(second.getByRole('heading', { name: '解锁私密账本' })).toHaveCount(0, { timeout: 30_000 });
    await expect(second.getByLabel('账本恢复码')).toHaveCount(0);
    await expect(second.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    const closing = server.close();
    server.server.closeAllConnections();
    await closing;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
