import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { NodeSqliteDriver } from '@zichan/db/node';

export type RegistrationMode = 'open' | 'invite' | 'closed';
export type AccountRole = 'owner' | 'admin' | 'viewer' | 'member';

/**
 * One expression decides every role: ownership wins, then an administrator grant — which is
 * read-only when flagged. Every SQL path and `roleForUser` share it, so the console, the API
 * and the task runner cannot disagree about what a given account may do.
 */
export const ROLE_SQL = "CASE WHEN o.username IS NOT NULL THEN 'owner' WHEN a.username IS NOT NULL THEN (CASE WHEN a.read_only = 1 THEN 'viewer' ELSE 'admin' END) ELSE 'member' END";
export type ServerLogLevel = 'info' | 'warn' | 'error';
export type JsonRecord = Record<string, unknown>;
export interface LedgerProtection {
  mode: 'managed' | 'private' | 'relay';
  version: number;
  sealedSecret: string | null;
}

export interface SyncUser {
  accountId: string;
  username: string;
  opaqueRegistrationRecord: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  /** Bumped on every administrative mutation; used as the optimistic-concurrency token. */
  revision: number;
}

export interface OpaqueLoginState {
  id: string;
  username: string;
  serverLoginState: string;
  ip: string;
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
}

export interface SyncSession {
  id: string;
  username: string;
  deviceId: string;
  deviceName: string;
  refreshHash: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastSeenAt: string;
  lastIp?: string;
  revokedAt?: string;
  /** `admin` for management-console logins, `ledger` for accounting devices. */
  kind: string;
}

