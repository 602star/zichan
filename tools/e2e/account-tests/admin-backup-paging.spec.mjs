/**
 * Backup record paging in a real browser.
 *
 * The unit tests pin the query and the summary; this pins what an operator actually sees: a fixed
 * 50-record window used to hide older history, and "latest successful backup" was read off that
 * same window, so a run of failures could hide the last good backup and make the page claim there
 * was none. Here the failure run is longer than one page.
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { SyncServerStore } from '../../../apps/sync-server/dist/store.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = ['backup', 'paging', 'e2e', '0001'].join('-');
const setupToken = 'test-backup-paging-owner-secret-000000';

/** 60 failures, then one old success: the success cannot be on the first page. */
const FAILURE_COUNT = 60;

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'zichan-backup-paging-'));
  const server = createSyncServer({
    dataDir,
    webDir: resolve(root, 'apps/web/dist'),
    enableWeb: true,
    registrationMode: 'open',
    ownerSetupToken: setupToken,
  });
  await server.ready;
  await server.started;
  await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.server.address().port}`;
  try {
    await registerAccount(url, 'operator', password, { ownerSetupToken: setupToken });
    await registerAccount(url, 'otheruser', password);
    // A second connection to the same database: the server does not expose its store, and these
    // rows stand in for what the deployment-side maintenance program would have recorded.
    const store = new SyncServerStore(join(dataDir, 'server.sqlite'), 'open', server.serverId);
    try {
      for (let index = 0; index < FAILURE_COUNT; index += 1) {
        await store.upsertBackupRecord({
          recordId: `backup-failed-${String(index).padStart(3, '0')}`,
          kind: 'scheduled',
          status: 'failed',
          createdAt: new Date(Date.now() - index * 60_000).toISOString(),
          errorMessage: 'disk full',
        });
      }
      await store.upsertBackupRecord({
        recordId: 'backup-good-oldest',
        kind: 'scheduled',
        status: 'completed',
        createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        verifiedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        verification: { ok: true },
      });
    } finally { await store.close(); }
  } catch (error) {
    server.server.closeAllConnections(); await server.close();
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
  const owner = await loginAccount(url, 'operator', password);
  return {
    url, owner,
    close: async () => {
      server.server.closeAllConnections();
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function signIn(page, url) {
  await page.goto(`${url}/admin/`);
  await page.getByLabel('管理账号用户名').fill('operator');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
}

test('pages past a fixed window and keeps the last success visible', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    await page.getByRole('link', { name: '存储与备份' }).click();
    await expect(page.getByRole('heading', { name: '存储与备份' })).toBeVisible();

    // The count is of the whole filtered set, not of the page: 60 failures + 1 success.
    await expect(page.getByText(`共 ${FAILURE_COUNT + 1} 条记录`)).toBeVisible();
    // The backup table is the one inside the「备份记录」panel; scoping to it keeps the summary
    // stats, which also contain record ids, out of the assertions. (`columnheader` is not usable
    // here: the accessibility tree exposes these headers as plain cells.)
    const table = page.locator('section').filter({ has: page.getByText('备份记录', { exact: true }) }).locator('table');
    await expect(table.getByText('backup-failed-000')).toBeVisible();

    // The old success is not on this page, yet the summary still reports it. Before the fix this
    // said "暂无数据" because it was derived from the page.
    await expect(table.getByText('backup-good-oldest')).toHaveCount(0);
    await expect(page.getByText('最近成功备份').locator('..')).toContainText('backup-good-oldest');

    // Paging continues instead of stopping at a fixed 50: page two shows the next batch, and the
    // first page's rows are gone.
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.getByText('第 2 页')).toBeVisible();
    await expect(table.getByText('backup-failed-000')).toHaveCount(0);

    // Filtering narrows the list but must not change the summary: "is there a good backup" is a
    // question about the whole set.
    await page.getByLabel('状态').selectOption('completed');
    await expect(page.getByText('共 1 条记录')).toBeVisible();
    await expect(page.getByText('backup-failed-000')).toHaveCount(0);
    await expect(page.getByText('最近成功备份').locator('..')).toContainText('backup-good-oldest');
    // The one completed record is now on the only page.
    await expect(table.getByText('backup-good-oldest')).toBeVisible();

    // The failure count is reachable too, and the two filters combine.
    await page.getByLabel('状态').selectOption('failed');
    await page.getByLabel('类型').selectOption('scheduled');
    await expect(page.getByText(`共 ${FAILURE_COUNT} 条记录`)).toBeVisible();
    await page.getByLabel('类型').selectOption('drill');
    await expect(page.getByText('共 0 条记录')).toBeVisible();
  } finally { await f.close(); }
});
