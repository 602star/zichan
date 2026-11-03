import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { test } from 'node:test';

const launcher = resolve(import.meta.dirname, '../../../apps/sync-server/scripts/update-launcher.mjs');
const fakeServer = `
import { createServer } from 'node:http';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
const version = /releases\\/v(0\\.4\\.\\d+)\\//.exec(import.meta.url)?.[1];
const pidFile = join(process.env.DATA_DIR, 'fake-server.pid');
await writeFile(pidFile, String(process.pid));
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/api/health'
    ? { ok: true, version } : { ok: true, mode: 'light', database: { ok: true, result: 'ok' } }));
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(async () => { await rm(pidFile, { force: true }); process.exit(0); }));
`;
const fakeMaintenance = `
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf('--' + name) + 1];
const state = option('data-dir');
const backup = args[0] === 'backup' ? option('output') : option('backup');
if (args[0] === 'backup') {
  const pid = await readFile(join(state, 'fake-server.pid'), 'utf8').catch(() => '');
  if (pid) throw new Error('server still running');
  await mkdir(backup);
  await copyFile(join(state, 'data.txt'), join(backup, 'data.txt'));
  await writeFile(join(backup, 'manifest.json'), '{}');
} else if (args[0] === 'verify-backup') {
  if (process.env.FAIL_BACKUP_VERIFY === '1') throw new Error('injected verify failure');
  if (await readFile(join(backup, 'data.txt'), 'utf8') !== 'existing account and attachment') throw new Error('data changed');
} else throw new Error('unknown command');
`;

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeout = 15000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { return await check(); }
    catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw last || new Error('Timed out');
}

async function scenario(verifyFailure) {
  const root = await mkdtemp(join(tmpdir(), 'zichan-launcher-'));
  const runtime = join(root, 'runtime');
  const state = join(root, 'state');
  const backups = join(root, 'backups');
  await mkdir(state);
  await mkdir(backups);
  await writeFile(join(state, 'data.txt'), 'existing account and attachment');
  for (const version of ['0.4.0', '0.4.1']) {
    const dist = join(runtime, 'releases', `v${version}`, 'dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'server.mjs'), fakeServer);
    await writeFile(join(dist, 'maintenance.mjs'), fakeMaintenance);
  }
  await symlink('releases/v0.4.0', join(runtime, 'current'), 'dir');
  const port = await freePort();
  const child = spawn(process.execPath, [launcher], {
    env: { ...process.env, PORT: String(port), DATA_DIR: state, ADMIN_BACKUP_DIRECTORY: backups,
      ZICHAN_UPDATE_RUNTIME_DIR: runtime, ZICHAN_UPDATE_REQUIRE_BACKUP: '1',
      FAIL_BACKUP_VERIFY: verifyFailure ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const health = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (!response.ok) throw new Error('health unavailable');
    return response.json();
  };
  try {
    await waitFor(async () => assert.equal((await health()).version, '0.4.0'));
    const taskId = randomUUID();
    await writeFile(join(runtime, 'pending.json'), JSON.stringify({ taskId, from: 'releases/v0.4.0',
      to: 'releases/v0.4.1', version: '0.4.1', operation: 'update', actor: 'acceptance' }));
    const next = join(runtime, '.current-next');
    await symlink('releases/v0.4.1', next, 'dir');
    await rename(next, join(runtime, 'current'));
    process.kill(Number(await readFile(join(state, 'fake-server.pid'), 'utf8')), 'SIGTERM');
    const expected = verifyFailure ? '0.4.0' : '0.4.1';
    await waitFor(async () => {
      const result = JSON.parse(await readFile(join(runtime, 'update-result.json'), 'utf8'));
      assert.equal(result.state, verifyFailure ? 'failed' : 'success');
      assert.equal((await health()).version, expected);
      return result;
    });
    assert.equal(await readFile(join(state, 'data.txt'), 'utf8'), 'existing account and attachment');
    assert.equal(await readFile(join(backups, `pre-update-${taskId}`, 'data.txt'), 'utf8'), 'existing account and attachment');
  } catch (error) {
    throw new Error(`${error.message}\nLauncher output:\n${output}`, { cause: error });
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}

test('launcher backs up existing data before starting the target version and preserves it on failure',
  { skip: process.platform !== 'linux' }, async () => {
    await scenario(false);
    await scenario(true);
  });
