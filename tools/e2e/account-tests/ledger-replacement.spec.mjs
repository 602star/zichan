import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('opens a new encrypted ledger with the same account after losing a private recovery code', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const setup = 'test-ledger-replacement-owner-000000000';
  const server = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', accountProtection: 'private', ownerSetupToken: setup });
  try {
    await server.ready;
    await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'owner', 'test-owner-password', { ownerSetupToken: setup });
    await registerAccount(url, 'ledger-user', 'test-account-password');
    await page.goto(`${url}/app/`);
    await page.getByLabel('服务器用户名').fill('ledger-user');
    await page.getByLabel('服务器账号密码', { exact: true }).fill('test-account-password');
    await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
    await page.getByRole('checkbox', { name: '我已把恢复码保存在此设备以外' }).check();
    await page.getByRole('button', { name: '创建私密账本', exact: true }).click();
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await page.reload();
    await page.getByText('恢复码遗失，重新开账本', { exact: true }).click();
    const code = await page.locator('details pre').innerText();
    await page.getByRole('checkbox', { name: '我已保存新账本恢复码' }).check();
    const confirm = page.getByRole('button', { name: '确认替换并创建新账本', exact: true });
    await expect(confirm).toBeDisabled();
    await page.getByLabel('替换旧账本确认文字').fill('替换旧账本');
    await page.screenshot({ path: testInfo.outputPath('replacement-confirmation.png'), fullPage: true });
    await Promise.all([
      page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
      confirm.click(),
    ]);
    await page.waitForLoadState('domcontentloaded');
    await page.getByLabel('账本恢复码', { exact: true }).fill(code);
    await page.getByRole('button', { name: '解锁账本', exact: true }).click();
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
  } finally {
    await page.close();
    const closing = server.close();
    server.server.closeAllConnections();
    await closing;
  }
});
