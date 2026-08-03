import { describe, expect, it } from 'vitest';
import { SqlJsDriver } from '../src/db/sqljs-driver.js';

describe('SqlJsDriver', () => {
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
});
