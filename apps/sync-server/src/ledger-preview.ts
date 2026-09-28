import { randomBytes } from 'node:crypto';
import {
  attachmentRemoteBlobId,
  decryptAttachmentChunk,
  decryptJson,
  deriveAttachmentCryptoContext,
  sha256Bytes,
  unlockLedgerKeyEnvelope,
  wireSyncCommit,
  type LedgerCryptoSession,
  type LedgerKeyEnvelope,
  type SyncCommitV2,
} from '@zichan/core';
import {
  applyPendingCommits,
  connectReplica,
  exportLedger,
  pullReplica,
  type CommitTransport,
  type LedgerBackup,
  type SyncReplicaIdentity,
} from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import { openCustodySecret } from './key-custody.js';
import {
  ServerStoreError,
  type StoredCommit,
  type SyncServerStore,
} from './store.js';

/** Structurally identical to the db package's PulledCommitRow, which is not re-exported. */
interface PulledCommitRow {
  seq: number;
  commit: SyncCommitV2;
  contentHash: string;
}

/**
 * Read-only view of one user's ledger, assembled in server memory.
 *
 * The operator's custody key plus the account's sealed secret unlock the ledger key
 * envelope, which decrypts the stored commits. Those commits are replayed into a
 * throwaway in-memory database and exported as the portable backup the web client
 * already knows how to render, so the preview reuses the real ledger UI.
 *
 * Nothing here is durable: the plaintext lives in this process only, and the session
 * entry disappears on expiry or eviction. No file is opened, so no plaintext reaches
 * the server's disk.
 */

export interface LedgerPreviewSession {
  readonly id: string;
  readonly username: string;
  readonly attachmentUsernames: readonly string[];
  /** Stable for the life of the session so repeat reads do not re-replay. */
  readonly ledgerId: string;
  /** The portable backup the console renders. Stays in this process. */
  readonly backup: LedgerBackup;
  readonly transactionCount: number;
  readonly attachmentCount: number;
  readonly commitCount: number;
  /**
   * The unlocked ledger key material, kept only so attachments can still be decrypted.
   *
   * The backup carries attachment *metadata* but never the bytes, so a preview that dropped this
   * on the way out could list a user's files and open none of them — a preview that looks
   * complete and is not.
   */
  readonly crypto: LedgerCryptoSession;
  /** Bounded cache of decrypted files, oldest evicted first, so re-opening one is not a re-download. */
  readonly attachments: Map<string, DecryptedPreviewAttachment>;
  createdAt: number;
  expiresAt: number;
  touchedAt: number;
}

/** One decrypted attachment body, held in memory until the session ends or the cache evicts it. */
export interface DecryptedPreviewAttachment {
  readonly bytes: Buffer;
  readonly fileName: string;
  readonly mimeType: string;
}

/**
 * The chunk layout of one stored attachment, as the blob store describes it.
 *
 * Declared structurally rather than imported from the blob store so this kernel does not depend
 * on that module; the server's `BlobManifest` satisfies it as-is.
 */
export interface PreviewBlobManifest {
  readonly blobId: string;
  readonly chunkCount: number;
  readonly chunks: readonly {
    readonly index: number;
    readonly sizeBytes: number;
    readonly ciphertextSha256: string;
    readonly iv: string;
  }[];
}

/**
 * How many decrypted files one preview keeps. Small on purpose: this is plaintext a person is
 * looking at, not a library, and the whole session is meant to be short-lived.
 */
export const PREVIEW_ATTACHMENT_CACHE_LIMIT = 8;

export interface LedgerPreviewOptions {
  store: SyncServerStore;
  /**
   * The deployment custody key. Passed as a thunk because the server loads it while booting,
   * after the router that owns this registry is already constructed.
   */
  custodyKey: Buffer | (() => Buffer);
  serverId: string;
  /**
   * Reads one encrypted attachment chunk straight from the blob store.
   *
   * Injected rather than imported so the preview kernel stays independent of where the bytes
   * live; the server passes `blobStore.chunk`, and a test can pass a map.
   */
  readChunk?: (routing: {
    username: string;
    ledgerId: string;
    blobId: string;
    index: number;
  }) => Promise<Uint8Array | undefined>;
  /** Reads an attachment's encrypted manifest, or undefined when the store has no such object. */
  readManifest?: (routing: {
    username: string;
    ledgerId: string;
    blobId: string;
  }) => Promise<PreviewBlobManifest | undefined>;
  /** Sliding window: each read pushes expiry forward. */
  idleTtlMs?: number;
  /** Hard ceiling: a busy session still dies. */
  absoluteTtlMs?: number;
  /** Session table ceiling; oldest are evicted first. */
  maxSessions?: number;
  now?: () => number;
}

