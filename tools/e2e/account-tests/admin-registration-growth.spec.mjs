import { clickAdminLink } from '../admin-navigation.mjs';
/**
 * Registration growth on the invitations page, in a real browser.
 *
 * The unit tests pin the queries and the endpoint; this pins what an operator sees: the growth
 * numbers, the per-batch table, and the range control actually re-reading from the server
 * instead of rescaling whatever was already on screen.
 */
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { SyncServerStore } from '../../../apps/sync-server/dist/store.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const accountPassword = ['growth', 'browser', 'password', '0001'].join('-');
const setupToken = 'e2e-admin-registration-growth-setup-0001';

async function fixture() {
  const server = createSyncServer({
    webDir: resolve(root, 'apps/web/dist'),
    enableWeb: true,
    registrationMode: 'open',
    ownerSetupToken: setupToken,
  });
  await server.ready;
  await server.started;
  await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.server.address().port}`;
  await registerAccount(url, 'operator', accountPassword, { ownerSetupToken: setupToken });
  const store = new SyncServerStore(server.dataDir + '/server.sqlite', 'invite', server.serverId);
  await store.setRegistrationMode('invite');
  await store.createInvite('browser-invite-one');
  await store.createInvite('browser-invite-two');
  await store.setInviteDisabled('browser-invite-two', true);
  await registerAccount(url, 'invited-member', accountPassword, { inviteCode: 'browser-invite-one' });
  return { url, store, close: async () => { await store.close(); server.server.closeAllConnections(); await server.close(); } };
}

async function signIn(page, url) {
  await page.goto(`${url}/e2e-private-entry/admin/`);
  await page.getByLabel('管理账号用户名').fill('operator');
  await page.getByLabel('管理账号密码').fill(accountPassword);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
}

test('shows registration growth and invitation attribution', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    await clickAdminLink(page, '注册与邀请');
    await expect(page.getByRole('heading', { name: '注册与邀请' })).toBeVisible();

    // The page shell is itself a <section>, so a `section` filter matches the wrapper too and a
    // "not present" assertion inside it would never be true. Anchor on the batch table instead:
    // it is the only table whose header says 发放日期.
    await expect(page.getByText('注册与邀请增长', { exact: true })).toBeVisible();
    await expect(page.getByText('新账号', { exact: true })).toBeVisible();
    const table = page.locator('table').filter({ has: page.getByText('发放日期', { exact: true }) });
    await expect(table.getByText('发放日期')).toBeVisible();
    // Two accounts exist: the owner (no invitation) and the invited member. The invited member
    // came in on the one code that was used, so the batch shows 2 issued / 1 used.
    await expect(page.getByText('其中来自邀请').locator('..')).toContainText('1');
    await expect(page.getByText('无邀请码').locator('..')).toContainText('1');
    await expect(table.getByRole('row')).toHaveCount(2);
    const batch = table.getByRole('row').nth(1);
    await expect(batch).toContainText('2');
    await expect(batch).toContainText('1');
    // Codes themselves are not listed here — the batch table answers "how many", not "which".
    await expect(table.getByText('browser-invite-one')).toHaveCount(0);
    await expect(page.getByText(/邀请码状态汇总（全部历史）：可用 0、\s*已用 1、\s*已撤销 1、已过期 0。/)).toBeVisible();

    // The range control re-reads from the server: switching to a year switches the bucketing to
    // months, which is visible in the caption rather than silently rescaled.
    await page.getByLabel('范围').selectOption('365d');
    await expect(page.getByText(/按自然月/)).toBeVisible();
    await page.getByLabel('范围').selectOption('30d');
    await expect(page.getByText(/按自然日/)).toBeVisible();
  } finally { await f.close(); }
});
