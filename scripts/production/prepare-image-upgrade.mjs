import { randomUUID } from 'node:crypto';
import { access, cp, link, mkdir, open, readFile, readlink, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Run only before the launcher starts, after Compose has stopped the old container.
// Stage trusted image files; the existing launcher performs offline backup and rollback.
export async function prepareImageUpgrade({ runtime, bootstrap, dataDir }) {
  for (const name of ['server-id', 'server.secret']) {
    const info = await stat(join(dataDir, name));
    if (!info.isFile() || info.size === 0) throw new Error('原服务器身份文件缺失，停止升级：' + name);
  }
  const current = await readlink(join(runtime, 'current'));
  const version = /^releases\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(current);
  if (version && version[0] === current && (BigInt(version[1]) > 0n || BigInt(version[2]) >= 7n)) return 'already-current';
  if (current !== 'releases/v0.6.0') throw new Error('此一次性配置仅用于 0.6.0 升级，当前链接为：' + current);
  if (await exists(join(runtime, 'pending.json'))) return 'pending';
  const marker = join(runtime, 'image-upgrade-0.6.0-to-0.7.0.json');
  if (await exists(marker)) return 'already-attempted';
  if (await exists(join(dataDir, 'maintenance.lock'))) throw new Error('服务器仍有维护锁，停止准备升级');
  const source = JSON.parse(await readFile(join(bootstrap, 'package.json'), 'utf8'));
  if (source.version !== '0.7.0') throw new Error('实际镜像不是 0.7.0，请拉取正确镜像后重建');
  for (const entry of ['server.mjs', 'maintenance.mjs']) {
    if (!(await stat(join(bootstrap, 'dist', entry))).isFile()) throw new Error('镜像缺少程序文件：' + entry);
  }
  const taskId = randomUUID();
  const staging = join(runtime, '.image-upgrade-' + taskId);
  const target = join(runtime, 'releases', 'v0.7.0');
  await mkdir(join(runtime, 'releases'), { recursive: true });
  await cp(bootstrap, staging, { recursive: true, force: false, errorOnExist: true });
  if (await exists(target)) await rename(target, target + '.before-' + taskId);
  await rename(staging, target);
  const update = { taskId, from: current, to: 'releases/v0.7.0', version: '0.7.0',
    operation: 'update', actor: '1panel-image-upgrade', at: new Date().toISOString() };
  const temporary = join(runtime, '.pending-image-' + taskId + '.json');
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(update)); await handle.sync(); }
  finally { await handle.close(); }
  // An atomic hard link never overwrites another pending operation.
  try { await link(temporary, join(runtime, 'pending.json')); }
  finally { await unlink(temporary); }
  await writeFile(marker, JSON.stringify(update), { flag: 'wx', mode: 0o600 });
  return 'prepared';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await prepareImageUpgrade({ runtime: process.env.ZICHAN_UPDATE_RUNTIME_DIR || '/state/runtime',
      bootstrap: '/app/bootstrap/release', dataDir: process.env.DATA_DIR || '/state/server' });
    console.log('1Panel 一次性升级准备：' + result);
    if (result === 'prepared') console.log('即将停服备份并校验，然后启动 0.7.0；失败时原启动器会回退。');
    if (result === 'already-attempted') console.log('已执行过一次升级；若仍为旧版，请查看后台更新记录，不自动重复备份。');
  } catch (error) { console.error('升级准备失败：', error.message); process.exitCode = 1; }
}