export const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_ABSOLUTE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_SESSIONS = 32;

/** Pull page size while draining the commit log. */
const PULL_PAGE_SIZE = 200;

/**
 * Commits are stored encrypted; replay needs plaintext. This transport decrypts each
 * string on the way through, then hands the commits to the shared replica machinery
 * so preview reuses the exact apply path a real client uses.
 */
function decryptingTransport(
  options: LedgerPreviewOptions,
  session: LedgerCryptoSession,
  ledgerId: string,
  rows: StoredCommit[],
): CommitTransport {
  const serverId = options.serverId;
  const replicaId = `${serverId}-preview`;
  const streamEpoch = `${serverId}-preview-epoch`;
  const decrypted: PulledCommitRow[] = [];

  return {
    // The commits are already in hand; the pull below just replays the decrypted page.
    connect: async (boundLedgerId: string) => {
      if (boundLedgerId !== ledgerId)
        throw new Error(`同步服务器绑定的是其他账本：${boundLedgerId}`);
      return {
        serverId,
        replicaId,
        streamEpoch,
        ledgerId,
        headSeq: rows.at(-1)?.seq ?? 0,
      };
    },
    pullCommits: async (
      _identity: SyncReplicaIdentity,
      afterSeq: number,
      limit = PULL_PAGE_SIZE,
    ) => {
      const pending = rows.filter((row) => row.seq > afterSeq);
      const page = pending.slice(0, limit);
      for (const row of page) {
        decrypted.push({
          seq: row.seq,
          contentHash: row.contentHash,
          commit: await decryptCommit(session, ledgerId, row),
        });
      }
      const headSeq = rows.at(-1)?.seq ?? 0;
      const nextSeq = page.at(-1)?.seq ?? afterSeq;
      return {
        commits: decrypted.filter((row) => row.seq > afterSeq),
        nextSeq,
        headSeq,
        hasMore: nextSeq < headSeq,
      };
    },
    pushCommits: async () => {
      // A preview never writes back.
      throw new Error('预览会话是只读的，不会向服务器回传提交');
    },
  };
}

/**
 * Decrypt one stored commit.
 *
 * The ciphertext is bound to its ledger, id and content hash, so the context has to
 * match the writer's exactly or authentication fails ('Cipher job failed').
 */
async function decryptCommit(
  session: LedgerCryptoSession,
  ledgerId: string,
  row: StoredCommit,
): Promise<SyncCommitV2> {
  const plaintext = await decryptJson<SyncCommitV2>(
    session,
    row.encCommit as never,
    {
      protocol: 2,
      ledgerId,
      commitId: row.commitId,
      contentHash: row.contentHash,
    },
  );
  return wireSyncCommit(plaintext);
}

/**
 * Replay the account's commits into a throwaway database and export the backup the
 * web client renders.
 *
 * Broken deliberately in the one place that matters: `openLedger` is called with no
 * `filename`, so the database is `:memory:` and no plaintext is written to disk.
 */
