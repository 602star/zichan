import { test, expect } from '@playwright/test';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

test('offline release update waits for all pages and preserves the account ledger under a deployment prefix', async ({ page, context }) => {
  const temporary = mkdtempSync(join(tmpdir(), 'zichan-update-'));
  const webDir = join(temporary, 'web');
  cpSync(resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'), webDir, { recursive: true });
  const setup = 'test-update-owner-00000000000000000';
  const server = createSyncServer({ webDir, enableWeb: true, basePath: '/ledger', registrationMode: 'open', ownerSetupToken: setup });
  try {
    await server.ready;
    await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.server.address().port}/ledger`;
    await registerAccount(url, 'owner', 'owner-test-password', { ownerSetupToken: setup });
    await registerAccount(url, 'update-user', 'account-test-password');
    await page.goto(`${url}/app/`);
    await page.getByLabel('服务器用户名').fill('update-user');
    await page.getByLabel('服务器账号密码').fill('account-test-password');
    await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).click();
    await page.getByRole('button', { name: '关闭快速记账' }).click();
    await page.getByRole('button', { name: '+ 记支出' }).click();
    await page.getByRole('textbox', { name: /^金额/ }).fill('36');
    await page.getByLabel('描述').fill('更新保留记录');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog', { name: '新增 · 日常支出' }).waitFor({ state: 'hidden' });
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    const binding = await page.evaluate(() => JSON.parse(localStorage.getItem('zichan.web-account.v2.binding')));
    const previousTitle = await page.title();
    const second = await context.newPage();
    await second.goto(`${url}/app/`);
    await expect(second.getByLabel('数据库初始化错误详情')).toContainText('账本已在另一个标签页打开');
    const workerFile = join(webDir, 'sw.js');
    writeFileSync(workerFile, readFileSync(workerFile, 'utf8').replace(/const cacheName = .*;/, 'const cacheName = `${prefix}acceptance-update`;'));
    const htmlFile = join(webDir, 'index.html');
    writeFileSync(htmlFile, readFileSync(htmlFile, 'utf8').replace(/<title>.*?<\/title>/, '<title>Lifecycle updated release</title>'));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
    await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting)).toBe(true);
    await expect(page.getByRole('status').filter({ hasText: '应用更新已准备好' })).toBeVisible();
    await page.reload();
    expect(await page.title()).toBe(previousTitle);
    await page.close();
    await expect.poll(() => second.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting)).toBe(true);
    await second.close();
    page = await context.newPage();
    // Observe activation outside the app scope so a new controlled page cannot
    // keep the previous worker alive while its last clients are being released.
    await page.goto(`${url}/api/health`);
    await expect.poll(() => page.evaluate(async (scope) => {
      const registration = await navigator.serviceWorker.getRegistration(scope);
      return !registration?.waiting && registration?.active?.state === 'activated';
    }, `${url}/app/`)).toBe(true);
    await page.goto(`${url}/app/`);
    await expect(page).toHaveTitle('Lifecycle updated release');
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('zichan.web-account.v2.binding')))).accountId).toBe(binding.accountId);
    await expect(page.getByText('更新保留记录', { exact: true })).toBeVisible();
    const keys = await page.evaluate(() => caches.keys());
    expect(keys.filter((key) => key.startsWith('zichan-shell:/ledger/app/:'))).toEqual(['zichan-shell:/ledger/app/:acceptance-update']);
  } finally { await context.close(); const closing = server.close(); server.server.closeAllConnections(); await closing; rmSync(temporary, { recursive: true, force: true }); }
});