export interface UserReplica {
  username: string;
  ledgerId: string;
  replicaId: string;
  streamEpoch: string;
  headSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredCommit {
  seq: number;
  commitId: string;
  ledgerId: string;
  contentHash: string;
  encCommit: JsonRecord;
  cipherBytes: number;
  createdAt: string;
}

export interface Invite {
  code: string;
  createdAt: string;
  usedBy?: string;
  usedAt?: string;
  disabled: boolean;
  expiresAt?: string;
}

export type AdminMutation =
  | { action: 'password-reset-issue'; accountId: string; codeHash: string; expiresAt: string }
  | { action: 'password-reset-revoke'; accountId: string }
  | { action: 'role'; accountId: string; role: 'admin' | 'viewer' | 'member' }
  | { action: 'state'; accountId: string; disabled: boolean }
  | { action: 'commit-quota'; accountId: string; bytes: number | null }
  | { action: 'blob-quota'; accountId: string; bytes: number | null }
  | { action: 'revoke-session'; sessionId: string }
  | { action: 'registration'; mode: RegistrationMode }
  /** Records an allow-listed settings change; carries no target account. */
  | { action: 'settings-save'; keys: string[] }
  | { action: 'sessions-revoke-all'; accountId: string; keepSessionId?: string }
  | { action: 'invite-create'; code: string; expiresAt: string }
  | { action: 'invite-state'; code: string; disabled: boolean }
  /** Alert lifecycle: acknowledgement and silence are audited like any other management act. */
  | { action: 'alert-acknowledge'; key: string }
  | { action: 'alert-silence'; key: string; hours: number }
  /** Second-factor changes on the actor's own account; audited like any other security change. */
  | { action: 'mfa-enroll'; accountId: string }
  | { action: 'mfa-disable'; accountId: string }
  | { action: 'mfa-recovery-codes'; accountId: string }
  | { action: 'alert-unsilence'; key: string };

export interface ServerLog {
  id: string;
  at: string;
  level: ServerLogLevel;
  action: string;
  message: string;
  ip?: string;
  username?: string;
  status?: number;
  detail?: JsonRecord;
}

export interface ServerStatus {
  claimed: boolean;
  ownerUsername?: string;
  registrationMode: RegistrationMode;
  userCount: number;
  disabledUserCount: number;
  inviteCount: number;
  commitCount: number;
  commitBytes: number;
  activeSessionCount: number;
  journalMode: string;
  tempStore: string;
  schemaVersion: number;
}

export interface ServerBackupArchive {
  archiveId: string;
  ledgerId: string;
  blobId: string;
  createdAt: string;
  reason: 'auto' | 'manual' | 'pre-import';
  kind: 'portable' | 'device';
  label: string;
  sizeBytes: number;
  sourceGeneration?: string;
}

export type AdminJobType =
  | 'database.integrity-check'
  | 'blobs.verify'
  | 'storage.cleanup'
  | 'logs.prune'
  | 'metrics.prune'
  | 'backup.verify'
  | 'restore.drill';
export type AdminJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface AdminJob {
  jobId: string;
  type: AdminJobType;
  params: JsonRecord;
  status: AdminJobStatus;
  createdAt: string;
  createdBy: string;
  targetAccountId?: string;
  startedAt?: string;
  finishedAt?: string;
  phase?: string;
  processed: number;
  total: number;
  result?: JsonRecord;
  errorCode?: string;
  errorMessage?: string;
  cancelRequested: boolean;
  retryOf?: string;
}

export interface AdminJobEvent {
  id: number;
  jobId: string;
  at: string;
  level: ServerLogLevel;
  message: string;
  detail?: JsonRecord;
}

/** Server-visible sync outcome. Client-side offline failures are out of scope by design. */
export type SyncEventCategory =
  | 'session-invalid'
  | 'quota-exceeded'
  | 'protocol-incompatible'
  | 'ledger-mismatch'
  | 'server-storage-error'
  | 'other';

export interface SyncEvent {
  id: string;
  at: string;
  username?: string;
  accountId?: string;
  deviceName?: string;
  operation: string;
  outcome: 'ok' | 'error';
  resultCode?: string;
  category?: SyncEventCategory;
  commitCount?: number;
  bytes?: number;
  durationMs?: number;
  requestId?: string;
}

export interface MetricBucket {
  bucketAt: string;
  requests: number;
  errors: number;
  slowRequests: number;
  durationMs: number;
  syncPushOk: number;
  syncPushFailed: number;
  syncPullOk: number;
  blobOk: number;
  blobFailed: number;
}

/** An administrator's enrolled second factor. The secret is stored encrypted. */
export interface AdminMfaRecord {
  username: string;
  secretCipher: string;
  /** False while enrollment is half-finished; such a record never gates login. */
  confirmed: boolean;
  enabledAt: string;
  lastStep: number;
  /** Hashes of the recovery codes that have not been used yet. */
  recoveryHashes: string[];
  enrolledBy?: string;
}

export interface AdminAlert {
  key: string;
  rule: string;
  scope: string;
  severity: 'warning' | 'critical';
  state: 'pending' | 'active' | 'resolved';
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  /** Bad samples in a row; only two in a row activate the alert. */
  consecutive: number;
  /** Silence stops external notifications and lowers priority; the record itself stays. */
  silencedUntil?: string;
  silencedBy?: string;
  silenceReason?: string;
  /** Last external notification attempt for this alert. */
  lastNotifiedAt?: string;
  notifyState?: 'sent' | 'failed' | 'skipped';
  notifyError?: string;
  detail?: JsonRecord;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
}

export interface ServerBackupRecord {
  recordId: string;
  kind: 'manual' | 'scheduled' | 'drill';
  status: 'completed' | 'failed' | 'planned';
  createdAt: string;
  finishedAt?: string;
  outputPath?: string;
  serverId?: string;
  fileCount?: number;
  totalBytes?: number;
  verifiedAt?: string;
  verification?: JsonRecord;
  drill?: JsonRecord;
  /** Result of a retention run over the backup location this record lives in. */
  retention?: JsonRecord;
  errorMessage?: string;
  note?: string;
  createdBy?: string;
}

export interface AccountSessionSummary {
  id: string;
  username: string;
  accountId?: string;
  role: AccountRole;
  deviceId: string;
  deviceName: string;
  kind: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  lastIp?: string;
  revokedAt?: string;
  active: boolean;
}

export class ServerStoreError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

export const CURRENT_SERVER_SCHEMA = 11;
export const CURRENT_SERVER_SCHEMA_NAME = 'server_management_ops_v11';
export function supportedServerSchema(version: number, name: string): boolean {
  return version === CURRENT_SERVER_SCHEMA && name === CURRENT_SERVER_SCHEMA_NAME
    || version === 10 && name === 'server_key_custody_v10'
    || version === 9 && name === 'server_password_recovery_v9'
    || version === 8 && name === 'server_management_v8'
    || version === 7 && name === 'server_account_identity_v7'
    || version === 6 && name === 'server_account_owner_v6';
}
const DEFAULT_COMMIT_QUOTA_BYTES = 512 * 1024 * 1024;
const DEFAULT_BLOB_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const LOG_RETENTION = 5_000;

function nowIso(): string {
  return new Date().toISOString();
}

function bool(value: unknown): boolean {
  return Number(value) === 1 || value === true;
}

function jsonObject(value: unknown): JsonRecord {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

/** String-array column (recovery-code hashes): anything unexpected reads as "none left". */
function jsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function userFromRow(row: Record<string, unknown>): SyncUser {
  return {
    accountId: String(row['account_id']),
    username: String(row['username']),
    opaqueRegistrationRecord: String(row['opaque_registration_record']),
    disabled: bool(row['disabled']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    ...(row['last_login_at'] == null ? {} : { lastLoginAt: String(row['last_login_at']) }),
    revision: Number(row['revision'] ?? 1),
  };
}

function opaqueLoginStateFromRow(row: Record<string, unknown>): OpaqueLoginState {
  return {
    id: String(row['login_id']),
    username: String(row['username']),
    serverLoginState: String(row['server_login_state']),
    ip: String(row['ip']),
    expiresAt: String(row['expires_at']),
    createdAt: String(row['created_at']),
    ...(row['used_at'] == null ? {} : { usedAt: String(row['used_at']) }),
  };
}

function sessionFromRow(row: Record<string, unknown>): SyncSession {
  return {
    id: String(row['session_id']),
    username: String(row['username']),
    deviceId: String(row['device_id']),
    deviceName: String(row['device_name']),
    refreshHash: String(row['refresh_hash']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    expiresAt: String(row['expires_at']),
    lastSeenAt: String(row['last_seen_at']),
    ...(row['last_ip'] == null ? {} : { lastIp: String(row['last_ip']) }),
    ...(row['revoked_at'] == null ? {} : { revokedAt: String(row['revoked_at']) }),
    kind: String(row['kind'] ?? 'ledger'),
  };
}

function replicaFromRow(row: Record<string, unknown>): UserReplica {
  return {
    username: String(row['username']),
    ledgerId: String(row['ledger_id']),
    replicaId: String(row['replica_id']),
    streamEpoch: String(row['stream_epoch']),
    headSeq: Number(row['head_seq'] ?? 0),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function inviteFromRow(row: Record<string, unknown>): Invite {
  return {
    code: String(row['code']),
    createdAt: String(row['created_at']),
    disabled: bool(row['disabled']),
    ...(row['expires_at'] == null ? {} : { expiresAt: String(row['expires_at']) }),
    ...(row['used_by'] == null ? {} : { usedBy: String(row['used_by']) }),
    ...(row['used_at'] == null ? {} : { usedAt: String(row['used_at']) }),
  };
}

function backupFromRow(row: Record<string, unknown>): ServerBackupArchive {
  const reason = String(row['reason']);
  const kind = String(row['kind']);
  if (!['auto', 'manual', 'pre-import'].includes(reason)
    || !['portable', 'device'].includes(kind)) {
    throw new Error('server backup catalog contains an invalid enum');
  }
  return {
    archiveId: String(row['archive_id']),
    ledgerId: String(row['ledger_id']),
    blobId: String(row['blob_id']),
    createdAt: String(row['created_at']),
    reason: reason as ServerBackupArchive['reason'],
    kind: kind as ServerBackupArchive['kind'],
    label: String(row['label']),
    sizeBytes: Number(row['size_bytes']),
    ...(row['source_generation'] == null ? {} : { sourceGeneration: String(row['source_generation']) }),
  };
}

export class SyncServerStore {
  readonly ready: Promise<void>;
  private readonly driver: NodeSqliteDriver;
  private logWrites = 0;
  private lastLogPruneAt = 0;

  constructor(
    readonly databaseFile: string,
    private readonly defaultRegistrationMode: RegistrationMode,
    private readonly serverId: string,
    private readonly defaultCommitQuotaBytes = DEFAULT_COMMIT_QUOTA_BYTES,
    initializeAfter?: Promise<unknown>,
    private readonly defaultBlobQuotaBytes = DEFAULT_BLOB_QUOTA_BYTES,
  ) {
    this.driver = new NodeSqliteDriver(databaseFile);
    this.ready = initializeAfter
      ? initializeAfter.then(() => this.initialize())
      : this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.driver.exec(`
PRAGMA temp_store = MEMORY;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
PRAGMA journal_size_limit = 67108864;`);
    await this.driver.exec(`
CREATE TABLE IF NOT EXISTS server_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS server_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_users (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  opaque_registration_record TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS server_ownership (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  username TEXT NOT NULL COLLATE NOCASE UNIQUE REFERENCES sync_users(username) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_account_identities (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  account_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS server_administrators (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  granted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS server_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_account_id TEXT NOT NULL,
  target_account_id TEXT,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  reason TEXT,
  request_id TEXT
);
CREATE TABLE IF NOT EXISTS registration_invite_policy (
  code TEXT PRIMARY KEY REFERENCES registration_invites(code) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_password_resets (
  account_id TEXT PRIMARY KEY REFERENCES sync_account_identities(account_id),
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  issued_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_opaque_login_states (
  login_id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  server_login_state TEXT NOT NULL,
  ip TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_opaque_login_states_expiry ON sync_opaque_login_states (expires_at);
CREATE TABLE IF NOT EXISTS sync_sessions (
  session_id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  refresh_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_ip TEXT,
  revoked_at TEXT,
  kind TEXT NOT NULL DEFAULT 'ledger'
);
CREATE INDEX IF NOT EXISTS idx_sync_sessions_user ON sync_sessions (username, revoked_at, expires_at);
CREATE TABLE IF NOT EXISTS server_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_updated ON server_rate_limits (updated_at);
CREATE TABLE IF NOT EXISTS sync_replicas (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  ledger_id TEXT NOT NULL,
  replica_id TEXT NOT NULL UNIQUE,
  stream_epoch TEXT NOT NULL,
  head_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_server_commits (
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  commit_id TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  enc_commit_json TEXT NOT NULL,
  cipher_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (username, seq),
  UNIQUE (username, commit_id)
);
CREATE INDEX IF NOT EXISTS idx_server_commits_cursor ON sync_server_commits (username, seq);
CREATE TABLE IF NOT EXISTS sync_key_envelopes (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  ledger_id TEXT NOT NULL,
  keyring_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_key_custody (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('managed', 'private', 'relay')),
  version INTEGER NOT NULL,
  sealed_secret TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS registration_invites (
  code TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  used_by TEXT COLLATE NOCASE REFERENCES sync_users(username),
  used_at TEXT,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS server_logs (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  action TEXT NOT NULL,
  message TEXT NOT NULL,
  ip TEXT,
  username TEXT COLLATE NOCASE,
  status INTEGER,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_server_logs_cursor ON server_logs (at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_server_logs_level ON server_logs (level, at DESC);
CREATE INDEX IF NOT EXISTS idx_server_logs_action ON server_logs (action, at DESC);
CREATE TABLE IF NOT EXISTS sync_user_quotas (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  commit_quota_bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_backup_archives (
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  ledger_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  source_generation TEXT,
  deleted_at TEXT,
  PRIMARY KEY (username, ledger_id, archive_id),
  UNIQUE (username, ledger_id, blob_id)
);
CREATE INDEX IF NOT EXISTS idx_backup_archives_created
  ON sync_backup_archives (username, ledger_id, deleted_at, created_at DESC);
CREATE TABLE IF NOT EXISTS admin_jobs (
  job_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  target_account_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  phase TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  retry_of TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_jobs_created ON admin_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_jobs_status ON admin_jobs (status, created_at);
CREATE TABLE IF NOT EXISTS admin_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_job_events_job ON admin_job_events (job_id, id);
CREATE TABLE IF NOT EXISTS admin_alerts (
  alert_key TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  scope TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  healthy_checks INTEGER NOT NULL DEFAULT 0,
  bad_streak INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  resolved_at TEXT,
  silenced_until TEXT,
  silenced_by TEXT,
  silence_reason TEXT,
  notified_at TEXT,
  notify_state TEXT,
  notify_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_state ON admin_alerts (state, last_seen_at DESC);
CREATE TABLE IF NOT EXISTS admin_audit_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_account_id TEXT,
  target_account_id TEXT,
  action TEXT NOT NULL,
  code TEXT,
  message TEXT,
  reason TEXT,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_failures_at ON admin_audit_failures (at DESC);
CREATE TABLE IF NOT EXISTS admin_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  status INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  actor_account_id TEXT,
  state TEXT NOT NULL DEFAULT 'complete'
);
CREATE INDEX IF NOT EXISTS idx_admin_idempotency_expiry ON admin_idempotency (expires_at);
CREATE TABLE IF NOT EXISTS server_metric_buckets (
  granularity TEXT NOT NULL,
  bucket_at TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  slow_requests INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  sync_push_ok INTEGER NOT NULL DEFAULT 0,
  sync_push_failed INTEGER NOT NULL DEFAULT 0,
  sync_pull_ok INTEGER NOT NULL DEFAULT 0,
  blob_ok INTEGER NOT NULL DEFAULT 0,
  blob_failed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (granularity, bucket_at)
);
CREATE TABLE IF NOT EXISTS sync_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  username TEXT COLLATE NOCASE,
  account_id TEXT,
  device_name TEXT,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  result_code TEXT,
  category TEXT,
  commit_count INTEGER,
  bytes INTEGER,
  duration_ms INTEGER,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_events_at ON sync_events (at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_events_username ON sync_events (username, at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_events_category ON sync_events (category, at DESC);
CREATE TABLE IF NOT EXISTS server_backup_records (
  record_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  output_path TEXT,
  server_id TEXT,
  file_count INTEGER,
  total_bytes INTEGER,
  verified_at TEXT,
  verification_json TEXT,
  drill_json TEXT,
  error_message TEXT,
  note TEXT,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_server_backup_records_created ON server_backup_records (created_at DESC);
CREATE TABLE IF NOT EXISTS server_maintenance_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_mfa (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  -- Ciphertext, not the raw shared secret: a stolen database file alone does not yield
  -- working codes, because the key lives in server.secret next to it.
  secret_cipher TEXT NOT NULL,
  enabled_at TEXT NOT NULL,
  -- 1 only once a code from the authenticator proved the enrollment works.
  confirmed INTEGER NOT NULL DEFAULT 0,
  -- Highest time step already accepted; a code at or below it is a replay.
  last_step INTEGER NOT NULL DEFAULT -1,
  -- Unused recovery codes, stored as hashes and removed one at a time.
  recovery_json TEXT NOT NULL,
  enrolled_by TEXT
);
CREATE TABLE IF NOT EXISTS admin_mfa_challenges (
  challenge_id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL,
  ip TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_mfa_challenges_expiry ON admin_mfa_challenges (expires_at);`);
    // Additive column upgrades keep pre-v11 databases readable without a schema reset.
    await this.ensureColumn('sync_users', 'revision', 'INTEGER NOT NULL DEFAULT 1');
    await this.ensureColumn('sync_sessions', 'kind', "TEXT NOT NULL DEFAULT 'ledger'");
    await this.ensureColumn('server_admin_audit', 'reason', 'TEXT');
    await this.ensureColumn('server_admin_audit', 'request_id', 'TEXT');
    // Alerts keep a consecutive-bad counter apart from the cumulative occurrence count, so
    // "bad → healthy → bad" cannot be reported as two consecutive failures.
    await this.ensureColumn('admin_alerts', 'bad_streak', 'INTEGER NOT NULL DEFAULT 0');
    // Silence and notification state are additive columns: an existing alert keeps its history.
    await this.ensureColumn('admin_alerts', 'silenced_until', 'TEXT');
    await this.ensureColumn('admin_alerts', 'silenced_by', 'TEXT');
    await this.ensureColumn('admin_alerts', 'silence_reason', 'TEXT');
    await this.ensureColumn('admin_alerts', 'notified_at', 'TEXT');
    await this.ensureColumn('admin_alerts', 'notify_state', 'TEXT');
    await this.ensureColumn('admin_alerts', 'notify_error', 'TEXT');
    // Idempotency records are claimed before the work runs and carry the requesting operator.
    await this.ensureColumn('admin_idempotency', 'actor_account_id', 'TEXT');
    await this.ensureColumn('admin_idempotency', 'state', "TEXT NOT NULL DEFAULT 'complete'");
    // Retention runs are recorded next to the backups they kept or removed.
    await this.ensureColumn('server_backup_records', 'retention_json', 'TEXT');
    // Read-only operators are administrators with this flag set; granting one is a role change.
    await this.ensureColumn('server_administrators', 'read_only', 'INTEGER NOT NULL DEFAULT 0');
    const migrations = await this.driver.all<{ version: number; name: string }>('SELECT version, name FROM server_schema_migrations ORDER BY version');
    const previous = migrations.length === 1 && (
      Number(migrations[0]?.version) === 6 && migrations[0]?.name === 'server_account_owner_v6'
      || Number(migrations[0]?.version) === 7 && migrations[0]?.name === 'server_account_identity_v7'
      || Number(migrations[0]?.version) === 8 && migrations[0]?.name === 'server_management_v8'
      || Number(migrations[0]?.version) === 9 && migrations[0]?.name === 'server_password_recovery_v9'
      || Number(migrations[0]?.version) === 10 && migrations[0]?.name === 'server_key_custody_v10'
    );
    if (!migrations.length || previous) {
      // This additive identity upgrade does not touch ledger bytes, credentials,
      // owner assignment or replica bindings. No historical schema reset.
      await this.driver.transaction(async (driver) => {
        const users = await driver.all<{ username: string }>('SELECT username FROM sync_users');
        for (const user of users) {
          await driver.run('INSERT OR IGNORE INTO sync_account_identities (username, account_id) VALUES (?, ?)', [user.username, `account-${randomBytes(16).toString('hex')}`]);
        }
        await driver.run('DELETE FROM server_schema_migrations');
        await driver.run('INSERT INTO server_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [CURRENT_SERVER_SCHEMA, CURRENT_SERVER_SCHEMA_NAME, nowIso()]);
      });
    } else if (migrations.length !== 1 || Number(migrations[0]?.version) !== CURRENT_SERVER_SCHEMA || migrations[0]?.name !== CURRENT_SERVER_SCHEMA_NAME) {
      throw new Error('同步服务器数据库结构不受支持，已停止启动；请先保护现有数据，不会自动重置');
    }
    const at = nowIso();
    const persistedServer = await this.driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['server_id']);
    if (persistedServer && persistedServer.value !== this.serverId) throw new Error('server-id 与 SQLite 主库不匹配');
    await this.driver.run('INSERT OR IGNORE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['server_id', this.serverId, at]);
    await this.driver.run('INSERT OR IGNORE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['registration_mode', this.defaultRegistrationMode, at]);
  }

  /** Additive column upgrades keep pre-v11 databases readable without a schema reset. */
  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const columns = await this.driver.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (columns.some((row) => String(row.name) === column)) return;
    await this.driver.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  async registrationMode(): Promise<RegistrationMode> {
    await this.ready;
    const owner = await this.driver.get<{ singleton: number }>('SELECT singleton FROM server_ownership WHERE singleton = 1');
    if (!owner) return 'closed';
    const row = await this.driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['registration_mode']);
    return row?.value === 'invite' || row?.value === 'closed' ? row.value : 'open';
  }

  async setRegistrationMode(mode: RegistrationMode): Promise<void> {
    await this.ready;
    await this.driver.run('INSERT OR REPLACE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['registration_mode', mode, nowIso()]);
  }

  async assertRegistrationAllowed(inviteCode?: string, claimOwner = false): Promise<void> {
    await this.ready;
    const owner = await this.ownerUsername();
    if (claimOwner) {
      if (owner) throw new ServerStoreError('OWNER_ALREADY_CLAIMED', 409, 'server owner has already been initialized');
      return;
    }
    if (!owner) throw new ServerStoreError('OWNER_SETUP_REQUIRED', 403, 'server operator must initialize the owner with the setup secret');
    const mode = await this.registrationMode();
    if (mode === 'closed') throw new ServerStoreError('REGISTRATION_CLOSED', 403, 'registration closed');
    if (mode !== 'invite') return;
    if (!inviteCode) throw new ServerStoreError('INVITE_REQUIRED', 403, 'invite required');
    const invite = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM registration_invites WHERE code = ?',
      [inviteCode],
    );
    const policy = await this.driver.get<{ expires_at: string }>('SELECT expires_at FROM registration_invite_policy WHERE code = ?', [inviteCode]);
    if (!invite || bool(invite['disabled']) || invite['used_by'] != null || policy && policy.expires_at <= nowIso()) {
      throw new ServerStoreError('INVALID_INVITE', 403, 'invalid invite');
    }
  }

  async getUser(username: string): Promise<SyncUser | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT u.*, i.account_id FROM sync_users u JOIN sync_account_identities i ON i.username = u.username WHERE u.username = ?', [username]);
    return row ? userFromRow(row) : undefined;
  }

  async ownerUsername(): Promise<string | undefined> {
    await this.ready;
    const row = await this.driver.get<{ username: string }>(
      'SELECT username FROM server_ownership WHERE singleton = 1',
    );
    return row?.username;
  }

  async roleForUser(username: string): Promise<AccountRole> {
    await this.ready;
    const owner = await this.driver.get<{ singleton: number }>(
      'SELECT singleton FROM server_ownership WHERE username = ?',
      [username],
    );
    if (owner) return 'owner';
    const administrator = await this.driver.get<{ read_only: number }>('SELECT read_only FROM server_administrators WHERE username = ?', [username]);
    if (!administrator) return 'member';
    return Number(administrator.read_only ?? 0) === 1 ? 'viewer' : 'admin';
  }

  async register(
    username: string,
    opaqueRegistrationRecord: string,
    inviteCode?: string,
    claimOwner = false,
  ): Promise<{ role: AccountRole }> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const existingOwner = await driver.get<{ singleton: number }>('SELECT singleton FROM server_ownership WHERE singleton = 1');
      if (claimOwner && existingOwner) throw new ServerStoreError('OWNER_ALREADY_CLAIMED', 409, 'server owner has already been initialized');
      if (!claimOwner && !existingOwner) throw new ServerStoreError('OWNER_SETUP_REQUIRED', 403, 'server operator must initialize the owner with the setup secret');
      const modeRow = await driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['registration_mode']);
      const mode = claimOwner
        ? 'open'
        : modeRow?.value === 'invite' || modeRow?.value === 'closed' ? modeRow.value : 'open';
      if (mode === 'closed') throw new ServerStoreError('REGISTRATION_CLOSED', 403, 'registration closed');
      let invite: Record<string, unknown> | undefined;
      if (mode === 'invite') {
        if (!inviteCode) throw new ServerStoreError('INVITE_REQUIRED', 403, 'invite required');
        invite = await driver.get<Record<string, unknown>>('SELECT * FROM registration_invites WHERE code = ?', [inviteCode]);
        const policy = await driver.get<{ expires_at: string }>('SELECT expires_at FROM registration_invite_policy WHERE code = ?', [inviteCode]);
        if (!invite || bool(invite['disabled']) || invite['used_by'] != null || policy && policy.expires_at <= nowIso()) throw new ServerStoreError('INVALID_INVITE', 403, 'invalid invite');
      }
      if (await driver.get('SELECT username FROM sync_users WHERE username = ?', [username])) throw new ServerStoreError('USER_EXISTS', 409, 'user exists');
      const at = nowIso();
      await driver.run(
        'INSERT INTO sync_users (username, opaque_registration_record, disabled, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
        [username, opaqueRegistrationRecord, at, at],
      );
      await driver.run('INSERT INTO sync_account_identities (username, account_id) VALUES (?, ?)', [username, `account-${randomBytes(16).toString('hex')}`]);
      if (claimOwner) await driver.run(
        'INSERT INTO server_ownership (singleton, username, created_at) VALUES (1, ?, ?)',
        [username, at],
      );
      if (inviteCode) await driver.run('UPDATE registration_invites SET used_by = ?, used_at = ? WHERE code = ?', [username, at, inviteCode]);
      const assignedOwner = await driver.get<{ username: string }>(
        'SELECT username FROM server_ownership WHERE singleton = 1',
      );
      return { role: assignedOwner?.username === username ? 'owner' : 'member' };
    });
  }

  async noteLogin(username: string): Promise<void> {
    await this.ready;
    const at = nowIso();
    await this.driver.run('UPDATE sync_users SET last_login_at = ?, updated_at = ? WHERE username = ?', [at, at, username]);
  }

  async createOpaqueLoginState(
    username: string,
    serverLoginState: string,
    ip: string,
    expiresAt: string,
  ): Promise<OpaqueLoginState> {
    await this.ready;
    const loginState: OpaqueLoginState = {
      id: `login-${randomBytes(16).toString('hex')}`,
      username,
      serverLoginState,
      ip,
      expiresAt,
      createdAt: nowIso(),
    };
    await this.driver.transaction(async (driver) => {
      await driver.run(
        'DELETE FROM sync_opaque_login_states WHERE expires_at < ? OR used_at IS NOT NULL',
        [loginState.createdAt],
      );
      await driver.run(
        `INSERT INTO sync_opaque_login_states
         (login_id, username, server_login_state, ip, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          loginState.id,
          loginState.username,
          loginState.serverLoginState,
          loginState.ip,
          loginState.expiresAt,
          loginState.createdAt,
        ],
      );
    });
    return loginState;
  }

  async consumeOpaqueLoginState(id: string, ip: string): Promise<OpaqueLoginState | undefined> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const row = await driver.get<Record<string, unknown>>(
        'SELECT * FROM sync_opaque_login_states WHERE login_id = ?',
        [id],
      );
      if (!row) return undefined;
      const loginState = opaqueLoginStateFromRow(row);
      const usedAt = nowIso();
      if (loginState.usedAt || loginState.ip !== ip || loginState.expiresAt <= usedAt) return undefined;
      const result = await driver.run(
        'UPDATE sync_opaque_login_states SET used_at = ? WHERE login_id = ? AND used_at IS NULL',
        [usedAt, id],
      );
      return result.changes === 1 ? loginState : undefined;
    });
  }

  async createSession(input: {
    expectedRegistrationRecord?: string;
    id: string;
    username: string;
    deviceId: string;
    deviceName: string;
    refreshHash: string;
    expiresAt: string;
    ip?: string;
    /** Management-console logins are recorded as `admin` so session lists can separate them. */
    kind?: string;
  }): Promise<SyncSession> {
    await this.ready;
    const at = nowIso();
    const session: SyncSession = {
      id: input.id,
      username: input.username,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      refreshHash: input.refreshHash,
      createdAt: at,
      updatedAt: at,
      expiresAt: input.expiresAt,
      lastSeenAt: at,
      kind: input.kind === 'admin' ? 'admin' : 'ledger',
      ...(input.ip ? { lastIp: input.ip } : {}),
    };
    await this.driver.transaction(async (driver) => {
      if (input.expectedRegistrationRecord !== undefined) {
        const user = await driver.get<{ opaque_registration_record: string; disabled: number }>('SELECT opaque_registration_record, disabled FROM sync_users WHERE username = ?', [input.username]);
        if (!user || user.disabled || user.opaque_registration_record !== input.expectedRegistrationRecord) throw new ServerStoreError('CREDENTIALS_CHANGED', 401, '账号凭据已变化，请重新登录');
      }
      await driver.run(
        `UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
         WHERE username = ? AND device_id = ? AND revoked_at IS NULL`,
        [at, at, session.username, session.deviceId],
      );
      await driver.run(
        `INSERT INTO sync_sessions
         (session_id, username, device_id, device_name, refresh_hash, created_at, updated_at, expires_at, last_seen_at, last_ip, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id, session.username, session.deviceId, session.deviceName, session.refreshHash,
          session.createdAt, session.updatedAt, session.expiresAt, session.lastSeenAt, session.lastIp ?? null, session.kind,
        ],
      );
    });
    return session;
  }

  async getSession(id: string): Promise<SyncSession | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM sync_sessions WHERE session_id = ?', [id]);
    return row ? sessionFromRow(row) : undefined;
  }

  async rotateSessionRefresh(id: string, expectedHash: string, nextHash: string, ip?: string): Promise<SyncSession | undefined> {
    await this.ready;
    const at = nowIso();
    const result = await this.driver.run(
      `UPDATE sync_sessions
       SET refresh_hash = ?, updated_at = ?, last_seen_at = ?, last_ip = ?
       WHERE session_id = ? AND refresh_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      [nextHash, at, at, ip ?? null, id, expectedHash, at],
    );
    return result.changes === 1 ? this.getSession(id) : undefined;
  }

  async touchSession(id: string, ip?: string): Promise<void> {
    await this.ready;
    const at = nowIso();
    await this.driver.run(
      `UPDATE sync_sessions SET last_seen_at = ?, updated_at = ?, last_ip = ?
       WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      [at, at, ip ?? null, id, at],
    );
  }

  async listSessions(username: string): Promise<SyncSession[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(
      'SELECT * FROM sync_sessions WHERE username = ? ORDER BY last_seen_at DESC, created_at DESC',
      [username],
    );
    return rows.map(sessionFromRow);
  }

  async revokeSession(id: string, username?: string): Promise<SyncSession | undefined> {
    await this.ready;
    const at = nowIso();
    const result = await this.driver.run(
      `UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
       WHERE session_id = ?${username ? ' AND username = ?' : ''}`,
      username ? [at, at, id, username] : [at, at, id],
    );
    return result.changes === 1 ? this.getSession(id) : undefined;
  }

  async takeRateLimit(
    bucketKey: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    await this.ready;
    const now = Date.now();
    return this.driver.transaction(async (driver) => {
      const row = await driver.get<{ window_started_at: number; hits: number; blocked_until: number }>(
        'SELECT window_started_at, hits, blocked_until FROM server_rate_limits WHERE bucket_key = ?',
        [bucketKey],
      );
      if (row && Number(row.blocked_until) > now) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((Number(row.blocked_until) - now) / 1000)) };
      }
      const windowStartedAt = !row || now - Number(row.window_started_at) >= windowMs ? now : Number(row.window_started_at);
      const hits = !row || windowStartedAt === now ? 1 : Number(row.hits) + 1;
      const allowed = hits <= limit;
      const blockedUntil = allowed ? 0 : windowStartedAt + windowMs;
      await driver.run(
        `INSERT OR REPLACE INTO server_rate_limits
         (bucket_key, window_started_at, hits, blocked_until, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [bucketKey, windowStartedAt, hits, blockedUntil, now],
      );
      if (randomInt(0, 100) < 1) {
        await driver.run('DELETE FROM server_rate_limits WHERE updated_at < ?', [now - 7 * 24 * 60 * 60 * 1000]);
      }
      return {
        allowed,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
      };
    });
  }

  async listUsers(after = '', limit = 100, filters: {
    search?: string;
    role?: string;
    state?: string;
    protection?: string;
    /** Capacity state is derived from the encrypted-commit quota, which is the billed one. */
    quota?: string;
  } = {}): Promise<{ users: JsonRecord[]; nextCursor?: string }> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT u.username, i.account_id, u.disabled, u.created_at, u.updated_at, u.last_login_at,
              ${ROLE_SQL} AS role,
              r.ledger_id, r.replica_id, COALESCE(r.head_seq, 0) AS commit_count,
              COALESCE(SUM(c.cipher_bytes), 0) AS commit_bytes,
              COALESCE(q.commit_quota_bytes, ?) AS commit_quota_bytes,
              u.revision,
              k.mode AS protection_mode,
              (SELECT COUNT(*) FROM sync_sessions s
               WHERE s.username = u.username AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_device_count
       FROM sync_users u
       JOIN sync_account_identities i ON i.username = u.username
       LEFT JOIN server_administrators a ON a.username = u.username
       LEFT JOIN server_ownership o ON o.username = u.username
       LEFT JOIN sync_replicas r ON r.username = u.username
       LEFT JOIN sync_server_commits c ON c.username = u.username
       LEFT JOIN sync_user_quotas q ON q.username = u.username
       LEFT JOIN sync_key_custody k ON k.username = u.username
       WHERE u.username > ? COLLATE NOCASE
         AND (? = '' OR instr(lower(u.username), lower(?)) > 0 OR i.account_id = ?)
         AND (? = '' OR ${ROLE_SQL} = ?)
         AND (? = '' OR u.disabled = ?)
         AND (? = '' OR COALESCE(k.mode, 'none') = ?)
       GROUP BY u.username
       HAVING (? = ''
         OR (? = 'over' AND COALESCE(SUM(c.cipher_bytes), 0) >= COALESCE(q.commit_quota_bytes, ?))
         OR (? = 'warning' AND COALESCE(SUM(c.cipher_bytes), 0) >= COALESCE(q.commit_quota_bytes, ?) * 0.9
             AND COALESCE(SUM(c.cipher_bytes), 0) < COALESCE(q.commit_quota_bytes, ?))
         OR (? = 'ok' AND COALESCE(SUM(c.cipher_bytes), 0) < COALESCE(q.commit_quota_bytes, ?) * 0.9))
       ORDER BY u.username COLLATE NOCASE
       LIMIT ?`,
      [
        this.defaultCommitQuotaBytes, nowIso(), after,
        filters.search ?? '', filters.search ?? '', filters.search ?? '',
        filters.role ?? '', filters.role ?? '',
        filters.state ?? '', filters.state === 'disabled' ? 1 : 0,
        filters.protection ?? '', filters.protection ?? '',
        filters.quota ?? '', filters.quota ?? '', this.defaultCommitQuotaBytes,
        filters.quota ?? '', this.defaultCommitQuotaBytes, this.defaultCommitQuotaBytes,
        filters.quota ?? '', this.defaultCommitQuotaBytes,
        limit + 1,
      ],
    );
    const page = rows.slice(0, limit).map((row) => ({
      accountId: String(row['account_id']), username: String(row['username']), disabled: bool(row['disabled']),
      role: row['role'] === 'owner' ? 'owner' : row['role'] === 'admin' ? 'admin' : row['role'] === 'viewer' ? 'viewer' : 'member',
      createdAt: String(row['created_at']), updatedAt: String(row['updated_at']),
      lastLoginAt: row['last_login_at'] ?? null, ledgerId: row['ledger_id'] ?? null,
      replicaId: row['replica_id'] ?? null, commitCount: Number(row['commit_count'] ?? 0),
      commitBytes: Number(row['commit_bytes'] ?? 0), commitQuotaBytes: Number(row['commit_quota_bytes']),
      activeDeviceCount: Number(row['active_device_count'] ?? 0),
      revision: Number(row['revision'] ?? 1),
      protectionMode: row['protection_mode'] == null ? null : String(row['protection_mode']),
      quotaState: Number(row['commit_bytes'] ?? 0) >= Number(row['commit_quota_bytes']) ? 'over'
        : Number(row['commit_bytes'] ?? 0) >= Number(row['commit_quota_bytes']) * 0.9 ? 'warning' : 'ok',
    }));
    return { users: page, ...(rows.length > limit ? { nextCursor: String(rows[limit - 1]?.['username'] ?? '') } : {}) };
  }

