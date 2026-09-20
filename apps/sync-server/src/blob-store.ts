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
import { dirname, join, resolve } from 'node:path';
import { NodeSqliteDriver } from '@zichan/db/node';

const BLOB_ID = /^[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const UPLOAD_ID = /^[a-f0-9]{32}$/;
const DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
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
  v: 1;
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
}

export interface BlobUploadPlan {
  status: 'available' | 'upload';
  uploadId?: string;
  missingChunks: number[];
  quotaBytes: number;
  usedBytes: number;
}

export interface BlobUsage {
  quotaBytes: number;
  usedBytes: number;
  objectCount: number;
  trashBytes: number;
  trashCount: number;
  stagingBytes: number;
  stagingCount: number;
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
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
}

interface ObjectCatalog {
  username: string;
  ledgerId: string;
  blobId: string;
  state: 'available' | 'trash';
  createdAt: string;
  deletedAt?: string;
  manifest: BlobManifest;
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

function assertManifest(value: unknown, maxBlobBytes: number): BlobManifest {
  if (!value || typeof value !== 'object') throw new Error('invalid blob manifest');
  const row = value as Partial<BlobManifest>;
  if (row.v !== 1 || typeof row.blobId !== 'string' || !BLOB_ID.test(row.blobId)) throw new Error('invalid blob id');
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
  return { v: 1, blobId: row.blobId, cipherBytes: Number(row.cipherBytes), chunkCount: Number(row.chunkCount), chunks };
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
      || (value.state !== 'available' && value.state !== 'trash') || typeof value.createdAt !== 'string') return null;
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
  private uploadLock: Promise<void> = Promise.resolve();
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
CREATE TABLE IF NOT EXISTS blob_uploads (
  upload_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
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
);`);
    await this.recoverCatalog();
    await this.cleanup();
  }

  private objectDir(state: 'available' | 'trash', ns: string, blobId: string): string {
    return join(this.dataDir, 'blobs', state === 'available' ? 'objects' : 'trash', ns, blobId.slice(0, 2), blobId);
  }

  private uploadDir(ns: string, uploadId: string): string {
    if (!UPLOAD_ID.test(uploadId)) throw new Error('invalid upload id');
    return join(this.dataDir, 'blobs', 'staging', ns, uploadId);
  }

  private async recoverCatalog(): Promise<void> {
    await this.driver.transaction(async (driver) => {
      await driver.run('DELETE FROM blob_objects');
      for (const [folder, state] of [['objects', 'available'], ['trash', 'trash']] as const) {
        for (const path of objectDirectories(join(this.dataDir, 'blobs', folder))) {
          const catalog = catalogAt(path);
          if (!catalog || catalog.state !== state) continue;
          const at = nowIso();
          await driver.run(
            `INSERT OR REPLACE INTO blob_objects
             (username, ledger_id, blob_id, namespace, state, cipher_bytes, chunk_count, manifest_json,
              created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              catalog.username, catalog.ledgerId, catalog.blobId, namespace(catalog.username, catalog.ledgerId),
              state, catalog.manifest.cipherBytes, catalog.manifest.chunkCount, JSON.stringify(catalog.manifest),
              catalog.createdAt, at, catalog.deletedAt ?? null,
            ],
          );
        }
      }
    });
  }

  async usage(username: string): Promise<BlobUsage> {
    await this.ready;
    const rows = await this.driver.all<{ state: string; bytes: number; count: number }>(
      'SELECT state, COALESCE(SUM(cipher_bytes), 0) AS bytes, COUNT(*) AS count FROM blob_objects WHERE username = ? GROUP BY state',
      [username],
    );
    const staging = await this.driver.get<{ bytes: number; count: number }>(
      'SELECT COALESCE(SUM(cipher_bytes), 0) AS bytes, COUNT(*) AS count FROM blob_uploads WHERE username = ?',
      [username],
    );
    const available = rows.find((row) => row.state === 'available');
    const trash = rows.find((row) => row.state === 'trash');
    const quota = await this.driver.get<{ quota_bytes: number }>('SELECT quota_bytes FROM blob_user_quotas WHERE username = ?', [username]);
    return {
      quotaBytes: Number(quota?.quota_bytes ?? this.quotaBytes),
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
    if (quotaBytes === undefined) {
      await this.driver.run('DELETE FROM blob_user_quotas WHERE username = ?', [username]);
    } else {
      if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1024 * 1024 || quotaBytes > 1024 ** 4) throw new Error('invalid attachment quota');
      await this.driver.run(
        'INSERT OR REPLACE INTO blob_user_quotas (username, quota_bytes, updated_at) VALUES (?, ?, ?)',
        [username, quotaBytes, nowIso()],
      );
    }
    return this.usage(username);
  }

  async status(username: string, ledgerId: string, blobIds: string[]): Promise<Record<string, 'available' | 'trash' | 'missing'>> {
    await this.ready;
    const result: Record<string, 'available' | 'trash' | 'missing'> = {};
    for (const blobId of [...new Set(blobIds)]) {
      if (!BLOB_ID.test(blobId)) throw new Error('invalid blob id');
      const row = await this.driver.get<{ state: string }>(
        'SELECT state FROM blob_objects WHERE username = ? AND ledger_id = ? AND blob_id = ?',
        [username, ledgerId, blobId],
      );
      result[blobId] = row?.state === 'available' ? 'available' : row?.state === 'trash' ? 'trash' : 'missing';
    }
    return result;
  }

  async beginUpload(username: string, ledgerId: string, value: unknown): Promise<BlobUploadPlan> {
    await this.ready;
    const manifest = assertManifest(value, this.maxBlobBytes);
    return this.withUploadLock(async () => {
      const manifestJson = JSON.stringify(manifest);
      const existing = await this.driver.get<{ state: string; manifest_json: string }>(
        'SELECT state, manifest_json FROM blob_objects WHERE username = ? AND ledger_id = ? AND blob_id = ?',
        [username, ledgerId, manifest.blobId],
      );
      if (existing && existing.manifest_json !== manifestJson) throw Object.assign(new Error('blob id already has a different encrypted manifest'), { code: 'BLOB_ID_COLLISION' });
      if (existing?.state === 'trash') await this.restore(username, ledgerId, manifest.blobId);
      if (existing) {
        const usage = await this.usage(username);
        return { status: 'available', missingChunks: [], quotaBytes: usage.quotaBytes, usedBytes: usage.usedBytes };
      }
      const active = await this.driver.get<{ upload_id: string; manifest_json: string }>(
        'SELECT upload_id, manifest_json FROM blob_uploads WHERE username = ? AND ledger_id = ? AND blob_id = ?',
        [username, ledgerId, manifest.blobId],
      );
      if (active) {
        if (active.manifest_json !== manifestJson) throw Object.assign(new Error('active upload has a different encrypted manifest'), { code: 'UPLOAD_MANIFEST_MISMATCH' });
        const done = new Set((await this.driver.all<{ chunk_index: number }>('SELECT chunk_index FROM blob_upload_chunks WHERE upload_id = ?', [active.upload_id])).map((row) => Number(row.chunk_index)));
        const usage = await this.usage(username);
        return { status: 'upload', uploadId: active.upload_id, missingChunks: manifest.chunks.map((chunk) => chunk.index).filter((index) => !done.has(index)), quotaBytes: usage.quotaBytes, usedBytes: usage.usedBytes };
      }
      const usage = await this.usage(username);
      if (usage.usedBytes + manifest.cipherBytes > usage.quotaBytes) throw Object.assign(new Error('attachment quota exceeded'), { code: 'QUOTA_EXCEEDED' });
      const uploadId = randomBytes(16).toString('hex');
      const ns = namespace(username, ledgerId);
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + this.uploadTtlMs).toISOString();
      atomicJson(join(this.uploadDir(ns, uploadId), 'manifest.json'), manifest);
      await this.driver.run(
        `INSERT INTO blob_uploads
         (upload_id, username, ledger_id, blob_id, namespace, cipher_bytes, chunk_count, manifest_json, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uploadId, username, ledgerId, manifest.blobId, ns, manifest.cipherBytes, manifest.chunkCount, manifestJson, createdAt, createdAt, expiresAt],
      );
      return { status: 'upload', uploadId, missingChunks: manifest.chunks.map((chunk) => chunk.index), quotaBytes: usage.quotaBytes, usedBytes: usage.usedBytes + manifest.cipherBytes };
    });
  }

  private async withUploadLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.uploadLock;
    let release!: () => void;
    this.uploadLock = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async putChunk(username: string, uploadId: string, index: number, contents: Uint8Array): Promise<void> {
    await this.ready;
    if (!UPLOAD_ID.test(uploadId) || !Number.isSafeInteger(index) || index < 0) throw new Error('invalid upload chunk');
    const upload = await this.driver.get<Record<string, unknown>>('SELECT * FROM blob_uploads WHERE upload_id = ? AND username = ?', [uploadId, username]);
    if (!upload) throw Object.assign(new Error('upload not found'), { code: 'UPLOAD_NOT_FOUND' });
    const manifest = assertManifest(JSON.parse(String(upload['manifest_json'])), this.maxBlobBytes);
    const expected = manifest.chunks[index];
    if (!expected || contents.byteLength !== expected.sizeBytes || sha256(contents) !== expected.ciphertextSha256) {
      throw Object.assign(new Error('encrypted chunk checksum mismatch'), { code: 'CHUNK_CHECKSUM_MISMATCH' });
    }
    const dir = this.uploadDir(String(upload['namespace']), uploadId);
    atomicBytes(join(dir, `${index}.chunk`), contents);
    await this.driver.run(
      `INSERT OR REPLACE INTO blob_upload_chunks (upload_id, chunk_index, size_bytes, ciphertext_sha256, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uploadId, index, contents.byteLength, expected.ciphertextSha256, nowIso()],
    );
    await this.driver.run('UPDATE blob_uploads SET updated_at = ? WHERE upload_id = ?', [nowIso(), uploadId]);
  }

  async completeUpload(username: string, uploadId: string): Promise<BlobManifest> {
    await this.ready;
    const upload = await this.driver.get<Record<string, unknown>>('SELECT * FROM blob_uploads WHERE upload_id = ? AND username = ?', [uploadId, username]);
    if (!upload) throw Object.assign(new Error('upload not found'), { code: 'UPLOAD_NOT_FOUND' });
    const manifest = assertManifest(JSON.parse(String(upload['manifest_json'])), this.maxBlobBytes);
    const source = this.uploadDir(String(upload['namespace']), uploadId);
    for (const chunk of manifest.chunks) {
      const path = join(source, `${chunk.index}.chunk`);
      if (!existsSync(path) || statSync(path).size !== chunk.sizeBytes || sha256(readFileSync(path)) !== chunk.ciphertextSha256) {
        throw Object.assign(new Error(`missing or invalid chunk ${chunk.index}`), { code: 'UPLOAD_INCOMPLETE' });
      }
    }
    const createdAt = String(upload['created_at']);
    const catalog: ObjectCatalog = {
      username,
      ledgerId: String(upload['ledger_id']),
      blobId: manifest.blobId,
      state: 'available',
      createdAt,
      manifest,
    };
    atomicJson(join(source, 'object.json'), catalog);
    const target = this.objectDir('available', String(upload['namespace']), manifest.blobId);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) rmSync(source, { recursive: true, force: true });
    else renameSync(source, target);
    const at = nowIso();
    await this.driver.transaction(async (driver) => {
      await driver.run(
        `INSERT OR REPLACE INTO blob_objects
         (username, ledger_id, blob_id, namespace, state, cipher_bytes, chunk_count, manifest_json, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, NULL)`,
        [username, catalog.ledgerId, manifest.blobId, String(upload['namespace']), manifest.cipherBytes, manifest.chunkCount, JSON.stringify(manifest), createdAt, at],
      );
      await driver.run('DELETE FROM blob_upload_chunks WHERE upload_id = ?', [uploadId]);
      await driver.run('DELETE FROM blob_uploads WHERE upload_id = ?', [uploadId]);
    });
    return manifest;
  }

  async manifest(username: string, ledgerId: string, blobId: string): Promise<BlobManifest | undefined> {
    await this.ready;
    const row = await this.driver.get<{ manifest_json: string }>(
      "SELECT manifest_json FROM blob_objects WHERE username = ? AND ledger_id = ? AND blob_id = ? AND state = 'available'",
      [username, ledgerId, blobId],
    );
    return row ? assertManifest(JSON.parse(row.manifest_json), this.maxBlobBytes) : undefined;
  }

  async chunk(username: string, ledgerId: string, blobId: string, index: number): Promise<Uint8Array | undefined> {
    const manifest = await this.manifest(username, ledgerId, blobId);
    const expected = manifest?.chunks[index];
    if (!manifest || !expected) return undefined;
    const path = join(this.objectDir('available', namespace(username, ledgerId), blobId), `${index}.chunk`);
    if (!existsSync(path)) return undefined;
    const contents = readFileSync(path);
    if (contents.byteLength !== expected.sizeBytes || sha256(contents) !== expected.ciphertextSha256) throw new Error('stored encrypted chunk is corrupt');
    return contents;
  }

  async remove(username: string, ledgerId: string, blobId: string): Promise<boolean> {
    await this.ready;
    if (!BLOB_ID.test(blobId)) throw new Error('invalid blob id');
    const row = await this.driver.get<{ namespace: string; created_at: string; manifest_json: string }>(
      "SELECT namespace, created_at, manifest_json FROM blob_objects WHERE username = ? AND ledger_id = ? AND blob_id = ? AND state = 'available'",
      [username, ledgerId, blobId],
    );
    if (!row) return false;
    const deletedAt = nowIso();
    const source = this.objectDir('available', row.namespace, blobId);
    const target = this.objectDir('trash', row.namespace, blobId);
    mkdirSync(dirname(target), { recursive: true });
    const catalog: ObjectCatalog = { username, ledgerId, blobId, state: 'trash', createdAt: row.created_at, deletedAt, manifest: JSON.parse(row.manifest_json) as BlobManifest };
    atomicJson(join(source, 'object.json'), catalog);
    if (existsSync(target)) rmSync(source, { recursive: true, force: true });
    else renameSync(source, target);
    await this.driver.run(
      "UPDATE blob_objects SET state = 'trash', deleted_at = ?, updated_at = ? WHERE username = ? AND ledger_id = ? AND blob_id = ?",
      [deletedAt, deletedAt, username, ledgerId, blobId],
    );
    return true;
  }

  async restore(username: string, ledgerId: string, blobId: string): Promise<boolean> {
    await this.ready;
    const row = await this.driver.get<{ namespace: string; created_at: string; manifest_json: string }>(
      "SELECT namespace, created_at, manifest_json FROM blob_objects WHERE username = ? AND ledger_id = ? AND blob_id = ? AND state = 'trash'",
      [username, ledgerId, blobId],
    );
    if (!row) return false;
    const source = this.objectDir('trash', row.namespace, blobId);
    const target = this.objectDir('available', row.namespace, blobId);
    mkdirSync(dirname(target), { recursive: true });
    const catalog: ObjectCatalog = { username, ledgerId, blobId, state: 'available', createdAt: row.created_at, manifest: JSON.parse(row.manifest_json) as BlobManifest };
    atomicJson(join(source, 'object.json'), catalog);
    if (existsSync(target)) rmSync(source, { recursive: true, force: true });
    else renameSync(source, target);
    await this.driver.run(
      "UPDATE blob_objects SET state = 'available', deleted_at = NULL, updated_at = ? WHERE username = ? AND ledger_id = ? AND blob_id = ?",
      [nowIso(), username, ledgerId, blobId],
    );
    return true;
  }

  /**
   * Verifies stored chunks in batches. Between batches the loop yields and checks
   * cancellation, so a long scan keeps login and synchronization responsive.
   */
  async verify(options: VerifyOptions = {}): Promise<BlobVerificationResult> {
    await this.ready;
    const result: BlobVerificationResult = { checkedObjects: 0, checkedChunks: 0, issues: [], cancelled: false };
    const clauses = ["(? = '' OR (username || '|' || blob_id) > ?)"];
    const scanParams: string[] = [options.resumeFrom ?? '', options.resumeFrom ?? ''];
    if (options.username) { clauses.push('username = ?'); scanParams.push(options.username); }
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT * FROM blob_objects WHERE ${clauses.join(' AND ')} ORDER BY username, blob_id`,
      scanParams,
    );
    const batchSize = Math.max(1, Math.min(500, Math.trunc(options.batchSize ?? 25)));
    // Inline by default: a caller without a worker pool still gets a correct verification.
    const hashChunk = options.hashChunk ?? ((path: string) => Promise.resolve(sha256(readFileSync(path))));
    await options.onProgress?.({ processed: 0, total: rows.length });
    for (const [position, row] of rows.entries()) {
      const username = String(row['username']);
      const blobId = String(row['blob_id']);
      result.lastKey = `${username}|${blobId}`;
      try {
        const state = String(row['state']) as 'available' | 'trash';
        const manifest = assertManifest(JSON.parse(String(row['manifest_json'])), this.maxBlobBytes);
        const directory = this.objectDir(state, String(row['namespace']), blobId);
        if (!catalogAt(directory)) throw new Error('object catalog is missing or invalid');
        for (const chunk of manifest.chunks) {
          const path = join(directory, `${chunk.index}.chunk`);
          if (!existsSync(path)) throw new Error(`chunk ${chunk.index} is missing`);
          result.checkedChunks += 1;
          // Size from `statSync`, not by reading the file: the hash is computed elsewhere, and
          // reading the whole chunk here would block the main thread for I/O that the hash already
          // needs — the same bytes read twice, once of them on the loop.
          if (statSync(path).size !== chunk.sizeBytes || await hashChunk(path) !== chunk.ciphertextSha256) throw new Error(`chunk ${chunk.index} checksum mismatch`);
        }
        result.checkedObjects += 1;
      } catch (error) {
        result.issues.push({ username, blobId, detail: error instanceof Error ? error.message : String(error) });
      }
      if ((position + 1) % batchSize !== 0) continue;
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
      await options.onProgress?.({ processed: position + 1, total: rows.length, ...(result.lastKey ? { lastKey: result.lastKey } : {}) });
      if (options.shouldCancel && await options.shouldCancel()) {
        result.cancelled = true;
        return result;
      }
    }
    await options.onProgress?.({ processed: rows.length, total: rows.length, ...(result.lastKey ? { lastKey: result.lastKey } : {}) });
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
    ];
    const composition: StorageComposition = {
      databaseBytes: fileSize(join(this.dataDir, 'server.sqlite')),
      walBytes: fileSize(join(this.dataDir, 'server.sqlite-wal')),
      shmBytes: fileSize(join(this.dataDir, 'server.sqlite-shm')),
      objectBytes: 0, objectCount: 0, trashBytes: 0, trashCount: 0, stagingBytes: 0, stagingCount: 0,
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
    const nowValue = now.toISOString();
    let removedObjects = 0;
    let removedUploads = 0;
    let freedBytes = 0;
    for (const completed of await this.driver.all<{ upload_id: string; namespace: string }>(
      `SELECT u.upload_id, u.namespace FROM blob_uploads u
       JOIN blob_objects o ON o.username = u.username AND o.ledger_id = u.ledger_id AND o.blob_id = u.blob_id`,
    )) {
      rmSync(this.uploadDir(completed.namespace, completed.upload_id), { recursive: true, force: true });
      await this.driver.run('DELETE FROM blob_upload_chunks WHERE upload_id = ?', [completed.upload_id]);
      await this.driver.run('DELETE FROM blob_uploads WHERE upload_id = ?', [completed.upload_id]);
      removedUploads += 1;
    }
    for (const upload of await this.driver.all<{ upload_id: string; namespace: string }>('SELECT upload_id, namespace FROM blob_uploads WHERE expires_at <= ?', [nowValue])) {
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
    for (const object of await this.driver.all<{ username: string; ledger_id: string; blob_id: string; namespace: string; cipher_bytes: number }>(
      "SELECT username, ledger_id, blob_id, namespace, cipher_bytes FROM blob_objects WHERE state = 'trash' AND deleted_at <= ?",
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
    await this.driver.close();
    if (this.ephemeral) rmSync(this.dataDir, { recursive: true, force: true });
  }
}
