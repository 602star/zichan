import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { decryptBackupBytes, decryptJson, encryptBackupBytes, unlockLedgerKeyEnvelope, wireSyncCommit,
  type LedgerKeyEnvelope } from '@zichan/core';
import { applyPendingCommits, checkConsistency, connectReplica, createLedgerStore, CURRENT_SCHEMA_VERSION,
  ledgerOpenContext, MAX_LEDGER_OPEN_BYTES, pullReplica, type CommitTransport, type LedgerOpenSnapshot, type SqlDriver } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { openCustodySecret } from './key-custody.js';
import { ServerStoreError, type SyncServerStore } from './store.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const fingerprint = (snapshot: LedgerOpenSnapshot) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

/** Historical replay must yield to HTTP requests, including inside SQL transactions. */
function cooperativeDriver(driver: SqlDriver): SqlDriver {
  let lastYield = performance.now();
  const work = async <T>(operation: () => Promise<T>): Promise<T> => {
    const value = await operation();
    if (performance.now() - lastYield > 8) { await yieldToRequests(); lastYield = performance.now(); }
    return value;
  };
  return {
    exec: sql => work(() => driver.exec(sql)),
    run: (sql, params) => work(() => driver.run(sql, params)),
    all: <R>(sql: string, params?: Parameters<SqlDriver['all']>[1]) => work(() => driver.all<R>(sql, params)),
    get: <R>(sql: string, params?: Parameters<SqlDriver['get']>[1]) => work(() => driver.get<R>(sql, params)),
    transaction: fn => driver.transaction(transaction => fn(cooperativeDriver(transaction))),
    close: () => driver.close(),
  };
}

/** A single bounded builder; only authenticated, compressed ciphertext is persisted. */
export class LedgerOpenSnapshots {
  private flight = Promise.resolve();
  private queued = new Set<string>();
  private dirty = new Set<string>();
  private stopped = false;
  private validated = new Map<string, string>();
  private failed = new Set<string>();
  constructor(private options: { store: SyncServerStore; serverId: string; directory: string;
    custodyKey: () => Buffer; onError: (error: unknown) => void }) {}

  private file(username: string): string {
    return join(this.options.directory, `${createHash('sha256').update(username).digest('hex')}.json`);
  }

  schedule(username: string): void {
    if (this.stopped) return;
    if (this.queued.has(username)) { this.dirty.add(username); return; }
    this.queued.add(username);
    this.flight = this.flight.then(async () => {
      try { if (!this.stopped) { await this.build(username); this.failed.delete(username); } }
      catch (error) { this.failed.add(username); this.options.onError(error); }
      finally {
        this.queued.delete(username);
        if (this.dirty.delete(username)) this.schedule(username);
      }
    });
  }

  async warm(): Promise<void> {
    for (const username of await this.options.store.ledgerOpenCandidates()) this.schedule(username);
  }

  async drain(): Promise<void> {
    for (;;) { const current = this.flight; await current; if (current === this.flight) return; }
  }
  async close(): Promise<void> { this.stopped = true; await this.drain(); }

  private async saved(username: string): Promise<LedgerOpenSnapshot | undefined> {
    try { return JSON.parse(await readFile(this.file(username), 'utf8')) as LedgerOpenSnapshot; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.onError(error); return undefined; }
  }

  async read(username: string, replicaId: string): Promise<LedgerOpenSnapshot | undefined> {
    const { store, serverId } = this.options;
    const [user, replica, selected] = await Promise.all([
      store.getUser(username), store.getReplica(username, replicaId), store.getReplica(username),
    ]);
    if (!user || !replica || selected?.replicaId !== replicaId) throw new ServerStoreError('SNAPSHOT_REPLICA_MISMATCH', 409, '快照不属于当前账号账本');
    const envelope = await store.getKeyEnvelope(username, replica.ledgerId, 'account', replicaId);
    const saved = await this.saved(username);
    const m = saved?.manifest;
    const valid = m?.version === 1 && m.schemaVersion === CURRENT_SCHEMA_VERSION && m.serverId === serverId
      && m.accountId === user.accountId && m.ledgerId === replica.ledgerId && m.replicaId === replicaId
      && m.streamEpoch === replica.streamEpoch && m.generation === envelope?.['generation']
      && m.keyringId === envelope?.['keyringId'] && m.headSeq <= replica.headSeq;
    const ready = valid && this.validated.get(username) === fingerprint(saved!);
    if (!ready || m!.headSeq < replica.headSeq) this.schedule(username);
    if (!ready && this.failed.has(username)) throw new ServerStoreError('SNAPSHOT_PREPARATION_FAILED', 503, '账本快照准备失败，请管理员检查快照任务后重试');
    return ready ? saved : undefined;
  }

