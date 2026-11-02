import { createHash, sign } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';

const [privateKeyPath, rawApk, rawOutput] = process.argv.slice(2);
if (!privateKeyPath || !rawApk || !rawOutput) {
  console.error('用法：node scripts/release/create-android-update-feed.mjs <Ed25519 私钥 PEM> <已签名 APK> <输出目录>');
  process.exit(2);
}
const version = JSON.parse(await readFile(resolve(import.meta.dirname, '../../package.json'), 'utf8')).version;
if (!/^0\.3\.(?:0|[1-9]\d*)$/.test(version)) throw new Error('Android 更新只支持 0.3.x');
const apk = resolve(rawApk);
if (!apk.toLowerCase().endsWith('.apk')) throw new Error('更新资产必须是 APK');
const bytes = await readFile(apk);
if (bytes.length === 0 || bytes.length > 256 * 1024 * 1024) throw new Error('APK 大小无效');
const artifact = `zichan-${version}-android-arm64.apk`;
const feed = { format: 'zichan-android-feed-v1', version, artifact,
  sha256: createHash('sha256').update(bytes).digest('hex') };
const signature = sign(null, Buffer.from(`${feed.format}\n${feed.version}\n${feed.artifact}\n${feed.sha256}\n`),
  await readFile(resolve(privateKeyPath), 'utf8')).toString('base64');
const output = resolve(rawOutput);
await mkdir(output, { recursive: true });
if (resolve(output, artifact) !== apk) await copyFile(apk, join(output, artifact));
await writeFile(join(output, 'android-latest.json'), JSON.stringify({ ...feed, signature }) + '\n');
console.log(`已创建 Android ${version} 更新清单：${basename(apk)} → ${artifact}`);
