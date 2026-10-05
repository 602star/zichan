/** Response shapes of the management API, kept in one place for the pages below. */
export interface ProcessSnapshot {
  pid: number; nodeVersion: string;
  rssBytes: number; heapTotalBytes: number; heapUsedBytes: number;
  externalBytes: number; arrayBuffersBytes: number;
  /** Window average since the previous sample; null on the very first one. */
  cpuPercent: number | null;
  eventLoopMeanMs: number | null; eventLoopMaxMs: number | null; eventLoopP99Ms: number | null;
  heapLimitBytes: number | null;
  /** Container memory limit when the runtime can read one. */
  constrainedBytes: number | null;
  availableBytes: number | null;
  startedAt: string;
  /** False when the last sample failed and these numbers are the previous reading. */
  available: boolean;
}

export interface DatabaseStats {
  pageCount: number; pageSize: number;
  freelistBytes: number; freelistRatio: number; logicalBytes: number;
  journalMode: string; autoVacuum: string; synchronous: string; tempStore: string;
  cacheSizeKiB: number | null; mmapBytes: number;
  walAutocheckpointPages: number; journalSizeLimitBytes: number; busyTimeoutMs: number;
  encoding: string; analyzedTables: number; analyzedAt: string | null;
}

export interface DatabaseTableUsage {
  name: string; kind: 'table' | 'index' | 'other'; bytes: number; pages: number; rowCount: number | null;
}

export interface ResourcesPayload {
  serverId: string; version: string;
  uptimeSeconds: number; sampledAt: string; stale: boolean;
  process: ProcessSnapshot;
  database: DatabaseStats | null;
  storage: { databaseBytes: number; walBytes: number; shmBytes: number; diskTotalBytes: number | null; diskFreeBytes: number | null };
  /** Only present when the request asked for the per-table scan. */
  tables: { tables: DatabaseTableUsage[]; scannedAt: string; durationMs: number } | null;
  identity: { pid: number; nodeVersion: string; uptimeSeconds: number; heapLimitBytes: number | null; constrainedBytes: number | null; availableBytes: number | null };
  thresholds: { memoryWarnBytes: number; eventLoopLagWarnMs: number; cpuWarnPercent: number };
  note: string;
}

export interface Snapshot {
  sampledAt: string;
  stale: boolean;
  counts: {
    userCount: number; disabledUserCount: number; inviteCount: number;
    commitCount: number; commitBytes: number; activeSessionCount: number;
  };
  storage: {
    databaseBytes: number; walBytes: number; shmBytes: number;
    objectBytes: number; objectCount: number; trashBytes: number; trashCount: number;
    stagingBytes: number; stagingCount: number;
    diskTotalBytes: number | null; diskFreeBytes: number | null;
  };
  cleanup: {
    lastStartedAt?: string; lastFinishedAt?: string; lastOk: boolean | null;
    lastError?: string; lastRemovedObjects: number; lastRemovedUploads: number;
    lastFreedBytes: number; consecutiveFailures: number; runs: number;
  };
  jobs: Record<string, number>;
  alerts: { active: number; pending: number; silenced: number };
  verification: { database?: Record<string, unknown>; blobs?: Record<string, unknown> };
  /** Latest attempt, latest *successful* attempt and latest verified attempt are kept apart. */
  backup: {
    recordId: string; status: string; attemptedAt: string; verificationOk?: boolean;
    lastSuccessRecordId?: string; lastSuccessAt?: string;
    lastVerifiedRecordId?: string; lastVerifiedAt?: string;
  } | null;
  uptimeSeconds: number;
  sampledWithinMs: number;
  process: ProcessSnapshot;
  database: DatabaseStats | null;
}

export interface Alert {
  key: string; rule: string; scope: string; severity: 'warning' | 'critical';
  state: 'pending' | 'active' | 'resolved';
  firstSeenAt: string; lastSeenAt: string; occurrences: number;
  /** Bad samples in a row; only two in a row activate the alert. */
  consecutive: number;
  detail?: Record<string, unknown>;
  acknowledgedAt?: string; acknowledgedBy?: string; resolvedAt?: string;
  /** Silence keeps the record and the rule, and only stops the outbound notification. */
  silencedUntil?: string; silencedBy?: string; silenceReason?: string;
  lastNotifiedAt?: string; notifyState?: 'sent' | 'failed' | 'skipped'; notifyError?: string;
}

