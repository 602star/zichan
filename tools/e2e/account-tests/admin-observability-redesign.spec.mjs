import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';
import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const review = resolve(root, 'apps/web/.impeccable/review/admin-observability');

test('uses real observability APIs, distinct log sources and the ledger theme at desktop and phone sizes', async ({ page }) => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'zichan-obs-redesign-'));
  const ownerSetupToken = 'test-observability-redesign-owner-000000';
  const loginSecret = 'observability-redesign-00001';
  const server = createSyncServer({ dataDir, webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken });
  mkdirSync(review, { recursive: true });
  try {
    await server.ready; await server.started; await listenOnSafePort(server.server, '127.0.0.1');
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'operator', loginSecret, { ownerSetupToken });
    const auth = await loginAccount(url, 'operator', loginSecret);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${url}/e2e-private-entry/admin/`);
    await page.getByLabel('管理账号用户名').fill('operator');
    await page.getByLabel('管理账号密码').fill(loginSecret);
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(page.getByRole('heading', { name: '运行概览', exact: true })).toBeVisible();
    await page.goto(`${url}/e2e-private-entry/admin/requests?range=1h`);
    await expect(page.getByRole('heading', { name: '请求分析', exact: true })).toBeVisible();
    await expect(page.getByText('5xx 错误率', { exact: true })).toBeVisible();
    await expect(page.getByText('P95 响应耗时', { exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(review, 'requests-empty-desktop.png'), fullPage: true });
    await page.request.get(`${url}/api/unknown-test-route`);
    await expect.poll(async () => {
      const response = await page.request.get(`${url}/api/admin/ops/requests/summary?range=1h`, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
      expect(response.status()).toBe(200);
      const result = await response.json();
      return result.data?.totalRequests ?? 0;
    }, { timeout: 60000, intervals: [3000] }).toBeGreaterThan(0);
    await page.getByRole('button', { name: '刷新请求', exact: true }).click();
    await expect(page.getByText('采样已更新', { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const styles = await page.locator('.zc-admin-root').evaluate((el) => ({ font: getComputedStyle(el).fontFamily, accent: getComputedStyle(el).getPropertyValue('--accent').trim() }));
    expect(styles.font).toContain('LXGW'); expect(styles.accent).toBe('#b63226');
    await page.screenshot({ path: resolve(review, 'requests-desktop.png'), fullPage: true });
    await page.goto(`${url}/e2e-private-entry/admin/traffic?range=24h`);
    await expect(page.getByText('近 5 分钟活跃', { exact: true })).toBeVisible();
    await expect(page.getByText('会话', { exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(review, 'traffic-desktop.png'), fullPage: true });
    await page.goto(`${url}/e2e-private-entry/admin/database`);
    await expect(page.getByText('日志模式', { exact: true })).toBeVisible();
    await expect(page.getByText('wal', { exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(review, 'database-desktop.png'), fullPage: true });
    await page.goto(`${url}/e2e-private-entry/admin/collectors`);
    await expect(page.getByText('待写入维度', { exact: true })).toBeVisible();
    await page.goto(`${url}/e2e-private-entry/admin/host`);
    await expect(page.getByText(/未采集。请在 Linux 宿主机/)).toBeVisible();
    await page.goto(`${url}/e2e-private-entry/admin/alerts`);
    await expect(page.getByText('通知投递', { exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(review, 'alerts-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ['requests', 'traffic', 'database', 'collectors', 'host', 'alerts']) {
      await page.goto(`${url}/e2e-private-entry/admin/${route}`);
      await expect(page.locator('.zc-admin-content')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: resolve(review, `${route}-mobile.png`), fullPage: true });
    }
    await page.getByRole('button', { name: '菜单', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '管理后台导航' }).getByRole('link', { name: '数据库', exact: true })).toBeVisible();
    await expect.poll(async () => Math.round((await page.getByRole('navigation', { name: '管理后台导航' }).boundingBox()).x)).toBe(0);
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('navigation', { name: '管理后台导航' }).getByRole('link', { name: '打开记账应用', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('navigation', { name: '管理后台导航' }).getByRole('link', { name: '运行概览', exact: true })).toBeFocused();
    await page.screenshot({ path: resolve(review, 'navigation-mobile.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('navigation', { name: '管理后台导航' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: '菜单', exact: true })).toBeFocused();
    await page.evaluate(() => { localStorage.setItem('zichan.appearance.v1', JSON.stringify({ theme: 'terracotta', mode: 'dark' })); window.dispatchEvent(new Event('storage')); });
    await expect(page.locator('.zc-admin-root')).toHaveAttribute('data-mode', 'dark');
    await page.screenshot({ path: resolve(review, 'dark-mobile.png'), fullPage: true });
  } finally { await closeTestSyncServer(server); rmSync(dataDir, { recursive: true, force: true }); }
});
