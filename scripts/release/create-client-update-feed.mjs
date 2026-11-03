import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, resolve, join } from 'node:path';

const [rawBase, rawOutput, ...mappings] = process.argv.slice(2);
if (!rawBase || !rawOutput || !mappings.length) {
  console.error('用法：node scripts/release/create-client-update-feed.mjs <HTTPS 目录> <输出目录> <target=已签名文件>...');
  process.exit(2);
}
const base = new URL(rawBase);
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('客户端更新目录必须使用 HTTPS');
const version = JSON.parse(await readFile(resolve(import.meta.dirname, '../../package.json'), 'utf8')).version;
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) throw new Error('客户端更新只支持稳定版本号');
const versionInName = new RegExp(`(?:^|[^0-9])${version.replaceAll('.', '\\.')}(?:[^0-9]|$)`);
const targetExtensions = new Map([
  ['windows-msi-x86_64', '.msi'], ['windows-nsis-x86_64', '-setup.exe'],
  ['windows-portable-x86_64', '.zip'], ['linux-appimage-x86_64', '.AppImage'],
  ['linux-deb-x86_64', '.deb'],
]);
const output = resolve(rawOutput);
await mkdir(output, { recursive: true });
const platforms = {};
const filenames = new Set();
for (const mapping of mappings) {
  const separator = mapping.indexOf('=');
  const target = mapping.slice(0, separator);
  const path = resolve(mapping.slice(separator + 1));
  if (!targetExtensions.has(target) || target in platforms) throw new Error(`目标平台无效或重复：${target}`);
  const name = basename(path);
  if (!versionInName.test(name) || !name.endsWith(targetExtensions.get(target)) || filenames.has(name)) {
    throw new Error(`资产名称、版本或平台不一致：${name}`);
  }
  filenames.add(name);
  const size = (await stat(path)).size;
  if (size === 0 || size > 1024 * 1024 * 1024) throw new Error(`资产大小无效：${name}`);
  const signature = (await readFile(`${path}.sig`, 'utf8')).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length > 8192) {
    throw new Error(`签名文件无效：${path}.sig`);
  }
  if (resolve(output, name) !== path) await copyFile(path, join(output, name));
  platforms[target] = { url: new URL(encodeURIComponent(name), base.href.endsWith('/') ? base : `${base.href}/`).href,
    signature };
}
await writeFile(join(output, 'latest.json'), JSON.stringify({ version, platforms }, null, 2) + '\n');
console.log(`已创建客户端 ${version} 更新清单：${Object.keys(platforms).join('、')}`);
