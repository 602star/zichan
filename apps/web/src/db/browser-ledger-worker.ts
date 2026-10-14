import type { LedgerCryptoSession } from '@zichan/core';
import { TABLES, type SqlDriver, type SqlParam } from '@zichan/db';
import { acquireBrowserLedgerLock } from './browser-ledger-lock.js';
import { loadDbBytes, saveDbBytes } from './idb.js';
import { SqlJsDriver } from './sqljs-driver.js';

type Request = {
  id: number;
  op: 'open' | 'close' | 'exec' | 'run' | 'all' | 'get' | 'begin' | 'commit' | 'rollback' | 'task-lock' | 'task-unlock';
  sql?: string;
  params?: SqlParam[];
  txId?: string;
  parentTxId?: string;
  scope?: { databaseName: string; lockName: string; ownerId?: string };
  cryptoSession?: LedgerCryptoSession;
  taskName?: string;
  taskToken?: string;
};

type Reply = { id: number; ok: true; value?: unknown } | { id: number; ok: false; error: { name: string; message: string } };
type WorkerHost = typeof globalThis & { onconnect: ((event: MessageEvent & { ports: MessagePort[] }) => void) | null };

interface SharedDatabase {
  driver: SqlJsDriver;
  databaseName: string;
  ledgerId: string;
  keyringId: string;
}

interface TransactionSession {
  port: MessagePort;
  driver: SqlDriver;
  parentTxId?: string;
  visibleChange: boolean;
  finish: (error?: Error) => void;
  flight: Promise<unknown>;
}

const ports = new Set<MessagePort>();
const transactions = new Map<string, TransactionSession>();
const taskLocks = new Map<string, { holder: { port: MessagePort; token: string }; waiting: { port: MessagePort; requestId: number; token: string }[] }>();
let database: SharedDatabase | null = null;
let opening: Promise<SharedDatabase> | null = null;
let closing: Promise<void> | null = null;

const visibleTables = new Set(Object.values(TABLES).map((table) => table.name));