export async function buildLedgerBackup(
  options: LedgerPreviewOptions,
  username: string,
): Promise<{
  backup: LedgerBackup;
  commitCount: number;
  ledgerId: string;
  crypto: LedgerCryptoSession;
  /** The account's stored spelling, which is what the blob store namespaces objects under. */
  username: string;
}> {
  const { store, serverId } = options;
  const custodyKey = typeof options.custodyKey === 'function' ? options.custodyKey() : options.custodyKey;
  const user = await store.getUser(username);
  if (!user) throw new ServerStoreError('UNKNOWN_USER', 404, '账号不存在');

  const custody = await store.getLedgerProtection(user.username);
  if (custody?.mode !== 'managed' || !custody.sealedSecret) {
    throw new ServerStoreError(
      'NOT_CUSTODIED',
      409,
      '该账号不是托管模式，服务器无法解密',
    );
  }
  const replica = await store.getReplica(user.username);
  if (!replica)
    throw new ServerStoreError('REPLICA_UNBOUND', 409, '该账号还没有绑定账本');
  const envelope = await store.getKeyEnvelope(user.username, replica.ledgerId);
  if (!envelope)
    throw new ServerStoreError('ENVELOPE_MISSING', 409, '该账号缺少账本密钥包');

  const custodyScope = `${serverId}:${user.accountId}`;
  const secretValue = openCustodySecret(
    custodyKey,
    custodyScope,
    custody.sealedSecret,
  );
  const session = await unlockLedgerKeyEnvelope(
    secretValue,
    envelope as unknown as LedgerKeyEnvelope,
  );

  const rows = await listAllCommits(store, user.username);

  // Replay into a throwaway in-memory database. Passing no filename is what keeps the
  // plaintext off disk; do not add one.
  const ledger = await openLedger();
  try {
    // The preview database is empty, so it starts on a random id. Point it at the
    // account's ledger first, or the replica handshake rejects the mismatch.
    await ledger.adoptLedgerId(replica.ledgerId);
    const transport = decryptingTransport(
      options,
      session,
      replica.ledgerId,
      rows,
    );
    const connection = await connectReplica(ledger, transport);
    await pullReplica(ledger, transport, connection);
    await applyPendingCommits(ledger);
    const backup = await exportLedger(ledger);
    return {
      backup,
      commitCount: rows.length,
      ledgerId: replica.ledgerId,
      crypto: session,
      username: user.username,
    };
  } finally {
    await ledger.close().catch(() => undefined);
  }
}

/**
 * Drain the commit log.
 *
 * The log is paginated by sequence, so a single page silently truncates the ledger and
 * the preview would show wrong totals instead of failing. Loop until the payload stops
 * advancing.
 */
async function listAllCommits(
  store: SyncServerStore,
  username: string,
): Promise<StoredCommit[]> {
  const all: StoredCommit[] = [];
  let cursor = 0;
  for (;;) {
    const page = await store.listCommits(username, cursor, PULL_PAGE_SIZE);
    all.push(...page.commits);
    if (!page.hasMore || page.commits.length === 0) break;
    cursor = page.nextSeq;
  }
  return all;
}

/**
 * Decrypt one attachment body from the server's own encrypted blob store.
 *
 * The operator's console never holds the user's ledger key, so the file has to be opened here and
 * handed over as plaintext. Two properties matter:
 *
 * - The blob id is *derived*, never taken from the caller. A caller-supplied id would let a
 *   crafted request pull any object in the store; deriving it from the session means the request
 *   can only ever name something this ledger can already decrypt.
 * - The plaintext is verified against the `sha256` the ledger recorded. Content addressing is what
 *   makes the result trustworthy — an authenticated chunk that hashes to the right value is the
 *   user's file, not merely a file that decrypted.
 */
