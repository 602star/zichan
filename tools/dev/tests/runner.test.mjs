import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, start, stop, assertPortFree, root } from '../../../scripts/dev/runner.mjs';

const fixtureEntry = fileURLToPath(new URL('../fixtures/service.mjs', import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'zichan-launcher-'));
  mkdirSync(join(directory, 'node_modules'));
  const port = await freePort();
  return { mode: 'web', directory, build: null, urls: [], units: [{ key: 'web', entry: fixtureEntry, args: [], cwd: directory, env: { ...process.env, TEST_PORT: String(port) }, host: '127.0.0.1', port, ready: `http://127.0.0.1:${port}/`, graceful: true }] };
}
async function ready(url, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(2_000, deadline - Date.now())) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* Not listening yet. */ }
    await sleep(30);
  }
  throw new Error(`Fixture did not become ready within ${timeoutMs}ms: ${url}`);
}

test('plans a single all-in-one build with safe defaults and no stale admin URL', () => {
  const value = plan('server', { BASE_PATH: '/ledger', PORT: '18888' }, resolve('example'));
  assert.equal(value.build, 'build:server');
  assert.equal(value.units[0].env.HOST, '0.0.0.0');
  assert.equal(value.units[0].env.ALLOW_INSECURE_HTTP, '1');
  assert.equal(value.units[0].env.REGISTRATION_MODE, 'invite');
  assert.ok(value.urls.includes('http://127.0.0.1:18888/ledger/'));
  assert.ok(!value.urls.some((url) => url.includes('/admin/')));
  assert.equal(plan('sync', {}).units[0].env.ENABLE_WEB, '0');
  assert.throws(() => plan('all', { PORT: '5173' }), /must differ/);
  assert.throws(() => plan('server', { PORT: 'bad' }), /integers/);
});

test('occupied ports are refused without terminating the listener', async () => {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    await assert.rejects(assertPortFree(server.address().port, '127.0.0.1'), /No process was stopped/);
    assert.equal(server.listening, true);
  } finally { await new Promise((done) => server.close(done)); }
});

test('check-only does not build or create control records', async () => {
  const value = await fixture();
  try {
    assert.equal(await start(value, { check: true }), 0);
    assert.equal(existsSync(join(value.directory, '.runtime')), false);
  } finally { rmSync(value.directory, { recursive: true, force: true }); }
});

test('stops an owned child via authenticated local control and removes only its records', async () => {
  const value = await fixture();
  const running = start(value, { noBuild: true });
  try {
    await ready(value.units[0].ready);
    const record = JSON.parse(readFileSync(join(value.directory, '.runtime/launchers/web.json'), 'utf8'));
    const denied = await fetch(`http://127.0.0.1:${record.controlPort}/stop`, { method: 'POST', headers: { 'X-Zichan-Launcher': 'wrong' }, body: '{}' });
    assert.equal(denied.status, 403); await denied.body.cancel();
    await ready(value.units[0].ready);
    await stop('web', value.directory);
    assert.equal(await running, 0);
    assert.equal(existsSync(join(value.directory, '.runtime/launchers/web.json')), false);
    await assertPortFree(value.units[0].port, '127.0.0.1');
  } finally { await stop('web', value.directory); await running; rmSync(value.directory, { recursive: true, force: true }); }
});

test('a child failure returns its nonzero exit code and closes the managed lifecycle', async () => {
  const value = await fixture();
  const running = start(value, { noBuild: true });
  try {
    await ready(value.units[0].ready);
    const res = await fetch(`${value.units[0].ready}fail`); await res.body.cancel();
    assert.equal(await running, 17);
  } finally { await stop('web', value.directory); await running; rmSync(value.directory, { recursive: true, force: true }); }
});

