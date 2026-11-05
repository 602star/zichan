import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const [privateKeyPath, feedPath] = process.argv.slice(2);
if (!privateKeyPath || !feedPath) {
  console.error('Usage: node verify-android-update-feed.mjs <private-key.pem> <android-latest.json>');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '../..');
const publicKey = createPublicKey(await readFile(resolve(privateKeyPath)));
const embeddedKey = (await readFile(join(root, 'apps/desktop/src-tauri/installer/android-update.pub'), 'utf8')).trim();
const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
if (rawPublicKey !== embeddedKey) throw new Error('Android feed signing key does not match the client public key');

const file = resolve(feedPath);
const feed = JSON.parse(await readFile(file, 'utf8'));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const artifact = `zichan-${version}-android-arm64.apk`;
if (feed.format !== 'zichan-android-feed-v1' || feed.version !== version || feed.artifact !== artifact ||
    basename(feed.artifact) !== feed.artifact || !/^[a-f0-9]{64}$/.test(feed.sha256)) {
  throw new Error('Android feed metadata does not match the release');
}
const digest = createHash('sha256').update(await readFile(join(dirname(file), artifact))).digest('hex');
if (digest !== feed.sha256) throw new Error('Android APK digest does not match the feed');
const signedText = `${feed.format}\n${feed.version}\n${feed.artifact}\n${feed.sha256}\n`;
if (!verify(null, Buffer.from(signedText), publicKey, Buffer.from(feed.signature, 'base64'))) {
  throw new Error('Android feed signature is invalid');
}
console.log(`Verified Android ${version} feed and APK`);
