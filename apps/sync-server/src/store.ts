import { Buffer } from 'node:buffer';
import { randomBytes, randomInt } from 'node:crypto';
import { NodeSqliteDriver } from '@zichan/db/node';

export type RegistrationMode = 'open' | 'invite' | 'closed';
export type ServerLogLevel = 'info' | 'warn' | 'error';
export type JsonRecord = Record<string, unknown>;

export interface SyncUser {
  username: string;
  opaqueRegistrationRecord: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
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
}

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
  registrationMode: RegistrationMode;
  userCount: number;
  disabledUserCount: number;
  inviteCount: number;
  commitCount: number;
  commitBytes: number;
  activeSessionCount: number;
  journalMode: string;
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

export class ServerStoreError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

export const CURRENT_SERVER_SCHEMA = 5;
export const CURRENT_SERVER_SCHEMA_NAME = 'server_opaque_pake_v5';
const DEFAULT_COMMIT_QUOTA_BYTES = 512 * 1024 * 1024;
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

function userFromRow(row: Record<string, unknown>): SyncUser {
  return {
    username: String(row['username']),
    opaqueRegistrationRecord: String(row['opaque_registration_record']),
    disabled: bool(row['disabled']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    ...(row['last_login_at'] == null ? {} : { lastLoginAt: String(row['last_login_at']) }),
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

  constructor(
    readonly databaseFile: string,
    private readonly defaultRegistrationMode: RegistrationMode,
    private readonly serverId: string,
    private readonly defaultCommitQuotaBytes = DEFAULT_COMMIT_QUOTA_BYTES,
    initializeAfter?: Promise<unknown>,
  ) {
    this.driver = new NodeSqliteDriver(databaseFile);
    this.ready = initializeAfter
      ? initializeAfter.then(() => this.initialize())
      : this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.driver.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
PRAGMA journal_size_limit = 67108864;
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
  last_login_at TEXT
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
  revoked_at TEXT
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
  ON sync_backup_archives (username, ledger_id, deleted_at, created_at DESC);`);
    const migrations = await this.driver.all<{ version: number; name: string }>('SELECT version, name FROM server_schema_migrations ORDER BY version');
    if (!migrations.length) {
      await this.driver.run('INSERT INTO server_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [CURRENT_SERVER_SCHEMA, CURRENT_SERVER_SCHEMA_NAME, nowIso()]);
    } else if (migrations.length !== 1 || Number(migrations[0]?.version) !== CURRENT_SERVER_SCHEMA || migrations[0]?.name !== CURRENT_SERVER_SCHEMA_NAME) {
      throw new Error('同步服务器数据库不是当前开发版结构，请重置服务器开发数据');
    }
    const at = nowIso();
    const persistedServer = await this.driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['server_id']);
    if (persistedServer && persistedServer.value !== this.serverId) throw new Error('server-id 与 SQLite 主库不匹配');
    await this.driver.run('INSERT OR IGNORE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['server_id', this.serverId, at]);
    await this.driver.run('INSERT OR IGNORE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['registration_mode', this.defaultRegistrationMode, at]);
  }

  async registrationMode(): Promise<RegistrationMode> {
    await this.ready;
    const row = await this.driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['registration_mode']);
    return row?.value === 'invite' || row?.value === 'closed' ? row.value : 'open';
  }

  async setRegistrationMode(mode: RegistrationMode): Promise<void> {
    await this.ready;
    await this.driver.run('INSERT OR REPLACE INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)', ['registration_mode', mode, nowIso()]);
  }

  async assertRegistrationAllowed(inviteCode?: string): Promise<void> {
    await this.ready;
    const mode = await this.registrationMode();
    if (mode === 'closed') throw new ServerStoreError('REGISTRATION_CLOSED', 403, 'registration closed');
    if (mode !== 'invite') return;
    if (!inviteCode) throw new ServerStoreError('INVITE_REQUIRED', 403, 'invite required');
    const invite = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM registration_invites WHERE code = ?',
      [inviteCode],
    );
    if (!invite || bool(invite['disabled']) || invite['used_by'] != null) {
      throw new ServerStoreError('INVALID_INVITE', 403, 'invalid invite');
    }
  }

  async getUser(username: string): Promise<SyncUser | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM sync_users WHERE username = ?', [username]);
    return row ? userFromRow(row) : undefined;
  }

  async register(username: string, opaqueRegistrationRecord: string, inviteCode?: string): Promise<void> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const modeRow = await driver.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', ['registration_mode']);
      const mode = modeRow?.value === 'invite' || modeRow?.value === 'closed' ? modeRow.value : 'open';
      if (mode === 'closed') throw new ServerStoreError('REGISTRATION_CLOSED', 403, 'registration closed');
      let invite: Record<string, unknown> | undefined;
      if (mode === 'invite') {
        if (!inviteCode) throw new ServerStoreError('INVITE_REQUIRED', 403, 'invite required');
        invite = await driver.get<Record<string, unknown>>('SELECT * FROM registration_invites WHERE code = ?', [inviteCode]);
        if (!invite || bool(invite['disabled']) || invite['used_by'] != null) throw new ServerStoreError('INVALID_INVITE', 403, 'invalid invite');
      }
      if (await driver.get('SELECT username FROM sync_users WHERE username = ?', [username])) throw new ServerStoreError('USER_EXISTS', 409, 'user exists');
      const at = nowIso();
      await driver.run(
        'INSERT INTO sync_users (username, opaque_registration_record, disabled, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
        [username, opaqueRegistrationRecord, at, at],
      );
      if (inviteCode) await driver.run('UPDATE registration_invites SET used_by = ?, used_at = ? WHERE code = ?', [username, at, inviteCode]);
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
    id: string;
    username: string;
    deviceId: string;
    deviceName: string;
    refreshHash: string;
    expiresAt: string;
    ip?: string;
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
      ...(input.ip ? { lastIp: input.ip } : {}),
    };
    await this.driver.transaction(async (driver) => {
      await driver.run(
        `UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
         WHERE username = ? AND device_id = ? AND revoked_at IS NULL`,
        [at, at, session.username, session.deviceId],
      );
      await driver.run(
        `INSERT INTO sync_sessions
         (session_id, username, device_id, device_name, refresh_hash, created_at, updated_at, expires_at, last_seen_at, last_ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id, session.username, session.deviceId, session.deviceName, session.refreshHash,
          session.createdAt, session.updatedAt, session.expiresAt, session.lastSeenAt, session.lastIp ?? null,
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

  async listUsers(after = '', limit = 100): Promise<{ users: JsonRecord[]; nextCursor?: string }> {
    await this.ready;
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT u.username, u.disabled, u.created_at, u.updated_at, u.last_login_at,
              r.ledger_id, r.replica_id, COALESCE(r.head_seq, 0) AS commit_count,
              COALESCE(SUM(c.cipher_bytes), 0) AS commit_bytes,
              COALESCE(q.commit_quota_bytes, ?) AS commit_quota_bytes,
              (SELECT COUNT(*) FROM sync_sessions s
               WHERE s.username = u.username AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_device_count
       FROM sync_users u
       LEFT JOIN sync_replicas r ON r.username = u.username
       LEFT JOIN sync_server_commits c ON c.username = u.username
       LEFT JOIN sync_user_quotas q ON q.username = u.username
       WHERE u.username > ? COLLATE NOCASE
       GROUP BY u.username
       ORDER BY u.username COLLATE NOCASE
       LIMIT ?`,
      [this.defaultCommitQuotaBytes, nowIso(), after, limit + 1],
    );
    const page = rows.slice(0, limit).map((row) => ({
      username: String(row['username']), disabled: bool(row['disabled']),
      createdAt: String(row['created_at']), updatedAt: String(row['updated_at']),
      lastLoginAt: row['last_login_at'] ?? null, ledgerId: row['ledger_id'] ?? null,
      replicaId: row['replica_id'] ?? null, commitCount: Number(row['commit_count'] ?? 0),
      commitBytes: Number(row['commit_bytes'] ?? 0), commitQuotaBytes: Number(row['commit_quota_bytes']),
      activeDeviceCount: Number(row['active_device_count'] ?? 0),
    }));
    return { users: page, ...(rows.length > limit ? { nextCursor: String(rows[limit - 1]?.['username'] ?? '') } : {}) };
  }

  async setUserDisabled(username: string, disabled: boolean): Promise<SyncUser | undefined> {
    await this.ready;
    await this.driver.transaction(async (driver) => {
      const at = nowIso();
      await driver.run('UPDATE sync_users SET disabled = ?, updated_at = ? WHERE username = ?', [disabled ? 1 : 0, at, username]);
      if (disabled) await driver.run('UPDATE sync_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE username = ?', [at, at, username]);
    });
    return this.getUser(username);
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
    return (await this.driver.all<Record<string, unknown>>('SELECT * FROM registration_invites ORDER BY created_at DESC')).map(inviteFromRow);
  }

  async getInvite(code: string): Promise<Invite | undefined> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM registration_invites WHERE code = ?', [code]);
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

  async appendLog(log: ServerLog): Promise<void> {
    await this.ready;
    await this.driver.run(
      `INSERT INTO server_logs (id, at, level, action, message, ip, username, status, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [log.id, log.at, log.level, log.action, log.message, log.ip ?? null, log.username ?? null, log.status ?? null, log.detail ? JSON.stringify(log.detail) : null],
    );
    await this.driver.run(
      `DELETE FROM server_logs WHERE id IN (
         SELECT id FROM server_logs ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?
       )`,
      [LOG_RETENTION],
    );
  }

  async listLogs(options: { limit: number; level?: string; from?: string; until?: string; cursor?: string }): Promise<{ logs: ServerLog[]; nextCursor?: string }> {
    await this.ready;
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (options.level) { clauses.push('level = ?'); params.push(options.level); }
    if (options.from) { clauses.push('at >= ?'); params.push(options.from); }
    if (options.until) { clauses.push('at < ?'); params.push(options.until); }
    if (options.cursor) { const [cursorAt, cursorId] = options.cursor.split('|'); clauses.push('(at < ? OR (at = ? AND id < ?))'); params.push(cursorAt ?? '', cursorAt ?? '', cursorId ?? ''); }
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

  async status(): Promise<ServerStatus> {
    await this.ready;
    const row = await this.driver.get<Record<string, unknown>>(
      `SELECT
        (SELECT COUNT(*) FROM sync_users) AS user_count,
        (SELECT COUNT(*) FROM sync_users WHERE disabled = 1) AS disabled_user_count,
        (SELECT COUNT(*) FROM registration_invites) AS invite_count,
        (SELECT COUNT(*) FROM sync_server_commits) AS commit_count,
        (SELECT COALESCE(SUM(cipher_bytes), 0) FROM sync_server_commits) AS commit_bytes,
        (SELECT COUNT(*) FROM sync_sessions WHERE revoked_at IS NULL AND expires_at > ?) AS active_session_count`,
      [nowIso()],
    );
    const journal = await this.driver.get<{ journal_mode: string }>('PRAGMA journal_mode');
    return {
      registrationMode: await this.registrationMode(),
      userCount: Number(row?.['user_count'] ?? 0), disabledUserCount: Number(row?.['disabled_user_count'] ?? 0),
      inviteCount: Number(row?.['invite_count'] ?? 0), commitCount: Number(row?.['commit_count'] ?? 0),
      commitBytes: Number(row?.['commit_bytes'] ?? 0), activeSessionCount: Number(row?.['active_session_count'] ?? 0),
      journalMode: String(journal?.journal_mode ?? ''),
      schemaVersion: CURRENT_SERVER_SCHEMA,
    };
  }

  async verify(): Promise<{ ok: boolean; result: string; journalMode: string; schemaVersion: number }> {
    await this.ready;
    const check = await this.driver.get<Record<string, unknown>>('PRAGMA quick_check');
    const result = String(Object.values(check ?? {})[0] ?? 'unknown');
    const journal = await this.driver.get<{ journal_mode: string }>('PRAGMA journal_mode');
    return { ok: result === 'ok', result, journalMode: String(journal?.journal_mode ?? ''), schemaVersion: CURRENT_SERVER_SCHEMA };
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

  async close(): Promise<void> {
    const initialized = await this.ready.then(() => true, () => false);
    if (initialized) await this.checkpoint().catch(() => undefined);
    await this.driver.close();
  }
}
