import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const [tag, privateKeyPath, packagePath, outputDirectory] = process.argv.slice(2);
if (!tag || !privateKeyPath || !packagePath || !outputDirectory) {
  console.error('用法：node scripts/release/sign-update-package.mjs <v稳定版本号> <Ed25519 私钥 PEM> <候选包> <输出目录>');
  process.exit(2);
}
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) throw new Error('发布标签必须是稳定版本号');
const version = tag.slice(1);
const artifact = `zichan-${version}.json`;
if (basename(packagePath) !== artifact) throw new Error('候选包文件名与标签不一致');
const bytes = await readFile(resolve(packagePath));
if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) throw new Error('候选包大小无效');
const release = JSON.parse(bytes.toString('utf8'));
if (release?.format !== 'zichan-release-v1' || release.version !== version
  || !Number.isSafeInteger(release.schema?.version) || !release.schema?.name
  || !Array.isArray(release.files) || release.files.length < 3 || release.files.length > 500
  || !release.files.some((file) => file.path === 'dist/server.mjs')
  || !release.files.some((file) => file.path === 'dist/maintenance.mjs')
  || !release.files.some((file) => file.path === 'web-dist/index.html')) {
  throw new Error('候选包内容与发布标签不一致');
}
const allowedFile = /^(?:dist\/(?:server|maintenance)\.mjs|web-dist\/[A-Za-z0-9._/-]+)$/;
const names = new Set();
let decodedBytes = 0;
for (const file of release.files) {
  if (!file || typeof file.path !== 'string' || !allowedFile.test(file.path)
    || file.path.includes('..') || file.path.includes('//') || names.has(file.path)
    || typeof file.data !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
    throw new Error('候选包含有非法文件');
  }
  names.add(file.path);
  decodedBytes += Buffer.byteLength(file.data, 'base64');
  if (decodedBytes > 64 * 1024 * 1024) throw new Error('候选包解压后超过大小限制');
}
const feed = { format: 'zichan-update-feed-v1', version, artifact,
  sha256: createHash('sha256').update(bytes).digest('hex') };
const privateKey = createPrivateKey(await readFile(resolve(privateKeyPath), 'utf8'));
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('更新私钥必须是 Ed25519');
const signature = sign(null, Buffer.from(`${feed.format}\n${feed.version}\n${feed.artifact}\n${feed.sha256}\n`), privateKey).toString('base64');
const signedFeed = `${JSON.stringify({ ...feed, signature })}\n`;
await writeFile(join(resolve(outputDirectory), `zichan-${version}.feed.json`), signedFeed, { flag: 'wx', mode: 0o644 });
await writeFile(join(resolve(outputDirectory), 'latest.json'), signedFeed, { flag: 'wx', mode: 0o644 });
console.log(`已签名 ${artifact}，SHA256 ${feed.sha256}`);
