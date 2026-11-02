import { createHash, randomUUID, verify } from 'node:crypto';
import { appendFileSync, fsyncSync, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CURRENT_SERVER_SCHEMA, CURRENT_SERVER_SCHEMA_NAME } from './store.js';
import { acquireMaintenanceLock } from './maintenance-lock.js';
import { readUpdateAsset, listUpdateFeedVersions, updateSourceConfigured, UPDATE_FEED_LIMIT } from './update-source.js';

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const VERSION = /^0\.3\.(0|[1-9]\d*)$/;
const ASSET = /^zichan-0\.3\.(?:0|[1-9]\d*)\.json$/;
const FILE = /^(?:dist\/(?:server|maintenance)\.mjs|web-dist\/[A-Za-z0-9._/-]+)$/;

interface Feed { format: 'zichan-update-feed-v1'; version: string; artifact: string; sha256: string; signature: string }
interface Release { format: 'zichan-release-v1'; version: string; schema: { version: number; name: string }; files: { path: string; data: string }[] }
export interface UpdateStatus { state: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'installing' | 'restarting' | 'success' | 'failed'; currentVersion: string; fromVersion?: string; targetVersion?: string; taskId?: string; operation?: 'update' | 'rollback'; actor?: string; percent?: number; downloadedBytes?: number; totalBytes?: number; error?: string; updatedAt: string }

export function comparePatch(left: string, right: string): number {
  if (!VERSION.test(left) || !VERSION.test(right)) throw new Error('仅支持 0.3.x 稳定版');
  return Number(left.split('.')[2]) - Number(right.split('.')[2]);
}

export function signedFeedText(feed: Pick<Feed, 'format' | 'version' | 'artifact' | 'sha256'>): string {
  return `${feed.format}\n${feed.version}\n${feed.artifact}\n${feed.sha256}\n`;
}

export function parseFeed(value: unknown, publicKey: string): Feed {
  const feed = value as Feed;
  if (!feed || feed.format !== 'zichan-update-feed-v1' || !VERSION.test(feed.version)
    || !ASSET.test(feed.artifact) || feed.artifact !== `zichan-${feed.version}.json`
    || !/^[a-f0-9]{64}$/.test(feed.sha256) || !/^[A-Za-z0-9+/=]{80,100}$/.test(feed.signature)) {
    throw new Error('更新清单格式无效');
  }
  if (!verify(null, Buffer.from(signedFeedText(feed)), publicKey, Buffer.from(feed.signature, 'base64'))) {
    throw new Error('更新清单签名无效');
  }
  return feed;
}

async function latest(): Promise<Feed> {
  const publicKeyPath = process.env.UPDATE_PUBLIC_KEY_PATH?.trim();
  if (!publicKeyPath) throw new Error('未配置更新签名公钥');
  const publicKey = await readFile(publicKeyPath, 'utf8');
  return parseFeed(JSON.parse((await readUpdateAsset('latest.json', UPDATE_FEED_LIMIT)).toString('utf8')), publicKey);
}

function appendJournal(runtime: string, status: UpdateStatus): void {
  if (!status.taskId) return;
  const path = join(runtime, 'update-history.jsonl');
  const handle = openSync(path, 'a', 0o600);
  try { appendFileSync(handle, JSON.stringify(status) + '\n'); fsyncSync(handle); }
  finally { closeSync(handle); }
}

async function history(runtime: string): Promise<UpdateStatus[]> {
  try {
    const lines = (await readFile(join(runtime, 'update-history.jsonl'), 'utf8')).trim().split('\n');
    const latestByTask = new Map<string, UpdateStatus>();
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as UpdateStatus;
        if (event.taskId) latestByTask.set(event.taskId, event);
      } catch { /* Ignore an incomplete final line after an interrupted append. */ }
    }
    return [...latestByTask.values()].reverse().slice(0, 50);
  } catch { return []; }
}

export function parseRelease(bytes: Buffer, expected: Feed): Release {
  if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('更新包 SHA256 不匹配');
  const release = JSON.parse(bytes.toString('utf8')) as Release;
  if (release.format !== 'zichan-release-v1' || release.version !== expected.version
    || release.schema?.version !== CURRENT_SERVER_SCHEMA || release.schema?.name !== CURRENT_SERVER_SCHEMA_NAME
    || !Array.isArray(release.files)
    || release.files.length < 2 || release.files.length > 500) throw new Error('更新包内容无效');
  const names = new Set<string>();
  let decoded = 0;
  for (const file of release.files) {
    if (!file || typeof file.path !== 'string' || !FILE.test(file.path) || file.path.includes('..')
      || file.path.includes('//') || typeof file.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)
      || names.has(file.path)) throw new Error('更新包含有非法文件');
    names.add(file.path);
    decoded += Buffer.byteLength(file.data, 'base64');
    if (decoded > MAX_ARTIFACT_BYTES) throw new Error('更新包解压后超过大小限制');
  }
  if (!names.has('dist/server.mjs') || !names.has('dist/maintenance.mjs')
    || !names.has('web-dist/index.html')) throw new Error('更新包缺少启动文件或页面');
  return release;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}

