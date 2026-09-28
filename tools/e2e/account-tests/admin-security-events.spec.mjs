import { clickAdminLink } from '../admin-navigation.mjs';
/**
 * The login-security page in a real browser.
 *
 * The unit tests pin the aggregation; this one pins what an operator depends on: the page is
 * reachable from the navigation, it states the boundary of what it can see, and it does not claim
 * an address is throttled when the limiter is not blocking it.
 */
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = ['security', 'events', 'e2e', '0001'].join('-');
const setupToken = 'test-security-events-owner-secret-000000';

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
    await registerAccount(url, 'victim', password);
  } catch (error) {
    server.server.closeAllConnections(); await server.close(); throw error;
  }
  const owner = await loginAccount(url, 'operator', password);
  const opaque = await import('@serenity-kit/opaque');
  await opaque.ready;
  /** A real OPAQUE guess: the official client answers a wrong password locally, so it is not used. */
  const guess = async (username) => {
    const start = opaque.client.startLogin({ password: 'guessed-password' });
    const started = await fetch(`${url}/api/auth/login/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, startLoginRequest: start.startLoginRequest }),
    });
    const body = await started.json();
    const finish = opaque.client.finishLogin({
      clientLoginState: start.clientLoginState,
      loginResponse: body.loginResponse,
      password: 'guessed-password',
      identifiers: { client: username, server: body.serverId },
      keyStretching: 'memory-constrained',
    });
    return fetch(`${url}/api/auth/login/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginId: body.loginId,
        finishLoginRequest: finish ? finish.finishLoginRequest : start.startLoginRequest,
        deviceId: 'attacker-device',
        deviceName: 'attacker',
      }),
    });
  };
  return {
    url, owner, guess,
    close: async () => { server.server.closeAllConnections(); await server.close(); },
  };
}

async function signIn(page, url, username = 'operator') {
  await page.goto(`${url}/admin/`);
  await page.getByLabel('管理账号用户名').fill(username);
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
}

/** The panel that owns a given title; panels are sections with the title as their first strong. */
const panelWith = (page, title) => page.locator('section').filter({ has: page.getByText(title, { exact: true }) }).first();

test('shows failed logins by source and states what it cannot see', async ({ page }) => {
  const f = await fixture();
  try {
    for (let index = 0; index < 3; index += 1) {
      expect((await f.guess('victim')).status).toBe(401);
    }
    await signIn(page, f.url);
    await clickAdminLink(page, '登录安全');
    await expect(page.getByRole('heading', { name: '登录安全' })).toBeVisible();

    // The aggregation is the point: an address, how often, and which accounts it touched.
    // Scoped to the failure panel, because the same address also appears in the bucket table.
    const failures = panelWith(page, '失败登录来源');
    await expect(failures.getByRole('cell', { name: '127.0.0.1', exact: true }).first()).toBeVisible();
    await expect(failures.getByRole('cell', { name: 'victim', exact: true }).first()).toBeVisible();
    await expect(page.getByText('失败总次数')).toBeVisible();

    // The boundary is on the page, not left for the reader to assume: a locally-rejected guess
    // never reaches the server, so an empty view is not proof that nothing happened.
    await expect(page.getByText(/客户端在本地就判定为密码错误/)).toBeVisible();
    await expect(page.getByText(/不提供手动按钮/)).toBeVisible();

    // Three failures are not throttling, and the page must not imply otherwise.
    await expect(page.getByText('正在限流')).toHaveCount(0);
  } finally { await f.close(); }
});

test('marks an address as throttled only once the limiter blocks it', async ({ page }) => {
  const f = await fixture();
  try {
    // Sign in before flooding, and note why: the limiter buckets by address, so the flood and the
    // administrator share one bucket. That is real behaviour rather than a test artifact — and it
    // is exactly the kind of thing this page exists to make visible.
    await signIn(page, f.url);

    let throttled = false;
    for (let index = 0; index < 30 && !throttled; index += 1) {
      const response = await fetch(`${f.url}/api/auth/login/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'victim', startLoginRequest: 'not-a-real-request' }),
      });
      throttled = response.status === 429;
    }
    expect(throttled).toBe(true);

    await clickAdminLink(page, '登录安全');
    await expect(page.getByRole('heading', { name: '登录安全' })).toBeVisible();
    // Both views agree: the bucket table shows the block, and the failure list marks the source.
    await expect(page.getByText(/限流至/).first()).toBeVisible();
    await expect(page.getByText(/当前有 \d+ 个桶处于限流状态/)).toBeVisible();
  } finally { await f.close(); }
});
