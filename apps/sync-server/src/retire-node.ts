import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { NodeSqliteDriver } from '@zichan/db/node';
import { assertServerStopped, createServerBackup, verifyServerBackup } from './backup.js';

export interface NodeRetirementInspection {
  dataDir: string;
  serverId: string;
  ledgerIds: string[];
  replicaIds: string[];
  accountCount: number;
  blobObjects: number;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function canonicalNewDirectory(value: string): string {
  const target = resolve(value);
  let ancestor = dirname(target);
  while (!existsSync(ancestor)) {
    const next = dirname(ancestor);
    if (next === ancestor) throw new Error('独立备份目录的上级路径不存在');
    ancestor = next;
  }
  return resolve(realpathSync.native(ancestor), relative(ancestor, dirname(target)), basename(target));
}

export function assertIndependentNodeBackupPath(dataDir: string, backupPath: string): void {
  const canonicalDataDir = realpathSync.native(dataDir);
  const canonicalBackup = canonicalNewDirectory(backupPath);
  if (inside(canonicalDataDir, canonicalBackup) || inside(canonicalBackup, canonicalDataDir)) {
    throw new Error('独立备份目录与节点数据目录不能互相包含；未执行清理');
  }
}

function assertNoLinkedFiles(root: string, current = root): void {
  const canonicalRoot = realpathSync.native(root);
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`节点数据目录包含链接 ${path}；未执行清理`);
    if (stat.isDirectory()) {
      if (!inside(canonicalRoot, realpathSync.native(path))) {
        throw new Error(`节点数据子目录超出指定目录 ${path}；未执行清理`);
      }
      assertNoLinkedFiles(root, path);
    }
  }
}

function assertExactDataDir(value: string): string {
  const dataDir = resolve(value);
  if (dataDir === parse(dataDir).root || dirname(dataDir) === dataDir
    || !existsSync(dataDir) || !lstatSync(dataDir).isDirectory()
    || lstatSync(dataDir).isSymbolicLink()) {
    throw new Error('必须指定已存在的节点数据目录，不能使用磁盘根目录或符号链接');
  }
  let component = parse(dataDir).root;
  for (const name of relative(component, dataDir).split(sep).filter(Boolean)) {
    component = join(component, name);
    if (lstatSync(component).isSymbolicLink()) {
      throw new Error('节点数据目录路径包含符号链接或目录联接；请直接指定实际目录');
    }
  }
  const actual = resolve(realpathSync.native(dataDir));
  for (const name of ['server-id', 'server.secret', 'server.sqlite', 'opaque.server-setup']) {
    const file = join(dataDir, name);
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
      throw new Error(`节点数据目录缺少普通文件 ${name}；未执行清理`);
    }
  }
  assertNoLinkedFiles(actual);
  return actual;
}

/** Inspect the stopped old node without modifying its ledger or attachments. */
export async function inspectNodeRetirement(dataDirValue: string): Promise<NodeRetirementInspection> {
  const dataDir = assertExactDataDir(dataDirValue);
  if (existsSync(join(dataDir, 'backup-executor.lock'))) {
    throw new Error('备份监督进程锁文件仍在，请先停止并核查监督进程；未执行清理');
  }
  assertServerStopped(dataDir);
  const serverId = readFileSync(join(dataDir, 'server-id'), 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(serverId)) throw new Error('节点 ID 无效；未执行清理');
  const driver = new NodeSqliteDriver(join(dataDir, 'server.sqlite'));
  try {
    const check = await driver.get<Record<string, unknown>>('PRAGMA quick_check');
    if (String(Object.values(check ?? {})[0] ?? '') !== 'ok'
      || await driver.get('PRAGMA foreign_key_check')) {
      throw new Error('节点 SQLite 完整性检查失败；未执行清理');
    }
    const tables = new Set((await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"))
      .map((row) => row.name));
    if (!tables.has('ledger_replica_slots') || !tables.has('blob_objects')) {
      throw new Error('节点数据库缺少副本或附件表；未执行清理');
    }
    const sources: string[] = [];
    for (const name of tables) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('节点数据库包含未知表名；未执行清理');
      const columns = await driver.all<{ name: string }>(`PRAGMA table_info("${name}")`);
      if (columns.some((column) => column.name === 'ledger_id')) sources.push(name);
    }
    if (!sources.length) throw new Error('节点数据库缺少账本归属列；未执行清理');
    const ledgerRows = await driver.all<{ ledger_id: string }>(
      `SELECT DISTINCT ledger_id FROM (${sources.map((name) => `SELECT ledger_id FROM ${name}`).join(' UNION ALL ')})
        WHERE ledger_id IS NOT NULL AND ledger_id <> '' ORDER BY ledger_id`);
    const slots = await driver.all<{ replica_id: string }>(
      'SELECT replica_id FROM ledger_replica_slots ORDER BY replica_id');
    const accounts = await driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM sync_users');
    const blobs = await driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM blob_objects');
    return { dataDir, serverId, ledgerIds: ledgerRows.map((row) => row.ledger_id),
      replicaIds: slots.map((row) => row.replica_id),
      accountCount: Number(accounts?.count ?? 0), blobObjects: Number(blobs?.count ?? 0) };
  } finally { await driver.close(); }
}

/** Clears only a whole, stopped, single-ledger node after creating a verified off-node backup. */
export async function retireNodeData(dataDirValue: string, backupPathValue: string,
  confirmedNodeId: string): Promise<NodeRetirementInspection & { backupPath: string }> {
  const inspection = await inspectNodeRetirement(dataDirValue);
  const backupPath = resolve(backupPathValue);
  if (confirmedNodeId !== inspection.serverId) throw new Error('确认的节点 ID 与数据目录不一致；未执行清理');
  if (inspection.ledgerIds.length > 1) {
    throw new Error(`该节点包含 ${inspection.ledgerIds.length} 本账；须先迁出其他账本，未执行清理`);
  }
  if (inspection.replicaIds.length > 1) {
    throw new Error(`该节点包含 ${inspection.replicaIds.length} 个独立副本槽位；须先核对并迁出其他副本，未执行清理`);
  }
  assertIndependentNodeBackupPath(inspection.dataDir, backupPath);
  const manifest = await createServerBackup(inspection.dataDir, backupPath);
  const verification = await verifyServerBackup(backupPath);
  if (!verification.ok || manifest.serverId !== inspection.serverId
    || verification.manifest.serverId !== inspection.serverId) {
    throw new Error(`独立备份未通过校验；原节点数据保留：${verification.issues.join('；')}`);
  }
  assertServerStopped(inspection.dataDir);
  if (readFileSync(join(inspection.dataDir, 'server-id'), 'utf8').trim() !== inspection.serverId) {
    throw new Error('清理前节点身份已变化；原节点数据保留');
  }
  const current = await inspectNodeRetirement(inspection.dataDir);
  if (JSON.stringify(current.ledgerIds) !== JSON.stringify(inspection.ledgerIds)
    || JSON.stringify(current.replicaIds) !== JSON.stringify(inspection.replicaIds)
    || current.accountCount !== inspection.accountCount || current.blobObjects !== inspection.blobObjects) {
    throw new Error('备份后节点目录发生变化；原节点数据保留');
  }
  // The deletion target was resolved and verified as the exact operator-named node directory.
  rmSync(inspection.dataDir, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  if (existsSync(inspection.dataDir)) throw new Error('节点数据目录尚未完全清理，请检查文件权限');
  return { ...inspection, backupPath };
}