function changesVisibleData(sql: string): boolean {
  return sql.split(';').some((statement) => {
    const match = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["'`]?([a-z_][a-z0-9_]*)/i.exec(statement);
    return match ? visibleTables.has(match[1]!.toLowerCase()) : /^\s*WITH\b/i.test(statement);
  });
}

function recordVisibleChange(port: MessagePort, txId: string | undefined, sql: string): void {
  if (!changesVisibleData(sql)) return;
  if (txId === undefined) broadcastChange(port);
  else requireTransaction(port, txId).visibleChange = true;
}

function reply(port: MessagePort, response: Reply): void {
  port.postMessage(response);
}

function fail(port: MessagePort, id: number, reason: unknown): void {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  reply(port, { id, ok: false, error: { name: error.name, message: error.message } });
}

function broadcastChange(source: MessagePort): void {
  for (const port of ports) {
    if (port !== source) port.postMessage({ event: 'changed' });
  }
}

function acquireTaskLock(port: MessagePort, request: Request): void {
  if (!ports.has(port) || !request.taskName || !request.taskToken) throw new Error('共享任务锁连接无效');
  const current = taskLocks.get(request.taskName);
  if (!current) {
    taskLocks.set(request.taskName, { holder: { port, token: request.taskToken }, waiting: [] });
    reply(port, { id: request.id, ok: true });
    return;
  }
  current.waiting.push({ port, requestId: request.id, token: request.taskToken });
}

function releaseTaskLock(port: MessagePort, name: string | undefined, token: string | undefined): void {
  if (!name || !token) throw new Error('共享任务锁编号无效');
  const current = taskLocks.get(name);
  if (!current || current.holder.port !== port || current.holder.token !== token) throw new Error('共享任务锁已失效');
  const next = current.waiting.shift();
  if (next) {
    current.holder = { port: next.port, token: next.token };
    reply(next.port, { id: next.requestId, ok: true });
  } else taskLocks.delete(name);
}

async function openDatabase(request: Request): Promise<SharedDatabase> {
  const scope = request.scope;
  const session = request.cryptoSession;
  if (!scope || !session) throw new Error('缺少浏览器账本连接信息');
  if (closing) await closing;
  if (database) {
    if (database.databaseName !== scope.databaseName || database.ledgerId !== session.ledgerId || database.keyringId !== session.keyringId) {
      throw new Error('此共享数据库连接属于另一份账本');
    }
    return database;
  }
  if (opening) {
    const current = await opening;
    if (current.databaseName !== scope.databaseName || current.ledgerId !== session.ledgerId || current.keyringId !== session.keyringId) {
      throw new Error('此共享数据库连接属于另一份账本');
    }
    return current;
  }
  opening = (async () => {
    const release = await acquireBrowserLedgerLock(undefined, { ...scope, ownerId: 'shared-worker' });
    try {
      const bytes = await loadDbBytes(session, scope.databaseName);
      const driver = await SqlJsDriver.open(bytes, async (next) => {
        await release.assertHeld();
        await saveDbBytes(next, session, scope.databaseName);
      }, release);
      return { driver, databaseName: scope.databaseName, ledgerId: session.ledgerId, keyringId: session.keyringId };
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
  })();
  try {
    database = await opening;
    return database;
  } finally {
    opening = null;
  }
}

function requireTransaction(port: MessagePort, txId: string | undefined): TransactionSession {
  const transaction = txId === undefined ? undefined : transactions.get(txId);
  if (!transaction || transaction.port !== port) throw new Error('账本事务已失效，请重试操作');
  return transaction;
}

function beginTransaction(port: MessagePort, request: Request): void {
  if (!database || request.txId === undefined) throw new Error('账本数据库尚未打开');
  if (!ports.has(port)) throw new Error('共享账本连接尚未打开');
  if (transactions.has(request.txId)) throw new Error('账本事务编号重复');
  const base = request.parentTxId === undefined
    ? database.driver
    : requireTransaction(port, request.parentTxId).driver;
  let started = false;
  let finish!: (error?: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    finish = (error) => error ? reject(error) : resolve();
  });
  const flight = base.transaction(async (scoped) => {
    started = true;
    transactions.set(request.txId!, { port, driver: scoped, parentTxId: request.parentTxId, visibleChange: false, finish, flight });
    reply(port, { id: request.id, ok: true });
    await completed;
  });
  void flight.catch((error) => { if (!started) fail(port, request.id, error); });
}

async function finishTransaction(port: MessagePort, request: Request, rollback: boolean): Promise<void> {
  const transaction = requireTransaction(port, request.txId);
  transaction.finish(rollback ? new Error('事务已回滚') : undefined);
  try {
    await transaction.flight;
    if (!rollback && transaction.visibleChange) {
      if (transaction.parentTxId === undefined) broadcastChange(port);
      else requireTransaction(port, transaction.parentTxId).visibleChange = true;
    }
  } catch (error) {
    if (!rollback) throw error;
  } finally {
    transactions.delete(request.txId!);
  }
}

async function closePort(port: MessagePort): Promise<void> {
  const pendingTransactions: Promise<unknown>[] = [];
  for (const transaction of transactions.values()) {
    if (transaction.port === port) {
      transaction.finish(new Error('账本页面已关闭'));
      pendingTransactions.push(transaction.flight.catch(() => undefined));
    }
  }
  for (const [id, transaction] of transactions) if (transaction.port === port) transactions.delete(id);
  ports.delete(port);
  for (const [name, lock] of taskLocks) {
    lock.waiting = lock.waiting.filter((waiting) => waiting.port !== port);
    if (lock.holder.port === port) releaseTaskLock(port, name, lock.holder.token);
  }
  if (ports.size === 0 && database) {
    const previous = database;
    database = null;
    const closeFlight = (async () => {
      await Promise.all(pendingTransactions);
      await previous.driver.close();
    })();
    closing = closeFlight;
    try { await closeFlight; }
    finally { if (closing === closeFlight) closing = null; }
  }
}

async function dispatch(port: MessagePort, request: Request): Promise<unknown> {
  if (request.op === 'open') {
    await openDatabase(request);
    ports.add(port);
    return undefined;
  }
  if (!ports.has(port) || !database) throw new Error('共享账本连接已关闭，请刷新页面');
  if (request.op === 'close') return closePort(port);
  if (request.op === 'task-unlock') return releaseTaskLock(port, request.taskName, request.taskToken);
  if (request.op === 'commit' || request.op === 'rollback') return finishTransaction(port, request, request.op === 'rollback');
  const driver = request.txId === undefined ? database.driver : requireTransaction(port, request.txId).driver;
  if (request.op === 'exec') {
    await driver.exec(request.sql ?? '');
    recordVisibleChange(port, request.txId, request.sql ?? '');
    return undefined;
  }
  if (request.op === 'run') {
    const result = await driver.run(request.sql ?? '', request.params);
    if (result.changes > 0) recordVisibleChange(port, request.txId, request.sql ?? '');
    return result;
  }
  if (request.op === 'all') return driver.all(request.sql ?? '', request.params);
  if (request.op === 'get') return driver.get(request.sql ?? '', request.params);
  throw new Error('未知的账本数据库操作');
}

(globalThis as WorkerHost).onconnect = (event) => {
  const port = event.ports[0];
  if (!port) return;
  port.onmessage = (message: MessageEvent<Request>) => {
    const request = message.data;
    if (!request || typeof request.id !== 'number') return;
    if (request.op === 'begin') {
      try { beginTransaction(port, request); } catch (error) { fail(port, request.id, error); }
      return;
    }
    if (request.op === 'task-lock') {
      try { acquireTaskLock(port, request); } catch (error) { fail(port, request.id, error); }
      return;
    }
    void dispatch(port, request).then(
      (value) => {
        reply(port, { id: request.id, ok: true, value });
        if (request.op === 'close') port.close();
      },
      (error) => fail(port, request.id, error),
    );
  };
  port.start();
};
