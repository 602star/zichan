import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, createUpdater, parseFeed, parseRelease, reconcileLauncherResult, signedFeedText } from '../src/updater.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const release = Buffer.from(JSON.stringify({
  format: 'zichan-release-v1', version: '0.3.2',
  schema: { version: 27, name: 'single_user_replica_storage_v27' },
  files: [
    { path: 'dist/server.mjs', data: Buffer.from('server').toString('base64') },
    { path: 'dist/maintenance.mjs', data: Buffer.from('maintenance').toString('base64') },
    { path: 'web-dist/index.html', data: Buffer.from('web').toString('base64') },
  ],
}));
const unsigned = {
  format: 'zichan-update-feed-v1' as const, version: '0.3.2',
  artifact: 'zichan-0.3.2.json', sha256: createHash('sha256').update(release).digest('hex'),
};
const feed = {
  ...unsigned,
  signature: sign(null, Buffer.from(signedFeedText(unsigned)), privateKey).toString('base64'),
};

describe('signed stable self updates', () => {
  it('keeps an available update enabled while status polls before the first launcher result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zichan-update-status-'));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const names = ['UPDATE_FEED_DIR', 'UPDATE_FEED_URL', 'UPDATE_GITHUB_REPO',
      'UPDATE_PUBLIC_KEY_PATH', 'ZICHAN_UPDATE_RUNTIME_DIR', 'ZICHAN_UPDATE_LAUNCHER'] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      for (const name of names) delete process.env[name];
      process.env.UPDATE_FEED_DIR = directory;
      process.env.UPDATE_PUBLIC_KEY_PATH = join(directory, 'public.pem');
      process.env.ZICHAN_UPDATE_RUNTIME_DIR = directory;
      process.env.ZICHAN_UPDATE_LAUNCHER = '1';
      await writeFile(process.env.UPDATE_PUBLIC_KEY_PATH, publicPem);
      await writeFile(join(directory, 'latest.json'), JSON.stringify(feed));
      const updater = createUpdater('0.3.1', directory);
      expect(await updater.check()).toMatchObject({ available: true, status: { state: 'available' } });
      expect(await updater.status()).toMatchObject({ available: true, status: { state: 'available' } });
    } finally {
      Object.defineProperty(process, 'platform', platform);
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('records a legacy launcher result without a prior history entry', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'zichan-update-history-'));
    try {
      const result = { taskId: 'legacy-task', version: '0.3.3', state: 'success' as const,
        at: '2026-11-02T00:00:00.000Z' };
      expect(await reconcileLauncherResult(runtime, '0.3.3', result)).toMatchObject({
        state: 'success', targetVersion: '0.3.3', operation: 'update', taskId: 'legacy-task',
      });
      await reconcileLauncherResult(runtime, '0.3.3', result);
      const lines = (await readFile(join(runtime, 'update-history.jsonl'), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ state: 'success', targetVersion: '0.3.3' });
    } finally { await rm(runtime, { recursive: true, force: true }); }
  });

  it('accepts a signed release with the required server and web files', () => {
    expect(compareVersions('0.3.2', '0.3.1')).toBe(1);
    expect(compareVersions('0.4.0', '0.3.5')).toBe(1);
    expect(compareVersions('0.4.1', '0.4.0')).toBe(1);
    expect(compareVersions('0.4.0', '0.4.1')).toBe(-1);
    const verified = parseFeed(feed, publicPem);
    expect(parseRelease(release, verified).version).toBe('0.3.2');
  });

  it('rejects a forged or stale feed and a modified package', () => {
    expect(() => parseFeed({ ...feed, sha256: '0'.repeat(64) }, publicPem)).toThrow('签名无效');
    expect(() => parseFeed({ ...feed, artifact: '../bad.json' }, publicPem)).toThrow('格式无效');
    expect(() => compareVersions('0.4.0-rc.1', '0.3.1')).toThrow();
    expect(() => parseRelease(Buffer.concat([release, Buffer.from(' ')]), feed)).toThrow('SHA256');
  });

  it('rejects paths outside the release even when the package hash is valid', () => {
    const escaped = Buffer.from(JSON.stringify({
      format: 'zichan-release-v1', version: '0.3.2',
      schema: { version: 27, name: 'single_user_replica_storage_v27' },
      files: [
        { path: 'dist/server.mjs', data: Buffer.from('server').toString('base64') },
        { path: 'dist/maintenance.mjs', data: Buffer.from('maintenance').toString('base64') },
        { path: 'web-dist/index.html', data: Buffer.from('web').toString('base64') },
        { path: 'web-dist/../../server.secret', data: Buffer.from('secret').toString('base64') },
      ],
    }));
    const forged = { ...feed, sha256: createHash('sha256').update(escaped).digest('hex') };
    expect(() => parseRelease(escaped, forged)).toThrow('非法文件');
  });

  it('refuses a server schema change even with a matching package digest', () => {
    const changed = Buffer.from(JSON.stringify({
      ...JSON.parse(release.toString()), schema: { version: 28, name: 'next_schema' },
    }));
    expect(() => parseRelease(changed, {
      ...feed, sha256: createHash('sha256').update(changed).digest('hex'),
    })).toThrow('内容无效');
  });
});
