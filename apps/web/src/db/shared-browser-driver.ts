import { newId, type LedgerCryptoSession } from '@zichan/core';
import { SerialTaskQueue, type SqlDriver, type SqlParam, type SqlRunResult } from '@zichan/db';
import { accountDatabaseName, accountStorageKey } from '../account-storage.js';
import { isTauriRuntime } from '../tauri.js';
import {
  assertLedgerLease, BROWSER_LEDGER_LEASE_MS, BROWSER_LEDGER_LOCK_NAME,
  BrowserLedgerAlreadyOpenError, claimLedgerLease, indexedDbLeaseBackend,
  releaseLedgerLease, renewLedgerLease,
} from './browser-ledger-lock.js';
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
  if (state.closed) return Promise.reject(new Error('账本连接已关闭，请刷新页面'));
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
let fallbackTaskTail = Promise.resolve();

function queueFallbackTask<T>(operation: () => Promise<T>): Promise<T> {
  const task = fallbackTaskTail.then(operation, operation);
  fallbackTaskTail = task.then(() => undefined, () => undefined);
  return task;
}

async function withIndexedDbTaskLock<T>(taskName: string, operation: () => Promise<T>): Promise<T> {
  const backend = indexedDbLeaseBackend(accountDatabaseName(), accountStorageKey(`zichan-browser-task.${taskName}`));
  const owner = newId();
  let version: number | null = null;
  while (version === null) {
    version = await claimLedgerLease(backend, owner, Date.now());
    if (version === null) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const heldVersion = version;
  let lost = false;
  const timer = setInterval(() => {
    void renewLedgerLease(backend, owner, heldVersion, Date.now())
      .then((held) => { if (!held) lost = true; })
      .catch(() => { lost = true; });
  }, Math.floor(BROWSER_LEDGER_LEASE_MS / 3));
  try {
    const result = await operation();
    if (lost || !await assertLedgerLease(backend, owner, heldVersion)) {
      throw new BrowserLedgerAlreadyOpenError('浏览器备份任务锁已失效，请刷新后重试');
    }
    return result;
  } finally {
    clearInterval(timer);
    await releaseLedgerLease(backend, owner, heldVersion);
  }
}

/** Serialize browser-wide work that combines SQL with network or attachment I/O. */
export async function withSharedBrowserTaskLock<T>(taskName: string, operation: () => Promise<T>): Promise<T> {
  const state = activeConnection;
  if (!state || state.closed) return queueFallbackTask(() => {
    if (isTauriRuntime() || !globalThis.indexedDB) return operation();
    const locks = globalThis.navigator?.locks;
    if (locks) return locks.request<Promise<T>>(accountStorageKey(`zichan-browser-task.${taskName}`), { mode: 'exclusive' }, operation)
      .then((result) => result);
    return withIndexedDbTaskLock(taskName, operation);
  });
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
    port.onmessageerror = () => rejectPending(state, new Error('账本通信失败，请刷新页面'));
    worker.onerror = () => rejectPending(state, new Error('账本进程停止，请刷新页面'));
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
        rejectPending(this.state, new Error('账本连接已关闭'));
        this.state.port.close();
      }
    });
  }

  private operation<T>(task: () => Promise<T>): Promise<T> {
    return this.txId ? task() : this.state.queue.run(task);
  }
}
