import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const [publicKeyPath, feedPath, packagePath] = process.argv.slice(2);
if (!publicKeyPath || !feedPath || !packagePath) {
  console.error('用法：node scripts/release/verify-update-package.mjs <Ed25519 公钥 PEM> <latest.json> <更新包>');
  process.exit(2);
}
const feed = JSON.parse(await readFile(resolve(feedPath), 'utf8'));
if (feed?.format !== 'zichan-update-feed-v1' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(feed.version)
  || feed.artifact !== `zichan-${feed.version}.json` || basename(packagePath) !== feed.artifact
  || !/^[a-f0-9]{64}$/.test(feed.sha256) || typeof feed.signature !== 'string') {
  throw new Error('更新清单格式无效');
}
const publicKey = createPublicKey(await readFile(resolve(publicKeyPath), 'utf8'));
if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('更新公钥必须是 Ed25519');
const signedText = `${feed.format}\n${feed.version}\n${feed.artifact}\n${feed.sha256}\n`;
if (!verify(null, Buffer.from(signedText), publicKey, Buffer.from(feed.signature, 'base64'))) {
  throw new Error('更新清单签名无效');
}
const bytes = await readFile(resolve(packagePath));
if (createHash('sha256').update(bytes).digest('hex') !== feed.sha256) throw new Error('更新包摘要不符');
const release = JSON.parse(bytes.toString('utf8'));
if (release?.format !== 'zichan-release-v1' || release.version !== feed.version) {
  throw new Error('更新包版本与清单不符');
}
console.log(`更新包签名与摘要有效：${feed.version}`);
