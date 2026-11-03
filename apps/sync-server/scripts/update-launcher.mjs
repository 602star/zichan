import { spawn } from 'node:child_process';
import { appendFile, cp, mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifiedPreUpdateBackup } from './pre-update-backup.mjs';

const runtime = process.env.ZICHAN_UPDATE_RUNTIME_DIR || '/app/runtime';
const releases = join(runtime, 'releases');
const current = join(runtime, 'current');
const pendingFile = join(runtime, 'pending.json');
const statusFile = join(runtime, 'update-result.json');
const historyFile = join(runtime, 'update-history.jsonl');
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const targetPattern = /^releases\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const taskPattern = /^[a-f0-9-]{36}$/;
let child;
let stopping = false;

async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}

async function recordResult(update, state, error) {
  const at = new Date().toISOString();
  const result = { taskId: update.taskId, version: update.version, state,
    operation: update.operation || 'update', backupPath: update.backupPath, error, at };
  await atomicJson(statusFile, result);
  await appendFile(historyFile, JSON.stringify({ state, currentVersion: state === 'success' ? update.version : update.from.slice('releases/v'.length),
    fromVersion: update.from.slice('releases/v'.length),
    targetVersion: update.version, taskId: update.taskId, operation: result.operation, actor: update.actor,
    backupPath: update.backupPath, error, updatedAt: at }) + '\n', { mode: 0o600 });
}

async function activate(target) {
  if (!targetPattern.test(target)) throw new Error('安装版本路径无效');
  await stat(join(runtime, target, 'dist', 'server.mjs'));
  const temp = join(runtime, `.current-${randomUUID()}`);
  await symlink(target, temp, 'dir');
  await rename(temp, current);
}

async function initialize() {
  await mkdir(releases, { recursive: true });
  try { await readlink(current); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const source = '/app/bootstrap/release';
    const packageJson = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (!versionPattern.test(packageJson.version)) throw new Error('镜像初始版本无效');
    const target = `releases/v${packageJson.version}`;
    const staging = join(runtime, `.bootstrap-${randomUUID()}`);
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
    await rm(join(runtime, target), { recursive: true, force: true });
    await rename(staging, join(runtime, target));
    await activate(target);
  }
  await trustedCurrent();
}

async function trustedCurrent() {
  const target = await readlink(current);
  if (!targetPattern.test(target)) throw new Error('当前版本链接无效');
  await stat(join(runtime, target, 'dist', 'server.mjs'));
  return target;
}

async function pending() {
  try {
    const value = JSON.parse(await readFile(pendingFile, 'utf8'));
    if (!taskPattern.test(value.taskId) || !targetPattern.test(value.from) || !targetPattern.test(value.to)
      || !versionPattern.test(value.version)
      || value.to !== `releases/v${value.version}`) throw new Error('待确认更新状态无效');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ready(version, exited) {
  const rawBase = (process.env.BASE_PATH || '').replace(/\/$/, '');
  const base = rawBase && !rawBase.startsWith('/') ? `/${rawBase}` : rawBase;
  const port = Number(process.env.PORT || 8787);
  for (let attempt = 0; attempt < 60 && !stopping && !exited(); attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${base}/api/health`,
        { signal: AbortSignal.timeout(1000), cache: 'no-store' });
      if (response.ok && (await response.json()).version === version) {
        const probe = await fetch(`http://127.0.0.1:${port}${base}/api/ready`,
          { signal: AbortSignal.timeout(1000), cache: 'no-store' });
        if (probe.ok) return true;
      }
    } catch { /* The new process may still be booting. */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function run() {
  await initialize();
  while (!stopping) {
    const target = await trustedCurrent();
    const update = await pending();
    if (update && target === update.from) {
      await activate(update.to);
      continue;
    }
    if (update && target !== update.to) throw new Error('待确认版本与当前链接不一致');
    if (update) {
      try {
        if (process.env.ZICHAN_UPDATE_REQUIRE_BACKUP === '1') {
          update.backupPath = await verifiedPreUpdateBackup({ runtime, update,
            backupRoot: process.env.ADMIN_BACKUP_DIRECTORY, dataDir: process.env.DATA_DIR || '/state/server' });
        }
      } catch (error) {
        await activate(update.from);
        await recordResult(update, 'failed', `切换前备份失败：${error instanceof Error ? error.message : String(error)}`);
        await rm(pendingFile);
        continue;
      }
    }
    if (stopping) break;
    child = spawn(process.execPath, [join(runtime, target, 'dist', 'server.mjs')], {
      env: { ...process.env, WEB_DIST: join(runtime, target, 'web-dist'),
        ZICHAN_UPDATE_RUNTIME_DIR: runtime, ZICHAN_UPDATE_LAUNCHER: '1' },
      stdio: 'inherit',
    });
    let exited = false;
    const completion = new Promise((resolve) => {
      child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
      child.once('error', (error) => { exited = true; resolve({ error }); });
    });
    if (update) {
      const healthy = await ready(update.version, () => exited);
      if (healthy) {
        await recordResult(update, 'success');
        await rm(pendingFile);
      } else if (!stopping) {
        if (!exited) { child.kill('SIGTERM'); await completion; }
        await activate(update.from);
        await recordResult(update, 'failed', '目标版本未在 60 秒内通过健康检查，已切回先前版本');
        await rm(pendingFile);
        continue;
      }
    }
    const result = await completion;
    if (stopping) break;
    if (await pending()) continue;
    throw new Error(`服务进程退出：${JSON.stringify(result)}`);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { stopping = true; child?.kill(signal); });
}
run().catch((error) => {
  console.error('Update launcher:', error);
  child?.kill('SIGTERM');
  process.exitCode = 1;
});
