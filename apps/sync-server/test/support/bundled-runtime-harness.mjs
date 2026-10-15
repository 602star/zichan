import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const root = mkdtempSync(join(tmpdir(), '资产 生命周期-zichan-bundled-server-'));
const serverDir = join(root, 'server');
const entry = join(serverDir, 'server.mjs');
const dataDir = join(root, 'data', 'server');
const externalDataDir = join(root, 'external-server-data');
const inheritedWebDir = join(root, 'external-web');
let child;

try {
  mkdirSync(join(serverDir, 'web'), { recursive: true });
  writeFileSync(join(serverDir, 'web', 'index.html'), '<!doctype html><title>Bundled Web</title>');
  buildSync({
    entryPoints: [join(repoRoot, 'apps', 'desktop', 'scripts', 'bundled-server-entry.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
  });

  const missingEnv = { ...process.env };
  delete missingEnv.DATA_DIR;
  const missing = spawnSync(process.execPath, [entry], { env: missingEnv, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /缺少 DATA_DIR.*不会回退/);

  const outside = spawnSync(process.execPath, [entry], {
    env: { ...process.env, DATA_DIR: externalDataDir, PORT: '0' },
    encoding: 'utf8',
  });
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /DATA_DIR 必须严格等于.*拒绝写入其他目录/);
  assert.equal(existsSync(externalDataDir), false);

  child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      DATA_DIR: process.platform === 'win32' ? toNamespacedPath(dataDir) : dataDir,
      WEB_DIST: inheritedWebDir,
      PORT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`同步服务器启动超时：${stderr}`)), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!stdout.includes('zichan server ->') || !stdout.includes('account-admin=owner-session')) return;
      clearTimeout(timeout);
      resolveReady();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once('exit', (code) => {
      if (stdout.includes('zichan server ->') && stdout.includes('account-admin=owner-session')) return;
      clearTimeout(timeout);
      rejectReady(new Error(`同步服务器提前退出（${code}）：${stderr}`));
    });
  });

  assert.equal(existsSync(join(dataDir, 'server.pid')), true);
  assert.match(stdout, new RegExp(`webDir=${join(serverDir, 'web').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(stdout.includes(inheritedWebDir), false);

  const closed = once(child, 'close');
  child.stdin.write('shutdown\n');
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.equal(existsSync(join(dataDir, 'server.pid')), false);
  assert.match(stdout, /closing SQLite and HTTP server/);
  child = undefined;
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, 'close');
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

assert.equal(existsSync(root), false);
process.stdout.write('bundled-runtime-ok\n');
