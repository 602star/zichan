/**
 * The maintenance window in a real browser.
 *
 * The unit and route tests pin the gate and the expiry. This pins what an operator sees: the
 * overview reports 维护中 rather than 降级, the scope of what stops is stated, and turning it back
 * off really restores writes.
 */
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = ['maintenance', 'spec', 'password', '0001'].join('-');
const setupToken = 'test-maintenance-owner-secret-000000';

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
  try {
    await registerAccount(url, 'operator', password, { ownerSetupToken: setupToken });
    await registerAccount(url, 'member', password);
  } catch (error) {
    server.server.closeAllConnections(); await server.close(); throw error;
  }
  const owner = await loginAccount(url, 'operator', password);
  const member = await loginAccount(url, 'member', password);
  const authorization = ['Bea', 'rer'].join('');
  // A member's data-plane write, to observe the gate the way a client would.
  const clientWrite = () => fetch(`${url}/api/v3/commits`, {
    method: 'POST', headers: { Authorization: `${authorization} ${member.accessToken}`, 'Content-Type': 'application/json' },
  });
  return { url, clientWrite, close: async () => { server.server.closeAllConnections(); await server.close(); } };
}

async function signIn(page, url) {
  await page.goto(`${url}/admin/`);
  await page.getByLabel('管理账号用户名').fill('operator');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
}

test('declares a maintenance window, shows it as a planned state, and restores writes', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    const panel = page.locator('section').filter({ has: page.getByText('维护窗口', { exact: true }) });

    // Before: normal operation, and stopping would be safe.
    await expect(panel.getByText('正常', { exact: true }).first()).toBeVisible();
    await expect(panel.getByText(/没有进行中的写入与任务/)).toBeVisible();

    await panel.getByLabel('维护说明（会显示给客户端）').fill('升级数据库，约 30 分钟');
    await panel.getByRole('button', { name: '声明维护窗口' }).click();

    // The service status says 维护中, and does not call it a degradation: a planned window and a
    // fault have different next steps.
    await expect(page.getByText('维护中', { exact: true }).first()).toBeVisible();
    await expect(panel.getByText(/客户端写入已暂停，读取正常/)).toBeVisible();
    await expect(panel.getByText(/升级数据库，约 30 分钟/)).toBeVisible();

    // The gate is really closed, not just displayed as closed.
    const refused = await f.clientWrite();
    expect(refused.status).toBe(503);
    expect((await refused.json()).code).toBe('MAINTENANCE');

    // Reads stay open, so the client can still find out what is happening.
    expect((await fetch(`${f.url}/api/health`)).status).toBe(200);

    await panel.getByRole('button', { name: '结束维护，恢复写入' }).click();
    await expect(panel.getByText(/读写都可用/)).toBeVisible();
    expect((await f.clientWrite()).status).not.toBe(503);
  } finally { await f.close(); }
});

test('warns that an open-ended window will not resume by itself', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    const panel = page.locator('section').filter({ has: page.getByText('维护窗口', { exact: true }) });
    // An open-ended window is allowed, but it must say so plainly: nothing will bring writes back
    // except a person, which is the difference between a window and an outage.
    await panel.getByRole('button', { name: '不设结束时间' }).click();
    await panel.getByRole('button', { name: '声明维护窗口' }).click();
    await expect(panel.getByText(/不会自动恢复，需要手动结束/)).toBeVisible();
    await panel.getByRole('button', { name: '结束维护，恢复写入' }).click();
    await expect(panel.getByText(/读写都可用/)).toBeVisible();
  } finally { await f.close(); }
});