  private async build(username: string): Promise<void> {
    const { store, serverId } = this.options;
    const user = await store.getUser(username);
    const replica = await store.getReplica(username);
    const protection = await store.getLedgerProtection(username);
    if (!user || user.disabled || !replica || replica.headSeq === 0 || protection?.mode !== 'managed' || !protection.sealedSecret) return;
    const envelope = await store.getKeyEnvelope(username, replica.ledgerId) as unknown as LedgerKeyEnvelope | undefined;
    if (!envelope) return;
    const previous = await this.saved(username);
    const old = previous?.manifest;
    let reusable = old?.version === 1 && old.schemaVersion === CURRENT_SCHEMA_VERSION && old.serverId === serverId
      && old.accountId === user.accountId && old.ledgerId === replica.ledgerId && old.replicaId === replica.replicaId
      && old.streamEpoch === replica.streamEpoch && old.generation === envelope.generation
      && old.keyringId === envelope.keyringId && old.headSeq <= replica.headSeq;
    if (reusable && old!.headSeq === replica.headSeq && this.validated.get(username) === fingerprint(previous!)) return;
    const secret = openCustodySecret(this.options.custodyKey(), `${serverId}:${user.accountId}`, protection.sealedSecret);
    const crypto = await unlockLedgerKeyEnvelope(secret, envelope);
    let driver = new NodeSqliteDriver();
    try {
      if (reusable) {
        try {
          const compressed = await decryptBackupBytes(crypto, previous!.payload, ledgerOpenContext(old!));
          const bytes = await decompress(compressed, { maxOutputLength: MAX_LEDGER_OPEN_BYTES });
          if (bytes.length !== old!.plainBytes || createHash('sha256').update(bytes).digest('hex') !== old!.sha256) throw new Error('服务器快照完整性验证失败');
          await driver.importBytes(bytes);
          this.validated.set(username, fingerprint(previous!));
        } catch (error) {
          this.options.onError(error);
          await driver.close(); driver = new NodeSqliteDriver(); reusable = false;
        }
      }
      const ledger = await createLedgerStore(cooperativeDriver(driver), { deviceId: 'server-open-snapshot' });
      if (reusable && old!.headSeq === replica.headSeq) return;
      if (!reusable) await ledger.adoptLedgerId(replica.ledgerId);
      const identity = { serverId, ledgerId: replica.ledgerId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch, headSeq: replica.headSeq };
      const transport: CommitTransport = {
        connect: async () => identity,
        pullCommits: async (_identity, after, limit = 200) => {
          await yieldToRequests();
          const page = await store.listCommits(username, after, limit, 'account', replica.replicaId);
          const rows = page.commits.filter(row => row.seq <= replica.headSeq);
          const commits = [];
          for (const row of rows) commits.push({ seq: row.seq, contentHash: row.contentHash,
            commit: wireSyncCommit(await decryptJson(crypto, row.encCommit as never,
              { protocol: 2, ledgerId: replica.ledgerId, commitId: row.commitId, contentHash: row.contentHash })) });
          const nextSeq = rows.at(-1)?.seq ?? after;
          if (nextSeq === after && after < replica.headSeq) throw new Error('快照构建发现不完整提交流');
          return { commits, nextSeq, headSeq: replica.headSeq, hasMore: nextSeq < replica.headSeq };
        },
        pushCommits: async () => { throw new Error('快照构建禁止推送提交'); },
      };
      const connected = await connectReplica(ledger, transport);
      await pullReplica(ledger, transport, connected);
      const result = await applyPendingCommits(ledger);
      if (result.invalid || result.pending || (await ledger.listSyncCommits({ state: 'invalid', includeInvalid: true })).length) throw new Error('快照包含无效或缺失依赖的提交');
      if ((await checkConsistency(ledger)).length) throw new Error('快照账本一致性检查失败');
      // Conflicts remain in the database for the user's normal conflict UI.
      const bytes = await driver.exportBytes();
      if (bytes.length > MAX_LEDGER_OPEN_BYTES) throw new Error('快照超过浏览器打开大小上限');
      const manifest: LedgerOpenSnapshot['manifest'] = { version: 1, schemaVersion: CURRENT_SCHEMA_VERSION,
        serverId, accountId: user.accountId, ledgerId: replica.ledgerId, replicaId: replica.replicaId,
        streamEpoch: replica.streamEpoch, headSeq: replica.headSeq, keyringId: envelope.keyringId,
        generation: envelope.generation, plainBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      const payload = await encryptBackupBytes(crypto, await compress(bytes), ledgerOpenContext(manifest));
      const current = await store.getReplica(username);
      const currentEnvelope = await store.getKeyEnvelope(username, replica.ledgerId);
      if (current?.replicaId !== replica.replicaId || current.streamEpoch !== replica.streamEpoch
        || currentEnvelope?.['generation'] !== envelope.generation) return;
      if (current.headSeq > replica.headSeq) this.dirty.add(username);
      await mkdir(this.options.directory, { recursive: true });
      const temporary = `${this.file(username)}.${randomBytes(8).toString('hex')}.tmp`;
      const snapshot = { manifest, payload };
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(temporary, this.file(username));
      this.validated.set(username, fingerprint(snapshot));
    } finally { await driver.close(); }
  }
}
