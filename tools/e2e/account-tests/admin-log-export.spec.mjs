import { clickAdminLink } from '../admin-navigation.mjs';
/**
 * Run log export in a real browser.
 *
 * The unit tests pin the server-side redaction and filters; this pins the part that only exists
 * in the browser: the buttons are there, they follow the current filters, and the file that lands
 * on disk is the redacted one.
 */
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = ['log', 'export', 'e2e', '0001'].join('-');
const setupToken = 'test-log-export-owner-secret-0000000';

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
    await registerAccount(url, 'otheruser', password);
  } catch (error) {
    server.server.closeAllConnections(); await server.close(); throw error;
  }
  const owner = await loginAccount(url, 'operator', password);
  return {
    url, owner,
    close: async () => { server.server.closeAllConnections(); await server.close(); },
  };
}

async function signIn(page, url) {
  await page.goto(`${url}/admin/`);
  await page.getByLabel('管理账号用户名').fill('operator');
  await page.getByLabel('管理账号密码').fill(password);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
}

test('downloads the run log as JSON and CSV, stating what it redacted', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    await clickAdminLink(page, '运行日志');
    await expect(page.getByRole('heading', { name: '运行日志' })).toBeVisible();

    // The page says what the file will and will not contain, so the reader is not left guessing.
    await expect(page.getByText(/令牌、密钥、邀请码与重置码不会出现在文件里/)).toBeVisible();
    await expect(page.getByText(/账号 ID、任务 ID 与请求 ID 保留/)).toBeVisible();

    const jsonDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 JSON' }).click();
    const json = await jsonDownload;
    expect(json.suggestedFilename()).toBe('run-log.json');
    const stream = await json.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.redaction).toContain('脱敏');
    // The export is the log itself, not an empty file with the right name.
    expect(body.rows.some((row) => row.action === 'register_success')).toBe(true);

    const csvDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 CSV' }).click();
    const csv = await csvDownload;
    expect(csv.suggestedFilename()).toBe('run-log.csv');
  } finally { await f.close(); }
});

test('narrows the export to the filters the page is showing', async ({ page }) => {
  const f = await fixture();
  try {
    await signIn(page, f.url);
    // Filter to one account, so the export must not contain the other account's lines.
    await page.goto(`${f.url}/admin/logs?username=otheruser`);
    await expect(page.getByRole('heading', { name: '运行日志' })).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 JSON' }).click();
    const stream = await (await download).createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every((row) => row.username === 'otheruser')).toBe(true);
  } finally { await f.close(); }
});
