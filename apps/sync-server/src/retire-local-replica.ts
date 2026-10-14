import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { NodeSqliteDriver } from '@zichan/db/node';
import { assertServerStopped, createServerBackup, verifyServerBackup } from './backup.js';
import { assertIndependentNodeBackupPath, inspectNodeRetirement } from './retire-node.js';
import { LOCAL_REPLICA_RETIREMENT_MARKER } from './replica-retirement-guard.js';
import { CURRENT_SERVER_SCHEMA, CURRENT_SERVER_SCHEMA_NAME } from './store.js';

export { LOCAL_REPLICA_RETIREMENT_MARKER, assertNoPendingLocalReplicaRetirement } from './replica-retirement-guard.js';
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const NS = /^[a-f0-9]{64}$/;
const BLOB_DIRS = ['objects', 'trash', 'staging', 'quarantine'] as const;

interface PendingRetirement {
  version: 1;
  serverId: string;
  replicaId: string;
  ledgerId: string;
  backupPath: string;
  otherLedgerIds: string[];
  objectCount: number;
  uploadCount: number;
  namespaces: string[];
}

export interface LocalReplicaRetirementInspection {
  serverId: string;
  replicaId: string;
  ledgerId: string;
  otherLedgerIds: string[];
  objectCount: number;
  uploadCount: number;
  namespaces: string[];
  issues: string[];
}

function replicaNamespace(ledgerId: string, replicaId: string): string {
  return createHash('sha256').update(`replica-v2\0${ledgerId}\0${replicaId}`).digest('hex');
}

function legacyNamespace(username: string, ledgerId: string): string {
  return createHash('sha256').update(`${username}\0${ledgerId}`).digest('hex');
}

function markerPath(dataDir: string): string { return join(dataDir, LOCAL_REPLICA_RETIREMENT_MARKER); }

function writeMarker(dataDir: string, value: PendingRetirement): void {
  const target = markerPath(dataDir);
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  const handle = openSync(temporary, 'r+');
  try { fsyncSync(handle); } finally { closeSync(handle); }
  renameSync(temporary, target);
}

function readMarker(dataDir: string): PendingRetirement | undefined {
  const path = markerPath(dataDir);
  if (!existsSync(path)) return;
  let value: PendingRetirement;
  try { value = JSON.parse(readFileSync(path, 'utf8')) as PendingRetirement; }
  catch { throw new Error('副本清理标记损坏；保留数据并停止启动'); }
  if (value.version !== 1 || !ID.test(value.serverId) || !ID.test(value.replicaId)
    || !ID.test(value.ledgerId) || !isAbsolute(value.backupPath)
    || !Array.isArray(value.otherLedgerIds)
    || value.otherLedgerIds.some((id) => typeof id !== 'string' || id.length > 256)
    || !Number.isSafeInteger(value.objectCount) || value.objectCount < 0
    || !Number.isSafeInteger(value.uploadCount) || value.uploadCount < 0
    || !Array.isArray(value.namespaces) || value.namespaces.some((name) => !NS.test(name))) {
    throw new Error('副本清理标记无效；保留数据并停止启动');
  }
  return value;
}