export interface Overview {
  serverId: string;
  version: string;
  snapshot: Snapshot;
  alerts: Alert[];
  recentJobs: Job[];
  recentFailures: { id: number; at: string; action: string; code: string | null; message: string | null; requestId: string | null; actorAccountId: string | null }[];
  /**
   * Who opened the management console, when, and from where. Optional because an older server
   * does not send it; the panel is simply absent rather than rendering an empty table.
   */
  recentAdminLogins?: AdminLoginSummary[];
  /**
   * The declared maintenance window, resolved by the same function the write gate uses. Present
   * since `capabilities.maintenance`; absent on an older server, which is why it is optional.
   */
  maintenance?: MaintenanceView;
  drain?: DrainView;
  capabilities: Record<string, boolean>;
}

/**
 * One management-console login: who, when, from where, and whether that session is still alive.
 *
 * `ip` is optional because a session restored from a database that predates the column has none;
 * the panel shows "未记录" rather than an empty cell that reads like a missing value.
 */
export interface AdminLoginSummary {
  sessionId: string;
  username: string;
  role: string;
  at: string;
  ip?: string;
  active: boolean;
}

export interface MaintenanceView {
  /** Whether client writes are being refused *right now* — not merely whether the flag is set. */
  active: boolean;
  enabled: boolean;
  message: string;
  until: string | null;
  startedAt: string | null;
  startedBy: string | null;
  /** Set when the operator declared an end time and it has passed. */
  expired: boolean;
}

export interface DrainView {
  inFlightWrites: number;
  runningJobs: number;
  queuedJobs: number;
  safeToStop: boolean;
  note: string;
}

export interface Metrics {
  range: string; granularity: string; from: string; until: string;
  buckets: {
    bucketAt: string; requests: number; errors: number; slowRequests: number; durationMs: number;
    syncPushOk: number; syncPushFailed: number; syncPullOk: number; blobOk: number; blobFailed: number;
    /** Resource readings are peaks inside the bucket, never sums. */
    rssBytes: number; heapUsedBytes: number; externalBytes: number; cpuPercent: number; eventLoopMaxMs: number;
  }[];
  totals: { requests: number; errors: number; slowRequests: number; errorRate: number | null; averageMs: number | null; syncPushOk: number; syncPushFailed: number; syncPullOk: number; blobOk: number; blobFailed: number };
  resourcePeak: { rssBytes: number; heapUsedBytes: number; externalBytes: number; cpuPercent: number; eventLoopMaxMs: number };
  observedSince: string | null;
  note: string;
}

export interface AccountRow {
  username: string; accountId: string; role: 'owner' | 'admin' | 'viewer' | 'member'; disabled: boolean;
  displayName: string | null;
  activeDeviceCount: number; commitBytes: number; commitQuotaBytes: number | null;
  createdAt: string; updatedAt: string; lastLoginAt?: string; revision: number;
  protectionMode: string | null; quotaState: 'ok' | 'warning' | 'over';
  /** Last successful sync event for this account; null when it has never synced. */
  lastSyncAt?: string | null;
}

export interface AccountDetail {
  account: {
    username: string; accountId: string; role: 'owner' | 'admin' | 'viewer' | 'member'; disabled: boolean;
    displayName: string | null; email: string | null; emailVerifiedAt: string | null; pendingEmail: string | null;
    createdAt: string; updatedAt: string; lastLoginAt: string | null; version: number;
    protection: { mode: string; version: number } | null;
  };
  capacity: {
    commitBytes: number; commitQuotaBytes: number | null; commitCount: number; headSeq: number;
    ledgerId: string | null; replicaId: string | null;
    blobUsedBytes: number; blobQuotaBytes: number | null; blobObjectCount: number;
    blobTrashBytes: number; blobStagingBytes: number; quotaNote: string;
  };
  sessions: SessionRow[];
  activeSessionCount: number;
  sync: { recent: SyncEvent[] };
  audit: { id: number; at: string; actorAccountId: string; targetAccountId: string | null; action: string; reason: string | null; requestId: string | null; before: unknown; after: unknown }[];
  jobs: Job[];
}

export interface SessionRow {
  id: string; username: string; accountId?: string; role: 'owner' | 'admin' | 'viewer' | 'member';
  deviceId: string; deviceName: string; kind: string;
  createdAt: string; lastSeenAt: string; expiresAt: string; lastIp?: string | null;
  revokedAt?: string | null; active: boolean;
}

