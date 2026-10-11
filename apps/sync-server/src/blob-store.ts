import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { NodeSqliteDriver } from '@zichan/db/node';

const BLOB_ID = /^[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const UPLOAD_ID = /^[a-f0-9]{32}$/;
const DEFAULT_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_MAX_BLOB_BYTES = 100 * 1024 * 1024;
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHUNKS = 512;
export const MAX_ENCRYPTED_CHUNK_BYTES = 4 * 1024 * 1024 + 32;

export interface BlobManifestChunk {
  index: number;
  sizeBytes: number;
  ciphertextSha256: string;
  iv: string;
}

export interface BlobManifest {
  v: 1 | 2;
  blobId: string;
  cipherBytes: number;
  chunkCount: number;
  chunks: BlobManifestChunk[];
}

export interface BlobStoreOptions {
  dataDir?: string;
  quotaBytes?: number;
  maxBlobBytes?: number;
  uploadTtlMs?: number;
  trashRetentionMs?: number;
  /** Owner and administrators are exempt from storage quotas on the sync server. */
  isUnlimitedAccount?: (username: string) => Promise<boolean>;
}

export interface BlobReplicaState {
  blobId: string;
  state: 'available' | 'trash';
  counter: number;
  writerNodeId: string;
  changedAt: string;
}

export interface BlobUploadPlan {
  status: 'available' | 'upload';
  uploadId?: string;
  missingChunks: number[];
  quotaBytes: number | null;
  usedBytes: number;
}

export interface BlobUsage {
  quotaBytes: number | null;
  usedBytes: number;
  objectCount: number;
  trashBytes: number;
  trashCount: number;
  stagingBytes: number;
  stagingCount: number;
}

export interface UnownedReplicaRecord {
  kind: 'object' | 'state' | 'upload';
  username: string;
  ledgerId: string;
  blobId: string;
  recordId: string;
  replicaId: string | null;
  candidateReplicaIds: string[];
  namespaceMatches: string[];
  state: string;
  formatVersion: number | null;
  cipherBytes: number | null;
  createdAt: string;
}

export interface BlobVerificationResult {
  checkedObjects: number;
  checkedChunks: number;
  issues: { username: string; blobId: string; detail: string }[];
  /** Present on incremental runs so an interrupted scan can resume after its last object. */
  lastKey?: string;
  cancelled?: boolean;
}

export interface VerifyOptions {
  resumeFrom?: string;
  /** Restricts the scan to one account so per-account maintenance stays bounded. */
  username?: string;
  ledgerId?: string;
  /** Verify only available portable V2 objects promised by a ledger replica. */
  replicaObjectsOnly?: boolean;
  batchSize?: number;
  /** Reports a batch boundary; also the point where cancellation is observed. The last
   * verified key rides along so the caller can persist a resumable checkpoint. */
  onProgress?: (progress: { processed: number; total: number; lastKey?: string }) => Promise<void> | void;
  shouldCancel?: () => Promise<boolean> | boolean;
  /**
   * Hash a chunk. The default hashes inline, which blocks the loop for the duration; the server
   * injects one that hands large chunks to a worker. Injectable so the store keeps working with no
   * worker pool in tests, and so the verification logic does not depend on how hashing is done.
   */
  hashChunk?: (path: string) => Promise<string>;
}

/** Scheduled maintenance used to fail silently; the last outcome is now readable. */
export interface CleanupStatus {
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastOk: boolean | null;
  lastError?: string;
  lastRemovedObjects: number;
  lastRemovedUploads: number;
  lastFreedBytes: number;
  consecutiveFailures: number;
  runs: number;
}

export interface StorageComposition {
  databaseBytes: number;
  walBytes: number;
  shmBytes: number;
  objectBytes: number;
  objectCount: number;
  trashBytes: number;
  trashCount: number;
  stagingBytes: number;
  stagingCount: number;
  quarantineBytes: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
}

interface ObjectCatalog {
  username: string;
  ledgerId: string;
  replicaId?: string;
  blobId: string;
  state: 'available' | 'trash';
  createdAt: string;
  deletedAt?: string;
  manifest: BlobManifest;
  ownershipDecision?: BlobOwnershipDecision;
}

export interface BlobOwnershipDecision {
  decisionId: string;
  kind: 'object';
  username: string;
  ledgerId: string;
  blobId: string;
  fromReplicaId: string | null;
  toReplicaId: string;
  actorAccountId: string;
  reason: string;
  decidedAt: string;
}

export interface BlobStateOwnershipDecision extends Omit<BlobOwnershipDecision, 'kind'> {
  kind: 'state';
}

export interface BlobUploadOwnershipDecision extends Omit<BlobOwnershipDecision, 'kind'> {
  kind: 'upload';
  uploadId: string;
}

function validOwnershipDecision(value: unknown): value is BlobOwnershipDecision {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<BlobOwnershipDecision>;
  return typeof row.decisionId === 'string' && /^[a-f0-9]{32}$/.test(row.decisionId)
    && row.kind === 'object' && typeof row.username === 'string'
    && typeof row.ledgerId === 'string' && typeof row.blobId === 'string' && BLOB_ID.test(row.blobId)
    && (row.fromReplicaId === null || typeof row.fromReplicaId === 'string')
    && typeof row.toReplicaId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(row.toReplicaId)
    && typeof row.actorAccountId === 'string' && row.actorAccountId.length > 0
    && typeof row.reason === 'string' && row.reason.length >= 12 && row.reason.length <= 500
    && typeof row.decidedAt === 'string' && Number.isFinite(Date.parse(row.decidedAt));
}

function nowIso(): string {
  return new Date().toISOString();
}

function fileSize(path: string): number {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
}

function directorySize(path: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directorySize(child);
    else total += fileSize(child);
  }
  return total;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function namespace(username: string, ledgerId: string): string {
  return createHash('sha256').update(`${username}\0${ledgerId}`).digest('hex');
}

function replicaNamespace(ledgerId: string, replicaId: string): string {
  return createHash('sha256').update(`replica-v2\0${ledgerId}\0${replicaId}`).digest('hex');
}

function assertManifest(value: unknown, maxBlobBytes: number): BlobManifest {
  if (!value || typeof value !== 'object') throw new Error('invalid blob manifest');
  const row = value as Partial<BlobManifest>;
  if ((row.v !== 1 && row.v !== 2) || typeof row.blobId !== 'string' || !BLOB_ID.test(row.blobId)) throw new Error('invalid blob id');
  if (!Number.isSafeInteger(row.cipherBytes) || Number(row.cipherBytes) < 16 || Number(row.cipherBytes) > maxBlobBytes + MAX_CHUNKS * 32) {
    throw new Error('invalid encrypted blob size');
  }
  if (!Number.isSafeInteger(row.chunkCount) || Number(row.chunkCount) < 1 || Number(row.chunkCount) > MAX_CHUNKS || !Array.isArray(row.chunks) || row.chunks.length !== row.chunkCount) {
    throw new Error('invalid blob chunk count');
  }
  const chunks: BlobManifestChunk[] = [];
  let total = 0;
  for (let index = 0; index < row.chunks.length; index += 1) {
    const chunk = row.chunks[index] as Partial<BlobManifestChunk>;
    if (chunk.index !== index
      || !Number.isSafeInteger(chunk.sizeBytes) || Number(chunk.sizeBytes) < 16 || Number(chunk.sizeBytes) > MAX_ENCRYPTED_CHUNK_BYTES
      || typeof chunk.ciphertextSha256 !== 'string' || !HASH.test(chunk.ciphertextSha256)
      || typeof chunk.iv !== 'string' || chunk.iv.length < 12 || chunk.iv.length > 64) {
      throw new Error(`invalid blob chunk ${index}`);
    }
    total += Number(chunk.sizeBytes);
    chunks.push({ index, sizeBytes: Number(chunk.sizeBytes), ciphertextSha256: chunk.ciphertextSha256, iv: chunk.iv });
  }
  if (total !== row.cipherBytes) throw new Error('blob cipher size does not match chunks');
  return { v: row.v, blobId: row.blobId, cipherBytes: Number(row.cipherBytes), chunkCount: Number(row.chunkCount), chunks };
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  const handle = openSync(temporary, 'r+');
  try { fsyncSync(handle); } finally { closeSync(handle); }
  renameSync(temporary, path);
}

function atomicBytes(path: string, value: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.part`;
  writeFileSync(temporary, value);
  const handle = openSync(temporary, 'r+');
  try { fsyncSync(handle); } finally { closeSync(handle); }
  renameSync(temporary, path);
}

function catalogAt(path: string): ObjectCatalog | null {
  try {
    const value = JSON.parse(readFileSync(join(path, 'object.json'), 'utf8')) as ObjectCatalog;
    if (!value || typeof value !== 'object' || typeof value.username !== 'string' || typeof value.ledgerId !== 'string'
      || typeof value.blobId !== 'string' || !BLOB_ID.test(value.blobId)
      || (value.state !== 'available' && value.state !== 'trash') || typeof value.createdAt !== 'string'
      || (value.replicaId !== undefined && (typeof value.replicaId !== 'string'
        || !/^[A-Za-z0-9_-]{8,128}$/.test(value.replicaId)))) return null;
    return { ...value, manifest: assertManifest(value.manifest, Number.MAX_SAFE_INTEGER) };
  } catch {
    return null;
  }
}

function objectDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const ns of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const nsPath = join(root, ns.name);
    for (const prefix of readdirSync(nsPath, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const prefixPath = join(nsPath, prefix.name);
      for (const object of readdirSync(prefixPath, { withFileTypes: true }).filter((entry) => entry.isDirectory())) result.push(join(prefixPath, object.name));
    }
  }
  return result;
}

function stagingDirectories(root: string): { namespace: string; uploadId: string; path: string }[] {
  if (!existsSync(root)) return [];
  const result: { namespace: string; uploadId: string; path: string }[] = [];
  for (const ns of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const nsPath = join(root, ns.name);
    for (const upload of readdirSync(nsPath, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      result.push({ namespace: ns.name, uploadId: upload.name, path: join(nsPath, upload.name) });
    }
  }
  return result;
}

export class EncryptedBlobStore {
  readonly dataDir: string;
  readonly ready: Promise<void>;
  private readonly driver: NodeSqliteDriver;
  private readonly ephemeral: boolean;
  private readonly quotaBytes: number;
  private readonly maxBlobBytes: number;
  private readonly uploadTtlMs: number;
  private readonly trashRetentionMs: number;
  private readonly isUnlimitedAccount?: (username: string) => Promise<boolean>;
  private replicaIdResolver?: (username: string, ledgerId: string) => Promise<string>;
  private replicationNodeId = 'local';
  private uploadLock: Promise<void> = Promise.resolve();
  private readonly chunkWriters = new Set<Promise<void>>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanupState: CleanupStatus = {
    lastOk: null, lastRemovedObjects: 0, lastRemovedUploads: 0, lastFreedBytes: 0, consecutiveFailures: 0, runs: 0,
  };
  /** Wired by the server so a failed scheduled cleanup reaches the log instead of vanishing. */
  onCleanupResult?: (status: CleanupStatus) => void;

  constructor(options: BlobStoreOptions = {}) {
    this.ephemeral = !options.dataDir;
    this.dataDir = resolve(options.dataDir ?? mkdtempSync(join(tmpdir(), 'zichan-sync-blobs-')));
    mkdirSync(this.dataDir, { recursive: true });
    this.driver = new NodeSqliteDriver(join(this.dataDir, 'server.sqlite'));
    this.quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
    this.isUnlimitedAccount = options.isUnlimitedAccount;
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    this.uploadTtlMs = options.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS;
    this.trashRetentionMs = options.trashRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
    this.ready = this.initialize();
    void this.ready.then(() => {
      this.cleanupTimer = setInterval(() => { void this.runCleanup(); }, 60 * 60 * 1000);
      this.cleanupTimer.unref?.();
    });
  }

  private async initialize(): Promise<void> {
    await this.driver.exec(`
PRAGMA temp_store = MEMORY;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
CREATE TABLE IF NOT EXISTS blob_objects (
  username TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  replica_id TEXT,
  blob_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  state TEXT NOT NULL,
  cipher_bytes INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (username, ledger_id, blob_id)
);
CREATE INDEX IF NOT EXISTS idx_blob_objects_usage ON blob_objects (username, state);
CREATE INDEX IF NOT EXISTS idx_blob_objects_replication ON blob_objects (username, ledger_id, state, json_extract(manifest_json, '$.v'), blob_id);
CREATE TABLE IF NOT EXISTS blob_v1_migrations (
  replica_id TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  legacy_blob_id TEXT NOT NULL,
  portable_blob_id TEXT NOT NULL,
  actor_account_id TEXT,
  migrated_at TEXT NOT NULL,
  PRIMARY KEY (replica_id, legacy_blob_id)
);
CREATE INDEX IF NOT EXISTS idx_blob_v1_migrations_ledger_legacy
  ON blob_v1_migrations (ledger_id, legacy_blob_id, replica_id);
CREATE TABLE IF NOT EXISTS blob_replica_states (
  username TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  replica_id TEXT,
  blob_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available', 'trash')),
  counter INTEGER NOT NULL CHECK (counter > 0),
  writer_node_id TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (username, ledger_id, blob_id)
);
CREATE INDEX IF NOT EXISTS idx_blob_replica_states_scan ON blob_replica_states (username, ledger_id, blob_id);
CREATE TABLE IF NOT EXISTS blob_uploads (
  upload_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  replica_id TEXT,
  blob_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  cipher_bytes INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (username, ledger_id, blob_id)
);
CREATE INDEX IF NOT EXISTS idx_blob_uploads_expiry ON blob_uploads (expires_at);
CREATE TABLE IF NOT EXISTS blob_user_quotas (
  username TEXT PRIMARY KEY,
  quota_bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blob_upload_chunks (
  upload_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  ciphertext_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (upload_id, chunk_index)
);
CREATE TABLE IF NOT EXISTS blob_ownership_decisions (
  decision_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind = 'object'),
  username TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  from_replica_id TEXT,
  to_replica_id TEXT NOT NULL,
  actor_account_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blob_state_ownership_decisions (
  decision_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  from_replica_id TEXT,
  to_replica_id TEXT NOT NULL,
  actor_account_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blob_upload_ownership_decisions (
  decision_id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL,
  username TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  from_replica_id TEXT,
  to_replica_id TEXT NOT NULL,
  actor_account_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  resumed_at TEXT
);`);
    await this.ensureColumn('blob_objects', 'replica_id', 'TEXT');
    await this.ensureColumn('blob_v1_migrations', 'actor_account_id', 'TEXT');
    await this.ensureColumn('blob_replica_states', 'replica_id', 'TEXT');
    await this.ensureColumn('blob_uploads', 'replica_id', 'TEXT');
    await this.ensureColumn('blob_upload_ownership_decisions', 'resumed_at', 'TEXT');
    await this.driver.exec(`CREATE INDEX IF NOT EXISTS idx_blob_objects_slot ON blob_objects
      (replica_id, state, json_extract(manifest_json, '$.v'), blob_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_blob_objects_slot_id ON blob_objects (replica_id, blob_id)
        WHERE replica_id IS NOT NULL AND json_extract(manifest_json, '$.v') = 2;
      CREATE INDEX IF NOT EXISTS idx_blob_replica_states_slot ON blob_replica_states (replica_id, blob_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_blob_replica_states_slot_id ON blob_replica_states (replica_id, blob_id)
        WHERE replica_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_blob_uploads_slot ON blob_uploads (replica_id, blob_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_blob_uploads_slot_id ON blob_uploads (replica_id, blob_id)
        WHERE replica_id IS NOT NULL;`);
    await this.recoverCatalog();
    // Older V2 trash predates the replicated state log. Preserve its deletion
    // before cleanup removes the recoverable ciphertext directory.
    await this.driver.run(`INSERT OR IGNORE INTO blob_replica_states
      (username, ledger_id, replica_id, blob_id, state, counter, writer_node_id, changed_at)
      SELECT username, ledger_id, replica_id, blob_id, 'trash', 1, 'migration', COALESCE(deleted_at, updated_at)
      FROM blob_objects WHERE state = 'trash' AND json_extract(manifest_json, '$.v') = 2`);
    await this.cleanup();
  }

  private objectDir(state: 'available' | 'trash', ns: string, blobId: string): string {
    if (!HASH.test(ns) || !BLOB_ID.test(blobId)) throw new Error('invalid attachment object path');
    return join(this.dataDir, 'blobs', state === 'available' ? 'objects' : 'trash', ns, blobId.slice(0, 2), blobId);
  }

  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const columns = await this.driver.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some((row) => row.name === column)) {
      await this.driver.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private uploadDir(ns: string, uploadId: string): string {
    if (!HASH.test(ns) || !UPLOAD_ID.test(uploadId)) throw new Error('invalid upload path');
    return join(this.dataDir, 'blobs', 'staging', ns, uploadId);
  }

  private async recoverCatalog(): Promise<void> {
    await this.driver.transaction(async (driver) => {
      await driver.run('DELETE FROM blob_objects');
      for (const [folder, state] of [['objects', 'available'], ['trash', 'trash']] as const) {
        for (const path of objectDirectories(join(this.dataDir, 'blobs', folder))) {
          const catalog = catalogAt(path);
          if (!catalog || catalog.state !== state) continue;
          const actualNamespace = basename(dirname(dirname(path)));
          if (!HASH.test(actualNamespace) || basename(path) !== catalog.blobId
            || basename(dirname(path)) !== catalog.blobId.slice(0, 2)) continue;
          const at = nowIso();
          await driver.run(
            `INSERT OR REPLACE INTO blob_objects
             (username, ledger_id, replica_id, blob_id, namespace, state, cipher_bytes, chunk_count, manifest_json,
              created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              catalog.username, catalog.ledgerId, catalog.replicaId ?? null, catalog.blobId, actualNamespace,
              state, catalog.manifest.cipherBytes, catalog.manifest.chunkCount, JSON.stringify(catalog.manifest),
              catalog.createdAt, at, catalog.deletedAt ?? null,
            ],
          );
          const decision = catalog.ownershipDecision;
          if (decision !== undefined) {
            if (!validOwnershipDecision(decision) || decision.username !== catalog.username
              || decision.ledgerId !== catalog.ledgerId || decision.blobId !== catalog.blobId
              || decision.toReplicaId !== catalog.replicaId) {
              throw new Error('附件归属决定与对象侧写不一致，已停止启动');
            }
            await driver.run(`INSERT OR IGNORE INTO blob_ownership_decisions
              (decision_id, kind, username, ledger_id, blob_id, from_replica_id,
                to_replica_id, actor_account_id, reason, decided_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [decision.decisionId, decision.kind, decision.username, decision.ledgerId,
              decision.blobId, decision.fromReplicaId, decision.toReplicaId,
              decision.actorAccountId, decision.reason, decision.decidedAt]);
            const recorded = await driver.get(`SELECT 1 FROM blob_ownership_decisions
              WHERE decision_id = ? AND kind = ? AND username = ? AND ledger_id = ?
                AND blob_id = ? AND from_replica_id IS ? AND to_replica_id = ?
                AND actor_account_id = ? AND reason = ? AND decided_at = ?`,
            [decision.decisionId, decision.kind, decision.username, decision.ledgerId,
              decision.blobId, decision.fromReplicaId, decision.toReplicaId,
              decision.actorAccountId, decision.reason, decision.decidedAt]);
            if (!recorded) throw new Error('附件归属决定与对象侧写不一致，已停止启动');
          }
        }
      }
    });
  }

  async usage(username: string, ledgerId?: string): Promise<BlobUsage> {
    await this.ready;
    const replicaId = ledgerId ? await this.replicaIdResolver?.(username, ledgerId) : undefined;
    const hasLedgerRoutes = replicaId ? Boolean(await this.driver.get(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_account_routes'")) : false;
    const scope = replicaId && hasLedgerRoutes
      ? `(item.ledger_id = ? AND (item.replica_id = ? OR (item.replica_id IS NULL AND item.username IN
          (SELECT username FROM ledger_account_routes WHERE replica_id = ?)
          AND NOT EXISTS (SELECT 1 FROM ledger_replacement_checkpoints checkpoint
            WHERE checkpoint.username = item.username AND checkpoint.ledger_id = item.ledger_id
              AND checkpoint.replica_id <> ?))))`
      : replicaId ? 'item.ledger_id = ? AND item.replica_id = ?'
      : 'item.username = ?';
    const params = replicaId && hasLedgerRoutes ? [ledgerId!, replicaId, replicaId, replicaId]
      : replicaId ? [ledgerId!, replicaId] : [username];
    let quotaOwner = username;
    if (replicaId && hasLedgerRoutes) {
      const owner = await this.driver.get<{ username: string }>(
        'SELECT username FROM sync_replicas WHERE replica_id = ?', [replicaId]);
      quotaOwner = owner?.username ?? username;
    }
    // A migrated V1 remains on disk for recovery, but its available V2 replaces
    // it for logical quota accounting. Restoring or losing V2 charges V1 again.
    const migratedLegacyFilter = ` AND NOT (
      item.state = 'available' AND json_extract(item.manifest_json, '$.v') = 1
      AND EXISTS (SELECT 1 FROM blob_v1_migrations migration
        JOIN blob_objects portable ON portable.replica_id = migration.replica_id
          AND portable.ledger_id = migration.ledger_id
          AND portable.blob_id = migration.portable_blob_id
        WHERE migration.ledger_id = item.ledger_id
          AND migration.legacy_blob_id = item.blob_id
          AND (item.replica_id IS NULL OR item.replica_id = migration.replica_id)
          AND portable.state = 'available' AND json_extract(portable.manifest_json, '$.v') = 2))`;
    const rows = await this.driver.all<{ state: string; bytes: number; count: number }>(
      `SELECT state, COALESCE(SUM(cipher_bytes), 0) AS bytes, COUNT(*) AS count FROM blob_objects item
        WHERE ${scope}${migratedLegacyFilter} GROUP BY state`,
      params,
    );
    const staging = await this.driver.get<{ bytes: number; count: number }>(
      `SELECT COALESCE(SUM(cipher_bytes), 0) AS bytes, COUNT(*) AS count FROM blob_uploads item WHERE ${scope}`,
      params,
    );
    const available = rows.find((row) => row.state === 'available');
    const trash = rows.find((row) => row.state === 'trash');
    const quota = await this.driver.get<{ quota_bytes: number }>('SELECT quota_bytes FROM blob_user_quotas WHERE username = ?', [quotaOwner]);
    const hasSlotQuotaTable = replicaId && hasLedgerRoutes && await this.driver.get(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_replica_blob_quotas'");
    const slotQuota = hasSlotQuotaTable ? await this.driver.get<{ quota_bytes: number }>(
      'SELECT quota_bytes FROM ledger_replica_blob_quotas WHERE replica_id = ?', [replicaId]) : undefined;
    return {
      quotaBytes: await this.isUnlimitedAccount?.(quotaOwner) ? null
        : Number(slotQuota?.quota_bytes ?? quota?.quota_bytes ?? this.quotaBytes),
      usedBytes: Number(available?.bytes ?? 0) + Number(trash?.bytes ?? 0) + Number(staging?.bytes ?? 0),
      objectCount: Number(available?.count ?? 0),
      trashBytes: Number(trash?.bytes ?? 0),
      trashCount: Number(trash?.count ?? 0),
      stagingBytes: Number(staging?.bytes ?? 0),
      stagingCount: Number(staging?.count ?? 0),
    };
  }

  async setUserQuota(username: string, quotaBytes?: number): Promise<BlobUsage> {
    await this.ready;
    if (quotaBytes !== undefined && (!Number.isSafeInteger(quotaBytes)
      || quotaBytes < 1024 * 1024 || quotaBytes > 1024 ** 4)) throw new Error('invalid attachment quota');
    await this.driver.transaction(async (driver) => {
      const slotTable = await driver.get(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_replica_blob_quotas'");
      if (quotaBytes === undefined) {
        await driver.run('DELETE FROM blob_user_quotas WHERE username = ?', [username]);
        if (slotTable) await driver.run(`DELETE FROM ledger_replica_blob_quotas WHERE replica_id IN
          (SELECT replica_id FROM sync_replicas WHERE username = ?)`, [username]);
      } else {
        const at = nowIso();
        await driver.run('INSERT OR REPLACE INTO blob_user_quotas (username, quota_bytes, updated_at) VALUES (?, ?, ?)',
          [username, quotaBytes, at]);
        if (slotTable) await driver.run(`INSERT INTO ledger_replica_blob_quotas (replica_id, quota_bytes, updated_at)
          SELECT replica_id, ?, ? FROM sync_replicas WHERE username = ?
          ON CONFLICT(replica_id) DO UPDATE SET quota_bytes = excluded.quota_bytes,
            updated_at = excluded.updated_at`, [quotaBytes, at, username]);
      }
    });
    return this.usage(username);
  }

  /** Persist ownership inferred from a live route or a retained replacement checkpoint. */
  async reconcileReplicaOwnership(): Promise<{
    objectsUpdated: number; statesUpdated: number; uploadsUpdated: number;
    unownedObjects: number; unownedStates: number; unownedUploads: number;
  }> {
    await this.ready;
    const marker = await this.driver.get<{ value: string }>(
      "SELECT value FROM server_meta WHERE key = 'blob_ownership_sidecars_v1'");
    const fullPass = marker?.value !== 'complete';
    const candidateCache = new Map<string, string[]>();
    const candidates = async (username: string, ledgerId: string): Promise<string[]> => {
      const key = `${username.toLowerCase()}\0${ledgerId}`;
      const cached = candidateCache.get(key);
      if (cached) return cached;
      const rows = await this.driver.all<{ replica_id: string }>(`SELECT replica_id FROM (
        SELECT route.replica_id FROM ledger_account_routes route
          JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
          WHERE route.username = ? AND slot.ledger_id = ?
        UNION
        SELECT checkpoint.replica_id FROM ledger_replacement_checkpoints checkpoint
          JOIN ledger_replica_slots slot ON slot.replica_id = checkpoint.replica_id
          WHERE checkpoint.username = ? AND checkpoint.ledger_id = ?
            AND slot.ledger_id = checkpoint.ledger_id
      )`, [username, ledgerId, username, ledgerId]);
      const ids = rows.map((row) => row.replica_id);
      candidateCache.set(key, ids);
      return ids;
    };
    const resolveReplica = async (username: string, ledgerId: string,
      physicalNamespace?: string, sidecarReplicaId?: string): Promise<string | undefined> => {
      const ids = await candidates(username, ledgerId);
      if (sidecarReplicaId) return ids.includes(sidecarReplicaId) ? sidecarReplicaId : undefined;
      if (physicalNamespace) {
        const matches = ids.filter((id) => replicaNamespace(ledgerId, id) === physicalNamespace);
        if (matches.length === 1) return matches[0];
      }
      return ids.length === 1 ? ids[0] : undefined;
    };
    let objectsUpdated = 0;
    let cursor = ['', '', ''];
    while (true) {
      const rows = await this.driver.all<Record<string, unknown>>(`SELECT username, ledger_id,
        replica_id, blob_id, namespace, state FROM blob_objects
        WHERE (username, ledger_id, blob_id) > (?, ?, ?)
          ${fullPass ? '' : 'AND replica_id IS NULL'}
        ORDER BY username, ledger_id, blob_id LIMIT 200`, cursor);
      for (const row of rows) {
        const username = String(row['username']);
        const ledgerId = String(row['ledger_id']);
        const blobId = String(row['blob_id']);
        cursor = [username, ledgerId, blobId];
        const state = row['state'] === 'trash' ? 'trash' : 'available';
        const physicalNamespace = String(row['namespace']);
        const path = this.objectDir(state, physicalNamespace, blobId);
        const catalog = catalogAt(path);
        const replicaId = row['replica_id'] == null
          ? await resolveReplica(username, ledgerId, physicalNamespace, catalog?.replicaId)
          : String(row['replica_id']);
        if (!replicaId) continue;
        const slot = await this.driver.get<{ ledger_id: string }>(
          'SELECT ledger_id FROM ledger_replica_slots WHERE replica_id = ?', [replicaId]);
        if (!slot) continue; // Preserve an old sidecar until a verified backup restores its slot.
        if (slot.ledger_id !== ledgerId) throw new Error('附件归属与账本副本槽位不一致，已停止启动');
        if (!catalog || catalog.username !== username || catalog.ledgerId !== ledgerId
          || catalog.blobId !== blobId || catalog.state !== state
          || catalog.replicaId && catalog.replicaId !== replicaId) {
          throw new Error('附件侧写与 SQLite 归属不一致，已停止启动');
        }
        if (catalog.replicaId !== replicaId) {
          atomicJson(join(path, 'object.json'), { ...catalog, replicaId });
          objectsUpdated += 1;
        }
        if (row['replica_id'] == null) await this.driver.run(`UPDATE blob_objects SET replica_id = ?
          WHERE username = ? AND ledger_id = ? AND blob_id = ? AND replica_id IS NULL`,
        [replicaId, username, ledgerId, blobId]);
      }
      if (rows.length < 200) break;
    }
    const updateMetadata = async (table: 'blob_replica_states' | 'blob_uploads'): Promise<number> => {
      let updated = 0;
      let afterRowId = 0;
      while (true) {
        const rows = await this.driver.all<{ rowid: number; username: string; ledger_id: string;
          blob_id: string; namespace: string | null }>(
          `SELECT rowid, username, ledger_id, blob_id,
            ${table === 'blob_uploads' ? 'namespace' : 'NULL AS namespace'} FROM ${table}
            WHERE replica_id IS NULL AND rowid > ? ORDER BY rowid LIMIT 200`, [afterRowId]);
        for (const row of rows) {
          afterRowId = Number(row.rowid);
          const object = table === 'blob_replica_states' ? await this.driver.get<{ replica_id: string | null }>(
            `SELECT replica_id FROM blob_objects WHERE username = ? AND ledger_id = ? AND blob_id = ?`,
            [row.username, row.ledger_id, row.blob_id]) : undefined;
          const replicaId = await resolveReplica(row.username, row.ledger_id,
            row.namespace ?? undefined, object?.replica_id ?? undefined);
          if (replicaId) {
            await this.driver.run(`UPDATE ${table} SET replica_id = ? WHERE rowid = ? AND replica_id IS NULL`,
              [replicaId, row.rowid]);
            updated += 1;
          }
        }
        if (rows.length < 200) break;
      }
      return updated;
    };
    const statesUpdated = await updateMetadata('blob_replica_states');
    const uploadsUpdated = await updateMetadata('blob_uploads');
    if (fullPass) await this.driver.run(`INSERT INTO server_meta (key, value, updated_at)
      VALUES ('blob_ownership_sidecars_v1', 'complete', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [nowIso()]);
    const count = async (table: 'blob_objects' | 'blob_replica_states' | 'blob_uploads'): Promise<number> =>
      Number((await this.driver.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table} object
          LEFT JOIN ledger_replica_slots slot ON slot.replica_id = object.replica_id
          WHERE object.replica_id IS NULL OR slot.replica_id IS NULL
            OR slot.ledger_id <> object.ledger_id`))?.count ?? 0);
    return { objectsUpdated, statesUpdated, uploadsUpdated,
      unownedObjects: await count('blob_objects'),
      unownedStates: await count('blob_replica_states'),
      unownedUploads: await count('blob_uploads') };
  }

  async unownedReplicaRecords(): Promise<{ objects: number; states: number; uploads: number }> {
    await this.ready;
    const count = async (table: 'blob_objects' | 'blob_replica_states' | 'blob_uploads'): Promise<number> =>
      Number((await this.driver.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table} object
          LEFT JOIN ledger_replica_slots slot ON slot.replica_id = object.replica_id
          WHERE object.replica_id IS NULL OR slot.replica_id IS NULL
            OR slot.ledger_id <> object.ledger_id`))?.count ?? 0);
    return { objects: await count('blob_objects'), states: await count('blob_replica_states'),
      uploads: await count('blob_uploads') };
  }

  /** Bounded inventory for a human to investigate; this never assigns ownership. */
  async listUnownedReplicaRecords(kind: UnownedReplicaRecord['kind'], cursor = '', limit = 50): Promise<{
    records: UnownedReplicaRecord[]; nextCursor?: string;
  }> {
    await this.ready;
    if (!['object', 'state', 'upload'].includes(kind) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('invalid unowned attachment query');
    }
    let after = ['', '', ''];
    if (cursor) {
      if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid unowned attachment cursor');
      try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(decoded) || decoded.length !== 3 || !decoded.every((part) =>
          typeof part === 'string' && part.length <= 256)) throw new Error('invalid cursor');
        after = decoded as string[];
      } catch { throw new Error('invalid unowned attachment cursor'); }
    }
    const source = kind === 'object'
      ? { table: 'blob_objects', key: 'blob_id', state: 'record.state', namespace: 'record.namespace',
        format: "json_extract(record.manifest_json, '$.v')",
        bytes: 'record.cipher_bytes', at: 'record.created_at' }
      : kind === 'state'
        ? { table: 'blob_replica_states', key: 'blob_id', state: 'record.state', namespace: 'NULL',
          format: 'NULL', bytes: 'NULL', at: 'record.changed_at' }
        : { table: 'blob_uploads', key: 'upload_id', state: "'staging'", namespace: 'record.namespace',
          format: "json_extract(record.manifest_json, '$.v')",
          bytes: 'record.cipher_bytes', at: 'record.created_at' };
    const rows = await this.driver.all<{ username: string; ledger_id: string; blob_id: string;
      record_id: string; replica_id: string | null; namespace: string | null; state: string;
      format_version: number | null; cipher_bytes: number | null; created_at: string }>(`SELECT record.username, record.ledger_id, record.blob_id,
        record.${source.key} AS record_id, record.replica_id, ${source.namespace} AS namespace,
        ${source.state} AS state, ${source.format} AS format_version,
        ${source.bytes} AS cipher_bytes, ${source.at} AS created_at
        FROM ${source.table} record LEFT JOIN ledger_replica_slots slot ON slot.replica_id = record.replica_id
        WHERE (record.replica_id IS NULL OR slot.replica_id IS NULL OR slot.ledger_id <> record.ledger_id)
          AND (record.username, record.ledger_id, record.${source.key}) > (?, ?, ?)
        ORDER BY record.username, record.ledger_id, record.${source.key} LIMIT ?`,
    [...after, limit + 1]);
    const selected = rows.slice(0, limit);
    const candidateCache = new Map<string, string[]>();
    const records: UnownedReplicaRecord[] = [];
    for (const row of selected) {
      const candidateKey = `${row.username.toLowerCase()}\0${row.ledger_id}`;
      let candidateReplicaIds = candidateCache.get(candidateKey);
      if (!candidateReplicaIds) {
        const candidates = await this.driver.all<{ replica_id: string }>(`SELECT replica_id FROM (
          SELECT route.replica_id FROM ledger_account_routes route
            JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
            WHERE route.username = ? AND slot.ledger_id = ?
          UNION
          SELECT checkpoint.replica_id FROM ledger_replacement_checkpoints checkpoint
            JOIN ledger_replica_slots slot ON slot.replica_id = checkpoint.replica_id
            WHERE checkpoint.username = ? AND checkpoint.ledger_id = ?
        ) ORDER BY replica_id`, [row.username, row.ledger_id, row.username, row.ledger_id]);
        candidateReplicaIds = candidates.map((candidate) => candidate.replica_id);
        candidateCache.set(candidateKey, candidateReplicaIds);
      }
      records.push({ kind, username: row.username, ledgerId: row.ledger_id,
        blobId: row.blob_id, recordId: row.record_id, replicaId: row.replica_id,
        candidateReplicaIds, namespaceMatches: row.namespace
          ? candidateReplicaIds.filter((id) => replicaNamespace(row.ledger_id, id) === row.namespace) : [],
        state: row.state, formatVersion: row.format_version == null ? null : Number(row.format_version),
        cipherBytes: row.cipher_bytes == null ? null : Number(row.cipher_bytes),
        createdAt: row.created_at });
    }
    const last = selected.at(-1);
    return { records, ...(rows.length > limit && last ? {
      nextCursor: Buffer.from(JSON.stringify([last.username, last.ledger_id, last.record_id])).toString('base64url'),
    } : {}) };
  }

  private async assertOwnershipCandidate(username: string, ledgerId: string, replicaId: string): Promise<void> {
    const candidates = await this.driver.all<{ replica_id: string }>(`SELECT replica_id FROM (
      SELECT route.replica_id FROM ledger_account_routes route
        JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
        WHERE route.username = ? AND slot.ledger_id = ?
      UNION
      SELECT checkpoint.replica_id FROM ledger_replacement_checkpoints checkpoint
        JOIN ledger_replica_slots slot ON slot.replica_id = checkpoint.replica_id
        WHERE checkpoint.username = ? AND checkpoint.ledger_id = ?
    )`, [username, ledgerId, username, ledgerId]);
    if (!candidates.some((candidate) => candidate.replica_id === replicaId)) {
      throw Object.assign(new Error('target is not a verified historical replica candidate'),
        { code: 'REPLICA_CANDIDATE_REQUIRED' });
    }
  }

  /** Explicit recovery of one V2 object; the sidecar survives SQLite catalog rebuilding. */
  async assignUnownedObject(input: { username: string; ledgerId: string; blobId: string;
    replicaId: string; actorAccountId: string; reason: string }): Promise<BlobOwnershipDecision> {
    await this.ready;
    const { username, ledgerId, blobId, replicaId, actorAccountId } = input;
    const reason = input.reason.trim();
    if (!username || !ledgerId || !BLOB_ID.test(blobId) || !/^[A-Za-z0-9_-]{8,128}$/.test(replicaId)
      || !actorAccountId || reason.length < 12 || reason.length > 500) {
      throw Object.assign(new Error('invalid attachment ownership decision'), { code: 'INVALID_OWNERSHIP_DECISION' });
    }
    return this.withUploadLock(async () => {
      await this.assertOwnershipCandidate(username, ledgerId, replicaId);
      const row = await this.driver.get<Record<string, unknown>>(`SELECT object.* FROM blob_objects object
        LEFT JOIN ledger_replica_slots slot ON slot.replica_id = object.replica_id
        WHERE object.username = ? AND object.ledger_id = ? AND object.blob_id = ?
          AND (object.replica_id IS NULL OR slot.replica_id IS NULL OR slot.ledger_id <> object.ledger_id)`,
      [username, ledgerId, blobId]);
      if (!row || (JSON.parse(String(row['manifest_json'])) as BlobManifest).v !== 2) {
        throw Object.assign(new Error('unowned V2 object no longer exists'), { code: 'UNOWNED_OBJECT_NOT_FOUND' });
      }
      const physicalNamespace = String(row['namespace']);
      if (physicalNamespace !== namespace(username, ledgerId)
        && physicalNamespace !== replicaNamespace(ledgerId, replicaId)) {
        throw Object.assign(new Error('physical namespace points to another replica'),
          { code: 'OBJECT_NAMESPACE_CONFLICT' });
      }
      const state = row['state'] === 'trash' ? 'trash' : 'available';
      const path = this.objectDir(state, physicalNamespace, blobId);
      const catalog = catalogAt(path);
      const fromReplicaId = row['replica_id'] == null ? null : String(row['replica_id']);
      if (!catalog || catalog.username !== username || catalog.ledgerId !== ledgerId
        || catalog.blobId !== blobId || catalog.state !== state
        || JSON.stringify(catalog.manifest) !== String(row['manifest_json'])
        || catalog.replicaId && catalog.replicaId !== fromReplicaId) {
        throw Object.assign(new Error('object sidecar does not match the catalog'),
          { code: 'OBJECT_CATALOG_CONFLICT' });
      }
      try { await this.checkStoredObject(row, async (file) => sha256(readFileSync(file))); }
      catch (error) {
        throw Object.assign(new Error(`encrypted object failed physical verification: ${String(error)}`),
          { code: 'OBJECT_INTEGRITY_FAILED' });
      }
      const decision: BlobOwnershipDecision = { decisionId: randomBytes(16).toString('hex'), kind: 'object',
        username, ledgerId, blobId, fromReplicaId, toReplicaId: replicaId,
        actorAccountId, reason, decidedAt: nowIso() };
      atomicJson(join(path, 'object.json'), { ...catalog, replicaId, ownershipDecision: decision });
      try {
        await this.driver.transaction(async (driver) => {
          const changed = await driver.run(`UPDATE blob_objects SET replica_id = ?
            WHERE username = ? AND ledger_id = ? AND blob_id = ? AND replica_id IS ?`,
          [replicaId, username, ledgerId, blobId, fromReplicaId]);
          if (changed.changes !== 1) throw new Error('object ownership changed during review');
          await driver.run(`UPDATE blob_replica_states SET replica_id = ?
            WHERE username = ? AND ledger_id = ? AND blob_id = ? AND replica_id IS NULL`,
          [replicaId, username, ledgerId, blobId]);
          await driver.run(`UPDATE replica_physical_status SET blob_hash = NULL,
            verified_at = NULL, scanned_at = NULL, issue = NULL
            WHERE username = ? AND ledger_id = ?`, [username, ledgerId]);
          await driver.run(`UPDATE node_replication_links SET physical_blob_hash = NULL,
            physical_verified_at = NULL, physical_scanned_at = NULL,
            physical_issue = NULL, push_state_sweep_at = NULL,
            inventory_matched_at = NULL, updated_at = ?
            WHERE username = ? AND ledger_id = ? AND enabled = 1`,
          [nowIso(), username, ledgerId]);
          await driver.run(`INSERT INTO blob_ownership_decisions
            (decision_id, kind, username, ledger_id, blob_id, from_replica_id,
              to_replica_id, actor_account_id, reason, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [decision.decisionId, decision.kind, username, ledgerId, blobId, fromReplicaId,
            replicaId, actorAccountId, reason, decision.decidedAt]);
        });
      } catch (error) {
        atomicJson(join(path, 'object.json'), catalog);
        throw error;
      }
      return decision;
    });
  }

  /** Isolated V2 state has no ciphertext sidecar; preserve a durable manual decision. */
  async assignUnownedState(input: { username: string; ledgerId: string; blobId: string;
    replicaId: string; actorAccountId: string; reason: string }): Promise<BlobStateOwnershipDecision> {
    await this.ready;
    const { username, ledgerId, blobId, replicaId, actorAccountId } = input;
    const reason = input.reason.trim();
    if (!username || !ledgerId || !BLOB_ID.test(blobId) || !/^[A-Za-z0-9_-]{8,128}$/.test(replicaId)
      || !actorAccountId || reason.length < 12 || reason.length > 500) {
      throw Object.assign(new Error('invalid attachment state ownership decision'),
        { code: 'INVALID_OWNERSHIP_DECISION' });
    }
    return this.withUploadLock(async () => {
      await this.assertOwnershipCandidate(username, ledgerId, replicaId);
      const state = await this.driver.get<{ replica_id: string | null; state: string }>(
        `SELECT record.replica_id, record.state FROM blob_replica_states record
         LEFT JOIN ledger_replica_slots slot ON slot.replica_id = record.replica_id
         WHERE record.username = ? AND record.ledger_id = ? AND record.blob_id = ?
           AND (record.replica_id IS NULL OR slot.replica_id IS NULL OR slot.ledger_id <> record.ledger_id)`,
        [username, ledgerId, blobId]);
      if (!state) throw Object.assign(new Error('unowned attachment state no longer exists'),
        { code: 'UNOWNED_STATE_NOT_FOUND' });
      const conflictingState = await this.driver.get(`SELECT 1 FROM blob_replica_states
        WHERE replica_id = ? AND blob_id = ?`, [replicaId, blobId]);
      if (conflictingState) throw Object.assign(new Error('target replica already has this attachment state'),
        { code: 'STATE_OWNERSHIP_CONFLICT' });
      const sameAccountObject = await this.driver.get<{ replica_id: string | null;
        state: string; manifest_json: string }>(`SELECT replica_id, state, manifest_json FROM blob_objects
        WHERE username = ? AND ledger_id = ? AND blob_id = ?`, [username, ledgerId, blobId]);
      const targetObject = await this.driver.get<{ username: string }>(`SELECT username FROM blob_objects
        WHERE replica_id = ? AND blob_id = ?`, [replicaId, blobId]);
      if (targetObject && targetObject.username !== username
        || sameAccountObject && (sameAccountObject.replica_id !== replicaId
          || sameAccountObject.state !== state.state
          || (JSON.parse(sameAccountObject.manifest_json) as BlobManifest).v !== 2)) {
        throw Object.assign(new Error('attachment object conflicts with the proposed state owner'),
          { code: 'STATE_OWNERSHIP_CONFLICT' });
      }
      const decision: BlobStateOwnershipDecision = {
        decisionId: randomBytes(16).toString('hex'), kind: 'state', username, ledgerId, blobId,
        fromReplicaId: state.replica_id, toReplicaId: replicaId,
        actorAccountId, reason, decidedAt: nowIso(),
      };
      await this.driver.transaction(async (driver) => {
        const changed = await driver.run(`UPDATE blob_replica_states SET replica_id = ?
          WHERE username = ? AND ledger_id = ? AND blob_id = ? AND replica_id IS ?`,
        [replicaId, username, ledgerId, blobId, state.replica_id]);
        if (changed.changes !== 1) throw new Error('attachment state ownership changed during review');
        await driver.run(`INSERT INTO blob_state_ownership_decisions
          (decision_id, username, ledger_id, blob_id, from_replica_id,
            to_replica_id, actor_account_id, reason, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [decision.decisionId, username, ledgerId, blobId, decision.fromReplicaId,
          replicaId, actorAccountId, reason, decision.decidedAt]);
        await driver.run(`UPDATE node_replication_links SET push_state_sweep_at = NULL,
          inventory_matched_at = NULL, updated_at = ?
          WHERE username = ? AND ledger_id = ? AND enabled = 1`,
        [nowIso(), username, ledgerId]);
      });
      return decision;
    });
  }

  /** Resume one historical V2 upload after validating its manifest and every saved chunk. */
  async assignUnownedUpload(input: { username: string; ledgerId: string; blobId: string;
    uploadId: string; replicaId: string; actorAccountId: string; reason: string }): Promise<BlobUploadOwnershipDecision> {
    await this.ready;
    const { username, ledgerId, blobId, uploadId, replicaId, actorAccountId } = input;
    const reason = input.reason.trim();
    if (!username || !ledgerId || !BLOB_ID.test(blobId) || !UPLOAD_ID.test(uploadId)
      || !/^[A-Za-z0-9_-]{8,128}$/.test(replicaId) || !actorAccountId
      || reason.length < 12 || reason.length > 500) {
      throw Object.assign(new Error('invalid upload ownership decision'),
        { code: 'INVALID_OWNERSHIP_DECISION' });
    }
    return this.withUploadLock(async () => {
      await this.assertOwnershipCandidate(username, ledgerId, replicaId);
      const row = await this.driver.get<{ replica_id: string | null; namespace: string;
        manifest_json: string }>(`SELECT upload.replica_id, upload.namespace, upload.manifest_json
        FROM blob_uploads upload LEFT JOIN ledger_replica_slots slot ON slot.replica_id = upload.replica_id
        WHERE upload.upload_id = ? AND upload.username = ? AND upload.ledger_id = ? AND upload.blob_id = ?
          AND (upload.replica_id IS NULL OR slot.replica_id IS NULL OR slot.ledger_id <> upload.ledger_id)`,
      [uploadId, username, ledgerId, blobId]);
      if (!row) throw Object.assign(new Error('unowned upload no longer exists'),
        { code: 'UNOWNED_UPLOAD_NOT_FOUND' });
      let manifest: BlobManifest;
      try { manifest = assertManifest(JSON.parse(row.manifest_json), this.maxBlobBytes); }
      catch { throw Object.assign(new Error('staged upload manifest is invalid'),
        { code: 'UPLOAD_CATALOG_CONFLICT' }); }
      if (manifest.v !== 2 || row.namespace !== namespace(username, ledgerId)
        && row.namespace !== replicaNamespace(ledgerId, replicaId)) {
        throw Object.assign(new Error('staged upload format or physical namespace conflicts with the target replica'),
          { code: 'UPLOAD_NAMESPACE_CONFLICT' });
      }
      const path = this.uploadDir(row.namespace, uploadId);
      try {
        const physical = assertManifest(JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')),
          this.maxBlobBytes);
        if (JSON.stringify(physical) !== JSON.stringify(manifest)) throw new Error('manifest mismatch');
        const saved = await this.driver.all<{ chunk_index: number; size_bytes: number;
          ciphertext_sha256: string }>(`SELECT chunk_index, size_bytes, ciphertext_sha256
          FROM blob_upload_chunks WHERE upload_id = ?`, [uploadId]);
        for (const part of saved) {
          const expected = manifest.chunks[part.chunk_index];
          const file = join(path, `${part.chunk_index}.chunk`);
          if (!expected || expected.sizeBytes !== part.size_bytes
            || expected.ciphertextSha256 !== part.ciphertext_sha256
            || fileSize(file) !== expected.sizeBytes || sha256(readFileSync(file)) !== expected.ciphertextSha256) {
            throw new Error(`saved chunk ${part.chunk_index} failed verification`);
          }
        }
      } catch (error) {
        throw Object.assign(new Error(`staged upload failed physical verification: ${String(error)}`),
          { code: 'UPLOAD_CATALOG_CONFLICT' });
      }
      const object = await this.driver.get(`SELECT 1 FROM blob_objects
        WHERE (username = ? AND ledger_id = ? AND blob_id = ?) OR (replica_id = ? AND blob_id = ?)
        LIMIT 1`, [username, ledgerId, blobId, replicaId, blobId]);
      const state = await this.driver.get<{ replica_id: string | null; state: string }>(
        'SELECT replica_id, state FROM blob_replica_states WHERE username = ? AND ledger_id = ? AND blob_id = ?',
        [username, ledgerId, blobId]);
      if (object || state && (state.replica_id !== replicaId || state.state === 'trash')) {
        throw Object.assign(new Error('an object or deletion state conflicts with the staged upload'),
          { code: 'UPLOAD_OWNERSHIP_CONFLICT' });
      }
      const decision: BlobUploadOwnershipDecision = { decisionId: randomBytes(16).toString('hex'),
        kind: 'upload', username, ledgerId, blobId, uploadId, fromReplicaId: row.replica_id,
        toReplicaId: replicaId, actorAccountId, reason, decidedAt: nowIso() };
      const expiresAt = new Date(Date.now() + this.uploadTtlMs).toISOString();
      await this.driver.transaction(async (driver) => {
        const changed = await driver.run(`UPDATE blob_uploads SET replica_id = ?, updated_at = ?, expires_at = ?
          WHERE upload_id = ? AND replica_id IS ?`,
        [replicaId, decision.decidedAt, expiresAt, uploadId, row.replica_id]);
        if (changed.changes !== 1) throw new Error('upload ownership changed during review');
        await driver.run(`INSERT INTO blob_upload_ownership_decisions
          (decision_id, upload_id, username, ledger_id, blob_id, from_replica_id,
            to_replica_id, actor_account_id, reason, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [decision.decisionId, uploadId, username, ledgerId, blobId, row.replica_id,
          replicaId, actorAccountId, reason, decision.decidedAt]);
      });
      return decision;
    });
  }

  async listOwnershipDecisions(limit = 50): Promise<(
    BlobOwnershipDecision | BlobStateOwnershipDecision | BlobUploadOwnershipDecision)[]> {
    await this.ready;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid decision limit');
    const rows = await this.driver.all<{ decision_id: string; kind: 'object' | 'state' | 'upload';
      upload_id: string | null; username: string;
      ledger_id: string; blob_id: string; from_replica_id: string | null; to_replica_id: string;
      actor_account_id: string; reason: string; decided_at: string }>(
        `SELECT * FROM (
          SELECT decision_id, kind, NULL AS upload_id, username, ledger_id, blob_id, from_replica_id,
            to_replica_id, actor_account_id, reason, decided_at FROM blob_ownership_decisions
          UNION ALL
          SELECT decision_id, 'state' AS kind, NULL AS upload_id, username, ledger_id, blob_id, from_replica_id,
            to_replica_id, actor_account_id, reason, decided_at FROM blob_state_ownership_decisions
          UNION ALL
          SELECT decision_id, 'upload' AS kind, upload_id, username, ledger_id, blob_id, from_replica_id,
            to_replica_id, actor_account_id, reason, decided_at FROM blob_upload_ownership_decisions
        ) ORDER BY decided_at DESC, decision_id DESC LIMIT ?`, [limit]);
    return rows.map((row) => ({ decisionId: row.decision_id, kind: row.kind,
      username: row.username, ledgerId: row.ledger_id, blobId: row.blob_id,
      fromReplicaId: row.from_replica_id, toReplicaId: row.to_replica_id,
      actorAccountId: row.actor_account_id, reason: row.reason, decidedAt: row.decided_at,
      ...(row.kind === 'upload' && row.upload_id ? { uploadId: row.upload_id } : {}),
    })) as (BlobOwnershipDecision | BlobStateOwnershipDecision | BlobUploadOwnershipDecision)[];
  }

  async status(username: string, ledgerId: string, blobIds: string[]): Promise<Record<string, 'available' | 'trash' | 'missing'>> {
    await this.ready;
    const result: Record<string, 'available' | 'trash' | 'missing'> = {};
    for (const blobId of [...new Set(blobIds)]) {
      if (!BLOB_ID.test(blobId)) throw new Error('invalid blob id');
      const row = await this.objectRow(username, ledgerId, blobId);
      result[blobId] = row?.['state'] === 'available' ? 'available' : row?.['state'] === 'trash' ? 'trash' : 'missing';
    }
    return result;
  }

  setReplicationNodeId(nodeId: string): void {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(nodeId)) throw new Error('invalid replication node id');
    this.replicationNodeId = nodeId;
  }

  /** New portable objects use a replica slot; existing object paths remain valid. */
  setReplicaIdResolver(resolver: (username: string, ledgerId: string) => Promise<string>): void {
    this.replicaIdResolver = resolver;
  }

  private async legacyRowBelongsToReplica(username: string, ledgerId: string, replicaId: string): Promise<boolean> {
    const routesExist = await this.driver.get(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_account_routes'");
    if (!routesExist) return true; // Standalone blob stores have no account catalog.
    const rows = await this.driver.all<{ replica_id: string }>(`SELECT replica_id FROM (
      SELECT route.replica_id FROM ledger_account_routes route
        JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
        WHERE route.username = ? AND slot.ledger_id = ?
      UNION
      SELECT checkpoint.replica_id FROM ledger_replacement_checkpoints checkpoint
        JOIN ledger_replica_slots slot ON slot.replica_id = checkpoint.replica_id
        WHERE checkpoint.username = ? AND checkpoint.ledger_id = ?
    ) LIMIT 2`, [username, ledgerId, username, ledgerId]);
    return rows.length === 1 && rows[0]?.replica_id === replicaId;
  }

  private async replicaReadScope(username: string, ledgerId: string): Promise<{ sql: string; params: string[] }> {
    const replicaId = await this.replicaIdResolver?.(username, ledgerId);
    return replicaId
      ? await this.legacyRowBelongsToReplica(username, ledgerId, replicaId)
        ? { sql: '(ledger_id = ? AND (replica_id = ? OR (replica_id IS NULL AND username = ?)))',
          params: [ledgerId, replicaId, username] }
        : { sql: 'ledger_id = ? AND replica_id = ?', params: [ledgerId, replicaId] }
      : { sql: 'username = ? AND ledger_id = ?', params: [username, ledgerId] };
  }

  /** Backups use V1 blob framing too, but they are not legacy ledger attachments. */
  private async legacyAttachmentFilter(replicaId?: string): Promise<{ sql: string; params: string[] }> {
    const catalog = await this.driver.get(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_backup_archives'");
    const backupFilter = catalog ? ` AND NOT EXISTS (SELECT 1 FROM ledger_backup_archives archive
      WHERE archive.username = blob_objects.username
        AND archive.ledger_id = blob_objects.ledger_id
        AND (blob_objects.replica_id IS NULL OR archive.replica_id = blob_objects.replica_id)
        AND archive.blob_id = blob_objects.blob_id)` : '';
    const migrationFilter = replicaId ? ` AND NOT EXISTS (SELECT 1 FROM blob_v1_migrations migration
      JOIN blob_objects portable ON portable.replica_id = migration.replica_id
        AND portable.ledger_id = migration.ledger_id
        AND portable.blob_id = migration.portable_blob_id
      WHERE migration.replica_id = ? AND migration.ledger_id = blob_objects.ledger_id
        AND migration.legacy_blob_id = blob_objects.blob_id
        AND portable.state = 'available' AND json_extract(portable.manifest_json, '$.v') = 2)` : '';
    return { sql: backupFilter + migrationFilter, params: replicaId ? [replicaId] : [] };
  }

  private async objectRow(username: string, ledgerId: string, blobId: string): Promise<Record<string, unknown> | undefined> {
    const replicaId = await this.replicaIdResolver?.(username, ledgerId);
    const own = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM blob_objects WHERE username = ? AND ledger_id = ? AND blob_id = ?',
      [username, ledgerId, blobId],
    );
    if (own && (!replicaId || own['replica_id'] === replicaId
      || own['replica_id'] == null && await this.legacyRowBelongsToReplica(username, ledgerId, replicaId))) return own;
    return replicaId ? this.driver.get<Record<string, unknown>>(
      'SELECT * FROM blob_objects WHERE replica_id = ? AND ledger_id = ? AND blob_id = ?',
      [replicaId, ledgerId, blobId]) : undefined;
  }

  /** V1 IDs include their original account name; return only names with live objects in this replica. */
  async listLegacyRoutes(username: string, ledgerId: string): Promise<string[]> {
    await this.ready;
    const scope = await this.replicaReadScope(username, ledgerId);
    const attachmentFilter = await this.legacyAttachmentFilter(await this.replicaIdResolver?.(username, ledgerId));
    const rows = await this.driver.all<{ username: string }>(
      `SELECT DISTINCT username FROM blob_objects WHERE ${scope.sql} AND state = 'available'
       AND json_extract(manifest_json, '$.v') = 1${attachmentFilter.sql} ORDER BY username`,
    [...scope.params, ...attachmentFilter.params]);
    return rows.map((row) => row.username);
  }

  /** Keep the V1 ciphertext recoverable while a verified V2 object satisfies current replicas. */
  async markLegacyMigrated(username: string, ledgerId: string, legacyBlobId: string,
    portableBlobId: string, actorAccountId: string): Promise<void> {
    await this.ready;
    if (!BLOB_ID.test(legacyBlobId) || !BLOB_ID.test(portableBlobId) || legacyBlobId === portableBlobId
      || !/^[A-Za-z0-9_-]{8,160}$/.test(actorAccountId)) {
      throw Object.assign(new Error('invalid legacy attachment migration ids'), { code: 'INVALID_BLOB_MIGRATION' });
    }
    const replicaId = await this.replicaIdResolver?.(username, ledgerId);
    const [legacy, portable] = await Promise.all([
      this.objectRow(username, ledgerId, legacyBlobId), this.objectRow(username, ledgerId, portableBlobId),
    ]);
    if (!replicaId || !legacy || !portable || legacy['state'] !== 'available'
      || portable['state'] !== 'available' || portable['replica_id'] !== replicaId
      || (JSON.parse(String(legacy['manifest_json'])) as BlobManifest).v !== 1
      || (JSON.parse(String(portable['manifest_json'])) as BlobManifest).v !== 2) {
      throw Object.assign(new Error('legacy and portable attachments are not available in this replica'),
        { code: 'BLOB_MIGRATION_UNAVAILABLE' });
    }
    await this.driver.run(`INSERT INTO blob_v1_migrations
      (replica_id, ledger_id, legacy_blob_id, portable_blob_id, actor_account_id, migrated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(replica_id, legacy_blob_id) DO UPDATE SET
        portable_blob_id = excluded.portable_blob_id,
        actor_account_id = excluded.actor_account_id, migrated_at = excluded.migrated_at`,
    [replicaId, ledgerId, legacyBlobId, portableBlobId, actorAccountId, new Date().toISOString()]);
  }

  private async replicaStateRow(username: string, ledgerId: string, blobId: string): Promise<Record<string, unknown> | undefined> {
    const replicaId = await this.replicaIdResolver?.(username, ledgerId);
    const own = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM blob_replica_states WHERE username = ? AND ledger_id = ? AND blob_id = ?',
      [username, ledgerId, blobId],
    );
    if (own && (!replicaId || own['replica_id'] === replicaId
      || own['replica_id'] == null && await this.legacyRowBelongsToReplica(username, ledgerId, replicaId))) return own;
    return replicaId ? this.driver.get<Record<string, unknown>>(
      'SELECT * FROM blob_replica_states WHERE replica_id = ? AND ledger_id = ? AND blob_id = ?',
      [replicaId, ledgerId, blobId]) : undefined;
  }

  async listReplicaStates(username: string, ledgerId: string, after: string, limit: number): Promise<{
    states: BlobReplicaState[]; nextId: string; hasMore: boolean; totalTombstones: number;
  }> {
    await this.ready;
    if (after && !BLOB_ID.test(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid attachment state cursor');
    const scope = await this.replicaReadScope(username, ledgerId);
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT blob_id, state, counter, writer_node_id, changed_at FROM blob_replica_states
       WHERE ${scope.sql} AND blob_id > ? ORDER BY blob_id LIMIT ?`,
      [...scope.params, after, limit + 1],
    );
    const selected = rows.slice(0, limit);
    const count = await this.driver.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM blob_replica_states WHERE ${scope.sql} AND state = 'trash'`,
      scope.params,
    );
    return { states: selected.map((row) => ({ blobId: String(row['blob_id']),
      state: String(row['state']) as BlobReplicaState['state'], counter: Number(row['counter']),
      writerNodeId: String(row['writer_node_id']), changedAt: String(row['changed_at']) })),
      nextId: selected.length ? String(selected[selected.length - 1]!['blob_id']) : after, hasMore: rows.length > limit,
      totalTombstones: Number(count?.count ?? 0) };
  }

  private async noteLocalReplicaState(username: string, ledgerId: string, blobId: string,
    state: BlobReplicaState['state'], changedAt: string): Promise<void> {
    const replicaId = await this.replicaIdResolver?.(username, ledgerId);
    const row = await this.replicaStateRow(username, ledgerId, blobId);
    const owner = row ?? await this.objectRow(username, ledgerId, blobId);
    const storedBy = owner ? String(owner['username']) : username;
    await this.assertReplicaStateWritable(storedBy, ledgerId, blobId, replicaId);
    await this.driver.run(`INSERT INTO blob_replica_states
      (username, ledger_id, replica_id, blob_id, state, counter, writer_node_id, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (username, ledger_id, blob_id) DO UPDATE SET state = excluded.state,
        replica_id = COALESCE(excluded.replica_id, blob_replica_states.replica_id),
        counter = excluded.counter, writer_node_id = excluded.writer_node_id, changed_at = excluded.changed_at`,
    [storedBy, ledgerId, replicaId ?? null, blobId, state, Number(row?.['counter'] ?? 0) + 1, this.replicationNodeId, changedAt]);
  }

  async applyReplicaState(username: string, ledgerId: string, value: BlobReplicaState): Promise<boolean> {
    await this.ready;
    if (!value || !BLOB_ID.test(value.blobId) || (value.state !== 'available' && value.state !== 'trash')
      || !Number.isSafeInteger(value.counter) || value.counter < 1
      || !/^[A-Za-z0-9_-]{4,128}$/.test(value.writerNodeId)
      || !Number.isFinite(Date.parse(value.changedAt))) throw new Error('invalid replicated attachment state');
    const replicaId = await this.replicaIdResolver?.(username, ledgerId);
    await this.assertReplicaStateWritable(username, ledgerId, value.blobId, replicaId);
    const local = await this.replicaStateRow(username, ledgerId, value.blobId);
    if (local && (Number(local['counter']) > value.counter
      || Number(local['counter']) === value.counter && (local['state'] === 'trash' && value.state === 'available'
        || local['state'] === value.state && String(local['writer_node_id']) >= value.writerNodeId))) {
      const physical = (await this.status(username, ledgerId, [value.blobId]))[value.blobId];
      if (local['state'] === 'trash' && physical === 'available') await this.remove(username, ledgerId, value.blobId, false);
      if (local['state'] === 'available' && physical === 'trash') await this.restore(username, ledgerId, value.blobId, false);
      return false;
    }
    if (value.state === 'trash') await this.remove(username, ledgerId, value.blobId, false);
    else await this.restore(username, ledgerId, value.blobId, false);
    const owner = local ?? await this.objectRow(username, ledgerId, value.blobId);
    const storedBy = owner ? String(owner['username']) : username;
    await this.assertReplicaStateWritable(storedBy, ledgerId, value.blobId, replicaId);
    await this.driver.run(`INSERT INTO blob_replica_states
      (username, ledger_id, replica_id, blob_id, state, counter, writer_node_id, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (username, ledger_id, blob_id) DO UPDATE SET state = excluded.state,
        replica_id = COALESCE(excluded.replica_id, blob_replica_states.replica_id),
        counter = excluded.counter, writer_node_id = excluded.writer_node_id, changed_at = excluded.changed_at`,
    [storedBy, ledgerId, replicaId ?? null, value.blobId, value.state, value.counter, value.writerNodeId, value.changedAt]);
    return true;
  }

  private async assertReplicaStateWritable(username: string, ledgerId: string, blobId: string,
    replicaId?: string): Promise<void> {
    if (!replicaId) return;
    const existing = await this.driver.get<{ replica_id: string | null }>(`SELECT replica_id
      FROM blob_replica_states WHERE username = ? AND ledger_id = ? AND blob_id = ?`,
    [username, ledgerId, blobId]);
    if (!existing || existing.replica_id === replicaId) return;
    if (existing.replica_id == null && await this.legacyRowBelongsToReplica(username, ledgerId, replicaId)) return;
    throw Object.assign(new Error('historical attachment state ownership needs review'),
      { code: 'BLOB_OWNERSHIP_UNRESOLVED' });
  }

  async listPortableManifests(username: string, ledgerId: string, after: string, limit: number): Promise<{
    manifests: BlobManifest[]; nextId: string; hasMore: boolean; totalObjects: number; totalBytes: number; legacyObjects: number;
  }> {
    await this.ready;
    if (after && !BLOB_ID.test(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid attachment cursor');
    const scope = await this.replicaReadScope(username, ledgerId);
    const attachmentFilter = await this.legacyAttachmentFilter(await this.replicaIdResolver?.(username, ledgerId));
    const rows = await this.driver.all<{ blob_id: string; manifest_json: string }>(
      `SELECT blob_id, manifest_json FROM blob_objects WHERE ${scope.sql} AND state = 'available'
       AND json_extract(manifest_json, '$.v') = 2 AND blob_id > ? ORDER BY blob_id LIMIT ?`,
      [...scope.params, after, limit + 1],
    );
    const selected = rows.slice(0, limit);
    const [portable, legacy] = await Promise.all([
      this.driver.get<{ objects: number; bytes: number }>(
        `SELECT COUNT(*) AS objects, COALESCE(SUM(cipher_bytes), 0) AS bytes FROM blob_objects
         WHERE ${scope.sql} AND state = 'available' AND json_extract(manifest_json, '$.v') = 2`, scope.params),
      this.driver.get<{ objects: number }>(
        `SELECT COUNT(*) AS objects FROM blob_objects
         WHERE ${scope.sql} AND state = 'available' AND json_extract(manifest_json, '$.v') = 1
           ${attachmentFilter.sql}`, [...scope.params, ...attachmentFilter.params]),
    ]);
    return { manifests: selected.map((row) => assertManifest(JSON.parse(row.manifest_json), this.maxBlobBytes)),
      nextId: selected.at(-1)?.blob_id ?? after, hasMore: rows.length > limit,
      totalObjects: Number(portable?.objects ?? 0), totalBytes: Number(portable?.bytes ?? 0), legacyObjects: Number(legacy?.objects ?? 0) };
  }

  async beginUpload(username: string, ledgerId: string, value: unknown): Promise<BlobUploadPlan> {
    await this.ready;
    const manifest = assertManifest(value, this.maxBlobBytes);
    return this.withUploadLock(async () => {
      const manifestJson = JSON.stringify(manifest);
      const selectedReplicaId = await this.replicaIdResolver?.(username, ledgerId);
      const replicaId = manifest.v === 2 ? selectedReplicaId : undefined;
      if (replicaId !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(replicaId)) {
        throw new Error('invalid replica id for attachment upload');
      }
      if (selectedReplicaId && !await this.legacyRowBelongsToReplica(username, ledgerId, selectedReplicaId)) {
        const ambiguous = await this.driver.get(`SELECT 1 FROM blob_objects WHERE username = ? AND ledger_id = ?
          AND blob_id = ? AND replica_id IS NULL UNION ALL SELECT 1 FROM blob_uploads
          WHERE username = ? AND ledger_id = ? AND blob_id = ? AND replica_id IS NULL LIMIT 1`,
        [username, ledgerId, manifest.blobId, username, ledgerId, manifest.blobId]);
        if (ambiguous) throw Object.assign(new Error('historical attachment ownership needs review'),
          { code: 'BLOB_OWNERSHIP_UNRESOLVED' });
      }
      const existing = await this.objectRow(username, ledgerId, manifest.blobId);
      let replicaState: Record<string, unknown> | undefined;
      if (manifest.v === 2) {
        replicaState = await this.replicaStateRow(username, ledgerId, manifest.blobId);
        if (replicaState?.['state'] === 'trash') throw Object.assign(new Error('attachment is deleted; restore it explicitly before uploading'), { code: 'BLOB_IN_TRASH' });
      }
      if (existing && existing['manifest_json'] !== manifestJson) throw Object.assign(new Error('blob id already has a different encrypted manifest'), { code: 'BLOB_ID_COLLISION' });
      if (existing?.['state'] === 'trash') {
        if (manifest.v === 2 && replicaState?.['state'] !== 'available') throw Object.assign(new Error('attachment is deleted; restore it explicitly before uploading'), { code: 'BLOB_IN_TRASH' });
        await this.restore(username, ledgerId, manifest.blobId, manifest.v !== 2);
      }
      if (existing) {
        const usage = await this.usage(username, manifest.v === 2 ? ledgerId : undefined);
        return { status: 'available', missingChunks: [], quotaBytes: usage.quotaBytes, usedBytes: usage.usedBytes };
      }
      const active = await this.driver.get<{ upload_id: string; username: string; manifest_json: string }>(
        replicaId
          ? `SELECT upload_id, username, manifest_json FROM blob_uploads
             WHERE ledger_id = ? AND blob_id = ? AND (replica_id = ? OR (replica_id IS NULL AND username = ?))`
          : 'SELECT upload_id, username, manifest_json FROM blob_uploads WHERE username = ? AND ledger_id = ? AND blob_id = ?',
        replicaId ? [ledgerId, manifest.blobId, replicaId, username] : [username, ledgerId, manifest.blobId],
      );
      if (active) {
        if (active.manifest_json !== manifestJson) throw Object.assign(new Error('active upload has a different encrypted manifest'), { code: 'UPLOAD_MANIFEST_MISMATCH' });
        if (active.username !== username && !replicaId) throw Object.assign(new Error('another member is uploading this attachment'), { code: 'UPLOAD_IN_PROGRESS' });
        const done = new Set((await this.driver.all<{ chunk_index: number }>('SELECT chunk_index FROM blob_upload_chunks WHERE upload_id = ?', [active.upload_id])).map((row) => Number(row.chunk_index)));
        const usage = await this.usage(username, manifest.v === 2 ? ledgerId : undefined);
        return { status: 'upload', uploadId: active.upload_id, missingChunks: manifest.chunks.map((chunk) => chunk.index).filter((index) => !done.has(index)), quotaBytes: usage.quotaBytes, usedBytes: usage.usedBytes };
      }
      const usage = await this.usage(username, manifest.v === 2 ? ledgerId : undefined);
      if (usage.quotaBytes !== null && usage.usedBytes + manifest.cipherBytes > usage.quotaBytes) throw Object.assign(new Error('attachment quota exceeded'), { code: 'QUOTA_EXCEEDED' });
      const uploadId = randomBytes(16).toString('hex');
      const ns = replicaId ? replicaNamespace(ledgerId, replicaId) : namespace(username, ledgerId);
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + this.uploadTtlMs).toISOString();
      atomicJson(join(this.uploadDir(ns, uploadId), 'manifest.json'), manifest);
      await this.driver.run(
        `INSERT INTO blob_uploads
         (upload_id, username, ledger_id, replica_id, blob_id, namespace, cipher_bytes, chunk_count, manifest_json, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uploadId, username, ledgerId, replicaId ?? null, manifest.blobId, ns, manifest.cipherBytes, manifest.chunkCount, manifestJson, createdAt, createdAt, expiresAt],
      );
      return { status: 'upload', uploadId, missingChunks: manifest.chunks.map((chunk) => chunk.index), quotaBytes: usage.quotaBytes, usedBytes: usage.usedBytes + manifest.cipherBytes };
    });
  }

  private async withUploadLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.uploadLock;
    const activeWriters = [...this.chunkWriters];
    let release!: () => void;
    this.uploadLock = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    await Promise.all(activeWriters);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Concurrent chunk writes may run together, but exclusive catalog operations drain them. */
  private async withChunkWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.uploadLock;
    let release!: () => void;
    const flight = new Promise<void>((resolveFlight) => { release = resolveFlight; });
    this.chunkWriters.add(flight);
    try {
      await previous;
      return await operation();
    } finally {
      this.chunkWriters.delete(flight);
      release();
    }
  }

  private async authorizedUpload(username: string, uploadId: string): Promise<Record<string, unknown> | undefined> {
    const upload = await this.driver.get<Record<string, unknown>>('SELECT * FROM blob_uploads WHERE upload_id = ?', [uploadId]);
    if (!upload) return undefined;
    if (upload['username'] === username) {
      const callerReplicaId = await this.replicaIdResolver?.(username, String(upload['ledger_id']));
      if (!callerReplicaId || upload['replica_id'] === callerReplicaId
        || upload['replica_id'] == null && await this.legacyRowBelongsToReplica(
          username, String(upload['ledger_id']), callerReplicaId)) return upload;
      return undefined;
    }
    const replicaId = upload['replica_id'];
    if (typeof replicaId !== 'string' || !replicaId
      || (JSON.parse(String(upload['manifest_json'])) as BlobManifest).v !== 2) return undefined;
    const callerReplicaId = await this.replicaIdResolver?.(username, String(upload['ledger_id']));
    return callerReplicaId === replicaId ? upload : undefined;
  }

  async putChunk(username: string, uploadId: string, index: number, contents: Uint8Array): Promise<void> {
    await this.ready;
    if (!UPLOAD_ID.test(uploadId) || !Number.isSafeInteger(index) || index < 0) throw new Error('invalid upload chunk');
    return this.withChunkWrite(async () => {
      const upload = await this.authorizedUpload(username, uploadId);
      if (!upload) throw Object.assign(new Error('upload not found'), { code: 'UPLOAD_NOT_FOUND' });
      const manifest = assertManifest(JSON.parse(String(upload['manifest_json'])), this.maxBlobBytes);
      const expected = manifest.chunks[index];
      if (!expected || contents.byteLength !== expected.sizeBytes || sha256(contents) !== expected.ciphertextSha256) {
        throw Object.assign(new Error('encrypted chunk checksum mismatch'), { code: 'CHUNK_CHECKSUM_MISMATCH' });
      }
      const dir = this.uploadDir(String(upload['namespace']), uploadId);
      atomicBytes(join(dir, `${index}.chunk`), contents);
      const at = nowIso();
      await this.driver.transaction(async (driver) => {
        await driver.run(`INSERT OR REPLACE INTO blob_upload_chunks
          (upload_id, chunk_index, size_bytes, ciphertext_sha256, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
        [uploadId, index, contents.byteLength, expected.ciphertextSha256, at]);
        await driver.run(`UPDATE blob_uploads SET updated_at = ?, expires_at = ? WHERE upload_id = ?`,
          [at, new Date(Date.now() + this.uploadTtlMs).toISOString(), uploadId]);
        await driver.run(`UPDATE blob_upload_ownership_decisions SET resumed_at = COALESCE(resumed_at, ?)
          WHERE upload_id = ?`, [at, uploadId]);
      });
    });
  }

  async completeUpload(username: string, uploadId: string, expectedVersion?: 1 | 2): Promise<BlobManifest> {
    await this.ready;
    return this.withUploadLock(async () => {
      const upload = await this.authorizedUpload(username, uploadId);
      if (!upload) throw Object.assign(new Error('upload not found'), { code: 'UPLOAD_NOT_FOUND' });
      const manifest = assertManifest(JSON.parse(String(upload['manifest_json'])), this.maxBlobBytes);
      if (expectedVersion && manifest.v !== expectedVersion) throw Object.assign(new Error('blob upload version mismatch'), { code: 'INVALID_BLOB_VERSION' });
      if (manifest.v === 2) {
        const replicaState = await this.replicaStateRow(username, String(upload['ledger_id']), manifest.blobId);
        if (replicaState?.['state'] === 'trash') throw Object.assign(new Error('attachment was deleted during upload'), { code: 'BLOB_IN_TRASH' });
      }
      const source = this.uploadDir(String(upload['namespace']), uploadId);
      for (const chunk of manifest.chunks) {
        const path = join(source, `${chunk.index}.chunk`);
        if (!existsSync(path) || statSync(path).size !== chunk.sizeBytes || sha256(readFileSync(path)) !== chunk.ciphertextSha256) {
          throw Object.assign(new Error(`missing or invalid chunk ${chunk.index}`), { code: 'UPLOAD_INCOMPLETE' });
        }
      }
      const existing = await this.objectRow(username, String(upload['ledger_id']), manifest.blobId);
      if (existing) {
        if (existing['manifest_json'] !== JSON.stringify(manifest)) {
          throw Object.assign(new Error('blob id already has a different encrypted manifest'), { code: 'BLOB_ID_COLLISION' });
        }
        if (existing['state'] !== 'available') {
          throw Object.assign(new Error('attachment was deleted during upload'), { code: 'BLOB_IN_TRASH' });
        }
        rmSync(source, { recursive: true, force: true });
        await this.driver.transaction(async (driver) => {
          await driver.run('DELETE FROM blob_upload_chunks WHERE upload_id = ?', [uploadId]);
          await driver.run('DELETE FROM blob_uploads WHERE upload_id = ?', [uploadId]);
        });
        return manifest;
      }
      const createdAt = String(upload['created_at']);
      const catalog: ObjectCatalog = {
        username,
        ledgerId: String(upload['ledger_id']),
        ...(upload['replica_id'] == null ? {} : { replicaId: String(upload['replica_id']) }),
        blobId: manifest.blobId,
        state: 'available',
        createdAt,
        manifest,
      };
      atomicJson(join(source, 'object.json'), catalog);
      const target = this.objectDir('available', String(upload['namespace']), manifest.blobId);
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) {
        throw Object.assign(new Error('attachment path exists without a catalog record; restart to recover it'), { code: 'BLOB_CATALOG_MISSING' });
      }
      renameSync(source, target);
      const at = nowIso();
      await this.driver.transaction(async (driver) => {
        await driver.run(
          `INSERT OR REPLACE INTO blob_objects
           (username, ledger_id, replica_id, blob_id, namespace, state, cipher_bytes, chunk_count, manifest_json, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, NULL)`,
          [username, catalog.ledgerId, catalog.replicaId ?? null, manifest.blobId, String(upload['namespace']), manifest.cipherBytes, manifest.chunkCount, JSON.stringify(manifest), createdAt, at],
        );
        await driver.run('DELETE FROM blob_upload_chunks WHERE upload_id = ?', [uploadId]);
        await driver.run('DELETE FROM blob_uploads WHERE upload_id = ?', [uploadId]);
      });
      return manifest;
    });
  }

  async manifest(username: string, ledgerId: string, blobId: string): Promise<BlobManifest | undefined> {
    await this.ready;
    const row = await this.objectRow(username, ledgerId, blobId);
    return row?.['state'] === 'available'
      ? assertManifest(JSON.parse(String(row['manifest_json'])), this.maxBlobBytes) : undefined;
  }

  async chunk(username: string, ledgerId: string, blobId: string, index: number): Promise<Uint8Array | undefined> {
    await this.ready;
    const row = await this.objectRow(username, ledgerId, blobId);
    const manifest = row?.['state'] === 'available'
      ? assertManifest(JSON.parse(String(row['manifest_json'])), this.maxBlobBytes) : undefined;
    const expected = manifest?.chunks[index];
    if (!manifest || !expected || !row) return undefined;
    const path = join(this.objectDir('available', String(row['namespace']), blobId), `${index}.chunk`);
    if (!existsSync(path)) return undefined;
    const contents = readFileSync(path);
    if (contents.byteLength !== expected.sizeBytes || sha256(contents) !== expected.ciphertextSha256) throw new Error('stored encrypted chunk is corrupt');
    return contents;
  }

  /** Keep damaged ciphertext for diagnosis while making the replica fetch a clean copy. */
  async quarantineCorruptReplicaObject(username: string, ledgerId: string, blobId: string,
    hashChunk: (path: string) => Promise<string>): Promise<boolean> {
    await this.ready;
    if (!BLOB_ID.test(blobId)) throw new Error('invalid blob id');
    return this.withUploadLock(async () => {
      const row = await this.objectRow(username, ledgerId, blobId);
      if (!row || row['state'] !== 'available' || (JSON.parse(String(row['manifest_json'])) as BlobManifest).v !== 2) return false;
      if (!HASH.test(String(row['namespace']))) throw new Error('invalid attachment object path');
      // The object may have been repaired since the sweep reported its issue.
      try { await this.checkStoredObject(row, hashChunk); return false; } catch { /* Still damaged. */ }
      const source = this.objectDir('available', String(row['namespace']), blobId);
      const quarantine = join(this.dataDir, 'blobs', 'quarantine', String(row['namespace']), blobId.slice(0, 2),
        `${blobId}.${Date.now()}.${randomBytes(6).toString('hex')}`);
      const moved = existsSync(source);
      if (moved) {
        mkdirSync(dirname(quarantine), { recursive: true });
        renameSync(source, quarantine);
      }
      try {
        const removed = await this.driver.run(
          "DELETE FROM blob_objects WHERE username = ? AND ledger_id = ? AND blob_id = ? AND state = 'available' AND manifest_json = ?",
          [String(row['username']), ledgerId, blobId, String(row['manifest_json'])]);
        if (removed.changes === 1) return true;
        if (moved) renameSync(quarantine, source);
        return false;
      } catch (error) {
        if (moved && !existsSync(source)) renameSync(quarantine, source);
        throw error;
      }
    });
  }

  async remove(username: string, ledgerId: string, blobId: string, recordReplicaState = true): Promise<boolean> {
    await this.ready;
    if (!BLOB_ID.test(blobId)) throw new Error('invalid blob id');
    const row = await this.objectRow(username, ledgerId, blobId);
    if (!row || row['state'] !== 'available') {
      if (recordReplicaState) {
        const replicaState = await this.replicaStateRow(username, ledgerId, blobId);
        if (replicaState?.['state'] === 'available') {
          await this.noteLocalReplicaState(username, ledgerId, blobId, 'trash', nowIso());
          return true;
        }
      }
      return false;
    }
    if (recordReplicaState && (JSON.parse(String(row['manifest_json'])) as BlobManifest).v === 2) {
      await this.assertReplicaStateWritable(String(row['username']), ledgerId, blobId,
        await this.replicaIdResolver?.(username, ledgerId));
    }
    const deletedAt = nowIso();
    const storedBy = String(row['username']);
    const source = this.objectDir('available', String(row['namespace']), blobId);
    const target = this.objectDir('trash', String(row['namespace']), blobId);
    mkdirSync(dirname(target), { recursive: true });
    const previousDecision = catalogAt(source)?.ownershipDecision;
    const catalog: ObjectCatalog = { username: storedBy, ledgerId,
      ...(row['replica_id'] == null ? {} : { replicaId: String(row['replica_id']) }),
      ...(validOwnershipDecision(previousDecision) ? { ownershipDecision: previousDecision } : {}),
      blobId, state: 'trash', createdAt: String(row['created_at']), deletedAt,
      manifest: JSON.parse(String(row['manifest_json'])) as BlobManifest };
    atomicJson(join(source, 'object.json'), catalog);
    if (existsSync(target)) rmSync(source, { recursive: true, force: true });
    else renameSync(source, target);
    await this.driver.run(
      "UPDATE blob_objects SET state = 'trash', deleted_at = ?, updated_at = ? WHERE username = ? AND ledger_id = ? AND blob_id = ?",
      [deletedAt, deletedAt, storedBy, ledgerId, blobId],
    );
    if (recordReplicaState && (JSON.parse(String(row['manifest_json'])) as BlobManifest).v === 2) {
      await this.noteLocalReplicaState(username, ledgerId, blobId, 'trash', deletedAt);
    }
    return true;
  }

  async restore(username: string, ledgerId: string, blobId: string, recordReplicaState = true): Promise<boolean> {
    await this.ready;
    const row = await this.objectRow(username, ledgerId, blobId);
    if (!row || row['state'] !== 'trash') return false;
    if (recordReplicaState && (JSON.parse(String(row['manifest_json'])) as BlobManifest).v === 2) {
      await this.assertReplicaStateWritable(String(row['username']), ledgerId, blobId,
        await this.replicaIdResolver?.(username, ledgerId));
    }
    const storedBy = String(row['username']);
    const source = this.objectDir('trash', String(row['namespace']), blobId);
    const target = this.objectDir('available', String(row['namespace']), blobId);
    mkdirSync(dirname(target), { recursive: true });
    const previousDecision = catalogAt(source)?.ownershipDecision;
    const catalog: ObjectCatalog = { username: storedBy, ledgerId,
      ...(row['replica_id'] == null ? {} : { replicaId: String(row['replica_id']) }),
      ...(validOwnershipDecision(previousDecision) ? { ownershipDecision: previousDecision } : {}),
      blobId, state: 'available', createdAt: String(row['created_at']),
      manifest: JSON.parse(String(row['manifest_json'])) as BlobManifest };
    atomicJson(join(source, 'object.json'), catalog);
    if (existsSync(target)) rmSync(source, { recursive: true, force: true });
    else renameSync(source, target);
    await this.driver.run(
      "UPDATE blob_objects SET state = 'available', deleted_at = NULL, updated_at = ? WHERE username = ? AND ledger_id = ? AND blob_id = ?",
      [nowIso(), storedBy, ledgerId, blobId],
    );
    if (recordReplicaState && (JSON.parse(String(row['manifest_json'])) as BlobManifest).v === 2) {
      await this.noteLocalReplicaState(username, ledgerId, blobId, 'available', nowIso());
    }
    return true;
  }

  private async checkStoredObject(row: Record<string, unknown>, hashChunk: (path: string) => Promise<string>): Promise<number> {
    const username = String(row['username']);
    const ledgerId = String(row['ledger_id']);
    const blobId = String(row['blob_id']);
    const state = String(row['state']) as 'available' | 'trash';
    const manifest = assertManifest(JSON.parse(String(row['manifest_json'])), this.maxBlobBytes);
    const directory = this.objectDir(state, String(row['namespace']), blobId);
    const catalog = catalogAt(directory);
    if (!catalog || catalog.username !== username || catalog.ledgerId !== ledgerId
      || catalog.blobId !== blobId || catalog.state !== state
      || JSON.stringify(catalog.manifest) !== JSON.stringify(manifest)) {
      throw new Error('object catalog is missing or invalid');
    }
    let checkedChunks = 0;
    for (const chunk of manifest.chunks) {
      const path = join(directory, `${chunk.index}.chunk`);
      if (!existsSync(path)) throw new Error(`chunk ${chunk.index} is missing`);
      checkedChunks += 1;
      if (statSync(path).size !== chunk.sizeBytes || await hashChunk(path) !== chunk.ciphertextSha256) {
        throw new Error(`chunk ${chunk.index} checksum mismatch`);
      }
    }
    return checkedChunks;
  }

  /**
   * Verifies stored chunks in batches. Between batches the loop yields and checks
   * cancellation, so a long scan keeps login and synchronization responsive.
   */
  async verify(options: VerifyOptions = {}): Promise<BlobVerificationResult> {
    await this.ready;
    const result: BlobVerificationResult = { checkedObjects: 0, checkedChunks: 0, issues: [], cancelled: false };
    const resume = options.resumeFrom ?? '';
    const parts = resume ? resume.split('|') : [];
    if (resume && (parts.length !== 2 && parts.length !== 3 || parts.some((part) => !part))) {
      throw new Error('invalid attachment verification checkpoint');
    }
    // Older checkpoints lacked ledgerId. Rewind that account to avoid skipping
    // duplicate object IDs in different ledgers after the ordering upgrade.
    const resumeUsername = parts[0] ?? '';
    const resumeLedgerId = parts.length === 3 ? parts[1]! : '';
    const resumeBlobId = parts.length === 3 ? parts[2]! : '';
    const filters: string[] = [];
    const filterParams: string[] = [];
    const cursorClause = '(username > ? OR (username = ? AND (ledger_id > ? OR (ledger_id = ? AND blob_id > ?))))';
    if (options.replicaObjectsOnly && options.username && options.ledgerId) {
      const scope = await this.replicaReadScope(options.username, options.ledgerId);
      filters.push(scope.sql);
      filterParams.push(...scope.params);
    } else {
      if (options.username) { filters.push('username = ?'); filterParams.push(options.username); }
      if (options.ledgerId) { filters.push('ledger_id = ?'); filterParams.push(options.ledgerId); }
    }
    if (options.replicaObjectsOnly) filters.push("state = 'available' AND json_extract(manifest_json, '$.v') = 2");
    const countClauses = [...filters, ...(resume ? [cursorClause] : [])];
    const where = countClauses.length ? `WHERE ${countClauses.join(' AND ')}` : '';
    const countParams = [...filterParams, ...(resume
      ? [resumeUsername, resumeUsername, resumeLedgerId, resumeLedgerId, resumeBlobId] : [])];
    const total = Number((await this.driver.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM blob_objects ${where}`, countParams))?.count ?? 0);
    const batchSize = Math.max(1, Math.min(500, Math.trunc(options.batchSize ?? 25)));
    const pageSize = Math.max(100, batchSize);
    // Inline by default: a caller without a worker pool still gets a correct verification.
    const hashChunk = options.hashChunk ?? ((path: string) => Promise.resolve(sha256(readFileSync(path))));
    await options.onProgress?.({ processed: 0, total });
    let processed = 0;
    let cursorUsername = resumeUsername;
    let cursorLedgerId = resumeLedgerId;
    let cursorBlobId = resumeBlobId;
    while (processed < total) {
      const pageClauses = [...filters, cursorClause];
      const pageParams = [...filterParams, cursorUsername, cursorUsername, cursorLedgerId,
        cursorLedgerId, cursorBlobId, pageSize];
      const rows = await this.driver.all<Record<string, unknown>>(
        `SELECT * FROM blob_objects WHERE ${pageClauses.join(' AND ')} ORDER BY username, ledger_id, blob_id LIMIT ?`, pageParams);
      if (!rows.length) break;
      for (const row of rows) {
        const username = String(row['username']);
        const ledgerId = String(row['ledger_id']);
        const blobId = String(row['blob_id']);
        result.lastKey = `${username}|${ledgerId}|${blobId}`;
        cursorUsername = username;
        cursorLedgerId = ledgerId;
        cursorBlobId = blobId;
        try {
          result.checkedChunks += await this.checkStoredObject(row, hashChunk);
          result.checkedObjects += 1;
        } catch (error) {
          result.issues.push({ username, blobId, detail: error instanceof Error ? error.message : String(error) });
        }
        processed += 1;
        if (processed % batchSize === 0) {
          await new Promise<void>((resolveYield) => setImmediate(resolveYield));
          await options.onProgress?.({ processed, total, ...(result.lastKey ? { lastKey: result.lastKey } : {}) });
          if (options.shouldCancel && await options.shouldCancel()) {
            result.cancelled = true;
            return result;
          }
        }
      }
    }
    await options.onProgress?.({ processed, total, ...(result.lastKey ? { lastKey: result.lastKey } : {}) });
    return result;
  }

  /** Runs cleanup, records the outcome, and reports failures to the operator. */
  async runCleanup(now = new Date()): Promise<CleanupStatus> {
    this.cleanupState.lastStartedAt = now.toISOString();
    this.cleanupState.runs += 1;
    try {
      const summary = await this.cleanup(now);
      this.cleanupState.lastOk = true;
      this.cleanupState.lastError = undefined;
      this.cleanupState.lastRemovedObjects = summary.removedObjects;
      this.cleanupState.lastRemovedUploads = summary.removedUploads;
      this.cleanupState.lastFreedBytes = summary.freedBytes;
      this.cleanupState.consecutiveFailures = 0;
    } catch (error) {
      this.cleanupState.lastOk = false;
      this.cleanupState.lastError = error instanceof Error ? error.message : String(error);
      this.cleanupState.consecutiveFailures += 1;
    } finally {
      this.cleanupState.lastFinishedAt = new Date().toISOString();
      this.onCleanupResult?.(this.cleanupStatus());
    }
    return this.cleanupStatus();
  }

  cleanupStatus(): CleanupStatus {
    return { ...this.cleanupState };
  }

  /** Logical quota usage stays separate from physical disk usage on the storage page. */
  async storageComposition(): Promise<StorageComposition> {
    await this.ready;
    const directories: [keyof StorageComposition, string][] = [
      ['objectBytes', join(this.dataDir, 'blobs', 'objects')],
      ['trashBytes', join(this.dataDir, 'blobs', 'trash')],
      ['stagingBytes', join(this.dataDir, 'blobs', 'staging')],
      ['quarantineBytes', join(this.dataDir, 'blobs', 'quarantine')],
    ];
    const composition: StorageComposition = {
      databaseBytes: fileSize(join(this.dataDir, 'server.sqlite')),
      walBytes: fileSize(join(this.dataDir, 'server.sqlite-wal')),
      shmBytes: fileSize(join(this.dataDir, 'server.sqlite-shm')),
      objectBytes: 0, objectCount: 0, trashBytes: 0, trashCount: 0, stagingBytes: 0, stagingCount: 0,
      quarantineBytes: 0,
      diskTotalBytes: null, diskFreeBytes: null,
    };
    for (const [key, directory] of directories) composition[key] = directorySize(directory);
    const counts = await this.driver.all<{ state: string; value: number }>(
      "SELECT state, COUNT(*) AS value FROM blob_objects GROUP BY state",
    );
    for (const row of counts) {
      if (row.state === 'available') composition.objectCount = Number(row.value);
      else if (row.state === 'trash') composition.trashCount = Number(row.value);
    }
    const staging = await this.driver.get<{ value: number }>('SELECT COUNT(*) AS value FROM blob_uploads');
    composition.stagingCount = Number(staging?.value ?? 0);
    try {
      const stats = statfsSync(this.dataDir);
      composition.diskTotalBytes = Number(stats.blocks) * Number(stats.bsize);
      composition.diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      composition.diskTotalBytes = null;
      composition.diskFreeBytes = null;
    }
    return composition;
  }

  async cleanup(now = new Date()): Promise<{ removedObjects: number; removedUploads: number; freedBytes: number }> {
    return this.withUploadLock(() => this.cleanupUnlocked(now));
  }

  private async cleanupUnlocked(now: Date): Promise<{ removedObjects: number; removedUploads: number; freedBytes: number }> {
    const nowValue = now.toISOString();
    let removedObjects = 0;
    let removedUploads = 0;
    let freedBytes = 0;
    const hasReplicaSlots = Boolean(await this.driver.get(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_replica_slots'"));
    // An unresolved historical row may be the only remaining copy of ciphertext.
    // Keep it until an operator can prove its replica, even after normal TTLs.
    const ownedUpload = hasReplicaSlots ? `AND u.replica_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM ledger_replica_slots slot
      WHERE slot.replica_id = u.replica_id AND slot.ledger_id = u.ledger_id)` : '';
    for (const completed of await this.driver.all<{ upload_id: string; namespace: string }>(
      `SELECT u.upload_id, u.namespace FROM blob_uploads u
       JOIN blob_objects o ON o.username = u.username AND o.ledger_id = u.ledger_id AND o.blob_id = u.blob_id
       WHERE o.replica_id IS u.replica_id ${ownedUpload}`,
    )) {
      rmSync(this.uploadDir(completed.namespace, completed.upload_id), { recursive: true, force: true });
      await this.driver.run('DELETE FROM blob_upload_chunks WHERE upload_id = ?', [completed.upload_id]);
      await this.driver.run('DELETE FROM blob_uploads WHERE upload_id = ?', [completed.upload_id]);
      removedUploads += 1;
    }
    for (const upload of await this.driver.all<{ upload_id: string; namespace: string }>(
      `SELECT u.upload_id, u.namespace FROM blob_uploads u WHERE u.expires_at <= ? ${ownedUpload}
        AND NOT EXISTS (SELECT 1 FROM blob_upload_ownership_decisions decision
          WHERE decision.upload_id = u.upload_id AND decision.resumed_at IS NULL)`,
      [nowValue])) {
      rmSync(this.uploadDir(upload.namespace, upload.upload_id), { recursive: true, force: true });
      await this.driver.run('DELETE FROM blob_upload_chunks WHERE upload_id = ?', [upload.upload_id]);
      await this.driver.run('DELETE FROM blob_uploads WHERE upload_id = ?', [upload.upload_id]);
      removedUploads += 1;
    }
    const activeUploads = new Set((await this.driver.all<{ upload_id: string; namespace: string }>('SELECT upload_id, namespace FROM blob_uploads'))
      .map((upload) => `${upload.namespace}/${upload.upload_id}`));
    for (const directory of stagingDirectories(join(this.dataDir, 'blobs', 'staging'))) {
      if (!activeUploads.has(`${directory.namespace}/${directory.uploadId}`)) {
        rmSync(directory.path, { recursive: true, force: true });
        continue;
      }
      for (const entry of readdirSync(directory.path, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith('.part') || entry.name.endsWith('.tmp'))) {
          rmSync(join(directory.path, entry.name), { force: true });
        }
      }
    }
    const cutoff = new Date(now.getTime() - this.trashRetentionMs).toISOString();
    const ownedObject = hasReplicaSlots ? `AND object.replica_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM ledger_replica_slots slot
      WHERE slot.replica_id = object.replica_id AND slot.ledger_id = object.ledger_id)` : '';
    for (const object of await this.driver.all<{ username: string; ledger_id: string; blob_id: string; namespace: string; cipher_bytes: number }>(
      `SELECT object.username, object.ledger_id, object.blob_id, object.namespace, object.cipher_bytes
       FROM blob_objects object WHERE object.state = 'trash' AND object.deleted_at <= ? ${ownedObject}`,
      [cutoff],
    )) {
      // Measure before deleting so the report can say how much space came back.
      const freed = directorySize(this.objectDir('trash', object.namespace, object.blob_id));
      rmSync(this.objectDir('trash', object.namespace, object.blob_id), { recursive: true, force: true });
      await this.driver.run('DELETE FROM blob_objects WHERE username = ? AND ledger_id = ? AND blob_id = ?', [object.username, object.ledger_id, object.blob_id]);
      removedObjects += 1;
      freedBytes += freed;
    }
    return { removedObjects, removedUploads, freedBytes };
  }

  async close(): Promise<void> {
    await this.ready;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.uploadLock;
    await Promise.all(this.chunkWriters);
    await this.driver.close();
    if (this.ephemeral) rmSync(this.dataDir, { recursive: true, force: true });
  }
}
