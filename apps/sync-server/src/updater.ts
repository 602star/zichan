import { createHash, randomUUID, verify } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CURRENT_SERVER_SCHEMA, CURRENT_SERVER_SCHEMA_NAME } from './store.js';
import { acquireMaintenanceLock } from './maintenance-lock.js';

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const VERSION = /^0\.3\.(0|[1-9]\d*)$/;
const ASSET = /^zichan-0\.3\.(?:0|[1-9]\d*)\.json$/;
const FILE = /^(?:dist\/(?:server|maintenance)\.mjs|web-dist\/[A-Za-z0-9._/-]+)$/;

interface Feed { format: 'zichan-update-feed-v1'; version: string; artifact: string; sha256: string; signature: string }
interface Release { format: 'zichan-release-v1'; version: string; schema: { version: number; name: string }; files: { path: string; data: string }[] }
export interface UpdateStatus { state: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'installing' | 'restarting' | 'success' | 'failed'; currentVersion: string; targetVersion?: string; taskId?: string; error?: string; updatedAt: string }

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

async function boundedResponse(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`更新源响应 HTTP ${response.status}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) { await response.body.cancel().catch(() => undefined); throw new Error('更新文件超过大小限制'); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function source(): { directory?: string; url?: URL } {
  const directory = process.env.UPDATE_FEED_DIR?.trim();
  const rawUrl = process.env.UPDATE_FEED_URL?.trim();
  if (Boolean(directory) === Boolean(rawUrl)) throw new Error('请配置 UPDATE_FEED_DIR 或 UPDATE_FEED_URL 中的一项');
  if (directory) return { directory: resolve(directory) };
  const url = new URL(rawUrl!);
  if (url.protocol !== 'https:') throw new Error('远程更新源必须使用 HTTPS');
  if (basename(url.pathname) !== 'latest.json' || url.search || url.hash) throw new Error('更新源必须指向 latest.json');
  return { url };
}

async function readSource(asset: string, limit: number): Promise<Buffer> {
  const configured = source();
  if (configured.directory) {
    const path = join(configured.directory, asset);
    if ((await stat(path)).size > limit) throw new Error('更新文件超过大小限制');
    const bytes = await readFile(path);
    if (bytes.length > limit) throw new Error('更新文件超过大小限制');
    return bytes;
  }
  return boundedResponse(new URL(asset, configured.url).href, limit);
}

async function latest(): Promise<Feed> {
  const publicKeyPath = process.env.UPDATE_PUBLIC_KEY_PATH?.trim();
  if (!publicKeyPath) throw new Error('未配置更新签名公钥');
  const publicKey = await readFile(publicKeyPath, 'utf8');
  return parseFeed(JSON.parse((await readSource('latest.json', 4096)).toString('utf8')), publicKey);
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
    && process.env.UPDATE_PUBLIC_KEY_PATH && (process.env.UPDATE_FEED_DIR || process.env.UPDATE_FEED_URL));
  let status: UpdateStatus = { state: 'idle', currentVersion, updatedAt: new Date().toISOString() };
  let busy = false;
  const set = (state: UpdateStatus['state'], patch: Partial<UpdateStatus> = {}) => {
    status = { ...status, ...patch, state, updatedAt: new Date().toISOString() };
  };
  const check = async () => {
    if (!enabled) return { enabled, status, reason: '此部署未启用 Linux 签名包自更新' };
    if (busy) return { enabled, status };
    set('checking');
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
    busy = true;
    const taskId = randomUUID();
    set('downloading', { taskId, targetVersion: version, error: undefined });
    void (async () => {
      let releaseLock: (() => void) | undefined;
      let pendingWritten = false;
      let switched = false;
      try {
        releaseLock = acquireMaintenanceLock(dataDir, `update:${taskId}`);
        if (!releaseLock) throw new Error('服务器正在执行其他维护操作，请稍后重试');
        const feed = await latest();
        if (feed.version !== version) throw new Error('目标版本已不在最新签名清单中，请重新检查');
        const release = parseRelease(await readSource(feed.artifact, MAX_ARTIFACT_BYTES), feed);
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
        await atomicJson(join(runtime, 'pending.json'), { taskId, from: previous, to: `releases/${target}`, version, actor, at: new Date().toISOString() });
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
    if (!enabled || !runtime || status.state !== 'idle') {
      return { enabled, status, available: status.state === 'available' };
    }
    try {
      const result = JSON.parse(await readFile(join(runtime, 'update-result.json'), 'utf8')) as {
        taskId: string; version: string; state: 'success' | 'failed'; error?: string; at: string;
      };
      if (result.state === 'success' && result.version !== currentVersion) return { enabled, status };
      return { enabled, available: false, status: { state: result.state, currentVersion,
        targetVersion: result.version, taskId: result.taskId, error: result.error, updatedAt: result.at } };
    } catch { return { enabled, status, available: false }; }
  };
  return { enabled, check, apply, status: getStatus };
}
