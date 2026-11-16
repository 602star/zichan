import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { SyncServerStore } from '../../../apps/sync-server/dist/store.js';
import { logRequestContext } from '../../../apps/sync-server/dist/log-context.js';
import { registerAccount, loginAccount } from '../../../packages/db/dist/index.js';
import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const review = resolve(root, 'apps/web/.impeccable/review/log-workspace');
const routes = { system: 'logs', access: 'access-logs', login: 'security-events', operations: 'audit', tasks: 'task-logs', containers: 'container-logs' };
const titles = { system: '系统日志', access: '访问日志', login: '登录日志', operations: '操作日志', tasks: '任务日志', containers: '容器日志' };

test('all six log modes expose real category fields, scoped export, details and one navigation entry', async ({ page }) => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'zichan-log-workspace-'));
  const ownerSetupToken = 'test-log-workspace-owner-00000000';
  const loginSecret = 'log-workspace-login-00001';
  const server = createSyncServer({ dataDir, webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken });
  let store;
  mkdirSync(review, { recursive: true });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  try {
    await server.ready; await server.started; await listenOnSafePort(server.server, '127.0.0.1');
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'operator', loginSecret, { ownerSetupToken });
    const auth = await loginAccount(url, 'operator', loginSecret);
    store = new SyncServerStore(resolve(dataDir, 'server.sqlite'), 'open', server.serverId);
    await store.ready;
    const user = await store.getUser('operator');
    const now = new Date().toISOString();
    // Synthetic fixture records are written through the real stores; the UI is never mocked.
    await logRequestContext.run({ requestId: 'req-workspace-test', ip: '192.0.2.42', userAgent: 'Workspace Test Browser', method: 'POST', instanceId: 'test-instance', role: 'owner', authMethod: 'totp' }, async () => {
      await store.appendLog({ id: 'fixture-system', at: now, level: 'error', action: 'fixture_test', message: '合成验收记录：请求处理失败', detail: { component: 'fixture-component', requestId: 'req-workspace-test', stack: 'Error: synthetic failure', nested: { token: 'NEVER_EXPOSE_THIS_TOKEN' } } });
      await store.appendLog({ id: 'fixture-login', at: now, level: 'warn', action: 'login_failed', message: '合成认证失败', username: 'operator', ip: '192.0.2.42', detail: { deviceName: '验收设备', reason: 'invalid_proof' } });
      await store.logWorkspace.recordReadAudit(user.accountId, 'fixture-action', { enabled: true });
      await store.recordAdminFailure({ actorAccountId: user.accountId, action: 'fixture-action', code: 'EXPECTED_FAILURE', message: '合成失败尝试', requestId: 'req-workspace-test' });
      const first = await store.createJob({ type: 'database.integrity-check', createdBy: 'operator' });
      await store.finishJob(first.jobId, { status: 'failed', errorCode: 'EXPECTED_FAILURE', errorMessage: '合成任务失败' });
      const retry = await store.createJob({ type: first.type, createdBy: 'operator', retryOf: first.jobId });
      await store.finishJob(retry.jobId, { status: 'cancelled' });
      await store.appendJobEvent(first.jobId, 'error', '合成执行事件', { step: 'validation' });
    });
    await store.observability.insertEvents([{ id: 'fixture-access', at: now, method: 'POST', route: '/api/fixture/:id', status: 503, durationMs: 1400, ip: '192.0.2.42', requestId: 'req-workspace-test', instanceId: 'test-instance', userAgent: 'Workspace Test Browser', origin: 'https://example.test', ttfbMs: 100 }]);
    writeFileSync(resolve(dataDir, 'container-logs.json'), JSON.stringify({ sampledAt: now, containers: ['test-app'], entries: [{ id: 'fixture-container', at: now, container: 'test-app', stream: 'stderr', message: '合成容器日志 output=validation' }], errors: [] }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${url}/e2e-private-entry/admin/`);
    await page.getByLabel('管理账号用户名').fill('operator'); await page.getByLabel('管理账号密码').fill(loginSecret);
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: '管理后台导航' });
    await expect(nav.getByRole('link', { name: '日志管理', exact: true })).toHaveCount(1);
    await expect(nav.getByRole('link', { name: '登录日志', exact: true })).toHaveCount(0);
    for (const [kind, route] of Object.entries(routes)) {
      await page.goto(`${url}/e2e-private-entry/admin/${route}`);
      await expect(page.getByRole('heading', { name: titles[kind], exact: true })).toBeVisible();
      await expect(page.locator('.zc-admin-log-table tbody tr').first()).toBeVisible();
      await expect(page.getByRole('button', { name: '查看详情', exact: true }).first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: resolve(review, `${kind}-desktop.png`), fullPage: true });
    }
    await page.goto(`${url}/e2e-private-entry/admin/logs?component=fixture-component`);
    await expect(page.getByText('合成验收记录：请求处理失败', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '查看详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '系统日志详情' });
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: '关闭详情' })).toBeFocused();
    await expect(dialog.getByText('Error: synthetic failure', { exact: true })).toBeVisible();
    expect(await page.content()).not.toContain('NEVER_EXPOSE_THIS_TOKEN');
    await page.screenshot({ path: resolve(review, 'system-detail-desktop.png'), fullPage: false });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '查看详情', exact: true })).toBeFocused();
    await page.goto(`${url}/e2e-private-entry/admin/access-logs?method=POST&status=503&minDuration=1000`);
    await expect(page.getByText('/api/fixture/:id', { exact: true })).toBeVisible();
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('access-logs.csv');
    await expect(page.getByText(/已导出 访问日志 CSV/)).toBeVisible();
    const exported = await page.request.get(`${url}/api/admin/log-workspace/access/export?format=json&method=POST&status=503`, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    const payload = await exported.json(); expect(payload.rows).toHaveLength(1); expect(payload.fields).toContain('userAgent'); expect(payload.fields).not.toContain('device');
    await page.goto(`${url}/e2e-private-entry/admin/audit?action=fixture-action&result=failure`);
    await expect(page.locator('.zc-admin-log-table').getByText('失败尝试', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '查看详情', exact: true }).click();
    await expect(page.getByRole('dialog').getByText('EXPECTED_FAILURE', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto(`${url}/e2e-private-entry/admin/task-logs`);
    await expect(page.getByRole('columnheader', { name: '尝试次数', exact: true })).toBeVisible();
    await page.goto(`${url}/e2e-private-entry/admin/monitor?view=traffic&range=1h`);
    await expect(page).toHaveURL(/\/traffic\?range=1h/);
    await page.goto(`${url}/e2e-private-entry/admin/resources`);
    await expect(page).toHaveURL(/\/database/);
    await expect(page.getByText('数据库状态', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [kind, route] of Object.entries(routes)) {
      await page.goto(`${url}/e2e-private-entry/admin/${route}`);
      await expect(page.getByRole('button', { name: '查看详情', exact: true }).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const active = page.getByRole('navigation', { name: '日志与审计视图' }).locator('[aria-current=page]');
      await expect(active).toBeInViewport();
      await expect(page.locator('.zc-admin-log-provenance')).toBeInViewport();
      expect((await page.locator('.zc-admin-log-table tbody tr').first().boundingBox()).y).toBeLessThan(844);
      await page.screenshot({ path: resolve(review, `${kind}-mobile.png`), fullPage: true });
    }
    await page.getByRole('button', { name: '查看详情', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: '容器日志详情' })).toBeVisible();
    await page.screenshot({ path: resolve(review, 'container-detail-mobile.png'), fullPage: false });
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => { localStorage.setItem('zichan.appearance.v1', JSON.stringify({ theme: 'terracotta', mode: 'dark' })); window.dispatchEvent(new Event('storage')); });
    await expect(page.locator('.zc-admin-root')).toHaveAttribute('data-mode', 'dark');
    await page.screenshot({ path: resolve(review, 'containers-dark-mobile.png'), fullPage: false });
    expect(errors).toEqual([]);
  } finally { await store?.close(); await closeTestSyncServer(server); rmSync(dataDir, { recursive: true, force: true }); }
});
