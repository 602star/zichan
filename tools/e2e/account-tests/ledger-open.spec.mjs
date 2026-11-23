import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';

test('cold snapshot and warm cache allow immediate writes while background services are unavailable', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const server = createSyncServer({ enableWeb: true,
    webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'),
    registrationMode: 'open', ownerSetupToken: 'ledger-open-owner-setup-token-000000' });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const fresh = await browser.newContext({ serviceWorkers: 'block' });
  context.setDefaultTimeout(10_000); fresh.setDefaultTimeout(10_000);
  try {
    await server.ready; await listenOnSafePort(server.server, '127.0.0.1');
    const base = `http://127.0.0.1:${server.server.address().port}`;
    await fresh.addCookies([
      { name: 'zichan_session', value: 'obsolete-root', domain: '127.0.0.1', path: '/' },
      { name: 'zichan_session', value: 'obsolete-auth', domain: '127.0.0.1', path: '/api/auth' },
    ]);
    await registerAccount(base, 'open-owner', 'open-test-password', { ownerSetupToken: 'ledger-open-owner-setup-token-000000' });
    const login = async page => {
      await page.goto(`${base}/`);
      try { await page.getByLabel('服务器用户名').fill('open-owner'); }
      catch (error) { throw new Error(`${error.message}\n${await page.locator('body').textContent()}`); }
      await page.getByLabel('服务器账号密码').fill('open-test-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
    };
    const write = async (page, note) => {
      if (!await page.getByRole('textbox', { name: /^金额/ }).isVisible()) {
        await page.locator('.zc-sidebar').getByRole('button', { name: '快速记账', exact: true }).click();
      }
      await page.getByRole('textbox', { name: /^金额/ }).fill('17.25');
      await page.getByLabel('描述', { exact: true }).fill(note);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText(note, { exact: true }).first()).toBeVisible();
    };
    const author = await context.newPage();
    await login(author);
    await author.getByRole('button', { name: '开始记账', exact: true }).click();
    await write(author, '首个设备记录');
    await expect.poll(() => author.evaluate(() => {
      const report = JSON.parse(sessionStorage.getItem('zichan.startup-timing.v1') || '{}');
      return report.stages?.some(s => s.name === 'background.syncCaughtUp') ?? false;
    })).toBe(true);
    // Wait for the write-triggered sync, then prepare the server snapshot explicitly.
    await expect.poll(async () => {
      await server.flushOpenSnapshots();
      return author.evaluate(async () => {
        const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin',
          headers: { 'X-Zichan-Session': 'cookie', 'Content-Type': 'application/json' }, body: '{}' });
        const session = await response.json();
        const snapshot = await fetch('/api/v4/ledger-open-snapshot', { headers: { Authorization: `Bearer ${session.accessToken}` } });
        return snapshot.status;
      });
    }).toBe(200);

    const page = await fresh.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let snapshots = 0;
    page.on('response', response => { if (response.url().endsWith('/api/v4/ledger-open-snapshot') && response.status() === 200) snapshots++; });
    await login(page);
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    expect(snapshots).toBeGreaterThan(0);
    await expect(page.getByText('首个设备记录', { exact: true }).first()).toBeVisible();
    await write(page, '快照打开后立即记账');
    const cold = await page.evaluate(() => JSON.parse(sessionStorage.getItem('zichan.startup-timing.v1')));
    expect(cold.stages.some(s => s.name === 'local.installSnapshot')).toBe(true);
    await expect.poll(() => page.evaluate(async () => {
      const names = (await indexedDB.databases()).map(db => db.name).filter(name => name?.endsWith(':trusted-device'));
      for (const name of names) {
        const found = await new Promise(resolve => {
          const open = indexedDB.open(name); open.onsuccess = () => {
            const db = open.result; const tx = db.transaction('vault');
            const get = tx.objectStore('vault').get('access');
            tx.oncomplete = () => { db.close(); resolve(!!get.result); };
          };
        });
        if (found) return true;
      }
      return false;
    })).toBe(true);

    await page.route('**/api/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"isolated outage"}' }));
    await page.reload();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await write(page, '后台不可用仍可记账');
    const warm = await page.evaluate(() => JSON.parse(sessionStorage.getItem('zichan.startup-timing.v1')));
    expect(warm.stages.some(s => s.name === 'local.cacheOpen')).toBe(true);
    expect(warm.stages.some(s => s.name === 'account.sessionRestore')).toBe(false);
    await page.unroute('**/api/**');
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await expect.poll(() => page.evaluate(() => {
      const report = JSON.parse(sessionStorage.getItem('zichan.startup-timing.v1') || '{}');
      return report.stages?.some(s => s.name === 'background.syncCaughtUp') ?? false;
    })).toBe(true);
    await author.reload();
    await expect(author.getByText('后台不可用仍可记账', { exact: true }).first()).toBeVisible();
    const measured = testInfo.outputPath('measured-open-timings.json');
    writeFileSync(measured, JSON.stringify({ cold, warm }, null, 2));
    await testInfo.attach('measured-open-timings', { path: measured, contentType: 'application/json' });

    const admin = await context.newPage();
    await admin.goto(`${base}/e2e-private-entry/admin/`);
    await admin.getByLabel('管理账号用户名').fill('open-owner');
    await admin.getByLabel('管理账号密码').fill('open-test-password');
    await admin.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await admin.getByRole('link', { name: '打开性能', exact: true }).click();
    await expect(admin.getByRole('heading', { name: '打开性能', exact: true })).toBeVisible();
    await expect(admin.getByRole('cell', { name: '新设备首次恢复总耗时', exact: true })).toBeVisible();
    await expect(admin.getByRole('cell', { name: '本机授权快速打开总耗时', exact: true })).toBeVisible();
    await admin.screenshot({ path: testInfo.outputPath('startup-desktop.png'), fullPage: true });
    await admin.setViewportSize({ width: 390, height: 844 });
    await expect(admin.getByRole('navigation', { name: '管理后台导航', exact: true })).toBeHidden();
    await admin.screenshot({ path: testInfo.outputPath('startup-mobile.png'), fullPage: true });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-Zichan-Session': 'cookie' } }));
    await page.reload();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await expect(page.getByText('登录已失效，同步已暂停。本机账本仍可记账，记录将在重新登录后同步。')).toBeVisible();
    await write(page, '登录失效仍可本机记账');
    await page.getByRole('button', { name: '重新登录', exact: true }).click();
    await expect(page.getByLabel('服务器用户名')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await context.close(); await fresh.close(); await closeTestSyncServer(server); }
});
