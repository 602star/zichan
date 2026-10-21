import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { LedgerCryptoSession } from '@zichan/core';
import { openIdb } from '../src/db/idb.js';

const session: LedgerCryptoSession = {
  v: 1,
  ledgerId: 'lease-race-ledger',
  keyringId: 'lease-race-keyring',
  generation: 1,
  activeKeyId: 'key-1',
  dataKeys: new Map([['key-1', new Uint8Array(32).fill(1)]]),
  attachmentSecret: new Uint8Array(32).fill(2),
  backupSecret: new Uint8Array(32).fill(3),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser snapshot and fallback lease commit', () => {
  it('upgrades a version-one browser database without losing stored values', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const name = 'ledger-lease-upgrade';
    const oldDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = oldDatabase.transaction('kv', 'readwrite');
      transaction.objectStore('kv').put('existing-value', 'existing-key');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    oldDatabase.close();

    const upgraded = await openIdb(name);
    expect(upgraded.version).toBe(2);
    expect([...upgraded.objectStoreNames]).toEqual(['kv', 'lease']);
    upgraded.close();
    const { loadKv } = await import('../src/db/idb.js');
    expect(await loadKv('existing-key', name)).toBe('existing-value');
  });

  it('rejects a stale snapshot after another page takes an expired lease and saves', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.resetModules();
    const firstLock = await import('../src/db/browser-ledger-lock.js');
    const firstStorage = await import('../src/db/idb.js');
    const databaseName = 'ledger-snapshot-race';
    const lockName = 'ledger-snapshot-race-lock';
    const first = await firstLock.acquireBrowserLedgerLock(null, { databaseName, lockName, ownerId: 'first-page' });
    try {
      // This was the old save-time check. Pause the first page immediately afterward.
      await first.assertHeld();
      vi.spyOn(Date, 'now').mockReturnValue(1_000 + firstLock.BROWSER_LEDGER_LEASE_MS + 1);
      vi.resetModules(); // A second document has its own in-process lock queue.
      const secondLock = await import('../src/db/browser-ledger-lock.js');
      const secondStorage = await import('../src/db/idb.js');
      const second = await secondLock.acquireBrowserLedgerLock(null, { databaseName, lockName, ownerId: 'second-page' });
      try {
        await secondStorage.saveDbBytes(new Uint8Array([2]), session, databaseName, second.snapshotLease);
        await expect(firstStorage.saveDbBytes(new Uint8Array([1]), session, databaseName, first.snapshotLease))
          .rejects.toMatchObject({ name: 'BrowserLedgerAlreadyOpenError' });
        expect(await secondStorage.loadDbBytes(session, databaseName)).toEqual(new Uint8Array([2]));
      } finally {
        await second();
      }
    } finally {
      await first();
    }
  });
});
