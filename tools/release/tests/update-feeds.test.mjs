import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;

async function directory() {
  return mkdtemp(join(tmpdir(), 'zichan-update-feed-'));
}

test('Android feed signs the exact APK digest and named version', async () => {
  const temp = await directory();
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const key = join(temp, 'private.pem');
    const apk = join(temp, 'candidate.apk');
    const output = join(temp, 'feed');
    const bytes = Buffer.from('signed Android candidate for feed test');
    await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await writeFile(apk, bytes);
    const run = spawnSync(process.execPath, [join(root, 'scripts/release/create-android-update-feed.mjs'), key, apk, output],
      { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const feed = JSON.parse(await readFile(join(output, 'android-latest.json'), 'utf8'));
    assert.equal(feed.version, version);
    assert.equal(feed.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(join(output, feed.artifact)), bytes);
    const signedText = `${feed.format}\n${feed.version}\n${feed.artifact}\n${feed.sha256}\n`;
    assert.equal(verify(null, Buffer.from(signedText), publicKey, Buffer.from(feed.signature, 'base64')), true);
    assert.equal(verify(null, Buffer.from(`${signedText}tampered`), publicKey, Buffer.from(feed.signature, 'base64')), false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('desktop feed maps a signed platform artifact to HTTPS', async () => {
  const temp = await directory();
  try {
    const artifact = join(temp, `zichan-${version}-portable.zip`);
    const output = join(temp, 'feed');
    await writeFile(artifact, 'portable payload');
    await writeFile(`${artifact}.sig`, Buffer.alloc(64, 7).toString('base64'));
    const run = spawnSync(process.execPath, [join(root, 'scripts/release/create-client-update-feed.mjs'),
      'https://updates.example.test/client/', output, `windows-portable-x86_64=${artifact}`], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const feed = JSON.parse(await readFile(join(output, 'latest.json'), 'utf8'));
    assert.equal(feed.version, version);
    assert.equal(feed.platforms['windows-portable-x86_64'].url,
      `https://updates.example.test/client/zichan-${version}-portable.zip`);
    assert.deepEqual(await readFile(join(output, `zichan-${version}-portable.zip`)), await readFile(artifact));
    const wrong = join(temp, `zichan-${version}0-portable.zip`);
    await writeFile(wrong, 'wrong version payload');
    await writeFile(`${wrong}.sig`, Buffer.alloc(64, 7).toString('base64'));
    const rejected = spawnSync(process.execPath, [join(root, 'scripts/release/create-client-update-feed.mjs'),
      'https://updates.example.test/client/', output, `windows-portable-x86_64=${wrong}`], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /版本或平台不一致/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
