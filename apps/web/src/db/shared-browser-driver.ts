import { newId, type LedgerCryptoSession } from '@zichan/core';
import { SerialTaskQueue, type SqlDriver, type SqlParam, type SqlRunResult } from '@zichan/db';
import { accountDatabaseName, accountStorageKey } from '../account-storage.js';
import { BROWSER_LEDGER_LOCK_NAME, BrowserLedgerAlreadyOpenError } from './browser-ledger-lock.js';
import LedgerWorker from './browser-ledger-worker.ts?sharedworker';

type Operation = 'open' | 'close' | 'exec' | 'run' | 'all' | 'get' | 'begin' | 'commit' | 'rollback' | 'task-lock' | 'task-unlock';
type Request = {
  id: number;
  op: Operation;
  sql?: string;
  params?: SqlParam[];
  txId?: string;
  parentTxId?: string;
  scope?: { databaseName: string; lockName: string };
  cryptoSession?: LedgerCryptoSession;
  taskName?: string;
  taskToken?: string;
};
type Reply = { id: number; ok: true; value?: unknown } | { id: number; ok: false; error: { name: string; message: string } };

interface ConnectionState {
  worker: SharedWorker;
  port: MessagePort;
  queue: SerialTaskQueue;
  nextRequest: number;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  listeners: Set<() => void>;
  pendingChange: boolean;
  closed: boolean;
  onPageHide: () => void;
  onPageShow: (event: PageTransitionEvent) => void;
}

function request<T>(state: ConnectionState, data: Omit<Request, 'id'>): Promise<T> {
  if (state.closed) return Promise.reject(new Error('共享账本连接已关闭，请刷新页面'));
  const id = ++state.nextRequest;
  return new Promise<T>((resolve, reject) => {
    state.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    try { state.port.postMessage({ ...data, id }); }
    catch (error) {
      state.pending.delete(id);
      reject(error);
    }
  });
}

function rejectPending(state: ConnectionState, reason: Error): void {
  for (const pending of state.pending.values()) pending.reject(reason);
  state.pending.clear();
}

let activeConnection: ConnectionState | null = null;

/** Serialize browser-wide work that combines SQL with network or attachment I/O. */
export async function withSharedBrowserTaskLock<T>(taskName: string, operation: () => Promise<T>): Promise<T> {
  const state = activeConnection;
  if (!state || state.closed) return operation();
  const taskToken = newId();
  await request(state, { op: 'task-lock', taskName, taskToken });
  try { return await operation(); }
  finally { await request(state, { op: 'task-unlock', taskName, taskToken }); }
}

export class SharedBrowserSqlDriver implements SqlDriver {
  private readonly nestedQueue = new SerialTaskQueue();

  private constructor(private readonly state: ConnectionState, private readonly txId?: string) {}

  static async open(cryptoSession: LedgerCryptoSession): Promise<SharedBrowserSqlDriver> {
    const databaseName = accountDatabaseName();
    const worker = new LedgerWorker({ name: databaseName });
    const port = worker.port;
    const state: ConnectionState = {
      worker, port, queue: new SerialTaskQueue(), nextRequest: 0, pending: new Map(),
      listeners: new Set(), pendingChange: false, closed: false,
      onPageHide: () => undefined, onPageShow: () => undefined,
    };
    state.onPageHide = () => {
      if (state.closed) return;
      state.closed = true;
      rejectPending(state, new Error('账本页面已关闭'));
      try { port.postMessage({ id: ++state.nextRequest, op: 'close' }); } catch { /* The worker is already gone. */ }
      port.close();
    };
    state.onPageShow = (event) => { if (event.persisted && state.closed) window.location.reload(); };
    window.addEventListener('pagehide', state.onPageHide);
    window.addEventListener('pageshow', state.onPageShow);
    port.onmessage = (event: MessageEvent<Reply | { event: 'changed' }>) => {
      const message = event.data;
      if ('event' in message) {
        if (message.event === 'changed') {
          if (state.listeners.size === 0) state.pendingChange = true;
          else for (const listener of state.listeners) listener();
        }
        return;
      }
      const pending = state.pending.get(message.id);
      if (!pending) return;
      state.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else {
        const error = message.error.name === 'BrowserLedgerAlreadyOpenError'
          ? new BrowserLedgerAlreadyOpenError(message.error.message)
          : new Error(message.error.message);
        pending.reject(error);
      }
    };
    port.onmessageerror = () => rejectPending(state, new Error('共享账本通信失败，请刷新页面'));
    worker.onerror = () => rejectPending(state, new Error('共享账本进程停止，请刷新页面'));
    port.start();
    try {
      await request(state, {
        op: 'open', cryptoSession,
        scope: { databaseName, lockName: accountStorageKey(BROWSER_LEDGER_LOCK_NAME) },
      });
      activeConnection = state;
      return new SharedBrowserSqlDriver(state);
    } catch (error) {
      state.closed = true;
      window.removeEventListener('pagehide', state.onPageHide);
      window.removeEventListener('pageshow', state.onPageShow);
      port.close();
      throw error;
    }
  }

  subscribeChanges(listener: () => void): () => void {
    this.state.listeners.add(listener);
    if (this.state.pendingChange) {
      this.state.pendingChange = false;
      queueMicrotask(listener);
    }
    return () => this.state.listeners.delete(listener);
  }

  exec(sql: string): Promise<void> {
    return this.operation(() => request<void>(this.state, { op: 'exec', sql, txId: this.txId }));
  }

  run(sql: string, params: SqlParam[] = []): Promise<SqlRunResult> {
    return this.operation(() => request<SqlRunResult>(this.state, { op: 'run', sql, params, txId: this.txId }));
  }

  all<R = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<R[]> {
    return this.operation(() => request<R[]>(this.state, { op: 'all', sql, params, txId: this.txId }));
  }

  get<R = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<R | undefined> {
    return this.operation(() => request<R | undefined>(this.state, { op: 'get', sql, params, txId: this.txId }));
  }

  transaction<T>(fn: (driver: SqlDriver) => Promise<T>): Promise<T> {
    const run = async () => {
      const txId = newId();
      await request(this.state, { op: 'begin', txId, parentTxId: this.txId });
      try {
        const result = await fn(new SharedBrowserSqlDriver(this.state, txId));
        await request(this.state, { op: 'commit', txId });
        return result;
      } catch (error) {
        await request(this.state, { op: 'rollback', txId }).catch(() => undefined);
        throw error;
      }
    };
    return this.txId ? this.nestedQueue.run(run) : this.state.queue.run(run);
  }

  async close(): Promise<void> {
    if (this.txId) return;
    await this.state.queue.run(async () => {
      if (this.state.closed) return;
      try { await request(this.state, { op: 'close' }); }
      finally {
        this.state.closed = true;
        window.removeEventListener('pagehide', this.state.onPageHide);
        window.removeEventListener('pageshow', this.state.onPageShow);
        if (activeConnection === this.state) activeConnection = null;
        rejectPending(this.state, new Error('共享账本连接已关闭'));
        this.state.port.close();
      }
    });
  }

  private operation<T>(task: () => Promise<T>): Promise<T> {
    return this.txId ? task() : this.state.queue.run(task);
  }
}
