import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { expireQuickAuthorization } from './offline-access-fixture.mjs';

for (const basePath of ['', '/ledger']) for (const passwordRequired of [false, true]) {
  test(`stopped server preserves writes and cold startup at ${basePath || '/'} with ${passwordRequired ? 'password' : 'quick authorization'}`, async ({ page, context }, testInfo) => {
    const setup = 'offline-stop-owner-setup-0000000000';
    const password = 'offline-stop-test-password';
    const server = createSyncServer({ enableWeb: true,
      webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'),
      basePath, registrationMode: 'open', ownerSetupToken: setup });
    let stopped = false;
    const errors = [];
    const observe = current => current.on('pageerror', error => errors.push(error.message));
    const write = async note => {
      if (!await page.getByRole('textbox', { name: /^金额/ }).isVisible()) {
        await page.locator('.zc-sidebar').getByRole('button', { name: '快速记账', exact: true }).click();
      }
      await page.getByRole('textbox', { name: /^金额/ }).fill('17.25');
      await page.getByLabel('描述', { exact: true }).fill(note);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText(note, { exact: true }).first()).toBeVisible();
    };
    try {
      await server.ready;
      await listenOnSafePort(server.server);
      const url = `http://127.0.0.1:${server.server.address().port}${basePath}/`;
      await registerAccount(url.replace(/\/$/, ''), 'offline-owner', password, { ownerSetupToken: setup });
      observe(page);
      await page.goto(url);
      await page.getByLabel('服务器用户名').fill('offline-owner');
      await page.getByLabel('服务器账号密码').fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.getByRole('button', { name: '开始记账', exact: true }).click();
      await expect(page.locator('.zc-app-shell')).toBeVisible();
      await write('停服前的记录');
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      // Wait for quick authorization preparation; expire it only in password cases.
      if (passwordRequired) await expireQuickAuthorization(page);
      else {
        await expect.poll(() => page.evaluate(async () => {
          for (const { name } of await indexedDB.databases()) {
            if (!name?.endsWith(':trusted-device')) continue;
            const available = await new Promise((done, fail) => {
              const open = indexedDB.open(name);
              open.onerror = () => fail(open.error);
              open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction('vault');
                const get = tx.objectStore('vault').get('access');
                tx.oncomplete = () => { db.close(); done(get.result?.expiresAt > Date.now()); };
                tx.onabort = () => { db.close(); fail(tx.error); };
              };
            });
            if (available) return true;
          }
          return false;
        })).toBe(true);
      }
      await closeTestSyncServer(server);
      stopped = true;
      await expect(fetch(`${url}api/health`)).rejects.toThrow();
      // Leave the browser online: the app must handle actual connection refusal.
      expect(await page.evaluate(() => navigator.onLine)).toBe(true);
      await write('停服后继续保存');
      // These bundles have not been opened before the server stopped.
      for (const label of ['物品资产', '设置', '流水']) {
        await page.locator('.zc-sidebar').getByRole('button', { name: new RegExp(`${label}$`) }).click();
        await expect(page.locator('.zc-app-shell')).toBeVisible();
        await expect(page.getByText('正在加载…', { exact: true })).toHaveCount(0);
      }
      await page.close();
      page = await context.newPage();
      observe(page);
      await page.goto(url);
      if (passwordRequired) {
        await page.getByRole('button', { name: '离线解锁 offline-owner 的缓存' }).click();
        await page.getByLabel('账号密码', { exact: true }).fill(password);
        await page.getByRole('button', { name: '解锁缓存', exact: true }).click();
      }
      await expect(page.locator('.zc-app-shell')).toBeVisible();
      await page.locator('.zc-sidebar').getByRole('button', { name: /流水$/ }).click();
      await expect(page.getByText('停服前的记录', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('停服后继续保存', { exact: true }).first()).toBeVisible();
      await write('停服重开后仍能保存');
      await page.reload();
      if (passwordRequired) {
        await page.getByRole('button', { name: '离线解锁 offline-owner 的缓存' }).click();
        await page.getByLabel('账号密码', { exact: true }).fill(password);
        await page.getByRole('button', { name: '解锁缓存', exact: true }).click();
      }
      await expect(page.getByText('停服重开后仍能保存', { exact: true }).first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('server-stopped-ledger.png'), fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      if (!stopped) await closeTestSyncServer(server);
    }
  });
}
