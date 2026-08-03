/**
 * DDL. Generated from the table registry plus the hand-written tables that don't
 * follow the BaseEntity shape: conversion_steps (a value object owned by a chain),
 * operation_log (audit trail / §0.7), and schema_migrations.
 */
import { TABLES, allCols, type TableSpec, type ColType } from './tables.js';

const SQL_TYPE: Record<ColType, string> = {
  text: 'TEXT',
  int: 'INTEGER',
  real: 'REAL',
  bool: 'INTEGER',
};

function createTableSql(spec: TableSpec): string {
  const defs = allCols(spec).map((col) => {
    if (col.col === 'id') return '  id TEXT PRIMARY KEY';
    if (col.col === 'is_deleted') return '  is_deleted INTEGER NOT NULL DEFAULT 0';
    if (col.col === 'version') return '  version INTEGER NOT NULL DEFAULT 1';
    return `  ${col.col} ${SQL_TYPE[col.type]}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${spec.name} (\n${defs.join(',\n')}\n);`;
}

function indexSql(spec: TableSpec): string[] {
  return (spec.indexes ?? []).map(
    (ix) => `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${ix.name} ON ${spec.name} (${ix.cols.join(', ')})${ix.where ? ` WHERE ${ix.where}` : ''};`,
  );
}

/** conversion_steps: ordered value objects belonging to a chain (no soft-delete). */
const CONVERSION_STEPS_SQL = `
CREATE TABLE IF NOT EXISTS conversion_steps (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  from_asset_id TEXT NOT NULL,
  from_amount TEXT NOT NULL,
  to_asset_id TEXT NOT NULL,
  to_amount TEXT NOT NULL,
  source_amount_mode TEXT,
  target_amount_mode TEXT,
  fees_json TEXT,
  reference_rate TEXT,
  platform TEXT,
  account_from_id TEXT,
  account_to_id TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_steps_chain ON conversion_steps (chain_id);`;

/** operation_log: one row per mutation for durable product audit history. */
const OPERATION_LOG_SQL = `
CREATE TABLE IF NOT EXISTS operation_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  device_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  version INTEGER,
  payload TEXT,
  before_payload TEXT,
  after_payload TEXT,
  changed_keys TEXT,
  diff_json TEXT,
  batch_id TEXT,
  source TEXT,
  actor_name TEXT,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_oplog_entity ON operation_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_oplog_at ON operation_log (at);
CREATE INDEX IF NOT EXISTS idx_oplog_batch ON operation_log (batch_id);`;

const AUDIT_BATCHES_SQL = `
CREATE TABLE IF NOT EXISTS audit_batches (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  device_id TEXT,
  actor_name TEXT,
  entity_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  source_commit_id TEXT,
  source_server_id TEXT,
  source_replica_key TEXT,
  applied_count INTEGER,
  skipped_count INTEGER,
  conflict_count INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_batches_started ON audit_batches (started_at);`;

const BUSINESS_COMPENSATIONS_SQL = `
CREATE TABLE IF NOT EXISTS business_compensations (
  id TEXT PRIMARY KEY,
  source_batch_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  affected_entities_json TEXT NOT NULL,
  applied_at TEXT,
  applied_batch_id TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_business_compensations_status
  ON business_compensations (status, created_at);
CREATE INDEX IF NOT EXISTS idx_business_compensations_batch
  ON business_compensations (source_batch_id);`;

const LEDGER_META_SQL = `
CREATE TABLE IF NOT EXISTS ledger_meta (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL UNIQUE,
  protocol_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);`;

/** One encrypted relay unit maps to one local atomic business commit. */
const SYNC_COMMITS_SQL = `
CREATE TABLE IF NOT EXISTS sync_commits (
  commit_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  origin_device_name TEXT,
  created_at TEXT NOT NULL,
  parent_commit_ids TEXT NOT NULL,
  resolves_conflict_commit_ids TEXT NOT NULL,
  source TEXT NOT NULL,
  source_replica_key TEXT,
  sealed INTEGER NOT NULL,
  state TEXT NOT NULL,
  content_hash TEXT,
  received_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_commits_state ON sync_commits (state, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_commits_ledger ON sync_commits (ledger_id, created_at);`;

const SYNC_REVISIONS_SQL = `
CREATE TABLE IF NOT EXISTS sync_revisions (
  revision_id TEXT PRIMARY KEY,
  commit_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  parent_revision_ids TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_revision_commit_aggregate
  ON sync_revisions (commit_id, aggregate_type, aggregate_id);
CREATE INDEX IF NOT EXISTS idx_sync_revision_aggregate
  ON sync_revisions (aggregate_type, aggregate_id);`;

/** Multiple rows are allowed while disjoint concurrent revisions are materialized. */
const SYNC_ENTITY_HEADS_SQL = `
CREATE TABLE IF NOT EXISTS sync_entity_heads (
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  PRIMARY KEY (aggregate_type, aggregate_id, revision_id)
);`;

const SYNC_LEDGER_HEADS_SQL = `
CREATE TABLE IF NOT EXISTS sync_ledger_heads (
  commit_id TEXT PRIMARY KEY
);`;

const SYNC_REPLICA_STATE_SQL = `
CREATE TABLE IF NOT EXISTS sync_replica_state (
  replica_key TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  replica_id TEXT NOT NULL,
  stream_epoch TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  retired_at TEXT
);`;

const SYNC_REPLICA_ACKS_SQL = `
CREATE TABLE IF NOT EXISTS sync_replica_acks (
  replica_key TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (replica_key, commit_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_replica_acks_commit ON sync_replica_acks (commit_id);`;

const SYNC_CONFLICT_GROUPS_SQL = `
CREATE TABLE IF NOT EXISTS sync_conflict_groups (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL,
  local_commit_ids TEXT NOT NULL,
  remote_commit_ids TEXT NOT NULL,
  changed_paths TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_conflict_status ON sync_conflict_groups (status, at);`;

const SYNC_CONFLICT_BRANCHES_SQL = `
CREATE TABLE IF NOT EXISTS sync_conflict_branches (
  group_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  role TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  source_replica_key TEXT,
  parent_revision_ids TEXT NOT NULL,
  payload TEXT,
  PRIMARY KEY (group_id, revision_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_conflict_branch_aggregate
  ON sync_conflict_branches (aggregate_type, aggregate_id);`;

const SYNC_CONFLICT_RESOLUTIONS_SQL = `
CREATE TABLE IF NOT EXISTS sync_conflict_resolutions (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  resolver_device_id TEXT,
  action TEXT NOT NULL,
  resolved_commit_id TEXT,
  detail_json TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_conflict_resolved_at ON sync_conflict_resolutions (resolved_at);`;

/** Local attachment content state. These rows are never projected into sync commits. */
const ATTACHMENT_BLOBS_SQL = `
CREATE TABLE IF NOT EXISTS attachment_blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  state TEXT NOT NULL,
  verified_at TEXT,
  last_accessed_at TEXT,
  trash_after TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachment_blobs_state ON attachment_blobs (state, trash_after);`;

/** Durable bridge between SQLite commits and browser/native file operations. */
const ATTACHMENT_FILE_OPS_SQL = `
CREATE TABLE IF NOT EXISTS attachment_file_ops (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  attachment_id TEXT,
  content_sha256 TEXT,
  thumbnail_sha256 TEXT,
  phase TEXT NOT NULL,
  temp_content_key TEXT,
  temp_thumbnail_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachment_file_ops_phase ON attachment_file_ops (phase, updated_at);`;

/** Per-server encrypted object transfer state. Credentials and plaintext never enter this table. */
const ATTACHMENT_REPLICA_BLOBS_SQL = `
CREATE TABLE IF NOT EXISTS attachment_replica_blobs (
  profile_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  remote_blob_id TEXT NOT NULL,
  state TEXT NOT NULL,
  upload_id TEXT,
  uploaded_chunks_json TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  verified_at TEXT,
  retry_at TEXT,
  updated_at TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (profile_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_attachment_replica_state
  ON attachment_replica_blobs (profile_id, state, retry_at);`;

const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

const TRANSACTION_READ_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_transactions_report_date
  ON transactions (
    (CASE WHEN type = 'refund' THEN COALESCE(refund_effect_date, date) ELSE date END),
    id
  );
CREATE INDEX IF NOT EXISTS idx_transactions_record_report_date
  ON transactions (
    is_deleted,
    record_state,
    (CASE WHEN type = 'refund' THEN COALESCE(refund_effect_date, date) ELSE date END),
    id
  );`;

/** Every statement for the v1 schema, in dependency-free order. */
export function schemaStatements(): string[] {
  const stmts: string[] = [];
  for (const spec of Object.values(TABLES) as TableSpec[]) {
    stmts.push(createTableSql(spec));
    stmts.push(...indexSql(spec));
  }
  stmts.push(CONVERSION_STEPS_SQL);
  stmts.push(OPERATION_LOG_SQL);
  stmts.push(AUDIT_BATCHES_SQL);
  stmts.push(BUSINESS_COMPENSATIONS_SQL);
  stmts.push(LEDGER_META_SQL);
  stmts.push(SYNC_COMMITS_SQL);
  stmts.push(SYNC_REVISIONS_SQL);
  stmts.push(SYNC_ENTITY_HEADS_SQL);
  stmts.push(SYNC_LEDGER_HEADS_SQL);
  stmts.push(SYNC_REPLICA_STATE_SQL);
  stmts.push(SYNC_REPLICA_ACKS_SQL);
  stmts.push(SYNC_CONFLICT_GROUPS_SQL);
  stmts.push(SYNC_CONFLICT_BRANCHES_SQL);
  stmts.push(SYNC_CONFLICT_RESOLUTIONS_SQL);
  stmts.push(ATTACHMENT_BLOBS_SQL);
  stmts.push(ATTACHMENT_FILE_OPS_SQL);
  stmts.push(ATTACHMENT_REPLICA_BLOBS_SQL);
  stmts.push(TRANSACTION_READ_INDEXES_SQL);
  return stmts;
}

export {
  LEDGER_META_SQL,
  SYNC_COMMITS_SQL,
  SYNC_REVISIONS_SQL,
  SYNC_ENTITY_HEADS_SQL,
  SYNC_LEDGER_HEADS_SQL,
  SYNC_REPLICA_STATE_SQL,
  SYNC_REPLICA_ACKS_SQL,
  SYNC_CONFLICT_GROUPS_SQL,
  SYNC_CONFLICT_BRANCHES_SQL,
  SYNC_CONFLICT_RESOLUTIONS_SQL,
  ATTACHMENT_BLOBS_SQL,
  ATTACHMENT_FILE_OPS_SQL,
  ATTACHMENT_REPLICA_BLOBS_SQL,
  AUDIT_BATCHES_SQL,
  BUSINESS_COMPENSATIONS_SQL,
};

export { MIGRATIONS_TABLE_SQL };
