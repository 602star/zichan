import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'observability-workspace-0001';
const ownerSetupToken = 'test-observability-owner-secret-000000';

test('investigates logs and monitoring with readable views on desktop and mobile', async ({ page }, testInfo) => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'zichan-observability-'));
  const server = createSyncServer({ dataDir, webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken });
  try {
    await server.ready;
    await server.started;
    await listenOnSafePort(server.server, '127.0.0.1');
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'operator', password, { ownerSetupToken });
    await page.goto(`${url}/e2e-private-entry/admin/`);
    await page.getByLabel('管理账号用户名').fill('operator');
    await page.getByLabel('管理账号密码').fill(password);
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();

    // Legacy links converge on the sole owning page, retaining the selected range.
    for (const [legacy, canonical, heading] of [
      ['monitor?view=traffic&range=1h', 'traffic\\?range=1h', '访问分析'],
      ['monitor?view=overview&range=7d', 'requests\\?range=7d', '请求分析'],
      ['resources', 'database', '数据库'],
    ]) {
      await page.goto(`${url}/e2e-private-entry/admin/${legacy}`);
      await expect(page).toHaveURL(new RegExp(`/admin/${canonical}`));
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    await page.goto(`${url}/e2e-private-entry/admin/monitor?view=metrics`);
    await expect(page.getByRole('heading', { name: '运行监控', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '搜索指标' }).fill('HTTP');
    await expect(page.getByText('HTTP 请求量', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('metrics-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${url}/e2e-private-entry/admin/monitor?view=resources&range=1h`);
    await expect(page).toHaveURL(/view=system/);
    await expect(page.getByRole('img', { name: '系统内存趋势', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('resources-mobile.png'), fullPage: true });
  } finally {
    await closeTestSyncServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
