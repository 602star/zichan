import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { buildSync } from 'esbuild';

const root = mkdtempSync(join(tmpdir(), 'zichan-backup-supervisor-'));
const entry = join(root, 'server.mjs');
const children = new Set();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(read, message) {
  const end = Date.now() + 25_000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100); }
  throw new Error(message);
}
function json(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } }
async function unusedPort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
const now = new Date();
const start = new Date(now.getTime() - 60_000); const end = new Date(now.getTime() + 5 * 60_000);
const hm = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
async function launch(dataDir, backupDirectory) {
  const port = await unusedPort();
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', CONTROL_STDIN: '1', ENABLE_WEB: '0',
      ADMIN_BACKUP_AUTO: 'on', ADMIN_BACKUP_DIRECTORY: backupDirectory, ADMIN_BACKUP_WINDOW: `每天 ${hm(start)}-${hm(end)}` },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  children.add(child);
  let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
  child.once('exit', () => children.delete(child));
  await until(() => {
    if (child.exitCode !== null) throw new Error(output);
    return existsSync(join(dataDir, 'server.pid'));
  }, 'server did not start');
  return { child, port, output: () => output, initialPid: json(join(dataDir, 'server.pid')).pid };
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const closed = once(child, 'exit'); child.stdin.write('shutdown\n');
  const [code] = await closed; assert.equal(code, 0);
}
try {
  buildSync({ entryPoints: [resolve('apps/sync-server/src/main.ts')], outfile: entry, bundle: true, platform: 'node', target: 'node22', format: 'esm' });
  const data = join(root, 'data'); const backups = join(root, 'backups');
  const first = await launch(data, backups);
  await until(() => json(join(data, 'backup-executor.json'))?.lastResult === 'completed', first.output());
  assert.notEqual(json(join(data, 'server.pid')).pid, first.initialPid);
  assert.equal((await fetch(`http://127.0.0.1:${first.port}/api/health`)).status, 200);
  assert.equal(readdirSync(backups).length, 1);
  const record = json(join(data, 'maintenance', readdirSync(join(data, 'maintenance'))[0]));
  assert.equal(record.kind, 'scheduled'); assert.equal(record.verification.ok, true);
  assert.ok(existsSync(join(record.outputPath, 'manifest.json')));
  await stop(first.child);
  assert.equal(existsSync(join(data, 'server.pid')), false);
  assert.equal(existsSync(join(data, 'backup-executor.lock')), false);
  const second = await launch(data, backups);
  await until(() => json(join(data, 'backup-executor.json'))?.status === 'waiting', second.output());
  assert.equal(readdirSync(backups).length, 1);
  assert.equal(json(join(data, 'server.pid')).pid, second.initialPid);
  await stop(second.child);

  const failedData = join(root, 'failed-data'); const blocked = join(root, 'blocked');
  writeFileSync(blocked, 'a file, not a directory');
  const failure = await launch(failedData, blocked);
  await until(() => json(join(failedData, 'backup-executor.json'))?.lastResult === 'failed', failure.output());
  assert.notEqual(json(join(failedData, 'server.pid')).pid, failure.initialPid);
  assert.equal((await fetch(`http://127.0.0.1:${failure.port}/api/health`)).status, 200);
  const failedRecord = json(join(failedData, 'maintenance', readdirSync(join(failedData, 'maintenance'))[0]));
  assert.equal(failedRecord.status, 'failed'); assert.ok(failedRecord.errorMessage);
  await stop(failure.child);
  console.log('backup-supervisor-ok: verified backup, restart deduplication, failure recovery');
} finally {
  for (const child of children) await stop(child);
  // This absolute target is the single directory returned by mkdtemp above.
  if (!resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/') + 'zichan-backup-supervisor-')) throw new Error('unsafe temporary path');
  rmSync(root, { recursive: true, force: true });
}