async function currentTarget(runtime: string): Promise<string> {
  const { readlink } = await import('node:fs/promises');
  return readlink(join(runtime, 'current'));
}

async function switchTo(runtime: string, release: string): Promise<void> {
  const temp = join(runtime, `.current-${randomUUID()}`);
  await symlink(`releases/${release}`, temp, 'dir');
  await rename(temp, join(runtime, 'current'));
}

export function createUpdater(currentVersion: string, dataDir: string) {
  const runtime = process.env.ZICHAN_UPDATE_RUNTIME_DIR?.trim();
  const enabled = process.platform === 'linux' && Boolean(runtime && process.env.ZICHAN_UPDATE_LAUNCHER === '1'
    && process.env.UPDATE_PUBLIC_KEY_PATH && updateSourceConfigured());
  let status: UpdateStatus = { state: 'idle', currentVersion, updatedAt: new Date().toISOString() };
  let busy = false;
  const set = (state: UpdateStatus['state'], patch: Partial<UpdateStatus> = {}) => {
    const changed = status.state !== state;
    status = { ...status, ...patch, state, updatedAt: new Date().toISOString() };
    if (changed && runtime && status.taskId) {
      try { appendJournal(runtime, status); }
      catch (error) { console.error('更新历史写入失败', error); }
    }
  };
  const check = async () => {
    if (!enabled) return { enabled, status, reason: '此部署未启用 Linux 签名包自更新' };
    if (busy) return { enabled, status };
    if (runtime && await stat(join(runtime, 'pending.json')).then(() => true, () => false)) {
      return { enabled, status };
    }
    set('checking', { taskId: undefined, operation: undefined, actor: undefined, fromVersion: undefined, percent: undefined,
      downloadedBytes: undefined, totalBytes: undefined });
    try {
      const feed = await latest();
      const available = comparePatch(feed.version, currentVersion) > 0;
      set(available ? 'available' : 'current', { targetVersion: feed.version, error: undefined });
      return { enabled, status, available };
    } catch (error) {
      set('failed', { error: error instanceof Error ? error.message : String(error) });
      return { enabled, status, available: false };
    }
  };
  const apply = async (version: string, actor: string): Promise<UpdateStatus> => {
    if (!enabled || !runtime) throw new Error('此部署未启用自更新');
    if (busy) throw new Error('已有更新任务正在执行');
    if (!VERSION.test(version) || comparePatch(version, currentVersion) <= 0) throw new Error('目标版本必须高于当前 0.3.x 版本');
    if (await stat(join(runtime, 'pending.json')).then(() => true, () => false)) throw new Error('已有待确认更新');
    busy = true;
    const taskId = randomUUID();
    set('downloading', { taskId, operation: 'update', actor, fromVersion: currentVersion, targetVersion: version, error: undefined,
      percent: 0, downloadedBytes: 0, totalBytes: undefined });
    void (async () => {
      let releaseLock: (() => void) | undefined;
      let pendingWritten = false;
      let switched = false;
      try {
        releaseLock = acquireMaintenanceLock(dataDir, `update:${taskId}`);
        if (!releaseLock) throw new Error('服务器正在执行其他维护操作，请稍后重试');
        if (await stat(join(runtime, 'pending.json')).then(() => true, () => false)) throw new Error('已有待确认更新');
        const feed = await latest();
        if (feed.version !== version) throw new Error('目标版本已不在最新签名清单中，请重新检查');
        const bytes = await readUpdateAsset(feed.artifact, MAX_ARTIFACT_BYTES, version, (received, total) => {
          status = { ...status, downloadedBytes: received, totalBytes: total,
            percent: total ? Math.min(100, Math.floor(received / total * 100)) : undefined };
        });
        const release = parseRelease(bytes, feed);
        set('installing');
        const target = `v${version}`;
        const staging = join(runtime, `.${target}-${randomUUID()}`);
        try {
          await mkdir(staging, { recursive: false });
          for (const file of release.files) {
            const path = join(staging, file.path);
            if (!path.startsWith(staging + '/')) throw new Error('更新路径越界');
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: 0o644 });
          }
          // A failed health check leaves the rejected version for diagnosis. A fresh signed
          // package may replace that inactive directory, but never the running release.
          if (await currentTarget(runtime) === `releases/${target}`) throw new Error('目标版本已在运行');
          await rm(join(runtime, 'releases', target), { recursive: true, force: true });
          await rename(staging, join(runtime, 'releases', target));
        } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
        const previous = await currentTarget(runtime);
        await atomicJson(join(runtime, 'pending.json'), { taskId, from: previous, to: `releases/${target}`, version, actor, operation: 'update', at: new Date().toISOString() });
        pendingWritten = true;
        await switchTo(runtime, target);
        switched = true;
        set('restarting');
        setTimeout(() => process.send?.({ updateRestart: true }), 1000).unref();
      } catch (error) {
        if (pendingWritten && !switched) await rm(join(runtime, 'pending.json'), { force: true }).catch(() => undefined);
        set('failed', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        try { releaseLock?.(); }
        catch (error) { set('failed', { error: error instanceof Error ? error.message : String(error) }); }
        busy = false;
      }
    })();
    return status;
  };
  const getStatus = async () => {
    if (!enabled || !runtime) {
      return { enabled, status, available: status.state === 'available' };
    }
    try {
      const result = JSON.parse(await readFile(join(runtime, 'update-result.json'), 'utf8')) as {
        taskId: string; version: string; state: 'success' | 'failed'; operation?: 'update' | 'rollback'; error?: string; at: string;
      };
      if (result.state === 'success' && result.version !== currentVersion) return { enabled, status };
      const previous = (await history(runtime)).find((entry) => entry.taskId === result.taskId);
      if (previous && previous.state !== result.state) {
        try { appendJournal(runtime, { ...previous, state: result.state, currentVersion,
          operation: result.operation ?? previous.operation, error: result.error, updatedAt: result.at }); }
        catch (error) { console.error('更新结果历史写入失败', error); }
      }
      if (status.state !== 'idle') return { enabled, status, available: status.state === 'available' };
      return { enabled, available: false, status: { state: result.state, currentVersion,
        fromVersion: previous?.fromVersion, targetVersion: result.version, taskId: result.taskId, operation: result.operation ?? previous?.operation,
        error: result.error, updatedAt: result.at } };
    } catch { return { enabled, status, available: false }; }
  };
  const versions = async () => {
    if (!enabled || !runtime) return { installed: [], published: [] };
    const installed = (await readdir(join(runtime, 'releases')))
      .filter((name) => /^v0\.3\.(?:0|[1-9]\d*)$/.test(name));
    const published = await listUpdateFeedVersions().catch(() => []);
    return { installed: installed.map((name) => name.slice(1)).sort((a, b) => comparePatch(b, a)),
      published: published.sort((a, b) => comparePatch(b, a)) };
  };
  const rollback = async (version: string, actor: string): Promise<UpdateStatus> => {
    if (!enabled || !runtime) throw new Error('此部署未启用自更新');
    if (busy) throw new Error('已有更新任务正在执行');
    if (!VERSION.test(version) || comparePatch(version, currentVersion) >= 0) throw new Error('只能回滚到更早的 0.3.x 版本');
    const target = `v${version}`;
    if (!(await versions()).installed.includes(version)) throw new Error('目标版本未安装');
    for (const name of ['dist/server.mjs', 'dist/maintenance.mjs', 'web-dist/index.html']) {
      if (!(await stat(join(runtime, 'releases', target, name))).isFile()) throw new Error('目标版本文件不完整');
    }
    if (await stat(join(runtime, 'pending.json')).then(() => true, () => false)) throw new Error('已有待确认更新');
    const taskId = randomUUID();
    const previous = await currentTarget(runtime);
    if (previous !== `releases/v${currentVersion}`) throw new Error('当前运行版本与版本目录不一致');
    const releaseLock = acquireMaintenanceLock(dataDir, `rollback:${taskId}`);
    if (!releaseLock) throw new Error('服务器正在执行其他维护操作，请稍后重试');
    busy = true;
    try {
      set('installing', { taskId, operation: 'rollback', actor, fromVersion: currentVersion, targetVersion: version, error: undefined });
      await atomicJson(join(runtime, 'pending.json'), { taskId, from: previous, to: `releases/${target}`, version, actor,
        operation: 'rollback', at: new Date().toISOString() });
      await switchTo(runtime, target);
      set('restarting');
      setTimeout(() => process.send?.({ updateRestart: true }), 1000).unref();
      return status;
    } catch (error) {
      await rm(join(runtime, 'pending.json'), { force: true }).catch(() => undefined);
      set('failed', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { releaseLock(); busy = false; }
  };
  return { enabled, check, apply, rollback, versions, history: async () => {
    await getStatus();
    return runtime ? history(runtime) : [];
  }, status: getStatus };
}
