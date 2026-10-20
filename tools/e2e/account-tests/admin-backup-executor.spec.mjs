import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { writeExecutorState } from '../../../apps/sync-server/dist/backup-executor-state.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { clickAdminLink } from '../admin-navigation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
for (const width of [1280, 390]) {
  test(`shows real executor evidence and stale heartbeat at ${width}px`, async ({ page }, testInfo) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zichan-executor-ui-'));
    const server = createSyncServer({ dataDir, webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken: 'executor-ui-setup-token-000000000' });
    try {
      await server.ready; await server.started;
      await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
      const url = `http://127.0.0.1:${server.server.address().port}`;
      await registerAccount(url, 'operator', 'executor-ui-password-0000000', { ownerSetupToken: 'executor-ui-setup-token-000000000' });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url + '/e2e-private-entry/admin/');
      await page.getByLabel('管理账号用户名').fill('operator');
      await page.getByLabel('管理账号密码').fill('executor-ui-password-0000000');
      await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
      await clickAdminLink(page, '存储与备份');
      const panel = page.locator('#section-备份执行状态');
      await expect(panel).toContainText('运行状态未知');
      const state = { executorId: 'fixture-executor', heartbeatAt: new Date().toISOString(), timezone: 'Asia/Shanghai', status: 'waiting',
        nextRunAt: new Date(Date.now() + 86_400_000).toISOString(), lastResult: 'completed', lastFinishedAt: new Date().toISOString() };
      writeExecutorState(dataDir, state);
      await page.reload();
      await expect(panel).toContainText('在线 · 等待执行');
      await expect(panel).toContainText('备份与校验完成');
      await expect(panel).toContainText('Asia/Shanghai');
      await expect(panel).toContainText('fixture-executor');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`executor-${width}.png`), fullPage: true });
      writeExecutorState(dataDir, { ...state, heartbeatAt: new Date(Date.now() - 60_000).toISOString() });
      await page.reload();
      await expect(panel).toContainText('心跳已失联');
      await expect(panel).toContainText('暂无计划时间');
      writeExecutorState(dataDir, { ...state, heartbeatAt: new Date().toISOString(), status: 'error', lastResult: 'failed', error: 'disk full' });
      await page.reload();
      await expect(panel).toContainText('执行异常'); await expect(panel).toContainText('disk full');
    } finally {
      await page.close(); server.server.closeAllConnections(); await server.close();
      if (!resolve(dataDir).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/') + 'zichan-executor-ui-')) throw new Error('unsafe temporary path');
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
