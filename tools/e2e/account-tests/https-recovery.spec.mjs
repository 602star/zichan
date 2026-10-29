import { test, expect, chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createHttp, request } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { createServerBackup, verifyServerBackup, restoreServerBackup } from '../../../apps/sync-server/dist/backup.js';
import { NodeSqliteDriver } from '../../../packages/db/dist/node.js';

test('isolated HTTPS process deployment restores managed custody and ledger on another instance', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const temporary = mkdtempSync(join(tmpdir(), 'zichan-https-'));
  const source = join(temporary, 'source');
  const restored = join(temporary, 'restored');
  const backup = join(temporary, 'backup');
  let backend;
  let browser;
  let upstreamPort;
  const freePort = async () => {
    const socket = createHttp();
    await new Promise((done) => socket.listen(0, '127.0.0.1', done));
    const port = socket.address().port;
    await new Promise((done) => socket.close(done));
    return port;
  };
  const start = async (dataDir) => {
    upstreamPort = await freePort();
    backend = spawn(process.execPath, [join(root, 'apps/sync-server/dist/server.mjs')], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(upstreamPort), HOST: '127.0.0.1', WEB_DIST: join(root, 'apps/web/dist'), ENABLE_WEB: '1', REGISTRATION_MODE: 'open', TRUSTED_PROXIES: '127.0.0.1', CONTROL_STDIN: '1' },
    });
    let output = '';
    backend.stdout.on('data', (value) => { output += value; });
    backend.stderr.on('data', (value) => { output += value; });
    await expect.poll(async () => {
      if (backend.exitCode !== null) throw new Error(output);
      return fetch(`http://127.0.0.1:${upstreamPort}/api/health`).then((r) => r.status).catch(() => 0);
    }, { timeout: 20_000 }).toBe(200);
  };
  const stop = async () => {
    if (!backend || backend.exitCode !== null) return;
    const child = backend;
    const exited = new Promise((done) => child.once('exit', done));
    child.stdin.write('shutdown\n');
    const timer = setTimeout(() => child.kill(), 10_000);
    try { await exited; expect(child.exitCode).toBe(0); } finally { clearTimeout(timer); }
  };
  let proxy;
  try {
    execFileSync('python', [join(root, 'tools/e2e/test-certificate.py'), temporary], { windowsHide: true });
    const cert = readFileSync(join(temporary, 'test-cert.pem'));
    const pin = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    proxy = createHttps({ cert, key: readFileSync(join(temporary, 'test-key.pem')) }, (req, res) => {
      const upstream = request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method,
        headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': req.socket.remoteAddress } }, (response) => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(503); res.end(); });
      req.pipe(upstream);
    });
    await start(source);
    await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
    const url = `https://127.0.0.1:${proxy.address().port}`;
    browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), args: [`--ignore-certificate-errors-spki-list=${pin}`] });
    let context = await browser.newContext();
    context.setDefaultTimeout(10_000);
    let page = await context.newPage();
    await page.goto(`${url}/e2e-private-entry/admin/`);
    await page.getByLabel('管理账号用户名').fill('owner');
    await page.getByLabel('管理账号密码').fill('owner-test-password');
    await page.getByRole('button', { name: '创建所有者并进入后台' }).click();
    await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
    await page.goto(`${url}/app/`);
    await page.getByRole('button', { name: '注册新账号', exact: true }).click();
    await page.getByLabel('昵称', { exact: true }).fill('部署测试用户');
    await page.getByLabel('服务器用户名').fill('deployment-user');
    await page.getByLabel('服务器账号密码', { exact: true }).fill('deployment-password');
    await page.getByLabel('确认账号密码').fill('deployment-password');
    await page.getByRole('button', { name: '注册并登录', exact: true }).click();
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    await page.getByRole('button', { name: '+ 记支出' }).click();
    await page.getByRole('textbox', { name: /^金额/ }).fill('68');
    await page.getByLabel('描述').fill('HTTPS 恢复演练');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('HTTPS 恢复演练', { exact: true })).toBeVisible();
    expect((await context.cookies()).find((c) => c.name === 'zichan_session')).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict' });
    await expect.poll(async () => {
      const driver = new NodeSqliteDriver(join(source, 'server.sqlite'));
      try { return Number((await driver.get('SELECT COUNT(*) AS n FROM sync_server_commits')).n); } finally { await driver.close(); }
    }).toBeGreaterThan(1);
    await context.close();
    await stop();
    const manifest = await createServerBackup(source, backup);
    expect(manifest.files.some((file) => file.path === 'custody.key')).toBe(true);
    expect((await verifyServerBackup(backup)).ok).toBe(true);
    await restoreServerBackup(backup, restored);
    expect(readFileSync(join(restored, 'custody.key'), 'utf8')).toBe(readFileSync(join(source, 'custody.key'), 'utf8'));
    await start(restored);
    context = await browser.newContext();
    context.setDefaultTimeout(10_000);
    page = await context.newPage();
    await page.goto(`${url}/app/`);
    await page.getByLabel('服务器用户名').fill('deployment-user');
    await page.getByLabel('服务器账号密码', { exact: true }).fill('deployment-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await expect(page.getByText('HTTPS 恢复演练', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('https-restored-ledger.png') });
    await testInfo.attach('deployment-evidence', { body: JSON.stringify({ transport: 'HTTPS', certificateTrust: 'isolated SPKI pin', source: 'separate server.mjs process', restore: 'new process and data directory', files: manifest.files.map((f) => f.path), secureCookie: true, freshDeviceRestored: true }, null, 2), contentType: 'application/json' });
  } finally {
    await browser?.close();
    await stop();
    if (proxy) { const closed = new Promise((done) => proxy.close(done)); proxy.closeAllConnections(); await closed; }
    rmSync(temporary, { recursive: true, force: true });
  }
});
