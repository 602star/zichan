/** Response shapes of the management API, kept in one place for the pages below. */
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
  alerts: { active: number; pending: number };
  verification: { database?: Record<string, unknown>; blobs?: Record<string, unknown> };
  /** Latest attempt, latest *successful* attempt and latest verified attempt are kept apart. */
  backup: {
    recordId: string; status: string; attemptedAt: string; verificationOk?: boolean;
    lastSuccessRecordId?: string; lastSuccessAt?: string;
    lastVerifiedRecordId?: string; lastVerifiedAt?: string;
  } | null;
  uptimeSeconds: number;
  sampledWithinMs: number;
}

export interface Alert {
  key: string; rule: string; scope: string; severity: 'warning' | 'critical';
  state: 'pending' | 'active' | 'resolved';
  firstSeenAt: string; lastSeenAt: string; occurrences: number;
  /** Bad samples in a row; only two in a row activate the alert. */
  consecutive: number;
  detail?: Record<string, unknown>;
  acknowledgedAt?: string; acknowledgedBy?: string; resolvedAt?: string;
}

export interface Overview {
  serverId: string;
  version: string;
  snapshot: Snapshot;
  alerts: Alert[];
  recentJobs: Job[];
  recentFailures: { id: number; at: string; action: string; code: string | null; message: string | null; requestId: string | null; actorAccountId: string | null }[];
  capabilities: Record<string, boolean>;
}

export interface Metrics {
  range: string; granularity: string; from: string; until: string;
  buckets: { bucketAt: string; requests: number; errors: number; slowRequests: number; durationMs: number; syncPushOk: number; syncPushFailed: number; syncPullOk: number; blobOk: number; blobFailed: number }[];
  totals: { requests: number; errors: number; slowRequests: number; errorRate: number | null; averageMs: number | null; syncPushOk: number; syncPushFailed: number; syncPullOk: number; blobOk: number; blobFailed: number };
  observedSince: string | null;
  note: string;
}

export interface AccountRow {
  username: string; accountId: string; role: 'owner' | 'admin' | 'member'; disabled: boolean;
  activeDeviceCount: number; commitBytes: number; commitQuotaBytes: number;
  createdAt: string; updatedAt: string; lastLoginAt?: string; revision: number;
  protectionMode: string | null; quotaState: 'ok' | 'warning' | 'over';
}

export interface AccountDetail {
  account: {
    username: string; accountId: string; role: 'owner' | 'admin' | 'member'; disabled: boolean;
    createdAt: string; updatedAt: string; lastLoginAt: string | null; version: number;
    protection: { mode: string; version: number } | null;
  };
  capacity: {
    commitBytes: number; commitQuotaBytes: number; commitCount: number; headSeq: number;
    ledgerId: string | null; replicaId: string | null;
    blobUsedBytes: number; blobQuotaBytes: number; blobObjectCount: number;
    blobTrashBytes: number; blobStagingBytes: number; quotaNote: string;
  };
  sessions: SessionRow[];
  activeSessionCount: number;
  sync: { recent: SyncEvent[] };
  audit: { id: number; at: string; actorAccountId: string; targetAccountId: string | null; action: string; reason: string | null; requestId: string | null; before: unknown; after: unknown }[];
  jobs: Job[];
}

export interface SessionRow {
  id: string; username: string; accountId?: string; role: 'owner' | 'admin' | 'member';
  deviceId: string; deviceName: string; kind: string;
  createdAt: string; lastSeenAt: string; expiresAt: string; lastIp?: string | null;
  revokedAt?: string | null; active: boolean;
}

export interface SyncEvent {
  id: string; at: string; username?: string; accountId?: string; deviceName?: string;
  operation: string; outcome: 'ok' | 'error'; resultCode?: string;
  category?: string; commitCount?: number; bytes?: number; durationMs?: number; requestId?: string;
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
  errorMessage?: string; note?: string;
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

export interface SettingsField {
  name: string; label: string; kind: 'number' | 'select'; unit?: string; description: string;
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
  { value: 'blobs.verify', label: '附件校验', ownerOnly: false, hint: '分批扫描附件，可在批次边界取消。' },
  { value: 'storage.cleanup', label: '附件清理', ownerOnly: false, hint: '清理过期回收站与暂存上传，并记录释放空间。' },
  { value: 'logs.prune', label: '运行日志裁剪', ownerOnly: false, hint: '按保留条数裁剪运行日志。' },
  { value: 'metrics.prune', label: '指标与诊断裁剪', ownerOnly: false, hint: '按保留策略裁剪指标分桶与诊断事件。' },
  { value: 'backup.verify', label: '备份校验', ownerOnly: true, hint: '校验已登记的备份记录。' },
  { value: 'restore.drill', label: '恢复演练', ownerOnly: true, hint: '在隔离目录恢复并核对旧会话未复活。' },
];
