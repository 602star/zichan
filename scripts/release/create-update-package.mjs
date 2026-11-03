import { createHash, sign } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const unsigned = process.argv[2] === '--unsigned';
const [privateKeyPath, outputDirectory] = unsigned ? [undefined, process.argv[3]] : process.argv.slice(2);
if (!outputDirectory || !unsigned && !privateKeyPath) {
  console.error('用法：node scripts/release/create-update-package.mjs <Ed25519 私钥 PEM> <输出目录> | --unsigned <输出目录>');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(await readFile(join(root, 'apps/sync-server/package.json'), 'utf8')).version;
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) throw new Error('更新包仅支持稳定版本号');
const storeSource = await readFile(join(root, 'apps/sync-server/src/store.ts'), 'utf8');
const schemaVersion = /export const CURRENT_SERVER_SCHEMA = (\d+);/.exec(storeSource)?.[1];
const schemaName = /export const CURRENT_SERVER_SCHEMA_NAME = '([^']+)';/.exec(storeSource)?.[1];
if (!schemaVersion || !schemaName) throw new Error('无法读取服务器 schema 标识');
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) {
      const name = relative(root, path).split(sep).join('/');
      if (name.startsWith('apps/sync-server/dist/') && !/^apps\/sync-server\/dist\/(?:server|maintenance)\.mjs$/.test(name)) continue;
      const bundlePath = name.startsWith('apps/sync-server/dist/')
        ? name.replace('apps/sync-server/', '')
        : name.replace('apps/web/', 'web-');
      files.push({ path: bundlePath, data: (await readFile(path)).toString('base64') });
    } else throw new Error(`不支持符号链接：${path}`);
  }
}
await collect(join(root, 'apps/sync-server/dist'));
await collect(join(root, 'apps/web/dist'));
files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
if (!files.some((file) => file.path === 'dist/server.mjs')
  || !files.some((file) => file.path === 'web-dist/index.html')) throw new Error('请先运行 npm run build:server');
const artifact = `zichan-${version}.json`;
const bytes = Buffer.from(JSON.stringify({ format: 'zichan-release-v1', version,
  schema: { version: Number(schemaVersion), name: schemaName }, files }));
if (bytes.length > 64 * 1024 * 1024) throw new Error('更新包超过 64 MiB');
await mkdir(resolve(outputDirectory), { recursive: true });
await writeFile(join(resolve(outputDirectory), artifact), bytes, { flag: 'wx', mode: 0o644 });
if (unsigned) {
  console.log(`已创建未签名候选包 ${artifact}`);
  process.exit(0);
}
const feed = {
  format: 'zichan-update-feed-v1', version, artifact,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const signature = sign(null,
  Buffer.from(`${feed.format}\n${feed.version}\n${feed.artifact}\n${feed.sha256}\n`),
  await readFile(resolve(privateKeyPath), 'utf8')).toString('base64');
const signedFeed = JSON.stringify({ ...feed, signature }) + '\n';
await writeFile(join(resolve(outputDirectory), `zichan-${version}.feed.json`), signedFeed, { flag: 'wx', mode: 0o644 });
await writeFile(join(resolve(outputDirectory), 'latest.json'), signedFeed);
console.log(`已创建 ${artifact}，SHA256 ${feed.sha256}`);