test('repeated start reuses the authenticated launcher and leaves its process and records intact', async () => {
  const value = await fixture();
  const running = start(value, { noBuild: true });
  try {
    await ready(value.units[0].ready);
    const path = join(value.directory, '.runtime/launchers/web.json');
    const before = readFileSync(path, 'utf8');
    assert.equal(await start(value, { noBuild: true }), 0);
    assert.equal(readFileSync(path, 'utf8'), before);
    await assert.rejects(start({ ...value, units: [{ ...value.units[0], port: value.units[0].port + 1 }] }), /配置与本次请求不同/);
    await ready(value.units[0].ready);
    await stop('web', value.directory);
    assert.equal(existsSync(path), false); // stop now waits for release, not just an acknowledgement.
    await assertPortFree(value.units[0].port, '127.0.0.1');
    assert.equal(await running, 0);
  } finally { await stop('web', value.directory); await running; rmSync(value.directory, { recursive: true, force: true }); }
});

test('all mode reuses an existing unit and starts only the missing unit', async () => {
  const value = await fixture();
  const first = start(value, { noBuild: true });
  let second;
  try {
    await ready(value.units[0].ready);
    const path = join(value.directory, '.runtime/launchers/web.json');
    const before = readFileSync(path, 'utf8');
    const port = await freePort();
    const extra = { ...value.units[0], key: 'desktop', port, ready: `http://127.0.0.1:${port}/`, env: { ...process.env, TEST_PORT: String(port) } };
    second = start({ ...value, mode: 'all', units: [value.units[0], extra] }, { noBuild: true });
    await ready(extra.ready);
    assert.equal(readFileSync(path, 'utf8'), before);
    await stop('desktop', value.directory);
    assert.equal(await second, 0);
    await ready(value.units[0].ready); // The new launcher does not own the reused unit.
  } finally { await stop('all', value.directory); await second; await first; rmSync(value.directory, { recursive: true, force: true }); }
});

test('simultaneous double click creates one lifecycle and joins the other request', async () => {
  const value = await fixture();
  const first = start(value, { noBuild: true });
  const second = start(value, { noBuild: true });
  try {
    await ready(value.units[0].ready);
    assert.equal(await Promise.race([first, second]), 0);
    await ready(value.units[0].ready);
    await stop('web', value.directory);
    assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  } finally { await stop('web', value.directory); await Promise.allSettled([first, second]); rmSync(value.directory, { recursive: true, force: true }); }
});

test('build failure never starts services and is not reported as success', async () => {
  const value = await fixture();
  value.build = 'fail';
  writeFileSync(join(value.directory, 'package.json'), JSON.stringify({ private: true, scripts: { fail: 'node -e "process.exit(19)"' } }));
  try {
    assert.equal(await start(value), 19);
    await assertPortFree(value.units[0].port, '127.0.0.1');
  } finally { rmSync(value.directory, { recursive: true, force: true }); }
});

test('built server serves root/admin/health and shuts down using isolated data', {
  skip: !existsSync(join(root, 'apps/sync-server/dist/server.mjs')) || !existsSync(join(root, 'apps/web/dist/index.html')),
}, async () => {
  const isolated = await fixture();
  const value = plan('server', { ...process.env, PORT: String(isolated.units[0].port),
    HOST: '127.0.0.1', BASE_PATH: '/smoke', DATA_DIR: join(isolated.directory, 'data'),
    WEB_DIST: join(root, 'apps/web/dist'), REGISTRATION_MODE: 'invite', ALLOW_INSECURE_HTTP: '0' });
  value.directory = isolated.directory;
  value.build = null; // Artifacts are prerequisites; never build or write launcher records in the user's data directory.
  const running = start(value);
  try {
    await ready(value.units[0].ready, 30_000);
    for (const url of value.urls) {
      const response = await fetch(url);
      assert.equal(response.status, 200, url);
      await response.body.cancel();
    }
    await stop('server', value.directory);
    assert.equal(await running, 0);
    assert.equal(existsSync(join(value.directory, '.runtime/launchers/server.json')), false);
    await assertPortFree(value.units[0].port, '127.0.0.1');
  } finally {
    await stop('server', value.directory);
    await running;
    rmSync(value.directory, { recursive: true, force: true });
  }
});
