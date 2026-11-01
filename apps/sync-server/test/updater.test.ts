import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { comparePatch, parseFeed, parseRelease, signedFeedText } from '../src/updater.js';

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

describe('signed 0.3.x self updates', () => {
  it('accepts a signed release with the required server and web files', () => {
    expect(comparePatch('0.3.2', '0.3.1')).toBe(1);
    const verified = parseFeed(feed, publicPem);
    expect(parseRelease(release, verified).version).toBe('0.3.2');
  });

  it('rejects a forged or stale feed and a modified package', () => {
    expect(() => parseFeed({ ...feed, sha256: '0'.repeat(64) }, publicPem)).toThrow('签名无效');
    expect(() => parseFeed({ ...feed, artifact: '../bad.json' }, publicPem)).toThrow('格式无效');
    expect(() => comparePatch('0.4.0', '0.3.1')).toThrow();
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
