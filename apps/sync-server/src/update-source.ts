import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const MAX_FEED_BYTES = 4096;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const RELEASE_ASSET = /^zichan-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.json$/;
const FEED_ASSET = /^zichan-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.feed\.json$/;

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(BigInt);
  const rightParts = right.split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index]! > rightParts[index]!) return 1;
    if (leftParts[index]! < rightParts[index]!) return -1;
  }
  return 0;
}

interface GithubAsset { id: number; name: string; size: number }
interface GithubRelease { tag_name: string; draft: boolean; prerelease: boolean; assets: GithubAsset[] }

async function boundedResponse(url: string, limit: number, init?: RequestInit,
  onProgress?: (received: number, total?: number) => void, allowGithubAssetRedirect = false): Promise<Buffer> {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (response.status === 302 || response.status === 301) {
    if (!allowGithubAssetRedirect) throw new Error('更新源不允许重定向');
    const location = response.headers.get('location');
    if (!location) throw new Error('更新源重定向缺少地址');
    const target = new URL(location);
    if (target.protocol !== 'https:' || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) {
      throw new Error('更新源重定向地址不可信');
    }
    return boundedResponse(target.href, limit, undefined, onProgress);
  }
  if (!response.ok || !response.body) throw new Error(`更新源响应 HTTP ${response.status}`);
  const chunks: Buffer[] = [];
  let size = 0;
  const length = Number(response.headers.get('content-length'));
  const total = Number.isSafeInteger(length) && length > 0 ? length : undefined;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error('更新文件超过大小限制');
    chunks.push(bytes);
    onProgress?.(size, total);
  }
  return Buffer.concat(chunks);
}

function configuredSource(): 'directory' | 'url' | 'github' {
  const selected = [process.env.UPDATE_FEED_DIR, process.env.UPDATE_FEED_URL, process.env.UPDATE_GITHUB_REPO].filter((value) => value?.trim());
  if (selected.length !== 1) throw new Error('请且只配置一个更新源');
  return process.env.UPDATE_FEED_DIR?.trim() ? 'directory' : process.env.UPDATE_FEED_URL?.trim() ? 'url' : 'github';
}

async function githubToken(): Promise<string> {
  const path = process.env.UPDATE_GITHUB_TOKEN_FILE?.trim();
  if (!path) throw new Error('私有 GitHub 更新源缺少只读 Token 文件');
  const token = (await readFile(path, 'utf8')).trim();
  if (!/^(?:ghp_|github_pat_|ghs_)[A-Za-z0-9_]{20,}$/.test(token)) throw new Error('GitHub Token 文件无效');
  return token;
}

function githubRepo(): string {
  const repo = process.env.UPDATE_GITHUB_REPO?.trim() ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('GitHub 仓库格式无效');
  return repo;
}

async function githubReleases(): Promise<GithubRelease[]> {
  const response = await boundedResponse(`https://api.github.com/repos/${githubRepo()}/releases?per_page=100`, 1024 * 1024,
    { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${await githubToken()}`, 'User-Agent': 'zichan-updater' } });
  const releases = JSON.parse(response.toString('utf8')) as GithubRelease[];
  if (!Array.isArray(releases)) throw new Error('GitHub 发布列表无效');
  return releases.filter((release) => release && !release.draft && !release.prerelease
    && VERSION.test(release.tag_name?.slice(1) ?? '') && release.tag_name.startsWith('v')
    && Array.isArray(release.assets));
}

async function githubAsset(release: GithubRelease, name: string, limit: number,
  onProgress?: (received: number, total?: number) => void): Promise<Buffer> {
  const asset = release.assets.find((entry) => entry.name === name);
  if (!asset || !Number.isSafeInteger(asset.id) || asset.size > limit) throw new Error(`GitHub 发布缺少有效资产 ${name}`);
  return boundedResponse(`https://api.github.com/repos/${githubRepo()}/releases/assets/${asset.id}`, limit,
    { headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${await githubToken()}`, 'User-Agent': 'zichan-updater' } }, onProgress, true);
}

export async function readUpdateAsset(name: string, limit: number, version?: string,
  onProgress?: (received: number, total?: number) => void): Promise<Buffer> {
  if (name !== 'latest.json' && !RELEASE_ASSET.test(name) && !FEED_ASSET.test(name)) throw new Error('更新资产名称无效');
  const source = configuredSource();
  if (source === 'directory') {
    const directory = resolve(process.env.UPDATE_FEED_DIR!.trim());
    const file = join(directory, name);
    if ((await stat(file)).size > limit) throw new Error('更新文件超过大小限制');
    const bytes = await readFile(file);
    if (bytes.length > limit) throw new Error('更新文件超过大小限制');
    onProgress?.(bytes.length, bytes.length);
    return bytes;
  }
  if (source === 'url') {
    const url = new URL(process.env.UPDATE_FEED_URL!.trim());
    if (url.protocol !== 'https:' || url.username || url.password
      || basename(url.pathname) !== 'latest.json' || url.search || url.hash) {
      throw new Error('远程更新源必须是 HTTPS latest.json');
    }
    return boundedResponse(new URL(name, url).href, limit, undefined, onProgress);
  }
  const releases = await githubReleases();
  const release = version
    ? releases.find((entry) => entry.tag_name === `v${version}`)
    : releases.sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
  if (!release) throw new Error('GitHub 没有可用的稳定版发布');
  return githubAsset(release, name, limit, onProgress);
}

export async function listUpdateFeedVersions(): Promise<string[]> {
  const source = configuredSource();
  if (source === 'directory') {
    return (await readdir(resolve(process.env.UPDATE_FEED_DIR!.trim())))
      .filter((name) => FEED_ASSET.test(name))
      .map((name) => name.slice('zichan-'.length, -'.feed.json'.length));
  }
  if (source === 'github') return (await githubReleases()).map((entry) => entry.tag_name.slice(1));
  return [];
}

export function updateSourceConfigured(): boolean {
  return Boolean(process.env.UPDATE_FEED_DIR || process.env.UPDATE_FEED_URL || process.env.UPDATE_GITHUB_REPO);
}

export const UPDATE_FEED_LIMIT = MAX_FEED_BYTES;
