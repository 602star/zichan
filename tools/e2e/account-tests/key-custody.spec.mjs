import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount, loginAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture() {
  const setup = 'test-custody-owner-000000000000000000';
  const server = createSyncServer({ webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken: setup });
  await server.ready;
  await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.server.address().port}`;
  await registerAccount(url, 'owner', 'owner-test-password', { ownerSetupToken: setup });
  return { server, url };
}
async function login(page, url, username) {
  await page.goto(`${url}/app/`);
  await page.getByLabel('服务器用户名').fill(username);
  await page.getByLabel('服务器账号密码', { exact: true }).fill('account-test-password');
  await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
}
async function openSettings(page) {
  const close = page.getByRole('button', { name: '关闭快速记账' });
  await close.click();
  await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
  await page.getByRole('tab', { name: '数据与安全' }).click();
}

test('managed account opens without a key prompt, restores a new device, and switches to private recovery', async ({ page, browser }, testInfo) => {
  const f = await fixture();
  const second = await browser.newContext();
  try {
    await registerAccount(f.url, 'managed-user', 'account-test-password');
    await login(page, f.url, 'managed-user');
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await expect(page.getByLabel('账本密码', { exact: true })).toHaveCount(0);
    await openSettings(page);
    await expect(page.getByRole('region', { name: '账本保护' })).toContainText('云端托管');
    const other = await second.newPage();
    await login(other, f.url, 'managed-user');
    await expect(other.locator('.zc-app-shell')).toBeVisible();
    await expect(other.getByLabel('远端账本密码')).toHaveCount(0);
    await other.close();
    const panel = page.getByRole('region', { name: '账本保护' });
    await panel.getByText('高级：更改保护方式', { exact: true }).click();
    await panel.getByRole('button', { name: '准备切换到私密模式' }).click();
    const code = await panel.locator('pre').innerText();
    await panel.getByRole('checkbox', { name: /我已保存新恢复码/ }).check();
    await panel.getByRole('button', { name: '确认更改保护方式' }).click();
    await expect(panel).toContainText('保护方式已更新');
    await panel.screenshot({ path: testInfo.outputPath('private-protection.png') });
    const session = await loginAccount(f.url, 'managed-user', 'account-test-password', { deviceId: 'api-check' });
    const remote = await (await fetch(`${f.url}/api/v3/protection`, { headers: { Authorization: `Bearer ${session.accessToken}` } })).json();
    expect(remote.mode).toBe('private'); expect(remote.secret).toBeNull();
    await page.reload();
    await page.getByLabel('账本恢复码', { exact: true }).fill(code);
    await page.getByRole('button', { name: '解锁账本', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
    await page.getByRole('tab', { name: '数据与安全' }).click();
    const restoredPanel = page.getByRole('region', { name: '账本保护' });
    await restoredPanel.getByText('此设备的离线访问', { exact: true }).click();
    await restoredPanel.getByRole('button', { name: '记住此设备七天' }).click();
    await expect(restoredPanel).toContainText('已记住此设备七天');
    await page.reload();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await expect(page.getByLabel('账本恢复码', { exact: true })).toHaveCount(0);
    await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
    await page.getByRole('tab', { name: '数据与安全' }).click();
    await page.getByText('高级：更改保护方式', { exact: true }).click();
    await page.getByRole('button', { name: '准备切换到云端托管' }).click();
    await page.getByRole('checkbox', { name: '允许此服务器解密账本', exact: true }).check();
    await page.getByRole('button', { name: '确认更改保护方式' }).click();
    await expect(page.getByRole('region', { name: '账本保护' })).toContainText('保护方式已更新');
    await page.reload();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
  } finally { await second.close(); await page.close(); f.server.server.closeAllConnections(); await f.server.close(); }
});

test('private registration saves a recovery code and offline access is opt-in', async ({ page }) => {
  const f = await fixture();
  try {
    await page.goto(`${f.url}/app/`);
    await page.getByRole('button', { name: '注册新账号', exact: true }).click();
    await page.getByLabel('服务器用户名').fill('private-user');
    await page.getByLabel('服务器账号密码', { exact: true }).fill('account-test-password');
    await page.getByLabel('确认账号密码').fill('account-test-password');
    await page.getByText('高级：账本保护方式', { exact: true }).click();
    await page.getByRole('checkbox', { name: '创建私密账本，自己保存恢复码' }).check();
    await page.getByRole('button', { name: '注册并登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '创建私密账本', exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: '我已把恢复码保存在此设备以外' }).check();
    await page.getByRole('button', { name: '创建私密账本', exact: true }).click();
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await openSettings(page);
    await page.getByText('此设备的离线访问', { exact: true }).click();
    await page.getByLabel('设置离线密码').fill('offline-only-password');
    await page.getByLabel('确认离线密码').fill('offline-only-password');
    await page.getByRole('button', { name: '设置离线密码', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '离线密码已设置' })).toBeVisible();
    const raw = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(raw).not.toContain('offline-only-password'); expect(raw).not.toContain('account-test-password');
    await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'offline' } }));
    await page.reload();
    await page.getByRole('button', { name: '离线解锁 private-user 的缓存' }).click();
    await page.getByLabel('离线密码', { exact: true }).fill('offline-only-password');
    await page.getByRole('button', { name: '解锁缓存', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
  } finally { await page.close(); f.server.server.closeAllConnections(); await f.server.close(); }
});