export interface SyncEvent {
  id: string; at: string; username?: string; accountId?: string; deviceName?: string;
  operation: string; outcome: 'ok' | 'error'; resultCode?: string;
  category?: string; commitCount?: number; bytes?: number; durationMs?: number; requestId?: string;
  /** Self-reported by the client; absent for clients that send no client header. */
  clientKind?: string; clientVersion?: string; protocolVersion?: string;
}

/** Failed authentication attempts grouped by source address. */
export interface AuthFailuresPayload {
  sources: {
    source: string; failures: number; accountCount: number; accounts: string[];
    firstAt: string; lastAt: string;
    /** Whether the limiter currently blocks this address, read from the limiter itself. */
    throttled: boolean;
  }[];
  total: number;
  sourceCount: number;
  note: string;
}

/** Rate-limit buckets as recorded by the limiter. */
export interface RateLimitsPayload {
  buckets: {
    bucketKey: string;
    /** Absent on buckets written before these columns existed; shown as unknown, not guessed. */
    scope: string | null;
    source: string | null;
    hits: number; windowStartedAt: string; blockedUntil: string | null; updatedAt: string;
  }[];
  active: number;
  tracked: number;
  note: string;
}

export interface Job {
  jobId: string; type: string; params: Record<string, unknown>; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string; createdBy: string; targetAccountId?: string; startedAt?: string; finishedAt?: string;
  phase?: string; processed: number; total: number;
  /** Computed by the server: finished is not the same as healthy. */
  outcome?: 'pending' | 'clean' | 'issues-found' | 'failed' | 'cancelled' | 'interrupted';
  result?: Record<string, unknown>; errorCode?: string; errorMessage?: string;
  cancelRequested: boolean; retryOf?: string;
}

export interface JobEvent { id: number; jobId: string; at: string; level: string; message: string; detail?: Record<string, unknown> }

export interface BackupRecord {
  recordId: string; kind: string; status: string; createdAt: string; finishedAt?: string;
  outputPath?: string; serverId?: string; fileCount?: number; totalBytes?: number;
  verifiedAt?: string; verification?: Record<string, unknown>; drill?: Record<string, unknown>;
  /** Deployment-side retention outcome: what it removed and what it refused to touch. */
  retention?: {
    keep?: number; dryRun?: boolean; removed?: { path: string; totalBytes?: number }[]; freedBytes?: number;
    retained?: string[]; unverified?: { path: string; reason: string }[]; unverifiedCount?: number;
  };
  errorMessage?: string; note?: string;
}

/**
 * The paginated backup list.
 *
 * `summary` is queried server-side rather than derived from `backups`: with a filter applied, or
 * after a run of failures, the newest success may not be on this page at all.
 */
export interface BackupsPayload {
  executor?: {
    status: 'unknown' | 'offline' | 'starting' | 'disabled' | 'waiting' | 'running' | 'error' | 'stopped';
    executorId?: string; heartbeatAt?: string; timezone?: string; nextRunAt?: string;
    lastResult?: 'completed' | 'failed' | 'interrupted'; lastFinishedAt?: string; error?: string;
  };
  backups: BackupRecord[];
  nextCursor?: string;
  /** Size of the filtered set, not of this page. */
  total: number;
  summary: {
    lastAttempt?: { recordId: string; status: string; createdAt: string; errorMessage?: string; verificationOk?: boolean } | null;
    lastSuccess: { recordId: string; createdAt: string } | null;
    lastVerified: { recordId: string; verifiedAt: string } | null;
    /** The newest retention run carries its note and outcome, so the page can still say what it did. */
    lastRetention: { recordId: string; createdAt: string; note?: string; retention?: Record<string, unknown> } | null;
  };
  /** The ordering the server actually applied, echoed back so the page cannot show a lie. */
  sort?: { key: string; direction: string };
  note: string;
}

export interface Storage {
  databaseBytes: number; walBytes: number; shmBytes: number;
  objectBytes: number; objectCount: number; trashBytes: number; trashCount: number;
  stagingBytes: number; stagingCount: number;
  diskTotalBytes: number | null; diskFreeBytes: number | null;
  cleanup: Snapshot['cleanup'];
  backupDirectory: string | null;
  diskFreeRatio: number | null;
  note: string;
}

