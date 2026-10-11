import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NodeSqliteDriver } from '@zichan/db/node';
import type { SqlDriver } from '@zichan/db';
import { assertServerStopped, createServerBackup, verifyServerBackup } from './backup.js';
import { CURRENT_SERVER_SCHEMA, CURRENT_SERVER_SCHEMA_NAME,
  RETIRED_SERVER_SCHEMA, RETIRED_SERVER_SCHEMA_NAME } from './store.js';

export interface LegacyShadowRetirement {
  backupPath: string;
  backupServerId: string;
  removed: { commits: number; keyEnvelopes: number; requirements: number; archives: number };
  commitCipherBytes: number;
  databaseBytesBefore: number;
  databaseBytesAfter: number;
  vacuumed: boolean;
  vacuumIssue?: string;
}

const LEGACY_TABLES = [
  'sync_server_commits', 'sync_key_envelopes', 'sync_ledger_requirements', 'sync_backup_archives',
] as const;

async function count(driver: SqlDriver, table: string): Promise<number> {
  const row = await driver.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(row?.count ?? 0);
}

/** Only a fresh, verified, off-server backup permits retiring duplicate ciphertext. */
export async function retireLegacyShadowPayload(dataDirValue: string, backupPathValue: string,
  options: { vacuum?: boolean } = {}): Promise<LegacyShadowRetirement> {
  const dataDir = resolve(dataDirValue);
  const backupPath = resolve(backupPathValue);
  assertServerStopped(dataDir);
  const backup = await createServerBackup(dataDir, backupPath);
  const verification = await verifyServerBackup(backupPath);
  if (!verification.ok || verification.manifest.serverId !== backup.serverId) {
    throw new Error(`独立备份未通过校验：${verification.issues.join('；')}`);
  }
  assertServerStopped(dataDir);
  const file = join(dataDir, 'server.sqlite');
  if (readFileSync(join(dataDir, 'server-id'), 'utf8').trim() !== backup.serverId) {
    throw new Error('备份服务器身份与待清理数据不一致');
  }
  const databaseBytesBefore = statSync(file).size;
  const driver = new NodeSqliteDriver(file);
  let removed!: LegacyShadowRetirement['removed'];
  let commitCipherBytes = 0;
  try {
    const schema = await driver.get<{ version: number; name: string }>(
      'SELECT version, name FROM server_schema_migrations');
    if (schema?.version !== CURRENT_SERVER_SCHEMA || schema.name !== CURRENT_SERVER_SCHEMA_NAME) {
      throw new Error('仅支持 schema 24 的旧影子数据清理；数据库未修改');
    }
    const check = await driver.get<Record<string, unknown>>('PRAGMA quick_check');
    if (String(Object.values(check ?? {})[0] ?? '') !== 'ok') {
      throw new Error('源数据库完整性检查失败；数据库未修改');
    }
    if (await driver.get('PRAGMA foreign_key_check')) {
      throw new Error('源数据库外键检查失败；数据库未修改');
    }
    const deletingTriggers = (await driver.all<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name IN (${LEGACY_TABLES.map(() => '?').join(', ')})`,
    [...LEGACY_TABLES])).filter((row) => /\bDELETE\b/i.test(row.sql));
    if (deletingTriggers.length) throw new Error(`旧表仍有删除触发器：${deletingTriggers.map((row) => row.name).join('、')}`);
    const driftSql = `SELECT 'commits' AS source WHERE EXISTS (
      SELECT 1 FROM sync_server_commits legacy WHERE NOT EXISTS (
        SELECT 1 FROM ledger_account_routes route
          JOIN ledger_replica_commits replica ON replica.replica_id = route.replica_id
          WHERE route.username = legacy.username AND replica.seq = legacy.seq
            AND replica.commit_id = legacy.commit_id AND replica.ledger_id = legacy.ledger_id
            AND replica.content_hash = legacy.content_hash
            AND replica.enc_commit_json = legacy.enc_commit_json
            AND replica.cipher_bytes = legacy.cipher_bytes
            AND replica.key_epoch = legacy.key_epoch
            AND replica.writer_issuer_node_id IS legacy.writer_issuer_node_id
            AND replica.writer_account_id IS legacy.writer_account_id))
      UNION ALL SELECT 'key envelopes' WHERE EXISTS (
        SELECT 1 FROM sync_key_envelopes legacy WHERE NOT EXISTS (
          SELECT 1 FROM ledger_account_routes route
            JOIN ledger_replica_key_envelopes replica ON replica.replica_id = route.replica_id
            WHERE route.username = legacy.username AND replica.ledger_id = legacy.ledger_id
              AND replica.keyring_id = legacy.keyring_id
              AND (replica.generation > legacy.generation OR replica.generation = legacy.generation
                AND replica.envelope_json = legacy.envelope_json)))
      UNION ALL SELECT 'requirements' WHERE EXISTS (
        SELECT 1 FROM sync_ledger_requirements legacy WHERE NOT EXISTS (
          SELECT 1 FROM ledger_account_routes route
            JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
            JOIN ledger_replica_requirements replica ON replica.replica_id = route.replica_id
            WHERE route.username = legacy.username AND slot.ledger_id = legacy.ledger_id
              AND replica.capability = legacy.capability))
      UNION ALL SELECT 'backup archives' WHERE EXISTS (
        SELECT 1 FROM sync_backup_archives legacy WHERE NOT EXISTS (
          SELECT 1 FROM ledger_backup_archives replica
            WHERE replica.username = legacy.username AND replica.ledger_id = legacy.ledger_id
              AND replica.archive_id = legacy.archive_id AND replica.blob_id = legacy.blob_id
              AND replica.created_at = legacy.created_at AND replica.reason = legacy.reason
              AND replica.kind = legacy.kind AND replica.label = legacy.label
              AND replica.size_bytes = legacy.size_bytes
              AND replica.source_generation IS legacy.source_generation
              AND replica.deleted_at IS legacy.deleted_at)) LIMIT 1`;
    const drift = await driver.get<{ source: string }>(driftSql);
    if (drift) throw new Error(`旧影子数据与副本权威表不一致（${drift.source}）；已保留原数据和备份`);
    await driver.transaction(async (tx) => {
      assertServerStopped(dataDir);
      const currentDrift = await tx.get<{ source: string }>(driftSql);
      if (currentDrift) throw new Error(`旧影子数据与副本权威表不一致（${currentDrift.source}）；已保留原数据和备份`);
      const bytes = await tx.get<{ value: number }>(
        'SELECT COALESCE(SUM(LENGTH(CAST(enc_commit_json AS BLOB))), 0) AS value FROM sync_server_commits');
      commitCipherBytes = Number(bytes?.value ?? 0);
      removed = {
        commits: await count(tx, 'sync_server_commits'),
        keyEnvelopes: await count(tx, 'sync_key_envelopes'),
        requirements: await count(tx, 'sync_ledger_requirements'),
        archives: await count(tx, 'sync_backup_archives'),
      };
      for (const table of LEGACY_TABLES) await tx.run(`DELETE FROM ${table}`);
      const at = new Date().toISOString();
      await tx.run(`INSERT INTO server_meta (key, value, updated_at)
        VALUES ('legacy_shadow_payload_retired', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify({ backupPath, backupServerId: backup.serverId, removed, commitCipherBytes }), at]);
      await tx.run(`UPDATE server_schema_migrations SET version = ?, name = ?, applied_at = ?
        WHERE version = ? AND name = ?`,
      [RETIRED_SERVER_SCHEMA, RETIRED_SERVER_SCHEMA_NAME, at,
        CURRENT_SERVER_SCHEMA, CURRENT_SERVER_SCHEMA_NAME]);
      await tx.exec(`DROP TABLE sync_server_commits;
        DROP TABLE sync_key_envelopes;
        DROP TABLE sync_ledger_requirements;
        DROP TABLE sync_backup_archives;`);
    });
    const afterCheck = await driver.get<Record<string, unknown>>('PRAGMA quick_check');
    if (String(Object.values(afterCheck ?? {})[0] ?? '') !== 'ok') {
      throw new Error('清理后数据库完整性检查失败，请停服并从已验证备份恢复');
    }
    if (await driver.get('PRAGMA foreign_key_check')) {
      throw new Error('清理后数据库外键检查失败，请停服并从已验证备份恢复');
    }
    let vacuumed = false;
    let vacuumIssue: string | undefined;
    if (options.vacuum) {
      try {
        await driver.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
        vacuumed = true;
      } catch (error) {
        vacuumIssue = error instanceof Error ? error.message : String(error);
      }
    }
    return { backupPath, backupServerId: backup.serverId, removed, commitCipherBytes,
      databaseBytesBefore, databaseBytesAfter: statSync(file).size,
      vacuumed, ...(vacuumIssue ? { vacuumIssue } : {}) };
  } finally { await driver.close(); }
}