  async setUserDisabled(username: string, disabled: boolean): Promise<SyncUser | undefined> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const existing = await driver.get<{ username: string }>('SELECT username FROM sync_users WHERE username = ?', [username]);
      if (!existing) return;
      if (disabled) {
        const owner = await driver.get<{ username: string }>('SELECT username FROM server_ownership WHERE singleton = 1');
        if (owner?.username === existing.username) {
          throw new ServerStoreError('OWNER_CANNOT_BE_DISABLED', 409, 'server owner cannot be disabled');
        }
      }
      const at = nowIso();
      await driver.run('UPDATE sync_users SET disabled = ?, updated_at = ? WHERE username = ?', [disabled ? 1 : 0, at, username]);
      if (disabled) await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ?', [at, at, username]);
    });
    return this.getUser(username);
  }

  async userByAccountId(accountId: string): Promise<SyncUser | undefined> {
    await this.ready;
    const row = await this.driver.get<{ username: string }>('SELECT username FROM sync_account_identities WHERE account_id = ?', [accountId]);
    return row ? this.getUser(row.username) : undefined;
  }

  /** Authorization, mutation, session invalidation and durable audit share one transaction. */
  async mutateAdmin(
    actorSessionId: string,
    mutation: AdminMutation,
    options: { reason?: string; requestId?: string; expectedVersion?: number } = {},
  ): Promise<{ revoked: boolean; revokedSessions: number }> {
    await this.ready;
    let revoked = false;
    let revokedSessions = 0;
    await this.driver.transaction(async (driver) => {
      const at = nowIso();
      const roleSql = `SELECT u.username, u.disabled, i.account_id,
        ${ROLE_SQL} AS role
        FROM sync_users u JOIN sync_account_identities i ON i.username = u.username
        LEFT JOIN server_ownership o ON o.username = u.username
        LEFT JOIN server_administrators a ON a.username = u.username`;
      const session = await driver.get<{ username: string; created_at: string }>(
        'SELECT username, created_at FROM sync_sessions WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ?', [actorSessionId, at]);
      const actor = session ? await driver.get<{ username: string; disabled: number; account_id: string; role: AccountRole }>(`${roleSql} WHERE u.username = ?`, [session.username]) : undefined;
      if (!actor || actor.disabled || actor.role === 'member') throw new ServerStoreError('ADMIN_REQUIRED', 403, 'administrator session required');
      // Read-only operators can see everything this console shows, but change nothing.
      if (actor.role === 'viewer') throw new ServerStoreError('READ_ONLY_ROLE', 403, '只读运维角色不能执行管理变更');
      let targetId = 'accountId' in mutation ? mutation.accountId : undefined;
      let targetSession: Record<string, unknown> | undefined;
      if (mutation.action === 'revoke-session') {
        targetSession = await driver.get<Record<string, unknown>>('SELECT s.*, i.account_id FROM sync_sessions s JOIN sync_account_identities i ON i.username = s.username WHERE s.session_id = ?', [mutation.sessionId]);
        if (!targetSession) throw new ServerStoreError('NOT_FOUND', 404, 'session not found');
        targetId = String(targetSession['account_id']);
      }
      const target = targetId ? await driver.get<{ username: string; disabled: number; account_id: string; role: AccountRole }>(`${roleSql} WHERE i.account_id = ?`, [targetId]) : undefined;
      if (targetId && !target) throw new ServerStoreError('NOT_FOUND', 404, 'account not found');
      const quotaMutation = mutation.action === 'commit-quota' || mutation.action === 'blob-quota';
      // Everyone keeps control of their own devices: an owner (or administrator) may revoke
      // their own other sessions after re-authenticating, while other privileged accounts
      // stay protected. The current session ends through logout instead.
      const selfSessions = Boolean(target && target.account_id === actor.account_id
        && (mutation.action === 'revoke-session' || mutation.action === 'sessions-revoke-all'));
      if (mutation.action === 'mfa-enroll' || mutation.action === 'mfa-disable' || mutation.action === 'mfa-recovery-codes') {
        // The factor belongs to the account it protects, so this is the one management change no
        // role can make on someone else's behalf.
        if (!target || target.account_id !== actor.account_id) {
          throw new ServerStoreError('PROTECTED_ACCOUNT', 403, '两步验证只能由账号本人管理，不能由他人代操作');
        }
      } else if (target && !selfSessions && ((!quotaMutation && target.role === 'owner') || actor.role === 'admin' && target.role !== 'member')) {
        throw new ServerStoreError('PROTECTED_ACCOUNT', 403, 'cannot manage this privileged account');
      }
      if ((mutation.action === 'role' || mutation.action === 'registration' || mutation.action === 'settings-save') && actor.role !== 'owner') {
        throw new ServerStoreError('OWNER_REQUIRED', 403, 'server owner required');
      }
      // Optimistic concurrency: two administrators editing the same account must not silently overwrite each other.
      if (options.expectedVersion !== undefined && target) {
        const current = await driver.get<{ revision: number }>('SELECT revision FROM sync_users WHERE username = ?', [target.username]);
        if (Number(current?.revision ?? 1) !== options.expectedVersion) {
          throw new ServerStoreError('STALE_WRITE', 409, '账号数据已被其他管理员修改，请刷新后重试');
        }
      }
      // High-risk changes need a fresh login: role, password recovery, account state, and revoking
      // other people's sessions. Everything else is recoverable from the audit trail.
      if ((mutation.action === 'role' || mutation.action === 'password-reset-issue' || mutation.action === 'state'
        || mutation.action === 'sessions-revoke-all' || selfSessions)
        && Date.now() - Date.parse(session!.created_at) > 5 * 60_000) {
        throw new ServerStoreError('RECENT_LOGIN_REQUIRED', 403, '此敏感操作需要最近 5 分钟内的登录，请退出管理后台并重新登录');
      }
      if (selfSessions && mutation.action === 'revoke-session' && mutation.sessionId === actorSessionId) {
        throw new ServerStoreError('CURRENT_SESSION', 409, '不能撤销当前正在使用的会话，请使用退出结束它');
      }
      let before: unknown = null;
      let after: unknown = null;
      if (mutation.action === 'password-reset-issue') {
        if (target!.disabled) throw new ServerStoreError('ACCOUNT_DISABLED', 409, 'enable the account before issuing a reset');
        if (!/^[a-f0-9]{64}$/.test(mutation.codeHash) || !Number.isFinite(Date.parse(mutation.expiresAt)) || mutation.expiresAt <= at || Date.parse(mutation.expiresAt) > Date.now() + 16 * 60_000) throw new ServerStoreError('INVALID_RESET', 400, 'invalid reset policy');
        await driver.run('INSERT OR REPLACE INTO account_password_resets (account_id, code_hash, expires_at, issued_at) VALUES (?, ?, ?, ?)', [target!.account_id, mutation.codeHash, mutation.expiresAt, at]);
        after = { expiresAt: mutation.expiresAt };
      } else if (mutation.action === 'password-reset-revoke') {
        // Revoking a pending code is a management change, so it is audited like issuing one.
        const pending = await driver.get<{ account_id: string }>('SELECT account_id FROM account_password_resets WHERE account_id = ?', [target!.account_id]);
        revoked = Boolean(pending);
        before = { hadPendingCode: revoked };
        after = { hadPendingCode: false };
        await driver.run('DELETE FROM account_password_resets WHERE account_id = ?', [target!.account_id]);
      } else if (mutation.action === 'role') {
        if (mutation.role !== 'member' && mutation.role !== 'admin' && mutation.role !== 'viewer') throw new ServerStoreError('INVALID_ROLE', 400, 'invalid role');
        if (target!.disabled) throw new ServerStoreError('ACCOUNT_DISABLED', 409, 'enable the account before changing its role');
        before = { role: target!.role }; after = { role: mutation.role };
        if (mutation.role === 'admin') {
          await driver.run('INSERT INTO server_administrators (username, granted_at, read_only) VALUES (?, ?, 0) ON CONFLICT(username) DO UPDATE SET read_only = 0', [target!.username, at]);
        } else if (mutation.role === 'viewer') {
          await driver.run('INSERT INTO server_administrators (username, granted_at, read_only) VALUES (?, ?, 1) ON CONFLICT(username) DO UPDATE SET read_only = 1', [target!.username, at]);
        }
        else await driver.run('DELETE FROM server_administrators WHERE username = ?', [target!.username]);
        await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ?', [at, at, target!.username]);
      } else if (mutation.action === 'state') {
        before = { disabled: bool(target!.disabled) }; after = { disabled: mutation.disabled };
        await driver.run('UPDATE sync_users SET disabled = ?, updated_at = ? WHERE username = ?', [mutation.disabled ? 1 : 0, at, target!.username]);
        if (mutation.disabled) await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ?', [at, at, target!.username]);
      } else if (mutation.action === 'commit-quota') {
        if (mutation.bytes !== null && (!Number.isSafeInteger(mutation.bytes) || mutation.bytes < 1024 ** 2 || mutation.bytes > 1024 ** 4)) throw new ServerStoreError('INVALID_QUOTA', 400, 'invalid quota');
        before = await driver.get('SELECT commit_quota_bytes FROM sync_user_quotas WHERE username = ?', [target!.username]) ?? null;
        after = { bytes: mutation.bytes };
        if (mutation.bytes === null) await driver.run('DELETE FROM sync_user_quotas WHERE username = ?', [target!.username]);
        else await driver.run('INSERT OR REPLACE INTO sync_user_quotas (username, commit_quota_bytes, updated_at) VALUES (?, ?, ?)', [target!.username, mutation.bytes, at]);
      } else if (mutation.action === 'blob-quota') {
        if (mutation.bytes !== null && (!Number.isSafeInteger(mutation.bytes) || mutation.bytes < 1024 ** 2 || mutation.bytes > 1024 ** 4)) throw new ServerStoreError('INVALID_QUOTA', 400, 'invalid quota');
        // Blob metadata shares server.sqlite; mutate through this transaction, not the second connection.
        before = await driver.get('SELECT quota_bytes FROM blob_user_quotas WHERE username = ?', [target!.username]) ?? null;
        after = { bytes: mutation.bytes };
        if (mutation.bytes === null) await driver.run('DELETE FROM blob_user_quotas WHERE username = ?', [target!.username]);
        else await driver.run('INSERT OR REPLACE INTO blob_user_quotas (username, quota_bytes, updated_at) VALUES (?, ?, ?)', [target!.username, mutation.bytes, at]);
      } else if (mutation.action === 'revoke-session') {
        before = { sessionId: mutation.sessionId, revokedAt: targetSession!['revoked_at'] }; after = { sessionId: mutation.sessionId, revokedAt: at };
        await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE session_id = ?', [at, at, mutation.sessionId]);
      } else if (mutation.action === 'registration') {
        if (!['open', 'invite', 'closed'].includes(mutation.mode)) throw new ServerStoreError('INVALID_MODE', 400, 'invalid registration mode');
        before = await driver.get('SELECT value FROM server_meta WHERE key = ?', ['registration_mode']) ?? null;
        after = { mode: mutation.mode };
        await driver.run('INSERT OR REPLACE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['registration_mode', mutation.mode, at]);
      } else if (mutation.action === 'invite-create') {
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(mutation.code) || !Number.isFinite(Date.parse(mutation.expiresAt)) || mutation.expiresAt <= at) throw new ServerStoreError('INVALID_INVITE', 400, 'invalid invite or expiry');
        if (await driver.get('SELECT code FROM registration_invites WHERE code = ?', [mutation.code])) throw new ServerStoreError('INVITE_EXISTS', 409, 'invite exists');
        await driver.run('INSERT INTO registration_invites (code, created_at, disabled) VALUES (?, ?, 0)', [mutation.code, at]);
        await driver.run('INSERT INTO registration_invite_policy (code, expires_at) VALUES (?, ?)', [mutation.code, mutation.expiresAt]);
        after = { expiresAt: mutation.expiresAt, inviteFingerprint: createHash('sha256').update(mutation.code).digest('hex') }; // Never put usable invitation secrets in audit logs.
      } else if (mutation.action === 'settings-save') {
        if (!Array.isArray(mutation.keys) || !mutation.keys.length || mutation.keys.some((key) => typeof key !== 'string')) {
          throw new ServerStoreError('INVALID_SETTING', 400, 'invalid settings keys');
        }
        after = { keys: mutation.keys };
      } else if (mutation.action === 'sessions-revoke-all') {
        // The mutation and its audit record stay in one transaction: a rejected call must not
        // leave sessions revoked without a trace.
        before = { accountId: mutation.accountId };
        const result = await driver.run(
          `UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
           WHERE revoked_at IS NULL AND username = ?${mutation.keepSessionId ? ' AND session_id <> ?' : ''}`,
          mutation.keepSessionId
            ? [at, at, target!.username, mutation.keepSessionId]
            : [at, at, target!.username],
        );
        revokedSessions = Number(result.changes ?? 0);
        after = { revoked: revokedSessions, keptCurrentSession: Boolean(mutation.keepSessionId) };
      } else if (mutation.action === 'invite-state') {
        const invite = await driver.get<{ disabled: number; used_by: string | null }>('SELECT disabled, used_by FROM registration_invites WHERE code = ?', [mutation.code]);
        if (!invite) throw new ServerStoreError('NOT_FOUND', 404, 'invite not found');
        if (invite.used_by) throw new ServerStoreError('INVITE_USED', 409, 'used invite cannot be changed');
        before = { disabled: bool(invite.disabled) }; after = { disabled: mutation.disabled, inviteFingerprint: createHash('sha256').update(mutation.code).digest('hex') };
        await driver.run('UPDATE registration_invites SET disabled = ? WHERE code = ?', [mutation.disabled ? 1 : 0, mutation.code]);
      } else if (mutation.action === 'alert-acknowledge' || mutation.action === 'alert-silence' || mutation.action === 'alert-unsilence') {
        // The alert change and its audit record share this transaction: a rejected request must
        // not be able to silence an alert without leaving a trace.
        const alert = await driver.get<Record<string, unknown>>('SELECT * FROM admin_alerts WHERE alert_key = ?', [mutation.key]);
        if (!alert) throw new ServerStoreError('NOT_FOUND', 404, 'alert not found');
        before = { acknowledgedAt: alert['acknowledged_at'] ?? null, silencedUntil: alert['silenced_until'] ?? null };
        if (mutation.action === 'alert-acknowledge') {
          await driver.run('UPDATE admin_alerts SET acknowledged_at = COALESCE(acknowledged_at, ?), acknowledged_by = COALESCE(acknowledged_by, ?) WHERE alert_key = ?', [at, actor.account_id, mutation.key]);
          after = { key: mutation.key, acknowledgedAt: at };
        } else if (mutation.action === 'alert-silence') {
          if (!Number.isSafeInteger(mutation.hours) || mutation.hours < 1 || mutation.hours > 720) {
            throw new ServerStoreError('INVALID_SILENCE', 400, 'silence window must be 1-720 hours');
          }
          const until = new Date(Date.now() + mutation.hours * 3_600_000).toISOString();
          await driver.run('UPDATE admin_alerts SET silenced_until = ?, silenced_by = ?, silence_reason = ? WHERE alert_key = ?', [until, actor.account_id, options.reason ?? null, mutation.key]);
          after = { key: mutation.key, silencedUntil: until, hours: mutation.hours };
        } else {
          await driver.run('UPDATE admin_alerts SET silenced_until = NULL, silenced_by = NULL, silence_reason = NULL WHERE alert_key = ?', [mutation.key]);
          after = { key: mutation.key, silencedUntil: null };
        }
      }
      if (target && (mutation.action === 'role' || mutation.action === 'state')) await driver.run('DELETE FROM account_password_resets WHERE account_id = ?', [target.account_id]);
      if (target) await driver.run('UPDATE sync_users SET revision = revision + 1 WHERE username = ?', [target.username]);
      await driver.run('INSERT INTO server_admin_audit (at, actor_account_id, target_account_id, action, before_json, after_json, reason, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [at, actor.account_id, targetId ?? null, mutation.action, JSON.stringify(before), JSON.stringify(after), options.reason ?? null, options.requestId ?? null]);
    });
    return { revoked, revokedSessions };
  }

  async listAdminAudit(options: {
    before?: number;
    limit?: number;
    search?: string;
    action?: string;
    actorAccountId?: string;
    targetAccountId?: string;
    from?: string;
    until?: string;
  } = {}): Promise<{ entries: JsonRecord[]; nextCursor?: string }> {
    await this.ready;
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const clauses: string[] = ['id < ?'];
    const params: (string | number)[] = [options.before ?? Number.MAX_SAFE_INTEGER];
    if (options.search) { clauses.push("instr(lower(action || ' ' || actor_account_id || ' ' || COALESCE(target_account_id, '')), lower(?)) > 0"); params.push(options.search); }
    if (options.action) { clauses.push('action = ?'); params.push(options.action); }
    if (options.actorAccountId) { clauses.push('actor_account_id = ?'); params.push(options.actorAccountId); }
    if (options.targetAccountId) { clauses.push('target_account_id = ?'); params.push(options.targetAccountId); }
    if (options.from) { clauses.push('at >= ?'); params.push(options.from); }
    if (options.until) { clauses.push('at < ?'); params.push(options.until); }
    params.push(limit + 1);
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT * FROM server_admin_audit WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      params,
    );
    return { entries: rows.slice(0, limit).map((row) => ({ id: row['id'], at: row['at'], actorAccountId: row['actor_account_id'], targetAccountId: row['target_account_id'], action: row['action'], reason: row['reason'], requestId: row['request_id'], before: JSON.parse(String(row['before_json'])), after: JSON.parse(String(row['after_json'])) })),
      ...(rows.length > limit ? { nextCursor: String(rows[limit - 1]!['id']) } : {}) };
  }

  async assertPasswordReset(username: string, codeHash: string): Promise<void> {
    await this.ready;
    const row = await this.driver.get('SELECT r.account_id FROM account_password_resets r JOIN sync_account_identities i ON i.account_id = r.account_id JOIN sync_users u ON u.username = i.username WHERE i.username = ? AND r.code_hash = ? AND r.expires_at > ? AND u.disabled = 0', [username, codeHash, nowIso()]);
    if (!row) throw new ServerStoreError('INVALID_PASSWORD_RESET', 403, '重置码无效、已使用或已过期，请联系管理员重新审核');
  }

  /** Local operator recovery or a recently authenticated user's own password change. */
  async issueAccountRecovery(codeHash: string, expiresAt: string, actorSessionId?: string): Promise<string> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      if (!/^[a-f0-9]{64}$/.test(codeHash) || expiresAt <= at || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) > Date.now() + 16 * 60_000) throw new ServerStoreError('INVALID_RESET', 400, 'invalid reset policy');
      const actor = actorSessionId
        ? await driver.get<{ username: string; account_id: string }>(`SELECT u.username, i.account_id FROM sync_sessions s JOIN sync_users u ON u.username = s.username JOIN sync_account_identities i ON i.username = u.username WHERE s.session_id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND s.created_at > ? AND u.disabled = 0`, [actorSessionId, at, new Date(Date.now() - 5 * 60_000).toISOString()])
        : await driver.get<{ username: string; account_id: string }>('SELECT o.username, i.account_id FROM server_ownership o JOIN sync_account_identities i ON i.username = o.username WHERE o.singleton = 1');
      if (!actor) throw new ServerStoreError('RECENT_LOGIN_REQUIRED', 403, actorSessionId ? '请重新验证当前账号密码' : '服务器尚未创建所有者');
      await driver.run('INSERT OR REPLACE INTO account_password_resets (account_id, code_hash, expires_at, issued_at) VALUES (?, ?, ?, ?)', [actor.account_id, codeHash, expiresAt, at]);
      await driver.run('INSERT INTO server_admin_audit (at, actor_account_id, target_account_id, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)', [at, actor.account_id, actor.account_id, actorSessionId ? 'password-change-authorize' : 'owner-recovery-local', '{}', JSON.stringify({ expiresAt, localOperator: !actorSessionId })]);
      return actor.username;
    });
  }

  async completePasswordReset(username: string, codeHash: string, registrationRecord: string): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const at = nowIso();
      const row = await driver.get<{ account_id: string }>('SELECT r.account_id FROM account_password_resets r JOIN sync_account_identities i ON i.account_id = r.account_id JOIN sync_users u ON u.username = i.username WHERE i.username = ? AND r.code_hash = ? AND r.expires_at > ? AND u.disabled = 0', [username, codeHash, at]);
      if (!row) throw new ServerStoreError('INVALID_PASSWORD_RESET', 403, '重置码无效、已使用或已过期，请联系管理员重新审核');
      await driver.run('UPDATE sync_users SET opaque_registration_record = ?, updated_at = ? WHERE username = ?', [registrationRecord, at, username]);
      await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ?', [at, at, username]);
      await driver.run('DELETE FROM sync_opaque_login_states WHERE username = ?', [username]);
      await driver.run('DELETE FROM account_password_resets WHERE account_id = ?', [row.account_id]);
      await driver.run('INSERT INTO server_admin_audit (at, actor_account_id, target_account_id, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)', [at, row.account_id, row.account_id, 'password-reset-complete', '{}', '{"sessionsRevoked":true}']);
    });
  }

  async getReplica(username: string): Promise<UserReplica | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM sync_replicas WHERE username = ?', [username]);
    return row ? replicaFromRow(row) : undefined;
  }

  async bindReplica(username: string, ledgerId: string): Promise<UserReplica> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const row = await driver.get<Record<string, unknown>>('SELECT * FROM sync_replicas WHERE username = ?', [username]);
      if (row) {
        const replica = replicaFromRow(row);
        if (replica.ledgerId !== ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, 'account is already bound to another ledger');
        return replica;
      }
      const at = nowIso();
      const replica: UserReplica = {
        username, ledgerId,
        replicaId: `rep-${randomBytes(12).toString('hex')}`,
        streamEpoch: `epoch-${randomBytes(12).toString('hex')}`,
        headSeq: 0, createdAt: at, updatedAt: at,
      };
      await driver.run(
        'INSERT INTO sync_replicas (username, ledger_id, replica_id, stream_epoch, head_seq, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
        [username, ledgerId, replica.replicaId, replica.streamEpoch, at, at],
      );
      return replica;
    });
  }

  /** Replace only the explicitly confirmed replica, including its initial encrypted data. */
  async replaceReplica(username: string, sessionId: string, expected: { ledgerId: string; streamEpoch: string }, envelope: JsonRecord, commits: Omit<StoredCommit, 'seq' | 'cipherBytes' | 'createdAt'>[], protection?: Omit<LedgerProtection, 'version'>): Promise<UserReplica> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      const actor = await driver.get('SELECT session_id FROM sync_sessions WHERE username = ? AND session_id = ? AND revoked_at IS NULL AND expires_at > ?', [username, sessionId, at]);
      if (!actor) throw new ServerStoreError('SESSION_REVOKED', 401, '请重新登录后再替换账本');
      const row = await driver.get<Record<string, unknown>>('SELECT * FROM sync_replicas WHERE username = ?', [username]);
      const current = row ? replicaFromRow(row) : undefined;
      const ledgerId = String(envelope.ledgerId);
      // A lost response can be retried without deleting any newly synchronized commits.
      if (current?.ledgerId === ledgerId) {
        const stored = await driver.get<{ envelope_json: string }>('SELECT envelope_json FROM sync_key_envelopes WHERE username = ?', [username]);
        if (stored?.envelope_json === JSON.stringify(envelope)) return current;
      }
      if (!current || current.ledgerId !== expected.ledgerId || current.streamEpoch !== expected.streamEpoch || ledgerId === current.ledgerId) {
        throw new ServerStoreError('LEDGER_MISMATCH', 409, '服务器账本已变化，请重新登录并确认要替换的账本');
      }
      const quota = await driver.get<{ commit_quota_bytes: number }>('SELECT commit_quota_bytes FROM sync_user_quotas WHERE username = ?', [username]);
      const bytes = commits.reduce((sum, commit) => sum + Buffer.byteLength(JSON.stringify(commit.encCommit)), 0);
      if (bytes > Number(quota?.commit_quota_bytes ?? this.defaultCommitQuotaBytes)) throw new ServerStoreError('COMMIT_QUOTA_EXCEEDED', 507, 'encrypted commit quota exceeded');
      await driver.run('DELETE FROM sync_server_commits WHERE username = ?', [username]);
      await driver.run('DELETE FROM sync_key_envelopes WHERE username = ?', [username]);
      const next = { ...current, ledgerId, replicaId: `rep-${randomBytes(12).toString('hex')}`, streamEpoch: `epoch-${randomBytes(12).toString('hex')}`, headSeq: commits.length, updatedAt: at };
      await driver.run('UPDATE sync_replicas SET ledger_id = ?, replica_id = ?, stream_epoch = ?, head_seq = ?, updated_at = ? WHERE username = ?', [ledgerId, next.replicaId, next.streamEpoch, next.headSeq, at, username]);
      await driver.run('INSERT INTO sync_key_envelopes (username, ledger_id, keyring_id, generation, envelope_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [username, ledgerId, String(envelope.keyringId), Number(envelope.generation), JSON.stringify(envelope), at]);
      if (protection) {
        await driver.run('INSERT INTO sync_key_custody (username, mode, version, sealed_secret, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(username) DO UPDATE SET mode = excluded.mode, version = sync_key_custody.version + 1, sealed_secret = excluded.sealed_secret, updated_at = excluded.updated_at', [username, protection.mode, protection.sealedSecret, at]);
      }
      for (const [index, commit] of commits.entries()) {
        if (commit.ledgerId !== ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, 'initial commit belongs to another ledger');
        const encoded = JSON.stringify(commit.encCommit);
        await driver.run('INSERT INTO sync_server_commits (username, seq, commit_id, ledger_id, content_hash, enc_commit_json, cipher_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [username, index + 1, commit.commitId, ledgerId, commit.contentHash, encoded, Buffer.byteLength(encoded), at]);
      }
      await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ? AND session_id <> ?', [at, at, username, sessionId]);
      return next;
    });
  }

  async getKeyEnvelope(username: string, ledgerId: string): Promise<JsonRecord | undefined> {
    await this.ready;
    const row = await this.driver.get<{ envelope_json: string }>(
      'SELECT envelope_json FROM sync_key_envelopes WHERE username = ? AND ledger_id = ?',
      [username, ledgerId],
    );
    return row ? jsonObject(row.envelope_json) : undefined;
  }

  async putKeyEnvelope(
    username: string,
    ledgerId: string,
    keyringId: string,
    generation: number,
    envelope: JsonRecord,
  ): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const replica = await driver.get<{ ledger_id: string }>('SELECT ledger_id FROM sync_replicas WHERE username = ?', [username]);
      if (replica?.ledger_id !== ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, 'account is bound to another ledger');
      const current = await driver.get<{ keyring_id: string; generation: number; envelope_json: string }>(
        'SELECT keyring_id, generation, envelope_json FROM sync_key_envelopes WHERE username = ?',
        [username],
      );
      const serialized = JSON.stringify(envelope);
      if (current) {
        if (current.keyring_id !== keyringId) throw new ServerStoreError('KEYRING_MISMATCH', 409, 'a different ledger keyring is already stored');
        if (Number(current.generation) > generation) throw new ServerStoreError('STALE_KEY_ENVELOPE', 409, 'a newer key envelope is already stored');
        if (Number(current.generation) === generation && current.envelope_json !== serialized) {
          throw new ServerStoreError('KEY_ENVELOPE_COLLISION', 409, 'same key generation has different ciphertext');
        }
        if (Number(current.generation) === generation) return;
      }
      await driver.run(
        `INSERT OR REPLACE INTO sync_key_envelopes
         (username, ledger_id, keyring_id, generation, envelope_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [username, ledgerId, keyringId, generation, serialized, nowIso()],
      );
    });
  }

  async putBackupArchive(
    username: string,
    ledgerId: string,
    archive: Omit<ServerBackupArchive, 'ledgerId'>,
  ): Promise<ServerBackupArchive> {
    await this.ready;
    const existing = await this.driver.get<Record<string, unknown>>(
      `SELECT * FROM sync_backup_archives
       WHERE username = ? AND ledger_id = ? AND archive_id = ?`,
      [username, ledgerId, archive.archiveId],
    );
    if (existing) {
      const current = backupFromRow(existing);
      if (current.blobId !== archive.blobId || current.sizeBytes !== archive.sizeBytes) {
        throw new ServerStoreError('BACKUP_ID_COLLISION', 409, 'backup archive id already has different content');
      }
      if (existing['deleted_at'] != null) {
        await this.driver.run(
          `UPDATE sync_backup_archives SET deleted_at = NULL
           WHERE username = ? AND ledger_id = ? AND archive_id = ?`,
          [username, ledgerId, archive.archiveId],
        );
      }
      return { ...current, label: archive.label };
    }
    await this.driver.run(
      `INSERT INTO sync_backup_archives
       (username, ledger_id, archive_id, blob_id, created_at, reason, kind, label,
        size_bytes, source_generation, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        username,
        ledgerId,
        archive.archiveId,
        archive.blobId,
        archive.createdAt,
        archive.reason,
        archive.kind,
        archive.label,
        archive.sizeBytes,
        archive.sourceGeneration ?? null,
      ],
    );
    return { ...archive, ledgerId };
  }

  async listBackupArchives(
    username: string,
    ledgerId: string,
    limit = 100,
  ): Promise<ServerBackupArchive[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT * FROM sync_backup_archives
       WHERE username = ? AND ledger_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC, archive_id DESC LIMIT ?`,
      [username, ledgerId, Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    return rows.map(backupFromRow);
  }

  async removeBackupArchive(
    username: string,
    ledgerId: string,
    archiveId: string,
  ): Promise<ServerBackupArchive | undefined> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const row = await driver.get<Record<string, unknown>>(
        `SELECT * FROM sync_backup_archives
         WHERE username = ? AND ledger_id = ? AND archive_id = ? AND deleted_at IS NULL`,
        [username, ledgerId, archiveId],
      );
      if (!row) return undefined;
      await driver.run(
        `UPDATE sync_backup_archives SET deleted_at = ?
         WHERE username = ? AND ledger_id = ? AND archive_id = ? AND deleted_at IS NULL`,
        [nowIso(), username, ledgerId, archiveId],
      );
      return backupFromRow(row);
    });
  }

  async listCommits(username: string, after: number, limit: number): Promise<{ commits: StoredCommit[]; headSeq: number; nextSeq: number; hasMore: boolean }> {
    await this.ready;
    const replica = await this.getReplica(username);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
    const rows = await this.driver.all<Record<string, unknown>>(
      'SELECT * FROM sync_server_commits WHERE username = ? AND seq > ? ORDER BY seq LIMIT ?',
      [username, after, limit],
    );
    const commits = rows.map((row): StoredCommit => ({
      seq: Number(row['seq']), commitId: String(row['commit_id']), ledgerId: String(row['ledger_id']),
      contentHash: String(row['content_hash']), encCommit: jsonObject(row['enc_commit_json']),
      cipherBytes: Number(row['cipher_bytes']), createdAt: String(row['created_at']),
    }));
    const nextSeq = commits.at(-1)?.seq ?? after;
    return { commits, headSeq: replica.headSeq, nextSeq, hasMore: nextSeq < replica.headSeq };
  }

  async pushCommits(username: string, incoming: Omit<StoredCommit, 'seq' | 'cipherBytes' | 'createdAt'>[]): Promise<{ assigned: { commitId: string; seq: number; contentHash: string }[]; replica: UserReplica }> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const replicaRow = await driver.get<Record<string, unknown>>('SELECT * FROM sync_replicas WHERE username = ?', [username]);
      if (!replicaRow) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
      const replica = replicaFromRow(replicaRow);
      const quotaRow = await driver.get<{ commit_quota_bytes: number }>('SELECT commit_quota_bytes FROM sync_user_quotas WHERE username = ?', [username]);
      const usedRow = await driver.get<{ bytes: number }>('SELECT COALESCE(SUM(cipher_bytes), 0) AS bytes FROM sync_server_commits WHERE username = ?', [username]);
      const quota = Number(quotaRow?.commit_quota_bytes ?? this.defaultCommitQuotaBytes);
      let projected = Number(usedRow?.bytes ?? 0);
      let headSeq = replica.headSeq;
      const assigned: { commitId: string; seq: number; contentHash: string }[] = [];
      for (const item of incoming) {
        if (item.ledgerId !== replica.ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, 'account is bound to another ledger');
        const existing = await driver.get<{ seq: number; content_hash: string }>('SELECT seq, content_hash FROM sync_server_commits WHERE username = ? AND commit_id = ?', [username, item.commitId]);
        if (existing) {
          if (existing.content_hash !== item.contentHash) throw new ServerStoreError('COMMIT_ID_COLLISION', 409, `commit ${item.commitId} has different content`);
          assigned.push({ commitId: item.commitId, seq: Number(existing.seq), contentHash: existing.content_hash });
          continue;
        }
        const encoded = JSON.stringify(item.encCommit);
        const bytes = Buffer.byteLength(encoded);
        if (projected + bytes > quota) throw new ServerStoreError('COMMIT_QUOTA_EXCEEDED', 507, 'encrypted commit quota exceeded');
        headSeq += 1;
        projected += bytes;
        await driver.run(
          `INSERT INTO sync_server_commits
           (username, seq, commit_id, ledger_id, content_hash, enc_commit_json, cipher_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [username, headSeq, item.commitId, item.ledgerId, item.contentHash, encoded, bytes, nowIso()],
        );
        assigned.push({ commitId: item.commitId, seq: headSeq, contentHash: item.contentHash });
      }
      const at = nowIso();
      await driver.run('UPDATE sync_replicas SET head_seq = ?, updated_at = ? WHERE username = ?', [headSeq, at, username]);
      await driver.run('UPDATE sync_users SET updated_at = ? WHERE username = ?', [at, username]);
      return { assigned, replica: { ...replica, headSeq, updatedAt: at } };
    });
  }

  async setCommitQuota(username: string, quotaBytes?: number): Promise<void> {
    await this.ready;
    if (quotaBytes === undefined) await this.driver.run('DELETE FROM sync_user_quotas WHERE username = ?', [username]);
    else await this.driver.run('INSERT OR REPLACE INTO sync_user_quotas (username, commit_quota_bytes, updated_at) VALUES (?, ?, ?)', [username, quotaBytes, nowIso()]);
  }

  async listInvites(): Promise<Invite[]> {
    await this.ready;
    return (await this.driver.all<Record<string, unknown>>('SELECT i.*, p.expires_at FROM registration_invites i LEFT JOIN registration_invite_policy p ON p.code = i.code ORDER BY i.created_at DESC')).map(inviteFromRow);
  }

  async getInvite(code: string): Promise<Invite | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT i.*, p.expires_at FROM registration_invites i LEFT JOIN registration_invite_policy p ON p.code = i.code WHERE i.code = ?', [code]);
    return row ? inviteFromRow(row) : undefined;
  }

  async createInvite(code: string): Promise<Invite> {
    await this.ready;
    if (await this.getInvite(code)) throw new ServerStoreError('INVITE_EXISTS', 409, 'invite exists');
    const invite: Invite = { code, createdAt: nowIso(), disabled: false };
    await this.driver.run('INSERT INTO registration_invites (code, created_at, disabled) VALUES (?, ?, 0)', [code, invite.createdAt]);
    return invite;
  }

  async setInviteDisabled(code: string, disabled: boolean): Promise<Invite | undefined> {
    await this.ready;
    await this.driver.run('UPDATE registration_invites SET disabled = ? WHERE code = ?', [disabled ? 1 : 0, code]);
    return this.getInvite(code);
  }

  /** Trimming is batched: one DELETE per log write made every line pay for the whole table. */
  async pruneLogs(retention = LOG_RETENTION): Promise<{ removed: number }> {
    await this.ready;
    const result = await this.driver.run(
      `DELETE FROM server_logs WHERE id IN (
         SELECT id FROM server_logs ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?
       )`,
      [retention],
    );
    return { removed: Number(result.changes ?? 0) };
  }

  async appendLog(log: ServerLog): Promise<void> {
    await this.ready;
    await this.driver.run(
      `INSERT INTO server_logs (id, at, level, action, message, ip, username, status, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [log.id, log.at, log.level, log.action, log.message, log.ip ?? null, log.username ?? null, log.status ?? null, log.detail ? JSON.stringify(log.detail) : null],
    );
    this.logWrites += 1;
    const now = Date.now();
    if (this.logWrites >= 200 || now - this.lastLogPruneAt >= 60_000) {
      this.logWrites = 0;
      this.lastLogPruneAt = now;
      await this.pruneLogs();
    }
  }

  async listLogs(options: {
    limit: number;
    level?: string;
    from?: string;
    until?: string;
    cursor?: string;
    requestId?: string;
    /** Exact account name, as recorded on the log line. */
    username?: string;
    action?: string;
  }): Promise<{ logs: ServerLog[]; nextCursor?: string }> {
    await this.ready;
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (options.level) { clauses.push('level = ?'); params.push(options.level); }
    if (options.username) { clauses.push('username = ?'); params.push(options.username); }
    if (options.action) { clauses.push('action = ?'); params.push(options.action); }
    if (options.from) { clauses.push('at >= ?'); params.push(options.from); }
    if (options.until) { clauses.push('at < ?'); params.push(options.until); }
    if (options.cursor) { const [cursorAt, cursorId] = options.cursor.split('|'); clauses.push('(at < ? OR (at = ? AND id < ?))'); params.push(cursorAt ?? '', cursorAt ?? '', cursorId ?? ''); }
    // Lets an operator jump from an error message straight to the request log line.
    if (options.requestId) { clauses.push("instr(COALESCE(detail_json, ''), ?) > 0"); params.push(options.requestId); }
    let sql = 'SELECT * FROM server_logs';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY at DESC, id DESC LIMIT ?';
    params.push(options.limit + 1);
    const rows = await this.driver.all<Record<string, unknown>>(sql, params);
    const page = rows.slice(0, options.limit).map((row): ServerLog => ({
      id: String(row['id']), at: String(row['at']), level: String(row['level']) as ServerLogLevel,
      action: String(row['action']), message: String(row['message']),
      ...(row['ip'] == null ? {} : { ip: String(row['ip']) }),
      ...(row['username'] == null ? {} : { username: String(row['username']) }),
      ...(row['status'] == null ? {} : { status: Number(row['status']) }),
      ...(row['detail_json'] == null ? {} : { detail: jsonObject(row['detail_json']) }),
    }));
    const last = page.at(-1);
    return { logs: page, ...(rows.length > options.limit && last ? { nextCursor: `${last.at}|${last.id}` } : {}) };
  }


  /** Distinct actions seen in the retained log, for the console filter. */
  async listLogActions(limit = 200): Promise<string[]> {
    await this.ready;
    const rows = await this.driver.all<{ action: string }>('SELECT DISTINCT action FROM server_logs ORDER BY action LIMIT ?', [Math.max(1, Math.min(500, limit))]);
    return rows.map((row) => String(row.action));
  }

  async status(): Promise<ServerStatus> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>(
      `SELECT
        (SELECT username FROM server_ownership WHERE singleton = 1) AS owner_username,
        (SELECT COUNT(*) FROM sync_users) AS user_count,
        (SELECT COUNT(*) FROM sync_users WHERE disabled = 1) AS disabled_user_count,
        (SELECT COUNT(*) FROM registration_invites) AS invite_count,
        (SELECT COUNT(*) FROM sync_server_commits) AS commit_count,
        (SELECT COALESCE(SUM(cipher_bytes), 0) FROM sync_server_commits) AS commit_bytes,
        (SELECT COUNT(*) FROM sync_sessions WHERE revoked_at IS NULL AND expires_at > ?) AS active_session_count`,
      [nowIso()],
    );
    const journal = await this.driver.get<{ journal_mode: string }>('PRAGMA journal_mode');
    const temp = await this.driver.get<{ temp_store: number }>('PRAGMA temp_store');
    return {
      claimed: row?.['owner_username'] != null,
      ...(row?.['owner_username'] == null ? {} : { ownerUsername: String(row['owner_username']) }),
      registrationMode: await this.registrationMode(),
      userCount: Number(row?.['user_count'] ?? 0), disabledUserCount: Number(row?.['disabled_user_count'] ?? 0),
      inviteCount: Number(row?.['invite_count'] ?? 0), commitCount: Number(row?.['commit_count'] ?? 0),
      commitBytes: Number(row?.['commit_bytes'] ?? 0), activeSessionCount: Number(row?.['active_session_count'] ?? 0),
      journalMode: String(journal?.journal_mode ?? ''),
      tempStore: Number(temp?.temp_store) === 2 ? 'memory' : String(temp?.temp_store ?? ''),
      schemaVersion: CURRENT_SERVER_SCHEMA,
    };
  }

  async hasCustodySecrets(): Promise<boolean> {
    await this.ready;
    return Boolean(await this.driver.get('SELECT username FROM sync_key_custody WHERE sealed_secret IS NOT NULL LIMIT 1'));
  }

  async getLedgerProtection(username: string): Promise<LedgerProtection | undefined> {
    await this.ready;
    const row = await this.driver.get<{ mode: LedgerProtection['mode']; version: number; sealed_secret: string | null }>('SELECT mode, version, sealed_secret FROM sync_key_custody WHERE username = ?', [username]);
    return row ? { mode: row.mode, version: Number(row.version), sealedSecret: row.sealed_secret } : undefined;
  }

  /** Compare-and-swap custody and the matching envelope together, under the live session. */
  async setLedgerProtection(username: string, sessionId: string, expectedVersion: number, next: Omit<LedgerProtection, 'version'>, envelope: JsonRecord): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const session = await driver.get<{ revoked_at: string | null; expires_at: string }>('SELECT revoked_at, expires_at FROM sync_sessions WHERE session_id = ? AND username = ?', [sessionId, username]);
      if (!session || session.revoked_at || session.expires_at <= nowIso()) throw new ServerStoreError('UNAUTHORIZED', 401, 'session expired');
      const current = await driver.get<{ version: number }>('SELECT version FROM sync_key_custody WHERE username = ?', [username]);
      if (Number(current?.version ?? 0) !== expectedVersion) throw new ServerStoreError('PROTECTION_CHANGED', 409, '保护设置已变化，请重新读取');
      const replica = await driver.get<{ ledger_id: string }>('SELECT ledger_id FROM sync_replicas WHERE username = ?', [username]);
      if (replica && replica.ledger_id !== envelope.ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, 'account is bound to another ledger');
      const oldEnvelope = await driver.get<{ envelope_json: string; generation: number; keyring_id: string }>('SELECT envelope_json, generation, keyring_id FROM sync_key_envelopes WHERE username = ?', [username]);
      if (oldEnvelope && (oldEnvelope.keyring_id !== envelope.keyringId || Number(oldEnvelope.generation) > Number(envelope.generation)
        || Number(oldEnvelope.generation) === Number(envelope.generation) && oldEnvelope.envelope_json !== JSON.stringify(envelope))) {
        throw new ServerStoreError('KEY_ENVELOPE_COLLISION', 409, '账本密钥已变化，请重新同步');
      }
      const at = nowIso();
      if (!replica) await driver.run('INSERT INTO sync_replicas (username, ledger_id, replica_id, stream_epoch, head_seq, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)', [username, String(envelope.ledgerId), `rep-${randomBytes(12).toString('hex')}`, `epoch-${randomBytes(12).toString('hex')}`, at, at]);
      await driver.run('INSERT OR REPLACE INTO sync_key_envelopes (username, ledger_id, keyring_id, generation, envelope_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [username, String(envelope.ledgerId), String(envelope.keyringId), Number(envelope.generation), JSON.stringify(envelope), at]);
      await driver.run('INSERT OR REPLACE INTO sync_key_custody (username, mode, version, sealed_secret, updated_at) VALUES (?, ?, ?, ?, ?)', [username, next.mode, expectedVersion + 1, next.sealedSecret, at]);
      if (oldEnvelope && Number(envelope.generation) > Number(oldEnvelope.generation)) {
        await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ? AND session_id <> ?', [at, at, username, sessionId]);
      }
    });
  }

  async listInvitesPage(before = 0, limit = 25, state = ''): Promise<{ invites: Invite[]; nextCursor?: string }> {
    await this.ready;
    // A numeric cursor avoids placing the invitation credential in pagination URLs.
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT i.*, i.rowid AS cursor_id, p.expires_at FROM registration_invites i
       LEFT JOIN registration_invite_policy p ON p.code = i.code
       WHERE (? = 0 OR i.rowid < ?)
         AND (? = '' OR CASE WHEN i.used_by IS NOT NULL THEN 'used'
           WHEN i.disabled = 1 THEN 'revoked'
           WHEN p.expires_at <= ? THEN 'expired' ELSE 'available' END = ?)
       ORDER BY i.rowid DESC LIMIT ?`,
      [before, before, state, nowIso(), state, limit + 1],
    );
    return {
      invites: rows.slice(0, limit).map(inviteFromRow),
      ...(rows.length > limit ? { nextCursor: String(rows[limit - 1]!['cursor_id']) } : {}),
    };
  }

  async verify(): Promise<{ ok: boolean; result: string; journalMode: string; tempStore: string; schemaVersion: number }> {
    await this.ready;
    const check = await this.driver.get<Record<string, unknown>>('PRAGMA quick_check');
    const result = String(Object.values(check ?? {})[0] ?? 'unknown');
    const journal = await this.driver.get<{ journal_mode: string }>('PRAGMA journal_mode');
    const temp = await this.driver.get<{ temp_store: number }>('PRAGMA temp_store');
    return {
      ok: result === 'ok',
      result,
      journalMode: String(journal?.journal_mode ?? ''),
      tempStore: Number(temp?.temp_store) === 2 ? 'memory' : String(temp?.temp_store ?? ''),
      schemaVersion: CURRENT_SERVER_SCHEMA,
    };
  }

  async checkpoint(): Promise<void> {
    await this.ready;
    await this.driver.exec('PRAGMA wal_checkpoint(FULL);');
  }

  async vacuumInto(path: string): Promise<void> {
    await this.ready;
    await this.checkpoint();
    const quoted = await this.driver.get<{ value: string }>('SELECT quote(?) AS value', [path]);
    if (!quoted?.value) throw new Error('cannot quote SQLite backup path');
    await this.driver.exec(`VACUUM INTO ${quoted.value};`);
  }

  /** Lightweight readiness probe: constant-time reads instead of a whole-database check. */
  async probe(): Promise<{ ok: boolean; result: string; journalMode: string; tempStore: string; schemaVersion: number; migrations: number }> {
    await this.ready;
    const check = await this.driver.get<Record<string, unknown>>('SELECT 1 AS ok');
    const migrations = await this.driver.get<{ value: number }>('SELECT COUNT(*) AS value FROM server_schema_migrations');
    const journal = await this.driver.get<{ journal_mode: string }>('PRAGMA journal_mode');
    const temp = await this.driver.get<{ temp_store: number }>('PRAGMA temp_store');
    const migrationCount = Number(migrations?.value ?? 0);
    const reachable = Number(check?.['ok']) === 1;
    return {
      ok: reachable && migrationCount === 1,
      result: reachable ? (migrationCount === 1 ? 'ok' : 'schema-mismatch') : 'unavailable',
      journalMode: String(journal?.journal_mode ?? ''),
      tempStore: Number(temp?.temp_store) === 2 ? 'memory' : String(temp?.temp_store ?? ''),
      schemaVersion: CURRENT_SERVER_SCHEMA,
      migrations: migrationCount,
    };
  }

  /** Deep check. Deliberately kept out of readiness and HTTP request paths. */
  async integrityCheck(): Promise<{ ok: boolean; result: string; schemaVersion: number; checkedAt: string }> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>('PRAGMA integrity_check');
    const result = rows.map((row) => String(Object.values(row)[0] ?? '')).join('; ') || 'unknown';
    return { ok: result === 'ok', result, schemaVersion: CURRENT_SERVER_SCHEMA, checkedAt: nowIso() };
  }

  async maintenanceState(key: string): Promise<JsonRecord | undefined> {
    await this.ready;
    const row = await this.driver.get<{ value_json: string }>('SELECT value_json FROM server_maintenance_state WHERE key = ?', [key]);
    return row ? jsonObject(row.value_json) : undefined;
  }

  async setMaintenanceState(key: string, value: JsonRecord): Promise<void> {
    await this.ready;
    await this.driver.run(
      'INSERT OR REPLACE INTO server_maintenance_state (key, value_json, updated_at) VALUES (?, ?, ?)',
      [key, JSON.stringify(value), nowIso()],
    );
  }

  async getMfa(username: string): Promise<AdminMfaRecord | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM admin_mfa WHERE username = ?', [username]);
    return row ? this.mapMfa(row) : undefined;
  }

  async saveMfa(record: Omit<AdminMfaRecord, 'lastStep'> & { lastStep?: number }): Promise<void> {
    await this.ready;
    await this.driver.run(
      `INSERT INTO admin_mfa (username, secret_cipher, enabled_at, confirmed, last_step, recovery_json, enrolled_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET secret_cipher = excluded.secret_cipher, confirmed = excluded.confirmed, enabled_at = excluded.enabled_at,
         last_step = excluded.last_step, recovery_json = excluded.recovery_json, enrolled_by = excluded.enrolled_by`,
      [
        record.username, record.secretCipher, record.enabledAt, record.confirmed ? 1 : 0, record.lastStep ?? -1,
        JSON.stringify(record.recoveryHashes), record.enrolledBy ?? null,
      ],
    );
  }

  async deleteMfa(username: string): Promise<void> {
    await this.ready;
    await this.driver.run('DELETE FROM admin_mfa WHERE username = ?', [username]);
  }

  /**
   * Consumes one time step. Returns false when the step was already used, so replaying a
   * code that is still inside its validity window cannot open a second session.
   */
  async recordMfaStep(username: string, step: number): Promise<boolean> {
    await this.ready;
    const result = await this.driver.run('UPDATE admin_mfa SET last_step = ? WHERE username = ? AND last_step < ?', [step, username, step]);
    return Number(result.changes ?? 0) > 0;
  }

  /** Removes one recovery code; the read-modify-write shares a transaction so two uses cannot both succeed. */
  async consumeMfaRecoveryCode(username: string, codeHash: string): Promise<boolean> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const row = await driver.get<{ recovery_json: string }>('SELECT recovery_json FROM admin_mfa WHERE username = ?', [username]);
      if (!row) return false;
      const hashes = jsonArray(row.recovery_json);
      if (!hashes.includes(codeHash)) return false;
      const remaining = hashes.filter((entry) => entry !== codeHash);
      await driver.run('UPDATE admin_mfa SET recovery_json = ? WHERE username = ?', [JSON.stringify(remaining), username]);
      return true;
    });
  }

  /** Owner plus every administrator: the set that a "require MFA" policy applies to. */
  async listAdminUsernames(): Promise<string[]> {
    await this.ready;
    const rows = await this.driver.all<{ username: string }>(`
      SELECT o.username FROM server_ownership o
      UNION
      SELECT a.username FROM server_administrators a
    `);
    return rows.map((row) => String(row.username));
  }

  async countMfaEnrolled(): Promise<number> {
    await this.ready;
    const row = await this.driver.get<{ value: number }>('SELECT COUNT(*) AS value FROM admin_mfa');
    return Number(row?.value ?? 0);
  }

  async createMfaChallenge(input: { id: string; username: string; tokenHash: string; ip?: string; expiresAt: string }): Promise<void> {
    await this.ready;
    // Expired challenges are cleared here: they are only useful for a few minutes and there is
    // no scheduled job that would otherwise collect them.
    await this.driver.run('DELETE FROM admin_mfa_challenges WHERE expires_at <= ?', [nowIso()]);
    await this.driver.run(
      'INSERT INTO admin_mfa_challenges (challenge_id, username, token_hash, ip, attempts, expires_at) VALUES (?, ?, ?, ?, 0, ?)',
      [input.id, input.username, input.tokenHash, input.ip ?? null, input.expiresAt],
    );
  }

  async getMfaChallenge(id: string): Promise<{ username: string; tokenHash: string; attempts: number; expiresAt: string; consumedAt?: string } | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM admin_mfa_challenges WHERE challenge_id = ?', [id]);
    if (!row) return undefined;
    return {
      username: String(row['username']),
      tokenHash: String(row['token_hash']),
      attempts: Number(row['attempts'] ?? 0),
      expiresAt: String(row['expires_at']),
      ...(row['consumed_at'] == null ? {} : { consumedAt: String(row['consumed_at']) }),
    };
  }

  async noteMfaChallengeAttempt(id: string): Promise<number> {
    await this.ready;
    await this.driver.run('UPDATE admin_mfa_challenges SET attempts = attempts + 1 WHERE challenge_id = ?', [id]);
    const row = await this.driver.get<{ attempts: number }>('SELECT attempts FROM admin_mfa_challenges WHERE challenge_id = ?', [id]);
    return Number(row?.attempts ?? 0);
  }

  async consumeMfaChallenge(id: string): Promise<void> {
    await this.ready;
    await this.driver.run('UPDATE admin_mfa_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL', [nowIso(), id]);
  }

  private mapMfa(row: Record<string, unknown>): AdminMfaRecord {
    return {
      username: String(row['username']),
      secretCipher: String(row['secret_cipher']),
      confirmed: bool(row['confirmed']),
      enabledAt: String(row['enabled_at']),
      lastStep: Number(row['last_step'] ?? -1),
      recoveryHashes: jsonArray(row['recovery_json']),
      ...(row['enrolled_by'] == null ? {} : { enrolledBy: String(row['enrolled_by']) }),
    };
  }

  /** One sample per request is aggregated into a minute and an hour bucket. */
  async recordServiceSample(sample: Partial<Omit<MetricBucket, 'bucketAt'>>, at = new Date()): Promise<void> {
    await this.ready;
    const buckets: [string, string][] = [
      ['minute', new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString()],
      ['hour', new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000).toISOString()],
    ];
    await this.driver.transaction(async (driver) => {
      for (const [granularity, bucketAt] of buckets) {
        await driver.run(
          `INSERT INTO server_metric_buckets
           (granularity, bucket_at, requests, errors, slow_requests, duration_ms,
            sync_push_ok, sync_push_failed, sync_pull_ok, blob_ok, blob_failed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(granularity, bucket_at) DO UPDATE SET
             requests = requests + excluded.requests,
             errors = errors + excluded.errors,
             slow_requests = slow_requests + excluded.slow_requests,
             duration_ms = duration_ms + excluded.duration_ms,
             sync_push_ok = sync_push_ok + excluded.sync_push_ok,
             sync_push_failed = sync_push_failed + excluded.sync_push_failed,
             sync_pull_ok = sync_pull_ok + excluded.sync_pull_ok,
             blob_ok = blob_ok + excluded.blob_ok,
             blob_failed = blob_failed + excluded.blob_failed`,
          [
            granularity, bucketAt,
            sample.requests ?? 0, sample.errors ?? 0, sample.slowRequests ?? 0, sample.durationMs ?? 0,
            sample.syncPushOk ?? 0, sample.syncPushFailed ?? 0, sample.syncPullOk ?? 0,
            sample.blobOk ?? 0, sample.blobFailed ?? 0,
          ],
        );
      }
    });
  }

  async listMetricBuckets(granularity: 'minute' | 'hour', from: string, until: string): Promise<MetricBucket[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(
      'SELECT * FROM server_metric_buckets WHERE granularity = ? AND bucket_at >= ? AND bucket_at < ? ORDER BY bucket_at',
      [granularity, from, until],
    );
    return rows.map((row) => ({
      bucketAt: String(row['bucket_at']),
      requests: Number(row['requests'] ?? 0),
      errors: Number(row['errors'] ?? 0),
      slowRequests: Number(row['slow_requests'] ?? 0),
      durationMs: Number(row['duration_ms'] ?? 0),
      syncPushOk: Number(row['sync_push_ok'] ?? 0),
      syncPushFailed: Number(row['sync_push_failed'] ?? 0),
      syncPullOk: Number(row['sync_pull_ok'] ?? 0),
      blobOk: Number(row['blob_ok'] ?? 0),
      blobFailed: Number(row['blob_failed'] ?? 0),
    }));
  }

  async pruneMetrics(now = new Date()): Promise<{ removed: number }> {
    await this.ready;
    const minuteCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const hourCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const minutes = await this.driver.run("DELETE FROM server_metric_buckets WHERE granularity = 'minute' AND bucket_at < ?", [minuteCutoff]);
    const hours = await this.driver.run("DELETE FROM server_metric_buckets WHERE granularity = 'hour' AND bucket_at < ?", [hourCutoff]);
    return { removed: Number(minutes.changes ?? 0) + Number(hours.changes ?? 0) };
  }

  /** Diagnostic events get their own retention so log trimming cannot erase them. */
  async recordSyncEvent(event: Omit<SyncEvent, 'id' | 'at'> & { at?: string }): Promise<void> {
    await this.ready;
    const at = event.at ?? nowIso();
    await this.driver.run(
      `INSERT OR REPLACE INTO sync_events
       (id, at, username, account_id, device_name, operation, outcome, result_code, category, commit_count, bytes, duration_ms, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomBytes(12).toString('hex'), at, event.username ?? null, event.accountId ?? null, event.deviceName ?? null,
        event.operation, event.outcome, event.resultCode ?? null, event.category ?? null,
        event.commitCount ?? null, event.bytes ?? null, event.durationMs ?? null, event.requestId ?? null,
      ],
    );
  }

  async listSyncEvents(options: {
    limit: number;
    cursor?: string;
    username?: string;
    accountId?: string;
    category?: string;
    outcome?: string;
    from?: string;
    until?: string;
  }): Promise<{ events: SyncEvent[]; nextCursor?: string }> {
    await this.ready;
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.username) { clauses.push('username = ?'); params.push(options.username); }
    if (options.accountId) { clauses.push('account_id = ?'); params.push(options.accountId); }
    if (options.category) { clauses.push('category = ?'); params.push(options.category); }
    if (options.outcome) { clauses.push('outcome = ?'); params.push(options.outcome); }
    if (options.from) { clauses.push('at >= ?'); params.push(options.from); }
    if (options.until) { clauses.push('at < ?'); params.push(options.until); }
    if (options.cursor) {
      const [cursorAt, cursorId] = options.cursor.split('|');
      clauses.push('(at < ? OR (at = ? AND id < ?))');
      params.push(cursorAt ?? '', cursorAt ?? '', cursorId ?? '');
    }
    let sql = 'SELECT * FROM sync_events';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY at DESC, id DESC LIMIT ?';
    params.push(options.limit + 1);
    const rows = await this.driver.all<Record<string, unknown>>(sql, params);
    const events = rows.slice(0, options.limit).map((row): SyncEvent => ({
      id: String(row['id']),
      at: String(row['at']),
      ...(row['username'] == null ? {} : { username: String(row['username']) }),
      ...(row['account_id'] == null ? {} : { accountId: String(row['account_id']) }),
      ...(row['device_name'] == null ? {} : { deviceName: String(row['device_name']) }),
      operation: String(row['operation']),
      outcome: row['outcome'] === 'ok' ? 'ok' : 'error',
      ...(row['result_code'] == null ? {} : { resultCode: String(row['result_code']) }),
      ...(row['category'] == null ? {} : { category: String(row['category']) as SyncEvent['category'] }),
      ...(row['commit_count'] == null ? {} : { commitCount: Number(row['commit_count']) }),
      ...(row['bytes'] == null ? {} : { bytes: Number(row['bytes']) }),
      ...(row['duration_ms'] == null ? {} : { durationMs: Number(row['duration_ms']) }),
      ...(row['request_id'] == null ? {} : { requestId: String(row['request_id']) }),
    }));
    const last = events.at(-1);
    return { events, ...(rows.length > options.limit && last ? { nextCursor: `${last.at}|${last.id}` } : {}) };
  }

  async pruneSyncEvents(retention = 20_000): Promise<{ removed: number }> {
    await this.ready;
    const result = await this.driver.run(
      `DELETE FROM sync_events WHERE id IN (
         SELECT id FROM sync_events ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?
       )`,
      [retention],
    );
    return { removed: Number(result.changes ?? 0) };
  }

  /** Accounts at or above a fraction of their quota, used by the capacity alert rule. */
  async capacityWarnings(ratio: number): Promise<{
    username: string; accountId: string; scope: 'commit' | 'blobs'; usedBytes: number; quotaBytes: number;
  }[]> {
    await this.ready;
    const hasBlobTables = await this.driver.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'blob_objects'");
    const blobBytes = hasBlobTables
      ? '(SELECT username, SUM(cipher_bytes) AS bytes FROM blob_objects WHERE state <> \'trash\' GROUP BY username)'
      : '(SELECT NULL AS username, 0 AS bytes WHERE 0)'
    ;
    const blobQuotas = hasBlobTables ? 'blob_user_quotas' : null;
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT u.username, i.account_id,
              COALESCE(c.bytes, 0) AS commit_bytes, COALESCE(q.commit_quota_bytes, ?) AS commit_quota,
              COALESCE(b.bytes, 0) AS blob_bytes, COALESCE(bq.quota_bytes, ?) AS blob_quota
       FROM sync_users u
       JOIN sync_account_identities i ON i.username = u.username
       LEFT JOIN (SELECT username, SUM(cipher_bytes) AS bytes FROM sync_server_commits GROUP BY username) c ON c.username = u.username
       LEFT JOIN sync_user_quotas q ON q.username = u.username
       LEFT JOIN ${blobBytes} b ON b.username = u.username
       LEFT JOIN ${blobQuotas ? blobQuotas : '(SELECT NULL AS username, 0 AS quota_bytes WHERE 0)'} bq ON bq.username = u.username
       WHERE u.disabled = 0`,
      [this.defaultCommitQuotaBytes, this.defaultBlobQuotaBytes],
    );
    const warnings: { username: string; accountId: string; scope: 'commit' | 'blobs'; usedBytes: number; quotaBytes: number }[] = [];
    for (const row of rows) {
      const username = String(row['username']);
      const accountId = String(row['account_id']);
      const commitQuota = Number(row['commit_quota'] ?? 0);
      const commitUsed = Number(row['commit_bytes'] ?? 0);
      if (commitQuota > 0 && commitUsed >= commitQuota * ratio) {
        warnings.push({ username, accountId, scope: 'commit', usedBytes: commitUsed, quotaBytes: commitQuota });
      }
      const blobQuota = Number(row['blob_quota'] ?? 0);
      const blobUsed = Number(row['blob_bytes'] ?? 0);
      if (blobQuota > 0 && blobUsed >= blobQuota * ratio) {
        warnings.push({ username, accountId, scope: 'blobs', usedBytes: blobUsed, quotaBytes: blobQuota });
      }
    }
    return warnings;
  }

  /** Sustained sync failures: only server-visible outcomes, never client offline gaps. */
  async recentSyncErrorCount(minutes: number): Promise<number> {
    await this.ready;
    const row = await this.driver.get<{ value: number }>(
      "SELECT COUNT(*) AS value FROM sync_events WHERE outcome = 'error' AND at >= ?",
      [new Date(Date.now() - minutes * 60_000).toISOString()],
    );
    return Number(row?.value ?? 0);
  }

  async countActiveSessions(username?: string): Promise<number> {
    await this.ready;
    const row = username
      ? await this.driver.get<{ value: number }>(
        'SELECT COUNT(*) AS value FROM sync_sessions WHERE username = ? AND revoked_at IS NULL AND expires_at > ?',
        [username, nowIso()],
      )
      : await this.driver.get<{ value: number }>(
        'SELECT COUNT(*) AS value FROM sync_sessions WHERE revoked_at IS NULL AND expires_at > ?',
        [nowIso()],
      );
    return Number(row?.value ?? 0);
  }

  /** Sessions are the management unit; the previous account-page unit is gone. */
  async listSessionsPage(options: {
    limit: number;
    cursor?: string;
    search?: string;
    state?: string;
    kind?: string;
    memberOnly?: boolean;
  }): Promise<{ sessions: AccountSessionSummary[]; nextCursor?: string }> {
    await this.ready;
    const at = nowIso();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.memberOnly) {
      clauses.push(`${ROLE_SQL} = 'member'`);
    }
    if (options.search) {
      clauses.push('(instr(lower(s.username), lower(?)) > 0 OR i.account_id = ? OR instr(lower(s.device_name), lower(?)) > 0)');
      params.push(options.search, options.search, options.search);
    }
    if (options.state === 'active') { clauses.push('s.revoked_at IS NULL AND s.expires_at > ?'); params.push(at); }
    else if (options.state === 'revoked') clauses.push('s.revoked_at IS NOT NULL');
    else if (options.state === 'expired') { clauses.push('s.revoked_at IS NULL AND s.expires_at <= ?'); params.push(at); }
    if (options.kind) { clauses.push('s.kind = ?'); params.push(options.kind); }
    if (options.cursor) {
      const [cursorSeen, cursorId] = options.cursor.split('|');
      clauses.push('(s.last_seen_at < ? OR (s.last_seen_at = ? AND s.session_id < ?))');
      params.push(cursorSeen ?? '', cursorSeen ?? '', cursorId ?? '');
    }
    let sql = `SELECT s.*, i.account_id,
        ${ROLE_SQL} AS role
      FROM sync_sessions s
      JOIN sync_account_identities i ON i.username = s.username
      LEFT JOIN server_administrators a ON a.username = s.username
      LEFT JOIN server_ownership o ON o.username = s.username`;
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY s.last_seen_at DESC, s.session_id DESC LIMIT ?';
    params.push(options.limit + 1);
    const rows = await this.driver.all<Record<string, unknown>>(sql, params);
    const sessions = rows.slice(0, options.limit).map((row): AccountSessionSummary => ({
      id: String(row['session_id']),
      username: String(row['username']),
      accountId: String(row['account_id']),
      role: row['role'] === 'owner' ? 'owner' : row['role'] === 'admin' ? 'admin' : row['role'] === 'viewer' ? 'viewer' : 'member',
      deviceId: String(row['device_id']),
      deviceName: String(row['device_name']),
      kind: String(row['kind'] ?? 'ledger'),
      createdAt: String(row['created_at']),
      lastSeenAt: String(row['last_seen_at']),
      expiresAt: String(row['expires_at']),
      ...(row['last_ip'] == null ? {} : { lastIp: String(row['last_ip']) }),
      ...(row['revoked_at'] == null ? {} : { revokedAt: String(row['revoked_at']) }),
      active: row['revoked_at'] == null && String(row['expires_at']) > at,
    }));
    const last = sessions.at(-1);
    return { sessions, ...(rows.length > options.limit && last ? { nextCursor: `${last.lastSeenAt}|${last.id}` } : {}) };
  }

  /** Every account-scoped read a single detail page needs, without exposing ledger bytes. */
  async accountDetail(accountId: string): Promise<JsonRecord | undefined> {
    await this.ready;
    const at = nowIso();
    const row = await this.driver.get<Record<string, unknown>>(
      `SELECT u.username, i.account_id, u.disabled, u.created_at, u.updated_at, u.last_login_at, u.revision,
              ${ROLE_SQL} AS role,
              r.ledger_id, r.replica_id, COALESCE(r.head_seq, 0) AS commit_count,
              (SELECT COUNT(*) FROM sync_server_commits c WHERE c.username = u.username) AS stored_commits,
              (SELECT COALESCE(SUM(c.cipher_bytes), 0) FROM sync_server_commits c WHERE c.username = u.username) AS commit_bytes,
              COALESCE(q.commit_quota_bytes, ?) AS commit_quota_bytes,
              c2.mode AS protection_mode, c2.version AS protection_version
       FROM sync_account_identities i
       JOIN sync_users u ON u.username = i.username
       LEFT JOIN server_administrators a ON a.username = u.username
       LEFT JOIN server_ownership o ON o.username = u.username
       LEFT JOIN sync_replicas r ON r.username = u.username
       LEFT JOIN sync_user_quotas q ON q.username = u.username
       LEFT JOIN sync_key_custody c2 ON c2.username = u.username
       WHERE i.account_id = ?`,
      [this.defaultCommitQuotaBytes, accountId],
    );
    if (!row) return undefined;
    const username = String(row['username']);
    const sessions = await this.driver.all<Record<string, unknown>>(
      `SELECT s.*, i.account_id,
              ${ROLE_SQL} AS role
       FROM sync_sessions s
       JOIN sync_account_identities i ON i.username = s.username
       LEFT JOIN server_administrators a ON a.username = s.username
       LEFT JOIN server_ownership o ON o.username = s.username
       WHERE s.username = ? ORDER BY s.last_seen_at DESC, s.session_id DESC LIMIT 100`,
      [username],
    );
    const events = await this.listSyncEvents({ limit: 20, accountId });
    const audit = await this.driver.all<Record<string, unknown>>(
      "SELECT id, at, actor_account_id, target_account_id, action, before_json, after_json, reason, request_id FROM server_admin_audit WHERE target_account_id = ? OR actor_account_id = ? ORDER BY id DESC LIMIT 20",
      [accountId, accountId],
    );
    const jobs = await this.driver.all<Record<string, unknown>>(
      'SELECT * FROM admin_jobs WHERE target_account_id = ? ORDER BY created_at DESC LIMIT 20',
      [accountId],
    );
    const activeSessions = sessions.filter((session) => session['revoked_at'] == null && String(session['expires_at']) > at).length;
    return {
      account: {
        username,
        accountId,
        role: row['role'] === 'owner' ? 'owner' : row['role'] === 'admin' ? 'admin' : row['role'] === 'viewer' ? 'viewer' : 'member',
        disabled: bool(row['disabled']),
        createdAt: String(row['created_at']),
        updatedAt: String(row['updated_at']),
        lastLoginAt: row['last_login_at'] ?? null,
        version: Number(row['revision'] ?? 1),
        protection: row['protection_mode'] == null
          ? null
          : { mode: String(row['protection_mode']), version: Number(row['protection_version'] ?? 0) },
      },
      capacity: {
        commitBytes: Number(row['commit_bytes'] ?? 0),
        commitQuotaBytes: Number(row['commit_quota_bytes']),
        commitCount: Number(row['stored_commits'] ?? 0),
        headSeq: Number(row['commit_count'] ?? 0),
        ledgerId: row['ledger_id'] ?? null,
        replicaId: row['replica_id'] ?? null,
      },
      sessions: sessions.map((session) => ({
        id: String(session['session_id']),
        username,
        accountId,
        role: session['role'] === 'owner' ? 'owner' : session['role'] === 'admin' ? 'admin' : 'member',
        deviceId: String(session['device_id']),
        deviceName: String(session['device_name']),
        kind: String(session['kind'] ?? 'ledger'),
        createdAt: String(session['created_at']),
        lastSeenAt: String(session['last_seen_at']),
        expiresAt: String(session['expires_at']),
        lastIp: session['last_ip'] ?? null,
        revokedAt: session['revoked_at'] ?? null,
        active: session['revoked_at'] == null && String(session['expires_at']) > at,
      })),
      activeSessionCount: activeSessions,
      sync: { recent: events.events },
      audit: audit.map((entry) => ({
        id: Number(entry['id']),
        at: String(entry['at']),
        actorAccountId: String(entry['actor_account_id']),
        targetAccountId: entry['target_account_id'] ?? null,
        action: String(entry['action']),
        reason: entry['reason'] ?? null,
        requestId: entry['request_id'] ?? null,
        before: JSON.parse(String(entry['before_json'])),
        after: JSON.parse(String(entry['after_json'])),
      })),
      jobs: jobs.map((job) => this.mapJob(job)),
    };
  }

  async countActiveSessionsForAccount(accountId: string): Promise<number> {
    await this.ready;
    const row = await this.driver.get<{ value: number }>(
      `SELECT COUNT(*) AS value FROM sync_sessions s
       JOIN sync_account_identities i ON i.username = s.username
       WHERE i.account_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
      [accountId, nowIso()],
    );
    return Number(row?.value ?? 0);
  }

  private mapJob(row: Record<string, unknown>): AdminJob {
    const status = String(row['status']);
    return {
      jobId: String(row['job_id']),
      type: String(row['type']) as AdminJobType,
      params: jsonObject(row['params_json']),
      status: (['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(status) ? status : 'failed') as AdminJobStatus,
      createdAt: String(row['created_at']),
      createdBy: String(row['created_by']),
      ...(row['target_account_id'] == null ? {} : { targetAccountId: String(row['target_account_id']) }),
      ...(row['started_at'] == null ? {} : { startedAt: String(row['started_at']) }),
      ...(row['finished_at'] == null ? {} : { finishedAt: String(row['finished_at']) }),
      ...(row['phase'] == null ? {} : { phase: String(row['phase']) }),
      processed: Number(row['processed'] ?? 0),
      total: Number(row['total'] ?? 0),
      ...(row['result_json'] == null ? {} : { result: jsonObject(row['result_json']) }),
      ...(row['error_code'] == null ? {} : { errorCode: String(row['error_code']) }),
      ...(row['error_message'] == null ? {} : { errorMessage: String(row['error_message']) }),
      cancelRequested: bool(row['cancel_requested']),
      ...(row['retry_of'] == null ? {} : { retryOf: String(row['retry_of']) }),
    };
  }

  async createJob(input: {
    type: AdminJobType;
    params?: JsonRecord;
    createdBy: string;
    targetAccountId?: string;
    retryOf?: string;
  }): Promise<AdminJob> {
    await this.ready;
    const job: AdminJob = {
      jobId: `job-${randomBytes(12).toString('hex')}`,
      type: input.type,
      params: input.params ?? {},
      status: 'queued',
      createdAt: nowIso(),
      createdBy: input.createdBy,
      ...(input.targetAccountId ? { targetAccountId: input.targetAccountId } : {}),
      processed: 0,
      total: 0,
      cancelRequested: false,
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
    };
    await this.driver.run(
      `INSERT INTO admin_jobs
       (job_id, type, params_json, status, created_at, created_by, target_account_id, processed, total, cancel_requested, retry_of)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, 0, 0, ?)`,
      [job.jobId, job.type, JSON.stringify(job.params), job.createdAt, job.createdBy, job.targetAccountId ?? null, job.retryOf ?? null],
    );
    return job;
  }

  async getJob(jobId: string): Promise<AdminJob | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM admin_jobs WHERE job_id = ?', [jobId]);
    return row ? this.mapJob(row) : undefined;
  }

  async listJobs(options: { limit: number; status?: string; type?: string; cursor?: string; accountId?: string }): Promise<{ jobs: AdminJob[]; nextCursor?: string }> {
    await this.ready;
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) { clauses.push('status = ?'); params.push(options.status); }
    if (options.type) { clauses.push('type = ?'); params.push(options.type); }
    // Targeted account: the field is only ever set for account-scoped task types, so this
    // filter is exactly "tasks that name this account".
    if (options.accountId) { clauses.push('target_account_id = ?'); params.push(options.accountId); }
    if (options.cursor) {
      const [cursorAt, cursorId] = options.cursor.split('|');
      clauses.push('(created_at < ? OR (created_at = ? AND job_id < ?))');
      params.push(cursorAt ?? '', cursorAt ?? '', cursorId ?? '');
    }
    let sql = 'SELECT * FROM admin_jobs';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC, job_id DESC LIMIT ?';
    params.push(options.limit + 1);
    const rows = await this.driver.all<Record<string, unknown>>(sql, params);
    const jobs = rows.slice(0, options.limit).map((row) => this.mapJob(row));
    const last = jobs.at(-1);
    return { jobs, ...(rows.length > options.limit && last ? { nextCursor: `${last.createdAt}|${last.jobId}` } : {}) };
  }

  async countJobsByStatus(): Promise<Record<string, number>> {
    await this.ready;
    const rows = await this.driver.all<{ status: string; value: number }>('SELECT status, COUNT(*) AS value FROM admin_jobs GROUP BY status');
    return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.value)]));
  }

  /** Claims at most one heavy job: the first phase runs a single maintenance worker. */
  async claimNextJob(): Promise<AdminJob | undefined> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const running = await driver.get<{ job_id: string }>("SELECT job_id FROM admin_jobs WHERE status = 'running' LIMIT 1");
      if (running) return undefined;
      const next = await driver.get<Record<string, unknown>>(
        "SELECT * FROM admin_jobs WHERE status = 'queued' ORDER BY created_at, job_id LIMIT 1",
      );
      if (!next) return undefined;
      const at = nowIso();
      const claimed = await driver.run(
        "UPDATE admin_jobs SET status = 'running', started_at = ?, phase = 'starting' WHERE job_id = ? AND status = 'queued'",
        [at, String(next['job_id'])],
      );
      if (Number(claimed.changes ?? 0) !== 1) return undefined;
      return this.mapJob({ ...next, status: 'running', started_at: at, phase: 'starting' });
    });
  }

  async updateJobProgress(jobId: string, patch: { phase?: string; processed?: number; total?: number }): Promise<void> {
    await this.ready;
    const assignments: string[] = [];
    const params: (string | number)[] = [];
    if (patch.phase !== undefined) { assignments.push('phase = ?'); params.push(patch.phase); }
    if (patch.processed !== undefined) { assignments.push('processed = ?'); params.push(patch.processed); }
    if (patch.total !== undefined) { assignments.push('total = ?'); params.push(patch.total); }
    if (!assignments.length) return;
    params.push(jobId);
    await this.driver.run(`UPDATE admin_jobs SET ${assignments.join(', ')} WHERE job_id = ?`, params);
  }

  async finishJob(jobId: string, outcome: {
    status: Exclude<AdminJobStatus, 'queued' | 'running'>;
    result?: JsonRecord;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    await this.ready;
    await this.driver.run(
      'UPDATE admin_jobs SET status = ?, finished_at = ?, result_json = ?, error_code = ?, error_message = ?, cancel_requested = CASE WHEN ? = \'cancelled\' THEN 1 ELSE cancel_requested END WHERE job_id = ?',
      [
        outcome.status, nowIso(),
        outcome.result === undefined ? null : JSON.stringify(outcome.result),
        outcome.errorCode ?? null, outcome.errorMessage ?? null,
        outcome.status, jobId,
      ],
    );
  }

  /**
   * Whether the operator who queued a job may still act. The job runner asks this immediately
   * before the work starts: queued work must not run for someone who has since been demoted,
   * disabled or removed.
   */
  async jobCreatorCanRun(username: string): Promise<boolean> {
    await this.ready;
    const row = await this.driver.get<{ disabled: number; role: string }>(
      `SELECT u.disabled, ${ROLE_SQL} AS role
       FROM sync_users u
       LEFT JOIN server_ownership o ON o.username = u.username
       LEFT JOIN server_administrators a ON a.username = u.username
       WHERE u.username = ?`,
      [username],
    );
    if (!row) return false;
    if (bool(row.disabled)) return false;
    return row.role === 'owner' || row.role === 'admin';
  }

  /**
   * Stops a job that must not run, without pretending it succeeded or failed on its own merits.
   * The reason is recorded on the job and in its event log, so the operator sees why nothing ran.
   */
  async abandonJob(jobId: string, reason: string): Promise<void> {
    await this.ready;
    await this.finishJob(jobId, { status: 'cancelled', errorCode: 'ACTOR_NOT_PERMITTED', errorMessage: reason });
    await this.appendJobEvent(jobId, 'warn', reason);
  }

  async requestJobCancel(jobId: string): Promise<AdminJob | undefined> {
    await this.ready;
    const job = await this.getJob(jobId);
    if (!job) return undefined;
    if (job.status === 'queued') {
      await this.driver.run("UPDATE admin_jobs SET cancel_requested = 1, status = 'cancelled', finished_at = ? WHERE job_id = ? AND status = 'queued'", [nowIso(), jobId]);
    } else if (job.status === 'running') {
      await this.driver.run('UPDATE admin_jobs SET cancel_requested = 1 WHERE job_id = ? AND status = \'running\'', [jobId]);
    }
    return this.getJob(jobId);
  }

  async jobCancelRequested(jobId: string): Promise<boolean> {
    await this.ready;
    const row = await this.driver.get<{ cancel_requested: number }>('SELECT cancel_requested FROM admin_jobs WHERE job_id = ?', [jobId]);
    return bool(row?.cancel_requested);
  }

  async appendJobEvent(jobId: string, level: ServerLogLevel, message: string, detail?: JsonRecord): Promise<void> {
    await this.ready;
    await this.driver.run(
      'INSERT INTO admin_job_events (job_id, at, level, message, detail_json) VALUES (?, ?, ?, ?, ?)',
      [jobId, nowIso(), level, message, detail ? JSON.stringify(detail) : null],
    );
  }

  async listJobEvents(jobId: string, limit = 50): Promise<AdminJobEvent[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(
      'SELECT * FROM admin_job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?',
      [jobId, Math.max(1, Math.min(200, limit))],
    );
    return rows.reverse().map((row) => ({
      id: Number(row['id']),
      jobId: String(row['job_id']),
      at: String(row['at']),
      level: String(row['level']) as ServerLogLevel,
      message: String(row['message']),
      ...(row['detail_json'] == null ? {} : { detail: jsonObject(row['detail_json']) }),
    }));
  }

  /**
   * A restart loses the executor. Only jobs with a checkpoint resume; the rest are
   * reported as interrupted so a crash is never shown as success.
   */
  async markInterruptedJobs(): Promise<{ interrupted: string[]; resumed: string[] }> {
    await this.ready;
    const at = nowIso();
    const running = await this.driver.all<Record<string, unknown>>("SELECT * FROM admin_jobs WHERE status = 'running'");
    const interrupted: string[] = [];
    const resumed: string[] = [];
    for (const row of running) {
      const job = this.mapJob(row);
      await this.driver.run(
        "UPDATE admin_jobs SET status = 'interrupted', finished_at = ?, error_code = 'EXECUTION_INTERRUPTED', error_message = ? WHERE job_id = ? AND status = 'running'",
        [at, '服务在任务执行期间退出，未完成的部分不会标记为成功', job.jobId],
      );
      interrupted.push(job.jobId);
      // Only blob verification keeps a resumable checkpoint; everything else stays manual.
      if (job.type === 'blobs.verify' && job.result && typeof job.result['lastKey'] === 'string') {
        const resumedJob = await this.createJob({
          type: job.type,
          params: { ...job.params, resumeFrom: String(job.result['lastKey']) },
          createdBy: job.createdBy,
          ...(job.targetAccountId ? { targetAccountId: job.targetAccountId } : {}),
          retryOf: job.jobId,
        });
        resumed.push(resumedJob.jobId);
        await this.appendJobEvent(resumedJob.jobId, 'info', '已从中断任务的检查点继续执行');
      }
    }
    return { interrupted, resumed };
  }

  async upsertAlert(input: {
    key: string;
    rule: string;
    scope: string;
    severity: AdminAlert['severity'];
    active: boolean;
    detail?: JsonRecord;
  }): Promise<AdminAlert> {
    await this.ready;
    const at = nowIso();
    return this.driver.transaction(async (driver) => {
      const row = await driver.get<Record<string, unknown>>('SELECT * FROM admin_alerts WHERE alert_key = ?', [input.key]);
      const current = row
        ? {
          occurrences: Number(row['occurrences'] ?? 0),
          healthyChecks: Number(row['healthy_checks'] ?? 0),
          badStreak: Number(row['bad_streak'] ?? 0),
          state: String(row['state']),
        }
        : undefined;
      let occurrences = current?.occurrences ?? 0;
      let healthyChecks = current?.healthyChecks ?? 0;
      let badStreak = current?.badStreak ?? 0;
      let state: AdminAlert['state'] = (current?.state as AdminAlert['state']) ?? 'pending';
      let resolvedAt: string | null = row?.['resolved_at'] == null ? null : String(row['resolved_at']);
      if (input.active) {
        occurrences += 1;
        healthyChecks = 0;
        // Only consecutive bad samples activate an alert: a healthy sample in between resets the
        // streak, so "bad → healthy → bad" stays pending instead of counting as two in a row.
        badStreak += 1;
        state = badStreak >= 2 ? 'active' : 'pending';
        resolvedAt = null;
      } else if (current && current.state !== 'resolved') {
        badStreak = 0;
        healthyChecks += 1;
        if (healthyChecks >= 2) { state = 'resolved'; resolvedAt = at; }
      }
      await driver.run(
        `INSERT INTO admin_alerts
         (alert_key, rule, scope, severity, state, first_seen_at, last_seen_at, occurrences, healthy_checks, bad_streak, detail_json, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(alert_key) DO UPDATE SET
           severity = excluded.severity, state = excluded.state, last_seen_at = excluded.last_seen_at,
           occurrences = excluded.occurrences, healthy_checks = excluded.healthy_checks,
           bad_streak = excluded.bad_streak,
           detail_json = excluded.detail_json, resolved_at = excluded.resolved_at`,
        [
          input.key, input.rule, input.scope, input.severity, state, row?.['first_seen_at'] == null ? at : String(row['first_seen_at']),
          at, occurrences, healthyChecks, badStreak, input.detail ? JSON.stringify(input.detail) : null, resolvedAt,
        ],
      );
      const saved = await driver.get<Record<string, unknown>>('SELECT * FROM admin_alerts WHERE alert_key = ?', [input.key]);
      return this.mapAlert(saved!);
    });
  }

  private mapAlert(row: Record<string, unknown>): AdminAlert {
    const state = String(row['state']);
    const severity = String(row['severity']);
    return {
      key: String(row['alert_key']),
      rule: String(row['rule']),
      scope: String(row['scope']),
      severity: severity === 'critical' ? 'critical' : 'warning',
      state: (['pending', 'active', 'resolved'].includes(state) ? state : 'pending') as AdminAlert['state'],
      firstSeenAt: String(row['first_seen_at']),
      lastSeenAt: String(row['last_seen_at']),
      occurrences: Number(row['occurrences'] ?? 0),
      consecutive: Number(row['bad_streak'] ?? 0),
      ...(row['detail_json'] == null ? {} : { detail: jsonObject(row['detail_json']) }),
      ...(row['acknowledged_at'] == null ? {} : { acknowledgedAt: String(row['acknowledged_at']) }),
      ...(row['acknowledged_by'] == null ? {} : { acknowledgedBy: String(row['acknowledged_by']) }),
      ...(row['resolved_at'] == null ? {} : { resolvedAt: String(row['resolved_at']) }),
      ...(row['silenced_until'] == null ? {} : { silencedUntil: String(row['silenced_until']) }),
      ...(row['silenced_by'] == null ? {} : { silencedBy: String(row['silenced_by']) }),
      ...(row['silence_reason'] == null ? {} : { silenceReason: String(row['silence_reason']) }),
      ...(row['notified_at'] == null ? {} : { lastNotifiedAt: String(row['notified_at']) }),
      ...(row['notify_state'] == null ? {} : { notifyState: String(row['notify_state']) as AdminAlert['notifyState'] }),
      ...(row['notify_error'] == null ? {} : { notifyError: String(row['notify_error']) }),
    };
  }

  async listAlerts(options: { state?: string; limit?: number } = {}): Promise<AdminAlert[]> {
    await this.ready;
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.state) { clauses.push('state = ?'); params.push(options.state); }
    let sql = 'SELECT * FROM admin_alerts';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY CASE state WHEN \'active\' THEN 0 WHEN \'pending\' THEN 1 ELSE 2 END, last_seen_at DESC LIMIT ?';
    params.push(options.limit ?? 100);
    return (await this.driver.all<Record<string, unknown>>(sql, params)).map((row) => this.mapAlert(row));
  }

  async getAlert(key: string): Promise<AdminAlert | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM admin_alerts WHERE alert_key = ?', [key]);
    return row ? this.mapAlert(row) : undefined;
  }

  /** Records the last external notification attempt next to the alert it belongs to. */
  async recordAlertNotification(key: string, result: { state: 'sent' | 'failed' | 'skipped'; error?: string }): Promise<void> {
    await this.ready;
    await this.driver.run('UPDATE admin_alerts SET notified_at = ?, notify_state = ?, notify_error = ? WHERE alert_key = ?', [nowIso(), result.state, result.error ?? null, key]);
  }

  /**
   * Store-level primitive: the management API writes through `mutateAdmin`, so an
   * acknowledgement made from the console also lands in the durable audit trail.
   */
  async acknowledgeAlert(key: string, actorAccountId: string): Promise<AdminAlert | undefined> {
    await this.ready;
    await this.driver.run(
      "UPDATE admin_alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE alert_key = ? AND acknowledged_at IS NULL",
      [nowIso(), actorAccountId, key],
    );
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM admin_alerts WHERE alert_key = ?', [key]);
    return row ? this.mapAlert(row) : undefined;
  }

  /** Failed attempts live outside the rolled-back transaction that produced them. */
  async recordAdminFailure(input: {
    actorAccountId?: string;
    targetAccountId?: string;
    action: string;
    code?: string;
    message?: string;
    reason?: string;
    requestId?: string;
  }): Promise<void> {
    try {
      await this.ready;
      await this.driver.run(
        `INSERT INTO admin_audit_failures (at, actor_account_id, target_account_id, action, code, message, reason, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nowIso(), input.actorAccountId ?? null, input.targetAccountId ?? null, input.action,
          input.code ?? null, input.message ?? null, input.reason ?? null, input.requestId ?? null,
        ],
      );
      await this.driver.run(
        'DELETE FROM admin_audit_failures WHERE id IN (SELECT id FROM admin_audit_failures ORDER BY id DESC LIMIT -1 OFFSET ?)',
        [2_000],
      );
    } catch {
      // Diagnostics must never turn a handled management failure into a server error.
    }
  }

  async listAdminFailures(limit = 50): Promise<JsonRecord[]> {
    await this.ready;
    return (await this.driver.all<Record<string, unknown>>('SELECT * FROM admin_audit_failures ORDER BY id DESC LIMIT ?', [limit]))
      .map((row) => ({
        id: Number(row['id']), at: String(row['at']), actorAccountId: row['actor_account_id'] ?? null,
        targetAccountId: row['target_account_id'] ?? null, action: String(row['action']),
        code: row['code'] ?? null, message: row['message'] ?? null, reason: row['reason'] ?? null,
        requestId: row['request_id'] ?? null,
      }));
  }

  /**
   * Claims an idempotency key before the work starts, so two concurrent requests with the
   * same key cannot both perform it. The row keeps the requesting operator and stays
   * `in-progress` until the result is committed: a caller that arrives after a crash in
   * that window is told to verify the outcome instead of silently repeating the work.
   */
  async claimIdempotency(key: string, fingerprint: string, actorAccountId: string, ttlMs = 24 * 60 * 60 * 1000): Promise<
    | { state: 'claimed' }
    | { state: 'replay'; status: number; body: JsonRecord }
    | { state: 'mismatch' }
    | { state: 'actor-mismatch' }
    | { state: 'in-progress' }
  > {
    await this.ready;
    const at = new Date();
    const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
    return this.driver.transaction(async (driver) => {
      const insert = await driver.run(
        `INSERT INTO admin_idempotency (idempotency_key, fingerprint, status, body_json, created_at, expires_at, actor_account_id, state)
         VALUES (?, ?, 0, '{}', ?, ?, ?, 'in-progress')
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [key, fingerprint, at.toISOString(), expiresAt, actorAccountId],
      );
      if (Number(insert.changes ?? 0) === 1) return { state: 'claimed' };
      const existing = await driver.get<Record<string, unknown>>('SELECT * FROM admin_idempotency WHERE idempotency_key = ?', [key]);
      if (!existing) return { state: 'claimed' };
      if (String(existing['expires_at']) <= at.toISOString()) {
        // An expired record never blocks a fresh attempt.
        await driver.run('DELETE FROM admin_idempotency WHERE idempotency_key = ?', [key]);
        await driver.run(
          `INSERT INTO admin_idempotency (idempotency_key, fingerprint, status, body_json, created_at, expires_at, actor_account_id, state)
           VALUES (?, ?, 0, '{}', ?, ?, ?, 'in-progress')`,
          [key, fingerprint, at.toISOString(), expiresAt, actorAccountId],
        );
        return { state: 'claimed' };
      }
      if (String(existing['fingerprint']) !== fingerprint) return { state: 'mismatch' };
      // The record belongs to whoever claimed it: another operator reusing the key gets told
      // instead of being handed someone else's recorded result.
      if (String(existing['actor_account_id'] ?? '') !== '' && String(existing['actor_account_id']) !== actorAccountId) return { state: 'actor-mismatch' };
      if (String(existing['state'] ?? '') !== 'complete') return { state: 'in-progress' };
      return { state: 'replay', status: Number(existing['status']), body: jsonObject(existing['body_json']) };
    });
  }

  async completeIdempotency(key: string, status: number, body: JsonRecord): Promise<void> {
    await this.ready;
    const at = new Date();
    await this.driver.run(
      "UPDATE admin_idempotency SET status = ?, body_json = ?, state = 'complete' WHERE idempotency_key = ?",
      [status, JSON.stringify(body), key],
    );
    await this.driver.run('DELETE FROM admin_idempotency WHERE expires_at <= ?', [at.toISOString()]);
  }

  /** Releases a claim whose work failed before it produced a result, so a retry can proceed. */
  async releaseIdempotency(key: string): Promise<void> {
    await this.ready;
    await this.driver.run("DELETE FROM admin_idempotency WHERE idempotency_key = ? AND state <> 'complete'", [key]);
  }

  /** Persists resumable progress on a running job; a finished job is never overwritten. */
  async checkpointJob(jobId: string, checkpoint: JsonRecord): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const row = await driver.get<{ result_json: string | null; status: string }>(
        'SELECT result_json, status FROM admin_jobs WHERE job_id = ?',
        [jobId],
      );
      if (!row || String(row.status) !== 'running') return;
      const merged = { ...jsonObject(row.result_json), ...checkpoint };
      await driver.run('UPDATE admin_jobs SET result_json = ? WHERE job_id = ? AND status = \'running\'', [JSON.stringify(merged), jobId]);
    });
  }

  async upsertBackupRecord(record: ServerBackupRecord): Promise<void> {
    await this.ready;
    await this.driver.run(
      `INSERT INTO server_backup_records
       (record_id, kind, status, created_at, finished_at, output_path, server_id, file_count, total_bytes,
        verified_at, verification_json, drill_json, error_message, note, created_by,
        retention_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(record_id) DO UPDATE SET
         kind = excluded.kind, status = excluded.status, finished_at = excluded.finished_at,
         output_path = excluded.output_path, server_id = excluded.server_id, file_count = excluded.file_count,
         total_bytes = excluded.total_bytes, verified_at = excluded.verified_at,
         verification_json = excluded.verification_json, drill_json = excluded.drill_json,
         retention_json = excluded.retention_json,
         error_message = excluded.error_message, note = excluded.note`,
      [
        record.recordId, record.kind, record.status, record.createdAt, record.finishedAt ?? null,
        record.outputPath ?? null, record.serverId ?? null, record.fileCount ?? null, record.totalBytes ?? null,
        record.verifiedAt ?? null,
        record.verification === undefined ? null : JSON.stringify(record.verification),
        record.drill === undefined ? null : JSON.stringify(record.drill),
        record.errorMessage ?? null, record.note ?? null, record.createdBy ?? null,
        record.retention === undefined ? null : JSON.stringify(record.retention),
      ],
    );
  }

  async getBackupRecord(recordId: string): Promise<ServerBackupRecord | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM server_backup_records WHERE record_id = ?', [recordId]);
    return row ? this.mapBackupRecord(row) : undefined;
  }

  async listBackupRecords(limit = 50): Promise<ServerBackupRecord[]> {
    await this.ready;
    return (await this.driver.all<Record<string, unknown>>(
      'SELECT * FROM server_backup_records ORDER BY created_at DESC LIMIT ?',
      [Math.max(1, Math.min(200, limit))],
    )).map((row) => this.mapBackupRecord(row));
  }

  private mapBackupRecord(row: Record<string, unknown>): ServerBackupRecord {
    const kind = String(row['kind']);
    const status = String(row['status']);
    return {
      recordId: String(row['record_id']),
      kind: (['manual', 'scheduled', 'drill'].includes(kind) ? kind : 'manual') as ServerBackupRecord['kind'],
      status: (['completed', 'failed', 'planned'].includes(status) ? status : 'failed') as ServerBackupRecord['status'],
      createdAt: String(row['created_at']),
      ...(row['finished_at'] == null ? {} : { finishedAt: String(row['finished_at']) }),
      ...(row['output_path'] == null ? {} : { outputPath: String(row['output_path']) }),
      ...(row['server_id'] == null ? {} : { serverId: String(row['server_id']) }),
      ...(row['file_count'] == null ? {} : { fileCount: Number(row['file_count']) }),
      ...(row['total_bytes'] == null ? {} : { totalBytes: Number(row['total_bytes']) }),
      ...(row['verified_at'] == null ? {} : { verifiedAt: String(row['verified_at']) }),
      ...(row['verification_json'] == null ? {} : { verification: jsonObject(row['verification_json']) }),
      ...(row['drill_json'] == null ? {} : { drill: jsonObject(row['drill_json']) }),
      ...(row['retention_json'] == null ? {} : { retention: jsonObject(row['retention_json']) }),
      ...(row['error_message'] == null ? {} : { errorMessage: String(row['error_message']) }),
      ...(row['note'] == null ? {} : { note: String(row['note']) }),
      ...(row['created_by'] == null ? {} : { createdBy: String(row['created_by']) }),
    };
  }

  async close(): Promise<void> {    const initialized = await this.ready.then(() => true, () => false);
    if (initialized) await this.checkpoint().catch(() => undefined);
    await this.driver.close();
  }
}
