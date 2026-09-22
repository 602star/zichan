import { randomBytes } from 'node:crypto';
import {
  decryptJson,
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
  /** Stable for the life of the session so repeat reads do not re-replay. */
  readonly ledgerId: string;
  /** The portable backup the console renders. Stays in this process. */
  readonly backup: LedgerBackup;
  readonly transactionCount: number;
  readonly attachmentCount: number;
  readonly commitCount: number;
  readonly createdAt: number;
  expiresAt: number;
  touchedAt: number;
}

export interface LedgerPreviewOptions {
  store: SyncServerStore;
  /**
   * The deployment custody key. Passed as a thunk because the server loads it while booting,
   * after the router that owns this registry is already constructed.
   */
  custodyKey: Buffer | (() => Buffer);
  serverId: string;
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
    return { backup, commitCount: rows.length, ledgerId: replica.ledgerId };
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
    const { backup, commitCount, ledgerId } = await buildLedgerBackup(
      this.options,
      username,
    );
    const now = this.now();

    // One live session per account: a second preview should not double the plaintext.
    for (const [id, existing] of this.sessions) {
      if (existing.username === username) this.sessions.delete(id);
    }

    const session: LedgerPreviewSession = {
      id: `preview-${randomBytes(24).toString('base64url')}`,
      username,
      ledgerId,
      backup,
      transactionCount: backup.transactions?.length ?? 0,
      attachmentCount: backup.attachments?.length ?? 0,
      commitCount,
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

  /** Drop a session and its plaintext now. */
  close(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** Live session count, after sweeping. */
  size(): number {
    this.sweep();
    return this.sessions.size;
  }

  /** Close everything; used on shutdown so nothing survives a restart. */
  clear(): void {
    this.sessions.clear();
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
        this.sessions.delete(id);
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
      this.sessions.delete(session.id);
    }
  }
}
