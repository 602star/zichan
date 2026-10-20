/**
 * Sorting, page size and column visibility in a real browser.
 *
 * The unit tests pin the query shapes and the cursor/ordering pairing. This pins what an operator
 * actually does: click a header and see the *server* reorder the list, change the page size and
 * see more rows, and turn a column off and have it stay off.
 *
 * The failure this guards against is invisible on screen. Sorting the rows already loaded would
 * reorder the twenty-five on screen and present the result as "the newest accounts" — a page that
 * is wrong in a way nobody can see. So the assertions are about rows that were *not* on the first
 * page before the sort, and about the request the click produced.
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
const accountPassword = ['list', 'controls', 'browser', '0001'].join('-');
const setupToken = 'test-admin-list-controls-owner-secret-0000';

/** More accounts than one page, and their name order is the reverse of their creation order. */
const ACCOUNT_COUNT = 30;

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'zichan-list-controls-'));
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
    await registerAccount(url, 'operator', accountPassword, { ownerSetupToken: setupToken });
    // Seeded rather than registered: the names are chosen so that sorting by name and sorting by
    // creation time cannot both look right, and registration would not let us pick them.
    const store = new SyncServerStore(join(dataDir, 'server.sqlite'), 'open', server.serverId);
    try {
      const base = Date.UTC(2026, 0, 1);
      for (let index = 0; index < ACCOUNT_COUNT; index += 1) {
        // Created oldest-first as `member-30`, `member-29`, … `member-01`: name order is the exact
        // reverse of creation order, so a list that claims to sort by name while still paging by
        // creation time cannot look right by accident.
        const username = `member-${String(ACCOUNT_COUNT - index).padStart(2, '0')}`;
        const at = new Date(base + index * 60_000).toISOString();
        await store.seed('INSERT INTO sync_users (username, opaque_registration_record, disabled, created_at, updated_at) VALUES (?, ?, 0, ?, ?)', [username, `record-${index}`, at, at]);
        await store.seed('INSERT INTO sync_account_identities (username, account_id) VALUES (?, ?)', [username, `account-${String(index).padStart(2, '0')}`]);
      }
    } finally { await store.close(); }
    await loginAccount(url, 'operator', accountPassword);
  } catch (error) {
    server.server.closeAllConnections(); await server.close();
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
  return {
    url,
    close: async () => {
      server.server.closeAllConnections();
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function signIn(page, url) {
  await page.goto(`${url}/e2e-private-entry/admin/`);
  await page.getByLabel('管理账号用户名').fill('operator');
  await page.getByLabel('管理账号密码').fill(accountPassword);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
}

test('sorts, resizes and hides columns on the account list', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    await page.getByRole('link', { name: '用户管理' }).click();
    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();

    // The list is the one inside the「用户列表」panel; the page shell is also a <section>.
    const table = page.locator('section').filter({ has: page.getByText('用户列表', { exact: true }) }).locator('table');
    await expect(table.locator('tbody tr')).toHaveCount(25);

    // A sortable header is a button named after its column, and it must carry no aria-label: on the
    // sessions page "状态" is both a sortable column and a filter select, and `getByLabel` matches an
    // accessible name, so an aria-label here would make the existing filter locators ambiguous.
    await expect(table.getByRole('button', { name: '用户名', exact: true })).toHaveCount(1);
    expect(await table.getByRole('button', { name: '用户名', exact: true }).getAttribute('aria-label')).toBeNull();

    // Clicking a header asks the server for that ordering rather than reordering the loaded rows.
    const requested = page.waitForRequest((request) => request.url().includes('/api/admin/users') && request.url().includes('sort=name'));
    await table.getByRole('button', { name: '用户名', exact: true }).click();
    expect((await requested).url()).toContain('dir=asc');
    // The sorted state is exposed where assistive technology looks for it.
    await expect(table.locator('th[aria-sort="ascending"]')).toHaveCount(1);

    // Name-ascending puts `member-01` first. It was created *last*, so it was on the second page
    // before the sort: the ordering really came from the server, not from reordering this page.
    await expect(table.locator('tbody tr').first()).toContainText('member-01');
    // Flipping the direction re-queries instead of reversing what is on screen.
    const flipped = page.waitForRequest((request) => request.url().includes('/api/admin/users') && request.url().includes('dir=desc'));
    await table.getByRole('button', { name: '用户名', exact: true }).click();
    await flipped;
    await expect(table.locator('th[aria-sort="descending"]')).toHaveCount(1);
    await expect(table.locator('tbody tr').first()).toContainText('operator');

    // Sorting restarts from the first page: the cursor belonged to the previous ordering.
    await expect(page.getByText('第 1 页')).toBeVisible();

    // Page size is a server-side limit, not a client-side slice.
    const resized = page.waitForRequest((request) => request.url().includes('/api/admin/users') && request.url().includes('limit=50'));
    await page.getByLabel('每页条数').selectOption('50');
    await resized;
    // 30 seeded accounts plus the operator.
    await expect(table.locator('tbody tr')).toHaveCount(31);

    // Column visibility: turning a column off removes it from the table, and the choice is about
    // the person, so it survives a reload rather than travelling in the URL. The header is located
    // by its accessible name: the button also contains the sort arrow, so an exact text match on
    // the column label would not find it.
    const syncHeader = table.getByRole('button', { name: '最近成功同步', exact: true });
    await page.getByText('列显示').click();
    await expect(syncHeader).toBeVisible();
    await page.getByRole('checkbox', { name: '最近成功同步' }).uncheck();
    await expect(syncHeader).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
    const afterReload = page.locator('section').filter({ has: page.getByText('用户列表', { exact: true }) }).locator('table');
    // The header for a hidden column is gone with it, not left behind sorting nothing.
    await expect(afterReload.getByRole('button', { name: '最近成功同步', exact: true })).toHaveCount(0);

    await page.screenshot({ path: test.info().outputPath('admin-list-controls.png'), fullPage: true });
  } finally { await f.close(); }
});

test('reports a cursor from another ordering instead of showing a plausible wrong page', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    await page.getByRole('link', { name: '用户管理' }).click();
    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();

    // A cursor issued under the name ordering, then opened under the default ordering. Reusing it
    // would return a stable, plausible, wrong page, which is worse than an error because nothing
    // about the response looks broken. The cursor is taken from the page's own authenticated
    // request, so this exercises exactly what the console would hand to the next page.
    const sorted = page.waitForResponse((response) => response.url().includes('/api/admin/users') && response.url().includes('sort=name'));
    await page.locator('section').filter({ has: page.getByText('用户列表', { exact: true }) })
      .locator('table').getByRole('button', { name: '用户名', exact: true }).click();
    const stale = (await (await sorted).json()).nextCursor;
    expect(stale).toBeTruthy();

    await page.goto(`${f.url}/e2e-private-entry/admin/users?limit=25&cursor=${encodeURIComponent(stale)}`);
    await expect(page.getByText(/翻页游标与当前排序不一致/)).toBeVisible();

    // The same cursor under the ordering it was issued for is accepted and returns a real page.
    await page.goto(`${f.url}/e2e-private-entry/admin/users?sort=name&dir=asc&limit=25&cursor=${encodeURIComponent(stale)}`);
    const table = page.locator('section').filter({ has: page.getByText('用户列表', { exact: true }) }).locator('table');
    await expect(table.locator('tbody tr')).toHaveCount(6);
  } finally { await f.close(); }
});
