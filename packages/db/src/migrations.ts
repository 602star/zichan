/**
 * Development schema baseline, with an in-place upgrade from the immediately
 * preceding ledger-timezone schema so account onboarding preserves existing data.
 */
import type { Logger } from '@zichan/logger';
import type { SqlDriver } from './driver.js';
import { MIGRATIONS_TABLE_SQL, schemaStatements } from './schema.js';
import { TABLES, allCols, type TableSpec } from './tables.js';

export const CURRENT_SCHEMA_VERSION = 118;
export const CURRENT_SCHEMA_NAME = 'current_schema_2026_09_18_account_onboarding';
export const SCHEMA_RESET_REQUIRED_CODE = 'SCHEMA_RESET_REQUIRED';

export class SchemaResetRequiredError extends Error {
  readonly code = SCHEMA_RESET_REQUIRED_CODE;

  constructor(detail: string) {
    super(`开发期数据库不是当前结构，请在错误页重置本地开发数据。${detail ? ` ${detail}` : ''}`);
    this.name = 'SchemaResetRequiredError';
  }
}

export interface Migration {
  version: number;
  name: string;
  up: (driver: SqlDriver) => Promise<void>;
}

export const MIGRATIONS: Migration[] = [{
  version: CURRENT_SCHEMA_VERSION,
  name: CURRENT_SCHEMA_NAME,
  up: async (driver) => {
    for (const statement of schemaStatements()) await driver.exec(statement);
  },
}];

const SUPPORT_TABLE_COLUMNS: Record<string, string[]> = {
  conversion_steps: [
    'id', 'chain_id', 'step_order', 'from_asset_id', 'from_amount', 'to_asset_id', 'to_amount',
    'source_amount_mode', 'target_amount_mode', 'fees_json', 'reference_rate', 'platform',
    'account_from_id', 'account_to_id', 'note',
  ],
  operation_log: [
    'id', 'at', 'device_id', 'entity_type', 'entity_id', 'op', 'version', 'payload',
    'before_payload', 'after_payload', 'changed_keys', 'diff_json', 'batch_id', 'source',
    'actor_name', 'summary',
  ],
  audit_batches: [
    'id', 'type', 'label', 'started_at', 'finished_at', 'device_id', 'actor_name',
    'entity_count', 'summary', 'source_commit_id', 'source_server_id', 'source_replica_key',
    'applied_count', 'skipped_count', 'conflict_count', 'outcome',
  ],
  business_compensations: [
    'id', 'source_batch_id', 'label', 'created_at', 'status', 'payload_json',
    'affected_entities_json', 'applied_at', 'applied_batch_id', 'error',
  ],
  ledger_meta: ['id', 'ledger_id', 'protocol_version', 'created_at'],
  sync_commits: [
    'commit_id', 'ledger_id', 'origin_device_id', 'origin_device_name', 'created_at',
    'parent_commit_ids', 'resolves_conflict_commit_ids', 'source', 'source_replica_key',
    'sealed', 'state', 'content_hash',
    'received_at', 'error',
  ],
  sync_revisions: [
    'revision_id', 'commit_id', 'aggregate_type', 'aggregate_id',
    'parent_revision_ids', 'op', 'payload',
  ],
  sync_entity_heads: ['aggregate_type', 'aggregate_id', 'revision_id'],
  sync_ledger_heads: ['commit_id'],
  sync_replica_state: [
    'replica_key', 'server_id', 'replica_id', 'stream_epoch', 'ledger_id',
    'cursor', 'head_seq', 'updated_at', 'retired_at',
  ],
  sync_replica_acks: ['replica_key', 'commit_id', 'server_seq', 'content_hash', 'updated_at'],
  sync_conflict_groups: [
    'id', 'ledger_id', 'at', 'status', 'local_commit_ids', 'remote_commit_ids',
    'changed_paths', 'resolved_at',
  ],
  sync_conflict_branches: [
    'group_id', 'revision_id', 'commit_id', 'aggregate_type', 'aggregate_id',
    'role', 'origin_device_id', 'source_replica_key', 'parent_revision_ids', 'payload',
  ],
  sync_conflict_resolutions: [
    'id', 'group_id', 'resolved_at', 'resolver_device_id', 'action',
    'resolved_commit_id', 'detail_json', 'note',
  ],
  attachment_blobs: [
    'sha256', 'size_bytes', 'mime_type', 'state', 'verified_at', 'last_accessed_at',
    'trash_after', 'error',
  ],
  attachment_file_ops: [
    'id', 'kind', 'attachment_id', 'content_sha256', 'thumbnail_sha256', 'phase',
    'temp_content_key', 'temp_thumbnail_key', 'created_at', 'updated_at', 'error',
  ],
  attachment_replica_blobs: [
    'profile_id', 'sha256', 'remote_blob_id', 'state', 'upload_id',
    'uploaded_chunks_json', 'key_version', 'verified_at', 'retry_at', 'updated_at', 'error',
  ],
  schema_migrations: ['version', 'name', 'applied_at'],
};

function expectedSchema(): Map<string, string[]> {
  const expected = new Map<string, string[]>();
  for (const spec of Object.values(TABLES) as TableSpec[]) {
    expected.set(spec.name, allCols(spec).map((column) => column.col));
  }
  for (const [table, columns] of Object.entries(SUPPORT_TABLE_COLUMNS)) expected.set(table, columns);
  return expected;
}

