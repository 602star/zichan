import { describe, expect, it, vi } from 'vitest';
import { D, newId, type Transaction } from '@zichan/core';
import {
  assertCurrentSchema,
  createLedgerStore,
  CURRENT_SCHEMA_NAME,
  CURRENT_SCHEMA_VERSION,
  runMigrations,
  saveTransaction,
} from '@zichan/db';
import { createLogger, nullSink } from '@zichan/logger';
import { SqlJsDriver } from '../src/db/sqljs-driver.js';

const log = createLogger({ level: 'error', sinks: [nullSink()] });

function base() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

function transaction(id: string, amount: string): Transaction {
  return {
    ...base(),
    id,
    date: '2026-08-01',
    type: 'expense',
    category: 'food',
    amount,
    assetId: 'CNY',
    accountId: 'bank',
    recordState: 'active',
    reportingTreatment: 'ordinary',
  } as Transaction;
}

describe('SqlJsDriver', () => {
  it('runs schema 116 and the exact-money Dashboard SQL contract in real sql.js', async () => {
    const driver = await SqlJsDriver.open(null);
    expect(await runMigrations(driver, log)).toBe(1);
    await expect(assertCurrentSchema(driver)).resolves.toBeUndefined();
    expect(await driver.all('SELECT version, name FROM schema_migrations')).toEqual([{
      version: CURRENT_SCHEMA_VERSION,
      name: CURRENT_SCHEMA_NAME,
    }]);

    const store = await createLedgerStore(driver, { logger: log });
    await store.assets.put({
      ...base(), id: 'CNY', code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, isActive: true,
    } as never);
    await store.accounts.put({
      ...base(), id: 'bank', name: 'Bank', kind: 'bank', isActive: true,
    } as never);
    await store.categories.put({
      ...base(), id: 'expense-root', name: '支出', type: 'expense', isActive: true,
    } as never);
    await store.categories.put({
      ...base(), id: 'food', name: '餐饮', type: 'expense', parentId: 'expense-root', isActive: true,
    } as never);
    await saveTransaction(store, transaction('amount-low', '9007199254740992.01'));
    await saveTransaction(store, transaction('amount-fixed', '9007199254740992.02'));
    await saveTransaction(store, transaction('amount-exponent', '9.00719925474099202e+15'));

    const exact = await store.transactionBrowsePage({
      advanced: { groups: [{ conditions: [{
        field: 'amount', op: 'eq', value: '09007199254740992.0200',
      }] }] },
    });
    expect(new Set(exact.transactions.map((row) => row.id))).toEqual(
      new Set(['amount-fixed', 'amount-exponent']),
    );

    const dashboard = await store.dashboardTransactionReadModel({ activityLimit: 2 });
    const amounts = dashboard.balanceAggregates.find((row) => row.assetId === 'CNY')?.amounts ?? [];
    expect([...amounts].sort()).toEqual([
      '-9007199254740992.01',
      '-9007199254740992.02',
      '-9007199254740992.02',
    ].sort());
    expect(amounts.reduce((total, amount) => total.plus(amount), D(0)).toString())
      .toBe('-27021597764222976.05');
    expect(dashboard.reportAggregates.flatMap((row) => row.amounts).sort()).toEqual([
      '9007199254740992.01',
      '9007199254740992.02',
      '9007199254740992.02',
    ].sort());
    expect(dashboard.recentTransactions).toHaveLength(2);
    await store.close();
  });

  it('serializes root operations around a rolled-back transaction', async () => {
    const driver = await SqlJsDriver.open(null);
    await driver.exec('CREATE TABLE entries (value TEXT NOT NULL)');
    let releaseFailure!: () => void;
    let markFailureReady!: () => void;
    const failureMayContinue = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const failureReady = new Promise<void>((resolve) => { markFailureReady = resolve; });

    const failed = driver.transaction(async (transaction) => {
      await transaction.run('INSERT INTO entries(value) VALUES (?)', ['will roll back']);
      markFailureReady();
      await failureMayContinue;
      throw new Error('planned rollback');
    }).catch((error: unknown) => error);
    await failureReady;
    let outsideWriteFinished = false;
    const outsideWrite = driver.run('INSERT INTO entries(value) VALUES (?)', ['must survive'])
      .then(() => { outsideWriteFinished = true; });
    await Promise.resolve();
    expect(outsideWriteFinished).toBe(false);

    releaseFailure();
    expect(await failed).toBeInstanceOf(Error);
    await outsideWrite;
    expect(await driver.all<{ value: string }>('SELECT value FROM entries')).toEqual([{ value: 'must survive' }]);
    await driver.close();
  });

  it('exports browser snapshots only after a transaction commits', async () => {
    const snapshots: Uint8Array[] = [];
    const driver = await SqlJsDriver.open(null, (bytes) => snapshots.push(bytes));
    await driver.exec('CREATE TABLE entries (value TEXT NOT NULL)');
    expect(snapshots).toHaveLength(1);

    let releaseCommit!: () => void;
    let markWriteReady!: () => void;
    const commitMayContinue = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const writeReady = new Promise<void>((resolve) => { markWriteReady = resolve; });
    const transaction = driver.transaction(async (scope) => {
      await scope.run('INSERT INTO entries(value) VALUES (?)', ['committed']);
      markWriteReady();
      await commitMayContinue;
    });
    await writeReady;
    expect(snapshots).toHaveLength(1);

    releaseCommit();
    await transaction;
    expect(snapshots).toHaveLength(2);
    await driver.close();
  });

  it('waits for each asynchronous IndexedDB write before starting the next root operation', async () => {
    let releaseFirstPersist!: () => void;
    let markFirstPersistStarted!: () => void;
    const firstPersistMayFinish = new Promise<void>((resolve) => { releaseFirstPersist = resolve; });
    const firstPersistStarted = new Promise<void>((resolve) => { markFirstPersistStarted = resolve; });
    let persistCalls = 0;
    let activePersists = 0;
    let maxActivePersists = 0;
    const driver = await SqlJsDriver.open(null, async () => {
      persistCalls += 1;
      activePersists += 1;
      maxActivePersists = Math.max(maxActivePersists, activePersists);
      if (persistCalls === 1) {
        markFirstPersistStarted();
        await firstPersistMayFinish;
      }
      activePersists -= 1;
    });

    const create = driver.exec('CREATE TABLE entries (value TEXT NOT NULL)');
    await firstPersistStarted;
    let insertFinished = false;
    const insert = driver.run('INSERT INTO entries(value) VALUES (?)', ['newest'])
      .then(() => { insertFinished = true; });
    await Promise.resolve();
    expect(insertFinished).toBe(false);

    releaseFirstPersist();
    await Promise.all([create, insert]);
    expect(persistCalls).toBe(2);
    expect(maxActivePersists).toBe(1);
    await driver.close();
  });

  it('releases its browser lifetime lock exactly once when closed', async () => {
    const onClose = vi.fn().mockResolvedValue(undefined);
    const driver = await SqlJsDriver.open(null, undefined, onClose);
    await driver.close();
    await driver.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not rewrite a rejected legacy snapshot after read-only schema inspection', async () => {
    const legacySnapshots: Uint8Array[] = [];
    const legacy = await SqlJsDriver.open(null, (bytes) => legacySnapshots.push(bytes.slice()));
    await legacy.exec('CREATE TABLE legacy_assets (id TEXT PRIMARY KEY, amount TEXT NOT NULL)');
    await legacy.run('INSERT INTO legacy_assets (id, amount) VALUES (?, ?)', ['old', '123.45']);
    await legacy.close();
    const original = legacySnapshots.at(-1)!;

    const rejectedWrites: Uint8Array[] = [];
    const rejected = await SqlJsDriver.open(original, (bytes) => rejectedWrites.push(bytes.slice()));
    await expect(createLedgerStore(rejected, { logger: log })).rejects.toThrow('重置本地开发数据');
    await rejected.close();

    expect(rejectedWrites).toHaveLength(0);
  });
});
