import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { accountDatabaseName, accountStorageKey } from '../src/account-storage.js';
import { claimLedgerLease, indexedDbLeaseBackend, releaseLedgerLease } from '../src/db/browser-ledger-lock.js';
import { withSharedBrowserTaskLock } from '../src/db/shared-browser-driver.js';

afterEach(() => vi.unstubAllGlobals());

describe('browser task lock without a SharedWorker connection', () => {
  it('uses Web Locks when available', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const request = vi.fn(async (_name: string, _options: unknown, callback: () => Promise<string>) => callback());
    vi.stubGlobal('navigator', { locks: { request } });
    await expect(withSharedBrowserTaskLock('backup', async () => 'finished')).resolves.toBe('finished');
    expect(request).toHaveBeenCalledWith('zichan-browser-task.backup', { mode: 'exclusive' }, expect.any(Function));
  });

  it('serializes overlapping backup tasks in the same page', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('navigator', {});
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const wait = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const first = withSharedBrowserTaskLock('backup', async () => {
      order.push('first-start');
      markFirstStarted();
      await wait;
      order.push('first-end');
    });
    const second = withSharedBrowserTaskLock('backup', async () => { order.push('second'); });
    try {
      await firstStarted;
      expect(order).toEqual(['first-start']);
    } finally {
      releaseFirst();
    }
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('waits for a lease held by another page', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('navigator', {});
    const backend = indexedDbLeaseBackend(accountDatabaseName(), accountStorageKey('zichan-browser-task.backup'));
    const version = await claimLedgerLease(backend, 'other-page', Date.now());
    expect(version).not.toBeNull();
    let entered = false;
    const task = withSharedBrowserTaskLock('backup', async () => { entered = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(false);
    await releaseLedgerLease(backend, 'other-page', version!);
    await task;
    expect(entered).toBe(true);
  });
});
