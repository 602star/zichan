import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount, loginAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'multi-server-account-password';
const cachePassword = 'multi-server-cache-password';

test('keeps Web login isolated while editing, syncing and restoring multiple servers', async ({ page, context }) => {
  const servers = [];
  async function start(username) {
    const setup = 'test-multi-server-owner-secret-000000';
    const server = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken: setup });
    servers.push(server);
    await server.ready;
    await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(url, 'operator', password, { ownerSetupToken: setup });
    await registerAccount(url, username, password);
    const owner = await loginAccount(url, 'operator', password);
    return { url, owner };
  }
  try {
    const home = await start('home-user');
    const secondary = await start('remote-user');
    await page.goto(`${home.url}/app/`);
    await page.getByLabel('服务器用户名').fill('home-user');
    await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录已有账号' }).click();
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).click();
    await page.getByRole('button', { name: '关闭快速记账' }).click();
    await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
    await page.getByRole('tab', { name: '同步与账号' }).click();
    await page.getByRole('button', { name: '管理同步服务器', exact: true }).click();
    await page.getByRole('button', { name: /^同步设置/ }).click();
    await expect(page.getByRole('button', { name: '新增服务器' })).toBeVisible();
    await expect(page.getByLabel('完整服务器地址')).toBeDisabled();
    await expect(page.getByLabel('用户名', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
    await expect(page.getByText('管理员初始化密钥', { exact: false })).toHaveCount(0);
    const beforeCookie = (await context.cookies()).find((cookie) => cookie.name === 'zichan_session').value;

    await page.getByRole('button', { name: '新增服务器' }).click();
    await expect(page.getByRole('button', { name: '本机服务器', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '公网域名', exact: true })).toBeVisible();
    await page.getByLabel('完整服务器地址').fill(secondary.url);
    await page.getByRole('button', { name: '保存地址', exact: true }).click();
    await page.getByLabel('中文别名').fill('本机副本');
    await page.getByLabel('用户名', { exact: true }).fill('remote-user');
    await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
    await page.getByLabel('确认服务器账号密码', { exact: true }).fill('mismatch');
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page.getByText(/两次输入的服务器账号密码不一致/)).toBeVisible();
    // Let the server finish Alice's login, but hold delivery while the user changes the profile.
    let release;
    const held = new Promise((done) => { release = done; });
    let reportResponse;
    const delayedResponse = new Promise((done) => { reportResponse = done; });
    await page.route(`${secondary.url}/api/auth/login/finish`, async (route) => {
      const response = await route.fetch();
      reportResponse(await response.json());
      await held;
      await route.fulfill({ response }).catch(() => {}); // The client intentionally aborts the old request.
    });
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const staleSession = await delayedResponse;
    await page.getByLabel('用户名', { exact: true }).fill('different-user');
    release();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
    await expect(page.getByLabel('用户名', { exact: true })).toHaveValue('different-user');
    await expect(page.getByText(/登录未完成：/)).toHaveCount(0);
    const staleStorage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(staleStorage).not.toContain(staleSession.accessToken);
    expect(staleStorage).not.toContain(staleSession.accountId);
    await page.unroute(`${secondary.url}/api/auth/login/finish`);
    await page.getByLabel('用户名', { exact: true }).fill('remote-user');
    await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
    const loginResponse = page.waitForResponse((response) => response.url() === `${secondary.url}/api/auth/login/finish`);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const remoteSession = await (await loginResponse).json();
    expect(remoteSession.refreshToken).toBeTruthy();
    await expect.poll(() => page.evaluate(() => JSON.stringify({ ...sessionStorage }))).toContain(remoteSession.refreshToken);
    expect((await context.cookies()).find((cookie) => cookie.name === 'zichan_session').value).toBe(beforeCookie);
    // Passwords have been cleared: these clicks exercise the existing-session branch.
    await expect(page.getByLabel('服务器账号密码', { exact: true })).toHaveValue('');
    for (const status of [503, 403]) {
      await page.route(`${secondary.url}/api/health`, (route) => route.fulfill({ status, json: { error: 'unavailable' } }));
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByText(new RegExp(`本机副本（remote-user）登录未完成：.*HTTP ${status}`))).toBeVisible();
      await page.unroute(`${secondary.url}/api/health`);
    }
    await page.route(`${secondary.url}/api/health`, (route) => route.fulfill({ json: { serverId: 'changed', serverPublicKey: 'changed' } }));
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByText(/本机副本（remote-user）登录未完成：.*身份已变化/)).toBeVisible();
    await page.unroute(`${secondary.url}/api/health`);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByText(/登录未完成：/)).toHaveCount(0);
    await page.getByLabel('启用 本机副本', { exact: true }).check();
    await page.getByRole('button', { name: '同步全部启用服务器', exact: true }).first().click();
    await expect.poll(async () => {
      const response = await fetch(`${secondary.url}/api/admin/users?search=remote-user`, { headers: { Authorization: `Bearer ${secondary.owner.accessToken}` } });
      return (await response.json()).users[0].commitCount;
    }).toBeGreaterThan(0);

    const protectionPanel = page.getByRole('region', { name: '服务器保护方式' });
    await protectionPanel.getByRole('button', { name: '检查保护方式' }).click();
    await expect(protectionPanel).toContainText('此服务器仅保存密文');
    await expect(protectionPanel.getByRole('button', { name: '启用此服务器托管' })).toBeDisabled();
    await protectionPanel.getByRole('checkbox', { name: '允许此服务器解密账本' }).check();
    await protectionPanel.getByRole('button', { name: '启用此服务器托管' }).click();
    await expect(protectionPanel).toContainText('此服务器已获授权，可以解密账本');
    await protectionPanel.getByRole('button', { name: '撤销此服务器托管' }).click();
    await expect(protectionPanel).toContainText('此服务器仅保存密文');

    await page.getByRole('button', { name: '新增服务器' }).click();
    await page.getByLabel('完整服务器地址').fill('https://ledger.example.com/zichan');
    await page.getByRole('button', { name: '保存地址', exact: true }).click();
    await page.getByLabel('中文别名').fill('公网副本');
    await expect(page.getByLabel('启用 公网副本', { exact: true })).not.toBeChecked();
    await page.reload();
    await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
    await page.getByRole('tab', { name: '同步与账号' }).click();
    await page.getByRole('button', { name: '管理同步服务器', exact: true }).click();
    await page.getByRole('button', { name: /^同步设置/ }).click();
    await expect(page.getByLabel('启用 本机副本', { exact: true })).toBeChecked();
    await expect(page.getByLabel('启用 公网副本', { exact: true })).not.toBeChecked();
    const storage = await page.evaluate(() => ({ local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) }));
    expect(storage.local).not.toContain(password);
    expect(storage.session).not.toContain(password);
    expect(storage.local).not.toContain(remoteSession.refreshToken);
    expect(storage.session).toContain(remoteSession.refreshToken);
    await page.getByLabel('启用 公网副本', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('web-multi-server.png') });
    await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
    await page.getByRole('tab', { name: '同步与账号' }).click();
    await page.getByRole('button', { name: '退出记账账号', exact: true }).click();
    await page.getByRole('button', { name: '确认退出', exact: true }).click();
    await expect(page.getByRole('heading', { name: '账号登录', exact: true })).toBeVisible();
    expect((await fetch(`${secondary.url}/api/auth/me`, { headers: { Authorization: `Bearer ${remoteSession.accessToken}` } })).status).toBe(401);
    await page.getByLabel('服务器用户名').fill('home-user');
    await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录已有账号' }).click();
    await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
    await page.getByRole('tab', { name: '同步与账号' }).click();
    await page.getByRole('button', { name: '管理同步服务器', exact: true }).click();
    await page.getByRole('button', { name: /^同步设置/ }).click();
    await expect(page.getByLabel('启用 本机副本', { exact: true })).toBeChecked();
    await expect(page.getByLabel('启用 公网副本', { exact: true })).not.toBeChecked();
    expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).not.toContain(remoteSession.refreshToken);
    await page.getByRole('row').filter({ hasText: '公网副本' }).click();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('不删除服务器上的账号或账本');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByLabel('启用 公网副本', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '撤销会话并删除连接', exact: true }).click();
    await expect(page.getByLabel('启用 公网副本', { exact: true })).toHaveCount(0);
  } finally {
    await page.close();
    for (const server of servers) { server.server.closeAllConnections(); await server.close(); }
  }
});
