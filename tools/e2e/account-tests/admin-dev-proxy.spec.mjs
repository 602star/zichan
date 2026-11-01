import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createPortProbe } from 'node:net';
import { createServer as createViteServer } from '../../../node_modules/vite/dist/node/index.js';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('development proxy supports owner creation, cookie restore and rejects foreign origins', async ({ page, context }) => {
  const server = createSyncServer({ basePath: '/ledger', enableWeb: false });
  let vite;
  const previousTarget = process.env.ZICHAN_DEV_API_TARGET;
  try {
    await server.ready;
    await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
    process.env.ZICHAN_DEV_API_TARGET = `http://127.0.0.1:${server.server.address().port}/ledger`;
    const probe = createPortProbe();
    await new Promise((done) => probe.listen(0, '127.0.0.1', done));
    const port = probe.address().port;
    await new Promise((done) => probe.close(done));
    vite = await createViteServer({ root: join(root, 'apps/web'), server: { port, host: '127.0.0.1' } });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const foreignSetup = await context.request.post(`${origin}/api/auth/register/start`, {
      headers: { Origin: 'http://foreign.invalid', 'X-Zichan-Session': 'admin-cookie' },
      data: { username: 'foreign-owner', registrationRequest: 'test', initializeOwner: true },
    });
    expect(foreignSetup.status()).toBe(403);
    await page.route('**/api/health', (route) => route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><html></html>' }));
    await page.goto(`${origin}/e2e-private-entry/admin/`);
    await expect(page.getByRole('alert')).toContainText('无法确定管理服务器地址');
    await expect(page.getByRole('button', { name: '重新连接' })).toBeVisible();
    await expect(page.getByRole('button', { name: '创建所有者并进入后台' })).toHaveCount(0);
    await page.unroute('**/api/health');
    await page.reload();
    // Vite may still be transforming the admin bundle after a reload on a busy CI runner.
    await expect(page.getByRole('heading', { name: '初始化服务器所有者' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('管理账号用户名').fill('dev-owner');
    await page.getByLabel('管理账号密码').fill('dev-owner-test-password');
    await expect(page.getByLabel('部署者初始化密钥')).toHaveCount(0);
    await page.route('**/api/auth/login/start', (route) => route.abort(), { times: 1 });
    await page.getByRole('button', { name: '创建所有者并进入后台' }).click();
    await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
    await expect(page.getByRole('button', { name: '创建所有者并进入后台' })).toHaveCount(0);
    await page.getByLabel('管理账号密码').fill('dev-owner-test-password');
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
    const repeated = await context.request.post(`${origin}/api/auth/register/start`, {
      headers: { Origin: origin, 'X-Zichan-Session': 'admin-cookie' },
      data: { username: 'another-owner', registrationRequest: 'test', initializeOwner: true },
    });
    expect(repeated.status()).toBe(409);
    expect((await repeated.json()).code).toBe('OWNER_ALREADY_CLAIMED');
    expect((await context.cookies()).find((cookie) => cookie.name === 'zichan_admin_session')).toMatchObject({ httpOnly: true, path: '/api/auth', sameSite: 'Strict' });
    await page.reload();
    await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
    const denied = await context.request.post(`${origin}/api/auth/refresh`, {
      headers: { Origin: 'http://foreign.invalid', 'X-Zichan-Session': 'admin-cookie' }, data: {},
    });
    expect(denied.status()).toBe(403);
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  } finally {
    if (previousTarget === undefined) delete process.env.ZICHAN_DEV_API_TARGET;
    else process.env.ZICHAN_DEV_API_TARGET = previousTarget;
    await vite?.close();
    server.server.closeAllConnections();
    await server.close();
  }
});