export async function decryptPreviewAttachment(
  options: LedgerPreviewOptions,
  session: LedgerPreviewSession,
  sha256: string,
): Promise<DecryptedPreviewAttachment> {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ServerStoreError('INVALID_ATTACHMENT', 400, '附件校验和无效');
  }
  const cached = session.attachments.get(sha256);
  if (cached) {
    // Refresh recency so the eviction order stays least-recently-used.
    session.attachments.delete(sha256);
    session.attachments.set(sha256, cached);
    return cached;
  }

  const record = findAttachmentRecord(session.backup, sha256);
  if (!record) {
    throw new ServerStoreError('ATTACHMENT_NOT_FOUND', 404, '这个账号的账本里没有该附件');
  }

  const readChunk = options.readChunk;
  const readManifest = options.readManifest;
  if (!readChunk || !readManifest) {
    throw new ServerStoreError('ATTACHMENT_UNAVAILABLE', 409, '当前部署没有接入附件存储，无法下载');
  }

  // Blob storage uses the authenticated account spelling; crypto uses the device's
  // original spelling. Never substitute one for the other, even with NOCASE SQL.
  let resolved: { context: Awaited<ReturnType<typeof deriveAttachmentCryptoContext>>; blobId: string; manifest: PreviewBlobManifest } | undefined;
  for (const username of session.attachmentUsernames) {
    for (const attachmentSecret of [session.crypto.attachmentSecret, ...(session.crypto.retiredAttachmentSecrets ?? [])]) {
      const context = await deriveAttachmentCryptoContext({ ...session.crypto, attachmentSecret }, {
        serverId: options.serverId, ledgerId: session.ledgerId, username,
      });
      const blobId = await attachmentRemoteBlobId(context, sha256);
      const manifest = await readManifest({ username: session.username, ledgerId: session.ledgerId, blobId });
      if (manifest) { resolved = { context, blobId, manifest }; break; }
    }
    if (resolved) break;
  }
  if (!resolved) {
    throw new ServerStoreError('ATTACHMENT_MISSING', 404, '服务器上没有这份附件的正文，或上传时使用了不同的用户名大小写；请用上传时的用户名原串重新打开预览');
  }
  const { context, blobId, manifest } = resolved;
  if (manifest.blobId !== blobId || manifest.chunkCount !== manifest.chunks.length
    || manifest.chunks.some((chunk, index) => chunk.index !== index)) {
    throw new ServerStoreError('ATTACHMENT_CORRUPT', 502, '附件分块清单无效');
  }

  const parts: Buffer[] = [];
  for (const meta of manifest.chunks) {
    const ciphertext = await readChunk({
      username: session.username,
      ledgerId: session.ledgerId,
      blobId,
      index: meta.index,
    });
    if (!ciphertext) {
      throw new ServerStoreError('ATTACHMENT_MISSING', 404, `附件密文分块 ${meta.index} 不在服务器上`);
    }
    if (ciphertext.byteLength !== meta.sizeBytes || await sha256Bytes(ciphertext) !== meta.ciphertextSha256) {
      throw new ServerStoreError('ATTACHMENT_CORRUPT', 502, `附件密文分块 ${meta.index} 校验失败`);
    }
    const plaintext = await decryptAttachmentChunk(
      context,
      sha256,
      { index: meta.index, iv: meta.iv, ciphertext, ciphertextSha256: meta.ciphertextSha256 },
      manifest.chunkCount,
      record.sizeBytes,
    );
    parts.push(Buffer.from(plaintext));
  }

  const bytes = Buffer.concat(parts);
  if (bytes.byteLength !== record.sizeBytes || await sha256Bytes(bytes) !== sha256) {
    throw new ServerStoreError('ATTACHMENT_CORRUPT', 502, '附件解密后与账本记录的校验和不一致');
  }

  const decrypted: DecryptedPreviewAttachment = {
    bytes,
    fileName: record.fileName,
    mimeType: record.mimeType,
  };
  session.attachments.set(sha256, decrypted);
  for (const key of session.attachments.keys()) {
    if (session.attachments.size <= PREVIEW_ATTACHMENT_CACHE_LIMIT) break;
    session.attachments.delete(key);
  }
  return decrypted;
}

/** The ledger's own row for an attachment body or its thumbnail. */
function findAttachmentRecord(
  backup: LedgerBackup,
  sha256: string,
): { fileName: string; mimeType: string; sizeBytes: number } | undefined {
  for (const value of backup.attachments ?? []) {
    const row = value as Partial<{
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
      thumbnailSha256: string;
      thumbnailSizeBytes: number;
      thumbnailMimeType: string;
    }> | null;
    if (!row || typeof row !== 'object') continue;
    if (row.sha256 === sha256 && typeof row.sizeBytes === 'number') {
      return {
        fileName: row.fileName ?? sha256.slice(0, 12),
        mimeType: row.mimeType ?? 'application/octet-stream',
        sizeBytes: row.sizeBytes,
      };
    }
    if (row.thumbnailSha256 === sha256 && typeof row.thumbnailSizeBytes === 'number') {
      return {
        fileName: `${row.fileName ?? sha256.slice(0, 12)}（缩略图）`,
        mimeType: row.thumbnailMimeType ?? 'image/jpeg',
        sizeBytes: row.thumbnailSizeBytes,
      };
    }
  }
  return undefined;
}

/**
 * In-memory preview sessions.
 *
 * Entries are dropped on expiry, on eviction, or when the process exits. There is no
 * persistence layer by design: a restart must not resurrect a decrypted ledger.
 */
