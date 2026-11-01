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

    await page.goto(`${url}/e2e-private-entry/admin/logs`);
    await expect(page.getByRole('heading', { name: '运行日志' })).toBeVisible();
    await page.getByRole('textbox', { name: '关键词' }).fill('register_success');
    await page.getByRole('button', { name: '查询日志' }).click();
    await expect(page).toHaveURL(/search=register_success/);
    await expect(page.getByText('来源：同步服务器 SQLite')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('logs-desktop.png'), fullPage: true });

    await page.getByRole('navigation', { name: '日志与审计视图' }).getByRole('link', { name: /管理审计/ }).click();
    await expect(page.getByRole('heading', { name: '管理审计' })).toBeVisible();
    await expect(page.getByText(/失败尝试在页底单独列出/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('audit-desktop.png'), fullPage: true });
    await page.getByRole('navigation', { name: '日志与审计视图' }).getByRole('link', { name: /登录安全/ }).click();
    await expect(page.getByRole('heading', { name: '登录安全' })).toBeVisible();

    await page.goto(`${url}/e2e-private-entry/admin/monitor`);
    await expect(page.getByRole('heading', { name: '监控中心' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '请求与异常' })).toBeVisible();
    await page.getByRole('button', { name: '查看告警记录' }).click();
    await expect(page.getByRole('heading', { name: '告警历史' })).toBeVisible();
    await page.getByRole('button', { name: '测试通知' }).click();
    await expect(page.getByText('没有启用的通知渠道')).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: '监控中心' })).toBeVisible();
    await page.getByRole('navigation', { name: '运维监测视图' }).getByRole('button', { name: /访问统计/ }).click();
    await expect(page.getByRole('heading', { name: '访问统计' })).toBeVisible();
    await expect(page.getByText('PV · 页面访问')).toBeVisible();
    await expect(page.getByText('UV · 去重浏览器')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('traffic-desktop.png'), fullPage: true });
    await page.getByRole('navigation', { name: '运维监测视图' }).getByRole('button', { name: /指标总表/ }).click();
    await expect(page.getByRole('heading', { name: '指标总表' })).toBeVisible();
    await page.getByRole('textbox', { name: '搜索指标' }).fill('HTTP');
    await expect(page.getByText('HTTP 请求量', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('metrics-desktop.png'), fullPage: true });
    await page.getByRole('navigation', { name: '运维监测视图' }).getByRole('button', { name: /资源状态/ }).click();
    await expect(page.getByRole('heading', { name: '资源状态' })).toBeVisible();
    await expect(page.getByText(/运行方式：/)).toBeVisible();
    await expect(page.getByRole('heading', { name: '请求与异常' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('resources-desktop.png'), fullPage: true });
    await page.getByRole('navigation', { name: '运维监测视图' }).getByRole('button', { name: /服务占用/ }).click();
    await expect(page.getByRole('heading', { name: '服务占用' })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${url}/e2e-private-entry/admin/monitor?view=resources&range=1h`);
    await expect(page.getByRole('heading', { name: '资源状态' })).toBeVisible();
    await expect(page.getByText(/运行方式：/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('resources-mobile.png'), fullPage: true });
  } finally {
    await closeTestSyncServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