export interface AuditEntry {
  id: number; at: string; actorAccountId: string; targetAccountId: string | null;
  action: string; reason: string | null; requestId: string | null;
  before: unknown; after: unknown; actorName: string; targetName: string; summary: string;
}

export interface MfaStatusPayload {
  enabled: boolean;
  pending: boolean;
  enabledAt?: string;
  recoveryCodesRemaining: number;
  /** Server-side policy: every administrator must have a confirmed second factor. */
  required: boolean;
  administratorsWithoutMfa: string[];
  note: string;
}

export interface SettingsField {
  defaultValue?: number | string;
  name: string; label: string; kind: 'number' | 'select' | 'text'; unit?: string; description: string; maxLength?: number;
  /** Only for text fields: `url` is an http(s) address, `json` a channel list, `free` anything. */
  textFormat?: 'url' | 'free' | 'json';
  stored: number | string | null; envVar: string; source: 'env' | 'database' | 'default';
  value: number | string; minimum?: number; maximum?: number; options?: string[]; editable: boolean;
}

export interface SettingsPayload {
  settings: SettingsField[];
  stored: Record<string, number | string>;
  environment: Record<string, unknown>;
  secrets: Record<string, string>;
  version: { server: string; schema: number };
  security: { accessTokenMinutes: number; sessionDays: number };
}

export interface LogEntry {
  id: string; at: string; level: string; action: string; message: string;
  ip?: string; username?: string; status?: number; detail?: Record<string, unknown>;
}

/** Registration growth and invitation attribution, as returned by `/registration/growth`. */
export interface RegistrationGrowth {
  range: string;
  granularity: 'day' | 'month';
  from: string | null;
  until: string;
  growth: {
    granularity: 'day' | 'month';
    buckets: { at: string; accounts: number; invited: number }[];
    totals: { accounts: number; invited: number; uninvited: number };
  };
  attribution: {
    batches: { at: string; issued: number; used: number }[];
    totals: { issued: number; used: number; available: number; revoked: number; expired: number };
  };
}

export interface Invite { code: string; disabled: boolean; usedBy?: string; expiresAt?: string; createdAt?: string; state?: string }

export const SYNC_CATEGORIES: { value: string; label: string; next: string }[] = [
  { value: 'session-invalid', label: '会话失效', next: '请用户重新登录该设备。' },
  { value: 'quota-exceeded', label: '配额不足', next: '调整配额，或由用户整理已有数据。' },
  { value: 'protocol-incompatible', label: '协议不兼容', next: '更新客户端版本。' },
  { value: 'ledger-mismatch', label: '账本绑定不匹配', next: '核对绑定信息与用户端恢复流程。' },
  { value: 'server-storage-error', label: '服务端存储异常', next: '查看关联日志与存储状态。' },
  { value: 'other', label: '其他', next: '按结果代码查看关联日志。' },
];

export const JOB_TYPES: { value: string; label: string; ownerOnly: boolean; hint: string }[] = [
  { value: 'database.integrity-check', label: '数据库完整性校验', ownerOnly: false, hint: '深度检查，替代就绪探测里的全库检查。' },
  { value: 'database.analyze', label: '重建查询计划统计', ownerOnly: false, hint: '执行 ANALYZE，让查询计划在表增长后仍选中正确的索引。' },
  { value: 'blobs.verify', label: '附件校验', ownerOnly: false, hint: '分批扫描附件，可在批次边界取消。' },
  { value: 'storage.cleanup', label: '附件清理', ownerOnly: false, hint: '清理过期回收站与暂存上传，并记录释放空间。' },
  { value: 'logs.prune', label: '运行日志裁剪', ownerOnly: false, hint: '按保留条数裁剪运行日志。' },
  { value: 'metrics.prune', label: '指标与诊断裁剪', ownerOnly: false, hint: '按保留策略裁剪指标分桶与诊断事件。' },
  { value: 'audit.prune', label: '管理审计裁剪', ownerOnly: false, hint: '按保留条数裁剪管理审计与失败尝试；审计上限默认远高于运行日志。' },
  { value: 'backup.verify', label: '备份校验', ownerOnly: true, hint: '校验已登记的备份记录。' },
  { value: 'restore.drill', label: '恢复演练', ownerOnly: true, hint: '在隔离目录恢复并核对旧会话未复活。' },
];