export async function inspectLocalReplicaRetirement(dataDirValue: string,
  replicaId: string): Promise<LocalReplicaRetirementInspection> {
  if (!ID.test(replicaId)) throw new Error('副本 ID 无效');
  const node = await inspectNodeRetirement(dataDirValue);
  const db = new NodeSqliteDriver(join(node.dataDir, 'server.sqlite'));
  try {
    const slot = await db.get<{ ledger_id: string }>(
      'SELECT ledger_id FROM ledger_replica_slots WHERE replica_id = ?', [replicaId]);
    if (!slot) throw new Error('指定副本槽位不存在');
    const ledgerId = slot.ledger_id;
    if (!ID.test(ledgerId)) throw new Error('账本 ID 无效；未执行清理');
    const issues: string[] = [];
    const schema = await db.get<{ version: number; name: string }>(
      'SELECT version, name FROM server_schema_migrations');
    if (schema?.version !== CURRENT_SERVER_SCHEMA || schema?.name !== CURRENT_SERVER_SCHEMA_NAME) {
      issues.push('数据库版本与当前服务不一致');
    }
    const parallel = await db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM ledger_replica_slots WHERE ledger_id = ? AND replica_id <> ?',
      [ledgerId, replicaId]);
    if (Number(parallel?.count ?? 0)) issues.push('同一账本 ID 还有独立副本槽位，归属不能自动判定');
    for (const table of ['blob_objects', 'blob_replica_states', 'blob_uploads']) {
      const row = await db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ledger_id = ?
          AND (replica_id IS NULL OR replica_id <> ?)`, [ledgerId, replicaId]);
      if (Number(row?.count ?? 0)) issues.push(`${table} 有未归属或其他副本记录`);
    }
    const [objects, uploads] = await Promise.all([
      db.get<{ count: number }>('SELECT COUNT(*) AS count FROM blob_objects WHERE replica_id = ?', [replicaId]),
      db.get<{ count: number }>('SELECT COUNT(*) AS count FROM blob_uploads WHERE replica_id = ?', [replicaId]),
    ]);
    const namespaceRows = await db.all<{ namespace: string }>(`
      SELECT DISTINCT namespace FROM (
        SELECT namespace FROM blob_objects WHERE ledger_id = ? AND replica_id = ?
        UNION ALL SELECT namespace FROM blob_uploads WHERE ledger_id = ? AND replica_id = ?)
      ORDER BY namespace`, [ledgerId, replicaId, ledgerId, replicaId]);
    const accounts = await db.all<{ username: string }>(`
      SELECT DISTINCT username FROM (
        SELECT username FROM account_ledger_index WHERE replica_id = ?
        UNION ALL SELECT username FROM ledger_account_routes WHERE replica_id = ?
        UNION ALL SELECT username FROM sync_replicas WHERE replica_id = ?)
      ORDER BY username`, [replicaId, replicaId, replicaId]);
    const namespaces = [...new Set([
      replicaNamespace(ledgerId, replicaId), ...namespaceRows.map((row) => row.namespace),
      ...accounts.map((row) => legacyNamespace(row.username, ledgerId)),
    ])].sort();
    if (namespaces.some((name) => !NS.test(name))) issues.push('附件物理目录名无效');
    for (const namespace of namespaces) {
      const shared = await db.get<{ count: number }>(`
        SELECT (SELECT COUNT(*) FROM blob_objects WHERE namespace = ? AND ledger_id <> ?)
          + (SELECT COUNT(*) FROM blob_uploads WHERE namespace = ? AND ledger_id <> ?) AS count`,
      [namespace, ledgerId, namespace, ledgerId]);
      if (Number(shared?.count ?? 0)) issues.push(`附件目录 ${namespace} 被其他账本引用`);
    }
    return { serverId: node.serverId, replicaId, ledgerId,
      otherLedgerIds: node.ledgerIds.filter((id) => id !== ledgerId),
      objectCount: Number(objects?.count ?? 0), uploadCount: Number(uploads?.count ?? 0),
      namespaces, issues };
  } finally { await db.close(); }
}

async function removeReplicaRows(dataDir: string, pending: PendingRetirement): Promise<void> {
  const db = new NodeSqliteDriver(join(dataDir, 'server.sqlite'));
  try {
    await db.transaction(async (tx) => {
      for (const namespace of pending.namespaces) {
        const shared = await tx.get(`SELECT 1 FROM blob_objects WHERE namespace = ? AND ledger_id <> ?
          UNION ALL SELECT 1 FROM blob_uploads WHERE namespace = ? AND ledger_id <> ? LIMIT 1`,
        [namespace, pending.ledgerId, namespace, pending.ledgerId]);
        if (shared) throw new Error(`待清理附件目录 ${namespace} 已被其他账本引用；原数据保留`);
      }
      const slot = await tx.get<{ ledger_id: string }>(
        'SELECT ledger_id FROM ledger_replica_slots WHERE replica_id = ?', [pending.replicaId]);
      if (slot && slot.ledger_id !== pending.ledgerId) throw new Error('待清理副本账本 ID 已变化');
      const other = await tx.get('SELECT 1 FROM ledger_replica_slots WHERE ledger_id = ? AND replica_id <> ?',
        [pending.ledgerId, pending.replicaId]);
      if (other) throw new Error('同账本 ID 出现其他副本槽位；已停止清理');
      for (const table of ['blob_objects', 'blob_replica_states', 'blob_uploads']) {
        if (await tx.get(`SELECT 1 FROM ${table} WHERE ledger_id = ? AND (replica_id IS NULL OR replica_id <> ?) LIMIT 1`,
          [pending.ledgerId, pending.replicaId])) throw new Error(`${table} 归属已变化；已停止清理`);
      }
      if (!slot) return;
      const at = new Date().toISOString();
      await tx.run(`UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
        WHERE replica_id = ? OR replica_id IS NULL AND username IN
          (SELECT username FROM sync_replicas WHERE replica_id = ?)`,
      [at, at, pending.replicaId, pending.replicaId]);
      await tx.run(`DELETE FROM blob_upload_chunks WHERE upload_id IN
        (SELECT upload_id FROM blob_uploads WHERE ledger_id = ? AND replica_id = ?)`,
      [pending.ledgerId, pending.replicaId]);
      for (const table of ['blob_uploads', 'blob_objects', 'blob_replica_states']) {
        await tx.run(`DELETE FROM ${table} WHERE ledger_id = ? AND replica_id = ?`,
          [pending.ledgerId, pending.replicaId]);
      }
      await tx.run('DELETE FROM node_replication_links WHERE ledger_id = ?', [pending.ledgerId]);
      await tx.run('DELETE FROM node_replication_grants WHERE ledger_id = ?', [pending.ledgerId]);
      await tx.run('DELETE FROM replica_physical_status WHERE ledger_id = ?', [pending.ledgerId]);
      await tx.run('DELETE FROM federated_account_bindings WHERE ledger_id = ?', [pending.ledgerId]);
      await tx.run('DELETE FROM ledger_replacement_checkpoints WHERE replica_id = ?', [pending.replicaId]);
      await tx.run('DELETE FROM ledger_account_routes WHERE replica_id = ?', [pending.replicaId]);
      await tx.run('DELETE FROM sync_replicas WHERE replica_id = ?', [pending.replicaId]);
      await tx.run('DELETE FROM ledger_replica_slots WHERE replica_id = ?', [pending.replicaId]);
      await tx.run('DELETE FROM server_meta WHERE key = ?', [`replica_retired:${pending.replicaId}`]);
    });
    if (await db.get('PRAGMA foreign_key_check')) throw new Error('清理后 SQLite 外键检查失败');
  } finally { await db.close(); }
}

function removeReplicaFiles(dataDir: string, namespaces: string[]): void {
  for (const namespace of namespaces) {
    if (!NS.test(namespace)) throw new Error('待清理附件目录名无效');
    for (const folder of BLOB_DIRS) {
      const path = join(dataDir, 'blobs', folder, namespace);
      if (existsSync(path)) rmSync(path, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    }
  }
}

export async function retireLocalReplica(dataDirValue: string, replicaId: string,
  backupPathValue: string, confirmedNodeId: string,
  confirmedLedgerId: string): Promise<LocalReplicaRetirementInspection & {
    backupPath: string; resumed: boolean;
  }> {
  const dataDir = resolve(dataDirValue);
  const backupPath = resolve(backupPathValue);
  const node = await inspectNodeRetirement(dataDir);
  if (node.serverId !== confirmedNodeId) throw new Error('确认的节点 ID 与数据目录不一致');
  assertIndependentNodeBackupPath(dataDir, backupPath);
  const existing = readMarker(dataDir);
  let pending: PendingRetirement;
  let inspection: LocalReplicaRetirementInspection;
  if (existing) {
    if (existing.serverId !== confirmedNodeId || existing.replicaId !== replicaId
      || existing.ledgerId !== confirmedLedgerId || existing.backupPath !== backupPath) {
      throw new Error('已有不同的副本清理未完成；须先恢复该操作');
    }
    const verification = await verifyServerBackup(backupPath);
    if (!verification.ok || verification.manifest.serverId !== confirmedNodeId) {
      throw new Error('清理前备份失效；保留未完成标记和原数据');
    }
    pending = existing;
    inspection = { serverId: existing.serverId, replicaId: existing.replicaId,
      ledgerId: existing.ledgerId, otherLedgerIds: existing.otherLedgerIds,
      objectCount: existing.objectCount, uploadCount: existing.uploadCount,
      namespaces: existing.namespaces, issues: [] };
  } else {
    inspection = await inspectLocalReplicaRetirement(dataDir, replicaId);
    if (inspection.ledgerId !== confirmedLedgerId) throw new Error('确认的账本 ID 与副本槽位不一致');
    if (inspection.issues.length) throw new Error(`副本尚不能清理：${inspection.issues.join('；')}`);
    const manifest = await createServerBackup(dataDir, backupPath);
    const verification = await verifyServerBackup(backupPath);
    if (!verification.ok || manifest.serverId !== confirmedNodeId
      || verification.manifest.serverId !== confirmedNodeId) throw new Error('独立备份未通过校验；原数据保留');
    assertServerStopped(dataDir);
    const current = await inspectLocalReplicaRetirement(dataDir, replicaId);
    if (current.issues.length || current.ledgerId !== inspection.ledgerId
      || JSON.stringify(current.namespaces) !== JSON.stringify(inspection.namespaces)
      || current.objectCount !== inspection.objectCount || current.uploadCount !== inspection.uploadCount) {
      throw new Error('备份后副本目录发生变化；原数据保留');
    }
    pending = { version: 1, serverId: confirmedNodeId, replicaId,
      ledgerId: inspection.ledgerId, backupPath,
      otherLedgerIds: inspection.otherLedgerIds, objectCount: inspection.objectCount,
      uploadCount: inspection.uploadCount, namespaces: inspection.namespaces };
    writeMarker(dataDir, pending);
  }
  assertServerStopped(dataDir);
  await removeReplicaRows(dataDir, pending);
  removeReplicaFiles(dataDir, pending.namespaces);
  const db = new NodeSqliteDriver(join(dataDir, 'server.sqlite'));
  try {
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    const check = await db.get<Record<string, unknown>>('PRAGMA quick_check');
    if (String(Object.values(check ?? {})[0] ?? '') !== 'ok'
      || await db.get('PRAGMA foreign_key_check')) throw new Error('清理后数据库完整性检查失败');
  } finally { await db.close(); }
  for (const namespace of pending.namespaces) for (const folder of BLOB_DIRS) {
    if (existsSync(join(dataDir, 'blobs', folder, namespace))) {
      throw new Error('附件目录尚未完全清理；保留未完成标记');
    }
  }
  rmSync(markerPath(dataDir));
  return { ...inspection, backupPath, resumed: Boolean(existing) };
}
