import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqlDriver } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { applyLedgerControlEvent, assertAccountEncryptionKeyEnvelope, assertLedgerMemberKeyEnvelope, canonicalJson,
  ledgerControlEventHash, type AccountEncryptionKeyEnvelope, type LedgerControlEvent,
  type LedgerControlState, type LedgerMemberIdentity, type LedgerMemberKeyEnvelope } from '@zichan/core';
import { cursorValue, readCursor, resolveSort, type ResolvedSort, type SortOption } from './list-sort.js';
import { MAINTENANCE_KEY } from './maintenance-mode.js';
import { verifyFederatedCredential, type FederatedCredentialBundle } from './federated-credential.js';

/**
 * Sortable columns of the account list.
 *
 * Every expression is NULL-safe on purpose: SQLite puts NULLs first in ASC and last in DESC, and
 * `col > NULL` is NULL rather than true, so a page whose last row had a NULL value would stop
 * paging without any error. Coalescing gives every row a total position instead.
 *
 * Aggregates are not allowed here: the cursor comparison is a WHERE fragment, and an aggregate
 * cannot appear there. `usage` is therefore a correlated subquery rather than SUM(...).
 *
 * Timestamps are compared in the format they are stored in. `expires_at` is an ISO string with a
 * `T` separator, and `T` (0x54) sorts after the space (0x20) in `datetime('now')`, so the two are
 * not interchangeable: on the same calendar day, an instant that has already passed compares as
 * still ahead of `now`. `strftime` produces the stored format instead.
 */
/** Sortable columns of the session list. `name` is the account, not the device. */
export const SESSION_SORT_OPTIONS: Record<string, SortOption> = {
  lastSeen: { expr: 's.last_seen_at', tiebreaker: 's.session_id', column: 'last_seen_at' },
  created: { expr: 's.created_at', tiebreaker: 's.session_id', column: 'created_at' },
  expires: { expr: 's.expires_at', tiebreaker: 's.session_id', column: 'expires_at' },
  name: { expr: 's.username COLLATE NOCASE', tiebreaker: 's.session_id', column: 'username' },
  device: { expr: 's.device_name COLLATE NOCASE', tiebreaker: 's.session_id', column: 'device_name' },
};

/** Sortable columns of the run log. */
export const LOG_SORT_OPTIONS: Record<string, SortOption> = {
  at: { expr: 'at', tiebreaker: 'id', column: 'at' },
  level: { expr: 'level', tiebreaker: 'id', column: 'level' },
  action: { expr: 'action COLLATE NOCASE', tiebreaker: 'id', column: 'action' },
  username: { expr: "COALESCE(username, '') COLLATE NOCASE", tiebreaker: 'id', column: 'username' },
};

/** Sortable columns of the task list. */
export const JOB_SORT_OPTIONS: Record<string, SortOption> = {
  created: { expr: 'created_at', tiebreaker: 'job_id', column: 'created_at' },
  status: { expr: 'status', tiebreaker: 'job_id', column: 'status' },
  type: { expr: 'type', tiebreaker: 'job_id', column: 'type' },
};

/** Sortable columns of the sync diagnostic list. */
export const SYNC_EVENT_SORT_OPTIONS: Record<string, SortOption> = {
  at: { expr: 'at', tiebreaker: 'id', column: 'at' },
  account: { expr: "COALESCE(username, '') COLLATE NOCASE", tiebreaker: 'id', column: 'username' },
  device: { expr: "COALESCE(device_name, '') COLLATE NOCASE", tiebreaker: 'id', column: 'device_name' },
  operation: { expr: 'operation COLLATE NOCASE', tiebreaker: 'id', column: 'operation' },
  duration: { expr: 'COALESCE(duration_ms, -1)', tiebreaker: 'id', numeric: true, column: 'duration_ms' },
  commits: { expr: 'COALESCE(commit_count, -1)', tiebreaker: 'id', numeric: true, column: 'commit_count' },
};

/** Sortable columns of the backup record list. */
export const BACKUP_SORT_OPTIONS: Record<string, SortOption> = {
  created: { expr: 'created_at', tiebreaker: 'record_id', column: 'created_at' },
  status: { expr: 'status', tiebreaker: 'record_id', column: 'status' },
  kind: { expr: 'kind', tiebreaker: 'record_id', column: 'kind' },
  files: { expr: 'COALESCE(file_count, -1)', tiebreaker: 'record_id', numeric: true, column: 'file_count' },
  size: { expr: 'COALESCE(total_bytes, -1)', tiebreaker: 'record_id', numeric: true, column: 'total_bytes' },
};

/**
 * Sortable columns of the management audit.
 *
 * Ordered by `at` rather than `id`: the page shows a time, and sorting by a surrogate key that
 * merely happens to agree with it would look right until two entries share a timestamp. `id` is
 * the tiebreaker, so the ordering is still total.
 */
export const AUDIT_SORT_OPTIONS: Record<string, SortOption> = {
  at: { expr: 'at', tiebreaker: 'id', column: 'at' },
  action: { expr: 'action COLLATE NOCASE', tiebreaker: 'id', column: 'action' },
  actor: { expr: 'actor_account_id COLLATE NOCASE', tiebreaker: 'id', column: 'actor_account_id' },
  target: { expr: "COALESCE(target_account_id, '') COLLATE NOCASE", tiebreaker: 'id', column: 'target_account_id' },
};

/**
 * Sortable columns of the invitation list.
 *
 * The invitation code itself is deliberately not sortable. The cursor carries the sort value, and
 * this list's cursor is numeric for a reason: a pagination URL ends up in browser history, in
 * referrer headers and in whatever the operator pastes into a chat. Sorting by code would put a
 * live single-use credential there. `created`, `expires` and `state` all answer the questions an
 * operator actually has ("what did we hand out, what is about to lapse, what is still usable"),
 * and none of them is a secret.
 *
 * `expires_at` lives in the policy table, so the ordering joins it in. `state` reuses the very
 * expression the filter uses, so the two cannot disagree about what "available" means.
 */
export const INVITE_STATE_SQL = `CASE WHEN i.used_by IS NOT NULL THEN 'used'
  WHEN i.disabled = 1 THEN 'revoked'
  WHEN p.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 'expired' ELSE 'available' END`;

export const INVITE_SORT_OPTIONS: Record<string, SortOption> = {
  created: { expr: 'i.created_at', tiebreaker: 'i.rowid', column: 'created_at' },
  expires: { expr: "COALESCE(p.expires_at, '')", tiebreaker: 'i.rowid', column: 'expires_at' },
  state: { expr: INVITE_STATE_SQL, tiebreaker: 'i.rowid', column: 'invite_state' },
};

export const USER_SORT_OPTIONS: Record<string, SortOption> = {
  created: { expr: 'u.created_at', tiebreaker: 'u.username', column: 'created_at' },
  name: { expr: 'u.username COLLATE NOCASE', tiebreaker: 'u.username', column: 'username' },
  lastLogin: { expr: "COALESCE(u.last_login_at, '')", tiebreaker: 'u.username', column: 'last_login_at' },
  lastSync: { expr: "COALESCE((SELECT MAX(e.at) FROM sync_events e WHERE e.username = u.username AND e.outcome = 'ok'), '')", tiebreaker: 'u.username', column: 'last_sync_at' },
  devices: { expr: "(SELECT COUNT(*) FROM sync_sessions s WHERE s.username = u.username AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))", tiebreaker: 'u.username', numeric: true, column: 'active_device_count' },
  usage: { expr: 'COALESCE((SELECT SUM(c.cipher_bytes) FROM ledger_replica_commits c JOIN sync_replicas primary_replica ON primary_replica.replica_id = c.replica_id WHERE primary_replica.username = u.username), 0)', tiebreaker: 'u.username', numeric: true, column: 'commit_bytes' },
};

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
  mode: 'managed' | 'relay';
  version: number;
  sealedSecret: string | null;
}

export interface SyncUser {
  accountId: string;
  username: string;
  displayName: string;
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
  /** Selected ledger slot for this node-local session. Admin sessions have none. */
  replicaId?: string;
  /** Incremented only when this session explicitly switches ledgers. */
  selectionVersion: number;
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
  /** Zero means a commit persisted before signed member control was enabled. */
  keyEpoch?: number;
  writer?: LedgerMemberIdentity;
  cipherBytes: number;
  createdAt: string;
  /** Historical ciphertext suppressed by a signed owner decision. */
  quarantined?: boolean;
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
  /** Reading a user's decrypted ledger is a management act and is recorded as one. */
  | { action: 'ledger-preview-open'; accountId: string; previewId: string }
  | { action: 'mfa-disable'; accountId: string }
  | { action: 'mfa-recovery-codes'; accountId: string }
  | { action: 'alert-unsilence'; key: string }
  /**
   * Maintenance windows are audited like any other management act: "who took sync down, and when"
   * is exactly the question the audit trail exists to answer.
   */
  | { action: 'maintenance-on'; until: string | null; message: string }
  | { action: 'maintenance-off' };

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
  | 'database.analyze'
  | 'blobs.verify'
  | 'storage.cleanup'
  | 'logs.prune'
  | 'metrics.prune'
  | 'audit.prune'
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
  /**
   * What the client said it was. Self-reported, so it is diagnostic evidence, not proof:
   * it answers "is this an old build" without the server having to trust it for anything.
   * All three are absent for clients that send no client header at all.
   */
  clientKind?: string;
  clientVersion?: string;
  protocolVersion?: string;
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
  /**
   * Resource readings are point-in-time values, not counters, so the trend stores the peak
   * seen inside the bucket. Summing them the way request counters are summed would produce a
   * number that means nothing.
   */
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  cpuPercent: number;
  eventLoopMaxMs: number;
}

export interface SystemMetricSample {
  scope: 'host' | 'container';
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  networkRxBytesPerSecond: number | null;
  networkTxBytesPerSecond: number | null;
}

export interface SystemMetricBucket extends SystemMetricSample {
  bucketAt: string;
  sampledAt: string;
}

/** Point-in-time database structure readings; the expensive per-table breakdown is not here. */
export interface DatabaseStats {
  pageCount: number;
  pageSize: number;
  /** Bytes in pages SQLite has freed but not returned: what a VACUUM would reclaim. */
  freelistBytes: number;
  freelistRatio: number;
  /** Logical size of the main database file, derived from the page counters. */
  logicalBytes: number;
  journalMode: string;
  autoVacuum: string;
  synchronous: string;
  tempStore: string;
  cacheSizeKiB: number | null;
  mmapBytes: number;
  walAutocheckpointPages: number;
  journalSizeLimitBytes: number;
  busyTimeoutMs: number;
  encoding: string;
  /** Rows SQLite considers "large" per table, from the analyzer tables. */
  analyzedTables: number;
  /** When `ANALYZE` last ran, derived from `sqlite_stat1` timestamps when available. */
  analyzedAt: string | null;
}

/** Per-table page usage from `dbstat`. Only produced on demand: it scans the whole file. */
export interface DatabaseTableUsage {
  name: string;
  kind: 'table' | 'index' | 'other';
  bytes: number;
  pages: number;
  rowCount: number | null;
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
  constructor(readonly code: string, readonly status: number, message: string,
    readonly commitId?: string) {
    super(message);
  }
}

export const CURRENT_SERVER_SCHEMA = 26;
export const CURRENT_SERVER_SCHEMA_NAME = 'fresh_replica_storage_v26';
export function supportedServerSchema(version: number, name: string): boolean {
  return version === CURRENT_SERVER_SCHEMA && name === CURRENT_SERVER_SCHEMA_NAME;
}
const DEFAULT_COMMIT_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_BLOB_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
const LOG_RETENTION = 5_000;

/** The v13 bridge retains the old commits until all account reads have moved. */
export function requiredReplicaMigrationBytes(cipherBytes: number, commitCount: number): bigint {
  if (!Number.isSafeInteger(cipherBytes) || cipherBytes < 0
    || !Number.isSafeInteger(commitCount) || commitCount < 0) {
    throw new Error('无法安全估算账本副本迁移空间，已停止启动');
  }
  if (!commitCount) return 0n;
  // Allow for the second copy, its indexes, page overhead and WAL activity.
  return 2n * (BigInt(cipherBytes) + BigInt(commitCount) * 512n) + 64n * 1024n * 1024n;
}

export interface LedgerReplacementCheckpoint {
  checkpointId: string;
  ledgerId: string;
  replicaId: string;
  streamEpoch: string;
  headSeq: number;
  createdAt: string;
  restoredAt?: string;
}

/** Stable across nodes even when a client encrypts the same commit more than once. */
async function commitCatalogDigest(driver: SqlDriver, replicaId: string): Promise<{ count: number; digest: string }> {
  const hash = createHash('sha256');
  let after = '';
  let count = 0;
  while (true) {
    const rows = await driver.all<Record<string, unknown>>(`SELECT commit_row.commit_id,
      commit_row.ledger_id, commit_row.content_hash, commit_row.key_epoch,
      commit_row.writer_issuer_node_id, commit_row.writer_account_id
      FROM ledger_replica_commits commit_row LEFT JOIN ledger_control_resolutions resolution
        ON resolution.replica_id = commit_row.replica_id
          AND resolution.rejected_commit_id = commit_row.commit_id
          AND resolution.rejected_content_hash = commit_row.content_hash
      WHERE commit_row.replica_id = ? AND commit_row.commit_id > ?
        AND resolution.rejected_commit_id IS NULL ORDER BY commit_row.commit_id LIMIT 500`, [replicaId, after]);
    for (const row of rows) {
      hash.update(JSON.stringify([row['commit_id'], row['ledger_id'], row['content_hash'],
        row['key_epoch'], row['writer_issuer_node_id'], row['writer_account_id']]));
      hash.update('\n');
      after = String(row['commit_id']);
      count += 1;
    }
    if (rows.length < 500) break;
  }
  return { count, digest: hash.digest('hex') };
}

function unlimitedQuotaRole(role: unknown): boolean {
  return role === 'owner' || role === 'admin';
}

export interface NodeReplicationGrant {
  grantId: string;
  username: string;
  ledgerId: string;
  peerNodeId: string;
  peerPublicKey: string;
  createdAt: string;
  expiresAt: string;
  renewable: boolean;
  revokedAt?: string;
}

export interface NodeReplicationLink {
  linkId: string;
  username: string;
  ledgerId: string;
  localStreamEpoch: string;
  peerUrl: string;
  peerNodeId: string;
  peerPublicKey: string;
  peerReplicaId: string;
  peerStreamEpoch: string;
  grantId: string;
  pullSeq: number;
  pushSeq: number;
  pullBlobCursor: string;
  pushBlobCursor: string;
  pullStateCursor: string;
  pushStateCursor: string;
  pullMemberCursor: string;
  pushMemberCursor: string;
  memberEpoch: number;
  peerHeadSeq: number;
  localHeadSeq: number;
  peerBlobObjects: number;
  localBlobObjects: number;
  peerBlobBytes: number;
  localBlobBytes: number;
  pullBlobScannedBytes: number;
  pushBlobScannedBytes: number;
  pullBlobTransferredBytes: number;
  pushBlobTransferredBytes: number;
  peerLegacyObjects: number;
  localLegacyObjects: number;
  peerTombstones: number;
  localTombstones: number;
  pullBlobSweepAt?: string;
  pushBlobSweepAt?: string;
  pullStateSweepAt?: string;
  pushStateSweepAt?: string;
  inventoryMatchedAt?: string;
  inventoryIssue?: string;
  inventoryBlobHash?: string;
  physicalBlobHash?: string;
  physicalVerifiedAt?: string;
  physicalScannedAt?: string;
  physicalIssue?: string;
  lastSuccessAt?: string;
  lastError?: string;
  syncRounds: number;
  convergedRounds: number;
  partialRounds: number;
  failedRounds: number;
  lastRoundDurationMs: number;
  enabled: boolean;
  revocationPending: boolean;
  remoteRevokedAt?: string;
  revocationError?: string;
  lifecycleState: 'JOINING' | 'BOOTSTRAPPING' | 'CATCHING_UP' | 'VERIFYING' | 'READY'
    | 'REVOKING' | 'REVOKED' | 'STOPPED';
  lifecycleCheckedAt?: string;
}

export interface NodeGroupMemberReport {
  peerNodeId: string;
  peerPublicKey: string;
  joinedAt: string;
  grantId?: string;
  identityConflict?: boolean;
  report?: JsonRecord;
  receivedAt?: string;
}

export interface ServerSyncGroup {
  groupId: string;
  mainNodeId: string;
  mainPublicKey: string;
  mainUrl: string;
  role: 'main' | 'member';
  createdAt: string;
}

export interface ServerSyncGroupMember {
  nodeId: string;
  publicKey: string;
  nodeUrl: string;
  joinedAt: string;
}

export interface ReplicaGroupMember {
  nodeId: string;
  publicKey: string;
  joinedAt: string;
  retiredAt?: string;
}

export interface AccountEncryptionKeyRecord {
  issuerNodeId: string;
  subjectAccountId: string;
  publicKey: string;
  envelope: JsonRecord;
  revision: number;
  updatedAt: string;
}

export interface LedgerControlRoot extends LedgerMemberIdentity {
  signingPublicKey: string;
}

export interface LedgerControlPage {
  root: LedgerControlRoot | null;
  events: LedgerControlEvent[];
  headSeq: number;
  headHash: string | null;
  nextSeq: number;
  hasMore: boolean;
}

export interface LedgerMemberEnvelopePage {
  keyEpoch: number;
  envelopes: LedgerMemberKeyEnvelope[];
  nextCursor: string;
  hasMore: boolean;
}

export interface NodeReplicaInventory {
  serverId: string;
  replicaId: string;
  streamEpoch: string;
  ledgerId: string;
  issuerNodeId: string;
  subjectAccountId: string;
  accountKeyHash: string;
  keyringId: string;
  keyGeneration: number;
  keyEnvelopeHash: string;
  controlSeq: number;
  controlHash: string;
  keyEpoch: number;
  memberEnvelopeCount: number;
  memberEnvelopeHash: string;
  missingMemberEnvelopeCount: number;
  memberAccountKeyCount: number;
  memberAccountKeyHash: string;
  missingMemberAccountKeyCount: number;
  memberAccountCount: number;
  missingMemberAccountCount: number;
  requirementsHash: string;
  commitCount: number;
  commitHash: string;
  commitStreamComplete: number;
  attachmentPromisePresent: number;
  attachmentPromiseCurrent: number;
  promisedBlobCount: number;
  promisedBlobHash: string;
  missingPromisedBlobCount: number;
  rejectedCommitCount: number;
  blobCount: number;
  blobHash: string;
  tombstoneCount: number;
  stateHash: string;
  legacyBlobCount: number;
}

export interface AttachmentPromiseCatalog {
  commitCount: number;
  commitHash: string;
  blobCount: number;
  blobHash: string;
  publishedAt: string;
}

export interface AttachmentPromiseUpload {
  uploadId: string;
  commitCount: number;
  commitHash: string;
  expectedCount: number;
  receivedCount: number;
  lastBlobId: string;
  expiresAt: string;
}

export interface ReplicaPhysicalStatus {
  blobHash?: string;
  verifiedAt?: string;
  scannedAt?: string;
  issue?: string;
}

/** A federated replica account has no local password; only an issuer assertion can create its session. */
export const FEDERATED_ONLY_RECORD = '!federated-only!';

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
    displayName: typeof row['display_name'] === 'string' && row['display_name'].trim() ? String(row['display_name']) : String(row['username']),
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
    ...(row['replica_id'] == null ? {} : { replicaId: String(row['replica_id']) }),
    selectionVersion: Number(row['selection_version'] ?? 0),
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
    const existingTables = (await this.driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )).map((row) => row.name);
    const hasServerSchema = existingTables.includes('server_schema_migrations');
    if (existingTables.length && !hasServerSchema) {
      const emptyBlobTables = new Set(['blob_objects', 'blob_replica_states',
        'blob_uploads', 'blob_user_quotas', 'blob_upload_chunks']);
      if (existingTables.some((table) => !emptyBlobTables.has(table))) {
        throw new Error('同步服务器数据库不是当前全新部署结构，请使用空数据目录重新部署');
      }
      for (const table of existingTables) {
        const count = await this.driver.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
        if (Number(count?.count ?? 0) > 0) {
          throw new Error('同步服务器数据库已有旧数据，请使用空数据目录重新部署');
        }
      }
    }
    if (hasServerSchema) {
      const marker = await this.driver.all<{ version: number; name: string }>(
        'SELECT version, name FROM server_schema_migrations',
      );
      if (marker.length !== 1 || marker[0]?.version !== CURRENT_SERVER_SCHEMA
        || marker[0]?.name !== CURRENT_SERVER_SCHEMA_NAME) {
        throw new Error('同步服务器数据库版本不匹配；开发期不升级旧库，请使用空数据目录重新部署');
      }
    }
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
  display_name TEXT,
  opaque_registration_record TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS server_sync_group (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  group_id TEXT NOT NULL,
  main_node_id TEXT NOT NULL,
  main_public_key TEXT NOT NULL,
  main_url TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('main', 'member')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS server_sync_group_members (
  group_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  node_url TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, node_id)
);
CREATE TABLE IF NOT EXISTS server_sync_group_join_tokens (
  token_hash TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS server_sync_group_nonces (
  group_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (group_id, node_id, nonce)
);
CREATE TABLE IF NOT EXISTS server_sync_group_progress (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS server_sync_group_account_exports (
  account_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  exported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_user_opaque_setups (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  server_setup TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_opaque_registration_setups (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  server_setup TEXT NOT NULL,
  expires_at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS federated_account_bindings (
  local_username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  issuer_node_id TEXT NOT NULL,
  subject_account_id TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  UNIQUE (issuer_node_id, subject_account_id)
);
CREATE TABLE IF NOT EXISTS federated_password_credentials (
  local_username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  source_username TEXT NOT NULL COLLATE NOCASE,
  issuer_node_id TEXT NOT NULL,
  subject_account_id TEXT NOT NULL,
  registration_record TEXT NOT NULL,
  server_setup TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  source_revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (source_username)
);
CREATE TABLE IF NOT EXISTS relayed_account_credentials (
  ledger_id TEXT NOT NULL,
  issuer_node_id TEXT NOT NULL,
  subject_account_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  bundle_json TEXT NOT NULL,
  issuer_signature TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ledger_id, issuer_node_id, subject_account_id)
);
CREATE TABLE IF NOT EXISTS account_directory_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id TEXT NOT NULL,
  issuer_node_id TEXT NOT NULL,
  subject_account_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_directory_log_ledger_seq ON account_directory_log(ledger_id, seq);
CREATE TABLE IF NOT EXISTS node_directory_cursors (
  link_id TEXT PRIMARY KEY REFERENCES node_replication_links(link_id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS native_directory_exports (
  ledger_id TEXT NOT NULL,
  subject_account_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, subject_account_id)
);
CREATE TABLE IF NOT EXISTS node_credential_exports (
  link_id TEXT NOT NULL REFERENCES node_replication_links(link_id) ON DELETE CASCADE,
  subject_account_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  exported_at TEXT NOT NULL,
  PRIMARY KEY (link_id, subject_account_id)
);
CREATE TABLE IF NOT EXISTS account_transfer_counters (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  commit_push_requests INTEGER NOT NULL DEFAULT 0,
  commit_pull_requests INTEGER NOT NULL DEFAULT 0,
  commit_upload_bytes INTEGER NOT NULL DEFAULT 0,
  commit_download_bytes INTEGER NOT NULL DEFAULT 0,
  blob_upload_bytes INTEGER NOT NULL DEFAULT 0,
  blob_download_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sync_runs (
  run_id TEXT NOT NULL,
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  replica_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('converged', 'partial', 'failed')),
  pulled INTEGER NOT NULL,
  pushed INTEGER NOT NULL,
  attachment_uploads INTEGER NOT NULL,
  attachment_downloads INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  finished_at TEXT NOT NULL,
  PRIMARY KEY (username, run_id)
);
CREATE TABLE IF NOT EXISTS joined_group_registration_policy (
  source_node_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('open', 'invite', 'closed')),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_sync_runs_user_at ON account_sync_runs(username, finished_at);
CREATE TABLE IF NOT EXISTS account_encryption_keys (
  issuer_node_id TEXT NOT NULL,
  subject_account_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (issuer_node_id, subject_account_id)
);
CREATE TABLE IF NOT EXISTS federated_login_intents (
  state_hash TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES node_replication_links(link_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_federated_login_intents_expiry ON federated_login_intents (expires_at);
CREATE TABLE IF NOT EXISTS federated_login_codes (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES node_replication_grants(grant_id) ON DELETE CASCADE,
  username TEXT NOT NULL COLLATE NOCASE,
  subject_account_id TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_federated_login_codes_expiry ON federated_login_codes (expires_at);
CREATE TABLE IF NOT EXISTS server_administrators (
  read_only INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS account_password_email_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES sync_account_identities(account_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  issued_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_password_email_limits (
  account_id TEXT PRIMARY KEY REFERENCES sync_account_identities(account_id) ON DELETE CASCADE,
  window_started_at TEXT NOT NULL,
  window_count INTEGER NOT NULL,
  last_requested_at TEXT NOT NULL
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
  replica_id TEXT,
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
  kind TEXT NOT NULL DEFAULT 'ledger',
  selection_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sync_sessions_user ON sync_sessions (username, revoked_at, expires_at);
CREATE TABLE IF NOT EXISTS server_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  scope TEXT,
  source TEXT
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
-- Migration bridge: storage is still account-partitioned, but the replica
-- identity and sequence now have their own ledger slot. Legacy accounts route
-- to a slot without merging distinct histories that share a ledger ID.
CREATE TABLE IF NOT EXISTS ledger_replica_slots (
  replica_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  stream_epoch TEXT NOT NULL,
  head_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_replica_slots_ledger ON ledger_replica_slots (ledger_id);
CREATE TABLE IF NOT EXISTS ledger_account_routes (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  replica_id TEXT NOT NULL REFERENCES ledger_replica_slots(replica_id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_account_routes_slot ON ledger_account_routes (replica_id);
-- Derived from the signed member chain. A legacy slot without a chain keeps
-- its original account route until the ledger has initialized membership.
CREATE TABLE IF NOT EXISTS account_ledger_index (
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  replica_id TEXT NOT NULL REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (username, replica_id)
);
CREATE INDEX IF NOT EXISTS idx_account_ledger_index_slot ON account_ledger_index (replica_id);
CREATE TRIGGER IF NOT EXISTS sync_replicas_slot_insert AFTER INSERT ON sync_replicas BEGIN
  INSERT INTO ledger_replica_slots (replica_id, ledger_id, stream_epoch, head_seq, created_at, updated_at)
    VALUES (NEW.replica_id, NEW.ledger_id, NEW.stream_epoch, NEW.head_seq, NEW.created_at, NEW.updated_at)
    ON CONFLICT(replica_id) DO UPDATE SET ledger_id = excluded.ledger_id,
      stream_epoch = excluded.stream_epoch, head_seq = excluded.head_seq, updated_at = excluded.updated_at;
  INSERT INTO ledger_account_routes (username, replica_id, created_at)
    VALUES (NEW.username, NEW.replica_id, NEW.created_at)
    ON CONFLICT(username) DO UPDATE SET replica_id = excluded.replica_id;
END;
CREATE TRIGGER IF NOT EXISTS sync_replicas_slot_update AFTER UPDATE ON sync_replicas BEGIN
  INSERT INTO ledger_replica_slots (replica_id, ledger_id, stream_epoch, head_seq, created_at, updated_at)
    VALUES (NEW.replica_id, NEW.ledger_id, NEW.stream_epoch, NEW.head_seq, NEW.created_at, NEW.updated_at)
    ON CONFLICT(replica_id) DO UPDATE SET ledger_id = excluded.ledger_id,
      stream_epoch = excluded.stream_epoch, head_seq = excluded.head_seq, updated_at = excluded.updated_at;
  INSERT INTO ledger_account_routes (username, replica_id, created_at)
    VALUES (NEW.username, NEW.replica_id, NEW.created_at)
    ON CONFLICT(username) DO UPDATE SET replica_id = excluded.replica_id;
  DELETE FROM ledger_account_routes WHERE username = OLD.username AND OLD.username <> NEW.username;
  DELETE FROM ledger_replica_slots WHERE replica_id = OLD.replica_id AND OLD.replica_id <> NEW.replica_id
    AND NOT EXISTS (SELECT 1 FROM ledger_account_routes WHERE replica_id = OLD.replica_id);
END;
CREATE TRIGGER IF NOT EXISTS sync_replicas_slot_delete AFTER DELETE ON sync_replicas BEGIN
  DELETE FROM ledger_account_routes WHERE username = OLD.username;
  DELETE FROM ledger_replica_slots WHERE replica_id = OLD.replica_id
    AND NOT EXISTS (SELECT 1 FROM ledger_account_routes WHERE replica_id = OLD.replica_id);
END;
CREATE TABLE IF NOT EXISTS node_replication_grants (
  grant_id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  ledger_id TEXT NOT NULL,
  peer_node_id TEXT NOT NULL,
  peer_public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  renewable INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_node_replication_grants_user ON node_replication_grants (username, ledger_id, revoked_at);
CREATE TABLE IF NOT EXISTS node_replication_nonces (
  grant_id TEXT NOT NULL REFERENCES node_replication_grants(grant_id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (grant_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_node_replication_nonces_expiry ON node_replication_nonces (expires_at);
CREATE TABLE IF NOT EXISTS ledger_replica_group_members (
  replica_id TEXT NOT NULL REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (replica_id, node_id)
);
CREATE TABLE IF NOT EXISTS node_replica_health_reports (
  grant_id TEXT PRIMARY KEY REFERENCES node_replication_grants(grant_id) ON DELETE CASCADE,
  peer_node_id TEXT NOT NULL,
  peer_replica_id TEXT NOT NULL,
  peer_stream_epoch TEXT NOT NULL,
  source_replica_id TEXT NOT NULL,
  source_stream_epoch TEXT NOT NULL,
  report_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_replica_group_snapshots (
  link_id TEXT PRIMARY KEY REFERENCES node_replication_links(link_id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_replication_links (
  link_id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  ledger_id TEXT NOT NULL,
  local_stream_epoch TEXT NOT NULL,
  peer_url TEXT NOT NULL,
  peer_node_id TEXT NOT NULL,
  peer_public_key TEXT NOT NULL,
  peer_replica_id TEXT NOT NULL,
  peer_stream_epoch TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  pull_seq INTEGER NOT NULL DEFAULT 0,
  push_seq INTEGER NOT NULL DEFAULT 0,
  pull_blob_cursor TEXT NOT NULL DEFAULT '',
  push_blob_cursor TEXT NOT NULL DEFAULT '',
  pull_state_cursor TEXT NOT NULL DEFAULT '',
  push_state_cursor TEXT NOT NULL DEFAULT '',
  pull_member_cursor TEXT NOT NULL DEFAULT '',
  push_member_cursor TEXT NOT NULL DEFAULT '',
  member_epoch INTEGER NOT NULL DEFAULT 0,
  peer_head_seq INTEGER NOT NULL DEFAULT 0,
  local_head_seq INTEGER NOT NULL DEFAULT 0,
  peer_blob_objects INTEGER NOT NULL DEFAULT 0,
  local_blob_objects INTEGER NOT NULL DEFAULT 0,
  peer_blob_bytes INTEGER NOT NULL DEFAULT 0,
  local_blob_bytes INTEGER NOT NULL DEFAULT 0,
  pull_blob_scanned_bytes INTEGER NOT NULL DEFAULT 0,
  push_blob_scanned_bytes INTEGER NOT NULL DEFAULT 0,
  pull_blob_transferred_bytes INTEGER NOT NULL DEFAULT 0,
  push_blob_transferred_bytes INTEGER NOT NULL DEFAULT 0,
  peer_legacy_objects INTEGER NOT NULL DEFAULT 0,
  local_legacy_objects INTEGER NOT NULL DEFAULT 0,
  peer_tombstones INTEGER NOT NULL DEFAULT 0,
  local_tombstones INTEGER NOT NULL DEFAULT 0,
  pull_blob_sweep_at TEXT,
  push_blob_sweep_at TEXT,
  pull_state_sweep_at TEXT,
  push_state_sweep_at TEXT,
  inventory_matched_at TEXT,
  inventory_issue TEXT,
  inventory_blob_hash TEXT,
  physical_blob_hash TEXT,
  physical_verified_at TEXT,
  physical_scanned_at TEXT,
  physical_issue TEXT,
  last_success_at TEXT,
  last_error TEXT,
  sync_rounds INTEGER NOT NULL DEFAULT 0,
  converged_rounds INTEGER NOT NULL DEFAULT 0,
  partial_rounds INTEGER NOT NULL DEFAULT 0,
  failed_rounds INTEGER NOT NULL DEFAULT 0,
  last_round_duration_ms INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  revocation_pending INTEGER NOT NULL DEFAULT 0,
  remote_revoked_at TEXT,
  revocation_error TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'JOINING',
  lifecycle_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (username, ledger_id, peer_node_id)
);
CREATE INDEX IF NOT EXISTS idx_node_replication_links_enabled ON node_replication_links (enabled, username);
CREATE TABLE IF NOT EXISTS replica_physical_status (
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  ledger_id TEXT NOT NULL,
  blob_hash TEXT,
  verified_at TEXT,
  scanned_at TEXT,
  issue TEXT,
  PRIMARY KEY (username, ledger_id)
);
CREATE TABLE IF NOT EXISTS ledger_replica_requirements (
  replica_id TEXT NOT NULL REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  PRIMARY KEY (replica_id, capability)
);
CREATE TABLE IF NOT EXISTS ledger_replica_blob_quotas (
  replica_id TEXT PRIMARY KEY REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  quota_bytes INTEGER NOT NULL CHECK (quota_bytes >= 1048576),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_replica_commits (
  replica_id TEXT NOT NULL REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  commit_id TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  enc_commit_json TEXT NOT NULL,
  key_epoch INTEGER NOT NULL DEFAULT 0,
  writer_issuer_node_id TEXT,
  writer_account_id TEXT,
  cipher_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (replica_id, seq),
  UNIQUE (replica_id, commit_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_replica_commits_cursor ON ledger_replica_commits (replica_id, seq);
CREATE TABLE IF NOT EXISTS ledger_attachment_promises (
  replica_id TEXT PRIMARY KEY REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  commit_count INTEGER NOT NULL CHECK (commit_count >= 0),
  commit_hash TEXT NOT NULL,
  blob_count INTEGER NOT NULL CHECK (blob_count >= 0),
  blob_hash TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_attachment_promise_items (
  replica_id TEXT NOT NULL REFERENCES ledger_attachment_promises(replica_id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL,
  PRIMARY KEY (replica_id, blob_id)
);
CREATE TABLE IF NOT EXISTS ledger_attachment_promise_uploads (
  upload_id TEXT PRIMARY KEY,
  replica_id TEXT NOT NULL REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  source_node_id TEXT,
  commit_count INTEGER NOT NULL,
  commit_hash TEXT NOT NULL,
  expected_count INTEGER NOT NULL,
  expected_blob_hash TEXT,
  received_count INTEGER NOT NULL DEFAULT 0,
  last_blob_id TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachment_promise_uploads_expiry ON ledger_attachment_promise_uploads (expires_at);
CREATE INDEX IF NOT EXISTS idx_attachment_promise_uploads_source ON ledger_attachment_promise_uploads
  (replica_id, source_node_id, commit_hash, expected_blob_hash);
CREATE TABLE IF NOT EXISTS ledger_attachment_promise_upload_items (
  upload_id TEXT NOT NULL REFERENCES ledger_attachment_promise_uploads(upload_id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL,
  PRIMARY KEY (upload_id, blob_id)
);
CREATE TABLE IF NOT EXISTS ledger_replica_rejected_commits (
  replica_id TEXT NOT NULL REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  peer_node_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  key_epoch INTEGER NOT NULL,
  writer_issuer_node_id TEXT,
  writer_account_id TEXT,
  reason TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (replica_id, peer_node_id, commit_id)
);
CREATE TABLE IF NOT EXISTS ledger_replica_rejected_payloads (
  replica_id TEXT NOT NULL,
  peer_node_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  enc_commit_json TEXT NOT NULL,
  cipher_bytes INTEGER NOT NULL,
  PRIMARY KEY (replica_id, peer_node_id, commit_id),
  FOREIGN KEY (replica_id, peer_node_id, commit_id)
    REFERENCES ledger_replica_rejected_commits (replica_id, peer_node_id, commit_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ledger_control_resolutions (
  replica_id TEXT NOT NULL REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  rejected_commit_id TEXT NOT NULL,
  rejected_content_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('replay', 'discard')),
  replacement_commit_id TEXT,
  replacement_content_hash TEXT,
  actor_issuer_node_id TEXT NOT NULL,
  actor_account_id TEXT NOT NULL,
  key_epoch INTEGER NOT NULL,
  event_seq INTEGER NOT NULL,
  PRIMARY KEY (replica_id, rejected_commit_id),
  FOREIGN KEY (replica_id, event_seq) REFERENCES ledger_control_events(replica_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_ledger_control_resolutions_replacement
  ON ledger_control_resolutions (replica_id, replacement_commit_id);
CREATE TABLE IF NOT EXISTS ledger_replica_key_envelopes (
  replica_id TEXT PRIMARY KEY REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  ledger_id TEXT NOT NULL,
  keyring_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_control_roots (
  replica_id TEXT PRIMARY KEY REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  issuer_node_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  signing_public_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_control_events (
  replica_id TEXT NOT NULL REFERENCES ledger_control_roots(replica_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  event_hash TEXT NOT NULL,
  event_json TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  PRIMARY KEY (replica_id, seq),
  UNIQUE (replica_id, event_hash)
);
CREATE TABLE IF NOT EXISTS ledger_member_key_envelopes (
  replica_id TEXT NOT NULL REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
  issuer_node_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  key_epoch INTEGER NOT NULL CHECK (key_epoch >= 1),
  keyring_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  envelope_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (replica_id, issuer_node_id, account_id, key_epoch)
);
CREATE INDEX IF NOT EXISTS idx_ledger_member_key_envelopes_epoch ON ledger_member_key_envelopes (replica_id, key_epoch);
CREATE TABLE IF NOT EXISTS sync_key_custody (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('managed', 'relay')),
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
CREATE TABLE IF NOT EXISTS account_email_settings (
  username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  email TEXT,
  verified_at TEXT,
  pending_email TEXT,
  pending_hash TEXT,
  pending_expires_at TEXT,
  code_sent_at TEXT,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT,
  window_count INTEGER NOT NULL DEFAULT 0,
  notify_quota INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_email_outbox (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_email_outbox_due ON account_email_outbox (state, next_attempt_at);
CREATE TABLE IF NOT EXISTS ledger_backup_archives (
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  replica_id TEXT NOT NULL REFERENCES ledger_replica_slots(replica_id) ON DELETE CASCADE,
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
  PRIMARY KEY (username, replica_id, archive_id),
  UNIQUE (username, replica_id, blob_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_backup_archives_created
  ON ledger_backup_archives (username, replica_id, deleted_at, created_at DESC);
-- A replacement keeps the previous encrypted replica addressable for explicit
-- recovery. Ciphertext is copied into this checkpoint in the same SQLite
-- transaction as the replacement.
CREATE TABLE IF NOT EXISTS ledger_replacement_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE REFERENCES sync_users(username) ON DELETE CASCADE,
  replica_id TEXT NOT NULL REFERENCES ledger_replica_slots(replica_id),
  ledger_id TEXT NOT NULL,
  stream_epoch TEXT NOT NULL,
  head_seq INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  protection_mode TEXT,
  protection_version INTEGER,
  protection_sealed_secret TEXT,
  created_at TEXT NOT NULL,
  restored_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_replacement_checkpoints_user
  ON ledger_replacement_checkpoints (username, created_at DESC);
CREATE TABLE IF NOT EXISTS ledger_replacement_checkpoint_commits (
  checkpoint_id TEXT NOT NULL REFERENCES ledger_replacement_checkpoints(checkpoint_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  commit_id TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  enc_commit_json TEXT NOT NULL,
  key_epoch INTEGER NOT NULL,
  writer_issuer_node_id TEXT,
  writer_account_id TEXT,
  cipher_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (checkpoint_id, seq),
  UNIQUE (checkpoint_id, commit_id)
);
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
  event_loop_max_ms REAL NOT NULL DEFAULT 0,
  cpu_percent REAL NOT NULL DEFAULT 0,
  external_bytes INTEGER NOT NULL DEFAULT 0,
  heap_used_bytes INTEGER NOT NULL DEFAULT 0,
  rss_bytes INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS system_metric_buckets (
  scope TEXT NOT NULL,
  granularity TEXT NOT NULL,
  bucket_at TEXT NOT NULL,
  sampled_at TEXT NOT NULL,
  cpu_percent REAL,
  memory_used_bytes INTEGER,
  memory_total_bytes INTEGER,
  disk_used_bytes INTEGER,
  disk_total_bytes INTEGER,
  disk_read_bytes_per_second REAL,
  disk_write_bytes_per_second REAL,
  network_rx_bytes_per_second REAL,
  network_tx_bytes_per_second REAL,
  PRIMARY KEY (scope, granularity, bucket_at)
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
  request_id TEXT,
  client_kind TEXT,
  client_version TEXT,
  protocol_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_events_at ON sync_events (at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_events_username ON sync_events (username, at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_events_category ON sync_events (category, at DESC);
CREATE TABLE IF NOT EXISTS server_backup_records (
  retention_json TEXT,
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
    // Rebuild the slot update trigger after checkpoint storage exists. Replacing a
    // personal ledger must not cascade-delete its attachment and backup catalogs.
    await this.driver.exec(`
DROP TRIGGER IF EXISTS sync_replicas_slot_update;
CREATE TRIGGER sync_replicas_slot_update AFTER UPDATE ON sync_replicas BEGIN
  INSERT INTO ledger_replica_slots (replica_id, ledger_id, stream_epoch, head_seq, created_at, updated_at)
    VALUES (NEW.replica_id, NEW.ledger_id, NEW.stream_epoch, NEW.head_seq, NEW.created_at, NEW.updated_at)
    ON CONFLICT(replica_id) DO UPDATE SET ledger_id = excluded.ledger_id,
      stream_epoch = excluded.stream_epoch, head_seq = excluded.head_seq, updated_at = excluded.updated_at;
  INSERT INTO ledger_account_routes (username, replica_id, created_at)
    VALUES (NEW.username, NEW.replica_id, NEW.created_at)
    ON CONFLICT(username) DO UPDATE SET replica_id = excluded.replica_id;
  DELETE FROM ledger_account_routes WHERE username = OLD.username AND OLD.username <> NEW.username;
  DELETE FROM ledger_replica_slots WHERE replica_id = OLD.replica_id AND OLD.replica_id <> NEW.replica_id
    AND NOT EXISTS (SELECT 1 FROM ledger_account_routes WHERE replica_id = OLD.replica_id)
    AND NOT EXISTS (SELECT 1 FROM ledger_replacement_checkpoints WHERE replica_id = OLD.replica_id);
END;`);
    if (!hasServerSchema) {
      await this.driver.run('INSERT INTO server_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [CURRENT_SERVER_SCHEMA, CURRENT_SERVER_SCHEMA_NAME, nowIso()]);
    }
    const slotDrift = await this.driver.get(`SELECT 1 FROM sync_replicas owner
      LEFT JOIN ledger_account_routes route ON route.username = owner.username
      LEFT JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
      WHERE route.replica_id IS NULL OR slot.replica_id IS NULL
        OR slot.replica_id <> owner.replica_id OR slot.ledger_id <> owner.ledger_id
        OR slot.stream_epoch <> owner.stream_epoch OR slot.head_seq <> owner.head_seq
      LIMIT 1`);
    if (slotDrift) throw new Error('账本副本槽位与账号绑定不一致，已停止启动');
    const envelopeDrift = await this.driver.get(`SELECT 1 FROM ledger_replica_key_envelopes envelope
      LEFT JOIN ledger_replica_slots slot ON slot.replica_id = envelope.replica_id
      WHERE slot.replica_id IS NULL OR slot.ledger_id <> envelope.ledger_id LIMIT 1`);
    if (envelopeDrift) throw new Error('账本副本密钥包与副本槽位账本不一致，已停止启动');
    const controlRoots = await this.driver.all<{ replica_id: string }>('SELECT replica_id FROM ledger_control_roots');
    for (const root of controlRoots) {
      try {
        await this.readLedgerControlState(this.driver, root.replica_id);
        await this.verifyControlResolutionIndex(this.driver, root.replica_id);
      }
      catch (error) { throw new Error(`账本成员控制链校验失败，已停止启动：${String(error)}`); }
    }
    // The index is a cache of verified membership, never an independent grant.
    await this.driver.transaction(async (driver) => {
      const slots = await driver.all<{ replica_id: string }>('SELECT replica_id FROM ledger_replica_slots');
      for (const slot of slots) await this.rebuildAccountLedgerIndex(driver, slot.replica_id);
      await driver.run(`UPDATE sync_sessions SET replica_id =
        (SELECT route.replica_id FROM ledger_account_routes route WHERE route.username = sync_sessions.username)
        WHERE replica_id IS NULL AND kind = 'ledger'`);
    });
    const at = nowIso();
    const persistedServer = await this.driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['server_id']);
    if (persistedServer && persistedServer.value !== this.serverId) throw new Error('server-id 与 SQLite 主库不匹配');
    await this.driver.run('INSERT OR IGNORE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['server_id', this.serverId, at]);
    await this.driver.run('INSERT OR IGNORE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['registration_mode', this.defaultRegistrationMode, at]);
    await this.driver.run('INSERT OR IGNORE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['registration_policy_revision', '1', at]);
  }

  async registrationMode(): Promise<RegistrationMode> {
    await this.ready;
    const owner = await this.driver.get<{ singleton: number }>('SELECT singleton FROM server_ownership WHERE singleton = 1');
    if (!owner) return 'closed';
    const group = await this.serverSyncGroup();
    if (group?.role === 'member') {
      const policy = await this.driver.get<{ mode: RegistrationMode }>(
        'SELECT mode FROM joined_group_registration_policy WHERE source_node_id = ?', [group.mainNodeId]);
      return policy?.mode ?? 'closed';
    }
    const joined = await this.driver.all<{ source_node_id: string; mode: RegistrationMode }>(`
      SELECT p.source_node_id, p.mode FROM joined_group_registration_policy p
      WHERE EXISTS (SELECT 1 FROM node_replication_links l
        JOIN federated_account_bindings f ON f.local_username = l.username AND f.ledger_id = l.ledger_id
        WHERE l.peer_node_id = p.source_node_id AND l.enabled = 1)
      ORDER BY p.source_node_id`);
    if (joined.length > 1) return 'closed';
    if (joined[0]) return joined[0].mode;
    return (await this.localRegistrationPolicy()).mode;
  }

  async serverSyncGroup(): Promise<ServerSyncGroup | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM server_sync_group WHERE singleton = 1');
    return row ? { groupId: String(row['group_id']), mainNodeId: String(row['main_node_id']),
      mainPublicKey: String(row['main_public_key']), mainUrl: String(row['main_url']),
      role: String(row['role']) as 'main' | 'member', createdAt: String(row['created_at']) } : undefined;
  }

  async serverSyncGroupMembers(): Promise<ServerSyncGroupMember[]> {
    await this.ready;
    const group = await this.serverSyncGroup();
    if (!group) return [];
    const rows = await this.driver.all<Record<string, unknown>>(`SELECT * FROM server_sync_group_members
      WHERE group_id = ? ORDER BY joined_at, node_id`, [group.groupId]);
    return rows.map((row) => ({ nodeId: String(row['node_id']), publicKey: String(row['public_key']),
      nodeUrl: String(row['node_url']), joinedAt: String(row['joined_at']) }));
  }

  async consumeServerSyncGroupNonce(groupId: string, nodeId: string, nonce: string): Promise<boolean> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      await driver.run('DELETE FROM server_sync_group_nonces WHERE expires_at <= ?', [at]);
      const member = await driver.get('SELECT 1 FROM server_sync_group_members WHERE group_id = ? AND node_id = ?',
        [groupId, nodeId]);
      if (!member || await driver.get('SELECT 1 FROM server_sync_group_nonces WHERE group_id = ? AND node_id = ? AND nonce = ?',
        [groupId, nodeId, nonce])) return false;
      await driver.run(`INSERT INTO server_sync_group_nonces (group_id, node_id, nonce, expires_at)
        VALUES (?, ?, ?, ?)`, [groupId, nodeId, nonce, new Date(Date.now() + 5 * 60_000).toISOString()]);
      return true;
    });
  }

  async serverSyncGroupProgress(): Promise<{ lastAttemptAt?: string; lastSuccessAt?: string;
    lastError?: string }> {
    await this.ready;
    const row = await this.driver.get<{ last_attempt_at: string | null;
      last_success_at: string | null; last_error: string | null }>(
      'SELECT last_attempt_at, last_success_at, last_error FROM server_sync_group_progress WHERE singleton = 1');
    return { ...(row?.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
      ...(row?.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
      ...(row?.last_error ? { lastError: row.last_error } : {}) };
  }

  async recordServerSyncGroupProgress(error?: unknown): Promise<void> {
    await this.ready;
    const at = nowIso();
    await this.driver.run(`INSERT INTO server_sync_group_progress
      (singleton, last_attempt_at, last_success_at, last_error) VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
        last_success_at = COALESCE(excluded.last_success_at, server_sync_group_progress.last_success_at),
        last_error = excluded.last_error`,
    [at, error ? null : at, error ? String(error).slice(0, 500) : null]);
  }

  async groupAccountExportRevision(accountId: string): Promise<number> {
    await this.ready;
    const row = await this.driver.get<{ revision: number }>(
      'SELECT revision FROM server_sync_group_account_exports WHERE account_id = ?', [accountId]);
    return Number(row?.revision ?? 0);
  }

  async markGroupAccountExported(accountId: string, revision: number): Promise<void> {
    await this.ready;
    await this.driver.run(`INSERT INTO server_sync_group_account_exports
      (account_id, revision, exported_at) VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET revision = MAX(revision, excluded.revision),
        exported_at = excluded.exported_at`, [accountId, revision, nowIso()]);
  }

  async applyServerSyncGroupMembers(members: ServerSyncGroupMember[]): Promise<void> {
    await this.ready;
    const group = await this.serverSyncGroup();
    if (!group || group.role !== 'member' || members.length > 1000
      || !members.some((member) => member.nodeId === group.mainNodeId
        && member.publicKey === group.mainPublicKey && member.nodeUrl === group.mainUrl)) {
      throw new ServerStoreError('INVALID_GROUP_DIRECTORY', 409, '同步组节点目录无效');
    }
    await this.driver.transaction(async (driver) => {
      const seen = new Set<string>();
      for (const member of members) {
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(member.nodeId) || seen.has(member.nodeId)
          || typeof member.publicKey !== 'string' || typeof member.nodeUrl !== 'string'
          || !Number.isFinite(Date.parse(member.joinedAt))) {
          throw new ServerStoreError('INVALID_GROUP_DIRECTORY', 409, '同步组节点目录无效');
        }
        seen.add(member.nodeId);
        const prior = await driver.get<{ public_key: string }>(`SELECT public_key FROM server_sync_group_members
          WHERE group_id = ? AND node_id = ?`, [group.groupId, member.nodeId]);
        if (prior && prior.public_key !== member.publicKey) {
          throw new ServerStoreError('GROUP_NODE_CHANGED', 409, '节点签名身份变化，已停止同步');
        }
        await driver.run(`INSERT OR IGNORE INTO server_sync_group_members
          (group_id, node_id, public_key, node_url, joined_at) VALUES (?, ?, ?, ?, ?)`,
        [group.groupId, member.nodeId, member.publicKey, member.nodeUrl, member.joinedAt]);
      }
    });
  }

  async createServerSyncGroup(mainUrl: string, mainPublicKey: string): Promise<ServerSyncGroup> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      if (await driver.get('SELECT 1 FROM server_sync_group WHERE singleton = 1')) {
        throw new ServerStoreError('GROUP_EXISTS', 409, '本站已经加入同步组');
      }
      const groupId = `group-${randomBytes(16).toString('hex')}`;
      const at = nowIso();
      await driver.run(`INSERT INTO server_sync_group
        (singleton, group_id, main_node_id, main_public_key, main_url, role, created_at)
        VALUES (1, ?, ?, ?, ?, 'main', ?)`, [groupId, this.serverId, mainPublicKey, mainUrl, at]);
      await driver.run(`INSERT INTO server_sync_group_members
        (group_id, node_id, public_key, node_url, joined_at) VALUES (?, ?, ?, ?, ?)`,
      [groupId, this.serverId, mainPublicKey, mainUrl, at]);
      return { groupId, mainNodeId: this.serverId, mainPublicKey, mainUrl, role: 'main', createdAt: at };
    });
  }

  async issueServerSyncGroupJoinToken(): Promise<{ token: string; expiresAt: string }> {
    await this.ready;
    const group = await this.serverSyncGroup();
    if (!group || group.role !== 'main') throw new ServerStoreError('GROUP_MAIN_REQUIRED', 409, '请在同步组主节点操作');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
    await this.driver.run(`INSERT INTO server_sync_group_join_tokens
      (token_hash, group_id, expires_at) VALUES (?, ?, ?)`,
    [createHash('sha256').update(token).digest('hex'), group.groupId, expiresAt]);
    return { token, expiresAt };
  }

  async acceptServerSyncGroupMember(token: string, member: Omit<ServerSyncGroupMember, 'joinedAt'>):
    Promise<{ group: ServerSyncGroup; member: ServerSyncGroupMember }> {
    await this.ready;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[A-Za-z0-9_-]{8,128}$/.test(member.nodeId)
      || member.nodeId === this.serverId) throw new ServerStoreError('INVALID_GROUP_JOIN', 400, '同步组加入参数无效');
    try {
      const key = createPublicKey({ key: Buffer.from(member.publicKey, 'base64url'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519'
        || key.export({ format: 'der', type: 'spki' }).toString('base64url') !== member.publicKey) throw new Error('key');
    } catch { throw new ServerStoreError('INVALID_GROUP_JOIN', 400, '节点公钥无效'); }
    return this.driver.transaction(async (driver) => {
      const row = await driver.get<Record<string, unknown>>('SELECT * FROM server_sync_group WHERE singleton = 1');
      if (!row || row['role'] !== 'main') throw new ServerStoreError('GROUP_MAIN_REQUIRED', 409, '请在同步组主节点操作');
      const group: ServerSyncGroup = { groupId: String(row['group_id']), mainNodeId: this.serverId,
        mainPublicKey: String(row['main_public_key']), mainUrl: String(row['main_url']),
        role: 'main', createdAt: String(row['created_at']) };
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const at = nowIso();
      const issued = await driver.get<{ used_at: string | null; expires_at: string }>(`
        SELECT used_at, expires_at FROM server_sync_group_join_tokens
        WHERE token_hash = ? AND group_id = ?`, [tokenHash, group.groupId]);
      const prior = await driver.get<{ public_key: string; node_url: string; joined_at: string }>(`
        SELECT public_key, node_url, joined_at FROM server_sync_group_members
        WHERE group_id = ? AND node_id = ?`, [group.groupId, member.nodeId]);
      if (issued?.used_at && prior?.public_key === member.publicKey
        && prior.node_url === member.nodeUrl) {
        return { group, member: { ...member, joinedAt: prior.joined_at } };
      }
      const used = await driver.run(`UPDATE server_sync_group_join_tokens SET used_at = ?
        WHERE token_hash = ? AND group_id = ? AND used_at IS NULL AND expires_at > ?`,
      [at, tokenHash, group.groupId, at]);
      if (used.changes !== 1) throw new ServerStoreError('INVALID_GROUP_JOIN', 403, '加入码无效、已使用或过期');
      if (await driver.get('SELECT 1 FROM server_sync_group_members WHERE group_id = ? AND node_id = ?',
        [group.groupId, member.nodeId])) throw new ServerStoreError('GROUP_NODE_EXISTS', 409, '节点已加入同步组');
      await driver.run(`INSERT INTO server_sync_group_members
        (group_id, node_id, public_key, node_url, joined_at) VALUES (?, ?, ?, ?, ?)`,
      [group.groupId, member.nodeId, member.publicKey, member.nodeUrl, at]);
      return { group, member: { ...member, joinedAt: at } };
    });
  }

  async joinServerSyncGroup(group: ServerSyncGroup, localUrl: string,
    localPublicKey: string): Promise<void> {
    await this.ready;
    if (group.role !== 'main' || group.mainNodeId === this.serverId
      || !/^[A-Za-z0-9_-]{16,128}$/.test(group.groupId)) {
      throw new ServerStoreError('INVALID_GROUP_JOIN', 400, '主节点组身份无效');
    }
    await this.driver.transaction(async (driver) => {
      if (await driver.get('SELECT 1 FROM server_sync_group WHERE singleton = 1')) {
        throw new ServerStoreError('GROUP_EXISTS', 409, '本站已经加入同步组');
      }
      const at = nowIso();
      await driver.run(`INSERT INTO server_sync_group
        (singleton, group_id, main_node_id, main_public_key, main_url, role, created_at)
        VALUES (1, ?, ?, ?, ?, 'member', ?)`,
      [group.groupId, group.mainNodeId, group.mainPublicKey, group.mainUrl, at]);
      await driver.run(`INSERT INTO server_sync_group_members
        (group_id, node_id, public_key, node_url, joined_at) VALUES (?, ?, ?, ?, ?)`,
      [group.groupId, group.mainNodeId, group.mainPublicKey, group.mainUrl, group.createdAt]);
      await driver.run(`INSERT INTO server_sync_group_members
        (group_id, node_id, public_key, node_url, joined_at) VALUES (?, ?, ?, ?, ?)`,
      [group.groupId, this.serverId, localPublicKey, localUrl, at]);
    });
  }

  async localRegistrationPolicy(): Promise<{ mode: RegistrationMode; revision: number }> {
    await this.ready;
    const row = await this.driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['registration_mode']);
    const revision = await this.driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['registration_policy_revision']);
    return { mode: row?.value === 'invite' || row?.value === 'closed' ? row.value : 'open',
      revision: Number(revision?.value ?? 1) };
  }

  async registrationPolicySource(): Promise<string | null> {
    await this.ready;
    const group = await this.serverSyncGroup();
    if (group?.role === 'member') return group.mainNodeId;
    const peers = await this.driver.all<{ source_node_id: string }>(`
      SELECT DISTINCT p.source_node_id FROM joined_group_registration_policy p
      JOIN node_replication_links l ON l.peer_node_id = p.source_node_id AND l.enabled = 1
      JOIN federated_account_bindings f ON f.local_username = l.username AND f.ledger_id = l.ledger_id`);
    return peers.length === 1 ? peers[0]!.source_node_id : peers.length ? 'conflict' : null;
  }

  async applyJoinedRegistrationPolicy(sourceNodeId: string, mode: RegistrationMode,
    revision: number): Promise<void> {
    await this.ready;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sourceNodeId) || !['open', 'invite', 'closed'].includes(mode)
      || !Number.isSafeInteger(revision) || revision < 1) throw new Error('同步组注册策略无效');
    await this.driver.transaction(async (driver) => {
      const group = await driver.get<{ main_node_id: string; role: string }>(
        'SELECT main_node_id, role FROM server_sync_group WHERE singleton = 1');
      if (group?.role === 'member' && group.main_node_id !== sourceNodeId) {
        throw new ServerStoreError('GROUP_POLICY_CONFLICT', 409, '注册策略来源不是同步组主节点');
      }
      await driver.run(`DELETE FROM joined_group_registration_policy WHERE source_node_id NOT IN (
        SELECT DISTINCT l.peer_node_id FROM node_replication_links l
        JOIN federated_account_bindings f ON f.local_username = l.username AND f.ledger_id = l.ledger_id
        WHERE l.enabled = 1) AND source_node_id <> ?`,
      [group?.role === 'member' ? group.main_node_id : '']);
      const peers = await driver.all<{ source_node_id: string }>(
        'SELECT source_node_id FROM joined_group_registration_policy');
      if (peers.some((peer) => peer.source_node_id !== sourceNodeId)) {
        throw new ServerStoreError('GROUP_POLICY_CONFLICT', 409, '本站已属于另一主节点的注册策略，请先由管理员拆组');
      }
      const current = await driver.get<{ revision: number; mode: RegistrationMode }>(
        'SELECT revision, mode FROM joined_group_registration_policy WHERE source_node_id = ?', [sourceNodeId]);
      if (current && current.revision > revision) throw new ServerStoreError('GROUP_POLICY_ROLLBACK', 409, '组策略版本回退');
      if (current && current.revision === revision) {
        if (current.mode !== mode) throw new ServerStoreError('GROUP_POLICY_COLLISION', 409, '同版本组策略内容不同');
        return;
      }
      await driver.run(`INSERT INTO joined_group_registration_policy (source_node_id, revision, mode, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(source_node_id) DO UPDATE SET
          revision = excluded.revision, mode = excluded.mode, updated_at = excluded.updated_at`,
      [sourceNodeId, revision, mode, nowIso()]);
    });
  }

  async setRegistrationMode(mode: RegistrationMode): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const group = await driver.get<{ role: string }>('SELECT role FROM server_sync_group WHERE singleton = 1');
      if (group?.role === 'member') throw new ServerStoreError('GROUP_POLICY_OWNED', 409,
        '本站注册策略由同步组主节点统一管理');
      if (await driver.get(`SELECT 1 FROM joined_group_registration_policy p WHERE EXISTS (
        SELECT 1 FROM node_replication_links l JOIN federated_account_bindings f
          ON f.local_username = l.username AND f.ledger_id = l.ledger_id
        WHERE l.peer_node_id = p.source_node_id AND l.enabled = 1) LIMIT 1`)) {
        throw new ServerStoreError('GROUP_POLICY_OWNED', 409, '本站注册策略由同步组主节点统一管理');
      }
      const at = nowIso();
      await driver.run('INSERT OR REPLACE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['registration_mode', mode, at]);
      await driver.run(`UPDATE server_meta SET value = CAST(value AS INTEGER) + 1, updated_at = ?
        WHERE key = 'registration_policy_revision'`, [at]);
    });
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
    if ((await this.serverSyncGroup())?.role === 'member') return;
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

  async nodePublicKey(): Promise<string | undefined> {
    await this.ready;
    const row = await this.driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['node_signing_public_key']);
    return row?.value;
  }

  async opaqueSetupForUser(username: string): Promise<string | undefined> {
    await this.ready;
    const row = await this.driver.get<{ server_setup: string }>(
      'SELECT server_setup FROM sync_user_opaque_setups WHERE username = ?', [username]);
    return row?.server_setup;
  }

  async savePendingOpaqueSetup(tokenHash: string, username: string, setup: string, expiresAt: string): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      await driver.run('DELETE FROM sync_opaque_registration_setups WHERE expires_at <= ?', [nowIso()]);
      await driver.run(`INSERT INTO sync_opaque_registration_setups
        (token_hash, username, server_setup, expires_at) VALUES (?, ?, ?, ?)`,
      [tokenHash, username, setup, expiresAt]);
    });
  }

  async consumePendingOpaqueSetup(tokenHash: string, username: string): Promise<string | undefined> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const row = await driver.get<{ server_setup: string }>(
        'SELECT server_setup FROM sync_opaque_registration_setups WHERE token_hash = ? AND username = ? AND expires_at > ?',
        [tokenHash, username, nowIso()]);
      if (row) await driver.run('DELETE FROM sync_opaque_registration_setups WHERE token_hash = ?', [tokenHash]);
      return row?.server_setup;
    });
  }

  async bindNodePublicKey(publicKey: string): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const row = await driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['node_signing_public_key']);
      if (row && row.value !== publicKey) throw new Error('节点签名公钥与服务器数据库记录不一致');
      if (!row) await driver.run('INSERT INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['node_signing_public_key', publicKey, nowIso()]);
    });
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
    displayName?: string,
    opaqueServerSetup?: string,
    groupAccountId?: string,
  ): Promise<{ role: AccountRole }> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const existingOwner = await driver.get<{ singleton: number }>('SELECT singleton FROM server_ownership WHERE singleton = 1');
      if (claimOwner && existingOwner) throw new ServerStoreError('OWNER_ALREADY_CLAIMED', 409, 'server owner has already been initialized');
      if (!claimOwner && !existingOwner) throw new ServerStoreError('OWNER_SETUP_REQUIRED', 403, 'server operator must initialize the owner with the setup secret');
      const group = await driver.get<{ group_id: string; role: string }>(
        'SELECT group_id, role FROM server_sync_group WHERE singleton = 1');
      if (groupAccountId && (group?.role !== 'member' || claimOwner
        || !/^[A-Za-z0-9_-]{8,160}$/.test(groupAccountId))) {
        throw new ServerStoreError('INVALID_GROUP_ACCOUNT', 403, '同步组账号身份无效');
      }
      const modeRow = await driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['registration_mode']);
      const groupPolicy = group?.role === 'member' ? await driver.get<{ mode: string }>(
        'SELECT mode FROM joined_group_registration_policy WHERE source_node_id = (SELECT main_node_id FROM server_sync_group WHERE singleton = 1)') : undefined;
      const mode = groupAccountId ? 'open' : claimOwner
        ? 'open'
        : group?.role === 'member' ? groupPolicy?.mode ?? 'closed'
          : modeRow?.value === 'invite' || modeRow?.value === 'closed' ? modeRow.value : 'open';
      if (mode === 'closed') throw new ServerStoreError('REGISTRATION_CLOSED', 403, 'registration closed');
      let invite: Record<string, unknown> | undefined;
      if (mode === 'invite' && !groupAccountId) {
        if (!inviteCode) throw new ServerStoreError('INVITE_REQUIRED', 403, 'invite required');
        invite = await driver.get<Record<string, unknown>>('SELECT * FROM registration_invites WHERE code = ?', [inviteCode]);
        const policy = await driver.get<{ expires_at: string }>('SELECT expires_at FROM registration_invite_policy WHERE code = ?', [inviteCode]);
        if (!invite || bool(invite['disabled']) || invite['used_by'] != null || policy && policy.expires_at <= nowIso()) throw new ServerStoreError('INVALID_INVITE', 403, 'invalid invite');
      }
      if (await driver.get('SELECT username FROM sync_users WHERE username = ?', [username])) throw new ServerStoreError('USER_EXISTS', 409, 'user exists');
      if (await driver.get('SELECT 1 FROM federated_password_credentials WHERE source_username = ?', [username])) {
        throw new ServerStoreError('USER_EXISTS', 409, '该账号名已属于同步组内的统一账号');
      }
      const at = nowIso();
      await driver.run(
        'INSERT INTO sync_users (username, display_name, opaque_registration_record, disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
        [username, displayName ?? username, opaqueRegistrationRecord, at, at],
      );
      await driver.run('INSERT INTO sync_account_identities (username, account_id) VALUES (?, ?)',
        [username, groupAccountId ?? `account-${randomBytes(16).toString('hex')}`]);
      if (opaqueServerSetup) await driver.run(
        'INSERT INTO sync_user_opaque_setups (username, server_setup, updated_at) VALUES (?, ?, ?)',
        [username, opaqueServerSetup, at]);
      if (claimOwner) await driver.run(
        'INSERT INTO server_ownership (singleton, username, created_at) VALUES (1, ?, ?)',
        [username, at],
      );
      if (inviteCode && !groupAccountId) await driver.run('UPDATE registration_invites SET used_by = ?, used_at = ? WHERE code = ?', [username, at, inviteCode]);
      const assignedOwner = await driver.get<{ username: string }>(
        'SELECT username FROM server_ownership WHERE singleton = 1',
      );
      return { role: assignedOwner?.username === username ? 'owner' : 'member' };
    });
  }

  async setDisplayName(username: string, displayName: string): Promise<void> {
    await this.ready;
    await this.driver.run('UPDATE sync_users SET display_name = ?, revision = revision + 1, updated_at = ? WHERE username = ?',
      [displayName, nowIso(), username]);
  }

  async accountEmail(username: string): Promise<{ email?: string; verifiedAt?: string; pendingEmail?: string; quotaNotifications: boolean }> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT email, verified_at, pending_email, notify_quota FROM account_email_settings WHERE username = ?', [username]);
    return {
      ...(row?.['email'] == null ? {} : { email: String(row['email']) }),
      ...(row?.['verified_at'] == null ? {} : { verifiedAt: String(row['verified_at']) }),
      ...(row?.['pending_email'] == null ? {} : { pendingEmail: String(row['pending_email']) }),
      quotaNotifications: Number(row?.['notify_quota'] ?? 0) === 1,
    };
  }

  async startEmailVerification(username: string, email: string, codeHash: string): Promise<void> {
    await this.ready;
    const at = nowIso();
    await this.driver.transaction(async (driver) => {
      const row = await driver.get<Record<string, unknown>>('SELECT * FROM account_email_settings WHERE username = ?', [username]);
      if (row?.['email'] === email && row['verified_at']) throw new ServerStoreError('EMAIL_ALREADY_VERIFIED', 409, '该邮箱已验证');
      if (row?.['code_sent_at'] && Date.parse(String(row['code_sent_at'])) > Date.now() - 60_000) throw new ServerStoreError('EMAIL_RATE_LIMIT', 429, '请一分钟后再发送验证码');
      const sameWindow = row?.['window_started_at'] && Date.parse(String(row['window_started_at'])) > Date.now() - 24 * 60 * 60_000;
      const count = sameWindow ? Number(row?.['window_count'] ?? 0) : 0;
      if (count >= 5) throw new ServerStoreError('EMAIL_DAILY_LIMIT', 429, '今天的验证码发送次数已达上限');
      await driver.run(
        `INSERT INTO account_email_settings (username, pending_email, pending_hash, pending_expires_at, code_sent_at, code_attempts, window_started_at, window_count)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(username) DO UPDATE SET pending_email = excluded.pending_email, pending_hash = excluded.pending_hash,
           pending_expires_at = excluded.pending_expires_at, code_sent_at = excluded.code_sent_at,
           code_attempts = 0, window_started_at = excluded.window_started_at, window_count = excluded.window_count`,
        [username, email, codeHash, new Date(Date.now() + 10 * 60_000).toISOString(), at, sameWindow ? String(row['window_started_at']) : at, count + 1],
      );
    });
  }

  async clearPendingEmailVerification(username: string, codeHash: string): Promise<void> {
    await this.ready;
    await this.driver.run(
      `UPDATE account_email_settings SET pending_email = NULL, pending_hash = NULL, pending_expires_at = NULL, code_attempts = 0
       WHERE username = ? AND pending_hash = ?`,
      [username, codeHash],
    );
  }

  async completeEmailVerification(username: string, codeHash: string): Promise<void> {
    await this.ready;
    const result = await this.driver.transaction(async (driver) => {
      const row = await driver.get<Record<string, unknown>>('SELECT * FROM account_email_settings WHERE username = ?', [username]);
      if (!row?.['pending_email'] || !row['pending_hash'] || !row['pending_expires_at'] || String(row['pending_expires_at']) <= nowIso()) return 'expired';
      if (Number(row['code_attempts'] ?? 0) >= 5) return 'attempts';
      await driver.run('UPDATE account_email_settings SET code_attempts = code_attempts + 1 WHERE username = ?', [username]);
      const expected = Buffer.from(String(row['pending_hash']), 'hex');
      const actual = Buffer.from(codeHash, 'hex');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return 'invalid';
      await driver.run(
        `UPDATE account_email_settings SET email = pending_email, verified_at = ?, pending_email = NULL, pending_hash = NULL,
         pending_expires_at = NULL, code_attempts = 0, notify_quota = 0 WHERE username = ?`,
        [nowIso(), username],
      );
      await driver.run("UPDATE account_email_outbox SET state = 'skipped' WHERE username = ? AND state = 'pending'", [username]);
      return 'verified';
    });
    if (result !== 'verified') throw new ServerStoreError('EMAIL_CODE_INVALID', 400, result === 'attempts' ? '验证码尝试次数已达上限，请重新发送' : '验证码无效或已过期');
  }

  async setQuotaEmailNotifications(username: string, enabled: boolean): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const result = await driver.run('UPDATE account_email_settings SET notify_quota = ? WHERE username = ? AND email IS NOT NULL AND verified_at IS NOT NULL', [enabled ? 1 : 0, username]);
      if (!result.changes) throw new ServerStoreError('EMAIL_NOT_VERIFIED', 400, '请先验证邮箱');
      if (!enabled) await driver.run("UPDATE account_email_outbox SET state = 'skipped' WHERE username = ? AND state = 'pending'", [username]);
    });
  }

  async removeAccountEmail(username: string): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      await driver.run(`UPDATE account_email_settings SET email = NULL, verified_at = NULL, pending_email = NULL,
        pending_hash = NULL, pending_expires_at = NULL, notify_quota = 0 WHERE username = ?`, [username]);
      await driver.run("UPDATE account_email_outbox SET state = 'skipped' WHERE username = ? AND state = 'pending'", [username]);
    });
  }

  async enqueueQuotaEmail(username: string, eventKey: string, subject: string, body: string): Promise<void> {
    await this.ready;
    const at = nowIso();
    await this.driver.run(
      `INSERT OR IGNORE INTO account_email_outbox (id, event_key, username, subject, body, next_attempt_at, created_at)
       SELECT ?, ?, username, ?, ?, ?, ? FROM account_email_settings
       WHERE username = ? AND email IS NOT NULL AND verified_at IS NOT NULL AND notify_quota = 1`,
      [`mail-${randomBytes(16).toString('hex')}`, eventKey, subject, body, at, at, username],
    );
  }

  async dueAccountEmails(limit = 20): Promise<{ id: string; username: string; email?: string; subject: string; body: string; attempts: number; enabled: boolean }[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT o.id, o.username, o.subject, o.body, o.attempts, s.email, s.verified_at, s.notify_quota
       FROM account_email_outbox o LEFT JOIN account_email_settings s ON s.username = o.username
       WHERE o.state = 'pending' AND o.next_attempt_at <= ? ORDER BY o.created_at LIMIT ?`,
      [nowIso(), limit],
    );
    return rows.map((row) => ({
      id: String(row['id']), username: String(row['username']), subject: String(row['subject']), body: String(row['body']),
      attempts: Number(row['attempts'] ?? 0),
      ...(row['email'] == null ? {} : { email: String(row['email']) }),
      enabled: row['verified_at'] != null && Number(row['notify_quota'] ?? 0) === 1,
    }));
  }

  async finishAccountEmail(id: string, outcome: 'sent' | 'skipped' | 'failed', attempts = 0): Promise<void> {
    await this.ready;
    const nextAttempts = attempts + 1;
    const state = outcome === 'failed' && nextAttempts < 5 ? 'pending' : outcome;
    const next = new Date(Date.now() + Math.min(60, 2 ** attempts) * 60_000).toISOString();
    await this.driver.run('UPDATE account_email_outbox SET state = ?, attempts = ?, next_attempt_at = ?, sent_at = ? WHERE id = ?', [state, nextAttempts, next, outcome === 'sent' ? nowIso() : null, id]);
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
    /** A federated login can enter the ledger that issued its node grant. */
    replicaId?: string;
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
      selectionVersion: 0,
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
      if (session.kind === 'ledger') {
        const route = input.replicaId
          ? await driver.get<{ replica_id: string }>(
            'SELECT replica_id FROM account_ledger_index WHERE username = ? AND replica_id = ?',
            [session.username, input.replicaId])
          : await driver.get<{ replica_id: string }>(
            'SELECT replica_id FROM ledger_account_routes WHERE username = ?', [session.username])
            ?? await driver.get<{ replica_id: string }>(
              'SELECT replica_id FROM account_ledger_index WHERE username = ? ORDER BY created_at, replica_id LIMIT 1',
              [session.username]);
        if (input.replicaId && !route) throw new ServerStoreError('LEDGER_ACCESS_DENIED', 403,
          '当前账号没有此账本的访问权限');
        if (route) session.replicaId = route.replica_id;
      }
      await driver.run(
        `INSERT INTO sync_sessions
         (session_id, username, device_id, device_name, refresh_hash, created_at, updated_at, expires_at, last_seen_at, last_ip, kind, replica_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id, session.username, session.deviceId, session.deviceName, session.refreshHash,
          session.createdAt, session.updatedAt, session.expiresAt, session.lastSeenAt, session.lastIp ?? null,
          session.kind, session.replicaId ?? null,
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

  /** Select only a verified membership for one node-local browser session. */
  async selectSessionReplica(username: string, sessionId: string, replicaId: string): Promise<SyncSession> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      const session = await driver.get<Record<string, unknown>>(`SELECT * FROM sync_sessions
        WHERE session_id = ? AND username = ? AND kind = 'ledger'
          AND revoked_at IS NULL AND expires_at > ?`, [sessionId, username, at]);
      if (!session) throw new ServerStoreError('SESSION_REVOKED', 401, '账本会话已失效，请重新登录');
      const replica = await this.accountReplicaRow(driver, username, replicaId);
      if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 403, '当前账号没有此账本');
      const control = await this.readLedgerControlState(driver, replicaId);
      const primary = await driver.get<{ replica_id: string }>(
        'SELECT replica_id FROM ledger_account_routes WHERE username = ?', [username]);
      if (primary?.replica_id !== replicaId && !control) {
        throw new ServerStoreError('LEDGER_MEMBER_REQUIRED', 403, '此账本尚无成员控制链');
      }
      await this.assertLedgerAccessOnReplica(driver, username, replicaId, 'read');
      if (primary?.replica_id !== replicaId && control) {
        const identity = await driver.get<{ account_id: string; issuer_node_id: string | null;
          subject_account_id: string | null }>(`
          SELECT local.account_id, binding.issuer_node_id, binding.subject_account_id
          FROM sync_account_identities local LEFT JOIN federated_account_bindings binding
            ON binding.local_username = local.username WHERE local.username = ?`, [username]);
        const issuerNodeId = identity?.issuer_node_id ?? this.serverId;
        const accountId = identity?.subject_account_id ?? identity?.account_id;
        const envelope = accountId ? await driver.get(`SELECT 1 FROM ledger_member_key_envelopes
          WHERE replica_id = ? AND issuer_node_id = ? AND account_id = ? AND key_epoch = ?`,
        [replicaId, issuerNodeId, accountId, control.keyEpoch]) : undefined;
        if (!envelope) throw new ServerStoreError('MEMBER_ENVELOPE_REQUIRED', 409,
          '当前账本代次的成员密钥包尚未同步');
      }
      const selectionVersion = Number(session['selection_version'] ?? 0);
      if (!Number.isSafeInteger(selectionVersion) || selectionVersion < 0
        || selectionVersion >= Number.MAX_SAFE_INTEGER) {
        throw new ServerStoreError('SESSION_SELECTION_INVALID', 409, '账本会话选择版本无效');
      }
      const nextVersion = selectionVersion + 1;
      await driver.run(`UPDATE sync_sessions SET replica_id = ?, selection_version = ?, updated_at = ?
        WHERE session_id = ?`, [replicaId, nextVersion, at, sessionId]);
      return sessionFromRow({ ...session, replica_id: replicaId,
        selection_version: nextVersion, updated_at: at });
    });
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
    /** What the bucket protects, e.g. `auth` — recorded for the console, not for decisions. */
    scope?: string,
    /** Who the bucket belongs to (a source IP). Recorded, never used to make a decision. */
    source?: string,
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
         (bucket_key, window_started_at, hits, blocked_until, updated_at, scope, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [bucketKey, windowStartedAt, hits, blockedUntil, now, scope ?? null, source ?? null],
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

  /**
   * Failed authentication attempts, grouped by source address.
   *
   * A brute-force attempt is visible as one address accumulating failures across many accounts,
   * so the grouping is by source and the account names are kept as evidence rather than as the
   * key. Reading the run log for this does not work: it is capped, and a line-level view makes
   * "is this one attacker or one careless user" a manual count.
   */
  async failedLoginsBySource(options: {
    from?: string;
    until?: string;
    /** Only addresses at or above this many failures; keeps a long tail out of the view. */
    minFailures?: number;
    limit?: number;
  } = {}): Promise<{
    sources: { source: string; failures: number; accountCount: number; accounts: string[]; firstAt: string; lastAt: string }[];
    /** Every recorded failure in range, including addresses below the threshold. */
    total: number;
    /** How many distinct addresses are in the view, not just on this page. */
    sourceCount: number;
  }> {
    await this.ready;
    const clauses = ['action IN (\'login_failed\', \'login_disabled\', \'login_mfa_failed\')'];
    const params: (string | number)[] = [];
    if (options.from) { clauses.push('at >= ?'); params.push(options.from); }
    if (options.until) { clauses.push('at < ?'); params.push(options.until); }
    // A log line with no IP cannot be attributed to a source, so it is excluded rather than
    // grouped under a placeholder that would look like a real address.
    clauses.push("COALESCE(ip, '') <> ''");
    const where = `WHERE ${clauses.join(' AND ')}`;
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT ip AS source, COUNT(*) AS failures, MIN(at) AS first_at, MAX(at) AS last_at,
              COUNT(DISTINCT CASE WHEN COALESCE(username, '') <> '' THEN username END) AS account_count
       FROM server_logs ${where}
       GROUP BY ip HAVING COUNT(*) >= ? ORDER BY failures DESC, last_at DESC LIMIT ?`,
      [...params, Math.max(1, options.minFailures ?? 1), Math.max(1, Math.min(options.limit ?? 100, 500))],
    );
    const totals = await this.driver.get<{ total: number; source_count: number }>(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT ip) AS source_count FROM server_logs ${where}`,
      params,
    );
    // The account names are the evidence an operator reads; they are fetched only for the
    // addresses that survived the filter, so the cost stays proportional to what is shown.
    const sources = await Promise.all(rows.map(async (row) => {
      const accounts = await this.driver.all<{ username: string }>(
        `SELECT DISTINCT username FROM server_logs ${where} AND ip = ? AND COALESCE(username, '') <> '' LIMIT 10`,
        [...params, String(row['source'])],
      );
      return {
        source: String(row['source']),
        failures: Number(row['failures'] ?? 0),
        accountCount: Number(row['account_count'] ?? 0),
        accounts: accounts.map((entry) => entry.username),
        firstAt: String(row['first_at']),
        lastAt: String(row['last_at']),
      };
    }));
    return { sources, total: Number(totals?.total ?? 0), sourceCount: Number(totals?.source_count ?? 0) };
  }

  /**
   * Rate-limit buckets, currently blocked first.
   *
   * The table is written on every throttled request and was never readable from the console, so
   * "is this address being limited right now" had no answer that did not involve SQL. A bucket
   * with no `scope`/`source` predates those columns: it is reported as unknown rather than
   * parsed out of the key.
   */
  async listRateLimits(options: { activeOnly?: boolean; limit?: number } = {}): Promise<{
    buckets: { bucketKey: string; scope: string | null; source: string | null; hits: number; windowStartedAt: string; blockedUntil: string | null; updatedAt: string }[];
    active: number;
    tracked: number;
  }> {
    await this.ready;
    const now = Date.now();
    const clauses = options.activeOnly ? ['blocked_until > ?'] : [];
    const params: number[] = options.activeOnly ? [now] : [];
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT * FROM server_rate_limits ${where} ORDER BY blocked_until DESC, updated_at DESC LIMIT ?`,
      [...params, Math.max(1, Math.min(options.limit ?? 200, 1_000))],
    );
    const counts = await this.driver.get<{ active: number; tracked: number }>(
      'SELECT SUM(CASE WHEN blocked_until > ? THEN 1 ELSE 0 END) AS active, COUNT(*) AS tracked FROM server_rate_limits',
      [now],
    );
    return {
      buckets: rows.map((row) => ({
        bucketKey: String(row['bucket_key']),
        scope: row['scope'] == null ? null : String(row['scope']),
        source: row['source'] == null ? null : String(row['source']),
        hits: Number(row['hits'] ?? 0),
        windowStartedAt: new Date(Number(row['window_started_at'] ?? 0)).toISOString(),
        blockedUntil: Number(row['blocked_until'] ?? 0) > now ? new Date(Number(row['blocked_until'])).toISOString() : null,
        updatedAt: new Date(Number(row['updated_at'] ?? 0)).toISOString(),
      })),
      active: Number(counts?.active ?? 0),
      tracked: Number(counts?.tracked ?? 0),
    };
  }

  /**
   * Accounts, newest-first by default, with a cursor that follows the ordering.
   *
   * The sort is resolved by the caller from a whitelist (`userSortOptions`) because a sort name
   * arrives in a query string; this method only turns it into SQL. Rows are ordered by name today,
   * but the cursor was a plain `username > ?`, so adding a sortable column meant every existing
   * page silently mis-paged until the cursor followed suit.
   */
  async listUsers(after = '', limit = 100, filters: {
    search?: string;
    role?: string;
    state?: string;
    protection?: string;
    /** Capacity state is derived from the encrypted-commit quota, which is the billed one. */
    quota?: string;
    sort?: ResolvedSort;
  } = {}): Promise<{ users: JsonRecord[]; nextCursor?: string }> {
    await this.ready;
    const sort = filters.sort ?? resolveSort(USER_SORT_OPTIONS, null, 'created', null);
    // The cursor is compared against the ordering expression, so the two are built together.
    const cursor = readCursor(after);
    const cursorClause = cursor ? sort.cursor(sort.value(cursor.value), cursor.id) : undefined;
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT u.username, u.display_name, i.account_id, u.disabled, u.created_at, u.updated_at, u.last_login_at,
              ${ROLE_SQL} AS role,
              r.ledger_id, r.replica_id, COALESCE(r.head_seq, 0) AS commit_count,
              COALESCE(SUM(c.cipher_bytes), 0) AS commit_bytes,
              CASE WHEN ${ROLE_SQL} IN ('owner', 'admin') THEN NULL ELSE COALESCE(q.commit_quota_bytes, ?) END AS commit_quota_bytes,
              u.revision,
              k.mode AS protection_mode,
              (SELECT MAX(e.at) FROM sync_events e
               WHERE e.username = u.username AND e.outcome = 'ok') AS last_sync_at,
              (SELECT COUNT(*) FROM sync_sessions s
               WHERE s.username = u.username AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_device_count
       FROM sync_users u
       JOIN sync_account_identities i ON i.username = u.username
       LEFT JOIN server_administrators a ON a.username = u.username
       LEFT JOIN server_ownership o ON o.username = u.username
       LEFT JOIN sync_replicas r ON r.username = u.username
       LEFT JOIN ledger_replica_commits c ON c.replica_id = r.replica_id
       LEFT JOIN sync_user_quotas q ON q.username = u.username
       LEFT JOIN sync_key_custody k ON k.username = u.username
       WHERE (? = '' OR instr(lower(u.username), lower(?)) > 0 OR instr(lower(COALESCE(u.display_name, '')), lower(?)) > 0 OR i.account_id = ?)
         AND (? = '' OR ${ROLE_SQL} = ?)
         AND (? = '' OR u.disabled = ?)
         AND (? = '' OR COALESCE(k.mode, 'none') = ?)
         ${cursorClause ? `AND ${cursorClause.sql}` : ''}
       GROUP BY u.username
       HAVING (? = ''
         OR (? = 'over' AND ${ROLE_SQL} NOT IN ('owner', 'admin') AND COALESCE(SUM(c.cipher_bytes), 0) >= COALESCE(q.commit_quota_bytes, ?))
         OR (? = 'warning' AND ${ROLE_SQL} NOT IN ('owner', 'admin') AND COALESCE(SUM(c.cipher_bytes), 0) >= COALESCE(q.commit_quota_bytes, ?) * 0.9
             AND COALESCE(SUM(c.cipher_bytes), 0) < COALESCE(q.commit_quota_bytes, ?))
         OR (? = 'ok' AND (${ROLE_SQL} IN ('owner', 'admin') OR COALESCE(SUM(c.cipher_bytes), 0) < COALESCE(q.commit_quota_bytes, ?) * 0.9)))
       ORDER BY ${sort.orderBy}
       LIMIT ?`,
      [
        this.defaultCommitQuotaBytes, nowIso(),
        filters.search ?? '', filters.search ?? '', filters.search ?? '', filters.search ?? '',
        filters.role ?? '', filters.role ?? '',
        filters.state ?? '', filters.state === 'disabled' ? 1 : 0,
        filters.protection ?? '', filters.protection ?? '',
        // Bound here, not at the end: the cursor lives in WHERE and the quota rules in HAVING.
        ...(cursorClause ? cursorClause.params : []),
        filters.quota ?? '', filters.quota ?? '', this.defaultCommitQuotaBytes,
        filters.quota ?? '', this.defaultCommitQuotaBytes, this.defaultCommitQuotaBytes,
        filters.quota ?? '', this.defaultCommitQuotaBytes,
        limit + 1,
      ],
    );
    const page = rows.slice(0, limit).map((row) => ({
      accountId: String(row['account_id']), username: String(row['username']), displayName: row['display_name'] == null ? null : String(row['display_name']), disabled: bool(row['disabled']),
      role: row['role'] === 'owner' ? 'owner' : row['role'] === 'admin' ? 'admin' : row['role'] === 'viewer' ? 'viewer' : 'member',
      createdAt: String(row['created_at']), updatedAt: String(row['updated_at']),
      lastLoginAt: row['last_login_at'] ?? null, ledgerId: row['ledger_id'] ?? null,
      replicaId: row['replica_id'] ?? null, commitCount: Number(row['commit_count'] ?? 0),
      commitBytes: Number(row['commit_bytes'] ?? 0), commitQuotaBytes: row['commit_quota_bytes'] == null ? null : Number(row['commit_quota_bytes']),
      activeDeviceCount: Number(row['active_device_count'] ?? 0),
      revision: Number(row['revision'] ?? 1),
      protectionMode: row['protection_mode'] == null ? null : String(row['protection_mode']),
      lastSyncAt: row['last_sync_at'] == null ? null : String(row['last_sync_at']),
      quotaState: row['commit_quota_bytes'] == null ? 'ok' : Number(row['commit_bytes'] ?? 0) >= Number(row['commit_quota_bytes']) ? 'over'
        : Number(row['commit_bytes'] ?? 0) >= Number(row['commit_quota_bytes']) * 0.9 ? 'warning' : 'ok',
    }));
    // The cursor carries the sort it belongs to: reusing it under another ordering would return
    // a stable, plausible, wrong page instead of an error.
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      users: page,
      ...(last ? { nextCursor: sort.write(cursorValue(last, sort), String(last['username'] ?? '')) } : {}),
    };
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
      await driver.run('UPDATE sync_users SET disabled = ?, revision = revision + 1, updated_at = ? WHERE username = ?',
        [disabled ? 1 : 0, at, username]);
      if (disabled) await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ?', [at, at, username]);
    });
    return this.getUser(username);
  }

  async userByAccountId(accountId: string): Promise<SyncUser | undefined> {
    await this.ready;
    const row = await this.driver.get<{ username: string }>('SELECT username FROM sync_account_identities WHERE account_id = ?', [accountId]);
    return row ? this.getUser(row.username) : undefined;
  }

  async pendingNativeDirectoryUsers(linkId: string, limit = 50): Promise<SyncUser[]> {
    await this.ready;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('账号目录批次无效');
    const rows = await this.driver.all<{ username: string }>(`
      SELECT u.username FROM sync_users u
      JOIN sync_account_identities i ON i.username = u.username
      JOIN account_encryption_keys k ON k.issuer_node_id = ? AND k.subject_account_id = i.account_id
      LEFT JOIN federated_account_bindings f ON f.local_username = u.username
      LEFT JOIN server_ownership o ON o.username = u.username
      LEFT JOIN server_administrators a ON a.username = u.username
      LEFT JOIN node_credential_exports e ON e.link_id = ? AND e.subject_account_id = i.account_id
      WHERE f.local_username IS NULL AND o.username IS NULL AND a.username IS NULL
        AND (e.revision IS NULL OR e.revision < u.revision * 1000000 + k.revision)
      ORDER BY u.username LIMIT ?`, [this.serverId, linkId, limit]);
    const users = await Promise.all(rows.map((row) => this.getUser(row.username)));
    return users.filter((user): user is SyncUser => Boolean(user));
  }

  async pendingHubDirectoryUsers(ledgerId: string, limit = 50): Promise<SyncUser[]> {
    await this.ready;
    const rows = await this.driver.all<{ username: string }>(`
      SELECT u.username FROM sync_users u
      JOIN sync_account_identities i ON i.username = u.username
      JOIN account_encryption_keys k ON k.issuer_node_id = ? AND k.subject_account_id = i.account_id
      LEFT JOIN federated_account_bindings f ON f.local_username = u.username
      LEFT JOIN server_ownership o ON o.username = u.username
      LEFT JOIN server_administrators a ON a.username = u.username
      LEFT JOIN native_directory_exports e ON e.ledger_id = ? AND e.subject_account_id = i.account_id
      WHERE f.local_username IS NULL AND o.username IS NULL AND a.username IS NULL
        AND (e.revision IS NULL OR e.revision < u.revision * 1000000 + k.revision)
      ORDER BY u.username LIMIT ?`, [this.serverId, ledgerId, limit]);
    const users = await Promise.all(rows.map((row) => this.getUser(row.username)));
    return users.filter((user): user is SyncUser => Boolean(user));
  }

  async markHubDirectoryUserExported(ledgerId: string, accountId: string, revision: number): Promise<void> {
    await this.ready;
    await this.driver.run(`INSERT INTO native_directory_exports
      (ledger_id, subject_account_id, revision) VALUES (?, ?, ?)
      ON CONFLICT(ledger_id, subject_account_id) DO UPDATE SET
        revision = MAX(native_directory_exports.revision, excluded.revision)`,
    [ledgerId, accountId, revision]);
  }

  async nodeDirectoryCursor(linkId: string): Promise<number> {
    await this.ready;
    const row = await this.driver.get<{ cursor: number }>(
      'SELECT cursor FROM node_directory_cursors WHERE link_id = ?', [linkId]);
    return Number(row?.cursor ?? 0);
  }

  async advanceNodeDirectoryCursor(linkId: string, cursor: number): Promise<void> {
    await this.ready;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('账号目录游标无效');
    await this.driver.run(`INSERT INTO node_directory_cursors (link_id, cursor) VALUES (?, ?)
      ON CONFLICT(link_id) DO UPDATE SET cursor = MAX(node_directory_cursors.cursor, excluded.cursor)`,
    [linkId, cursor]);
  }

  async markDirectoryUserExported(linkId: string, accountId: string, revision: number): Promise<void> {
    await this.ready;
    await this.driver.run(`INSERT INTO node_credential_exports
      (link_id, subject_account_id, revision, exported_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(link_id, subject_account_id) DO UPDATE SET
        revision = MAX(node_credential_exports.revision, excluded.revision),
        exported_at = excluded.exported_at`,
    [linkId, accountId, revision, nowIso()]);
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
      if (target && (mutation.action === 'password-reset-issue' || mutation.action === 'role')
        && await driver.get('SELECT 1 FROM federated_account_bindings WHERE local_username = ?', [target.username])) {
        throw new ServerStoreError('FEDERATED_IDENTITY_MANAGED', 409, '统一账号的密码和节点管理角色不能在副本节点设置');
      }
      const quotaMutation = mutation.action === 'commit-quota' || mutation.action === 'blob-quota';
      // A preview only reads. It is the one management act an administrator may perform on any
      // account, so the privileged-target guard below must not apply to it.
      const readOnlyMutation = mutation.action === 'ledger-preview-open';
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
      } else if (target && !selfSessions && !readOnlyMutation && ((!quotaMutation && target.role === 'owner') || actor.role === 'admin' && target.role !== 'member')) {
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
      if (mutation.action === 'registration' || mutation.action === 'invite-create'
        || mutation.action === 'invite-state') {
        const group = await driver.get<{ role: string }>('SELECT role FROM server_sync_group WHERE singleton = 1');
        if (group?.role === 'member') throw new ServerStoreError('GROUP_POLICY_OWNED', 409,
          '同步组注册和邀请码只在主节点管理');
      }
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
        if (mutation.bytes === null) {
          await driver.run('DELETE FROM blob_user_quotas WHERE username = ?', [target!.username]);
          await driver.run(`DELETE FROM ledger_replica_blob_quotas WHERE replica_id IN
            (SELECT replica_id FROM sync_replicas WHERE username = ?)`, [target!.username]);
        } else {
          await driver.run('INSERT OR REPLACE INTO blob_user_quotas (username, quota_bytes, updated_at) VALUES (?, ?, ?)', [target!.username, mutation.bytes, at]);
          await driver.run(`INSERT INTO ledger_replica_blob_quotas (replica_id, quota_bytes, updated_at)
            SELECT replica_id, ?, ? FROM sync_replicas WHERE username = ?
            ON CONFLICT(replica_id) DO UPDATE SET quota_bytes = excluded.quota_bytes,
              updated_at = excluded.updated_at`, [mutation.bytes, at, target!.username]);
        }
      } else if (mutation.action === 'revoke-session') {
        before = { sessionId: mutation.sessionId, revokedAt: targetSession!['revoked_at'] }; after = { sessionId: mutation.sessionId, revokedAt: at };
        await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE session_id = ?', [at, at, mutation.sessionId]);
      } else if (mutation.action === 'registration') {
        if (!['open', 'invite', 'closed'].includes(mutation.mode)) throw new ServerStoreError('INVALID_MODE', 400, 'invalid registration mode');
        if (await driver.get(`SELECT 1 FROM joined_group_registration_policy p WHERE EXISTS (
          SELECT 1 FROM node_replication_links l JOIN federated_account_bindings f
            ON f.local_username = l.username AND f.ledger_id = l.ledger_id
          WHERE l.peer_node_id = p.source_node_id AND l.enabled = 1) LIMIT 1`)) {
          throw new ServerStoreError('GROUP_POLICY_OWNED', 409, '本站注册策略由同步组主节点统一管理');
        }
        before = await driver.get('SELECT value FROM server_meta WHERE key = ?', ['registration_mode']) ?? null;
        after = { mode: mutation.mode };
        await driver.run('INSERT OR REPLACE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['registration_mode', mutation.mode, at]);
        await driver.run(`UPDATE server_meta SET value = CAST(value AS INTEGER) + 1, updated_at = ?
          WHERE key = 'registration_policy_revision'`, [at]);
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
      } else if (mutation.action === 'ledger-preview-open') {
        // Reading a decrypted ledger changes no state, but it still has to be recorded: the
        // audit row is the only durable trace that the plaintext was viewed.
        after = { previewId: mutation.previewId };
      } else if (mutation.action === 'maintenance-on' || mutation.action === 'maintenance-off') {
        // Stored in the same key/value table the settings use, and written inside this transaction
        // so the flag and its audit record cannot diverge.
        const previous = await driver.get<{ value_json: string }>('SELECT value_json FROM server_maintenance_state WHERE key = ?', [MAINTENANCE_KEY]);
        const previousState = previous ? JSON.parse(previous.value_json) as JsonRecord : {};
        const next = mutation.action === 'maintenance-on'
          ? { enabled: true, message: mutation.message, until: mutation.until, startedAt: at, startedBy: actor.username }
          : { enabled: false, message: '', until: null, startedAt: null, startedBy: null };
        await driver.run('INSERT OR REPLACE INTO server_maintenance_state (key, value_json, updated_at) VALUES (?, ?, ?)', [MAINTENANCE_KEY, JSON.stringify(next), at]);
        before = { enabled: previousState['enabled'] === true, until: previousState['until'] ?? null };
        after = { enabled: next.enabled, until: next.until, message: next.message };
      }
      if (target && (mutation.action === 'role' || mutation.action === 'state')) await driver.run('DELETE FROM account_password_resets WHERE account_id = ?', [target.account_id]);
      // A preview changes nothing about the account, so it must not advance the revision:
      // doing so would make a concurrent administrator's save look stale.
      if (target && mutation.action !== 'ledger-preview-open') await driver.run('UPDATE sync_users SET revision = revision + 1 WHERE username = ?', [target.username]);
      await driver.run('INSERT INTO server_admin_audit (at, actor_account_id, target_account_id, action, before_json, after_json, reason, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [at, actor.account_id, targetId ?? null, mutation.action, JSON.stringify(before), JSON.stringify(after), options.reason ?? null, options.requestId ?? null]);
    });
    return { revoked, revokedSessions };
  }

  async listAdminAudit(options: {
    cursor?: string;
    limit?: number;
    search?: string;
    action?: string;
    actorAccountId?: string;
    targetAccountId?: string;
    from?: string;
    until?: string;
    sort?: ResolvedSort;
  } = {}): Promise<{ entries: JsonRecord[]; nextCursor?: string }> {
    await this.ready;
    const sort = options.sort ?? resolveSort(AUDIT_SORT_OPTIONS, null, 'at', null);
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.search) { clauses.push("instr(lower(action || ' ' || actor_account_id || ' ' || COALESCE(target_account_id, '')), lower(?)) > 0"); params.push(options.search); }
    if (options.action) { clauses.push('action = ?'); params.push(options.action); }
    if (options.actorAccountId) { clauses.push('actor_account_id = ?'); params.push(options.actorAccountId); }
    if (options.targetAccountId) { clauses.push('target_account_id = ?'); params.push(options.targetAccountId); }
    if (options.from) { clauses.push('at >= ?'); params.push(options.from); }
    if (options.until) { clauses.push('at < ?'); params.push(options.until); }
    // The cursor is compared against the ordering expression, so the two are built together.
    const cursor = readCursor(options.cursor);
    const cursorClause = cursor ? sort.cursor(sort.value(cursor.value), cursor.id) : undefined;
    if (cursorClause) clauses.push(cursorClause.sql);
    let sql = 'SELECT * FROM server_admin_audit';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ` ORDER BY ${sort.orderBy} LIMIT ?`;
    const rows = await this.driver.all<Record<string, unknown>>(sql, [...params, ...(cursorClause ? cursorClause.params : []), limit + 1]);
    const lastRow = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      entries: rows.slice(0, limit).map((row) => ({ id: row['id'], at: row['at'], actorAccountId: row['actor_account_id'], targetAccountId: row['target_account_id'], action: row['action'], reason: row['reason'], requestId: row['request_id'], before: JSON.parse(String(row['before_json'])), after: JSON.parse(String(row['after_json'])) })),
      // The cursor carries the sort it belongs to, so it cannot be reused under another ordering.
      ...(lastRow ? { nextCursor: sort.write(cursorValue(lastRow, sort), String(lastRow['id'])) } : {}),
    };
  }

  async assertPasswordReset(username: string, codeHash: string): Promise<void> {
    await this.ready;
    const row = await this.driver.get(`SELECT r.account_id FROM (
      SELECT r.account_id, r.code_hash, r.expires_at FROM account_password_resets r
      UNION ALL SELECT e.account_id, e.code_hash, e.expires_at FROM account_password_email_codes e
    ) r JOIN sync_account_identities i ON i.account_id = r.account_id
    JOIN sync_users u ON u.username = i.username
    WHERE i.username = ? AND r.code_hash = ? AND r.expires_at > ? AND u.disabled = 0`,
    [username, codeHash, nowIso()]);
    if (!row) throw new ServerStoreError('INVALID_PASSWORD_RESET', 403, '重置码无效、已使用或已过期，请联系管理员重新审核');
  }

  /** Returns no address for unknown, unverified, federated, disabled or rate-limited accounts. */
  async issueEmailPasswordReset(username: string, codeHash: string, expiresAt: string): Promise<{
    accountId: string; email: string;
  } | null> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      const account = await driver.get<{ account_id: string; email: string }>(`
        SELECT i.account_id, e.email FROM sync_users u
        JOIN sync_account_identities i ON i.username = u.username
        JOIN account_email_settings e ON e.username = u.username
        LEFT JOIN federated_account_bindings f ON f.local_username = u.username
        WHERE u.username = ? AND u.disabled = 0 AND f.local_username IS NULL
          AND e.email IS NOT NULL AND e.verified_at IS NOT NULL`, [username]);
      if (!account || !/^[a-f0-9]{64}$/.test(codeHash)
        || Date.parse(expiresAt) > Date.now() + 16 * 60_000 || expiresAt <= at) return null;
      const limit = await driver.get<{ window_started_at: string; window_count: number;
        last_requested_at: string }>(
        'SELECT * FROM account_password_email_limits WHERE account_id = ?', [account.account_id]);
      if (limit && Date.parse(limit.last_requested_at) > Date.now() - 10 * 60_000) return null;
      const sameWindow = limit && Date.parse(limit.window_started_at) > Date.now() - 24 * 60 * 60_000;
      const count = sameWindow ? Number(limit.window_count) : 0;
      if (count >= 5) return null;
      await driver.run(`INSERT INTO account_password_email_limits
        (account_id, window_started_at, window_count, last_requested_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET window_started_at = excluded.window_started_at,
          window_count = excluded.window_count, last_requested_at = excluded.last_requested_at`,
      [account.account_id, sameWindow ? limit.window_started_at : at, count + 1, at]);
      await driver.run('DELETE FROM account_password_email_codes WHERE account_id = ? OR expires_at <= ?',
        [account.account_id, at]);
      await driver.run(`INSERT INTO account_password_email_codes
        (code_hash, account_id, expires_at, issued_at) VALUES (?, ?, ?, ?)`,
      [codeHash, account.account_id, expiresAt, at]);
      await driver.run(`INSERT INTO server_admin_audit
        (at, actor_account_id, target_account_id, action, before_json, after_json)
        VALUES (?, ?, ?, 'password-reset-email-issued', '{}', ?)`,
      [at, account.account_id, account.account_id, JSON.stringify({ expiresAt })]);
      return { accountId: account.account_id, email: account.email };
    });
  }

  async revokeEmailPasswordReset(accountId: string, codeHash: string): Promise<void> {
    await this.ready;
    await this.driver.run('DELETE FROM account_password_email_codes WHERE account_id = ? AND code_hash = ?',
      [accountId, codeHash]);
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
      if (await driver.get('SELECT 1 FROM federated_account_bindings WHERE local_username = ?', [actor.username])) {
        throw new ServerStoreError('FEDERATED_IDENTITY_MANAGED', 409, '统一账号的密码必须在身份节点管理');
      }
      await driver.run('INSERT OR REPLACE INTO account_password_resets (account_id, code_hash, expires_at, issued_at) VALUES (?, ?, ?, ?)', [actor.account_id, codeHash, expiresAt, at]);
      await driver.run('INSERT INTO server_admin_audit (at, actor_account_id, target_account_id, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)', [at, actor.account_id, actor.account_id, actorSessionId ? 'password-change-authorize' : 'owner-recovery-local', '{}', JSON.stringify({ expiresAt, localOperator: !actorSessionId })]);
      return actor.username;
    });
  }

  async completePasswordReset(username: string, codeHash: string, registrationRecord: string,
    opaqueServerSetup?: string): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const at = nowIso();
      const row = await driver.get<{ account_id: string }>(`SELECT r.account_id FROM (
        SELECT account_id, code_hash, expires_at FROM account_password_resets
        UNION ALL SELECT account_id, code_hash, expires_at FROM account_password_email_codes
      ) r JOIN sync_account_identities i ON i.account_id = r.account_id
      JOIN sync_users u ON u.username = i.username
      WHERE i.username = ? AND r.code_hash = ? AND r.expires_at > ? AND u.disabled = 0`,
      [username, codeHash, at]);
      if (!row) throw new ServerStoreError('INVALID_PASSWORD_RESET', 403, '重置码无效、已使用或已过期，请联系管理员重新审核');
      if (await driver.get('SELECT 1 FROM federated_account_bindings WHERE local_username = ?', [username])) {
        throw new ServerStoreError('FEDERATED_IDENTITY_MANAGED', 409, '统一账号的密码必须在身份节点管理');
      }
      await driver.run('UPDATE sync_users SET opaque_registration_record = ?, revision = revision + 1, updated_at = ? WHERE username = ?',
        [registrationRecord, at, username]);
      if (opaqueServerSetup) await driver.run(`INSERT INTO sync_user_opaque_setups
        (username, server_setup, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET server_setup = excluded.server_setup, updated_at = excluded.updated_at`,
      [username, opaqueServerSetup, at]);
      await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ?', [at, at, username]);
      await driver.run('DELETE FROM sync_opaque_login_states WHERE username = ?', [username]);
      await driver.run('DELETE FROM account_password_resets WHERE account_id = ?', [row.account_id]);
      await driver.run('DELETE FROM account_password_email_codes WHERE account_id = ?', [row.account_id]);
      await driver.run('INSERT INTO server_admin_audit (at, actor_account_id, target_account_id, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)', [at, row.account_id, row.account_id, 'password-reset-complete', '{}', '{"sessionsRevoked":true}']);
    });
  }

  async createNodeReplicationGrant(username: string, peerNodeId: string, peerPublicKey: string,
    expiresAt: string, renewable = false, replicaId?: string,
    syncGroupId?: string): Promise<NodeReplicationGrant> {
    await this.ready;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(peerNodeId) || peerNodeId === this.serverId) {
      throw new ServerStoreError('INVALID_PEER', 400, '节点身份无效');
    }
    try {
      const key = createPublicKey({ key: Buffer.from(peerPublicKey, 'base64url'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519' || key.export({ format: 'der', type: 'spki' }).toString('base64url') !== peerPublicKey) throw new Error('invalid key');
    } catch { throw new ServerStoreError('INVALID_PEER_KEY', 400, '节点签名公钥无效'); }
    if (typeof renewable !== 'boolean') throw new ServerStoreError('INVALID_GRANT', 400, '复制授权续期设置无效');
    const at = nowIso();
    const end = Date.parse(expiresAt);
    if (!Number.isFinite(end) || end <= Date.now() || end > Date.now() + 30 * 86_400_000) {
      throw new ServerStoreError('INVALID_GRANT_EXPIRY', 400, '复制授权有效期无效');
    }
    return this.driver.transaction(async (driver) => {
      const replica = await this.accountReplicaRow(driver, username, replicaId);
      if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账号尚未绑定账本');
      if (syncGroupId) {
        const member = await driver.get<{ public_key: string }>(`SELECT m.public_key
          FROM server_sync_group g JOIN server_sync_group_members m ON m.group_id = g.group_id
          WHERE g.singleton = 1 AND g.role = 'main' AND g.group_id = ? AND m.node_id = ?`,
        [syncGroupId, peerNodeId]);
        if (member?.public_key !== peerPublicKey) throw new ServerStoreError('GROUP_MEMBER_REQUIRED', 403,
          '节点不属于当前服务器同步组');
      } else await this.assertLedgerAccessOnReplica(driver, username, replica.replica_id, 'manage');
      const owner = await driver.get<{ username: string }>(
        'SELECT username FROM sync_replicas WHERE replica_id = ?', [replica.replica_id]);
      if (!owner) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账本副本不存在');
      if (!syncGroupId && await driver.get('SELECT 1 FROM federated_account_bindings WHERE local_username = ?', [owner.username])) {
        throw new ServerStoreError('ISSUER_REQUIRED', 409, '请在统一账号身份节点签发副本授权');
      }
      const member = await driver.get<{ public_key: string; retired_at: string | null }>(`
        SELECT public_key, retired_at FROM ledger_replica_group_members WHERE replica_id = ? AND node_id = ?`,
      [replica.replica_id, peerNodeId]);
      if (member && member.public_key !== peerPublicKey) {
        throw new ServerStoreError('PEER_CHANGED', 409, '同一节点 ID 的签名公钥已改变，请使用新的节点身份');
      }
      if (member?.retired_at) {
        throw new ServerStoreError('REPLICA_MEMBER_RETIRED', 409,
          '该节点已明确移出副本组，不能用旧身份重新授权；请用新节点身份加入空副本');
      }
      await driver.run(`INSERT OR IGNORE INTO ledger_replica_group_members
        (replica_id, node_id, public_key, joined_at) VALUES (?, ?, ?, ?)`,
      [replica.replica_id, peerNodeId, peerPublicKey, at]);
      const grant: NodeReplicationGrant = {
        grantId: `grant-${randomBytes(16).toString('hex')}`,
        username: owner.username, ledgerId: replica.ledger_id,
        peerNodeId, peerPublicKey, createdAt: at, expiresAt, renewable,
      };
      await driver.run('INSERT INTO node_replication_grants (grant_id, username, ledger_id, peer_node_id, peer_public_key, created_at, expires_at, renewable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [grant.grantId, owner.username, grant.ledgerId, peerNodeId, peerPublicKey, at, expiresAt, renewable ? 1 : 0]);
      return grant;
    });
  }

  async ensureGroupNodeReplicationGrant(groupId: string, username: string,
    peerNodeId: string, peerPublicKey: string, replicaId: string): Promise<NodeReplicationGrant> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账本副本不存在');
    const existing = (await this.listNodeReplicationGrants(username)).find((grant) =>
      grant.ledgerId === replica.ledgerId && grant.peerNodeId === peerNodeId && grant.peerPublicKey === peerPublicKey
      && grant.renewable && Date.parse(grant.expiresAt) > Date.now() + 86_400_000);
    if (existing) return existing;
    return this.createNodeReplicationGrant(username, peerNodeId, peerPublicKey,
      new Date(Date.now() + 30 * 86_400_000).toISOString(), true, replicaId, groupId);
  }

  async ensureNativeGroupSourceGrant(username: string, replicaId: string,
    peerNodeId: string, peerPublicKey: string): Promise<NodeReplicationGrant> {
    await this.ready;
    if (await this.federatedAccount(username)) throw new ServerStoreError('ISSUER_REQUIRED', 409,
      '只能向主节点登记本站创建的账本');
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账本副本不存在');
    const existing = (await this.listNodeReplicationGrants(username)).find((grant) =>
      grant.ledgerId === replica.ledgerId && grant.peerNodeId === peerNodeId
      && grant.peerPublicKey === peerPublicKey && grant.renewable
      && Date.parse(grant.expiresAt) > Date.now() + 86_400_000);
    if (existing) return existing;
    return this.createNodeReplicationGrant(username, peerNodeId, peerPublicKey,
      new Date(Date.now() + 30 * 86_400_000).toISOString(), true, replicaId);
  }

  async groupLedgerCatalog(after: string, limit: number, peerNodeId: string,
    peerPublicKey: string): Promise<{ ledgers: Array<{
      ledgerId: string; issuerNodeId: string; subjectAccountId: string;
      replicaId: string; streamEpoch: string; envelope: JsonRecord; grantId: string;
    }>; next: string; hasMore: boolean }> {
    await this.ready;
    const group = await this.serverSyncGroup();
    if (!group || group.role !== 'main' || !/^[A-Za-z0-9_-]{8,128}$/.test(peerNodeId)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ServerStoreError('INVALID_GROUP_CATALOG', 400, '同步组账本目录请求无效');
    }
    const rows = await this.driver.all<{ username: string; ledger_id: string;
      replica_id: string; stream_epoch: string; envelope_json: string }>(`
      SELECT r.username, r.ledger_id, r.replica_id, r.stream_epoch, e.envelope_json
      FROM sync_replicas r JOIN ledger_replica_key_envelopes e ON e.replica_id = r.replica_id
      WHERE r.ledger_id > ? ORDER BY r.ledger_id LIMIT ?`, [after, limit + 1]);
    const selected = rows.slice(0, limit);
    const groupMembers = await this.serverSyncGroupMembers();
    const ledgers = [];
    for (const row of selected) {
      const user = await this.getUser(row.username);
      if (!user) continue;
      const binding = await this.federatedAccount(row.username);
      if (binding && !groupMembers.some((member) =>
        member.nodeId === binding.issuerNodeId)) {
        throw new ServerStoreError('GROUP_LEDGER_ISSUER_PENDING', 409,
          `账本 ${row.ledger_id} 的原始身份节点尚未加入服务器同步组`);
      }
      const grant = await this.ensureGroupNodeReplicationGrant(group.groupId, row.username,
        peerNodeId, peerPublicKey, row.replica_id);
      ledgers.push({ ledgerId: row.ledger_id,
        issuerNodeId: binding?.issuerNodeId ?? this.serverId,
        subjectAccountId: binding?.subjectAccountId ?? user.accountId,
        replicaId: row.replica_id, streamEpoch: row.stream_epoch,
        envelope: jsonObject(row.envelope_json), grantId: grant.grantId });
    }
    return { ledgers, next: selected.at(-1)?.ledger_id ?? after, hasMore: rows.length > limit };
  }

  async groupAccountRows(after: string, limit: number): Promise<Array<{
    user: SyncUser; issuerNodeId: string; subjectAccountId: string; key: string;
  }>> {
    await this.ready;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) throw new Error('账号目录页大小无效');
    const rows = await this.driver.all<Record<string, unknown>>(`SELECT u.*, i.account_id,
      COALESCE(f.issuer_node_id, ?) AS issuer_node_id,
      COALESCE(f.subject_account_id, i.account_id) AS subject_account_id,
      COALESCE(f.issuer_node_id, ?) || '/' || COALESCE(f.subject_account_id, i.account_id) AS account_key
      FROM sync_users u JOIN sync_account_identities i ON i.username = u.username
      LEFT JOIN federated_account_bindings f ON f.local_username = u.username
      WHERE account_key > ? ORDER BY account_key LIMIT ?`,
    [this.serverId, this.serverId, after, limit]);
    return rows.map((row) => ({ user: userFromRow(row), issuerNodeId: String(row['issuer_node_id']),
      subjectAccountId: String(row['subject_account_id']), key: String(row['account_key']) }));
  }

  async assertGroupUsernameAvailable(username: string, inviteCode?: string): Promise<void> {
    await this.ready;
    const group = await this.serverSyncGroup();
    if (!group || group.role !== 'main') throw new ServerStoreError('GROUP_MAIN_REQUIRED', 409,
      '仅主节点可以核准同步组注册');
    await this.assertRegistrationAllowed(inviteCode);
    if (await this.getUser(username) || await this.federatedPasswordCredential(username)) {
      throw new ServerStoreError('USER_EXISTS', 409, '同步组内已有同名账号');
    }
  }

  async acceptGroupAccount(bundle: FederatedCredentialBundle, signature: string,
    issuerPublicKey: string, inviteCode?: string, preExistingAt?: string): Promise<string> {
    await this.ready;
    if (!verifyFederatedCredential(bundle, signature, issuerPublicKey)) {
      throw new ServerStoreError('INVALID_ISSUER_SIGNATURE', 403, '账号签发方签名无效');
    }
    return this.driver.transaction(async (driver) => {
      const group = await driver.get<{ group_id: string; role: string }>(
        'SELECT group_id, role FROM server_sync_group WHERE singleton = 1');
      const member = group && await driver.get<{ public_key: string }>(`
        SELECT public_key FROM server_sync_group_members
        WHERE group_id = ? AND node_id = ?`, [group.group_id, bundle.issuerNodeId]);
      if (group?.role !== 'main' || bundle.ledgerId !== group.group_id
        || member?.public_key !== issuerPublicKey || bundle.issuerNodeId === this.serverId) {
        throw new ServerStoreError('INVALID_GROUP_ACCOUNT', 403, '账号签发节点不属于同步组');
      }
      const existing = await driver.get<{ local_username: string }>(`SELECT local_username
        FROM federated_account_bindings WHERE issuer_node_id = ? AND subject_account_id = ?`,
      [bundle.issuerNodeId, bundle.subjectAccountId]);
      const username = existing?.local_username ?? `replica_${createHash('sha256')
        .update(`${bundle.issuerNodeId}\0${bundle.subjectAccountId}`).digest('hex').slice(0, 40)}`;
      const other = await driver.get<{ local_username: string }>(
        'SELECT local_username FROM federated_password_credentials WHERE source_username = ?', [bundle.username]);
      const native = await driver.get<{ username: string }>('SELECT username FROM sync_users WHERE username = ?',
        [bundle.username]);
      if (other && other.local_username !== username || native && native.username !== username) {
        throw new ServerStoreError('GROUP_USERNAME_CONFLICT', 409, '同步组内已有同名账号');
      }
      const at = nowIso();
      if (!existing) {
        if (await driver.get('SELECT 1 FROM sync_users WHERE username = ?', [username])
          || await driver.get('SELECT 1 FROM sync_account_identities WHERE account_id = ?',
            [bundle.subjectAccountId])) throw new ServerStoreError('FEDERATED_IDENTITY_COLLISION', 409,
          '同步组账号身份冲突');
        // This path is signed by the already joined server. It imports accounts
        // that predate group membership without comparing clocks across hosts.
        const legacy = Boolean(preExistingAt && Number.isFinite(Date.parse(preExistingAt)));
        if (!legacy) {
          const policy = await driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?',
            ['registration_mode']);
          const mode = policy?.value === 'closed' || policy?.value === 'invite' ? policy.value : 'open';
          if (mode === 'closed') throw new ServerStoreError('REGISTRATION_CLOSED', 403, '同步组已关闭注册');
          if (mode === 'invite') {
            if (!inviteCode) throw new ServerStoreError('INVITE_REQUIRED', 403, '需要主节点邀请码');
            const invite = await driver.get<{ disabled: number; used_by: string | null }>(
              'SELECT disabled, used_by FROM registration_invites WHERE code = ?', [inviteCode]);
            const expiry = await driver.get<{ expires_at: string }>(
              'SELECT expires_at FROM registration_invite_policy WHERE code = ?', [inviteCode]);
            if (!invite || invite.disabled || invite.used_by || expiry && expiry.expires_at <= at) {
              throw new ServerStoreError('INVALID_INVITE', 403, '邀请码无效或已使用');
            }
          }
        }
        await driver.run(`INSERT INTO sync_users (username, display_name, opaque_registration_record,
          disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`,
        [username, bundle.displayName, FEDERATED_ONLY_RECORD, at, at]);
        await driver.run('INSERT INTO sync_account_identities (username, account_id) VALUES (?, ?)',
          [username, bundle.subjectAccountId]);
        await driver.run(`INSERT INTO federated_account_bindings
          (local_username, issuer_node_id, subject_account_id, ledger_id, created_at, verified_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        [username, bundle.issuerNodeId, bundle.subjectAccountId, group.group_id, at, at]);
        if (!legacy && inviteCode) await driver.run(`UPDATE registration_invites
          SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL`, [username, at, inviteCode]);
      }
      const previous = await driver.get<{ source_username: string; registration_record: string;
        server_setup: string; disabled: number; source_revision: number }>(`
        SELECT source_username, registration_record, server_setup, disabled, source_revision
        FROM federated_password_credentials WHERE local_username = ?`, [username]);
      if (previous && (previous.source_username !== bundle.username
        || previous.source_revision > bundle.revision)) throw new ServerStoreError('FEDERATED_CREDENTIAL_ROLLBACK', 409,
        '账号名或凭据版本回退');
      const changed = previous && (previous.registration_record !== bundle.registrationRecord
        || previous.server_setup !== bundle.serverSetup || Boolean(previous.disabled) !== bundle.disabled);
      if (previous && previous.source_revision === bundle.revision && changed) {
        throw new ServerStoreError('FEDERATED_CREDENTIAL_COLLISION', 409, '同版本账号凭据不同');
      }
      await driver.run(`INSERT INTO federated_password_credentials
        (local_username, source_username, issuer_node_id, subject_account_id,
         registration_record, server_setup, disabled, source_revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_username) DO UPDATE SET registration_record = excluded.registration_record,
          server_setup = excluded.server_setup, disabled = excluded.disabled,
          source_revision = excluded.source_revision, updated_at = excluded.updated_at`,
      [username, bundle.username, bundle.issuerNodeId, bundle.subjectAccountId,
        bundle.registrationRecord, bundle.serverSetup, bundle.disabled ? 1 : 0, bundle.revision, at]);
      await driver.run('UPDATE sync_users SET display_name = ? WHERE username = ?',
        [bundle.displayName, username]);
      if (changed) {
        await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ?',
          [at, at, username]);
        await driver.run('DELETE FROM sync_opaque_login_states WHERE username = ?', [username]);
      }
      const encoded = canonicalJson(bundle);
      const relayed = await driver.get<{ revision: number; bundle_json: string }>(`
        SELECT revision, bundle_json FROM relayed_account_credentials
        WHERE ledger_id = ? AND issuer_node_id = ? AND subject_account_id = ?`,
      [group.group_id, bundle.issuerNodeId, bundle.subjectAccountId]);
      if (relayed && (relayed.revision > bundle.revision
        || relayed.revision === bundle.revision && relayed.bundle_json !== encoded)) {
        throw new ServerStoreError('FEDERATED_CREDENTIAL_COLLISION', 409, '账号签名资料版本冲突');
      }
      if (!relayed || relayed.revision < bundle.revision) {
        await driver.run(`INSERT INTO relayed_account_credentials
          (ledger_id, issuer_node_id, subject_account_id, revision, bundle_json, issuer_signature, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(ledger_id, issuer_node_id, subject_account_id) DO UPDATE SET
            revision = excluded.revision, bundle_json = excluded.bundle_json,
            issuer_signature = excluded.issuer_signature, updated_at = excluded.updated_at`,
        [group.group_id, bundle.issuerNodeId, bundle.subjectAccountId,
          bundle.revision, encoded, signature, at]);
      }
      return username;
    });
  }

  async getNodeReplicationGrant(grantId: string, forRevocation = false): Promise<NodeReplicationGrant | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>(`
      SELECT g.* FROM node_replication_grants g
      JOIN sync_users u ON u.username = g.username AND u.disabled = 0
      JOIN sync_replicas r ON r.username = g.username AND r.ledger_id = g.ledger_id
      ${forRevocation ? '' : `JOIN ledger_replica_group_members m ON m.replica_id = r.replica_id
        AND m.node_id = g.peer_node_id AND m.public_key = g.peer_public_key AND m.retired_at IS NULL`}
      WHERE g.grant_id = ?`, [grantId]);
    return row ? {
      grantId: String(row['grant_id']), username: String(row['username']), ledgerId: String(row['ledger_id']),
      peerNodeId: String(row['peer_node_id']), peerPublicKey: String(row['peer_public_key']),
      createdAt: String(row['created_at']), expiresAt: String(row['expires_at']), renewable: Number(row['renewable']) === 1,
      ...(row['revoked_at'] ? { revokedAt: String(row['revoked_at']) } : {}),
    } : undefined;
  }

  async listNodeReplicationGrants(username: string): Promise<NodeReplicationGrant[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(`
      SELECT g.* FROM node_replication_grants g
      JOIN sync_replicas r ON r.username = g.username AND r.ledger_id = g.ledger_id
      JOIN ledger_replica_group_members m ON m.replica_id = r.replica_id
        AND m.node_id = g.peer_node_id AND m.public_key = g.peer_public_key AND m.retired_at IS NULL
      WHERE g.username = ? AND g.revoked_at IS NULL AND g.expires_at > ?
      ORDER BY g.created_at DESC`, [username, nowIso()]);
    return rows.map((row) => ({
      grantId: String(row['grant_id']), username: String(row['username']), ledgerId: String(row['ledger_id']),
      peerNodeId: String(row['peer_node_id']), peerPublicKey: String(row['peer_public_key']),
      createdAt: String(row['created_at']), expiresAt: String(row['expires_at']), renewable: Number(row['renewable']) === 1,
    }));
  }

  async recordNodeReplicaHealthReport(grantId: string, peerNodeId: string, report: JsonRecord): Promise<string> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      const grant = await driver.get<{ peer_node_id: string; username: string; ledger_id: string }>(`
        SELECT g.peer_node_id, g.username, g.ledger_id FROM node_replication_grants g
        JOIN sync_users u ON u.username = g.username AND u.disabled = 0
        JOIN sync_replicas r ON r.username = g.username AND r.ledger_id = g.ledger_id
        JOIN ledger_replica_group_members m ON m.replica_id = r.replica_id
          AND m.node_id = g.peer_node_id AND m.public_key = g.peer_public_key AND m.retired_at IS NULL
        WHERE g.grant_id = ? AND g.revoked_at IS NULL AND g.expires_at > ?`, [grantId, at]);
      if (!grant || grant.peer_node_id !== peerNodeId) {
        throw new ServerStoreError('NODE_AUTH_REJECTED', 403, '节点授权已失效');
      }
      const source = await driver.get<{ replica_id: string; stream_epoch: string }>(`
        SELECT slot.replica_id, slot.stream_epoch FROM ledger_account_routes route
        JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
        WHERE route.username = ? AND slot.ledger_id = ?`, [grant.username, grant.ledger_id]);
      if (!source || report['sourceReplicaId'] !== source.replica_id
        || report['sourceStreamEpoch'] !== source.stream_epoch) {
        throw new ServerStoreError('PEER_REPLICA_CHANGED', 409, '源节点副本或流世代已改变');
      }
      const inventory = report['inventory'] as JsonRecord;
      const previous = await driver.get<{ peer_replica_id: string; peer_stream_epoch: string;
        source_replica_id: string; source_stream_epoch: string }>(`
        SELECT peer_replica_id, peer_stream_epoch, source_replica_id, source_stream_epoch
        FROM node_replica_health_reports WHERE grant_id = ?`, [grantId]);
      if (previous && (previous.peer_replica_id !== inventory['replicaId']
        || previous.peer_stream_epoch !== inventory['streamEpoch']
        || previous.source_replica_id !== source.replica_id
        || previous.source_stream_epoch !== source.stream_epoch)) {
        throw new ServerStoreError('PEER_REPLICA_CHANGED', 409, '对端副本或流世代已改变，须重新授权');
      }
      await driver.run(`INSERT INTO node_replica_health_reports
        (grant_id, peer_node_id, peer_replica_id, peer_stream_epoch, source_replica_id,
         source_stream_epoch, report_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (grant_id) DO UPDATE SET report_json = excluded.report_json,
          received_at = excluded.received_at`,
      [grantId, peerNodeId, String(inventory['replicaId']), String(inventory['streamEpoch']),
        source.replica_id, source.stream_epoch, JSON.stringify(report), at]);
      return at;
    });
  }

  async listNodeGroupMemberReports(username: string, ledgerId: string): Promise<NodeGroupMemberReport[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(`
      SELECT m.node_id, m.public_key, m.joined_at, g.grant_id,
        h.report_json, h.received_at, h.source_replica_id, h.source_stream_epoch,
        slot.replica_id, slot.stream_epoch,
        EXISTS (SELECT 1 FROM node_replication_grants conflicting
          WHERE conflicting.username = owner.username AND conflicting.ledger_id = slot.ledger_id
            AND conflicting.peer_node_id = m.node_id AND conflicting.peer_public_key <> m.public_key
            AND conflicting.revoked_at IS NULL AND conflicting.expires_at > ?) AS identity_conflict
      FROM ledger_replica_group_members m
      JOIN sync_replicas owner ON owner.replica_id = m.replica_id
      JOIN ledger_replica_slots slot ON slot.replica_id = m.replica_id
      LEFT JOIN node_replication_grants g ON g.grant_id = (
        SELECT candidate.grant_id FROM node_replication_grants candidate
        WHERE candidate.username = owner.username AND candidate.ledger_id = slot.ledger_id
          AND candidate.peer_node_id = m.node_id AND candidate.peer_public_key = m.public_key
          AND candidate.revoked_at IS NULL AND candidate.expires_at > ?
        ORDER BY candidate.created_at DESC, candidate.grant_id DESC LIMIT 1)
      LEFT JOIN node_replica_health_reports h ON h.grant_id = g.grant_id
      WHERE owner.username = ? AND slot.ledger_id = ? AND m.retired_at IS NULL
      ORDER BY m.joined_at, m.node_id`, [nowIso(), nowIso(), username, ledgerId]);
    return rows.map((row) => {
      let report: JsonRecord | undefined;
      if (row['report_json'] && row['source_replica_id'] === row['replica_id']
        && row['source_stream_epoch'] === row['stream_epoch']) {
        try {
          const parsed: unknown = JSON.parse(String(row['report_json']));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) report = parsed as JsonRecord;
        } catch { /* A malformed stored report is treated as missing. */ }
      }
      return {
        peerNodeId: String(row['node_id']), peerPublicKey: String(row['public_key']),
        joinedAt: String(row['joined_at']),
        ...(row['grant_id'] ? { grantId: String(row['grant_id']) } : {}),
        ...(Number(row['identity_conflict']) === 1 ? { identityConflict: true } : {}),
        ...(report ? { report, receivedAt: String(row['received_at']) } : {}),
      };
    });
  }

  async listReplicaGroupMembers(replicaId: string): Promise<ReplicaGroupMember[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(`
      SELECT node_id, public_key, joined_at, retired_at FROM ledger_replica_group_members
      WHERE replica_id = ? ORDER BY joined_at, node_id`, [replicaId]);
    return rows.map((row) => ({ nodeId: String(row['node_id']), publicKey: String(row['public_key']),
      joinedAt: String(row['joined_at']),
      ...(row['retired_at'] ? { retiredAt: String(row['retired_at']) } : {}) }));
  }

  async replicaRetirement(replicaId: string): Promise<{
    sourceNodeId: string; retiredAt: string; observedAt: string;
  } | undefined> {
    await this.ready;
    const row = await this.driver.get<{ value: string }>(
      'SELECT value FROM server_meta WHERE key = ?', [`replica_retired:${replicaId}`]);
    return row ? JSON.parse(row.value) as { sourceNodeId: string; retiredAt: string; observedAt: string } : undefined;
  }

  /** A pinned peer signed the removal. The fence is permanent until the replica is retired locally. */
  async fenceRetiredReplica(link: NodeReplicationLink, sourceNodeId: string,
    retiredAt: string): Promise<void> {
    await this.ready;
    if (sourceNodeId !== link.peerNodeId || !Number.isFinite(Date.parse(retiredAt))) {
      throw new ServerStoreError('INVALID_REPLICA_RETIREMENT', 409, '副本移出证明无效');
    }
    await this.driver.transaction(async (driver) => {
      const current = await driver.get<{ replica_id: string; peer_node_id: string;
        peer_public_key: string; grant_id: string; local_stream_epoch: string }>(`
        SELECT slot.replica_id, link.peer_node_id, link.peer_public_key, link.grant_id,
          link.local_stream_epoch FROM node_replication_links link
        JOIN ledger_account_routes route ON route.username = link.username
        JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
        WHERE link.link_id = ? AND link.ledger_id = slot.ledger_id`, [link.linkId]);
      if (!current || current.peer_node_id !== sourceNodeId
        || current.peer_public_key !== link.peerPublicKey || current.grant_id !== link.grantId
        || current.local_stream_epoch !== link.localStreamEpoch) {
        throw new ServerStoreError('PEER_REPLICA_CHANGED', 409, '副本链路身份已改变，拒绝应用移出证明');
      }
      const at = nowIso();
      await driver.run(`INSERT OR IGNORE INTO server_meta (key, value, updated_at)
        VALUES (?, ?, ?)`, [`replica_retired:${current.replica_id}`,
        JSON.stringify({ sourceNodeId, retiredAt, observedAt: at }), at]);
      await driver.run(`UPDATE node_replication_links SET enabled = 0, revocation_pending = 0,
        lifecycle_state = 'REVOKED', lifecycle_checked_at = ?,
        last_error = '本节点已被中继移出副本组；本地写入已封锁', updated_at = ?
        WHERE username IN (SELECT username FROM ledger_account_routes WHERE replica_id = ?)
          AND ledger_id = ?`, [at, at, current.replica_id, link.ledgerId]);
    });
  }

  async recordNodeGroupSnapshot(linkId: string, snapshot: JsonRecord): Promise<string> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const link = await driver.get<{ peer_node_id: string; peer_replica_id: string;
        peer_stream_epoch: string; local_stream_epoch: string; username: string; ledger_id: string }>(`
        SELECT peer_node_id, peer_replica_id, peer_stream_epoch, local_stream_epoch,
          username, ledger_id FROM node_replication_links WHERE link_id = ? AND enabled = 1`, [linkId]);
      if (!link || snapshot['serverId'] !== link.peer_node_id
        || snapshot['replicaId'] !== link.peer_replica_id
        || snapshot['streamEpoch'] !== link.peer_stream_epoch
        || snapshot['ledgerId'] !== link.ledger_id) {
        throw new ServerStoreError('PEER_REPLICA_CHANGED', 409, '副本组目录来源或世代已改变');
      }
      const local = await driver.get<{ stream_epoch: string }>(`
        SELECT slot.stream_epoch FROM ledger_account_routes route
        JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
        WHERE route.username = ? AND slot.ledger_id = ?`, [link.username, link.ledger_id]);
      if (!local || local.stream_epoch !== link.local_stream_epoch) {
        throw new ServerStoreError('LOCAL_REPLICA_CHANGED', 409, '本地副本世代已改变');
      }
      const old = await driver.get<{ snapshot_json: string }>(
        'SELECT snapshot_json FROM node_replica_group_snapshots WHERE link_id = ?', [linkId]);
      if (old) {
        const prior = JSON.parse(old.snapshot_json) as { directory: { members: ReplicaGroupMember[] } };
        const next = snapshot['directory'] as { members: ReplicaGroupMember[] };
        const byId = new Map(next.members.map((member) => [member.nodeId, member]));
        for (const member of prior.directory.members) {
          const current = byId.get(member.nodeId);
          if (!current || current.publicKey !== member.publicKey || current.joinedAt !== member.joinedAt
            || member.retiredAt && current.retiredAt !== member.retiredAt) {
            throw new ServerStoreError('GROUP_DIRECTORY_ROLLBACK', 409, '中继副本组目录回退或节点身份已改变');
          }
        }
      }
      const at = nowIso();
      await driver.run(`INSERT INTO node_replica_group_snapshots (link_id, snapshot_json, received_at)
        VALUES (?, ?, ?) ON CONFLICT (link_id) DO UPDATE SET
          snapshot_json = excluded.snapshot_json, received_at = excluded.received_at`,
      [linkId, canonicalJson(snapshot), at]);
      const directory = snapshot['directory'] as { members: ReplicaGroupMember[] };
      for (const member of directory.members) {
        if (member.retiredAt && member.nodeId !== this.serverId) {
          await this.disableFederatedIssuer(driver, link.ledger_id, member.nodeId, at);
        }
      }
      return at;
    });
  }

  async nodeGroupSnapshot(linkId: string): Promise<{ snapshot: JsonRecord; receivedAt: string } | undefined> {
    await this.ready;
    const row = await this.driver.get<{ snapshot_json: string; received_at: string }>(`
      SELECT snapshot_json, received_at FROM node_replica_group_snapshots WHERE link_id = ?`, [linkId]);
    return row ? { snapshot: jsonObject(row.snapshot_json), receivedAt: row.received_at } : undefined;
  }

  async invalidateNodeGroupSnapshot(linkId: string): Promise<void> {
    await this.ready;
    await this.driver.run(`UPDATE node_replica_group_snapshots SET received_at = ? WHERE link_id = ?`,
      ['1970-01-01T00:00:00.000Z', linkId]);
  }

  async retireReplicaGroupMember(username: string, replicaId: string, nodeId: string): Promise<boolean> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const replica = await this.accountReplicaRow(driver, username, replicaId);
      if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账号尚未绑定账本');
      await this.assertLedgerAccessOnReplica(driver, username, replica.replica_id, 'manage');
      const owner = await driver.get<{ username: string }>(
        'SELECT username FROM sync_replicas WHERE replica_id = ?', [replica.replica_id]);
      if (!owner) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账本副本不存在');
      const at = nowIso();
      const result = await driver.run(`UPDATE ledger_replica_group_members SET retired_at = ?
        WHERE replica_id = ? AND node_id = ? AND retired_at IS NULL`, [at, replica.replica_id, nodeId]);
      if (result.changes === 0) return false;
      await driver.run(`UPDATE node_replication_grants SET revoked_at = COALESCE(revoked_at, ?)
        WHERE username = ? AND ledger_id = ? AND peer_node_id = ?`,
      [at, owner.username, replica.ledger_id, nodeId]);
      await this.disableFederatedIssuer(driver, replica.ledger_id, nodeId, at);
      return true;
    });
  }

  private async disableFederatedIssuer(driver: SqlDriver, ledgerId: string,
    issuerNodeId: string, at: string): Promise<void> {
    await driver.run(`UPDATE sync_users SET disabled = 1, updated_at = ?
      WHERE disabled = 0 AND username IN (
        SELECT local_username FROM federated_account_bindings
        WHERE ledger_id = ? AND issuer_node_id = ?)`, [at, ledgerId, issuerNodeId]);
    await driver.run(`UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
      WHERE username IN (SELECT local_username FROM federated_account_bindings
        WHERE ledger_id = ? AND issuer_node_id = ?)`, [at, at, ledgerId, issuerNodeId]);
  }

  async consumeNodeReplicationNonce(grantId: string, nonce: string, peerNodeId: string): Promise<boolean> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      const grant = await driver.get<{ peer_node_id: string; expires_at: string; renewable: number }>(`
        SELECT g.peer_node_id, g.expires_at, g.renewable FROM node_replication_grants g
        JOIN sync_users u ON u.username = g.username AND u.disabled = 0
        JOIN sync_replicas r ON r.username = g.username AND r.ledger_id = g.ledger_id
        JOIN ledger_replica_group_members m ON m.replica_id = r.replica_id
          AND m.node_id = g.peer_node_id AND m.public_key = g.peer_public_key AND m.retired_at IS NULL
        WHERE g.grant_id = ? AND g.revoked_at IS NULL AND g.expires_at > ?`, [grantId, at]);
      if (!grant || grant.peer_node_id !== peerNodeId) return false;
      await driver.run('DELETE FROM node_replication_nonces WHERE expires_at <= ?', [at]);
      const existing = await driver.get('SELECT 1 FROM node_replication_nonces WHERE grant_id = ? AND nonce = ?', [grantId, nonce]);
      if (existing) return false;
      await driver.run('INSERT INTO node_replication_nonces (grant_id, nonce, expires_at) VALUES (?, ?, ?)',
        [grantId, nonce, new Date(Date.now() + 10 * 60_000).toISOString()]);
      // Renewable grants are sliding inactivity leases. A valid signed request
      // extends only its own grant, and only after the replay nonce is consumed.
      if (grant.renewable === 1 && Date.parse(grant.expires_at) < Date.now() + 7 * 86_400_000) {
        await driver.run(`UPDATE node_replication_grants SET expires_at = ?
          WHERE grant_id = ? AND peer_node_id = ? AND renewable = 1 AND revoked_at IS NULL AND expires_at > ?`,
        [new Date(Date.now() + 30 * 86_400_000).toISOString(), grantId, peerNodeId, at]);
      }
      return true;
    });
  }

  /** Revocation acknowledgements remain retryable after the grant is already revoked. */
  async consumeNodeRevocationNonce(grantId: string, nonce: string, peerNodeId: string): Promise<boolean> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const grant = await driver.get<{ peer_node_id: string }>(`SELECT peer_node_id
        FROM node_replication_grants WHERE grant_id = ?`, [grantId]);
      if (!grant || grant.peer_node_id !== peerNodeId) return false;
      const at = nowIso();
      await driver.run('DELETE FROM node_replication_nonces WHERE expires_at <= ?', [at]);
      const existing = await driver.get('SELECT 1 FROM node_replication_nonces WHERE grant_id = ? AND nonce = ?',
        [grantId, nonce]);
      if (existing) return false;
      await driver.run('INSERT INTO node_replication_nonces (grant_id, nonce, expires_at) VALUES (?, ?, ?)',
        [grantId, nonce, new Date(Date.now() + 10 * 60_000).toISOString()]);
      return true;
    });
  }

  async revokeNodeReplicationGrant(username: string, grantId: string): Promise<boolean> {
    await this.ready;
    const result = await this.driver.run('UPDATE node_replication_grants SET revoked_at = ? WHERE grant_id = ? AND username = ? AND revoked_at IS NULL',
      [nowIso(), grantId, username]);
    return result.changes > 0;
  }

  private nodeLinkFromRow(row: Record<string, unknown>): NodeReplicationLink {
    const enabled = bool(row['enabled']);
    const checkedAt = row['lifecycle_checked_at'] ? String(row['lifecycle_checked_at']) : undefined;
    const recorded = String(row['lifecycle_state'] ?? 'JOINING');
    const now = Date.now();
    const recent = (value: unknown) => value && Number.isFinite(Date.parse(String(value)))
      && now - Date.parse(String(value)) <= 60_000 && Date.parse(String(value)) <= now + 30_000;
    const behind = Number(row['pull_seq']) < Number(row['peer_head_seq'])
      || Number(row['push_seq']) < Number(row['local_head_seq'])
      || Boolean(row['pull_blob_cursor'] || row['push_blob_cursor']
        || row['pull_state_cursor'] || row['push_state_cursor']);
    const readyEvidence = recent(checkedAt) && recent(row['last_success_at'])
      && recent(row['inventory_matched_at']) && !behind
      && !row['last_error'] && !row['inventory_issue'] && !row['physical_issue']
      && row['inventory_blob_hash'] && row['physical_blob_hash'] === row['inventory_blob_hash']
      && row['physical_verified_at'];
    const lifecycleState = !enabled
      ? bool(row['revocation_pending']) ? 'REVOKING' : row['remote_revoked_at'] ? 'REVOKED' : 'STOPPED'
      : recorded === 'READY' && !readyEvidence ? behind ? 'CATCHING_UP' : 'VERIFYING' : recorded;
    return {
      linkId: String(row['link_id']), username: String(row['username']), ledgerId: String(row['ledger_id']),
      localStreamEpoch: String(row['local_stream_epoch']), peerUrl: String(row['peer_url']),
      peerNodeId: String(row['peer_node_id']), peerPublicKey: String(row['peer_public_key']),
      peerReplicaId: String(row['peer_replica_id']), peerStreamEpoch: String(row['peer_stream_epoch']),
      grantId: String(row['grant_id']), pullSeq: Number(row['pull_seq']), pushSeq: Number(row['push_seq']),
      pullBlobCursor: String(row['pull_blob_cursor'] ?? ''), pushBlobCursor: String(row['push_blob_cursor'] ?? ''),
      pullStateCursor: String(row['pull_state_cursor'] ?? ''), pushStateCursor: String(row['push_state_cursor'] ?? ''),
      pullMemberCursor: String(row['pull_member_cursor'] ?? ''), pushMemberCursor: String(row['push_member_cursor'] ?? ''),
      memberEpoch: Number(row['member_epoch'] ?? 0),
      peerHeadSeq: Number(row['peer_head_seq'] ?? 0), localHeadSeq: Number(row['local_head_seq'] ?? 0),
      peerBlobObjects: Number(row['peer_blob_objects'] ?? 0), localBlobObjects: Number(row['local_blob_objects'] ?? 0),
      peerBlobBytes: Number(row['peer_blob_bytes'] ?? 0), localBlobBytes: Number(row['local_blob_bytes'] ?? 0),
      pullBlobScannedBytes: Number(row['pull_blob_scanned_bytes'] ?? 0),
      pushBlobScannedBytes: Number(row['push_blob_scanned_bytes'] ?? 0),
      pullBlobTransferredBytes: Number(row['pull_blob_transferred_bytes'] ?? 0),
      pushBlobTransferredBytes: Number(row['push_blob_transferred_bytes'] ?? 0),
      peerLegacyObjects: Number(row['peer_legacy_objects'] ?? 0), localLegacyObjects: Number(row['local_legacy_objects'] ?? 0),
      peerTombstones: Number(row['peer_tombstones'] ?? 0), localTombstones: Number(row['local_tombstones'] ?? 0),
      ...(row['pull_blob_sweep_at'] ? { pullBlobSweepAt: String(row['pull_blob_sweep_at']) } : {}),
      ...(row['push_blob_sweep_at'] ? { pushBlobSweepAt: String(row['push_blob_sweep_at']) } : {}),
      ...(row['pull_state_sweep_at'] ? { pullStateSweepAt: String(row['pull_state_sweep_at']) } : {}),
      ...(row['push_state_sweep_at'] ? { pushStateSweepAt: String(row['push_state_sweep_at']) } : {}),
      ...(row['inventory_matched_at'] ? { inventoryMatchedAt: String(row['inventory_matched_at']) } : {}),
      ...(row['inventory_issue'] ? { inventoryIssue: String(row['inventory_issue']) } : {}),
      ...(row['inventory_blob_hash'] ? { inventoryBlobHash: String(row['inventory_blob_hash']) } : {}),
      ...(row['physical_blob_hash'] ? { physicalBlobHash: String(row['physical_blob_hash']) } : {}),
      ...(row['physical_verified_at'] ? { physicalVerifiedAt: String(row['physical_verified_at']) } : {}),
      ...(row['physical_scanned_at'] ? { physicalScannedAt: String(row['physical_scanned_at']) } : {}),
      ...(row['physical_issue'] ? { physicalIssue: String(row['physical_issue']) } : {}),
      ...(row['last_success_at'] ? { lastSuccessAt: String(row['last_success_at']) } : {}),
      ...(row['last_error'] ? { lastError: String(row['last_error']) } : {}),
      syncRounds: Number(row['sync_rounds'] ?? 0),
      convergedRounds: Number(row['converged_rounds'] ?? 0),
      partialRounds: Number(row['partial_rounds'] ?? 0),
      failedRounds: Number(row['failed_rounds'] ?? 0),
      lastRoundDurationMs: Number(row['last_round_duration_ms'] ?? 0),
      enabled,
      revocationPending: bool(row['revocation_pending']),
      ...(row['remote_revoked_at'] ? { remoteRevokedAt: String(row['remote_revoked_at']) } : {}),
      ...(row['revocation_error'] ? { revocationError: String(row['revocation_error']) } : {}),
      lifecycleState: lifecycleState as NodeReplicationLink['lifecycleState'],
      ...(checkedAt ? { lifecycleCheckedAt: checkedAt } : {}),
    };
  }

  async createNodeReplicationLink(input: Omit<NodeReplicationLink, 'linkId' | 'pullSeq' | 'pushSeq' | 'pullBlobCursor' | 'pushBlobCursor' | 'pullStateCursor' | 'pushStateCursor' | 'pullMemberCursor' | 'pushMemberCursor' | 'memberEpoch' | 'peerHeadSeq' | 'localHeadSeq' | 'peerBlobObjects' | 'localBlobObjects' | 'peerBlobBytes' | 'localBlobBytes' | 'pullBlobScannedBytes' | 'pushBlobScannedBytes' | 'pullBlobTransferredBytes' | 'pushBlobTransferredBytes' | 'peerLegacyObjects' | 'localLegacyObjects' | 'peerTombstones' | 'localTombstones' | 'pullBlobSweepAt' | 'pushBlobSweepAt' | 'pullStateSweepAt' | 'pushStateSweepAt' | 'inventoryMatchedAt' | 'inventoryIssue' | 'inventoryBlobHash' | 'physicalBlobHash' | 'physicalVerifiedAt' | 'physicalScannedAt' | 'physicalIssue' | 'enabled' | 'lastSuccessAt' | 'lastError' | 'syncRounds' | 'convergedRounds' | 'partialRounds' | 'failedRounds' | 'lastRoundDurationMs' | 'revocationPending' | 'remoteRevokedAt' | 'revocationError' | 'lifecycleState' | 'lifecycleCheckedAt'>): Promise<NodeReplicationLink> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const replica = await driver.get<{ ledger_id: string; replica_id: string; stream_epoch: string; head_seq: number }>(
        'SELECT ledger_id, replica_id, stream_epoch, head_seq FROM sync_replicas WHERE username = ?', [input.username]);
      if (!replica || replica.ledger_id !== input.ledgerId || replica.stream_epoch !== input.localStreamEpoch) {
        throw new ServerStoreError('REPLICA_CHANGED', 409, '本地账本副本已改变');
      }
      if (Number(replica.head_seq) !== 0) throw new ServerStoreError('TARGET_NOT_EMPTY', 409, '加入节点的账本副本必须为空，不能自动合并已有提交');
      const hasBlobTables = await driver.get(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blob_objects'");
      if (hasBlobTables) {
        for (const table of ['blob_objects', 'blob_replica_states', 'blob_uploads']) {
          const occupied = await driver.get(`SELECT 1 FROM ${table}
            WHERE replica_id = ? OR (username = ? AND ledger_id = ?) LIMIT 1`,
          [replica.replica_id, input.username, input.ledgerId]);
          if (occupied) throw new ServerStoreError('TARGET_NOT_EMPTY', 409,
            '加入节点的账本副本仍有附件、删除状态或未完成上传，不能自动合并');
        }
      }
      if (await driver.get('SELECT 1 FROM ledger_control_roots WHERE replica_id = ?', [replica.replica_id])
        || await driver.get('SELECT 1 FROM ledger_replica_rejected_commits WHERE replica_id = ?', [replica.replica_id])) {
        throw new ServerStoreError('TARGET_NOT_EMPTY', 409,
          '加入节点的账本副本已有成员控制或待处理写入，不能自动合并');
      }
      const existing = await driver.get('SELECT 1 FROM node_replication_links WHERE username = ? AND ledger_id = ? AND peer_node_id = ?', [input.username, input.ledgerId, input.peerNodeId]);
      if (existing) throw new ServerStoreError('LINK_EXISTS', 409, '此账本与节点已有复制链路');
      const at = nowIso();
      const linkId = `link-${randomBytes(16).toString('hex')}`;
      await driver.run(`INSERT INTO node_replication_links
        (link_id, username, ledger_id, local_stream_epoch, peer_url, peer_node_id, peer_public_key, peer_replica_id, peer_stream_epoch, grant_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [linkId, input.username, input.ledgerId, input.localStreamEpoch, input.peerUrl, input.peerNodeId,
        input.peerPublicKey, input.peerReplicaId, input.peerStreamEpoch, input.grantId, at, at]);
      const row = await driver.get<Record<string, unknown>>(
        'SELECT * FROM node_replication_links WHERE link_id = ?', [linkId]);
      return this.nodeLinkFromRow(row!);
    });
  }

  async createNativeGroupSourceLink(username: string, ledgerId: string,
    peer: { peerUrl: string; peerNodeId: string; peerPublicKey: string;
      peerReplicaId: string; peerStreamEpoch: string; grantId: string }): Promise<NodeReplicationLink> {
    await this.ready;
    const group = await this.serverSyncGroup();
    if (group?.role !== 'member' || group.mainNodeId !== peer.peerNodeId
      || group.mainPublicKey !== peer.peerPublicKey || group.mainUrl !== peer.peerUrl
      || await this.federatedAccount(username)) {
      throw new ServerStoreError('GROUP_SOURCE_REQUIRED', 403, '仅本站原生账本可以主动同步到主节点');
    }
    return this.driver.transaction(async (driver) => {
      const replica = await driver.get<{ replica_id: string; stream_epoch: string }>(
        'SELECT replica_id, stream_epoch FROM sync_replicas WHERE username = ? AND ledger_id = ?',
        [username, ledgerId]);
      if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账本副本不存在');
      const existing = await driver.get<Record<string, unknown>>(`SELECT * FROM node_replication_links
        WHERE username = ? AND ledger_id = ? AND peer_node_id = ?`, [username, ledgerId, peer.peerNodeId]);
      if (existing) {
        const link = this.nodeLinkFromRow(existing);
        if (link.peerReplicaId !== peer.peerReplicaId || link.peerStreamEpoch !== peer.peerStreamEpoch
          || link.peerPublicKey !== peer.peerPublicKey) throw new ServerStoreError('PEER_CHANGED', 409,
            '主节点副本身份已改变，不能自动覆盖旧链路');
        if (link.grantId !== peer.grantId) await driver.run(`UPDATE node_replication_links
          SET grant_id = ?, updated_at = ? WHERE link_id = ?`, [peer.grantId, nowIso(), link.linkId]);
        return { ...link, grantId: peer.grantId };
      }
      const at = nowIso();
      const linkId = `link-${randomBytes(16).toString('hex')}`;
      await driver.run(`INSERT INTO node_replication_links
        (link_id, username, ledger_id, local_stream_epoch, peer_url, peer_node_id, peer_public_key,
         peer_replica_id, peer_stream_epoch, grant_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [linkId, username, ledgerId, replica.stream_epoch, peer.peerUrl, peer.peerNodeId,
        peer.peerPublicKey, peer.peerReplicaId, peer.peerStreamEpoch, peer.grantId, at, at]);
      const row = await driver.get<Record<string, unknown>>('SELECT * FROM node_replication_links WHERE link_id = ?', [linkId]);
      return this.nodeLinkFromRow(row!);
    });
  }

  async provisionFederatedReplica(input: {
    issuerNodeId: string; subjectAccountId: string; ledgerId: string; envelope: JsonRecord;
    peerUrl: string; peerNodeId: string; peerPublicKey: string; peerReplicaId: string;
    peerStreamEpoch: string; grantId: string;
  }): Promise<NodeReplicationLink> {
    await this.ready;
    const { issuerNodeId, subjectAccountId, ledgerId, envelope } = input;
    if (issuerNodeId === this.serverId
      || !/^[A-Za-z0-9_-]{8,128}$/.test(issuerNodeId)
      || !/^[A-Za-z0-9_-]{8,160}$/.test(subjectAccountId)
      || !/^[A-Za-z0-9_-]{16,128}$/.test(ledgerId)
      || envelope['ledgerId'] !== ledgerId || typeof envelope['keyringId'] !== 'string'
      || !Number.isSafeInteger(envelope['generation']) || Number(envelope['generation']) < 1) {
      throw new ServerStoreError('INVALID_FEDERATED_REPLICA', 400, '统一账号副本参数无效');
    }
    const username = `replica_${createHash('sha256').update(`${issuerNodeId}\0${subjectAccountId}`).digest('hex').slice(0, 40)}`;
    return this.driver.transaction(async (driver) => {
      const existing = await driver.get<{ local_username: string }>(`
        SELECT local_username FROM federated_account_bindings
        WHERE issuer_node_id = ? AND subject_account_id = ?`, [issuerNodeId, subjectAccountId]);
      if (existing && existing.local_username !== username
        || await driver.get('SELECT 1 FROM sync_replicas WHERE ledger_id = ?', [ledgerId])
        || await driver.get('SELECT 1 FROM sync_replicas WHERE username = ?', [username])
        || !existing && (await driver.get('SELECT 1 FROM sync_users WHERE username = ?', [username])
          || await driver.get('SELECT 1 FROM sync_account_identities WHERE account_id = ?', [subjectAccountId]))) {
        throw new ServerStoreError('FEDERATED_REPLICA_EXISTS', 409, '此账本或统一账号已在本节点存在，请检查现有副本');
      }
      const at = nowIso();
      const replicaId = `rep-${randomBytes(12).toString('hex')}`;
      const streamEpoch = `epoch-${randomBytes(12).toString('hex')}`;
      const linkId = `link-${randomBytes(16).toString('hex')}`;
      if (!existing) {
        await driver.run('INSERT INTO sync_users (username, display_name, opaque_registration_record, disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
          [username, '统一账号', FEDERATED_ONLY_RECORD, at, at]);
        await driver.run('INSERT INTO sync_account_identities (username, account_id) VALUES (?, ?)', [username, subjectAccountId]);
      }
      await driver.run('INSERT INTO sync_replicas (username, ledger_id, replica_id, stream_epoch, head_seq, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
        [username, ledgerId, replicaId, streamEpoch, at, at]);
      await driver.run(`INSERT INTO ledger_replica_key_envelopes
        (replica_id, ledger_id, keyring_id, generation, envelope_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [replicaId, ledgerId, String(envelope['keyringId']), Number(envelope['generation']), JSON.stringify(envelope), at]);
      await driver.run('INSERT INTO sync_key_custody (username, mode, version, sealed_secret, updated_at) VALUES (?, ?, 1, NULL, ?)',
        [username, 'relay', at]);
      if (!existing) await driver.run(`INSERT INTO federated_account_bindings
        (local_username, issuer_node_id, subject_account_id, ledger_id, created_at, verified_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [username, issuerNodeId, subjectAccountId, ledgerId, at, at]);
      const syncGroup = await driver.get<{ group_id: string }>(`SELECT group_id FROM server_sync_group
        WHERE singleton = 1 AND role = 'main'`);
      const sourceMember = syncGroup && await driver.get<{ public_key: string }>(`SELECT public_key
        FROM server_sync_group_members WHERE group_id = ? AND node_id = ?`,
      [syncGroup.group_id, input.peerNodeId]);
      if (sourceMember?.public_key === input.peerPublicKey) {
        await driver.run(`INSERT OR IGNORE INTO ledger_replica_group_members
          (replica_id, node_id, public_key, joined_at) VALUES (?, ?, ?, ?)`,
        [replicaId, input.peerNodeId, input.peerPublicKey, at]);
      }
      await driver.run(`INSERT INTO node_replication_links
        (link_id, username, ledger_id, local_stream_epoch, peer_url, peer_node_id, peer_public_key,
         peer_replica_id, peer_stream_epoch, grant_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [linkId, username, ledgerId, streamEpoch, input.peerUrl, input.peerNodeId, input.peerPublicKey,
        input.peerReplicaId, input.peerStreamEpoch, input.grantId, at, at]);
      await this.rebuildAccountLedgerIndex(driver, replicaId);
      const row = await driver.get<Record<string, unknown>>('SELECT * FROM node_replication_links WHERE link_id = ?', [linkId]);
      return this.nodeLinkFromRow(row!);
    });
  }

  /** A group account can log in locally before it receives any ledger membership. */
  async provisionFederatedDirectoryAccount(ledgerId: string, issuerNodeId: string,
    subjectAccountId: string): Promise<string> {
    await this.ready;
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(ledgerId)
      || !/^[A-Za-z0-9_-]{8,128}$/.test(issuerNodeId)
      || !/^[A-Za-z0-9_-]{8,160}$/.test(subjectAccountId)
      || issuerNodeId === this.serverId) {
      throw new ServerStoreError('FEDERATED_IDENTITY_CHANGED', 403, '统一账号身份无效');
    }
    return this.driver.transaction(async (driver) => {
      const existing = await driver.get<{ local_username: string }>(`
        SELECT local_username FROM federated_account_bindings
        WHERE issuer_node_id = ? AND subject_account_id = ?`, [issuerNodeId, subjectAccountId]);
      if (existing) return existing.local_username;
      const username = `replica_${createHash('sha256')
        .update(`${issuerNodeId}\0${subjectAccountId}`).digest('hex').slice(0, 40)}`;
      if (await driver.get('SELECT 1 FROM sync_users WHERE username = ?', [username])
        || await driver.get('SELECT 1 FROM sync_account_identities WHERE account_id = ?', [subjectAccountId])) {
        throw new ServerStoreError('FEDERATED_IDENTITY_COLLISION', 409, '统一账号身份与本地账号冲突');
      }
      const at = nowIso();
      await driver.run(`INSERT INTO sync_users (username, display_name, opaque_registration_record,
        disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`,
      [username, '同步组账号', FEDERATED_ONLY_RECORD, at, at]);
      await driver.run('INSERT INTO sync_account_identities (username, account_id) VALUES (?, ?)',
        [username, subjectAccountId]);
      await driver.run(`INSERT INTO federated_account_bindings
        (local_username, issuer_node_id, subject_account_id, ledger_id, created_at, verified_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [username, issuerNodeId, subjectAccountId, ledgerId, at, at]);
      return username;
    });
  }

  /** Bind an issuer-authenticated member to an existing ledger slot without granting node administration. */
  async provisionFederatedMember(link: Pick<NodeReplicationLink, 'username' | 'ledgerId' | 'peerNodeId'>,
    issuerNodeId: string,
    subjectAccountId: string): Promise<string> {
    await this.ready;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(issuerNodeId)
      || !/^[A-Za-z0-9_-]{8,160}$/.test(subjectAccountId)) {
      throw new ServerStoreError('FEDERATED_IDENTITY_CHANGED', 403, '统一身份节点不匹配');
    }
    return this.driver.transaction(async (driver) => {
      const route = await driver.get<{ replica_id: string; ledger_id: string }>(`
        SELECT slot.replica_id, slot.ledger_id FROM ledger_account_routes route
        JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
        WHERE route.username = ?`, [link.username]);
      if (!route || route.ledger_id !== link.ledgerId) {
        throw new ServerStoreError('REPLICA_CHANGED', 409, '统一登录账本副本已改变');
      }
      const control = await this.readLedgerControlState(driver, route.replica_id);
      const member = control?.members[`${issuerNodeId}/${subjectAccountId}`];
      if (!member || member.removed) {
        throw new ServerStoreError('LEDGER_MEMBER_REQUIRED', 403, '统一账号没有当前账本访问权');
      }
      const envelope = await driver.get('SELECT 1 FROM ledger_member_key_envelopes WHERE replica_id = ? AND issuer_node_id = ? AND account_id = ? AND key_epoch = ?',
        [route.replica_id, issuerNodeId, subjectAccountId, control.keyEpoch]);
      if (!envelope) throw new ServerStoreError('MEMBER_ENVELOPE_REQUIRED', 409, '成员密钥包尚未同步到此副本');
      const accountKey = await driver.get<{ public_key: string }>(
        'SELECT public_key FROM account_encryption_keys WHERE issuer_node_id = ? AND subject_account_id = ?',
        [issuerNodeId, subjectAccountId]);
      if (accountKey?.public_key !== member.encryptionPublicKey) {
        throw new ServerStoreError('MEMBER_ACCOUNT_KEY_REQUIRED', 409, '成员账号密钥尚未同步到此副本');
      }
      const existing = await driver.get<{ local_username: string }>(`
        SELECT local_username FROM federated_account_bindings
        WHERE issuer_node_id = ? AND subject_account_id = ?`, [issuerNodeId, subjectAccountId]);
      if (existing) {
        await this.rebuildAccountLedgerIndex(driver, route.replica_id, control);
        const existingRoute = await driver.get<{ replica_id: string }>(
          'SELECT replica_id FROM account_ledger_index WHERE username = ? AND replica_id = ?',
          [existing.local_username, route.replica_id]);
        const user = await driver.get<{ disabled: number }>(
          'SELECT disabled FROM sync_users WHERE username = ?', [existing.local_username]);
        if (!existingRoute || !user || Number(user.disabled)) {
          throw new ServerStoreError('FEDERATED_IDENTITY_CHANGED', 409, '统一账号已绑定其他副本或不可用');
        }
        return existing.local_username;
      }
      const username = `replica_${createHash('sha256').update(`${issuerNodeId}\0${subjectAccountId}`).digest('hex').slice(0, 40)}`;
      if (await driver.get('SELECT 1 FROM sync_users WHERE username = ?', [username])
        || await driver.get('SELECT 1 FROM sync_account_identities WHERE account_id = ?', [subjectAccountId])) {
        throw new ServerStoreError('FEDERATED_IDENTITY_COLLISION', 409, '统一账号身份与本地账号冲突');
      }
      const at = nowIso();
      await driver.run('INSERT INTO sync_users (username, display_name, opaque_registration_record, disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
        [username, '统一账本成员', FEDERATED_ONLY_RECORD, at, at]);
      await driver.run('INSERT INTO sync_account_identities (username, account_id) VALUES (?, ?)', [username, subjectAccountId]);
      await driver.run('INSERT INTO ledger_account_routes (username, replica_id, created_at) VALUES (?, ?, ?)',
        [username, route.replica_id, at]);
      await driver.run(`INSERT INTO federated_account_bindings
        (local_username, issuer_node_id, subject_account_id, ledger_id, created_at, verified_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [username, issuerNodeId, subjectAccountId, route.ledger_id, at, at]);
      await this.rebuildAccountLedgerIndex(driver, route.replica_id, control);
      return username;
    });
  }

  async listNodeReplicationLinks(username?: string, includeDisabled = username !== undefined): Promise<NodeReplicationLink[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(
      username ? 'SELECT * FROM node_replication_links WHERE username = ? ORDER BY created_at'
        : includeDisabled ? 'SELECT * FROM node_replication_links ORDER BY created_at'
          : 'SELECT * FROM node_replication_links WHERE enabled = 1 ORDER BY created_at',
      username ? [username] : [],
    );
    return rows.map((row) => this.nodeLinkFromRow(row));
  }

  async passiveGroupSourceLink(link: NodeReplicationLink): Promise<boolean> {
    await this.ready;
    const group = await this.serverSyncGroup();
    if (group?.role !== 'main') return false;
    const binding = await this.federatedAccount(link.username);
    if (binding?.issuerNodeId !== link.peerNodeId) return false;
    return (await this.serverSyncGroupMembers()).some((member) =>
      member.nodeId === link.peerNodeId && member.publicKey === link.peerPublicKey);
  }

  async pendingNodeRevocations(): Promise<NodeReplicationLink[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(`SELECT * FROM node_replication_links
      WHERE enabled = 0 AND revocation_pending = 1 ORDER BY updated_at LIMIT 100`);
    return rows.map((row) => this.nodeLinkFromRow(row));
  }

  async listReplicaSlots(): Promise<{ username: string; ledgerId: string }[]> {
    await this.ready;
    const rows = await this.driver.all<{ username: string; ledger_id: string }>(
      'SELECT username, ledger_id FROM sync_replicas ORDER BY username, ledger_id');
    return rows.map((row) => ({ username: row.username, ledgerId: row.ledger_id }));
  }

  async replicaPhysicalStatus(username: string, ledgerId: string): Promise<ReplicaPhysicalStatus> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM replica_physical_status WHERE username = ? AND ledger_id = ?', [username, ledgerId]);
    return row ? {
      ...(row['blob_hash'] ? { blobHash: String(row['blob_hash']) } : {}),
      ...(row['verified_at'] ? { verifiedAt: String(row['verified_at']) } : {}),
      ...(row['scanned_at'] ? { scannedAt: String(row['scanned_at']) } : {}),
      ...(row['issue'] ? { issue: String(row['issue']) } : {}),
    } : {};
  }

  async recordReplicaPhysicalStatus(username: string, ledgerId: string, blobHash: string, issue?: string,
    expected?: Pick<UserReplica, 'replicaId' | 'streamEpoch'>): Promise<void> {
    await this.ready;
    if (!/^[a-f0-9]{64}$/.test(blobHash)) throw new ServerStoreError('INVALID_INVENTORY_HASH', 400, '副本目录哈希无效');
    const at = nowIso();
    await this.driver.transaction(async (driver) => {
      if (expected) {
        const current = await driver.get<{ replica_id: string; stream_epoch: string }>(`
          SELECT slot.replica_id, slot.stream_epoch FROM ledger_account_routes route
          JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
          WHERE route.username = ? AND slot.ledger_id = ?`, [username, ledgerId]);
        if (!current || current.replica_id !== expected.replicaId
          || current.stream_epoch !== expected.streamEpoch) {
          throw new ServerStoreError('REPLICA_CHANGED', 409, '物理校验期间账本副本已改变');
        }
      }
      await driver.run(`INSERT INTO replica_physical_status
        (username, ledger_id, blob_hash, verified_at, scanned_at, issue) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (username, ledger_id) DO UPDATE SET blob_hash = excluded.blob_hash,
          verified_at = excluded.verified_at, scanned_at = excluded.scanned_at, issue = excluded.issue`,
      [username, ledgerId, blobHash, issue ? null : at, at, issue ?? null]);
      await driver.run(`UPDATE node_replication_links SET physical_blob_hash = ?, physical_verified_at = ?,
        physical_scanned_at = ?, physical_issue = ?, lifecycle_state = 'VERIFYING',
        lifecycle_checked_at = ?, updated_at = ?
        WHERE username = ? AND ledger_id = ? AND enabled = 1`,
      [blobHash, issue ? null : at, at, issue ?? null, at, at, username, ledgerId]);
    });
  }

  async invalidateReplicaPhysicalStatus(username: string, ledgerId: string): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      await driver.run(`UPDATE replica_physical_status SET blob_hash = NULL, verified_at = NULL,
        scanned_at = NULL, issue = NULL WHERE username = ? AND ledger_id = ?`, [username, ledgerId]);
      await driver.run(`UPDATE node_replication_links SET physical_blob_hash = NULL,
        physical_verified_at = NULL, physical_scanned_at = NULL, physical_issue = NULL,
        lifecycle_state = 'VERIFYING', lifecycle_checked_at = ?, updated_at = ?
        WHERE username = ? AND ledger_id = ? AND enabled = 1`,
      [nowIso(), nowIso(), username, ledgerId]);
    });
  }

  async recordReplicaPhysicalFailure(username: string, ledgerId: string, issue: string): Promise<void> {
    await this.ready;
    const at = nowIso();
    const detail = issue.slice(0, 400);
    await this.driver.transaction(async (driver) => {
      await driver.run(`INSERT INTO replica_physical_status
        (username, ledger_id, blob_hash, verified_at, scanned_at, issue) VALUES (?, ?, NULL, NULL, ?, ?)
        ON CONFLICT (username, ledger_id) DO UPDATE SET blob_hash = NULL,
          verified_at = NULL, scanned_at = excluded.scanned_at, issue = excluded.issue`,
      [username, ledgerId, at, detail]);
      await driver.run(`UPDATE node_replication_links SET physical_blob_hash = NULL,
        physical_verified_at = NULL, physical_scanned_at = ?, physical_issue = ?,
        lifecycle_state = 'VERIFYING', lifecycle_checked_at = ?, updated_at = ?
        WHERE username = ? AND ledger_id = ? AND enabled = 1`,
      [at, detail, at, at, username, ledgerId]);
    });
  }

  /** A consistent SQLite snapshot of the logical replica catalog, independent of local sequence order. */
  async replicaInventory(username: string, ledgerId: string, replicaId?: string): Promise<NodeReplicaInventory> {
    await this.ready;
    const scopedReplicaId = replicaId ?? (await this.getReplicaForLedger(username, ledgerId))?.replicaId;
    if (!scopedReplicaId) throw new ServerStoreError('REPLICA_INCOMPLETE', 409, '账本副本或密钥包缺失');
    return this.driver.transaction(async (driver) => {
      const replica = await driver.get<{ replica_id: string; stream_epoch: string; head_seq: number;
        account_id: string }>(`
        SELECT slot.replica_id, slot.stream_epoch, slot.head_seq, i.account_id
        FROM account_ledger_index route
        JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
        JOIN sync_account_identities i ON i.username = route.username
        WHERE route.username = ? AND slot.ledger_id = ? AND slot.replica_id = ?`,
      [username, ledgerId, scopedReplicaId]);
      if (!replica) throw new ServerStoreError('REPLICA_INCOMPLETE', 409, '账本副本或密钥包缺失');
      const key = await driver.get<{ keyring_id: string; generation: number; envelope_json: string }>(
        `SELECT keyring_id, generation, envelope_json FROM ledger_replica_key_envelopes
         WHERE replica_id = ? AND ledger_id = ?`, [replica.replica_id, ledgerId]);
      if (!key) throw new ServerStoreError('REPLICA_INCOMPLETE', 409, '账本副本或密钥包缺失');
      const binding = await driver.get<{ issuer_node_id: string; subject_account_id: string }>(
        'SELECT issuer_node_id, subject_account_id FROM federated_account_bindings WHERE local_username = ? AND ledger_id = ?', [username, ledgerId]);
      const issuerNodeId = binding?.issuer_node_id ?? this.serverId;
      const subjectAccountId = binding?.subject_account_id ?? replica.account_id;
      const accountKey = await driver.get<{ public_key: string; envelope_json: string; revision: number }>(
        'SELECT public_key, envelope_json, revision FROM account_encryption_keys WHERE issuer_node_id = ? AND subject_account_id = ?',
        [issuerNodeId, subjectAccountId]);
      const requirements = await driver.all<{ capability: string }>(
        `SELECT capability FROM ledger_replica_requirements
         WHERE replica_id = ? ORDER BY capability`, [replica.replica_id]);
      const scan = async (sql: string, fields: string[], scopeParams: string[]): Promise<{ count: number; digest: string }> => {
        const hash = createHash('sha256');
        let after = '';
        let count = 0;
        while (true) {
          const rows = await driver.all<Record<string, unknown>>(sql, [...scopeParams, after, 500]);
          for (const row of rows) {
            hash.update(JSON.stringify(fields.map((field) => field.endsWith('_json')
              ? canonicalJson(JSON.parse(String(row[field]))) : row[field])));
            hash.update('\n');
            after = String(row['blob_id'] ?? row['commit_id']);
            count += 1;
          }
          if (rows.length < 500) break;
        }
        return { count, digest: hash.digest('hex') };
      };
      const commits = await commitCatalogDigest(driver, replica.replica_id);
      const storedCommits = await driver.get<{ count: number; first_seq: number | null;
        last_seq: number | null; wrong_ledger: number }>(`SELECT COUNT(*) AS count,
          MIN(seq) AS first_seq, MAX(seq) AS last_seq,
          COALESCE(SUM(CASE WHEN ledger_id <> ? THEN 1 ELSE 0 END), 0) AS wrong_ledger
          FROM ledger_replica_commits WHERE replica_id = ?`, [ledgerId, replica.replica_id]);
      const blobScope = '(ledger_id = ? AND (replica_id = ? OR (replica_id IS NULL AND username = ?)))';
      const blobParams = [ledgerId, replica.replica_id, username];
      const blobs = await scan(`SELECT blob_id, manifest_json FROM blob_objects
        WHERE ${blobScope} AND state = 'available'
          AND json_extract(manifest_json, '$.v') = 2 AND blob_id > ? ORDER BY blob_id LIMIT ?`,
      ['blob_id', 'manifest_json'], blobParams);
      const states = await scan(`SELECT blob_id, state, counter, writer_node_id FROM blob_replica_states
        WHERE ${blobScope} AND blob_id > ? ORDER BY blob_id LIMIT ?`,
      ['blob_id', 'state', 'counter', 'writer_node_id'], blobParams);
      const [trash, legacy] = await Promise.all([
        driver.get<{ count: number }>(`SELECT COUNT(*) AS count FROM blob_replica_states
          WHERE ${blobScope} AND state = 'trash'`, blobParams),
        driver.get<{ count: number }>(`SELECT COUNT(*) AS count FROM blob_objects
          WHERE ${blobScope} AND state = 'available' AND json_extract(manifest_json, '$.v') = 1
            AND NOT EXISTS (SELECT 1 FROM ledger_backup_archives archive
              WHERE archive.username = blob_objects.username
                AND archive.ledger_id = blob_objects.ledger_id
                AND (blob_objects.replica_id IS NULL OR archive.replica_id = blob_objects.replica_id)
                AND archive.blob_id = blob_objects.blob_id)`, blobParams),
      ]);
      const rejected = await driver.get<{ count: number }>(`SELECT COUNT(*) AS count
        FROM ledger_replica_rejected_commits rejected LEFT JOIN ledger_control_resolutions resolution
          ON resolution.replica_id = rejected.replica_id
            AND resolution.rejected_commit_id = rejected.commit_id
            AND resolution.rejected_content_hash = rejected.content_hash
        WHERE rejected.replica_id = ? AND resolution.rejected_commit_id IS NULL`,
      [replica.replica_id]);
      const pendingRepairs = await driver.get<{ count: number }>(`SELECT COUNT(*) AS count
        FROM ledger_control_resolutions resolution LEFT JOIN ledger_replica_commits replacement
          ON replacement.replica_id = resolution.replica_id
            AND replacement.commit_id = resolution.replacement_commit_id
            AND replacement.content_hash = resolution.replacement_content_hash
            AND replacement.key_epoch = resolution.key_epoch
            AND replacement.writer_issuer_node_id = resolution.actor_issuer_node_id
            AND replacement.writer_account_id = resolution.actor_account_id
        WHERE resolution.replica_id = ? AND resolution.decision = 'replay'
          AND replacement.commit_id IS NULL`, [replica.replica_id]);
      const promise = await driver.get<{ commit_count: number; commit_hash: string;
        blob_count: number; blob_hash: string }>(
        'SELECT commit_count, commit_hash, blob_count, blob_hash FROM ledger_attachment_promises WHERE replica_id = ?',
        [replica.replica_id]);
      const missingPromise = promise ? await driver.get<{ count: number }>(`
        SELECT COUNT(*) AS count FROM ledger_attachment_promise_items required
        WHERE required.replica_id = ? AND NOT EXISTS (
          SELECT 1 FROM blob_objects object WHERE object.ledger_id = ?
            AND object.blob_id = required.blob_id AND object.state = 'available'
            AND json_extract(object.manifest_json, '$.v') = 2
            AND (object.replica_id = ? OR (object.replica_id IS NULL AND object.username = ?))
        )`, [replica.replica_id, ledgerId, replica.replica_id, username]) : undefined;
      const control = await this.readLedgerControlState(driver, replica.replica_id);
      const memberRows = control ? await driver.all<{ issuer_node_id: string; account_id: string; envelope_json: string }>(`
        SELECT issuer_node_id, account_id, envelope_json FROM ledger_member_key_envelopes
        WHERE replica_id = ? AND key_epoch = ? ORDER BY issuer_node_id, account_id`,
      [replica.replica_id, control.keyEpoch]) : [];
      const memberHash = createHash('sha256');
      let memberEnvelopeCount = 0;
      const covered = new Set<string>();
      for (const row of memberRows) {
        const id = `${row.issuer_node_id}/${row.account_id}`;
        const member = control?.members[id];
        if (!member || member.removed) continue;
        const envelope = JSON.parse(row.envelope_json) as LedgerMemberKeyEnvelope;
        if (envelope.recipientPublicKey !== member.encryptionPublicKey
          || envelope.ledgerId !== ledgerId || envelope.keyringId !== key.keyring_id) continue;
        memberHash.update(canonicalJson(envelope));
        memberHash.update('\n');
        covered.add(id);
        memberEnvelopeCount += 1;
      }
      const activeMemberCount = control ? Object.values(control.members).filter((member) => !member.removed).length : 0;
      const memberKeyHash = createHash('sha256');
      let memberAccountKeyCount = 0;
      let missingMemberAccountKeyCount = 0;
      let memberAccountCount = 0;
      for (const member of Object.values(control?.members ?? {})
        .filter((entry) => !entry.removed)
        .sort((left, right) => `${left.issuerNodeId}/${left.accountId}`.localeCompare(`${right.issuerNodeId}/${right.accountId}`))) {
        const account = await driver.get(`SELECT 1 FROM account_ledger_index membership
          JOIN sync_account_identities identity ON identity.username = membership.username
          JOIN sync_users user ON user.username = membership.username AND user.disabled = 0
          LEFT JOIN federated_account_bindings binding ON binding.local_username = membership.username
          WHERE membership.replica_id = ? AND (
            binding.issuer_node_id = ? AND binding.subject_account_id = ?
            OR binding.local_username IS NULL AND ? = ? AND identity.account_id = ?)
          LIMIT 1`, [replica.replica_id, member.issuerNodeId, member.accountId,
          member.issuerNodeId, this.serverId, member.accountId]);
        if (account) memberAccountCount += 1;
        const record = await driver.get<{ public_key: string; envelope_json: string; revision: number }>(
          'SELECT public_key, envelope_json, revision FROM account_encryption_keys WHERE issuer_node_id = ? AND subject_account_id = ?',
          [member.issuerNodeId, member.accountId]);
        if (!record || record.public_key !== member.encryptionPublicKey) {
          missingMemberAccountKeyCount += 1;
          continue;
        }
        memberKeyHash.update(canonicalJson({ issuerNodeId: member.issuerNodeId,
          accountId: member.accountId, publicKey: record.public_key,
          revision: Number(record.revision), envelope: JSON.parse(record.envelope_json) }));
        memberKeyHash.update('\n');
        memberAccountKeyCount += 1;
      }
      return {
        serverId: this.serverId, replicaId: replica.replica_id, streamEpoch: replica.stream_epoch, ledgerId,
        issuerNodeId, subjectAccountId,
        accountKeyHash: createHash('sha256').update(canonicalJson(accountKey ? {
          publicKey: accountKey.public_key, revision: Number(accountKey.revision),
          envelope: JSON.parse(accountKey.envelope_json),
        } : null)).digest('hex'),
        keyringId: key.keyring_id, keyGeneration: Number(key.generation),
        keyEnvelopeHash: createHash('sha256').update(canonicalJson(JSON.parse(key.envelope_json))).digest('hex'),
        controlSeq: control?.seq ?? 0,
        controlHash: control?.headHash ?? createHash('sha256').update('no-ledger-control-v1').digest('hex'),
        keyEpoch: control?.keyEpoch ?? 0,
        memberEnvelopeCount, memberEnvelopeHash: memberHash.digest('hex'),
        missingMemberEnvelopeCount: activeMemberCount - covered.size,
        memberAccountKeyCount, memberAccountKeyHash: memberKeyHash.digest('hex'),
        missingMemberAccountKeyCount,
        memberAccountCount, missingMemberAccountCount: activeMemberCount - memberAccountCount,
        requirementsHash: createHash('sha256').update(canonicalJson(requirements.map((row) => row.capability))).digest('hex'),
        commitCount: commits.count, commitHash: commits.digest,
        commitStreamComplete: Number(storedCommits?.count) === Number(replica.head_seq)
          && Number(storedCommits?.wrong_ledger) === 0
          && (Number(replica.head_seq) === 0 || Number(storedCommits?.first_seq) === 1
            && Number(storedCommits?.last_seq) === Number(replica.head_seq)) ? 1 : 0,
        attachmentPromisePresent: promise ? 1 : 0,
        attachmentPromiseCurrent: promise?.commit_count === commits.count
          && promise.commit_hash === commits.digest ? 1 : 0,
        promisedBlobCount: promise?.blob_count ?? 0,
        promisedBlobHash: promise?.blob_hash ?? createHash('sha256').digest('hex'),
        missingPromisedBlobCount: Number(missingPromise?.count ?? 0),
        rejectedCommitCount: Number(rejected?.count ?? 0) + Number(pendingRepairs?.count ?? 0),
        blobCount: blobs.count, blobHash: blobs.digest,
        tombstoneCount: Number(trash?.count ?? 0), stateHash: states.digest,
        legacyBlobCount: Number(legacy?.count ?? 0),
      };
    });
  }

  /** Start a paged attachment reference claim at the server's current logical commit frontier. */
  async beginAttachmentPromise(username: string, expectedCount: number,
    replicaId?: string): Promise<AttachmentPromiseUpload> {
    await this.ready;
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > 10_000_000) {
      throw new ServerStoreError('INVALID_ATTACHMENT_PROMISE', 400, '附件承诺数量无效');
    }
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账本副本不存在');
    return this.driver.transaction(async (driver) => {
      await this.assertLedgerAccessOnReplica(driver, username, replica.replicaId, 'write');
      const commits = await commitCatalogDigest(driver, replica.replicaId);
      const upload: AttachmentPromiseUpload = {
        uploadId: randomBytes(16).toString('hex'), commitCount: commits.count,
        commitHash: commits.digest, expectedCount, receivedCount: 0, lastBlobId: '',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
      await driver.run('DELETE FROM ledger_attachment_promise_uploads WHERE expires_at <= ?', [nowIso()]);
      await driver.run(`INSERT INTO ledger_attachment_promise_uploads
        (upload_id, replica_id, username, commit_count, commit_hash, expected_count,
          received_count, last_blob_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, 0, '', ?)`,
      [upload.uploadId, replica.replicaId, username, upload.commitCount, upload.commitHash,
        expectedCount, upload.expiresAt]);
      return upload;
    });
  }

  /** A peer resumes the same bounded upload after reconnecting; the signed source is pinned. */
  async beginReplicatedAttachmentPromise(username: string, sourceNodeId: string,
    catalog: Pick<AttachmentPromiseCatalog, 'commitCount' | 'commitHash' | 'blobCount' | 'blobHash'>,
    replicaId?: string): Promise<AttachmentPromiseUpload | null> {
    await this.ready;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sourceNodeId)
      || !Number.isSafeInteger(catalog.commitCount) || catalog.commitCount < 0
      || !Number.isSafeInteger(catalog.blobCount) || catalog.blobCount < 0 || catalog.blobCount > 10_000_000
      || !/^[a-f0-9]{64}$/.test(catalog.commitHash) || !/^[a-f0-9]{64}$/.test(catalog.blobHash)) {
      throw new ServerStoreError('INVALID_ATTACHMENT_PROMISE', 400, '节点附件承诺目录无效');
    }
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账本副本不存在');
    return this.driver.transaction(async (driver) => {
      await this.assertLedgerAccessOnReplica(driver, username, replica.replicaId, 'write');
      const commits = await commitCatalogDigest(driver, replica.replicaId);
      if (commits.count !== catalog.commitCount || commits.digest !== catalog.commitHash) {
        throw new ServerStoreError('ATTACHMENT_PROMISE_STALE', 409, '节点提交目录尚未收敛');
      }
      const existing = await driver.get<{ commit_count: number; commit_hash: string;
        blob_count: number; blob_hash: string }>(
        'SELECT * FROM ledger_attachment_promises WHERE replica_id = ?', [replica.replicaId]);
      if (existing?.commit_count === catalog.commitCount && existing.commit_hash === catalog.commitHash) {
        if (existing.blob_count !== catalog.blobCount || existing.blob_hash !== catalog.blobHash) {
          throw new ServerStoreError('ATTACHMENT_PROMISE_CONFLICT', 409, '同一提交前沿已有不同附件承诺目录');
        }
        return null;
      }
      await driver.run('DELETE FROM ledger_attachment_promise_uploads WHERE expires_at <= ?', [nowIso()]);
      const staged = await driver.get<Record<string, unknown>>(`SELECT * FROM ledger_attachment_promise_uploads
        WHERE replica_id = ? AND username = ? AND source_node_id = ? AND commit_count = ?
          AND commit_hash = ? AND expected_count = ? AND expected_blob_hash = ? AND expires_at > ?
        ORDER BY expires_at DESC LIMIT 1`,
      [replica.replicaId, username, sourceNodeId, catalog.commitCount, catalog.commitHash,
        catalog.blobCount, catalog.blobHash, nowIso()]);
      if (staged) return {
        uploadId: String(staged['upload_id']), commitCount: catalog.commitCount,
        commitHash: catalog.commitHash, expectedCount: catalog.blobCount,
        receivedCount: Number(staged['received_count']), lastBlobId: String(staged['last_blob_id']),
        expiresAt: String(staged['expires_at']),
      };
      const upload: AttachmentPromiseUpload = {
        uploadId: randomBytes(16).toString('hex'), commitCount: catalog.commitCount,
        commitHash: catalog.commitHash, expectedCount: catalog.blobCount, receivedCount: 0,
        lastBlobId: '', expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
      await driver.run(`INSERT INTO ledger_attachment_promise_uploads
        (upload_id, replica_id, username, source_node_id, commit_count, commit_hash,
          expected_count, expected_blob_hash, received_count, last_blob_id, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?)`,
      [upload.uploadId, replica.replicaId, username, sourceNodeId, catalog.commitCount,
        catalog.commitHash, catalog.blobCount, catalog.blobHash, upload.expiresAt]);
      return upload;
    });
  }

  async attachmentPromiseUpload(username: string, uploadId: string,
    replicaId?: string, sourceNodeId?: string): Promise<AttachmentPromiseUpload | undefined> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (!replica) return;
    await this.assertLedgerAccessOnReplica(this.driver, username, replica.replicaId, 'write');
    const row = await this.driver.get<Record<string, unknown>>(`SELECT * FROM ledger_attachment_promise_uploads
      WHERE upload_id = ? AND replica_id = ? AND username = ? AND source_node_id IS ? AND expires_at > ?`,
    [uploadId, replica.replicaId, username, sourceNodeId ?? null, nowIso()]);
    return row ? {
      uploadId, commitCount: Number(row['commit_count']), commitHash: String(row['commit_hash']),
      expectedCount: Number(row['expected_count']), receivedCount: Number(row['received_count']),
      lastBlobId: String(row['last_blob_id']), expiresAt: String(row['expires_at']),
    } : undefined;
  }

  async appendAttachmentPromisePage(username: string, uploadId: string, blobIds: string[],
    replicaId?: string, sourceNodeId?: string): Promise<AttachmentPromiseUpload> {
    await this.ready;
    if (!Array.isArray(blobIds) || blobIds.length < 1 || blobIds.length > 2000
      || blobIds.some((blobId) => typeof blobId !== 'string' || !/^[a-f0-9]{64}$/.test(blobId))) {
      throw new ServerStoreError('INVALID_ATTACHMENT_PROMISE_PAGE', 400, '附件承诺页面无效');
    }
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账本副本不存在');
    return this.driver.transaction(async (driver) => {
      await this.assertLedgerAccessOnReplica(driver, username, replica.replicaId, 'write');
      const row = await driver.get<Record<string, unknown>>(`SELECT * FROM ledger_attachment_promise_uploads
        WHERE upload_id = ? AND replica_id = ? AND username = ? AND source_node_id IS ? AND expires_at > ?`,
      [uploadId, replica.replicaId, username, sourceNodeId ?? null, nowIso()]);
      if (!row) throw new ServerStoreError('ATTACHMENT_PROMISE_UPLOAD_MISSING', 404, '附件承诺上传已过期或不存在');
      let last = String(row['last_blob_id']);
      for (const blobId of blobIds) {
        if (blobId <= last) throw new ServerStoreError('INVALID_ATTACHMENT_PROMISE_PAGE', 409, '附件承诺必须按对象 ID 严格递增');
        last = blobId;
      }
      const receivedCount = Number(row['received_count']) + blobIds.length;
      if (receivedCount > Number(row['expected_count'])) {
        throw new ServerStoreError('INVALID_ATTACHMENT_PROMISE_PAGE', 409, '附件承诺超过声明数量');
      }
      for (const blobId of blobIds) {
        await driver.run('INSERT INTO ledger_attachment_promise_upload_items (upload_id, blob_id) VALUES (?, ?)',
          [uploadId, blobId]);
      }
      await driver.run(`UPDATE ledger_attachment_promise_uploads
        SET received_count = ?, last_blob_id = ? WHERE upload_id = ?`, [receivedCount, last, uploadId]);
      return {
        uploadId, commitCount: Number(row['commit_count']), commitHash: String(row['commit_hash']),
        expectedCount: Number(row['expected_count']), receivedCount, lastBlobId: last,
        expiresAt: String(row['expires_at']),
      };
    });
  }

  /** Publish only a complete, current frontier; a conflicting claim never silently wins. */
  async completeAttachmentPromise(username: string, uploadId: string,
    replicaId?: string, sourceNodeId?: string): Promise<AttachmentPromiseCatalog> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账本副本不存在');
    return this.driver.transaction(async (driver) => {
      await this.assertLedgerAccessOnReplica(driver, username, replica.replicaId, 'write');
      const row = await driver.get<Record<string, unknown>>(`SELECT * FROM ledger_attachment_promise_uploads
        WHERE upload_id = ? AND replica_id = ? AND username = ? AND source_node_id IS ? AND expires_at > ?`,
      [uploadId, replica.replicaId, username, sourceNodeId ?? null, nowIso()]);
      if (!row) throw new ServerStoreError('ATTACHMENT_PROMISE_UPLOAD_MISSING', 404, '附件承诺上传已过期或不存在');
      const expectedCount = Number(row['expected_count']);
      if (Number(row['received_count']) !== expectedCount) {
        throw new ServerStoreError('ATTACHMENT_PROMISE_INCOMPLETE', 409, '附件承诺页面尚未传完');
      }
      const commits = await commitCatalogDigest(driver, replica.replicaId);
      if (commits.count !== Number(row['commit_count']) || commits.digest !== row['commit_hash']) {
        throw new ServerStoreError('ATTACHMENT_PROMISE_STALE', 409, '上传期间账本提交发生变化，请重新核对附件引用');
      }
      const hash = createHash('sha256');
      let after = '';
      let count = 0;
      while (true) {
        const page = await driver.all<{ blob_id: string }>(`SELECT blob_id FROM ledger_attachment_promise_upload_items
          WHERE upload_id = ? AND blob_id > ? ORDER BY blob_id LIMIT 500`, [uploadId, after]);
        for (const item of page) {
          hash.update(item.blob_id);
          hash.update('\n');
          after = item.blob_id;
          count += 1;
        }
        if (page.length < 500) break;
      }
      if (count !== expectedCount) throw new ServerStoreError('ATTACHMENT_PROMISE_INCOMPLETE', 409, '附件承诺目录数量不一致');
      const blobHash = hash.digest('hex');
      if (row['expected_blob_hash'] != null && row['expected_blob_hash'] !== blobHash) {
        throw new ServerStoreError('ATTACHMENT_PROMISE_HASH_MISMATCH', 409, '节点附件承诺摘要不匹配');
      }
      const existing = await driver.get<{ commit_count: number; commit_hash: string; blob_count: number;
        blob_hash: string; published_at: string }>(
        'SELECT * FROM ledger_attachment_promises WHERE replica_id = ?', [replica.replicaId]);
      if (existing && (existing.commit_count > commits.count
        || existing.commit_count === commits.count && (existing.commit_hash !== commits.digest
          || existing.blob_count !== count || existing.blob_hash !== blobHash))) {
        throw new ServerStoreError('ATTACHMENT_PROMISE_CONFLICT', 409, '同一提交前沿已有不同附件承诺目录');
      }
      if (existing?.commit_count === commits.count) {
        await driver.run('DELETE FROM ledger_attachment_promise_uploads WHERE upload_id = ?', [uploadId]);
        return { commitCount: existing.commit_count, commitHash: existing.commit_hash,
          blobCount: existing.blob_count, blobHash: existing.blob_hash, publishedAt: existing.published_at };
      }
      const publishedAt = nowIso();
      await driver.run('DELETE FROM ledger_attachment_promise_items WHERE replica_id = ?', [replica.replicaId]);
      await driver.run(`INSERT INTO ledger_attachment_promises
        (replica_id, commit_count, commit_hash, blob_count, blob_hash, published_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (replica_id) DO UPDATE SET commit_count = excluded.commit_count,
          commit_hash = excluded.commit_hash, blob_count = excluded.blob_count,
          blob_hash = excluded.blob_hash, published_at = excluded.published_at`,
      [replica.replicaId, commits.count, commits.digest, count, blobHash, publishedAt]);
      await driver.run(`INSERT INTO ledger_attachment_promise_items (replica_id, blob_id)
        SELECT ?, blob_id FROM ledger_attachment_promise_upload_items WHERE upload_id = ?`,
      [replica.replicaId, uploadId]);
      await driver.run('DELETE FROM ledger_attachment_promise_uploads WHERE upload_id = ?', [uploadId]);
      return { commitCount: commits.count, commitHash: commits.digest,
        blobCount: count, blobHash, publishedAt };
    });
  }

  async attachmentPromisePage(username: string, after = '', limit = 2000,
    replicaId?: string): Promise<{ catalog: AttachmentPromiseCatalog | null;
      blobIds: string[]; nextId: string; hasMore: boolean }> {
    await this.ready;
    if (after && !/^[a-f0-9]{64}$/.test(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
      throw new ServerStoreError('INVALID_ATTACHMENT_PROMISE_PAGE', 400, '附件承诺游标或页面大小无效');
    }
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账本副本不存在');
    return this.driver.transaction(async (driver) => {
      await this.assertLedgerAccessOnReplica(driver, username, replica.replicaId, 'read');
      const row = await driver.get<{ commit_count: number; commit_hash: string; blob_count: number;
        blob_hash: string; published_at: string }>(
        'SELECT * FROM ledger_attachment_promises WHERE replica_id = ?', [replica.replicaId]);
      if (!row) return { catalog: null, blobIds: [], nextId: after, hasMore: false };
      const ids = await driver.all<{ blob_id: string }>(`SELECT blob_id FROM ledger_attachment_promise_items
        WHERE replica_id = ? AND blob_id > ? ORDER BY blob_id LIMIT ?`, [replica.replicaId, after, limit + 1]);
      const blobIds = ids.slice(0, limit).map((item) => item.blob_id);
      return {
        catalog: { commitCount: row.commit_count, commitHash: row.commit_hash,
          blobCount: row.blob_count, blobHash: row.blob_hash, publishedAt: row.published_at },
        blobIds, nextId: blobIds.at(-1) ?? after, hasMore: ids.length > limit,
      };
    });
  }

  /** Commits are append-only, so the validated claim stays current until head_seq advances. */
  async attachmentPromiseIsCurrent(username: string, replicaId?: string): Promise<boolean> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (!replica) return false;
    const row = await this.driver.get<{ commit_count: number }>(
      'SELECT commit_count FROM ledger_attachment_promises WHERE replica_id = ?', [replica.replicaId]);
    return row?.commit_count === replica.headSeq;
  }

  async updateNodeReplicationLink(linkId: string, update: { pullSeq?: number; pushSeq?: number; pullBlobCursor?: string; pushBlobCursor?: string;
    pullStateCursor?: string; pushStateCursor?: string; pullStateSwept?: boolean; pushStateSwept?: boolean;
    pullMemberCursor?: string; pushMemberCursor?: string; memberEpoch?: number;
    peerHeadSeq?: number; localHeadSeq?: number; peerBlobObjects?: number; localBlobObjects?: number;
    peerBlobBytes?: number; localBlobBytes?: number; pullBlobScannedBytes?: number; pushBlobScannedBytes?: number;
    pullBlobTransferredBytes?: number; pushBlobTransferredBytes?: number;
    peerLegacyObjects?: number; localLegacyObjects?: number; peerTombstones?: number; localTombstones?: number;
    pullBlobSwept?: boolean; pushBlobSwept?: boolean;
    inventoryMatched?: boolean; inventoryIssue?: string | null; inventoryBlobHash?: string;
    error?: string | null }): Promise<void> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM node_replication_links WHERE link_id = ? AND enabled = 1', [linkId]);
    if (!row) return;
    const link = this.nodeLinkFromRow(row);
    const pullSeq = update.pullSeq ?? link.pullSeq;
    const pushSeq = update.pushSeq ?? link.pushSeq;
    if (!Number.isSafeInteger(pullSeq) || pullSeq < link.pullSeq || !Number.isSafeInteger(pushSeq) || pushSeq < link.pushSeq) {
      throw new ServerStoreError('INVALID_CURSOR', 400, '复制游标不能倒退');
    }
    const pullBlobCursor = update.pullBlobCursor ?? link.pullBlobCursor;
    const pushBlobCursor = update.pushBlobCursor ?? link.pushBlobCursor;
    const pullStateCursor = update.pullStateCursor ?? link.pullStateCursor;
    const pushStateCursor = update.pushStateCursor ?? link.pushStateCursor;
    const memberEpoch = update.memberEpoch ?? link.memberEpoch;
    const pullMemberCursor = update.pullMemberCursor ?? (memberEpoch > link.memberEpoch ? '' : link.pullMemberCursor);
    const pushMemberCursor = update.pushMemberCursor ?? (memberEpoch > link.memberEpoch ? '' : link.pushMemberCursor);
    if ([pullBlobCursor, pushBlobCursor, pullStateCursor, pushStateCursor].some((cursor) => cursor && !/^[a-f0-9]{64}$/.test(cursor))) {
      throw new ServerStoreError('INVALID_CURSOR', 400, '附件复制游标无效');
    }
    if (!Number.isSafeInteger(memberEpoch) || memberEpoch < link.memberEpoch
      || [pullMemberCursor, pushMemberCursor].some((cursor) => cursor
        && !/^[A-Za-z0-9_-]{8,160}\/[A-Za-z0-9_-]{8,160}$/.test(cursor))) {
      throw new ServerStoreError('INVALID_CURSOR', 400, '成员密钥复制游标无效');
    }
    const at = nowIso();
    const lifecycleState = link.lifecycleState === 'JOINING'
      && (update.error === undefined || update.error === null)
      ? 'BOOTSTRAPPING' : link.lifecycleState === 'READY' ? 'VERIFYING' : link.lifecycleState;
    const counters = [update.peerHeadSeq ?? link.peerHeadSeq, update.localHeadSeq ?? link.localHeadSeq,
      update.peerBlobObjects ?? link.peerBlobObjects, update.localBlobObjects ?? link.localBlobObjects,
      update.peerBlobBytes ?? link.peerBlobBytes, update.localBlobBytes ?? link.localBlobBytes,
      update.pullBlobScannedBytes ?? link.pullBlobScannedBytes, update.pushBlobScannedBytes ?? link.pushBlobScannedBytes,
      update.pullBlobTransferredBytes ?? link.pullBlobTransferredBytes,
      update.pushBlobTransferredBytes ?? link.pushBlobTransferredBytes,
      update.peerLegacyObjects ?? link.peerLegacyObjects, update.localLegacyObjects ?? link.localLegacyObjects,
      update.peerTombstones ?? link.peerTombstones, update.localTombstones ?? link.localTombstones];
    if (counters.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new ServerStoreError('INVALID_REPLICATION_STATUS', 400, '复制进度无效');
    await this.driver.run(`UPDATE node_replication_links SET pull_seq = ?, push_seq = ?, pull_blob_cursor = ?, push_blob_cursor = ?,
      pull_state_cursor = ?, push_state_cursor = ?, pull_member_cursor = ?, push_member_cursor = ?, member_epoch = ?,
      peer_head_seq = ?, local_head_seq = ?, peer_blob_objects = ?, local_blob_objects = ?,
      peer_blob_bytes = ?, local_blob_bytes = ?, pull_blob_scanned_bytes = ?, push_blob_scanned_bytes = ?,
      pull_blob_transferred_bytes = COALESCE(?, pull_blob_transferred_bytes),
      push_blob_transferred_bytes = COALESCE(?, push_blob_transferred_bytes),
      peer_legacy_objects = ?, local_legacy_objects = ?,
      peer_tombstones = ?, local_tombstones = ?,
      pull_blob_sweep_at = ?, push_blob_sweep_at = ?, pull_state_sweep_at = ?, push_state_sweep_at = ?,
      inventory_matched_at = ?, inventory_issue = ?, inventory_blob_hash = ?,
       last_error = ?, last_success_at = ?, lifecycle_state = ?, lifecycle_checked_at = ?,
       updated_at = ? WHERE link_id = ? AND enabled = 1`,
    [pullSeq, pushSeq, pullBlobCursor, pushBlobCursor, pullStateCursor, pushStateCursor,
      pullMemberCursor, pushMemberCursor, memberEpoch, ...counters.slice(0, 8),
      update.pullBlobTransferredBytes ?? null, update.pushBlobTransferredBytes ?? null,
      ...counters.slice(10),
      update.pullBlobSwept ? at : link.pullBlobSweepAt ?? null, update.pushBlobSwept ? at : link.pushBlobSweepAt ?? null,
      update.pullStateSwept ? at : link.pullStateSweepAt ?? null, update.pushStateSwept ? at : link.pushStateSweepAt ?? null,
      update.inventoryMatched ? at : link.inventoryMatchedAt ?? null,
      update.inventoryIssue === undefined ? link.inventoryIssue ?? null : update.inventoryIssue,
      update.inventoryBlobHash ?? link.inventoryBlobHash ?? null,
      update.error === undefined ? link.lastError ?? null : update.error,
       update.error === undefined || update.error === null ? at : link.lastSuccessAt ?? null,
       lifecycleState, at, at, linkId]);
  }

  async recordNodeReplicationRound(linkId: string, outcome: 'converged' | 'partial' | 'failed',
    durationMs: number): Promise<void> {
    await this.ready;
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new ServerStoreError('INVALID_REPLICATION_STATUS', 400, '复制轮次耗时无效');
    }
    const column = outcome === 'converged' ? 'converged_rounds'
      : outcome === 'partial' ? 'partial_rounds' : 'failed_rounds';
    await this.driver.run(`UPDATE node_replication_links SET sync_rounds = sync_rounds + 1,
      ${column} = ${column} + 1, last_round_duration_ms = ?, updated_at = ?
      WHERE link_id = ?`, [durationMs, nowIso(), linkId]);
  }

  /** Count acknowledged ciphertext chunks, including chunks of an unfinished object. */
  async recordNodeBlobTransfer(linkId: string, direction: 'pull' | 'push', bytes: number): Promise<void> {
    await this.ready;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new ServerStoreError('INVALID_REPLICATION_STATUS', 400, '附件传输字节数无效');
    }
    const column = direction === 'pull' ? 'pull_blob_transferred_bytes' : 'push_blob_transferred_bytes';
    const result = await this.driver.run(`UPDATE node_replication_links
      SET ${column} = ${column} + ?, updated_at = ?
      WHERE link_id = ? AND enabled = 1 AND ${column} <= ?`,
    [bytes, nowIso(), linkId, Number.MAX_SAFE_INTEGER - bytes]);
    if (result.changes !== 1) {
      const row = await this.driver.get<{ enabled: number }>(
        'SELECT enabled FROM node_replication_links WHERE link_id = ?', [linkId]);
      if (row?.enabled) throw new ServerStoreError('INVALID_REPLICATION_STATUS', 409, '附件传输计数超出安全范围');
    }
  }

  async recordNodeLinkLifecycle(linkId: string,
    state: 'BOOTSTRAPPING' | 'CATCHING_UP' | 'VERIFYING' | 'READY'): Promise<void> {
    await this.ready;
    const at = nowIso();
    await this.driver.run(`UPDATE node_replication_links SET lifecycle_state = ?,
      lifecycle_checked_at = ?, updated_at = ? WHERE link_id = ? AND enabled = 1`,
    [state, at, at, linkId]);
  }

  /** Revisit the whole peer catalog without changing either replica's data or grant. */
  async rescanNodeReplicationLink(username: string, linkId: string): Promise<NodeReplicationLink> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const row = await driver.get<Record<string, unknown>>(
        'SELECT * FROM node_replication_links WHERE username = ? AND link_id = ?', [username, linkId]);
      if (!row) throw new ServerStoreError('LINK_NOT_FOUND', 404, '复制链路不存在');
      const link = this.nodeLinkFromRow(row);
      if (!link.enabled || link.revocationPending) {
        throw new ServerStoreError('LINK_DISABLED', 409, '已停止或正在撤销的链路不能重新扫描');
      }
      const replica = await driver.get<{ ledger_id: string; stream_epoch: string }>(
        'SELECT ledger_id, stream_epoch FROM sync_replicas WHERE username = ?', [username]);
      if (!replica || replica.ledger_id !== link.ledgerId
        || replica.stream_epoch !== link.localStreamEpoch) {
        throw new ServerStoreError('REPLICA_CHANGED', 409, '本地账本副本已改变');
      }
      const at = nowIso();
      await driver.run(`UPDATE node_replication_links SET
        pull_seq = 0, push_seq = 0, pull_blob_cursor = '', push_blob_cursor = '',
        pull_state_cursor = '', push_state_cursor = '',
        pull_member_cursor = '', push_member_cursor = '', member_epoch = 0,
        peer_head_seq = 0, local_head_seq = 0,
        peer_blob_objects = 0, local_blob_objects = 0,
        peer_blob_bytes = 0, local_blob_bytes = 0,
        pull_blob_scanned_bytes = 0, push_blob_scanned_bytes = 0,
        peer_legacy_objects = 0, local_legacy_objects = 0,
        peer_tombstones = 0, local_tombstones = 0,
        pull_blob_sweep_at = NULL, push_blob_sweep_at = NULL,
        pull_state_sweep_at = NULL, push_state_sweep_at = NULL,
        inventory_matched_at = NULL, inventory_issue = NULL, inventory_blob_hash = NULL,
        physical_blob_hash = NULL, physical_verified_at = NULL,
        physical_scanned_at = NULL, physical_issue = NULL,
        last_error = NULL, lifecycle_state = 'BOOTSTRAPPING',
        lifecycle_checked_at = ?, updated_at = ?
        WHERE username = ? AND link_id = ? AND enabled = 1`,
      [at, at, username, linkId]);
      await driver.run(`UPDATE replica_physical_status SET blob_hash = NULL,
        verified_at = NULL, scanned_at = NULL, issue = NULL
        WHERE username = ? AND ledger_id = ?`, [username, link.ledgerId]);
      await driver.run(`UPDATE node_replication_links SET physical_blob_hash = NULL,
        physical_verified_at = NULL, physical_scanned_at = NULL, physical_issue = NULL,
        lifecycle_state = 'VERIFYING', lifecycle_checked_at = ?, updated_at = ?
        WHERE username = ? AND ledger_id = ? AND link_id <> ? AND enabled = 1`,
      [at, at, username, link.ledgerId, linkId]);
      await driver.run(`UPDATE node_replica_group_snapshots SET received_at = ? WHERE link_id = ?`,
        ['1970-01-01T00:00:00.000Z', linkId]);
      await driver.run('DELETE FROM node_directory_cursors WHERE link_id = ?', [linkId]);
      await driver.run('DELETE FROM node_credential_exports WHERE link_id = ?', [linkId]);
      const updated = await driver.get<Record<string, unknown>>(
        'SELECT * FROM node_replication_links WHERE link_id = ?', [linkId]);
      return this.nodeLinkFromRow(updated!);
    });
  }

  async invalidateNodePhysicalVerification(linkId: string): Promise<void> {
    await this.ready;
    const link = await this.driver.get<{ username: string; ledger_id: string }>(
      'SELECT username, ledger_id FROM node_replication_links WHERE link_id = ? AND enabled = 1', [linkId]);
    if (link) await this.invalidateReplicaPhysicalStatus(link.username, link.ledger_id);
  }

  async disableNodeReplicationLink(username: string, linkId: string): Promise<boolean> {
    await this.ready;
    const row = await this.driver.get<{ enabled: number }>(`SELECT enabled FROM node_replication_links
      WHERE username = ? AND link_id = ?`, [username, linkId]);
    if (!row) return false;
      if (Number(row.enabled) === 1) await this.driver.run(`UPDATE node_replication_links
       SET enabled = 0, revocation_pending = 1, remote_revoked_at = NULL,
         revocation_error = NULL, lifecycle_state = 'REVOKING', lifecycle_checked_at = ?,
         updated_at = ? WHERE username = ? AND link_id = ? AND enabled = 1`,
    [nowIso(), nowIso(), username, linkId]);
    return true;
  }

  async recordNodeRevocationResult(linkId: string, error?: string): Promise<void> {
    await this.ready;
    await this.driver.run(error ? `UPDATE node_replication_links SET revocation_error = ?,
      lifecycle_state = 'REVOKING', lifecycle_checked_at = ?, updated_at = ?
      WHERE link_id = ? AND enabled = 0 AND revocation_pending = 1`
      : `UPDATE node_replication_links SET revocation_pending = 0, remote_revoked_at = ?,
        revocation_error = NULL, lifecycle_state = 'REVOKED', lifecycle_checked_at = ?,
        updated_at = ? WHERE link_id = ? AND enabled = 0 AND revocation_pending = 1`,
    error ? [error.slice(0, 500), nowIso(), nowIso(), linkId]
      : [nowIso(), nowIso(), nowIso(), linkId]);
  }

  async renewNodeReplicationLink(username: string, linkId: string, grantId: string,
    peerNodeId: string, peerPublicKey: string, peerReplicaId: string, peerStreamEpoch: string): Promise<NodeReplicationLink> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const row = await driver.get<Record<string, unknown>>('SELECT * FROM node_replication_links WHERE username = ? AND link_id = ?', [username, linkId]);
      if (!row) throw new ServerStoreError('LINK_NOT_FOUND', 404, '复制链路不存在');
      const link = this.nodeLinkFromRow(row);
      if (link.revocationPending) {
        throw new ServerStoreError('REVOCATION_PENDING', 409,
          '旧授权尚未确认撤销，不能覆盖待处理撤销任务');
      }
      if (!link.enabled && grantId === link.grantId) {
        throw new ServerStoreError('NEW_GRANT_REQUIRED', 409, '已停止的链路必须使用新的授权重新加入');
      }
      if (link.peerNodeId !== peerNodeId || link.peerPublicKey !== peerPublicKey
        || link.peerReplicaId !== peerReplicaId || link.peerStreamEpoch !== peerStreamEpoch) {
        throw new ServerStoreError('PEER_CHANGED', 409, '对端身份或副本世代已改变，不能续签旧链路');
      }
      await driver.run(`UPDATE node_replication_links SET grant_id = ?, enabled = 1, last_error = NULL,
        revocation_pending = 0, remote_revoked_at = NULL, revocation_error = NULL,
        lifecycle_state = 'JOINING', lifecycle_checked_at = NULL,
        last_success_at = NULL, inventory_matched_at = NULL,
        updated_at = ? WHERE link_id = ?`, [grantId, nowIso(), linkId]);
      return { ...link, grantId, enabled: true, lastError: undefined,
        revocationPending: false, remoteRevokedAt: undefined, revocationError: undefined,
        lifecycleState: 'JOINING', lifecycleCheckedAt: undefined };
    });
  }

  async getReplica(username: string, replicaId?: string): Promise<UserReplica | undefined> {
    await this.ready;
    const row = replicaId
      ? await this.driver.get<Record<string, unknown>>(`SELECT membership.username, slot.ledger_id,
        slot.replica_id, slot.stream_epoch, slot.head_seq, slot.created_at, slot.updated_at
        FROM account_ledger_index membership JOIN ledger_replica_slots slot ON slot.replica_id = membership.replica_id
        WHERE membership.username = ? AND membership.replica_id = ?`, [username, replicaId])
      : await this.driver.get<Record<string, unknown>>(`SELECT route.username, slot.ledger_id,
        slot.replica_id, slot.stream_epoch, slot.head_seq, slot.created_at, slot.updated_at
        FROM ledger_account_routes route JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
        WHERE route.username = ?`, [username])
        ?? await this.driver.get<Record<string, unknown>>(`SELECT membership.username, slot.ledger_id,
          slot.replica_id, slot.stream_epoch, slot.head_seq, slot.created_at, slot.updated_at
          FROM account_ledger_index membership JOIN ledger_replica_slots slot
            ON slot.replica_id = membership.replica_id
          WHERE membership.username = ? ORDER BY membership.created_at, slot.replica_id LIMIT 1`, [username]);
    return row ? replicaFromRow(row) : undefined;
  }

  async getReplicaForLedger(username: string, ledgerId: string): Promise<UserReplica | undefined> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(`SELECT membership.username, slot.ledger_id,
      slot.replica_id, slot.stream_epoch, slot.head_seq, slot.created_at, slot.updated_at
      FROM account_ledger_index membership JOIN ledger_replica_slots slot ON slot.replica_id = membership.replica_id
      WHERE membership.username = ? AND slot.ledger_id = ? LIMIT 2`, [username, ledgerId]);
    if (rows.length > 1) throw new ServerStoreError('AMBIGUOUS_LEDGER', 409,
      '账号拥有多个同 ID 的独立账本副本，必须指定副本 ID');
    return rows[0] ? replicaFromRow(rows[0]) : undefined;
  }

  private accountReplicaRow(driver: SqlDriver, username: string, replicaId?: string): Promise<{
    replica_id: string; ledger_id: string; account_id: string;
  } | undefined> {
    const table = replicaId ? 'account_ledger_index' : 'ledger_account_routes';
    return driver.get<{ replica_id: string; ledger_id: string; account_id: string }>(`
      SELECT slot.replica_id, slot.ledger_id, identity.account_id
      FROM ${table} membership JOIN ledger_replica_slots slot ON slot.replica_id = membership.replica_id
      JOIN sync_account_identities identity ON identity.username = membership.username
      WHERE membership.username = ?${replicaId ? ' AND membership.replica_id = ?' : ''}`,
    replicaId ? [username, replicaId] : [username]);
  }

  /** The original slot account owns node-level attachment quota for all ledger members. */
  async replicaStorageOwner(username: string, replicaId?: string): Promise<string | undefined> {
    await this.ready;
    if (replicaId) {
      if (!await this.accountReplicaRow(this.driver, username, replicaId)) {
        throw new ServerStoreError('REPLICA_UNBOUND', 403, '当前账号没有此账本');
      }
      const owner = await this.driver.get<{ username: string }>(
        'SELECT username FROM sync_replicas WHERE replica_id = ?', [replicaId]);
      return owner?.username;
    }
    const row = await this.driver.get<{ username: string }>(`
      SELECT owner.username FROM ledger_account_routes route
      JOIN sync_replicas owner ON owner.replica_id = route.replica_id
      WHERE route.username = ?`, [username]);
    return row?.username;
  }

  private async readLedgerControlState(driver: SqlDriver, replicaId: string): Promise<LedgerControlState | undefined> {
    const root = await driver.get<{ issuer_node_id: string; account_id: string; signing_public_key: string; ledger_id: string }>(`
      SELECT root.issuer_node_id, root.account_id, root.signing_public_key, slot.ledger_id
      FROM ledger_control_roots root JOIN ledger_replica_slots slot ON slot.replica_id = root.replica_id
      WHERE root.replica_id = ?`, [replicaId]);
    if (!root) return undefined;
    const pinnedOwner = { issuerNodeId: root.issuer_node_id, accountId: root.account_id,
      signingPublicKey: root.signing_public_key };
    const events = await driver.all<{ seq: number; event_hash: string; event_json: string }>(
      'SELECT seq, event_hash, event_json FROM ledger_control_events WHERE replica_id = ? ORDER BY seq', [replicaId]);
    if (!events.length) throw new Error('账本成员控制根没有初始事件');
    let state: LedgerControlState | undefined;
    for (const row of events) {
      const event = JSON.parse(row.event_json) as LedgerControlEvent;
      if (Number(row.seq) !== event.seq || row.event_hash !== ledgerControlEventHash(event)) {
        throw new Error('账本成员事件哈希不一致');
      }
      state = applyLedgerControlEvent(state, event, pinnedOwner);
    }
    if (state?.ledgerId !== root.ledger_id) throw new Error('账本成员控制链指向其他账本');
    return state;
  }

  /** A deleted or altered derived decision must never resurrect an archived write. */
  private async verifyControlResolutionIndex(driver: SqlDriver, replicaId: string): Promise<void> {
    const events = await driver.all<{ seq: number; event_json: string }>(`SELECT seq, event_json
      FROM ledger_control_events WHERE replica_id = ? ORDER BY seq`, [replicaId]);
    const expected = events.flatMap((row) => {
      const event = JSON.parse(row.event_json) as LedgerControlEvent;
      return event.kind === 'RejectedCommitResolved' ? [{
        rejectedCommitId: event.rejectedCommitId, rejectedContentHash: event.rejectedContentHash,
        decision: event.decision, replacementCommitId: event.replacementCommitId ?? null,
        replacementContentHash: event.replacementContentHash ?? null,
        actorIssuerNodeId: event.actor.issuerNodeId, actorAccountId: event.actor.accountId,
        keyEpoch: event.keyEpoch, eventSeq: Number(row.seq),
      }] : [];
    });
    const actual = (await driver.all<Record<string, unknown>>(`SELECT * FROM ledger_control_resolutions
      WHERE replica_id = ? ORDER BY event_seq`, [replicaId])).map((row) => ({
      rejectedCommitId: row['rejected_commit_id'], rejectedContentHash: row['rejected_content_hash'],
      decision: row['decision'], replacementCommitId: row['replacement_commit_id'],
      replacementContentHash: row['replacement_content_hash'],
      actorIssuerNodeId: row['actor_issuer_node_id'], actorAccountId: row['actor_account_id'],
      keyEpoch: Number(row['key_epoch']), eventSeq: Number(row['event_seq']),
    }));
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error('签名隔离提交处置索引与成员控制链不一致');
    }
  }

  private async rebuildAccountLedgerIndex(driver: SqlDriver, replicaId: string,
    knownState?: LedgerControlState): Promise<void> {
    const state = knownState ?? await this.readLedgerControlState(driver, replicaId);
    const desired = new Set<string>();
    if (!state) {
      const routes = await driver.all<{ username: string }>(
        'SELECT username FROM ledger_account_routes WHERE replica_id = ?', [replicaId]);
      for (const route of routes) desired.add(route.username);
    } else {
      const identities = await driver.all<{ username: string; account_id: string;
        issuer_node_id: string | null; subject_account_id: string | null }>(`
        SELECT identity.username, identity.account_id, binding.issuer_node_id, binding.subject_account_id
        FROM sync_account_identities identity LEFT JOIN federated_account_bindings binding
          ON binding.local_username = identity.username`);
      for (const identity of identities) {
        const memberId = `${identity.issuer_node_id ?? this.serverId}/${identity.subject_account_id ?? identity.account_id}`;
        if (state.members[memberId]?.removed === false) desired.add(identity.username);
      }
    }
    const existing = await driver.all<{ username: string }>(
      'SELECT username FROM account_ledger_index WHERE replica_id = ?', [replicaId]);
    const present = new Set(existing.map((row) => row.username));
    const at = nowIso();
    for (const username of desired) {
      if (!present.has(username)) {
        await driver.run('INSERT INTO account_ledger_index (username, replica_id, created_at) VALUES (?, ?, ?)',
          [username, replicaId, at]);
      }
    }
    for (const username of present) {
      if (!desired.has(username)) await driver.run(
        'DELETE FROM account_ledger_index WHERE username = ? AND replica_id = ?', [username, replicaId]);
    }
  }

  async listAccountLedgers(username: string): Promise<Array<{ ledgerId: string; replicaId: string;
    streamEpoch: string }>> {
    await this.ready;
    const rows = await this.driver.all<{ ledger_id: string; replica_id: string; stream_epoch: string }>(`
      SELECT slot.ledger_id, slot.replica_id, slot.stream_epoch
      FROM account_ledger_index membership JOIN ledger_replica_slots slot
        ON slot.replica_id = membership.replica_id
      WHERE membership.username = ? ORDER BY membership.created_at, slot.replica_id`, [username]);
    return rows.map((row) => ({ ledgerId: row.ledger_id, replicaId: row.replica_id,
      streamEpoch: row.stream_epoch }));
  }

  /** Before genesis there is only one account writer; tag its legacy history before member writes exist. */
  private async attributePreControlCommits(driver: SqlDriver, replicaId: string,
    owner: LedgerMemberIdentity): Promise<void> {
    await driver.run(`UPDATE ledger_replica_commits SET key_epoch = 1,
      writer_issuer_node_id = ?, writer_account_id = ?
      WHERE replica_id = ? AND key_epoch = 0`,
    [owner.issuerNodeId, owner.accountId, replicaId]);
  }

  async ledgerControlState(username: string, replicaId?: string): Promise<LedgerControlState | undefined> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    return replica ? this.readLedgerControlState(this.driver, replica.replicaId) : undefined;
  }

  async ledgerControlPage(username: string, after: number, limit: number, replicaId?: string): Promise<LedgerControlPage> {
    await this.ready;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new ServerStoreError('INVALID_CURSOR', 400, '成员事件游标无效');
    }
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
    const rootRow = await this.driver.get<{ issuer_node_id: string; account_id: string; signing_public_key: string }>(
      'SELECT issuer_node_id, account_id, signing_public_key FROM ledger_control_roots WHERE replica_id = ?', [replica.replicaId]);
    if (!rootRow) return { root: null, events: [], headSeq: 0, headHash: null, nextSeq: after, hasMore: false };
    const state = (await this.readLedgerControlState(this.driver, replica.replicaId))!;
    const rows = await this.driver.all<{ event_json: string }>(
      'SELECT event_json FROM ledger_control_events WHERE replica_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      [replica.replicaId, after, limit]);
    const events = rows.map((row) => JSON.parse(row.event_json) as LedgerControlEvent);
    const nextSeq = events.at(-1)?.seq ?? after;
    return {
      root: { issuerNodeId: rootRow.issuer_node_id, accountId: rootRow.account_id,
        signingPublicKey: rootRow.signing_public_key },
      events, headSeq: state.seq, headHash: state.headHash, nextSeq, hasMore: nextSeq < state.seq,
    };
  }

  /** A signed node grant authenticates the sender; the genesis anchor must still be the issuer account. */
  async importLedgerControlPage(username: string, peerNodeId: string, root: LedgerControlRoot | null,
    events: LedgerControlEvent[], replicaId?: string): Promise<LedgerControlState | undefined> {
    await this.ready;
    if (!Array.isArray(events) || events.length > 50) throw new ServerStoreError('INVALID_CONTROL_PAGE', 400, '成员事件页无效');
    return this.driver.transaction(async (driver) => {
      const route = await this.accountReplicaRow(driver, username, replicaId);
      if (!route) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
      const existingRoot = await driver.get<{ issuer_node_id: string; account_id: string; signing_public_key: string }>(
        'SELECT issuer_node_id, account_id, signing_public_key FROM ledger_control_roots WHERE replica_id = ?', [route.replica_id]);
      if (!root) {
        if (events.length) throw new ServerStoreError('INVALID_CONTROL_PAGE', 400, '成员事件缺少初始所有者');
        return existingRoot ? this.readLedgerControlState(driver, route.replica_id) : undefined;
      }
      if (typeof root.issuerNodeId !== 'string' || typeof root.accountId !== 'string'
        || typeof root.signingPublicKey !== 'string'
        || Object.keys(root).sort().join(',') !== 'accountId,issuerNodeId,signingPublicKey') {
        throw new ServerStoreError('INVALID_CONTROL_ROOT', 400, '成员控制根无效');
      }
      if (existingRoot) {
        if (existingRoot.issuer_node_id !== root.issuerNodeId || existingRoot.account_id !== root.accountId
          || existingRoot.signing_public_key !== root.signingPublicKey) {
          throw new ServerStoreError('CONTROL_ROOT_CHANGED', 409, '账本初始所有者锚点已改变');
        }
      } else {
        const binding = await driver.get<{ issuer_node_id: string; subject_account_id: string }>(
          'SELECT issuer_node_id, subject_account_id FROM federated_account_bindings WHERE local_username = ?', [username]);
        if (peerNodeId !== root.issuerNodeId || binding?.issuer_node_id !== root.issuerNodeId
          || binding.subject_account_id !== root.accountId) {
          throw new ServerStoreError('CONTROL_ROOT_UNTRUSTED', 403, '初始所有者不是已固定身份节点的账号');
        }
        const genesis = events[0];
        const accountKey = await driver.get<{ public_key: string }>(
          'SELECT public_key FROM account_encryption_keys WHERE issuer_node_id = ? AND subject_account_id = ?',
          [root.issuerNodeId, root.accountId]);
        if (!genesis || !accountKey || genesis.encryptionPublicKey !== accountKey.public_key) {
          throw new ServerStoreError('CONTROL_ROOT_UNTRUSTED', 403, '初始所有者的账号公钥未被身份节点确认');
        }
      }
      let state = existingRoot ? await this.readLedgerControlState(driver, route.replica_id) : undefined;
      for (const event of events) {
        let eventHash: string;
        try { eventHash = ledgerControlEventHash(event); }
        catch { throw new ServerStoreError('INVALID_CONTROL_EVENT', 400, '成员事件格式无效'); }
        if (state && event.seq <= state.seq) {
          const existing = await driver.get<{ event_hash: string }>(
            'SELECT event_hash FROM ledger_control_events WHERE replica_id = ? AND seq = ?',
            [route.replica_id, event.seq]);
          if (existing?.event_hash !== eventHash) {
            throw new ServerStoreError('CONTROL_FORK', 409, '成员控制链同序号出现不同事件');
          }
          continue;
        }
        let next: LedgerControlState;
        try { next = applyLedgerControlEvent(state, event, root); }
        catch (error) { throw new ServerStoreError('INVALID_CONTROL_EVENT', 409, String(error)); }
        if (next.ledgerId !== route.ledger_id) throw new ServerStoreError('LEDGER_MISMATCH', 409, '成员事件属于其他账本');
        const at = nowIso();
        if (!existingRoot && !state) {
          await driver.run(`INSERT INTO ledger_control_roots
            (replica_id, issuer_node_id, account_id, signing_public_key, created_at) VALUES (?, ?, ?, ?, ?)`,
          [route.replica_id, root.issuerNodeId, root.accountId, root.signingPublicKey, at]);
          await this.attributePreControlCommits(driver, route.replica_id, root);
        }
        await driver.run(`INSERT INTO ledger_control_events
          (replica_id, seq, event_hash, event_json, stored_at) VALUES (?, ?, ?, ?, ?)`,
        [route.replica_id, event.seq, next.headHash, canonicalJson(event), at]);
        await this.persistControlResolution(driver, route.replica_id, event, false);
        state = next;
      }
      if (state) await this.rebuildAccountLedgerIndex(driver, route.replica_id, state);
      return state;
    });
  }

  private async assertLedgerAccessOnReplica(driver: SqlDriver, username: string, replicaId: string,
    mode: 'read' | 'write' | 'manage'): Promise<void> {
    if (mode !== 'read' && await driver.get('SELECT 1 FROM server_meta WHERE key = ?',
      [`replica_retired:${replicaId}`])) {
      throw new ServerStoreError('REPLICA_RETIRED', 409, '本节点已移出副本组，当前账本禁止继续写入');
    }
    const state = await this.readLedgerControlState(driver, replicaId);
    if (!state) return; // Legacy single-account replicas have no member control chain.
    const identity = await driver.get<{ account_id: string; issuer_node_id: string | null; subject_account_id: string | null }>(`
      SELECT local.account_id, federated.issuer_node_id, federated.subject_account_id
      FROM sync_account_identities local LEFT JOIN federated_account_bindings federated
        ON federated.local_username = local.username WHERE local.username = ?`, [username]);
    const memberId = `${identity?.issuer_node_id ?? this.serverId}/${identity?.subject_account_id ?? identity?.account_id ?? ''}`;
    const member = state.members[memberId];
    if (!member || member.removed) throw new ServerStoreError('LEDGER_MEMBER_REQUIRED', 403, '当前账号没有账本访问权');
    if (mode === 'write' && member.role === 'VIEWER') {
      throw new ServerStoreError('LEDGER_WRITE_REQUIRED', 403, '当前账本角色只允许读取');
    }
    if (mode === 'manage' && member.role !== 'OWNER') {
      throw new ServerStoreError('LEDGER_OWNER_REQUIRED', 403, '只有账本所有者可以管理授权');
    }
  }

  async assertLedgerAccess(username: string, mode: 'read' | 'write' | 'manage', replicaId?: string): Promise<void> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
    await this.assertLedgerAccessOnReplica(this.driver, username, replica.replicaId, mode);
  }

  private async persistControlResolution(driver: SqlDriver, replicaId: string,
    event: LedgerControlEvent, requireLocalReview: boolean): Promise<void> {
    if (event.kind !== 'RejectedCommitResolved') return;
    const oldId = event.rejectedCommitId!;
    const oldHash = event.rejectedContentHash!;
    const prior = await driver.get(`SELECT 1 FROM ledger_control_resolutions
      WHERE replica_id = ? AND rejected_commit_id = ?`, [replicaId, oldId]);
    if (prior) throw new ServerStoreError('REJECTED_COMMIT_ALREADY_RESOLVED', 409, '隔离提交已有签名处置决定');
    const rejected = await driver.all<{ content_hash: string }>(`SELECT content_hash
      FROM ledger_replica_rejected_commits WHERE replica_id = ? AND commit_id = ?`, [replicaId, oldId]);
    const oldCommit = await driver.get<{ content_hash: string }>(`SELECT content_hash
      FROM ledger_replica_commits WHERE replica_id = ? AND commit_id = ?`, [replicaId, oldId]);
    if (rejected.some((row) => row.content_hash !== oldHash)
      || oldCommit && oldCommit.content_hash !== oldHash) {
      throw new ServerStoreError('REJECTED_COMMIT_COLLISION', 409, '处置决定中的原提交内容哈希不匹配');
    }
    if (requireLocalReview && !rejected.length) {
      throw new ServerStoreError('REJECTED_COMMIT_NOT_FOUND', 409, '此节点没有待审核的隔离提交');
    }
    if (event.decision === 'replay') {
      const replacement = await driver.get<{ content_hash: string; key_epoch: number;
        writer_issuer_node_id: string; writer_account_id: string }>(`SELECT content_hash, key_epoch,
          writer_issuer_node_id, writer_account_id FROM ledger_replica_commits
          WHERE replica_id = ? AND commit_id = ?`, [replicaId, event.replacementCommitId!]);
      if (replacement && (replacement.content_hash !== event.replacementContentHash
        || Number(replacement.key_epoch) !== event.keyEpoch
        || replacement.writer_issuer_node_id !== event.actor.issuerNodeId
        || replacement.writer_account_id !== event.actor.accountId)) {
        throw new ServerStoreError('REPAIR_COMMIT_MISMATCH', 409, '修复提交内容、代次或写入者不匹配');
      }
      if (requireLocalReview && !replacement) {
        throw new ServerStoreError('REPAIR_COMMIT_REQUIRED', 409, '须先将审核后的新提交上传到当前节点');
      }
    }
    await driver.run(`INSERT INTO ledger_control_resolutions
      (replica_id, rejected_commit_id, rejected_content_hash, decision,
        replacement_commit_id, replacement_content_hash, actor_issuer_node_id,
        actor_account_id, key_epoch, event_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [replicaId, oldId, oldHash, event.decision!, event.replacementCommitId ?? null,
      event.replacementContentHash ?? null, event.actor.issuerNodeId, event.actor.accountId,
      event.keyEpoch, event.seq]);
  }

  /** Bootstrap is tied to an authenticated account and its published encryption key. */
  async initializeLedgerControl(username: string, event: LedgerControlEvent,
    replicaId?: string): Promise<LedgerControlState> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const route = await this.accountReplicaRow(driver, username, replicaId);
      if (!route || event.ledgerId !== route.ledger_id) throw new ServerStoreError('LEDGER_MISMATCH', 409, '账本副本身份不匹配');
      const binding = await driver.get<{ issuer_node_id: string; subject_account_id: string }>(
        'SELECT issuer_node_id, subject_account_id FROM federated_account_bindings WHERE local_username = ?', [username]);
      const owner: LedgerMemberIdentity = { issuerNodeId: binding?.issuer_node_id ?? this.serverId,
        accountId: binding?.subject_account_id ?? route.account_id };
      const accountKey = await driver.get<{ public_key: string }>(
        'SELECT public_key FROM account_encryption_keys WHERE issuer_node_id = ? AND subject_account_id = ?',
        [owner.issuerNodeId, owner.accountId]);
      if (!accountKey || accountKey.public_key !== event.encryptionPublicKey) {
        throw new ServerStoreError('ACCOUNT_KEY_REQUIRED', 409, '初始所有者必须先登记账号加密公钥');
      }
      const pinnedOwner = { ...owner, signingPublicKey: event.signingPublicKey ?? '' };
      let state: LedgerControlState;
      try { state = applyLedgerControlEvent(undefined, event, pinnedOwner); }
      catch (error) { throw new ServerStoreError('INVALID_CONTROL_EVENT', 409, String(error)); }
      const existing = await this.readLedgerControlState(driver, route.replica_id);
      if (existing) {
        if (existing.seq === 1 && existing.headHash === state.headHash) return existing;
        throw new ServerStoreError('CONTROL_ALREADY_INITIALIZED', 409, '账本成员控制链已经建立');
      }
      const at = nowIso();
      await driver.run(`INSERT INTO ledger_control_roots
        (replica_id, issuer_node_id, account_id, signing_public_key, created_at) VALUES (?, ?, ?, ?, ?)`,
      [route.replica_id, owner.issuerNodeId, owner.accountId, pinnedOwner.signingPublicKey, at]);
      await this.attributePreControlCommits(driver, route.replica_id, owner);
      await driver.run(`INSERT INTO ledger_control_events
        (replica_id, seq, event_hash, event_json, stored_at) VALUES (?, ?, ?, ?, ?)`,
      [route.replica_id, event.seq, state.headHash, canonicalJson(event), at]);
      await this.rebuildAccountLedgerIndex(driver, route.replica_id, state);
      return state;
    });
  }

  async appendLedgerControlEvent(username: string, event: LedgerControlEvent,
    envelopes: LedgerMemberKeyEnvelope[] = [], replicaId?: string): Promise<LedgerControlState> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const replica = await this.accountReplicaRow(driver, username, replicaId);
      if (!replica || event.ledgerId !== replica.ledger_id) throw new ServerStoreError('LEDGER_MISMATCH', 409, '账本副本身份不匹配');
      const binding = await driver.get<{ issuer_node_id: string; subject_account_id: string }>(
        'SELECT issuer_node_id, subject_account_id FROM federated_account_bindings WHERE local_username = ?', [username]);
      const actor = { issuerNodeId: binding?.issuer_node_id ?? this.serverId,
        accountId: binding?.subject_account_id ?? replica.account_id };
      if (event.actor.issuerNodeId !== actor.issuerNodeId || event.actor.accountId !== actor.accountId) {
        throw new ServerStoreError('CONTROL_ACTOR_MISMATCH', 403, '成员事件签名者与当前账号不符');
      }
      if (event.kind === 'MemberAdded') {
        const targetKey = await driver.get<{ public_key: string }>(
          'SELECT public_key FROM account_encryption_keys WHERE issuer_node_id = ? AND subject_account_id = ?',
          [event.target.issuerNodeId, event.target.accountId]);
        if (!targetKey || targetKey.public_key !== event.encryptionPublicKey) {
          throw new ServerStoreError('ACCOUNT_KEY_REQUIRED', 409, '目标成员的账号加密公钥未登记或不匹配');
        }
      }
      const current = await this.readLedgerControlState(driver, replica.replica_id);
      if (!current) throw new ServerStoreError('CONTROL_UNINITIALIZED', 409, '账本成员控制链尚未建立');
      if (event.seq === current.seq && ledgerControlEventHash(event) === current.headHash) {
        for (const envelope of envelopes) {
          const stored = await driver.get<{ envelope_json: string }>(`
            SELECT envelope_json FROM ledger_member_key_envelopes
            WHERE replica_id = ? AND issuer_node_id = ? AND account_id = ? AND key_epoch = ?`,
          [replica.replica_id, envelope.issuerNodeId, envelope.accountId, envelope.keyEpoch]);
          if (!stored || stored.envelope_json !== canonicalJson(envelope)) {
            throw new ServerStoreError('MEMBER_ENVELOPE_REQUIRED', 409,
              '成员事件已存在，但对应密钥包尚未完整保存');
          }
        }
        return current;
      }
      let next: LedgerControlState;
      try { next = applyLedgerControlEvent(current, event); }
      catch (error) { throw new ServerStoreError('INVALID_CONTROL_EVENT', 409, String(error)); }
      if (envelopes.length) {
        if (event.kind !== 'MemberAdded' && event.kind !== 'MemberRemoved' || envelopes.length > 100) {
          throw new ServerStoreError('INVALID_MEMBER_ENVELOPES', 400, '成员事件密钥包数量或类型无效');
        }
        const requiredIds = event.kind === 'MemberRemoved'
          ? Object.values(next.members).filter((member) => !member.removed)
            .map((member) => `${member.issuerNodeId}/${member.accountId}`)
          : [`${event.target.issuerNodeId}/${event.target.accountId}`];
        const submittedIds = envelopes.map((envelope) => `${envelope.issuerNodeId}/${envelope.accountId}`);
        if (new Set(submittedIds).size !== submittedIds.length
          || requiredIds.length !== submittedIds.length
          || requiredIds.some((id) => !submittedIds.includes(id))) {
          throw new ServerStoreError('MEMBER_ENVELOPE_COVERAGE', 409, '成员事件没有覆盖全部应获密钥的成员');
        }
        const keyring = await driver.get<{ keyring_id: string }>(
          'SELECT keyring_id FROM ledger_replica_key_envelopes WHERE replica_id = ?', [replica.replica_id]);
        const activeKeyId = envelopes[0]!.activeKeyId;
        const keyringId = envelopes[0]!.keyringId;
        for (const envelope of envelopes) {
          try { assertLedgerMemberKeyEnvelope(envelope); }
          catch (error) { throw new ServerStoreError('INVALID_MEMBER_ENVELOPE', 400, String(error)); }
          const target = next.members[`${envelope.issuerNodeId}/${envelope.accountId}`];
          if (!target || target.removed || target.encryptionPublicKey !== envelope.recipientPublicKey
            || envelope.ledgerId !== replica.ledger_id || envelope.keyEpoch !== next.keyEpoch
            || envelope.activeKeyId !== activeKeyId || envelope.keyringId !== keyringId
            || keyring && keyring.keyring_id !== envelope.keyringId) {
            throw new ServerStoreError('MEMBER_ENVELOPE_MISMATCH', 409, '成员事件密钥包与当前权限或密钥不一致');
          }
          await this.assertMemberEnvelopeKeyEpoch(driver, replica.replica_id, envelope);
        }
      }
      if (event.kind === 'MemberAdded' && event.target.issuerNodeId === this.serverId) {
        const target = await driver.get<{ username: string; disabled: number }>(`
          SELECT identity.username, user.disabled FROM sync_account_identities identity
          JOIN sync_users user ON user.username = identity.username WHERE identity.account_id = ?`,
        [event.target.accountId]);
        if (!target || Number(target.disabled)) {
          throw new ServerStoreError('MEMBER_ACCOUNT_UNAVAILABLE', 409, '目标账号未注册或已停用');
        }
        const route = await driver.get<{ replica_id: string }>(
          'SELECT replica_id FROM ledger_account_routes WHERE username = ?', [target.username]);
        // Keep an existing personal ledger as the legacy default. Membership in
        // this ledger is indexed separately and selected by a node-local session.
        if (!route) await driver.run(`INSERT INTO ledger_account_routes (username, replica_id, created_at)
          VALUES (?, ?, ?)`, [target.username, replica.replica_id, nowIso()]);
      }
      await driver.run(`INSERT INTO ledger_control_events
        (replica_id, seq, event_hash, event_json, stored_at) VALUES (?, ?, ?, ?, ?)`,
      [replica.replica_id, event.seq, next.headHash, canonicalJson(event), nowIso()]);
      await this.persistControlResolution(driver, replica.replica_id, event, true);
      for (const envelope of envelopes) await driver.run(`INSERT INTO ledger_member_key_envelopes
        (replica_id, issuer_node_id, account_id, key_epoch, keyring_id, generation, envelope_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [replica.replica_id, envelope.issuerNodeId, envelope.accountId, envelope.keyEpoch,
        envelope.keyringId, envelope.generation, canonicalJson(envelope), nowIso()]);
      await this.rebuildAccountLedgerIndex(driver, replica.replica_id, next);
      return next;
    });
  }

  async putLedgerMemberKeyEnvelope(username: string, envelope: LedgerMemberKeyEnvelope,
    replicaId?: string): Promise<void> {
    await this.ready;
    try { assertLedgerMemberKeyEnvelope(envelope); }
    catch (error) { throw new ServerStoreError('INVALID_MEMBER_ENVELOPE', 400, String(error)); }
    await this.driver.transaction(async (driver) => {
      const route = await this.accountReplicaRow(driver, username, replicaId);
      if (!route || route.ledger_id !== envelope.ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, '账本副本身份不匹配');
      const binding = await driver.get<{ issuer_node_id: string; subject_account_id: string }>(
        'SELECT issuer_node_id, subject_account_id FROM federated_account_bindings WHERE local_username = ?', [username]);
      const actorId = `${binding?.issuer_node_id ?? this.serverId}/${binding?.subject_account_id ?? route.account_id}`;
      const state = await this.readLedgerControlState(driver, route.replica_id);
      if (!state) throw new ServerStoreError('CONTROL_UNINITIALIZED', 409, '账本成员控制链尚未建立');
      if (state.members[actorId]?.removed !== false || state.members[actorId]?.role !== 'OWNER') {
        throw new ServerStoreError('LEDGER_OWNER_REQUIRED', 403, '只有账本所有者可以发放成员密钥');
      }
      const target = state.members[`${envelope.issuerNodeId}/${envelope.accountId}`];
      if (!target || target.removed || target.encryptionPublicKey !== envelope.recipientPublicKey
        || envelope.keyEpoch !== state.keyEpoch) {
        throw new ServerStoreError('MEMBER_ENVELOPE_MISMATCH', 409, '目标成员、公钥或密钥代次不匹配');
      }
      const keyring = await driver.get<{ keyring_id: string }>(
        'SELECT keyring_id FROM ledger_replica_key_envelopes WHERE replica_id = ?', [route.replica_id]);
      if (keyring && keyring.keyring_id !== envelope.keyringId) {
        throw new ServerStoreError('KEYRING_MISMATCH', 409, '成员密钥包属于另一个账本密钥环');
      }
      await this.assertMemberEnvelopeKeyEpoch(driver, route.replica_id, envelope);
      const current = await driver.get<{ keyring_id: string; generation: number; envelope_json: string }>(`
        SELECT keyring_id, generation, envelope_json FROM ledger_member_key_envelopes
        WHERE replica_id = ? AND issuer_node_id = ? AND account_id = ? AND key_epoch = ?`,
      [route.replica_id, envelope.issuerNodeId, envelope.accountId, envelope.keyEpoch]);
      const encoded = canonicalJson(envelope);
      if (current) {
        if (current.keyring_id !== envelope.keyringId || Number(current.generation) > envelope.generation) {
          throw new ServerStoreError('STALE_MEMBER_ENVELOPE', 409, '已有更新的成员密钥包');
        }
        if (Number(current.generation) === envelope.generation) {
          if (current.envelope_json !== encoded) throw new ServerStoreError('MEMBER_ENVELOPE_COLLISION', 409, '同代次成员密钥包不一致');
          return;
        }
      }
      await driver.run(`INSERT INTO ledger_member_key_envelopes
        (replica_id, issuer_node_id, account_id, key_epoch, keyring_id, generation, envelope_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (replica_id, issuer_node_id, account_id, key_epoch)
        DO UPDATE SET generation = excluded.generation, envelope_json = excluded.envelope_json,
          updated_at = excluded.updated_at`,
      [route.replica_id, envelope.issuerNodeId, envelope.accountId, envelope.keyEpoch,
        envelope.keyringId, envelope.generation, encoded, nowIso()]);
    });
  }

  async currentLedgerMemberKeyEnvelope(username: string, replicaId?: string): Promise<LedgerMemberKeyEnvelope | undefined> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (!replica) return undefined;
    const state = await this.readLedgerControlState(this.driver, replica.replicaId);
    if (!state) return undefined;
    const user = await this.getUser(username);
    if (!user) return undefined;
    const binding = await this.federatedAccount(username);
    const identity = { issuerNodeId: binding?.issuerNodeId ?? this.serverId,
      accountId: binding?.subjectAccountId ?? user.accountId };
    if (state.members[`${identity.issuerNodeId}/${identity.accountId}`]?.removed !== false) return undefined;
    const row = await this.driver.get<{ envelope_json: string }>(`
      SELECT envelope_json FROM ledger_member_key_envelopes
      WHERE replica_id = ? AND issuer_node_id = ? AND account_id = ? AND key_epoch = ?`,
    [replica.replicaId, identity.issuerNodeId, identity.accountId, state.keyEpoch]);
    return row ? JSON.parse(row.envelope_json) as LedgerMemberKeyEnvelope : undefined;
  }

  async ledgerMemberEnvelopePage(username: string, after: string, limit: number,
    replicaId?: string): Promise<LedgerMemberEnvelopePage> {
    await this.ready;
    if (after && !/^[A-Za-z0-9_-]{8,160}\/[A-Za-z0-9_-]{8,160}$/.test(after)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new ServerStoreError('INVALID_CURSOR', 400, '成员密钥游标无效');
    }
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
    const state = await this.readLedgerControlState(this.driver, replica.replicaId);
    if (!state) return { keyEpoch: 0, envelopes: [], nextCursor: '', hasMore: false };
    const rows = await this.driver.all<{ issuer_node_id: string; account_id: string; envelope_json: string }>(`
      SELECT issuer_node_id, account_id, envelope_json FROM ledger_member_key_envelopes
      WHERE replica_id = ? AND key_epoch = ? AND (issuer_node_id || '/' || account_id) > ?
      ORDER BY issuer_node_id, account_id LIMIT ?`, [replica.replicaId, state.keyEpoch, after, limit + 1]);
    const page = rows.slice(0, limit);
    const nextCursor = page.length ? `${page.at(-1)!.issuer_node_id}/${page.at(-1)!.account_id}` : after;
    const envelopes = page.filter((row) => state.members[`${row.issuer_node_id}/${row.account_id}`]?.removed === false)
      .map((row) => JSON.parse(row.envelope_json) as LedgerMemberKeyEnvelope);
    return { keyEpoch: state.keyEpoch, envelopes, nextCursor, hasMore: rows.length > limit };
  }

  async importLedgerMemberEnvelopes(username: string, envelopes: LedgerMemberKeyEnvelope[], replicaId?: string): Promise<void> {
    await this.ready;
    if (!Array.isArray(envelopes) || envelopes.length > 10) {
      throw new ServerStoreError('INVALID_MEMBER_ENVELOPES', 400, '成员密钥页无效');
    }
    await this.driver.transaction(async (driver) => {
      const route = await this.accountReplicaRow(driver, username, replicaId);
      if (!route) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
      const state = await this.readLedgerControlState(driver, route.replica_id);
      if (!state) {
        if (envelopes.length) throw new ServerStoreError('CONTROL_UNINITIALIZED', 409, '成员密钥缺少控制链');
        return;
      }
      const keyring = await driver.get<{ keyring_id: string }>(
        'SELECT keyring_id FROM ledger_replica_key_envelopes WHERE replica_id = ?', [route.replica_id]);
      for (const envelope of envelopes) {
        try { assertLedgerMemberKeyEnvelope(envelope); }
        catch (error) { throw new ServerStoreError('INVALID_MEMBER_ENVELOPE', 400, String(error)); }
        const target = state.members[`${envelope.issuerNodeId}/${envelope.accountId}`];
        if (envelope.ledgerId !== route.ledger_id || envelope.keyEpoch !== state.keyEpoch
          || !target || target.removed || target.encryptionPublicKey !== envelope.recipientPublicKey
          || keyring && keyring.keyring_id !== envelope.keyringId) {
          throw new ServerStoreError('MEMBER_ENVELOPE_MISMATCH', 409, '对端成员密钥包与控制链不匹配');
        }
        await this.assertMemberEnvelopeKeyEpoch(driver, route.replica_id, envelope);
        const current = await driver.get<{ keyring_id: string; generation: number; envelope_json: string }>(`
          SELECT keyring_id, generation, envelope_json FROM ledger_member_key_envelopes
          WHERE replica_id = ? AND issuer_node_id = ? AND account_id = ? AND key_epoch = ?`,
        [route.replica_id, envelope.issuerNodeId, envelope.accountId, envelope.keyEpoch]);
        const encoded = canonicalJson(envelope);
        if (current) {
          if (current.keyring_id !== envelope.keyringId || Number(current.generation) > envelope.generation) {
            throw new ServerStoreError('STALE_MEMBER_ENVELOPE', 409, '对端成员密钥包版本倒退');
          }
          if (Number(current.generation) === envelope.generation) {
            if (current.envelope_json !== encoded) {
              throw new ServerStoreError('MEMBER_ENVELOPE_COLLISION', 409, '同代次成员密钥包不一致');
            }
            continue;
          }
        }
        await driver.run(`INSERT INTO ledger_member_key_envelopes
          (replica_id, issuer_node_id, account_id, key_epoch, keyring_id, generation, envelope_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (replica_id, issuer_node_id, account_id, key_epoch)
          DO UPDATE SET generation = excluded.generation, envelope_json = excluded.envelope_json,
            updated_at = excluded.updated_at`,
        [route.replica_id, envelope.issuerNodeId, envelope.accountId, envelope.keyEpoch,
          envelope.keyringId, envelope.generation, encoded, nowIso()]);
      }
    });
  }

  private async assertMemberEnvelopeKeyEpoch(driver: SqlDriver, replicaId: string,
    envelope: LedgerMemberKeyEnvelope): Promise<void> {
    const current = await driver.all<{ envelope_json: string }>(`
      SELECT envelope_json FROM ledger_member_key_envelopes
      WHERE replica_id = ? AND key_epoch = ?`, [replicaId, envelope.keyEpoch]);
    for (const row of current) {
      const existing = JSON.parse(row.envelope_json) as LedgerMemberKeyEnvelope;
      if (existing.activeKeyId !== envelope.activeKeyId) {
        throw new ServerStoreError('MEMBER_ACTIVE_KEY_MISMATCH', 409,
          '同一密钥代次的成员密钥包必须使用同一个活动密钥');
      }
    }
    const previous = await driver.get<{ envelope_json: string }>(`
      SELECT envelope_json FROM ledger_member_key_envelopes
      WHERE replica_id = ? AND key_epoch < ? ORDER BY key_epoch DESC LIMIT 1`,
    [replicaId, envelope.keyEpoch]);
    if (previous && (JSON.parse(previous.envelope_json) as LedgerMemberKeyEnvelope).activeKeyId === envelope.activeKeyId) {
      throw new ServerStoreError('MEMBER_KEY_NOT_ROTATED', 409,
        '移除成员后必须更换账本活动密钥');
    }
  }

  async bindFederatedAccount(username: string, ledgerId: string, issuerNodeId: string, subjectAccountId: string): Promise<void> {
    await this.ready;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(issuerNodeId) || !/^[A-Za-z0-9_-]{8,160}$/.test(subjectAccountId)) {
      throw new ServerStoreError('INVALID_FEDERATED_IDENTITY', 400, '统一账号标识无效');
    }
    await this.driver.transaction(async (driver) => {
      const replica = await driver.get<{ ledger_id: string }>('SELECT ledger_id FROM sync_replicas WHERE username = ?', [username]);
      if (replica?.ledger_id !== ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, '统一账号账本不匹配');
      const existing = await driver.get<{ issuer_node_id: string; subject_account_id: string; ledger_id: string }>(
        'SELECT issuer_node_id, subject_account_id, ledger_id FROM federated_account_bindings WHERE local_username = ?', [username]);
      if (existing && (existing.issuer_node_id !== issuerNodeId || existing.subject_account_id !== subjectAccountId)) {
        throw new ServerStoreError('FEDERATED_IDENTITY_CHANGED', 409, '本地账号已绑定不同的统一身份');
      }
      const other = await driver.get<{ local_username: string }>(
        'SELECT local_username FROM federated_account_bindings WHERE issuer_node_id = ? AND subject_account_id = ?', [issuerNodeId, subjectAccountId]);
      if (other && other.local_username !== username) throw new ServerStoreError('FEDERATED_IDENTITY_COLLISION', 409, '统一身份已绑定另一个本地账号');
      const at = nowIso();
      if (existing) await driver.run('UPDATE federated_account_bindings SET verified_at = ? WHERE local_username = ?', [at, username]);
      else await driver.run(`INSERT INTO federated_account_bindings
        (local_username, issuer_node_id, subject_account_id, ledger_id, created_at, verified_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [username, issuerNodeId, subjectAccountId, ledgerId, at, at]);
      const slot = await driver.get<{ replica_id: string }>(
        'SELECT replica_id FROM ledger_account_routes WHERE username = ?', [username]);
      if (slot) await this.rebuildAccountLedgerIndex(driver, slot.replica_id);
    });
  }

  async federatedAccount(username: string): Promise<{ issuerNodeId: string; subjectAccountId: string; ledgerId: string } | undefined> {
    await this.ready;
    const row = await this.driver.get<{ issuer_node_id: string; subject_account_id: string; ledger_id: string }>(
      'SELECT issuer_node_id, subject_account_id, ledger_id FROM federated_account_bindings WHERE local_username = ?', [username]);
    return row ? { issuerNodeId: row.issuer_node_id, subjectAccountId: row.subject_account_id, ledgerId: row.ledger_id } : undefined;
  }

  /** A signed replica grant carries a password credential only for an account bound to that ledger. */
  async importFederatedPasswordCredential(input: {
    localUsername: string; sourceUsername: string; displayName: string;
    issuerNodeId: string; subjectAccountId: string;
    registrationRecord: string; serverSetup: string; disabled: boolean; sourceRevision: number;
  }): Promise<void> {
    await this.ready;
    if (!/^[\p{L}\p{N}_.-]{2,64}$/u.test(input.sourceUsername)
      || !input.displayName || Array.from(input.displayName).length > 24
      || /[\p{Cc}\p{Cf}]/u.test(input.displayName)
      || !/^[A-Za-z0-9_-]{8,128}$/.test(input.issuerNodeId)
      || !/^[A-Za-z0-9_-]{8,160}$/.test(input.subjectAccountId)
      || !input.registrationRecord || input.registrationRecord === FEDERATED_ONLY_RECORD
      || input.registrationRecord.length > 16_384 || !input.serverSetup
      || input.serverSetup.length > 16_384 || !Number.isSafeInteger(input.sourceRevision)
      || input.sourceRevision < 0) {
      throw new ServerStoreError('INVALID_FEDERATED_CREDENTIAL', 400, '统一账号凭据格式无效');
    }
    await this.driver.transaction(async (driver) => {
      const binding = await driver.get<{ issuer_node_id: string; subject_account_id: string }>(
        'SELECT issuer_node_id, subject_account_id FROM federated_account_bindings WHERE local_username = ?',
        [input.localUsername]);
      if (!binding || binding.issuer_node_id !== input.issuerNodeId
        || binding.subject_account_id !== input.subjectAccountId) {
        throw new ServerStoreError('FEDERATED_IDENTITY_CHANGED', 409, '统一账号凭据与本地身份绑定不符');
      }
      const other = await driver.get<{ local_username: string }>(
        'SELECT local_username FROM federated_password_credentials WHERE source_username = ?',
        [input.sourceUsername]);
      if (other && other.local_username !== input.localUsername) {
        throw new ServerStoreError('GROUP_USERNAME_CONFLICT', 409,
          `账号名 ${input.sourceUsername} 已被另一统一账号使用；请先由管理员处理冲突`);
      }
      const previous = await driver.get<{ source_username: string; registration_record: string;
        server_setup: string; disabled: number; source_revision: number }>(
        'SELECT source_username, registration_record, server_setup, disabled, source_revision FROM federated_password_credentials WHERE local_username = ?',
        [input.localUsername]);
      if (previous && previous.source_username !== input.sourceUsername) {
        throw new ServerStoreError('FEDERATED_USERNAME_CHANGED', 409, '统一账号登录名发生变化，需管理员迁移身份');
      }
      if (previous && input.sourceRevision > 0 && previous.source_revision > input.sourceRevision) {
        throw new ServerStoreError('FEDERATED_CREDENTIAL_ROLLBACK', 409, '统一账号凭据版本回退');
      }
      const changed = previous && (previous.registration_record !== input.registrationRecord
        || previous.server_setup !== input.serverSetup
        || Boolean(previous.disabled) !== input.disabled);
      const local = await driver.get<{ display_name: string }>(
        'SELECT display_name FROM sync_users WHERE username = ?', [input.localUsername]);
      if (previous && !changed && local?.display_name === input.displayName
        && previous.source_revision >= input.sourceRevision) return;
      if (previous && input.sourceRevision > 0 && previous.source_revision === input.sourceRevision
        && (changed || local?.display_name !== input.displayName)) {
        throw new ServerStoreError('FEDERATED_CREDENTIAL_COLLISION', 409, '同版本统一账号凭据不一致');
      }
      const at = nowIso();
      await driver.run(`INSERT INTO federated_password_credentials
        (local_username, source_username, issuer_node_id, subject_account_id,
          registration_record, server_setup, disabled, source_revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_username) DO UPDATE SET source_username = excluded.source_username,
          registration_record = excluded.registration_record, server_setup = excluded.server_setup,
          disabled = excluded.disabled, source_revision = excluded.source_revision,
          updated_at = excluded.updated_at`,
      [input.localUsername, input.sourceUsername, input.issuerNodeId, input.subjectAccountId,
        input.registrationRecord, input.serverSetup, input.disabled ? 1 : 0,
        Math.max(input.sourceRevision, previous?.source_revision ?? 0), at]);
      await driver.run('UPDATE sync_users SET display_name = ? WHERE username = ?',
        [input.displayName, input.localUsername]);
      if (changed) {
        await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ?',
          [at, at, input.localUsername]);
        await driver.run('DELETE FROM sync_opaque_login_states WHERE username = ?', [input.localUsername]);
      }
    });
  }

  async federatedPasswordCredential(sourceUsername: string): Promise<{
    localUsername: string; sourceUsername: string; issuerNodeId: string; subjectAccountId: string;
    registrationRecord: string; serverSetup: string; disabled: boolean;
  } | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM federated_password_credentials WHERE source_username = ?', [sourceUsername]);
    return row ? {
      localUsername: String(row['local_username']), sourceUsername: String(row['source_username']),
      issuerNodeId: String(row['issuer_node_id']), subjectAccountId: String(row['subject_account_id']),
      registrationRecord: String(row['registration_record']), serverSetup: String(row['server_setup']),
      disabled: bool(row['disabled']),
    } : undefined;
  }

  async federatedSourceUsername(localUsername: string): Promise<string | undefined> {
    await this.ready;
    const row = await this.driver.get<{ source_username: string }>(
      'SELECT source_username FROM federated_password_credentials WHERE local_username = ?', [localUsername]);
    return row?.source_username;
  }

  async saveRelayedCredential(bundle: FederatedCredentialBundle, signature: string,
    issuerPublicKey: string): Promise<void> {
    await this.ready;
    if (!verifyFederatedCredential(bundle, signature, issuerPublicKey)) {
      throw new ServerStoreError('INVALID_ISSUER_SIGNATURE', 403, '账号凭据签发方签名无效');
    }
    await this.driver.transaction(async (driver) => {
      const existing = await driver.get<{ revision: number; bundle_json: string; issuer_signature: string }>(`
        SELECT revision, bundle_json, issuer_signature FROM relayed_account_credentials
        WHERE ledger_id = ? AND issuer_node_id = ? AND subject_account_id = ?`,
      [bundle.ledgerId, bundle.issuerNodeId, bundle.subjectAccountId]);
      const encoded = canonicalJson(bundle);
      if (existing && existing.revision > bundle.revision) {
        throw new ServerStoreError('FEDERATED_CREDENTIAL_ROLLBACK', 409, '统一账号凭据版本回退');
      }
      if (existing && existing.revision === bundle.revision) {
        if (existing.bundle_json !== encoded || existing.issuer_signature !== signature) {
          throw new ServerStoreError('FEDERATED_CREDENTIAL_COLLISION', 409, '同版本统一账号凭据不一致');
        }
        return;
      }
      await driver.run(`INSERT INTO relayed_account_credentials
        (ledger_id, issuer_node_id, subject_account_id, revision, bundle_json, issuer_signature, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ledger_id, issuer_node_id, subject_account_id) DO UPDATE SET
          revision = excluded.revision, bundle_json = excluded.bundle_json,
          issuer_signature = excluded.issuer_signature, updated_at = excluded.updated_at`,
      [bundle.ledgerId, bundle.issuerNodeId, bundle.subjectAccountId,
        bundle.revision, encoded, signature, nowIso()]);
      await driver.run(`INSERT INTO account_directory_log
        (ledger_id, issuer_node_id, subject_account_id, revision, recorded_at)
        VALUES (?, ?, ?, ?, ?)`,
      [bundle.ledgerId, bundle.issuerNodeId, bundle.subjectAccountId, bundle.revision, nowIso()]);
    });
  }

  async relayedCredential(ledgerId: string, issuerNodeId: string,
    subjectAccountId: string): Promise<{ bundle: FederatedCredentialBundle; signature: string } | undefined> {
    await this.ready;
    const row = await this.driver.get<{ bundle_json: string; issuer_signature: string }>(`
      SELECT bundle_json, issuer_signature FROM relayed_account_credentials
      WHERE ledger_id = ? AND issuer_node_id = ? AND subject_account_id = ?`,
    [ledgerId, issuerNodeId, subjectAccountId]);
    return row ? { bundle: JSON.parse(row.bundle_json) as FederatedCredentialBundle,
      signature: row.issuer_signature } : undefined;
  }

  async accountDirectoryPage(ledgerId: string, after: number, limit = 50): Promise<{
    entries: Array<{ seq: number; bundle: FederatedCredentialBundle; signature: string }>;
    nextSeq: number; headSeq: number; hasMore: boolean;
  }> {
    await this.ready;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 50) throw new ServerStoreError('INVALID_CURSOR', 400, '账号目录游标无效');
    const head = await this.driver.get<{ seq: number }>(
      'SELECT MAX(seq) AS seq FROM account_directory_log WHERE ledger_id = ?', [ledgerId]);
    const rows = await this.driver.all<{ seq: number; bundle_json: string; issuer_signature: string }>(`
      SELECT log.seq, credential.bundle_json, credential.issuer_signature
      FROM account_directory_log log JOIN relayed_account_credentials credential
        ON credential.ledger_id = log.ledger_id AND credential.issuer_node_id = log.issuer_node_id
          AND credential.subject_account_id = log.subject_account_id
      WHERE log.ledger_id = ? AND log.seq > ? ORDER BY log.seq LIMIT ?`,
    [ledgerId, after, limit]);
    const nextSeq = rows.at(-1)?.seq ?? after;
    return { entries: rows.map((row) => ({ seq: row.seq,
      bundle: JSON.parse(row.bundle_json) as FederatedCredentialBundle,
      signature: row.issuer_signature })), nextSeq, headSeq: Number(head?.seq ?? 0),
      hasMore: nextSeq < Number(head?.seq ?? 0) };
  }

  async accountEncryptionKey(issuerNodeId: string, subjectAccountId: string): Promise<AccountEncryptionKeyRecord | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM account_encryption_keys WHERE issuer_node_id = ? AND subject_account_id = ?',
      [issuerNodeId, subjectAccountId],
    );
    return row ? { issuerNodeId, subjectAccountId, publicKey: String(row['public_key']),
      envelope: jsonObject(row['envelope_json']), revision: Number(row['revision']),
      updatedAt: String(row['updated_at']) } : undefined;
  }

  async putAccountEncryptionKey(issuerNodeId: string, subjectAccountId: string, publicKey: string,
    envelope: JsonRecord, expectedRevision: number): Promise<AccountEncryptionKeyRecord> {
    await this.ready;
    try { assertAccountEncryptionKeyEnvelope(envelope as unknown as AccountEncryptionKeyEnvelope); }
    catch { throw new ServerStoreError('INVALID_ACCOUNT_KEY', 400, '账号加密密钥包无效'); }
    if (envelope['issuerNodeId'] !== issuerNodeId || envelope['accountId'] !== subjectAccountId
      || envelope['publicKey'] !== publicKey) throw new ServerStoreError('INVALID_ACCOUNT_KEY', 400, '账号加密密钥包身份不匹配');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new ServerStoreError('INVALID_REVISION', 400, '账号密钥版本无效');
    }
    return this.driver.transaction(async (driver) => {
      const existing = await driver.get<{ public_key: string; envelope_json: string; revision: number; updated_at: string }>(
        'SELECT public_key, envelope_json, revision, updated_at FROM account_encryption_keys WHERE issuer_node_id = ? AND subject_account_id = ?',
        [issuerNodeId, subjectAccountId],
      );
      const encoded = JSON.stringify(envelope);
      if (existing && existing.public_key !== publicKey) {
        throw new ServerStoreError('ACCOUNT_KEY_CHANGED', 409, '账号加密公钥已改变，需要专门的密钥轮换流程');
      }
      if (existing && canonicalJson(JSON.parse(existing.envelope_json)) === canonicalJson(envelope)) return { issuerNodeId, subjectAccountId, publicKey,
        envelope, revision: Number(existing.revision), updatedAt: existing.updated_at };
      if (Number(existing?.revision ?? 0) !== expectedRevision) {
        throw new ServerStoreError('ACCOUNT_KEY_REVISION', 409, '账号加密密钥包已更新，请重新读取');
      }
      const at = nowIso();
      const revision = expectedRevision + 1;
      await driver.run(`INSERT INTO account_encryption_keys
        (issuer_node_id, subject_account_id, public_key, envelope_json, revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (issuer_node_id, subject_account_id) DO UPDATE SET envelope_json = excluded.envelope_json,
          revision = excluded.revision, updated_at = excluded.updated_at`,
      [issuerNodeId, subjectAccountId, publicKey, encoded, revision, at]);
      if (issuerNodeId === this.serverId) await driver.run(`UPDATE sync_users
        SET revision = revision + 1, updated_at = ?
        WHERE username = (SELECT username FROM sync_account_identities WHERE account_id = ?)`,
      [at, subjectAccountId]);
      return { issuerNodeId, subjectAccountId, publicKey, envelope, revision, updatedAt: at };
    });
  }

  async importAccountEncryptionKey(record: AccountEncryptionKeyRecord): Promise<void> {
    await this.ready;
    try { assertAccountEncryptionKeyEnvelope(record.envelope as unknown as AccountEncryptionKeyEnvelope); }
    catch { throw new ServerStoreError('INVALID_ACCOUNT_KEY', 400, '账号加密密钥包无效'); }
    if (record.envelope['issuerNodeId'] !== record.issuerNodeId || record.envelope['accountId'] !== record.subjectAccountId
      || record.envelope['publicKey'] !== record.publicKey || !Number.isSafeInteger(record.revision)
      || record.revision < 1 || !Number.isFinite(Date.parse(record.updatedAt))) {
      throw new ServerStoreError('INVALID_ACCOUNT_KEY', 400, '账号加密密钥包身份或版本无效');
    }
    await this.driver.transaction(async (driver) => {
      const existing = await driver.get<{ public_key: string; envelope_json: string; revision: number }>(
        'SELECT public_key, envelope_json, revision FROM account_encryption_keys WHERE issuer_node_id = ? AND subject_account_id = ?',
        [record.issuerNodeId, record.subjectAccountId],
      );
      const encoded = JSON.stringify(record.envelope);
      if (existing?.public_key && existing.public_key !== record.publicKey) {
        throw new ServerStoreError('ACCOUNT_KEY_CHANGED', 409, '身份节点账号加密公钥已改变');
      }
      if (existing && Number(existing.revision) > record.revision) {
        throw new ServerStoreError('ACCOUNT_KEY_ROLLBACK', 409, '身份节点账号密钥包版本倒退，复制已停止');
      }
      if (existing && Number(existing.revision) === record.revision) {
        if (canonicalJson(JSON.parse(existing.envelope_json)) !== canonicalJson(record.envelope)) {
          throw new ServerStoreError('ACCOUNT_KEY_COLLISION', 409, '账号密钥包同版本内容不一致');
        }
        return;
      }
      await driver.run(`INSERT INTO account_encryption_keys
        (issuer_node_id, subject_account_id, public_key, envelope_json, revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (issuer_node_id, subject_account_id) DO UPDATE SET envelope_json = excluded.envelope_json,
          revision = excluded.revision, updated_at = excluded.updated_at`,
      [record.issuerNodeId, record.subjectAccountId, record.publicKey, encoded, record.revision, record.updatedAt]);
    });
  }

  async createFederatedLoginState(state: string, linkId: string): Promise<void> {
    await this.ready;
    const link = await this.driver.get('SELECT 1 FROM node_replication_links WHERE link_id = ? AND enabled = 1', [linkId]);
    if (!link) throw new ServerStoreError('LINK_NOT_FOUND', 404, '统一登录节点链路不存在');
    const stateHash = createHash('sha256').update(state).digest('hex');
    await this.driver.run('DELETE FROM federated_login_intents WHERE expires_at <= ?', [nowIso()]);
    await this.driver.run('INSERT INTO federated_login_intents (state_hash, link_id, expires_at) VALUES (?, ?, ?)',
      [stateHash, linkId, new Date(Date.now() + 5 * 60_000).toISOString()]);
  }

  async consumeFederatedLoginState(state: string): Promise<string | undefined> {
    await this.ready;
    const stateHash = createHash('sha256').update(state).digest('hex');
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      const row = await driver.get<{ link_id: string }>(
        'SELECT link_id FROM federated_login_intents WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?', [stateHash, at]);
      if (!row) return undefined;
      const result = await driver.run('UPDATE federated_login_intents SET used_at = ? WHERE state_hash = ? AND used_at IS NULL', [at, stateHash]);
      return result.changes === 1 ? row.link_id : undefined;
    });
  }

  async issueFederatedLoginCode(grantId: string, username: string, subjectAccountId: string, state: string): Promise<string> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      const grant = await driver.get<{ username: string; ledger_id: string }>(
        'SELECT username, ledger_id FROM node_replication_grants WHERE grant_id = ? AND revoked_at IS NULL AND expires_at > ?', [grantId, at]);
      if (!grant) throw new ServerStoreError('GRANT_REVOKED', 403, '复制授权已失效');
      const account = await driver.get<{ account_id: string; disabled: number }>(`
        SELECT identity.account_id, user.disabled FROM sync_account_identities identity
        JOIN sync_users user ON user.username = identity.username WHERE identity.username = ?`, [username]);
      const ownerRoute = await driver.get<{ replica_id: string; ledger_id: string }>(`
        SELECT slot.replica_id, slot.ledger_id FROM ledger_account_routes route
        JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
        WHERE route.username = ?`, [grant.username]);
      const foreignIdentity = await driver.get('SELECT 1 FROM federated_account_bindings WHERE local_username = ?', [username]);
      if (foreignIdentity) throw new ServerStoreError('ISSUER_REQUIRED', 403,
        '本节点不能替其他身份节点签发统一登录凭据');
      if (!account || Number(account.disabled) || account.account_id !== subjectAccountId
        || !ownerRoute || ownerRoute.ledger_id !== grant.ledger_id) {
        throw new ServerStoreError('LEDGER_MEMBER_REQUIRED', 403, '当前账号没有该账本的访问权');
      }
      const control = await this.readLedgerControlState(driver, ownerRoute.replica_id);
      await this.assertLedgerAccessOnReplica(driver, username, ownerRoute.replica_id, 'read');
      if (username !== grant.username) {
        if (!control) throw new ServerStoreError('LEDGER_MEMBER_REQUIRED', 403, '该账本尚未开放成员登录');
        const envelope = await driver.get(`SELECT 1 FROM ledger_member_key_envelopes
          WHERE replica_id = ? AND issuer_node_id = ? AND account_id = ? AND key_epoch = ?`,
        [ownerRoute.replica_id, this.serverId, subjectAccountId, control.keyEpoch]);
        if (!envelope) throw new ServerStoreError('MEMBER_ENVELOPE_REQUIRED', 409, '成员密钥包尚未发放');
      }
      const code = randomBytes(32).toString('base64url');
      await driver.run('DELETE FROM federated_login_codes WHERE expires_at <= ?', [at]);
      await driver.run(`INSERT INTO federated_login_codes
        (code_hash, grant_id, username, subject_account_id, state, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [createHash('sha256').update(code).digest('hex'), grantId, username, subjectAccountId, state,
        new Date(Date.now() + 60_000).toISOString()]);
      return code;
    });
  }

  async consumeFederatedLoginCode(grantId: string, code: string, state: string): Promise<{ username: string; subjectAccountId: string } | undefined> {
    await this.ready;
    const codeHash = createHash('sha256').update(code).digest('hex');
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      const row = await driver.get<{ username: string; subject_account_id: string }>(
        `SELECT c.username, c.subject_account_id FROM federated_login_codes c
         JOIN node_replication_grants g ON g.grant_id = c.grant_id
         WHERE c.code_hash = ? AND c.grant_id = ? AND c.state = ? AND c.used_at IS NULL AND c.expires_at > ?
           AND g.revoked_at IS NULL AND g.expires_at > ?`, [codeHash, grantId, state, at, at]);
      if (!row) return undefined;
      const result = await driver.run('UPDATE federated_login_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', [at, codeHash]);
      return result.changes === 1 ? { username: row.username, subjectAccountId: row.subject_account_id } : undefined;
    });
  }

  async bindReplica(username: string, ledgerId: string): Promise<UserReplica> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const routed = await driver.get<Record<string, unknown>>(`SELECT route.username, slot.ledger_id,
        slot.replica_id, slot.stream_epoch, slot.head_seq, slot.created_at, slot.updated_at
        FROM ledger_account_routes route JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
        WHERE route.username = ?`, [username]);
      if (routed) {
        const replica = replicaFromRow(routed);
        if (replica.ledgerId !== ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, 'account is already bound to another ledger');
        return replica;
      }
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
      await driver.run(`UPDATE sync_sessions SET replica_id = ?, updated_at = ?
        WHERE username = ? AND kind = 'ledger' AND replica_id IS NULL`,
      [replica.replicaId, at, username]);
      await this.rebuildAccountLedgerIndex(driver, replica.replicaId);
      return replica;
    });
  }

  private async saveReplacementCheckpoint(driver: SqlDriver, username: string, replica: UserReplica, at: string): Promise<{
    mode: string; version: number; sealed_secret: string | null;
  } | undefined> {
    const activeEnvelope = await driver.get<{ keyring_id: string; generation: number; envelope_json: string }>(
      'SELECT keyring_id, generation, envelope_json FROM ledger_replica_key_envelopes WHERE replica_id = ? AND ledger_id = ?',
      [replica.replicaId, replica.ledgerId]);
    if (!activeEnvelope) throw new ServerStoreError('REPLACEMENT_BACKUP_INCOMPLETE', 409,
      '账本密钥包缺失，不能建立可恢复的替换检查点');
    const commitSize = await driver.get<{ bytes: number; count: number; first_seq: number | null;
      last_seq: number | null; wrong_ledger: number }>(`SELECT COALESCE(SUM(cipher_bytes), 0) AS bytes,
        COUNT(*) AS count, MIN(seq) AS first_seq, MAX(seq) AS last_seq,
        COALESCE(SUM(CASE WHEN ledger_id <> ? THEN 1 ELSE 0 END), 0) AS wrong_ledger
        FROM ledger_replica_commits WHERE replica_id = ?`, [replica.ledgerId, replica.replicaId]);
    if (Number(commitSize?.count) !== replica.headSeq || Number(commitSize?.wrong_ledger) !== 0
      || replica.headSeq > 0 && (Number(commitSize?.first_seq) !== 1
        || Number(commitSize?.last_seq) !== replica.headSeq)
    ) {
      throw new ServerStoreError('REPLACEMENT_BACKUP_INCOMPLETE', 409,
        '原账本提交副本尚未核对一致，不能安全替换');
    }
    const required = requiredReplicaMigrationBytes(Number(commitSize?.bytes ?? 0), Number(commitSize?.count ?? 0));
    if (required > 0n) {
      let available: bigint;
      try {
        const disk = statfsSync(dirname(this.databaseFile), { bigint: true });
        available = disk.bavail * disk.bsize;
      } catch {
        throw new ServerStoreError('REPLACEMENT_SPACE_UNKNOWN', 507, '无法检查备份空间，旧账本未替换');
      }
      if (available < required) throw new ServerStoreError('REPLACEMENT_SPACE_INSUFFICIENT', 507,
        `保存旧账本检查点需要约 ${required} 字节可用空间，旧账本未替换`);
    }
    const oldProtection = await driver.get<{
      mode: string; version: number; sealed_secret: string | null;
    }>('SELECT mode, version, sealed_secret FROM sync_key_custody WHERE username = ?', [username]);
    const checkpointId = `checkpoint-${randomBytes(16).toString('hex')}`;
    await driver.run(`INSERT INTO ledger_replacement_checkpoints
      (checkpoint_id, username, replica_id, ledger_id, stream_epoch, head_seq, envelope_json,
        protection_mode, protection_version, protection_sealed_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [checkpointId, username, replica.replicaId, replica.ledgerId, replica.streamEpoch,
      replica.headSeq, activeEnvelope.envelope_json, oldProtection?.mode ?? null,
      oldProtection?.version ?? null, oldProtection?.sealed_secret ?? null, at]);
    await driver.run(`INSERT INTO ledger_replacement_checkpoint_commits
      (checkpoint_id, seq, commit_id, ledger_id, content_hash, enc_commit_json, key_epoch,
        writer_issuer_node_id, writer_account_id, cipher_bytes, created_at)
      SELECT ?, seq, commit_id, ledger_id, content_hash, enc_commit_json, key_epoch,
        writer_issuer_node_id, writer_account_id, cipher_bytes, created_at
      FROM ledger_replica_commits WHERE replica_id = ?`, [checkpointId, replica.replicaId]);
    const copied = await driver.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM ledger_replacement_checkpoint_commits WHERE checkpoint_id = ?', [checkpointId]);
    if (Number(copied?.count) !== replica.headSeq) throw new ServerStoreError('REPLACEMENT_BACKUP_INCOMPLETE', 409,
      '旧账本检查点不完整，旧账本未替换');
    return oldProtection;
  }

  /** Replace only the explicitly confirmed replica, including its initial encrypted data. */
  async replaceReplica(username: string, sessionId: string, expected: { ledgerId: string; streamEpoch: string }, envelope: JsonRecord, commits: Omit<StoredCommit, 'seq' | 'cipherBytes' | 'createdAt'>[], protection?: Omit<LedgerProtection, 'version'>): Promise<UserReplica> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      const actor = await driver.get<{ replica_id: string | null }>(
        'SELECT replica_id FROM sync_sessions WHERE username = ? AND session_id = ? AND revoked_at IS NULL AND expires_at > ?',
        [username, sessionId, at]);
      if (!actor) throw new ServerStoreError('SESSION_REVOKED', 401, '请重新登录后再替换账本');
      const row = await driver.get<Record<string, unknown>>('SELECT * FROM sync_replicas WHERE username = ?', [username]);
      const current = row ? replicaFromRow(row) : undefined;
      if (current && actor.replica_id && actor.replica_id !== current.replicaId) {
        throw new ServerStoreError('LEGACY_REPLACEMENT_SCOPE', 409, '不能用另一个账本的会话替换旧账本');
      }
      const ledgerId = String(envelope.ledgerId);
      // A lost response can be retried without deleting any newly synchronized commits.
      if (current?.ledgerId === ledgerId) {
        const stored = await driver.get<{ envelope_json: string }>(
          'SELECT envelope_json FROM ledger_replica_key_envelopes WHERE replica_id = ?', [current.replicaId]);
        if (stored?.envelope_json === JSON.stringify(envelope)) return current;
      }
      if (!current || current.ledgerId !== expected.ledgerId || current.streamEpoch !== expected.streamEpoch || ledgerId === current.ledgerId) {
        throw new ServerStoreError('LEDGER_MISMATCH', 409, '服务器账本已变化，请重新登录并确认要替换的账本');
      }
      const routes = await driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM ledger_account_routes WHERE replica_id = ?', [current.replicaId]);
      if (Number(routes?.count) !== 1) throw new ServerStoreError('REPLICA_SHARED', 409, '共享账本不能由单个账号替换');
      const control = await driver.get<{ replica_id: string }>(
        'SELECT replica_id FROM ledger_control_roots WHERE replica_id = ?', [current.replicaId]);
      if (control) throw new ServerStoreError('REPLICA_CONTROLLED', 409, '已有成员控制链的账本不能通过单账号替换');
      const quota = await driver.get<{ commit_quota_bytes: number }>('SELECT commit_quota_bytes FROM sync_user_quotas WHERE username = ?', [username]);
      const quotaRole = await driver.get<{ role: string }>(`SELECT ${ROLE_SQL} AS role FROM sync_users u LEFT JOIN server_administrators a ON a.username = u.username LEFT JOIN server_ownership o ON o.username = u.username WHERE u.username = ?`, [username]);
      const bytes = commits.reduce((sum, commit) => sum + Buffer.byteLength(JSON.stringify(commit.encCommit)), 0);
      if (!unlimitedQuotaRole(quotaRole?.role) && bytes > Number(quota?.commit_quota_bytes ?? this.defaultCommitQuotaBytes)) throw new ServerStoreError('COMMIT_QUOTA_EXCEEDED', 507, 'encrypted commit quota exceeded');
      const oldProtection = await this.saveReplacementCheckpoint(driver, username, current, at);
      await driver.run('DELETE FROM ledger_replica_commits WHERE replica_id = ?', [current.replicaId]);
      await driver.run('DELETE FROM ledger_replica_key_envelopes WHERE replica_id = ?', [current.replicaId]);
      const next = { ...current, ledgerId, replicaId: `rep-${randomBytes(12).toString('hex')}`, streamEpoch: `epoch-${randomBytes(12).toString('hex')}`, headSeq: commits.length, updatedAt: at };
      await driver.run('UPDATE sync_replicas SET ledger_id = ?, replica_id = ?, stream_epoch = ?, head_seq = ?, updated_at = ? WHERE username = ?', [ledgerId, next.replicaId, next.streamEpoch, next.headSeq, at, username]);
      await driver.run('DELETE FROM replica_physical_status WHERE username = ? AND ledger_id IN (?, ?)',
        [username, current.ledgerId, ledgerId]);
      await driver.run(`INSERT INTO ledger_replica_blob_quotas (replica_id, quota_bytes, updated_at)
        SELECT ?, quota_bytes, ? FROM ledger_replica_blob_quotas WHERE replica_id = ?`,
      [next.replicaId, at, current.replicaId]);
      await driver.run(`INSERT INTO ledger_replica_key_envelopes
        (replica_id, ledger_id, keyring_id, generation, envelope_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [next.replicaId, ledgerId, String(envelope.keyringId), Number(envelope.generation), JSON.stringify(envelope), at]);
      if (protection) {
        await driver.run('INSERT INTO sync_key_custody (username, mode, version, sealed_secret, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(username) DO UPDATE SET mode = excluded.mode, version = sync_key_custody.version + 1, sealed_secret = excluded.sealed_secret, updated_at = excluded.updated_at', [username, protection.mode, protection.sealedSecret, at]);
      } else if (oldProtection) {
        throw new ServerStoreError('CUSTODY_REQUIRED', 409, '替换账本必须提供托管密钥');
      }
      for (const [index, commit] of commits.entries()) {
        if (commit.ledgerId !== ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, 'initial commit belongs to another ledger');
        const encoded = JSON.stringify(commit.encCommit);
        await driver.run(`INSERT INTO ledger_replica_commits
          (replica_id, seq, commit_id, ledger_id, content_hash, enc_commit_json, cipher_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [next.replicaId, index + 1, commit.commitId, ledgerId, commit.contentHash,
          encoded, Buffer.byteLength(encoded), at]);
      }
      await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ? AND session_id <> ?', [at, at, username, sessionId]);
      await driver.run('UPDATE node_replication_links SET enabled = 0, updated_at = ? WHERE username = ? AND ledger_id = ?', [at, username, current.ledgerId]);
      await driver.run('UPDATE node_replication_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE username = ? AND ledger_id = ?', [at, username, current.ledgerId]);
      await driver.run('UPDATE sync_sessions SET replica_id = ?, updated_at = ? WHERE session_id = ?',
        [next.replicaId, at, sessionId]);
      await this.rebuildAccountLedgerIndex(driver, current.replicaId);
      await this.rebuildAccountLedgerIndex(driver, next.replicaId);
      return next;
    });
  }

  async getKeyEnvelope(username: string, ledgerId: string, access: 'account' | 'node' = 'account',
    replicaId?: string): Promise<JsonRecord | undefined> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (access === 'account' && replica?.ledgerId === ledgerId) {
      await this.assertLedgerAccessOnReplica(this.driver, username, replica.replicaId, 'read');
    }
    if (!replica || replica.ledgerId !== ledgerId) return undefined;
    if (access === 'account' && await this.readLedgerControlState(this.driver, replica.replicaId)) {
      const owner = await this.driver.get<{ username: string }>(
        'SELECT username FROM sync_replicas WHERE replica_id = ?', [replica.replicaId]);
      if (owner?.username !== username) return undefined;
    }
    const row = await this.driver.get<{ envelope_json: string }>(
      'SELECT envelope_json FROM ledger_replica_key_envelopes WHERE replica_id = ? AND ledger_id = ?',
      [replica.replicaId, ledgerId]);
    return row ? jsonObject(row.envelope_json) : undefined;
  }

  async putKeyEnvelope(
    username: string,
    ledgerId: string,
    keyringId: string,
    generation: number,
    envelope: JsonRecord,
    access: 'account' | 'node' = 'account',
    replicaId?: string,
  ): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const replica = await this.accountReplicaRow(driver, username, replicaId);
      if (replica?.ledger_id !== ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, 'account is bound to another ledger');
      if (access === 'account') await this.assertLedgerAccessOnReplica(driver, username, replica.replica_id, 'manage');
      if (access === 'account' && await driver.get('SELECT 1 FROM ledger_control_roots WHERE replica_id = ?', [replica.replica_id])) {
        throw new ServerStoreError('KEY_ENVELOPE_CONTROLLED', 409, '此账本已启用成员密钥，不能通过旧密钥包接口更新');
      }
      const legacyOwner = await driver.get<{ username: string }>('SELECT username FROM sync_replicas WHERE replica_id = ?', [replica.replica_id]);
      if (legacyOwner?.username !== username) {
        throw new ServerStoreError('KEY_ENVELOPE_OWNER_REQUIRED', 403, '共享副本旧密钥包只能由原账号维护');
      }
      const current = await driver.get<{ keyring_id: string; generation: number; envelope_json: string }>(
        'SELECT keyring_id, generation, envelope_json FROM ledger_replica_key_envelopes WHERE replica_id = ?',
        [replica.replica_id],
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
        `INSERT OR REPLACE INTO ledger_replica_key_envelopes
         (replica_id, ledger_id, keyring_id, generation, envelope_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [replica.replica_id, ledgerId, keyringId, generation, serialized, nowIso()],
      );
    });
  }

  async putBackupArchive(
    username: string,
    ledgerId: string,
    archive: Omit<ServerBackupArchive, 'ledgerId'>,
    replicaId?: string,
  ): Promise<ServerBackupArchive> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (replica?.ledgerId !== ledgerId) {
      throw new ServerStoreError('LEDGER_MISMATCH', 409, '备份账本与当前会话不匹配');
    }
    const existing = await this.driver.get<Record<string, unknown>>(
      `SELECT * FROM ledger_backup_archives
       WHERE username = ? AND replica_id = ? AND archive_id = ?`,
      [username, replica.replicaId, archive.archiveId],
    );
    if (existing) {
      const current = backupFromRow(existing);
      if (current.blobId !== archive.blobId || current.sizeBytes !== archive.sizeBytes) {
        throw new ServerStoreError('BACKUP_ID_COLLISION', 409, 'backup archive id already has different content');
      }
      if (existing['deleted_at'] != null) {
        await this.driver.run(
          `UPDATE ledger_backup_archives SET deleted_at = NULL
           WHERE username = ? AND replica_id = ? AND archive_id = ?`,
          [username, replica.replicaId, archive.archiveId],
        );
      }
      return { ...current, label: archive.label };
    }
    await this.driver.run(
      `INSERT INTO ledger_backup_archives
       (username, replica_id, ledger_id, archive_id, blob_id, created_at, reason, kind, label,
        size_bytes, source_generation, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        username,
        replica.replicaId,
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
    replicaId?: string,
  ): Promise<ServerBackupArchive[]> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (replica?.ledgerId !== ledgerId) {
      throw new ServerStoreError('LEDGER_MISMATCH', 409, '备份账本与当前会话不匹配');
    }
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT * FROM ledger_backup_archives
       WHERE username = ? AND replica_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC, archive_id DESC LIMIT ?`,
      [username, replica.replicaId, Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    return rows.map(backupFromRow);
  }

  async removeBackupArchive(
    username: string,
    ledgerId: string,
    archiveId: string,
    replicaId?: string,
  ): Promise<ServerBackupArchive | undefined> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (replica?.ledgerId !== ledgerId) {
      throw new ServerStoreError('LEDGER_MISMATCH', 409, '备份账本与当前会话不匹配');
    }
    return this.driver.transaction(async (driver) => {
      const row = await driver.get<Record<string, unknown>>(
        `SELECT * FROM ledger_backup_archives
         WHERE username = ? AND replica_id = ? AND archive_id = ? AND deleted_at IS NULL`,
        [username, replica.replicaId, archiveId],
      );
      if (!row) return undefined;
      await driver.run(
        `UPDATE ledger_backup_archives SET deleted_at = ?
         WHERE username = ? AND replica_id = ? AND archive_id = ? AND deleted_at IS NULL`,
        [nowIso(), username, replica.replicaId, archiveId],
      );
      return backupFromRow(row);
    });
  }

  /** Retain bounded encrypted evidence of a rejected write even if its sender later fails. */
  async recordRejectedNodeCommit(username: string, peerNodeId: string,
    item: Omit<StoredCommit, 'seq' | 'cipherBytes' | 'createdAt'>, reason: string,
    replicaId?: string): Promise<void> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (!replica || item.ledgerId !== replica.ledgerId
      || !/^[A-Za-z0-9_-]{8,128}$/.test(peerNodeId)
      || !Number.isSafeInteger(item.keyEpoch) || Number(item.keyEpoch) < 0
      || !/^[a-f0-9]{64}$/.test(item.contentHash)) {
      throw new ServerStoreError('INVALID_REJECTED_COMMIT', 400, '无法记录无效的远端提交');
    }
    const at = nowIso();
    const encoded = JSON.stringify(item.encCommit);
    const bytes = Buffer.byteLength(encoded);
    await this.driver.transaction(async (driver) => {
      const prior = await driver.get<{ content_hash: string }>(`SELECT content_hash
        FROM ledger_replica_rejected_commits WHERE replica_id = ? AND peer_node_id = ? AND commit_id = ?`,
      [replica.replicaId, peerNodeId, item.commitId]);
      if (prior && prior.content_hash !== item.contentHash) {
        throw new ServerStoreError('REJECTED_COMMIT_COLLISION', 409, '隔离提交 ID 的内容哈希已改变');
      }
      await driver.run(`INSERT INTO ledger_replica_rejected_commits
        (replica_id, peer_node_id, commit_id, content_hash, key_epoch,
          writer_issuer_node_id, writer_account_id, reason, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (replica_id, peer_node_id, commit_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at, reason = excluded.reason`,
      [replica.replicaId, peerNodeId, item.commitId, item.contentHash, item.keyEpoch!,
        item.writer?.issuerNodeId ?? null, item.writer?.accountId ?? null, reason, at, at]);
      const used = await driver.get<{ bytes: number }>(`SELECT COALESCE(SUM(cipher_bytes), 0) AS bytes
        FROM ledger_replica_rejected_payloads WHERE replica_id = ?`, [replica.replicaId]);
      if (bytes <= 16 * 1024 * 1024 && Number(used?.bytes ?? 0) + bytes <= 512 * 1024 * 1024) {
        await driver.run(`INSERT OR IGNORE INTO ledger_replica_rejected_payloads
          (replica_id, peer_node_id, commit_id, enc_commit_json, cipher_bytes) VALUES (?, ?, ?, ?, ?)`,
        [replica.replicaId, peerNodeId, item.commitId, encoded, bytes]);
      }
    });
  }

  async listReplacementCheckpoints(username: string): Promise<LedgerReplacementCheckpoint[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(`SELECT checkpoint.checkpoint_id,
      checkpoint.ledger_id, checkpoint.replica_id, checkpoint.stream_epoch,
      checkpoint.head_seq, checkpoint.created_at, checkpoint.restored_at
      FROM ledger_replacement_checkpoints checkpoint
      JOIN ledger_replica_slots slot ON slot.replica_id = checkpoint.replica_id
        AND slot.ledger_id = checkpoint.ledger_id
        AND slot.stream_epoch = checkpoint.stream_epoch
        AND slot.head_seq = checkpoint.head_seq
      WHERE checkpoint.username = ? AND checkpoint.replica_id <>
        COALESCE((SELECT replica_id FROM sync_replicas WHERE username = ?), '')
        AND NOT EXISTS (SELECT 1 FROM ledger_replica_commits active
          WHERE active.replica_id = checkpoint.replica_id)
      ORDER BY checkpoint.created_at DESC, checkpoint.checkpoint_id DESC LIMIT 30`, [username, username]);
    return rows.map((row) => ({
      checkpointId: String(row['checkpoint_id']), ledgerId: String(row['ledger_id']),
      replicaId: String(row['replica_id']), streamEpoch: String(row['stream_epoch']),
      headSeq: Number(row['head_seq']), createdAt: String(row['created_at']),
      ...(row['restored_at'] ? { restoredAt: String(row['restored_at']) } : {}),
    }));
  }

  /** Restore an encrypted personal replica without discarding the currently active one. */
  async restoreReplacementCheckpoint(username: string, sessionId: string,
    expected: { ledgerId: string; streamEpoch: string }, checkpointId: string): Promise<UserReplica> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const at = nowIso();
      const actor = await driver.get<{ replica_id: string | null }>(
        'SELECT replica_id FROM sync_sessions WHERE username = ? AND session_id = ? AND revoked_at IS NULL AND expires_at > ?',
        [username, sessionId, at]);
      if (!actor) throw new ServerStoreError('SESSION_REVOKED', 401, '请重新登录后再恢复账本');
      const row = await driver.get<Record<string, unknown>>('SELECT * FROM sync_replicas WHERE username = ?', [username]);
      const current = row ? replicaFromRow(row) : undefined;
      if (!current || actor.replica_id && actor.replica_id !== current.replicaId) {
        throw new ServerStoreError('LEGACY_REPLACEMENT_SCOPE', 409, '只能恢复此账号当前的个人账本');
      }
      const checkpoint = await driver.get<{
        checkpoint_id: string; replica_id: string; ledger_id: string; stream_epoch: string;
        head_seq: number; envelope_json: string; protection_mode: string | null;
        protection_sealed_secret: string | null;
      }>(`SELECT * FROM ledger_replacement_checkpoints
        WHERE checkpoint_id = ? AND username = ?`, [checkpointId, username]);
      if (!checkpoint) throw new ServerStoreError('CHECKPOINT_NOT_FOUND', 404, '找不到此账号的替换前检查点');
      if (current.replicaId === checkpoint.replica_id) return current;
      if (current.ledgerId !== expected.ledgerId || current.streamEpoch !== expected.streamEpoch) {
        throw new ServerStoreError('LEDGER_MISMATCH', 409, '当前账本已变化，请刷新后重新确认恢复');
      }
      const routes = await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM ledger_account_routes WHERE replica_id = ?', [current.replicaId]);
      if (Number(routes?.count) !== 1) throw new ServerStoreError('REPLICA_SHARED', 409, '共享账本不能由单个账号恢复');
      if (await driver.get('SELECT 1 FROM ledger_control_roots WHERE replica_id IN (?, ?)',
        [current.replicaId, checkpoint.replica_id])) {
        throw new ServerStoreError('REPLICA_CONTROLLED', 409, '已有成员控制链的账本不能通过单账号恢复');
      }
      const target = await driver.get<{ ledger_id: string; stream_epoch: string; head_seq: number }>(
        'SELECT ledger_id, stream_epoch, head_seq FROM ledger_replica_slots WHERE replica_id = ?', [checkpoint.replica_id]);
      const targetRoutes = await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM ledger_account_routes WHERE replica_id = ?', [checkpoint.replica_id]);
      const targetCommits = await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM ledger_replica_commits WHERE replica_id = ?', [checkpoint.replica_id]);
      const saved = await driver.get<{ count: number; first_seq: number | null; last_seq: number | null; wrong_ledger: number }>(`
        SELECT COUNT(*) AS count, MIN(seq) AS first_seq, MAX(seq) AS last_seq,
          COALESCE(SUM(CASE WHEN ledger_id <> ? THEN 1 ELSE 0 END), 0) AS wrong_ledger
        FROM ledger_replacement_checkpoint_commits WHERE checkpoint_id = ?`,
      [checkpoint.ledger_id, checkpointId]);
      if (!target || target.ledger_id !== checkpoint.ledger_id || target.stream_epoch !== checkpoint.stream_epoch
        || Number(target.head_seq) !== Number(checkpoint.head_seq) || Number(targetRoutes?.count) !== 0
        || Number(targetCommits?.count) !== 0 || Number(saved?.count) !== Number(checkpoint.head_seq)
        || Number(saved?.wrong_ledger) !== 0 || Number(checkpoint.head_seq) > 0
          && (Number(saved?.first_seq) !== 1 || Number(saved?.last_seq) !== Number(checkpoint.head_seq))) {
        throw new ServerStoreError('CHECKPOINT_INCOMPLETE', 409, '旧副本检查点或附件目录已变化，请从整机备份恢复');
      }
      const envelope = jsonObject(checkpoint.envelope_json);
      if (envelope.ledgerId !== checkpoint.ledger_id || typeof envelope.keyringId !== 'string'
        || !Number.isSafeInteger(envelope.generation)) {
        throw new ServerStoreError('CHECKPOINT_INCOMPLETE', 409, '旧账本密钥包检查失败');
      }
      await this.saveReplacementCheckpoint(driver, username, current, at);
      await driver.run('DELETE FROM ledger_replica_commits WHERE replica_id = ?', [current.replicaId]);
      await driver.run('DELETE FROM ledger_replica_key_envelopes WHERE replica_id = ?', [current.replicaId]);
      await driver.run(`UPDATE sync_replicas SET ledger_id = ?, replica_id = ?, stream_epoch = ?,
         head_seq = ?, updated_at = ? WHERE username = ?`,
      [checkpoint.ledger_id, checkpoint.replica_id, checkpoint.stream_epoch, checkpoint.head_seq, at, username]);
      await driver.run('DELETE FROM replica_physical_status WHERE username = ? AND ledger_id IN (?, ?)',
        [username, current.ledgerId, checkpoint.ledger_id]);
      await driver.run(`INSERT INTO ledger_replica_key_envelopes
        (replica_id, ledger_id, keyring_id, generation, envelope_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [checkpoint.replica_id, checkpoint.ledger_id, String(envelope.keyringId),
        Number(envelope.generation), checkpoint.envelope_json, at]);
      await driver.run(`INSERT INTO ledger_replica_commits
        (replica_id, seq, commit_id, ledger_id, content_hash, enc_commit_json, key_epoch,
          writer_issuer_node_id, writer_account_id, cipher_bytes, created_at)
        SELECT ?, seq, commit_id, ledger_id, content_hash, enc_commit_json, key_epoch,
          writer_issuer_node_id, writer_account_id, cipher_bytes, created_at
        FROM ledger_replacement_checkpoint_commits WHERE checkpoint_id = ? ORDER BY seq`,
      [checkpoint.replica_id, checkpointId]);
      if (checkpoint.protection_mode) {
        await driver.run(`INSERT INTO sync_key_custody
          (username, mode, version, sealed_secret, updated_at) VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(username) DO UPDATE SET mode = excluded.mode,
            version = sync_key_custody.version + 1,
            sealed_secret = excluded.sealed_secret, updated_at = excluded.updated_at`,
        [username, checkpoint.protection_mode, checkpoint.protection_sealed_secret, at]);
      } else {
        await driver.run('DELETE FROM sync_key_custody WHERE username = ?', [username]);
      }
      await driver.run('UPDATE ledger_replacement_checkpoints SET restored_at = ? WHERE checkpoint_id = ?', [at, checkpointId]);
      await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ? AND session_id <> ?', [at, at, username, sessionId]);
      await driver.run('UPDATE sync_sessions SET replica_id = ?, updated_at = ? WHERE session_id = ?',
        [checkpoint.replica_id, at, sessionId]);
      await driver.run('UPDATE node_replication_links SET enabled = 0, updated_at = ? WHERE username = ? AND ledger_id = ?',
        [at, username, current.ledgerId]);
      await driver.run('UPDATE node_replication_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE username = ? AND ledger_id = ?',
        [at, username, current.ledgerId]);
      await this.rebuildAccountLedgerIndex(driver, current.replicaId);
      await this.rebuildAccountLedgerIndex(driver, checkpoint.replica_id);
      return { ...current, ledgerId: checkpoint.ledger_id, replicaId: checkpoint.replica_id,
        streamEpoch: checkpoint.stream_epoch, headSeq: Number(checkpoint.head_seq), updatedAt: at };
    });
  }

  async listRejectedNodeCommits(username: string, replicaId?: string): Promise<{ peerNodeId: string; commitId: string;
    contentHash: string; keyEpoch: number; writer?: LedgerMemberIdentity; reason: string;
    firstSeenAt: string; lastSeenAt: string; archived: boolean;
    resolution?: { decision: 'replay' | 'discard'; replacementCommitId?: string } }[]> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
    await this.assertLedgerAccessOnReplica(this.driver, username, replica.replicaId, 'manage');
    const rows = await this.driver.all<Record<string, unknown>>(`SELECT rejected.*, payload.cipher_bytes,
      resolution.decision, resolution.replacement_commit_id
      FROM ledger_replica_rejected_commits rejected LEFT JOIN ledger_replica_rejected_payloads payload
        ON payload.replica_id = rejected.replica_id AND payload.peer_node_id = rejected.peer_node_id
          AND payload.commit_id = rejected.commit_id
      LEFT JOIN ledger_control_resolutions resolution ON resolution.replica_id = rejected.replica_id
        AND resolution.rejected_commit_id = rejected.commit_id
        AND resolution.rejected_content_hash = rejected.content_hash
      WHERE rejected.replica_id = ? ORDER BY rejected.last_seen_at DESC LIMIT 200`, [replica.replicaId]);
    return rows.map((row) => ({ peerNodeId: String(row['peer_node_id']), commitId: String(row['commit_id']),
      contentHash: String(row['content_hash']), keyEpoch: Number(row['key_epoch']),
      ...(row['writer_issuer_node_id'] && row['writer_account_id'] ? {
        writer: { issuerNodeId: String(row['writer_issuer_node_id']), accountId: String(row['writer_account_id']) },
      } : {}), reason: String(row['reason']), firstSeenAt: String(row['first_seen_at']),
      lastSeenAt: String(row['last_seen_at']), archived: row['cipher_bytes'] != null,
      ...(row['decision'] ? { resolution: { decision: String(row['decision']) as 'replay' | 'discard',
        ...(row['replacement_commit_id'] ? { replacementCommitId: String(row['replacement_commit_id']) } : {}) } } : {}) }));
  }

  async rejectedNodeCommitCiphertext(username: string, peerNodeId: string, commitId: string,
    replicaId?: string): Promise<{ commitId: string; ledgerId: string; contentHash: string;
      keyEpoch: number; writer?: LedgerMemberIdentity; encCommit: JsonRecord } | undefined> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
    await this.assertLedgerAccessOnReplica(this.driver, username, replica.replicaId, 'manage');
    const row = await this.driver.get<Record<string, unknown>>(`SELECT rejected.*, payload.enc_commit_json
      FROM ledger_replica_rejected_commits rejected JOIN ledger_replica_rejected_payloads payload
        ON payload.replica_id = rejected.replica_id AND payload.peer_node_id = rejected.peer_node_id
          AND payload.commit_id = rejected.commit_id
      WHERE rejected.replica_id = ? AND rejected.peer_node_id = ? AND rejected.commit_id = ?`,
    [replica.replicaId, peerNodeId, commitId]);
    if (!row) return undefined;
    return { commitId, ledgerId: replica.ledgerId, contentHash: String(row['content_hash']),
      keyEpoch: Number(row['key_epoch']),
      ...(row['writer_issuer_node_id'] && row['writer_account_id'] ? {
        writer: { issuerNodeId: String(row['writer_issuer_node_id']), accountId: String(row['writer_account_id']) },
      } : {}), encCommit: JSON.parse(String(row['enc_commit_json'])) as JsonRecord };
  }

  async listCommits(username: string, after: number, limit: number, access: 'account' | 'node' = 'account',
    replicaId?: string): Promise<{ commits: StoredCommit[]; headSeq: number; nextSeq: number; hasMore: boolean }> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
    if (access === 'account') await this.assertLedgerAccessOnReplica(this.driver, username, replica.replicaId, 'read');
    const rows = await this.driver.all<Record<string, unknown>>(`SELECT commit_row.*,
      resolution.rejected_commit_id AS resolved_commit_id FROM ledger_replica_commits commit_row
      LEFT JOIN ledger_control_resolutions resolution ON resolution.replica_id = commit_row.replica_id
        AND resolution.rejected_commit_id = commit_row.commit_id
        AND resolution.rejected_content_hash = commit_row.content_hash
      WHERE commit_row.replica_id = ? AND commit_row.seq > ? ORDER BY commit_row.seq LIMIT ?`,
    [replica.replicaId, after, limit]);
    const commits = rows.map((row): StoredCommit => ({
      seq: Number(row['seq']), commitId: String(row['commit_id']), ledgerId: String(row['ledger_id']),
      contentHash: String(row['content_hash']), encCommit: jsonObject(row['enc_commit_json']),
      keyEpoch: Number(row['key_epoch'] ?? 0),
      ...(row['writer_issuer_node_id'] && row['writer_account_id'] ? {
        writer: { issuerNodeId: String(row['writer_issuer_node_id']), accountId: String(row['writer_account_id']) },
      } : {}),
      cipherBytes: Number(row['cipher_bytes']), createdAt: String(row['created_at']),
      ...(row['resolved_commit_id'] ? { quarantined: true } : {}),
    }));
    const nextSeq = commits.at(-1)?.seq ?? after;
    return { commits, headSeq: replica.headSeq, nextSeq, hasMore: nextSeq < replica.headSeq };
  }

  async listLedgerRequirements(username: string, ledgerId: string, replicaId?: string): Promise<string[]> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (!replica || replica.ledgerId !== ledgerId) return [];
    const rows = await this.driver.all<{ capability: string }>(
      `SELECT capability FROM ledger_replica_requirements
       WHERE replica_id = ? ORDER BY capability`, [replica.replicaId]);
    return rows.map((row) => row.capability);
  }

  async pushCommits(username: string, incoming: Omit<StoredCommit, 'seq' | 'cipherBytes' | 'createdAt'>[], capabilities: string[] = [], requiredCapabilities: string[] = [], access: 'account' | 'node' = 'account', replicaId?: string): Promise<{ assigned: { commitId: string; seq: number; contentHash: string }[]; replica: UserReplica }> {
    await this.ready;
    return this.driver.transaction(async (driver) => {
      const replicaRow = replicaId
        ? await driver.get<Record<string, unknown>>(`SELECT membership.username, slot.ledger_id,
          slot.replica_id, slot.stream_epoch, slot.head_seq, slot.created_at, slot.updated_at
          FROM account_ledger_index membership JOIN ledger_replica_slots slot ON slot.replica_id = membership.replica_id
          WHERE membership.username = ? AND membership.replica_id = ?`, [username, replicaId])
        : await driver.get<Record<string, unknown>>(`SELECT route.username, slot.ledger_id,
          slot.replica_id, slot.stream_epoch, slot.head_seq, slot.created_at, slot.updated_at
          FROM ledger_account_routes route JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
          WHERE route.username = ?`, [username]);
      if (!replicaRow) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
      const replica = replicaFromRow(replicaRow);
      if (await driver.get('SELECT 1 FROM server_meta WHERE key = ?',
        [`replica_retired:${replica.replicaId}`])) {
        throw new ServerStoreError('REPLICA_RETIRED', 409, '本节点已移出副本组，当前账本禁止继续写入');
      }
      if (access === 'account') await this.assertLedgerAccessOnReplica(driver, username, replica.replicaId, 'write');
      const control = incoming.length ? await this.readLedgerControlState(driver, replica.replicaId) : undefined;
      const accountIdentity = control && access === 'account' ? await driver.get<{
        account_id: string; issuer_node_id: string | null; subject_account_id: string | null;
      }>(`SELECT identity.account_id, binding.issuer_node_id, binding.subject_account_id
        FROM sync_account_identities identity LEFT JOIN federated_account_bindings binding
          ON binding.local_username = identity.username WHERE identity.username = ?`, [username]) : undefined;
      const accountWriter = accountIdentity ? {
        issuerNodeId: accountIdentity.issuer_node_id ?? this.serverId,
        accountId: accountIdentity.subject_account_id ?? accountIdentity.account_id,
      } : undefined;
      const requirements = await driver.all<{ capability: string }>('SELECT capability FROM ledger_replica_requirements WHERE replica_id = ?', [replica.replicaId]);
      if (requiredCapabilities.some((capability) => capability !== 'asset-cost-v2')) throw new ServerStoreError('UNSUPPORTED_CAPABILITY', 409, 'server upgrade required');
      const required = new Set([...requirements.map((row) => row.capability), ...requiredCapabilities]);
      if ([...required].some((capability) => !capabilities.includes(capability))) throw new ServerStoreError('CLIENT_UPGRADE_REQUIRED', 409, '该账本需要 asset-cost-v2，请升级客户端后再写入');
      const storageOwner = await driver.get<{ username: string }>('SELECT username FROM sync_replicas WHERE replica_id = ?', [replica.replicaId]);
      const billingUsername = storageOwner?.username ?? username;
      for (const capability of requiredCapabilities) {
        await driver.run('INSERT OR IGNORE INTO ledger_replica_requirements (replica_id, capability) VALUES (?, ?)',
          [replica.replicaId, capability]);
      }
      const quotaRow = await driver.get<{ commit_quota_bytes: number }>('SELECT commit_quota_bytes FROM sync_user_quotas WHERE username = ?', [billingUsername]);
      const quotaRole = await driver.get<{ role: string }>(`SELECT ${ROLE_SQL} AS role FROM sync_users u LEFT JOIN server_administrators a ON a.username = u.username LEFT JOIN server_ownership o ON o.username = u.username WHERE u.username = ?`, [billingUsername]);
      const usedRow = await driver.get<{ bytes: number }>('SELECT COALESCE(SUM(cipher_bytes), 0) AS bytes FROM ledger_replica_commits WHERE replica_id = ?', [replica.replicaId]);
      const quota = Number(quotaRow?.commit_quota_bytes ?? this.defaultCommitQuotaBytes);
      let projected = Number(usedRow?.bytes ?? 0);
      let headSeq = replica.headSeq;
      const assigned: { commitId: string; seq: number; contentHash: string }[] = [];
      for (const item of incoming) {
        if (item.ledgerId !== replica.ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, 'account is bound to another ledger');
        const resolution = await driver.get<{ rejected_content_hash: string }>(`SELECT rejected_content_hash
          FROM ledger_control_resolutions WHERE replica_id = ? AND rejected_commit_id = ?`,
        [replica.replicaId, item.commitId]);
        if (resolution) throw new ServerStoreError('RESOLVED_COMMIT_QUARANTINED', 409,
          resolution.rejected_content_hash === item.contentHash
            ? '原提交已由账本所有者签名处置，不再进入活动账本'
            : '原提交 ID 与已签名处置记录的内容哈希不同', item.commitId);
        // A browser can pull an old ciphertext from the sending node and then
        // re-encrypt that same logical commit with today's key. Never treat that
        // automatic relay as the current member approving a quarantined write.
        if (access === 'account' && control) {
          const rejected = await driver.get<{ content_hash: string }>(`
            SELECT content_hash FROM ledger_replica_rejected_commits
            WHERE replica_id = ? AND commit_id = ? LIMIT 1`, [replica.replicaId, item.commitId]);
          if (rejected) throw new ServerStoreError('REJECTED_COMMIT_REVIEW_REQUIRED', 409,
            rejected.content_hash === item.contentHash
              ? '此提交曾因旧权限或密钥代次被隔离，须审核后以新提交重新记账'
              : '此提交 ID 已对应一条被隔离的其他内容', item.commitId);
        }
        const existing = await driver.get<{ seq: number; content_hash: string }>('SELECT seq, content_hash FROM ledger_replica_commits WHERE replica_id = ? AND commit_id = ?', [replica.replicaId, item.commitId]);
        if (existing) {
          if (existing.content_hash !== item.contentHash) throw new ServerStoreError('COMMIT_ID_COLLISION', 409, `commit ${item.commitId} has different content`);
          assigned.push({ commitId: item.commitId, seq: Number(existing.seq), contentHash: existing.content_hash });
          continue;
        }
        const keyEpoch = access === 'account' ? control?.keyEpoch ?? 0 : item.keyEpoch;
        const writer = access === 'account' ? accountWriter : item.writer;
        if (!Number.isSafeInteger(keyEpoch) || keyEpoch! < 0
          || keyEpoch! > 0 && (!writer || !/^[A-Za-z0-9_-]{8,160}$/.test(writer.issuerNodeId)
            || !/^[A-Za-z0-9_-]{8,160}$/.test(writer.accountId))) {
          throw new ServerStoreError('INVALID_COMMIT_EPOCH', 400, '提交缺少有效的密钥代次或写入账号');
        }
        const epoch = keyEpoch as number;
        if (control && epoch === 0) {
          throw new ServerStoreError('STALE_COMMIT_EPOCH', 409,
            '成员控制链建立后不能接收没有密钥代次的节点提交', item.commitId);
        }
        if (control) {
          if (epoch !== control.keyEpoch) {
            throw new ServerStoreError('STALE_COMMIT_EPOCH', 409,
              '离线提交属于旧密钥代次，已停止复制并等待处理', item.commitId);
          }
          const member = control.members[`${writer!.issuerNodeId}/${writer!.accountId}`];
          if (!member || member.removed || member.role === 'VIEWER') {
            throw new ServerStoreError('STALE_COMMIT_WRITER', 409,
              '提交写入账号已无当前账本写入权', item.commitId);
          }
          const envelopeRow = await driver.get<{ envelope_json: string }>(`SELECT envelope_json
            FROM ledger_member_key_envelopes WHERE replica_id = ? AND issuer_node_id = ?
              AND account_id = ? AND key_epoch = ?`,
          [replica.replicaId, writer!.issuerNodeId, writer!.accountId, epoch]);
          if (!envelopeRow) throw new ServerStoreError('MEMBER_ENVELOPE_REQUIRED', 409, '当前成员密钥包尚未发放');
          const envelope = JSON.parse(envelopeRow.envelope_json) as LedgerMemberKeyEnvelope;
          if (item.encCommit['keyId'] !== envelope.activeKeyId) {
            throw new ServerStoreError('COMMIT_KEY_EPOCH_MISMATCH', 409,
              '提交未使用当前密钥代次的活动数据密钥', item.commitId);
          }
        } else if (!control && epoch > 0) {
          throw new ServerStoreError('CONTROL_UNINITIALIZED', 409, '成员控制链尚未到达此节点');
        }
        const encoded = JSON.stringify(item.encCommit);
        const bytes = Buffer.byteLength(encoded);
        if (!unlimitedQuotaRole(quotaRole?.role) && projected + bytes > quota) throw new ServerStoreError('COMMIT_QUOTA_EXCEEDED', 507, 'encrypted commit quota exceeded');
        headSeq += 1;
        projected += bytes;
        const at = nowIso();
        await driver.run(`INSERT INTO ledger_replica_commits
          (replica_id, seq, commit_id, ledger_id, content_hash, enc_commit_json, key_epoch,
            writer_issuer_node_id, writer_account_id, cipher_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [replica.replicaId, headSeq, item.commitId, item.ledgerId, item.contentHash, encoded,
          epoch, writer?.issuerNodeId ?? null, writer?.accountId ?? null, bytes, at]);
        assigned.push({ commitId: item.commitId, seq: headSeq, contentHash: item.contentHash });
      }
      const at = nowIso();
      if (storageOwner) {
        // Keep the primary account route's head aligned with the canonical slot.
        await driver.run('UPDATE sync_replicas SET head_seq = ?, updated_at = ? WHERE replica_id = ?', [headSeq, at, replica.replicaId]);
      } else {
        await driver.run('UPDATE ledger_replica_slots SET head_seq = ?, updated_at = ? WHERE replica_id = ?', [headSeq, at, replica.replicaId]);
      }
      await driver.run('UPDATE sync_users SET updated_at = ? WHERE username = ?', [at, username]);
      return { assigned, replica: { ...replica, headSeq, updatedAt: at } };
    });
  }

  async setCommitQuota(username: string, quotaBytes?: number): Promise<void> {
    await this.ready;
    if (quotaBytes === undefined) await this.driver.run('DELETE FROM sync_user_quotas WHERE username = ?', [username]);
    else await this.driver.run('INSERT OR REPLACE INTO sync_user_quotas (username, commit_quota_bytes, updated_at) VALUES (?, ?, ?)', [username, quotaBytes, nowIso()]);
  }

  async commitUsage(username: string, replicaId?: string): Promise<{ usedBytes: number; quotaBytes: number | null; commitCount: number }> {
    await this.ready;
    const replica = await this.getReplica(username, replicaId);
    if (replicaId && !replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '账本不属于当前账号');
    const owner = replica ? await this.driver.get<{ username: string }>('SELECT username FROM sync_replicas WHERE replica_id = ?', [replica.replicaId]) : undefined;
    const billingUsername = owner?.username ?? username;
    const usageKey = replica?.replicaId ?? '';
    const row = await this.driver.get<{ used_bytes: number; quota_bytes: number; commit_count: number }>(
      `SELECT
        (SELECT COALESCE(SUM(cipher_bytes), 0) FROM ledger_replica_commits WHERE replica_id = ?) AS used_bytes,
        (SELECT COUNT(*) FROM ledger_replica_commits WHERE replica_id = ?) AS commit_count,
        COALESCE((SELECT commit_quota_bytes FROM sync_user_quotas WHERE username = ?), ?) AS quota_bytes`,
      [usageKey, usageKey, billingUsername, this.defaultCommitQuotaBytes],
    );
    return {
      usedBytes: Number(row?.used_bytes ?? 0),
      quotaBytes: unlimitedQuotaRole(await this.roleForUser(billingUsername)) ? null : Number(row?.quota_bytes ?? this.defaultCommitQuotaBytes),
      commitCount: Number(row?.commit_count ?? 0),
    };
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
    sort?: ResolvedSort;
  }): Promise<{ logs: ServerLog[]; nextCursor?: string }> {
    const sort = options.sort ?? resolveSort(LOG_SORT_OPTIONS, null, 'at', null);
    await this.ready;
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (options.level) { clauses.push('level = ?'); params.push(options.level); }
    if (options.username) { clauses.push('username = ?'); params.push(options.username); }
    if (options.action) { clauses.push('action = ?'); params.push(options.action); }
    if (options.from) { clauses.push('at >= ?'); params.push(options.from); }
    if (options.until) { clauses.push('at < ?'); params.push(options.until); }
    // The cursor is compared against the ordering expression, so the two are built together.
    const cursor = readCursor(options.cursor);
    const cursorClause = cursor ? sort.cursor(sort.value(cursor.value), cursor.id) : undefined;
    if (cursorClause) clauses.push(cursorClause.sql);
    // Lets an operator jump from an error message straight to the request log line.
    if (options.requestId) { clauses.push("instr(COALESCE(detail_json, ''), ?) > 0"); params.push(options.requestId); }
    let sql = 'SELECT * FROM server_logs';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ` ORDER BY ${sort.orderBy} LIMIT ?`;
    params.push(...(cursorClause ? cursorClause.params : []), options.limit + 1);
    const rows = await this.driver.all<Record<string, unknown>>(sql, params);
    const page = rows.slice(0, options.limit).map((row): ServerLog => ({
      id: String(row['id']), at: String(row['at']), level: String(row['level']) as ServerLogLevel,
      action: String(row['action']), message: String(row['message']),
      ...(row['ip'] == null ? {} : { ip: String(row['ip']) }),
      ...(row['username'] == null ? {} : { username: String(row['username']) }),
      ...(row['status'] == null ? {} : { status: Number(row['status']) }),
      ...(row['detail_json'] == null ? {} : { detail: jsonObject(row['detail_json']) }),
    }));
    // The cursor carries the sort it belongs to, so it cannot be reused under another ordering.
    const lastRow = rows.length > options.limit ? rows[options.limit - 1] : undefined;
    const last = page.at(-1);
    return {
      logs: page,
      ...(lastRow && last ? { nextCursor: sort.write(cursorValue(lastRow, sort), last.id) } : {}),
    };
  }

  /** Aggregate the retained log, not the current cursor page, for an honest error trend. */
  async logLevelTrend(from: string, until: string, granularity: 'minute' | 'hour' | 'day'): Promise<{
    bucketAt: string; info: number; warn: number; error: number;
  }[]> {
    await this.ready;
    const bucket = granularity === 'minute'
      ? "substr(at, 1, 16) || ':00.000Z'"
      : granularity === 'hour'
        ? "substr(at, 1, 13) || ':00:00.000Z'"
        : "substr(at, 1, 10) || 'T00:00:00.000Z'";
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT ${bucket} AS bucket_at,
        SUM(CASE WHEN level = 'info' THEN 1 ELSE 0 END) AS info,
        SUM(CASE WHEN level = 'warn' THEN 1 ELSE 0 END) AS warn,
        SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS error
       FROM server_logs WHERE at >= ? AND at < ?
       GROUP BY bucket_at ORDER BY bucket_at`, [from, until]);
    return rows.map((row) => ({
      bucketAt: String(row['bucket_at']),
      info: Number(row['info'] ?? 0), warn: Number(row['warn'] ?? 0), error: Number(row['error'] ?? 0),
    }));
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
        (SELECT COUNT(*) FROM ledger_replica_commits) AS commit_count,
        (SELECT COALESCE(SUM(cipher_bytes), 0) FROM ledger_replica_commits) AS commit_bytes,
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

  async importFederatedLedgerProtection(username: string, issuerNodeId: string,
    ledgerId: string, mode: 'managed', sealedSecret: string): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const bound = await driver.get<{ issuer_node_id: string; ledger_id: string }>(
        'SELECT issuer_node_id, ledger_id FROM federated_account_bindings WHERE local_username = ?', [username]);
      const replica = await driver.get('SELECT 1 FROM sync_replicas WHERE username = ? AND ledger_id = ?',
        [username, ledgerId]);
      if (!bound || bound.issuer_node_id !== issuerNodeId || !replica) {
        throw new ServerStoreError('FEDERATED_IDENTITY_CHANGED', 409, '统一账号账本保护身份不匹配');
      }
      const current = await driver.get<{ mode: string; sealed_secret: string | null }>(
        'SELECT mode, sealed_secret FROM sync_key_custody WHERE username = ?', [username]);
      if (current?.mode === mode && current.sealed_secret === sealedSecret) return;
      await driver.run(`INSERT INTO sync_key_custody (username, mode, version, sealed_secret, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(username) DO UPDATE SET mode = excluded.mode,
          version = sync_key_custody.version + 1, sealed_secret = excluded.sealed_secret,
          updated_at = excluded.updated_at`, [username, mode, sealedSecret, nowIso()]);
      if (current && current.mode !== 'relay') {
        const at = nowIso();
        await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ?',
          [at, at, username]);
      }
    });
  }

  /** Compare-and-swap custody and the matching envelope together, under the live session. */
  async setLedgerProtection(username: string, sessionId: string, expectedVersion: number, next: Omit<LedgerProtection, 'version'>, envelope: JsonRecord): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const session = await driver.get<{ revoked_at: string | null; expires_at: string;
        replica_id: string | null; kind: string }>(
        'SELECT revoked_at, expires_at, replica_id, kind FROM sync_sessions WHERE session_id = ? AND username = ?',
        [sessionId, username]);
      if (!session || session.revoked_at || session.expires_at <= nowIso()) throw new ServerStoreError('UNAUTHORIZED', 401, 'session expired');
      const current = await driver.get<{ version: number }>('SELECT version FROM sync_key_custody WHERE username = ?', [username]);
      if (Number(current?.version ?? 0) !== expectedVersion) throw new ServerStoreError('PROTECTION_CHANGED', 409, '保护设置已变化，请重新读取');
      let replica = await driver.get<{ ledger_id: string; replica_id: string }>(
        'SELECT ledger_id, replica_id FROM sync_replicas WHERE username = ?', [username]);
      if (replica && replica.ledger_id !== envelope.ledgerId) throw new ServerStoreError('LEDGER_MISMATCH', 409, 'account is bound to another ledger');
      if (replica && session.replica_id && session.replica_id !== replica.replica_id) {
        throw new ServerStoreError('LEGACY_PROTECTION_SCOPE', 409, '此保护设置属于另一个账本');
      }
      if (replica && await driver.get('SELECT 1 FROM ledger_control_roots WHERE replica_id = ?', [replica.replica_id])) {
        throw new ServerStoreError('PROTECTION_CONTROLLED', 409, '此账本已启用成员密钥，不能通过旧保护接口更换密钥');
      }
      const oldEnvelope = replica ? await driver.get<{ envelope_json: string; generation: number; keyring_id: string }>(
        'SELECT envelope_json, generation, keyring_id FROM ledger_replica_key_envelopes WHERE replica_id = ?',
        [replica.replica_id]) : undefined;
      if (oldEnvelope && (oldEnvelope.keyring_id !== envelope.keyringId || Number(oldEnvelope.generation) > Number(envelope.generation)
        || Number(oldEnvelope.generation) === Number(envelope.generation) && oldEnvelope.envelope_json !== JSON.stringify(envelope))) {
        throw new ServerStoreError('KEY_ENVELOPE_COLLISION', 409, '账本密钥已变化，请重新同步');
      }
      const at = nowIso();
      if (!replica) {
        replica = { ledger_id: String(envelope.ledgerId), replica_id: `rep-${randomBytes(12).toString('hex')}` };
        await driver.run('INSERT INTO sync_replicas (username, ledger_id, replica_id, stream_epoch, head_seq, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
          [username, replica.ledger_id, replica.replica_id, `epoch-${randomBytes(12).toString('hex')}`, at, at]);
        await this.rebuildAccountLedgerIndex(driver, replica.replica_id);
        if (session.kind === 'ledger') await driver.run(
          'UPDATE sync_sessions SET replica_id = ?, updated_at = ? WHERE session_id = ?',
          [replica.replica_id, at, sessionId]);
      }
      await driver.run(`INSERT OR REPLACE INTO ledger_replica_key_envelopes
        (replica_id, ledger_id, keyring_id, generation, envelope_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [replica.replica_id, String(envelope.ledgerId), String(envelope.keyringId),
        Number(envelope.generation), JSON.stringify(envelope), at]);
      await driver.run('INSERT OR REPLACE INTO sync_key_custody (username, mode, version, sealed_secret, updated_at) VALUES (?, ?, ?, ?, ?)', [username, next.mode, expectedVersion + 1, next.sealedSecret, at]);
      if (oldEnvelope && Number(envelope.generation) > Number(oldEnvelope.generation)) {
        await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ? AND session_id <> ?', [at, at, username, sessionId]);
      }
    });
  }

  /**
   * Invitations, newest first by default.
   *
   * The cursor is still numeric-by-default in the sense that it never carries the invitation code:
   * `cursor_id` is `rowid`, and every sort option uses `rowid` as its tiebreaker, so a cursor
   * holds an ordering key plus an integer identity, never the credential. The list is paged by the
   * ordering the operator asked for, and the cursor follows that ordering.
   */
  async listInvitesPage(cursor = '', limit = 25, state = '', sort?: ResolvedSort): Promise<{ invites: Invite[]; nextCursor?: string }> {
    await this.ready;
    const resolved = sort ?? resolveSort(INVITE_SORT_OPTIONS, null, 'created', null);
    const parsed = readCursor(cursor);
    const cursorClause = parsed ? resolved.cursor(resolved.value(parsed.value), parsed.id) : undefined;
    const rows = await this.driver.all<Record<string, unknown>>(
      // `expires_at` lives on the policy row, so the join supplies it for both the state and the page.
      `SELECT i.*, i.rowid AS cursor_id, p.expires_at, ${INVITE_STATE_SQL} AS invite_state
       FROM registration_invites i
       LEFT JOIN registration_invite_policy p ON p.code = i.code
       WHERE (? = '' OR ${INVITE_STATE_SQL} = ?)
         ${cursorClause ? `AND ${cursorClause.sql}` : ''}
       ORDER BY ${resolved.orderBy} LIMIT ?`,
      [state, state, ...(cursorClause ? cursorClause.params : []), limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      invites: page.map(inviteFromRow),
      // The tiebreaker is the rowid, so a cursor never lands mid-tie and never names a code.
      ...(rows.length > limit && last
        ? { nextCursor: resolved.write(cursorValue(last, resolved), String(last['cursor_id'])) }
        : {}),
    };
  }

  /**
   * Runs one statement against the same connection the store uses.
   *
   * Exists for tests that need to seed rows the public API deliberately cannot create (an
   * invitation whose policy already expired, a record backdated to a past day). A second
   * connection to the same file would work too, but then the store's own reads could race the
   * write; going through the store keeps one connection and one ordering.
   */
  async seed(sql: string, params: (string | number | null)[] = []): Promise<void> {
    await this.ready;
    await this.driver.run(sql, params);
  }

  /**
   * New accounts over time, and how many of them came from an invitation.
   *
   * The console counted requests only, so "are we growing, and which batch of invitations did
   * it" had no answer at all. Registration time is the account's own `created_at`; attribution
   * is the invitation that names the account as its user, which is the only link that exists
   * between an account and how it got in.
   *
   * Buckets are UTC, like the metric buckets, and are rendered in local time by the console.
   */
  async registrationGrowth(options: { from?: string; until?: string; granularity?: 'day' | 'month' } = {}): Promise<{
    granularity: 'day' | 'month';
    buckets: { at: string; accounts: number; invited: number }[];
    totals: { accounts: number; invited: number; uninvited: number };
  }> {
    await this.ready;
    const granularity = options.granularity === 'month' ? 'month' : 'day';
    // `2026-09-20` for a day, `2026-09` for a month: the bucket key is the date prefix itself.
    const width = granularity === 'month' ? 7 : 10;
    const clauses: string[] = [];
    const params: (string | number)[] = [width];
    if (options.from) { clauses.push('u.created_at >= ?'); params.push(options.from); }
    if (options.until) { clauses.push('u.created_at < ?'); params.push(options.until); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    // EXISTS rather than a join: an account must be counted once even if more than one row
    // somehow names it, and the count of accounts is the number the page reports.
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT substr(u.created_at, 1, ?) AS bucket, COUNT(*) AS accounts,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM registration_invites i WHERE i.used_by = u.username) THEN 1 ELSE 0 END) AS invited
       FROM sync_users u ${where}
       GROUP BY bucket ORDER BY bucket`,
      params,
    );
    const buckets = rows.map((row) => ({
      at: String(row['bucket']),
      accounts: Number(row['accounts'] ?? 0),
      invited: Number(row['invited'] ?? 0),
    }));
    const accounts = buckets.reduce((sum, bucket) => sum + bucket.accounts, 0);
    const invited = buckets.reduce((sum, bucket) => sum + bucket.invited, 0);
    // "Uninvited" is a difference, not a category: it is open registration plus the owner the
    // deployment created, and nothing in the data separates those two.
    return { granularity, buckets, totals: { accounts, invited, uninvited: accounts - invited } };
  }

  /**
   * Invitations grouped by the day they were created, with how many were actually used.
   *
   * "How many people did that batch of invitations bring in" cannot be answered from the invite
   * list: that is one row per code, and adding up uses across pages by hand is exactly the manual
   * tally the failed-login view exists to avoid.
   *
   * Totals cover the whole history rather than the selected range — "how many did invitations
   * ever bring in" is the question the number is for — while `batches` is the range.
   */
  async inviteAttribution(options: { from?: string; until?: string; limit?: number } = {}): Promise<{
    batches: { at: string; issued: number; used: number }[];
    totals: { issued: number; used: number; available: number; revoked: number; expired: number };
  }> {
    await this.ready;
    const now = nowIso();
    // The state rules mirror `listInvitesPage` exactly, so the summary and the list cannot
    // disagree about what "available" means. An invitation with no policy row never expires.
    const totalsRow = await this.driver.get<Record<string, unknown>>(
      `SELECT COUNT(*) AS issued,
              COALESCE(SUM(CASE WHEN i.used_by IS NOT NULL THEN 1 ELSE 0 END), 0) AS used,
              COALESCE(SUM(CASE WHEN i.used_by IS NULL AND i.disabled = 1 THEN 1 ELSE 0 END), 0) AS revoked,
              COALESCE(SUM(CASE WHEN i.used_by IS NULL AND i.disabled = 0 AND p.expires_at <= ? THEN 1 ELSE 0 END), 0) AS expired,
              COALESCE(SUM(CASE WHEN i.used_by IS NULL AND i.disabled = 0 AND (p.expires_at IS NULL OR p.expires_at > ?) THEN 1 ELSE 0 END), 0) AS available
       FROM registration_invites i
       LEFT JOIN registration_invite_policy p ON p.code = i.code`,
      [now, now],
    );
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.from) { clauses.push('created_at >= ?'); params.push(options.from); }
    if (options.until) { clauses.push('created_at < ?'); params.push(options.until); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(200, options.limit ?? 90));
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT substr(created_at, 1, 10) AS bucket, COUNT(*) AS issued,
              COALESCE(SUM(CASE WHEN used_by IS NOT NULL THEN 1 ELSE 0 END), 0) AS used
       FROM registration_invites ${where}
       GROUP BY bucket ORDER BY bucket DESC LIMIT ?`,
      [...params, limit],
    );
    return {
      batches: rows.map((row) => ({ at: String(row['bucket']), issued: Number(row['issued'] ?? 0), used: Number(row['used'] ?? 0) })),
      totals: {
        issued: Number(totalsRow?.['issued'] ?? 0),
        used: Number(totalsRow?.['used'] ?? 0),
        available: Number(totalsRow?.['available'] ?? 0),
        revoked: Number(totalsRow?.['revoked'] ?? 0),
        expired: Number(totalsRow?.['expired'] ?? 0),
      },
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
    const schema = await this.driver.get<{ version: number }>('SELECT version FROM server_schema_migrations LIMIT 1');
    const journal = await this.driver.get<{ journal_mode: string }>('PRAGMA journal_mode');
    const temp = await this.driver.get<{ temp_store: number }>('PRAGMA temp_store');
    const migrationCount = Number(migrations?.value ?? 0);
    const reachable = Number(check?.['ok']) === 1;
    return {
      ok: reachable && migrationCount === 1,
      result: reachable ? (migrationCount === 1 ? 'ok' : 'schema-mismatch') : 'unavailable',
      journalMode: String(journal?.journal_mode ?? ''),
      tempStore: Number(temp?.temp_store) === 2 ? 'memory' : String(temp?.temp_store ?? ''),
      schemaVersion: Number(schema?.version ?? CURRENT_SERVER_SCHEMA),
      migrations: migrationCount,
    };
  }

  /** Deep check. Deliberately kept out of readiness and HTTP request paths. */
  async integrityCheck(): Promise<{ ok: boolean; result: string; schemaVersion: number; checkedAt: string }> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>('PRAGMA integrity_check');
    const result = rows.map((row) => String(Object.values(row)[0] ?? '')).join('; ') || 'unknown';
    const schema = await this.driver.get<{ version: number }>('SELECT version FROM server_schema_migrations LIMIT 1');
    return { ok: result === 'ok', result,
      schemaVersion: Number(schema?.version ?? CURRENT_SERVER_SCHEMA), checkedAt: nowIso() };
  }

  /**
   * Structure readings that are safe to take on a timer.
   *
   * Every statement here is either a constant-time pragma or a read of the small analyzer
   * table. The per-table page breakdown deliberately lives in `databaseTableUsage`, because
   * that one walks the whole file: measured at ~250 ms on a 125 MiB database, which is far
   * too long to put inside a 30-second sampling loop.
   */
  async databaseStats(): Promise<DatabaseStats> {
    await this.ready;
    const pragma = async (name: string): Promise<Record<string, unknown> | undefined> =>
      this.driver.get<Record<string, unknown>>(`PRAGMA ${name}`);
    const [
      pageCount, pageSize, freelist, journal, autoVacuum, synchronous,
      tempStore, cacheSize, mmap, autocheckpoint, journalLimit, busyTimeout, encoding,
    ] = await Promise.all([
      pragma('page_count'), pragma('page_size'), pragma('freelist_count'), pragma('journal_mode'),
      pragma('auto_vacuum'), pragma('synchronous'), pragma('temp_store'), pragma('cache_size'),
      pragma('mmap_size'), pragma('wal_autocheckpoint'), pragma('journal_size_limit'),
      pragma('busy_timeout'), pragma('encoding'),
    ]);
    const pages = Number(pageCount?.['page_count'] ?? 0);
    const size = Number(pageSize?.['page_size'] ?? 0);
    const free = Number(freelist?.['freelist_count'] ?? 0);
    // `PRAGMA cache_size` is negative when it counts KiB rather than pages. Both forms are
    // converted so the page shows a size, not a number whose unit depends on how it was set.
    const cacheRaw = Number(cacheSize?.['cache_size'] ?? 0);
    const cacheSizeKiB = cacheRaw === 0 ? null
      : cacheRaw < 0 ? Math.abs(cacheRaw)
        : Math.round((cacheRaw * size) / 1024);
    // The analyzer table only exists after `ANALYZE`; a missing one means "never analyzed".
    const analyzed = await this.driver.get<{ value: number }>('SELECT COUNT(*) AS value FROM sqlite_stat1')
      .catch(() => undefined);
    return {
      pageCount: pages,
      pageSize: size,
      freelistBytes: free * size,
      freelistRatio: pages > 0 ? Number((free / pages).toFixed(4)) : 0,
      logicalBytes: pages * size,
      journalMode: String(journal?.['journal_mode'] ?? ''),
      autoVacuum: autoVacuum?.['auto_vacuum'] === 0 || autoVacuum?.['auto_vacuum'] === '0' ? 'none'
        : autoVacuum?.['auto_vacuum'] === 1 || autoVacuum?.['auto_vacuum'] === '1' ? 'full' : 'incremental',
      synchronous: ({ 0: 'off', 1: 'normal', 2: 'full', 3: 'extra' } as Record<number, string>)[Number(synchronous?.['synchronous'] ?? -1)] ?? 'unknown',
      tempStore: Number(tempStore?.['temp_store']) === 2 ? 'memory'
        : Number(tempStore?.['temp_store']) === 1 ? 'file' : 'default',
      cacheSizeKiB,
      mmapBytes: Number(mmap?.['mmap_size'] ?? 0),
      walAutocheckpointPages: Number(autocheckpoint?.['wal_autocheckpoint'] ?? 0),
      journalSizeLimitBytes: Number(journalLimit?.['journal_size_limit'] ?? 0),
      busyTimeoutMs: Number(busyTimeout?.['timeout'] ?? 0),
      encoding: String(encoding?.['encoding'] ?? ''),
      analyzedTables: Number(analyzed?.value ?? 0),
      analyzedAt: (await this.maintenanceState('verification:analyze'))?.['checkedAt'] as string | undefined ?? null,
    };
  }

  /**
   * Per-table page usage. This is the expensive read: `dbstat` walks every page in the file.
   * It is never called from the sampling loop, only from an explicit refresh or a job.
   */
  async databaseTableUsage(): Promise<{ tables: DatabaseTableUsage[]; scannedAt: string; durationMs: number }> {
    await this.ready;
    const startedAt = Date.now();
    // This explicit diagnostic scans the whole file; an arbitrary row limit would silently
    // omit tables as migrations add indexes. Keep the ordering stable for operators.
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages
       FROM dbstat GROUP BY name ORDER BY bytes DESC, name ASC`,
    );
    const tables: DatabaseTableUsage[] = [];
    for (const row of rows) {
      const name = String(row['name']);
      // `dbstat` reports indexes under their own name; the console groups them under the table
      // they belong to so an operator sees "this table costs X", not an index catalogue.
      const index = /^sqlite_autoindex_(.+)_\d+$/.exec(name) ?? /^idx_[^_]*_(.+)$/.exec(name);
      tables.push({
        name,
        kind: name.startsWith('sqlite_') && !name.startsWith('sqlite_autoindex') ? 'other'
          : name.startsWith('idx_') || name.startsWith('sqlite_autoindex') ? 'index' : 'table',
        bytes: Number(row['bytes'] ?? 0),
        pages: Number(row['pages'] ?? 0),
        rowCount: index ? null : await this.tableRowCount(name),
      });
    }
    return { tables, scannedAt: nowIso(), durationMs: Date.now() - startedAt };
  }

  /** Row counts are read only for names that exist in the schema, so the value cannot inject SQL. */
  private async tableRowCount(name: string): Promise<number | null> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
    const known = await this.driver.get<{ value: number }>(
      "SELECT COUNT(*) AS value FROM sqlite_schema WHERE type = 'table' AND name = ?",
      [name],
    );
    if (!known || Number(known.value) === 0) return null;
    const row = await this.driver.get<{ value: number }>(`SELECT COUNT(*) AS value FROM "${name}"`);
    return row ? Number(row.value) : null;
  }

  /** `ANALYZE` is what makes the query planner keep using the indexes as the tables grow. */
  async analyze(): Promise<{ tables: number; durationMs: number; checkedAt: string }> {
    await this.ready;
    const startedAt = Date.now();
    await this.driver.exec('ANALYZE');
    const analyzed = await this.driver.get<{ value: number }>('SELECT COUNT(*) AS value FROM sqlite_stat1');
    const checkedAt = nowIso();
    await this.setMaintenanceState('verification:analyze', { checkedAt, tables: Number(analyzed?.value ?? 0) });
    return { tables: Number(analyzed?.value ?? 0), durationMs: Date.now() - startedAt, checkedAt };
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

  /** Last observed system reading per bucket; null remains missing data, never a fabricated zero. */
  async recordSystemMetricSample(sample: SystemMetricSample, at = new Date()): Promise<void> {
    await this.ready;
    const buckets: [string, string][] = [
      ['minute', new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString()],
      ['hour', new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000).toISOString()],
    ];
    await this.driver.transaction(async (driver) => {
      for (const [granularity, bucketAt] of buckets) {
        await driver.run(
          `INSERT INTO system_metric_buckets
           (scope, granularity, bucket_at, sampled_at, cpu_percent, memory_used_bytes, memory_total_bytes,
            disk_used_bytes, disk_total_bytes, disk_read_bytes_per_second, disk_write_bytes_per_second,
            network_rx_bytes_per_second, network_tx_bytes_per_second)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, granularity, bucket_at) DO UPDATE SET
             sampled_at = excluded.sampled_at,
             cpu_percent = excluded.cpu_percent,
             memory_used_bytes = excluded.memory_used_bytes,
             memory_total_bytes = excluded.memory_total_bytes,
             disk_used_bytes = excluded.disk_used_bytes,
             disk_total_bytes = excluded.disk_total_bytes,
             disk_read_bytes_per_second = excluded.disk_read_bytes_per_second,
             disk_write_bytes_per_second = excluded.disk_write_bytes_per_second,
             network_rx_bytes_per_second = excluded.network_rx_bytes_per_second,
             network_tx_bytes_per_second = excluded.network_tx_bytes_per_second`,
          [sample.scope, granularity, bucketAt, at.toISOString(), sample.cpuPercent,
            sample.memoryUsedBytes, sample.memoryTotalBytes, sample.diskUsedBytes, sample.diskTotalBytes,
            sample.diskReadBytesPerSecond, sample.diskWriteBytesPerSecond,
            sample.networkRxBytesPerSecond, sample.networkTxBytesPerSecond],
        );
      }
    });
  }

  async listSystemMetricBuckets(scope: SystemMetricSample['scope'], granularity: 'minute' | 'hour', from: string, until: string): Promise<SystemMetricBucket[]> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(
      'SELECT * FROM system_metric_buckets WHERE scope = ? AND granularity = ? AND bucket_at >= ? AND bucket_at < ? ORDER BY bucket_at',
      [scope, granularity, from, until],
    );
    const optional = (row: Record<string, unknown>, key: string): number | null => row[key] == null ? null : Number(row[key]);
    return rows.map((row) => ({
      scope, bucketAt: String(row['bucket_at']), sampledAt: String(row['sampled_at']),
      cpuPercent: optional(row, 'cpu_percent'),
      memoryUsedBytes: optional(row, 'memory_used_bytes'), memoryTotalBytes: optional(row, 'memory_total_bytes'),
      diskUsedBytes: optional(row, 'disk_used_bytes'), diskTotalBytes: optional(row, 'disk_total_bytes'),
      diskReadBytesPerSecond: optional(row, 'disk_read_bytes_per_second'),
      diskWriteBytesPerSecond: optional(row, 'disk_write_bytes_per_second'),
      networkRxBytesPerSecond: optional(row, 'network_rx_bytes_per_second'),
      networkTxBytesPerSecond: optional(row, 'network_tx_bytes_per_second'),
    }));
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
            sync_push_ok, sync_push_failed, sync_pull_ok, blob_ok, blob_failed,
            rss_bytes, heap_used_bytes, external_bytes, cpu_percent, event_loop_max_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(granularity, bucket_at) DO UPDATE SET
             requests = requests + excluded.requests,
             errors = errors + excluded.errors,
             slow_requests = slow_requests + excluded.slow_requests,
             duration_ms = duration_ms + excluded.duration_ms,
             sync_push_ok = sync_push_ok + excluded.sync_push_ok,
             sync_push_failed = sync_push_failed + excluded.sync_push_failed,
             sync_pull_ok = sync_pull_ok + excluded.sync_pull_ok,
             blob_ok = blob_ok + excluded.blob_ok,
             blob_failed = blob_failed + excluded.blob_failed,
             -- Resource readings are point-in-time, so the bucket keeps the highest one seen.
             -- Adding them up like the counters above would be a number without meaning.
             rss_bytes = max(rss_bytes, excluded.rss_bytes),
             heap_used_bytes = max(heap_used_bytes, excluded.heap_used_bytes),
             external_bytes = max(external_bytes, excluded.external_bytes),
             cpu_percent = max(cpu_percent, excluded.cpu_percent),
             event_loop_max_ms = max(event_loop_max_ms, excluded.event_loop_max_ms)`,
          [
            granularity, bucketAt,
            sample.requests ?? 0, sample.errors ?? 0, sample.slowRequests ?? 0, sample.durationMs ?? 0,
            sample.syncPushOk ?? 0, sample.syncPushFailed ?? 0, sample.syncPullOk ?? 0,
            sample.blobOk ?? 0, sample.blobFailed ?? 0,
            sample.rssBytes ?? 0, sample.heapUsedBytes ?? 0, sample.externalBytes ?? 0,
            sample.cpuPercent ?? 0, sample.eventLoopMaxMs ?? 0,
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
      rssBytes: Number(row['rss_bytes'] ?? 0),
      heapUsedBytes: Number(row['heap_used_bytes'] ?? 0),
      externalBytes: Number(row['external_bytes'] ?? 0),
      cpuPercent: Number(row['cpu_percent'] ?? 0),
      eventLoopMaxMs: Number(row['event_loop_max_ms'] ?? 0),
    }));
  }

  async pruneMetrics(now = new Date()): Promise<{ removed: number }> {
    await this.ready;
    const minuteCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const hourCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const minutes = await this.driver.run("DELETE FROM server_metric_buckets WHERE granularity = 'minute' AND bucket_at < ?", [minuteCutoff]);
    const hours = await this.driver.run("DELETE FROM server_metric_buckets WHERE granularity = 'hour' AND bucket_at < ?", [hourCutoff]);
    const systemMinutes = await this.driver.run("DELETE FROM system_metric_buckets WHERE granularity = 'minute' AND bucket_at < ?", [minuteCutoff]);
    const systemHours = await this.driver.run("DELETE FROM system_metric_buckets WHERE granularity = 'hour' AND bucket_at < ?", [hourCutoff]);
    return { removed: Number(minutes.changes ?? 0) + Number(hours.changes ?? 0) + Number(systemMinutes.changes ?? 0) + Number(systemHours.changes ?? 0) };
  }

  /** Diagnostic events get their own retention so log trimming cannot erase them. */
  async recordSyncEvent(event: Omit<SyncEvent, 'id' | 'at'> & { at?: string }): Promise<void> {
    await this.ready;
    const at = event.at ?? nowIso();
    await this.driver.run(
      `INSERT OR REPLACE INTO sync_events
       (id, at, username, account_id, device_name, operation, outcome, result_code, category, commit_count, bytes, duration_ms, request_id, client_kind, client_version, protocol_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomBytes(12).toString('hex'), at, event.username ?? null, event.accountId ?? null, event.deviceName ?? null,
        event.operation, event.outcome, event.resultCode ?? null, event.category ?? null,
        event.commitCount ?? null, event.bytes ?? null, event.durationMs ?? null, event.requestId ?? null,
        event.clientKind ?? null, event.clientVersion ?? null, event.protocolVersion ?? null,
      ],
    );
  }

  /** Encrypted payload bytes transferred by this account on this node; retries count as traffic. */
  async recordAccountTransfer(username: string, kind: 'commit-push' | 'commit-pull' | 'blob-upload' | 'blob-download',
    bytes: number): Promise<void> {
    await this.ready;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid transfer byte count');
    const fields = {
      'commit-push': ['commit_push_requests', 'commit_upload_bytes'],
      'commit-pull': ['commit_pull_requests', 'commit_download_bytes'],
      'blob-upload': [null, 'blob_upload_bytes'],
      'blob-download': [null, 'blob_download_bytes'],
    } as const;
    const [requestColumn, byteColumn] = fields[kind];
    const requestUpdate = requestColumn ? `${requestColumn} = ${requestColumn} + 1,` : '';
    await this.driver.run(`INSERT INTO account_transfer_counters (username, ${byteColumn},
        ${requestColumn ? `${requestColumn}, ` : ''}updated_at)
      VALUES (?, ?, ${requestColumn ? '1, ' : ''}?)
      ON CONFLICT(username) DO UPDATE SET ${requestUpdate}
        ${byteColumn} = ${byteColumn} + excluded.${byteColumn}, updated_at = excluded.updated_at`,
    [username, bytes, nowIso()]);
  }

  async accountTransfer(username: string): Promise<{
    commitPushRequests: number; commitPullRequests: number;
    commitUploadBytes: number; commitDownloadBytes: number;
    blobUploadBytes: number; blobDownloadBytes: number;
    syncRuns: number; convergedRuns: number; partialRuns: number; failedRuns: number;
  }> {
    await this.ready;
    const [row, runs] = await Promise.all([
      this.driver.get<Record<string, unknown>>('SELECT * FROM account_transfer_counters WHERE username = ?', [username]),
      this.driver.get<Record<string, unknown>>(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'converged' THEN 1 ELSE 0 END) AS converged,
        SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) AS partial,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM account_sync_runs WHERE username = ?`, [username]),
    ]);
    return {
      commitPushRequests: Number(row?.['commit_push_requests'] ?? 0),
      commitPullRequests: Number(row?.['commit_pull_requests'] ?? 0),
      commitUploadBytes: Number(row?.['commit_upload_bytes'] ?? 0),
      commitDownloadBytes: Number(row?.['commit_download_bytes'] ?? 0),
      blobUploadBytes: Number(row?.['blob_upload_bytes'] ?? 0),
      blobDownloadBytes: Number(row?.['blob_download_bytes'] ?? 0),
      syncRuns: Number(runs?.['total'] ?? 0),
      convergedRuns: Number(runs?.['converged'] ?? 0),
      partialRuns: Number(runs?.['partial'] ?? 0),
      failedRuns: Number(runs?.['failed'] ?? 0),
    };
  }

  async recordAccountSyncRun(username: string, replicaId: string, input: {
    runId: string; outcome: 'converged' | 'partial' | 'failed'; pulled: number; pushed: number;
    attachmentUploads: number; attachmentDownloads: number; durationMs: number;
  }): Promise<void> {
    await this.ready;
    if (!/^[a-f0-9-]{36}$/.test(input.runId) || !['converged', 'partial', 'failed'].includes(input.outcome)
      || [input.pulled, input.pushed, input.attachmentUploads, input.attachmentDownloads, input.durationMs]
        .some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new ServerStoreError('INVALID_SYNC_RUN', 400, '同步轮次报告无效');
    }
    await this.driver.run(`INSERT OR IGNORE INTO account_sync_runs
      (run_id, username, replica_id, outcome, pulled, pushed, attachment_uploads,
        attachment_downloads, duration_ms, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.runId, username, replicaId, input.outcome, input.pulled, input.pushed,
      input.attachmentUploads, input.attachmentDownloads, input.durationMs, nowIso()]);
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
    sort?: ResolvedSort;
  }): Promise<{ events: SyncEvent[]; nextCursor?: string }> {
    await this.ready;
    const sort = options.sort ?? resolveSort(SYNC_EVENT_SORT_OPTIONS, null, 'at', null);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.username) { clauses.push('username = ?'); params.push(options.username); }
    if (options.accountId) { clauses.push('account_id = ?'); params.push(options.accountId); }
    if (options.category) { clauses.push('category = ?'); params.push(options.category); }
    if (options.outcome) { clauses.push('outcome = ?'); params.push(options.outcome); }
    if (options.from) { clauses.push('at >= ?'); params.push(options.from); }
    if (options.until) { clauses.push('at < ?'); params.push(options.until); }
    // The cursor is compared against the ordering expression, so the two are built together.
    const cursor = readCursor(options.cursor);
    const cursorClause = cursor ? sort.cursor(sort.value(cursor.value), cursor.id) : undefined;
    if (cursorClause) clauses.push(cursorClause.sql);
    let sql = 'SELECT * FROM sync_events';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ` ORDER BY ${sort.orderBy} LIMIT ?`;
    params.push(...(cursorClause ? cursorClause.params : []), options.limit + 1);
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
      ...(row['client_kind'] == null ? {} : { clientKind: String(row['client_kind']) }),
      ...(row['client_version'] == null ? {} : { clientVersion: String(row['client_version']) }),
      ...(row['protocol_version'] == null ? {} : { protocolVersion: String(row['protocol_version']) }),
    }));
    // The cursor carries the sort it belongs to, so it cannot be reused under another ordering.
    const lastRow = rows.length > options.limit ? rows[options.limit - 1] : undefined;
    const last = events.at(-1);
    return {
      events,
      ...(lastRow && last ? { nextCursor: sort.write(cursorValue(lastRow, sort), last.id) } : {}),
    };
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
      ? `(SELECT username, SUM(bytes) AS bytes FROM (
          SELECT COALESCE(slot_owner.username, legacy_owner.username, object.username) AS username,
            object.cipher_bytes AS bytes FROM blob_objects object
            LEFT JOIN sync_replicas slot_owner ON slot_owner.replica_id = object.replica_id
            LEFT JOIN sync_replicas legacy_owner ON object.replica_id IS NULL
              AND legacy_owner.username = object.username AND legacy_owner.ledger_id = object.ledger_id
          UNION ALL
          SELECT COALESCE(slot_owner.username, legacy_owner.username, upload.username) AS username,
            upload.cipher_bytes AS bytes FROM blob_uploads upload
            LEFT JOIN sync_replicas slot_owner ON slot_owner.replica_id = upload.replica_id
            LEFT JOIN sync_replicas legacy_owner ON upload.replica_id IS NULL
              AND legacy_owner.username = upload.username AND legacy_owner.ledger_id = upload.ledger_id
        ) GROUP BY username)`
      : '(SELECT NULL AS username, 0 AS bytes WHERE 0)'
    ;
    const blobQuotas = hasBlobTables ? 'blob_user_quotas' : null;
    const replicaBlobQuotas = hasBlobTables && await this.driver.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_replica_blob_quotas'")
      ? 'ledger_replica_blob_quotas' : null;
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT u.username, i.account_id, ${ROLE_SQL} AS role,
              COALESCE(c.bytes, 0) AS commit_bytes, COALESCE(q.commit_quota_bytes, ?) AS commit_quota,
              COALESCE(b.bytes, 0) AS blob_bytes,
              COALESCE(rbq.quota_bytes, bq.quota_bytes, ?) AS blob_quota
       FROM sync_users u
       JOIN sync_account_identities i ON i.username = u.username
       LEFT JOIN server_administrators a ON a.username = u.username
       LEFT JOIN server_ownership o ON o.username = u.username
       LEFT JOIN (SELECT owner.username, SUM(commit_row.cipher_bytes) AS bytes
         FROM ledger_replica_commits commit_row JOIN sync_replicas owner
           ON owner.replica_id = commit_row.replica_id GROUP BY owner.username) c ON c.username = u.username
       LEFT JOIN sync_user_quotas q ON q.username = u.username
       LEFT JOIN ${blobBytes} b ON b.username = u.username
       LEFT JOIN ${blobQuotas ? blobQuotas : '(SELECT NULL AS username, 0 AS quota_bytes WHERE 0)'} bq ON bq.username = u.username
       LEFT JOIN ${replicaBlobQuotas ? replicaBlobQuotas : '(SELECT NULL AS replica_id, 0 AS quota_bytes WHERE 0)'} rbq
         ON rbq.replica_id = (SELECT replica_id FROM sync_replicas WHERE username = u.username)
       WHERE u.disabled = 0`,
      [this.defaultCommitQuotaBytes, this.defaultBlobQuotaBytes],
    );
    const warnings: { username: string; accountId: string; scope: 'commit' | 'blobs'; usedBytes: number; quotaBytes: number }[] = [];
    for (const row of rows) {
      if (unlimitedQuotaRole(row['role'])) continue;
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
    accountId?: string;
    cursor?: string;
    search?: string;
    state?: string;
    kind?: string;
    memberOnly?: boolean;
    sort?: ResolvedSort;
  }): Promise<{ sessions: AccountSessionSummary[]; nextCursor?: string }> {
    const sort = options.sort ?? resolveSort(SESSION_SORT_OPTIONS, null, 'lastSeen', null);
    await this.ready;
    const at = nowIso();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.memberOnly) {
      clauses.push(`${ROLE_SQL} = 'member'`);
    }
    if (options.accountId) {
      clauses.push('i.account_id = ?');
      params.push(options.accountId);
    }
    if (options.search) {
      clauses.push('(instr(lower(s.username), lower(?)) > 0 OR i.account_id = ? OR instr(lower(s.device_name), lower(?)) > 0)');
      params.push(options.search, options.search, options.search);
    }
    if (options.state === 'active') { clauses.push('s.revoked_at IS NULL AND s.expires_at > ?'); params.push(at); }
    else if (options.state === 'revoked') clauses.push('s.revoked_at IS NOT NULL');
    else if (options.state === 'expired') { clauses.push('s.revoked_at IS NULL AND s.expires_at <= ?'); params.push(at); }
    if (options.kind) { clauses.push('s.kind = ?'); params.push(options.kind); }
    // The cursor is compared against the ordering expression, so the two are built together.
    const cursor = readCursor(options.cursor);
    const cursorClause = cursor ? sort.cursor(sort.value(cursor.value), cursor.id) : undefined;
    let sql = `SELECT s.*, i.account_id,
        ${ROLE_SQL} AS role
      FROM sync_sessions s
      JOIN sync_account_identities i ON i.username = s.username
      LEFT JOIN server_administrators a ON a.username = s.username
      LEFT JOIN server_ownership o ON o.username = s.username`;
    if (cursorClause) { clauses.push(cursorClause.sql); params.push(...cursorClause.params); }
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ` ORDER BY ${sort.orderBy} LIMIT ?`;
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
    // The cursor carries the sort it belongs to, so a cursor cannot be reused under another one.
    const lastRow = rows.length > options.limit ? rows[options.limit - 1] : undefined;
    const last = sessions.at(-1);
    return {
      sessions,
      ...(lastRow && last ? { nextCursor: sort.write(cursorValue(lastRow, sort), last.id) } : {}),
    };
  }

  /**
   * The management-console sign-ins an operator wants to see at a glance: who got in, when, and
   * from where.
   *
   * Read from the sessions rather than the run log on purpose. The log is a capped, trimmed
   * stream — the oldest entries are deleted to keep the table bounded — so "who signed in last
   * week" would silently lose its answer as the log rolls over. A session row lives as long as the
   * session does, and the console context is already recorded on it (`kind = 'admin'`), so the
   * answer is exact for as long as it matters.
   */
  async recentAdminLogins(limit: number): Promise<{
    sessionId: string; username: string; role: AccountRole; at: string; ip?: string; active: boolean;
  }[]> {
    await this.ready;
    const at = nowIso();
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT s.session_id, s.username, s.created_at, s.expires_at, s.revoked_at, s.last_ip,
          ${ROLE_SQL} AS role
        FROM sync_sessions s
        LEFT JOIN server_administrators a ON a.username = s.username
        LEFT JOIN server_ownership o ON o.username = s.username
        WHERE s.kind = 'admin'
        ORDER BY s.created_at DESC, s.session_id DESC
        LIMIT ?`,
      [Math.max(1, Math.min(50, Math.trunc(limit)))],
    );
    return rows.map((row) => ({
      sessionId: String(row['session_id']),
      username: String(row['username']),
      role: row['role'] === 'owner' ? 'owner' : row['role'] === 'admin' ? 'admin' : row['role'] === 'viewer' ? 'viewer' : 'member',
      at: String(row['created_at']),
      ...(row['last_ip'] == null ? {} : { ip: String(row['last_ip']) }),
      active: row['revoked_at'] == null && String(row['expires_at']) > at,
    }));
  }

  /** Every account-scoped read a single detail page needs, without exposing ledger bytes. */
  async accountDetail(accountId: string): Promise<JsonRecord | undefined> {
    await this.ready;
    const at = nowIso();
    const row = await this.driver.get<Record<string, unknown>>(
      `SELECT u.username, u.display_name, i.account_id, u.disabled, u.created_at, u.updated_at, u.last_login_at, u.revision,
              ${ROLE_SQL} AS role,
              r.ledger_id, r.replica_id, COALESCE(r.head_seq, 0) AS commit_count,
              (SELECT COUNT(*) FROM ledger_replica_commits c WHERE c.replica_id = r.replica_id) AS stored_commits,
              (SELECT COALESCE(SUM(c.cipher_bytes), 0) FROM ledger_replica_commits c WHERE c.replica_id = r.replica_id) AS commit_bytes,
              CASE WHEN ${ROLE_SQL} IN ('owner', 'admin') THEN NULL ELSE COALESCE(q.commit_quota_bytes, ?) END AS commit_quota_bytes,
              e.email, e.verified_at, e.pending_email,
              c2.mode AS protection_mode, c2.version AS protection_version
       FROM sync_account_identities i
       JOIN sync_users u ON u.username = i.username
       LEFT JOIN server_administrators a ON a.username = u.username
       LEFT JOIN server_ownership o ON o.username = u.username
       LEFT JOIN sync_replicas r ON r.username = u.username
       LEFT JOIN sync_user_quotas q ON q.username = u.username
       LEFT JOIN account_email_settings e ON e.username = u.username
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
        displayName: row['display_name'] == null ? null : String(row['display_name']),
        email: row['email'] == null ? null : String(row['email']),
        emailVerifiedAt: row['verified_at'] == null ? null : String(row['verified_at']),
        pendingEmail: row['pending_email'] == null ? null : String(row['pending_email']),
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
        commitQuotaBytes: row['commit_quota_bytes'] == null ? null : Number(row['commit_quota_bytes']),
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
      sync: { recent: events.events, transfer: await this.accountTransfer(username) },
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

  async listJobs(options: { limit: number; status?: string; type?: string; cursor?: string; accountId?: string; sort?: ResolvedSort }): Promise<{ jobs: AdminJob[]; nextCursor?: string }> {
    const sort = options.sort ?? resolveSort(JOB_SORT_OPTIONS, null, 'created', null);
    await this.ready;
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) { clauses.push('status = ?'); params.push(options.status); }
    if (options.type) { clauses.push('type = ?'); params.push(options.type); }
    // Targeted account: the field is only ever set for account-scoped task types, so this
    // filter is exactly "tasks that name this account".
    if (options.accountId) { clauses.push('target_account_id = ?'); params.push(options.accountId); }
    // The cursor is compared against the ordering expression, so the two are built together.
    const cursor = readCursor(options.cursor);
    const cursorClause = cursor ? sort.cursor(sort.value(cursor.value), cursor.id) : undefined;
    if (cursorClause) clauses.push(cursorClause.sql);
    let sql = 'SELECT * FROM admin_jobs';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ` ORDER BY ${sort.orderBy} LIMIT ?`;
    params.push(...(cursorClause ? cursorClause.params : []), options.limit + 1);
    const rows = await this.driver.all<Record<string, unknown>>(sql, params);
    const jobs = rows.slice(0, options.limit).map((row) => this.mapJob(row));
    // The cursor carries the sort it belongs to, so it cannot be reused under another ordering.
    const lastRow = rows.length > options.limit ? rows[options.limit - 1] : undefined;
    const last = jobs.at(-1);
    return {
      jobs,
      ...(lastRow && last ? { nextCursor: sort.write(cursorValue(lastRow, sort), last.jobId) } : {}),
    };
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
    /** Operator-configurable cap; defaults to the historical hard-coded 2000. */
    retention?: number;
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
      await this.pruneAdminFailures(input.retention ?? 2_000);
    } catch {
      // Diagnostics must never turn a handled management failure into a server error.
    }
  }

  /**
   * Audit retention.
   *
   * `server_admin_audit` is the table an operator reads to answer "who changed what, when", so it
   * needs a bound of its own: it used to grow without limit while logs, metrics and sync events
   * were all trimmed. The default is deliberately far above the log retention, because trimming
   * the audit trail is a last resort, not routine housekeeping.
   */
  async pruneAdminAudit(retention = 50_000): Promise<{ removed: number }> {
    await this.ready;
    const result = await this.driver.run(
      `DELETE FROM server_admin_audit WHERE id IN (
         SELECT id FROM server_admin_audit ORDER BY id DESC LIMIT -1 OFFSET ?
       )`,
      [retention],
    );
    return { removed: Number(result.changes ?? 0) };
  }

  /**
   * Rejected management attempts. This used to be a hard-coded 2000 that no operator could
   * change; the cap is now a setting, and the write path trims against it.
   */
  async pruneAdminFailures(retention = 2_000): Promise<{ removed: number }> {
    await this.ready;
    const result = await this.driver.run(
      `DELETE FROM admin_audit_failures WHERE id IN (
         SELECT id FROM admin_audit_failures ORDER BY id DESC LIMIT -1 OFFSET ?
       )`,
      [retention],
    );
    return { removed: Number(result.changes ?? 0) };
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

  /**
   * The newest record that succeeded and passed verification, and the newest one verified.
   *
   * These are asked directly rather than derived from a page of recent records. Deriving them
   * was wrong in a way that mattered: with a nightly backup and a broken deployment, the newest
   * page can be entirely failures, so "last successful backup" looked empty and the overdue
   * alert fired on a server that had backed up successfully every night until that week.
   */
  async latestBackupSummary(): Promise<{
    lastAttempt: { recordId: string; status: string; createdAt: string; errorMessage?: string; verificationOk?: boolean } | null;
    lastSuccess: { recordId: string; createdAt: string } | null;
    lastVerified: { recordId: string; verifiedAt: string } | null;
    lastRetention: { recordId: string; createdAt: string; note?: string; retention?: JsonRecord } | null;
  }> {
    await this.ready;
    // "Succeeded" means created *and* not rejected by verification: a record whose verification
    // failed is a failed backup even though its creation succeeded.
    const success = await this.driver.get<{ record_id: string; created_at: string }>(
      `SELECT record_id, created_at FROM server_backup_records
       WHERE status = 'completed' AND kind != 'drill' AND retention_json IS NULL
         AND (verification_json IS NULL OR json_extract(verification_json, '$.ok') IS NOT 0)
       ORDER BY created_at DESC, record_id DESC LIMIT 1`,
    );
    const verified = await this.driver.get<{ record_id: string; verified_at: string }>(
      `SELECT record_id, verified_at FROM server_backup_records
       WHERE verified_at IS NOT NULL AND kind != 'drill' AND retention_json IS NULL
         AND verification_json IS NOT NULL
         AND json_extract(verification_json, '$.ok') IS 1
       ORDER BY verified_at DESC, record_id DESC LIMIT 1`,
    );
    const attempt = await this.driver.get<Record<string, unknown>>(
      `SELECT record_id, status, created_at, error_message, verification_json FROM server_backup_records
       WHERE status != 'planned' AND kind != 'drill' AND retention_json IS NULL
       ORDER BY created_at DESC, record_id DESC LIMIT 1`,
    );
    const verification = attempt?.['verification_json'] == null ? undefined : jsonObject(attempt['verification_json']);
    // The newest retention run, for the same reason: it is asked about by date, not by page.
    // Its note and outcome travel with it: the page reported "已清理 N 份" before the list was
    // paged, and paging must not cost the operator that answer.
    const retention = await this.driver.get<{ record_id: string; created_at: string; note: string | null; retention_json: string | null }>(
      `SELECT record_id, created_at, note, retention_json FROM server_backup_records
       WHERE retention_json IS NOT NULL
       ORDER BY created_at DESC, record_id DESC LIMIT 1`,
    );
    return {
      lastAttempt: attempt ? {
        recordId: String(attempt['record_id']), status: String(attempt['status']), createdAt: String(attempt['created_at']),
        ...(attempt['error_message'] == null ? {} : { errorMessage: String(attempt['error_message']) }),
        ...(typeof verification?.['ok'] === 'boolean' ? { verificationOk: verification['ok'] } : {}),
      } : null,
      lastSuccess: success ? { recordId: String(success.record_id), createdAt: String(success.created_at) } : null,
      lastVerified: verified ? { recordId: String(verified.record_id), verifiedAt: String(verified.verified_at) } : null,
      lastRetention: retention
        ? {
          recordId: String(retention.record_id),
          createdAt: String(retention.created_at),
          ...(retention.note == null ? {} : { note: String(retention.note) }),
          ...(retention.retention_json == null ? {} : { retention: jsonObject(retention.retention_json) }),
        }
        : null,
    };
  }

  /**
   * Backup records, newest first, with a cursor.
   *
   * This used to take a fixed 50 with no way past them, so a deployment that backs up nightly
   * could only ever see the last few weeks — and "when did the last *successful* backup happen"
   * could be answered wrongly when the newest 50 were all failures.
   *
   * The cursor is `created_at|record_id`, matching the sort key, so paging is stable even when
   * several records share a timestamp.
   */
  async listBackupRecords(limit = 50, options: {
    cursor?: string;
    status?: string;
    kind?: string;
    sort?: ResolvedSort;
  } = {}): Promise<{ backups: ServerBackupRecord[]; nextCursor?: string; total: number }> {
    await this.ready;
    const sort = options.sort ?? resolveSort(BACKUP_SORT_OPTIONS, null, 'created', null);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) { clauses.push('status = ?'); params.push(options.status); }
    if (options.kind) { clauses.push('kind = ?'); params.push(options.kind); }
    // The cursor is applied after the filters so paging stays consistent within a filtered view.
    const cursor = readCursor(options.cursor);
    const cursorClause = cursor ? sort.cursor(sort.value(cursor.value), cursor.id) : undefined;
    if (cursorClause) clauses.push(cursorClause.sql);
    let sql = 'SELECT * FROM server_backup_records';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ` ORDER BY ${sort.orderBy} LIMIT ?`;
    const pageSize = Math.max(1, Math.min(200, limit));
    const rows = await this.driver.all<Record<string, unknown>>(sql, [...params, ...(cursorClause ? cursorClause.params : []), pageSize + 1]);
    const page = rows.slice(0, pageSize).map((row) => this.mapBackupRecord(row));
    const lastRow = rows.length > pageSize ? rows[pageSize - 1] : undefined;

    // The total counts the filtered set, not the page: "how many failed backups are retained"
    // is a question about the whole set.
    const totalClauses: string[] = [];
    const totalParams: (string | number)[] = [];
    if (options.status) { totalClauses.push('status = ?'); totalParams.push(options.status); }
    if (options.kind) { totalClauses.push('kind = ?'); totalParams.push(options.kind); }
    const totalRow = await this.driver.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM server_backup_records${totalClauses.length ? ` WHERE ${totalClauses.join(' AND ')}` : ''}`,
      totalParams,
    );

    return {
      backups: page,
      ...(lastRow ? { nextCursor: sort.write(cursorValue(lastRow, sort), String(lastRow['record_id'])) } : {}),
      total: Number(totalRow?.total ?? 0),
    };
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