function difference(left: Iterable<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

export async function assertCurrentSchema(driver: SqlDriver): Promise<void> {
  const expected = expectedSchema();
  const tableRows = await driver.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const actualTables = new Set(tableRows.map((row) => row.name));
  const expectedTables = new Set(expected.keys());
  const missingTables = difference(expectedTables, actualTables);
  const extraTables = difference(actualTables, expectedTables);
  if (missingTables.length || extraTables.length) {
    throw new SchemaResetRequiredError(
      `表结构不一致（缺少：${missingTables.join('、') || '无'}；多出：${extraTables.join('、') || '无'}）。`,
    );
  }

  for (const [table, columns] of expected) {
    const actualRows = await driver.all<{ name: string }>(`PRAGMA table_info(${table})`);
    const actual = new Set(actualRows.map((row) => row.name));
    const wanted = new Set(columns);
    const missing = difference(wanted, actual);
    const extra = difference(actual, wanted);
    if (missing.length || extra.length) {
      throw new SchemaResetRequiredError(
        `${table} 列不一致（缺少：${missing.join('、') || '无'}；多出：${extra.join('、') || '无'}）。`,
      );
    }
  }

  for (const spec of Object.values(TABLES) as TableSpec[]) {
    if (!spec.indexes?.length) continue;
    const actualIndexes = await driver.all<{ name: string; unique: number; partial: number }>(
      `PRAGMA index_list(${spec.name})`,
    );
    const byName = new Map(actualIndexes.map((index) => [index.name, index]));
    for (const wanted of spec.indexes) {
      const actual = byName.get(wanted.name);
      if (!actual) throw new SchemaResetRequiredError(`${spec.name} 缺少索引 ${wanted.name}。`);
      if (Boolean(actual.unique) !== Boolean(wanted.unique) || Boolean(actual.partial) !== Boolean(wanted.where)) {
        throw new SchemaResetRequiredError(`${spec.name} 索引 ${wanted.name} 的唯一性或条件属性不一致。`);
      }
      const actualColumns = (await driver.all<{ name: string }>(`PRAGMA index_info(${wanted.name})`))
        .map((row) => row.name);
      if (actualColumns.length !== wanted.cols.length
        || actualColumns.some((column, index) => column !== wanted.cols[index])) {
        throw new SchemaResetRequiredError(`${spec.name} 索引 ${wanted.name} 的列不一致。`);
      }
    }
  }
}

export function isSchemaResetRequiredError(error: unknown): error is SchemaResetRequiredError {
  return error instanceof SchemaResetRequiredError
    || (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === SCHEMA_RESET_REQUIRED_CODE);
}

export async function runMigrations(driver: SqlDriver, log: Logger): Promise<number> {
  const tablesBefore = await driver.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const tableNames = tablesBefore.map((row) => row.name);
  const hasMigrationTable = tableNames.includes('schema_migrations');
  if (!hasMigrationTable && tableNames.length) {
    throw new SchemaResetRequiredError(`检测到未标记的旧表：${tableNames.join('、')}。`);
  }

  if (!hasMigrationTable) {
    const baseline = MIGRATIONS[0]!;
    log.info('creating current schema baseline', { version: baseline.version, name: baseline.name });
    await driver.transaction(async (transaction) => {
      await transaction.exec(MIGRATIONS_TABLE_SQL);
      await baseline.up(transaction);
      await assertCurrentSchema(transaction);
      await transaction.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [baseline.version, baseline.name, new Date().toISOString()],
      );
    });
    return 1;
  }

  const applied = await driver.all<{ version: number; name: string }>(
    'SELECT version, name FROM schema_migrations ORDER BY version',
  );

  if (applied.length === 1 && applied[0]?.version === 117 && applied[0]?.name === 'current_schema_2026_09_14_ledger_timezone') {
    await driver.transaction(async (transaction) => {
      for (const [table, fields] of Object.entries({
        accounts: ['purpose', 'opening_balance', 'opening_asset_id', 'balance_start_at', 'balance_start_date', 'balance_checkpoints'],
        settings: ['expense_default_account_id', 'income_default_account_id', 'as_of_mode'],
        transactions: ['balance_timing', 'balance_timing_account_id'],
      })) {
        for (const field of fields) await transaction.exec(`ALTER TABLE ${table} ADD COLUMN ${field} TEXT`);
      }
      await assertCurrentSchema(transaction);
      await transaction.run('UPDATE schema_migrations SET version = ?, name = ?, applied_at = ?',
        [CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_NAME, new Date().toISOString()]);
    });
    return 1;
  }

  if (applied.length === 0) {
    const preexisting = tableNames.filter((name) => name !== 'schema_migrations');
    if (preexisting.length) {
      throw new SchemaResetRequiredError(`检测到未标记的旧表：${preexisting.join('、')}。`);
    }
    const baseline = MIGRATIONS[0]!;
    log.info('creating current schema baseline', { version: baseline.version, name: baseline.name });
    await driver.transaction(async (transaction) => {
      await baseline.up(transaction);
      await assertCurrentSchema(transaction);
      await transaction.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [baseline.version, baseline.name, new Date().toISOString()],
      );
    });
    return 1;
  }

  if (
    applied.length !== 1
    || applied[0]?.version !== CURRENT_SCHEMA_VERSION
    || applied[0]?.name !== CURRENT_SCHEMA_NAME
  ) {
    throw new SchemaResetRequiredError(
      `检测到历史 schema 标记：${applied.map((row) => `${row.version}:${row.name}`).join('、')}。`,
    );
  }

  await assertCurrentSchema(driver);
  log.debug('current schema verified', { version: CURRENT_SCHEMA_VERSION });
  return 0;
}