export class LedgerPreviewRegistry {
  private readonly sessions = new Map<string, LedgerPreviewSession>();
  private readonly idleTtlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(private readonly options: LedgerPreviewOptions) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.absoluteTtlMs = options.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.now = options.now ?? Date.now;
  }

  /** Open a preview for one account, replacing any existing session for that account. */
  async open(
    username: string,
    operatorUsername: string,
  ): Promise<LedgerPreviewSession> {
    this.sweep();
    const { backup, commitCount, ledgerId, crypto, username: storedUsername } = await buildLedgerBackup(
      this.options,
      username,
    );
    const now = this.now();

    // One live session per account: a second preview should not double the plaintext.
    for (const [id, existing] of this.sessions) {
      if (existing.username === storedUsername) this.close(id);
    }

    const session: LedgerPreviewSession = {
      id: `preview-${randomBytes(24).toString('base64url')}`,
      username: storedUsername,
      attachmentUsernames: [...new Set([storedUsername, storedUsername.toLowerCase(), username.trim()])],
      ledgerId,
      backup,
      transactionCount: backup.transactions?.length ?? 0,
      attachmentCount: backup.attachments?.length ?? 0,
      commitCount,
      crypto,
      attachments: new Map(),
      createdAt: now,
      touchedAt: now,
      expiresAt: now + this.idleTtlMs,
    };
    this.sessions.set(session.id, session);
    this.evictOverflow();
    void operatorUsername;
    return session;
  }

  /** Read a session, sliding its expiry forward. Returns undefined once it is gone. */
  read(id: string): LedgerPreviewSession | undefined {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const now = this.now();
    session.touchedAt = now;
    session.expiresAt = Math.min(
      now + this.idleTtlMs,
      session.createdAt + this.absoluteTtlMs,
    );
    return session;
  }

  /**
   * The live session for one account, if any — without creating one.
   *
   * Opening decrypts a ledger and is therefore an audited act requiring a fresh login. A caller
   * that only wants to know whether a preview is already open must not be able to trigger that
   * decryption as a side effect, or a plain page load would become an unaudited read.
   */
  find(username: string): LedgerPreviewSession | undefined {
    this.sweep();
    for (const session of this.sessions.values()) {
      if (session.username.toLowerCase() === username.toLowerCase()) return this.read(session.id);
    }
    return undefined;
  }

  /** Drop a session and its plaintext now. */
  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    // Remove cached files even if an in-flight request still holds the session object.
    // This releases cache references; it does not securely erase buffers from process memory.
    session.attachments.clear();
    return this.sessions.delete(id);
  }

  /**
   * Decrypt one attachment of a live session.
   *
   * Returns undefined when the session is gone, and throws for a session that exists but cannot
   * serve the file — the difference matters to the caller: the first means "reopen the preview",
   * the second means "this particular file is not available", and collapsing them would report a
   * missing file as an expired preview.
   */
  async decryptAttachment(
    id: string,
    sha256: string,
  ): Promise<{ session: LedgerPreviewSession; file: DecryptedPreviewAttachment } | undefined> {
    const session = this.read(id);
    if (!session) return undefined;
    const file = await decryptPreviewAttachment(this.options, session, sha256);
    if (this.read(id) !== session) {
      session.attachments.clear();
      return undefined;
    }
    return { session, file };
  }

  /** Live session count, after sweeping. */
  size(): number {
    this.sweep();
    return this.sessions.size;
  }

  /** Close everything; used on shutdown so nothing survives a restart. */
  clear(): void {
    for (const id of this.sessions.keys()) this.close(id);
  }

  /** Remaining lifetime in ms, or 0 once expired. */
  remainingMs(id: string): number {
    const session = this.sessions.get(id);
    if (!session) return 0;
    const absoluteDeadline = session.createdAt + this.absoluteTtlMs;
    const deadline = Math.min(session.expiresAt, absoluteDeadline);
    return Math.max(0, deadline - this.now());
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      // Either clock can end a session: idle expiry, or the absolute ceiling a busy
      // session would otherwise outlive.
      if (
        now >= session.expiresAt ||
        now >= session.createdAt + this.absoluteTtlMs
      ) {
        this.close(id);
      }
    }
  }

  private evictOverflow(): void {
    if (this.sessions.size <= this.maxSessions) return;
    const ordered = [...this.sessions.values()].sort(
      (a, b) => a.touchedAt - b.touchedAt,
    );
    for (const session of ordered.slice(
      0,
      this.sessions.size - this.maxSessions,
    )) {
      this.close(session.id);
    }
  }
}
