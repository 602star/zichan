import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { NodeSqliteDriver } from '@zichan/db/node';
import { supportedServerSchema } from './store.js';

const BACKUP_VERSION = 1;
const SIDE_CARS = ['server.secret', 'server-id', 'opaque.server-setup'] as const;
const REQUIRED_FILES = ['server.sqlite', 'server.secret', 'server-id', 'opaque.server-setup'] as const;

export interface ServerBackupFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ServerBackupManifest {
  format: 'zichan-sync-server-backup';
  version: 1;
  createdAt: string;
  serverId: string;
  files: ServerBackupFile[];
}

export interface ServerBackupVerification {
  ok: boolean;
  manifest: ServerBackupManifest;
  checkedFiles: number;
  databaseResult: string;
  issues: string[];
}

function fsyncFile(path: string): void {
  const handle = openSync(path, 'r+');
  try { fsyncSync(handle); } finally { closeSync(handle); }
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsyncFile(temporary);
  renameSync(temporary, path);
}

function normalizeManifestPath(value: string): string | null {
  if (!value || isAbsolute(value) || value.includes('\\')) return null;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function pathInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function collectFiles(root: string, current = root): ServerBackupFile[] {
  if (!existsSync(current)) return [];
  const files: ServerBackupFile[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(root, path));
    else if (entry.isFile()) {
      const manifestPath = relative(root, path).split(sep).join('/');
      files.push({ path: manifestPath, sizeBytes: statSync(path).size, sha256: sha256File(path) });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function copyTree(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      fsyncFile(to);
    }
  }
}

function readManifest(backupDir: string): ServerBackupManifest {
  const path = join(resolve(backupDir), 'manifest.json');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServerBackupManifest>;
  if (value.format !== 'zichan-sync-server-backup' || value.version !== BACKUP_VERSION
    || typeof value.createdAt !== 'string' || typeof value.serverId !== 'string' || !Array.isArray(value.files)) {
    throw new Error('备份清单格式无效');
  }
  const files = value.files.map((file) => {
    const row = file as Partial<ServerBackupFile>;
    const pathValue = typeof row.path === 'string' ? normalizeManifestPath(row.path) : null;
    if (!pathValue || !Number.isSafeInteger(row.sizeBytes) || Number(row.sizeBytes) < 0
      || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('备份文件清单无效');
    return { path: pathValue, sizeBytes: Number(row.sizeBytes), sha256: row.sha256 };
  });
  if (REQUIRED_FILES.some((required) => !files.some((file) => file.path === required))
    || new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error('备份缺少数据库或认证密钥文件，或包含重复文件');
  }
  return { format: value.format, version: 1, createdAt: value.createdAt, serverId: value.serverId, files };
}

async function verifyDatabase(path: string): Promise<string> {
  const driver = new NodeSqliteDriver(path);
  try {
    const check = await driver.get<Record<string, unknown>>('PRAGMA quick_check');
    const result = String(Object.values(check ?? {})[0] ?? 'unknown');
    const migrations = await driver.all<{ version: number; name: string }>('SELECT version, name FROM server_schema_migrations ORDER BY version');
    const migration = migrations[0];
    if (migrations.length !== 1 || !migration || !supportedServerSchema(Number(migration.version), migration.name)) {
      return `schema:${migration?.version ?? 'missing'}:${migration?.name ?? 'missing'}`;
    }
    return result;
  } finally {
    await driver.close();
  }
}

function runningPid(dataDir: string): number | null {
  const path = join(resolve(dataDir), 'server.pid');
  if (!existsSync(path)) return null;
  let pid: number;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    pid = Number(value.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('服务器 PID 文件无效，请确认服务已停止后删除 server.pid');
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('服务器 PID 文件损坏，请确认服务已停止后删除 server.pid');
    throw error;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') rmSync(path, { force: true });
    else if (code === 'EPERM') return pid;
    else throw error;
    return null;
  }
}

export function assertServerStopped(dataDir: string): void {
  const pid = runningPid(dataDir);
  if (pid) throw new Error(`同步服务器仍在运行（PID ${pid}），请先停止服务再执行维护命令`);
}

async function snapshotDatabase(source: string, target: string): Promise<void> {
  if (!existsSync(source)) throw new Error(`主数据库不存在：${source}`);
  const driver = new NodeSqliteDriver(source);
  try {
    const check = await driver.get<Record<string, unknown>>('PRAGMA quick_check');
    if (String(Object.values(check ?? {})[0] ?? '') !== 'ok') throw new Error('源数据库完整性检查失败');
    await driver.exec('PRAGMA wal_checkpoint(FULL);');
    const quoted = await driver.get<{ value: string }>('SELECT quote(?) AS value', [target]);
    if (!quoted?.value) throw new Error('无法生成 SQLite 快照路径');
    await driver.exec(`VACUUM INTO ${quoted.value};`);
  } finally {
    await driver.close();
  }
  fsyncFile(target);
}

export async function createServerBackup(dataDirValue: string, outputValue: string): Promise<ServerBackupManifest> {
  const dataDir = resolve(dataDirValue);
  const output = resolve(outputValue);
  assertServerStopped(dataDir);
  if (pathInside(dataDir, output)) throw new Error('备份目录必须位于服务器数据目录之外');
  if (existsSync(output)) throw new Error(`备份目标已存在：${output}`);
  mkdirSync(dirname(output), { recursive: true });
  const staging = join(dirname(output), `.${basename(output)}.${randomBytes(6).toString('hex')}.staging`);
  mkdirSync(staging, { recursive: true });
  try {
    await snapshotDatabase(join(dataDir, 'server.sqlite'), join(staging, 'server.sqlite'));
    for (const name of SIDE_CARS) {
      const source = join(dataDir, name);
      if (existsSync(source)) {
        copyFileSync(source, join(staging, name));
        fsyncFile(join(staging, name));
      }
    }
    copyTree(join(dataDir, 'blobs', 'objects'), join(staging, 'blobs', 'objects'));
    copyTree(join(dataDir, 'blobs', 'trash'), join(staging, 'blobs', 'trash'));
    copyTree(join(dataDir, 'blobs', 'staging'), join(staging, 'blobs', 'staging'));
    const serverId = existsSync(join(staging, 'server-id')) ? readFileSync(join(staging, 'server-id'), 'utf8').trim() : '';
    if (!serverId) throw new Error('服务器 ID 文件缺失');
    if (!existsSync(join(staging, 'server.secret')) || !readFileSync(join(staging, 'server.secret'), 'utf8').trim()) throw new Error('服务器密钥文件缺失');
    if (!existsSync(join(staging, 'opaque.server-setup')) || !readFileSync(join(staging, 'opaque.server-setup'), 'utf8').trim()) {
      throw new Error('OPAQUE 服务器密钥文件缺失');
    }
    const manifest: ServerBackupManifest = {
      format: 'zichan-sync-server-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      serverId,
      files: collectFiles(staging),
    };
    atomicJson(join(staging, 'manifest.json'), manifest);
    const verification = await verifyServerBackup(staging);
    if (!verification.ok) throw new Error(`备份校验失败：${verification.issues.join('；')}`);
    renameSync(staging, output);
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyServerBackup(backupDirValue: string): Promise<ServerBackupVerification> {
  const backupDir = resolve(backupDirValue);
  const manifest = readManifest(backupDir);
  const issues: string[] = [];
  const backedUpServerId = existsSync(join(backupDir, 'server-id')) ? readFileSync(join(backupDir, 'server-id'), 'utf8').trim() : '';
  if (backedUpServerId !== manifest.serverId) issues.push('服务器 ID 与备份清单不一致');
  if (!existsSync(join(backupDir, 'server.secret')) || !readFileSync(join(backupDir, 'server.secret'), 'utf8').trim()) {
    issues.push('服务器密钥文件缺失');
  }
  if (!existsSync(join(backupDir, 'opaque.server-setup')) || !readFileSync(join(backupDir, 'opaque.server-setup'), 'utf8').trim()) {
    issues.push('OPAQUE 服务器密钥文件缺失');
  }
  for (const file of manifest.files) {
    const path = resolve(backupDir, ...file.path.split('/'));
    if (!pathInside(backupDir, path) || !existsSync(path) || !statSync(path).isFile()) {
      issues.push(`${file.path} 缺失`);
      continue;
    }
    const size = statSync(path).size;
    if (size !== file.sizeBytes) issues.push(`${file.path} 大小不符`);
    else if (sha256File(path) !== file.sha256) issues.push(`${file.path} 校验和不符`);
  }
  let databaseResult = 'not-checked';
  if (!issues.some((issue) => issue.startsWith('server.sqlite'))) {
    try {
      databaseResult = await verifyDatabase(join(backupDir, 'server.sqlite'));
      if (databaseResult !== 'ok') issues.push(`SQLite 完整性检查失败：${databaseResult}`);
    } catch (error) {
      databaseResult = error instanceof Error ? error.message : String(error);
      issues.push(`SQLite 无法打开：${databaseResult}`);
    }
  }
  return { ok: issues.length === 0, manifest, checkedFiles: manifest.files.length, databaseResult, issues };
}

export async function restoreServerBackup(backupDirValue: string, dataDirValue: string): Promise<{ previousDataDir?: string }> {
  const backupDir = resolve(backupDirValue);
  const dataDir = resolve(dataDirValue);
  assertServerStopped(dataDir);
  if (pathInside(dataDir, backupDir) || pathInside(backupDir, dataDir)) throw new Error('备份目录与待恢复数据目录不能互相包含');
  const verification = await verifyServerBackup(backupDir);
  if (!verification.ok) throw new Error(`备份校验失败：${verification.issues.join('；')}`);
  mkdirSync(dirname(dataDir), { recursive: true });
  const staging = join(dirname(dataDir), `.${basename(dataDir)}.${randomBytes(6).toString('hex')}.restore`);
  const previous = existsSync(dataDir) ? join(dirname(dataDir), `${basename(dataDir)}.before-restore-${Date.now()}`) : undefined;
  mkdirSync(staging, { recursive: true });
  try {
    for (const file of verification.manifest.files) {
      const source = resolve(backupDir, ...file.path.split('/'));
      const target = resolve(staging, ...file.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      fsyncFile(target);
    }
    if (await verifyDatabase(join(staging, 'server.sqlite')) !== 'ok') throw new Error('恢复暂存数据库完整性检查失败');
    // Restore data, not previously consumed recovery capabilities or old login sessions.
    const restoredDb = new NodeSqliteDriver(join(staging, 'server.sqlite'));
    try {
      await restoredDb.transaction(async (driver) => {
        if (await driver.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account_password_resets'")) await driver.run('DELETE FROM account_password_resets');
        await driver.run('DELETE FROM sync_opaque_login_states');
        const at = new Date().toISOString();
        await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?', [at, at]);
      });
    } finally { await restoredDb.close(); }
    if (previous) renameSync(dataDir, previous);
    try {
      renameSync(staging, dataDir);
    } catch (error) {
      if (previous && existsSync(previous) && !existsSync(dataDir)) renameSync(previous, dataDir);
      throw error;
    }
    return { ...(previous ? { previousDataDir: previous } : {}) };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
