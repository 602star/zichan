import { accountDatabaseName, accountStorageKey } from '../account-storage.js';
import { BrowserLedgerAlreadyOpenError } from './browser-ledger-error.js';
import { LEDGER_LEASE_STORE, openIdb, type LedgerSnapshotLease } from './idb.js';
export { BrowserLedgerAlreadyOpenError } from './browser-ledger-error.js';

export const BROWSER_LEDGER_LOCK_NAME = 'zichan-browser-ledger.sqlite';

interface BrowserLockManager {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: object | null) => Promise<void>,
  ): Promise<void>;
}

let localLeaseTail: Promise<void> | null = null;

/**
 * The lease this document currently holds, if any. A reload tears the document down
 * without running the release path, so the new document would otherwise be locked
 * out by its own predecessor's still-fresh heartbeat.
 */
let heldIndexedDbLease: { backend: LedgerLeaseBackend; owner: string; version: number } | null = null;
let pageHideReleaseWired = false;

function wirePageHideRelease(): void {
  if (pageHideReleaseWired) return;
  pageHideReleaseWired = true;
  const target = globalThis as unknown as { addEventListener?: (type: string, listener: () => void) => void };
  target.addEventListener?.('pagehide', () => {
    const lease = heldIndexedDbLease;
    if (!lease) return;
    heldIndexedDbLease = null;
    // Best effort: free the lease so a reload or a closed tab does not leave a
    // fresh heartbeat behind. The TTL still covers a crashed document.
    void releaseLedgerLease(lease.backend, lease.owner, lease.version).catch(() => undefined);
  });
}

/**
 * A cross-tab lease record. `version` increments on every ownership change, so a
 * document that lost its lease to another tab can be detected even after the same
 * `owner` value would otherwise look current.
 */
export interface BrowserLedgerLeaseState {
  owner: string;
  version: number;
  heartbeat: number;
}

/**
 * Run `work` inside one serialized read-write transaction over the single lease
 * record. IndexedDB serializes overlapping read-write transactions on one store,
 * which is what makes the read-then-write below a real cross-tab mutual exclusion
 * rather than a best-effort check. `work` must stay synchronous: awaiting a
 * non-IndexedDB promise would auto-commit and close the transaction.
 */
export interface LedgerLeaseBackend {
  transact<T>(
    work: (state: BrowserLedgerLeaseState | undefined) => { next?: BrowserLedgerLeaseState | null; result: T },
  ): Promise<T>;
}

/** A lease older than this is treated as abandoned by a crashed or frozen tab. */
export const BROWSER_LEDGER_LEASE_MS = 15_000;

/** Claim the lease, returning the new version, or null when another tab holds it. */
export async function claimLedgerLease(
  backend: LedgerLeaseBackend,
  owner: string,
  now: number,
  leaseMs = BROWSER_LEDGER_LEASE_MS,
): Promise<number | null> {
  return backend.transact((state) => {
    const held = !!state && state.owner !== '' && state.heartbeat + leaseMs > now;
    // A fresh lease held by a *different* tab blocks us. A fresh lease held by this
    // same tab is our own earlier document (a reload), which we may take over here;
    // the advanced version then makes that previous document fail its save-time
    // lease check, so it can never overwrite the newer snapshot.
    if (held && state!.owner !== owner) return { result: null };
    const version = (state?.version ?? 0) + 1;
    return { next: { owner, version, heartbeat: now }, result: version };
  });
}

/** True only while this document still owns the exact claimed version. */
export async function assertLedgerLease(
  backend: LedgerLeaseBackend,
  owner: string,
  version: number,
): Promise<boolean> {
  return backend.transact((state) => ({ result: !!state && state.owner === owner && state.version === version }));
}

export async function renewLedgerLease(
  backend: LedgerLeaseBackend,
  owner: string,
  version: number,
  now: number,
): Promise<boolean> {
  return backend.transact((state) => (state && state.owner === owner && state.version === version
    ? { next: { ...state, heartbeat: now }, result: true }
    : { result: false }));
}

export async function releaseLedgerLease(
  backend: LedgerLeaseBackend,
  owner: string,
  version: number,
): Promise<void> {
  // Mark the lease free instead of deleting the record so `version` keeps moving
  // forward; a document that lost the lease can then never look current again.
  await backend.transact((state) => (state && state.owner === owner && state.version === version
    ? { next: { owner: '', version, heartbeat: 0 }, result: undefined }
    : { result: undefined }));
}

function leaseOwnerId(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const LEASE_TAB_KEY = 'zichan.ledgerLease.tab.v1';

/**
 * Identity of this *browsing context*, stable across a reload because sessionStorage
 * survives one while staying invisible to other tabs. That is exactly what separates
 * "my own previous document" (takeover is safe) from "another tab" (must be blocked).
 */
function ledgerLeaseTabId(): string {
  try {
    const storage = globalThis.sessionStorage;
    const existing = storage?.getItem(LEASE_TAB_KEY);
    if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
    const created = leaseOwnerId();
    storage?.setItem(LEASE_TAB_KEY, created);
    return created;
  } catch {
    // Storage can be blocked; then a reload simply falls back to TTL expiry.
    return leaseOwnerId();
  }
}

function indexedDbLeaseBackend(databaseName = accountDatabaseName(), recordKey = accountStorageKey(BROWSER_LEDGER_LOCK_NAME)): LedgerLeaseBackend {
  return {
    async transact<T>(work: (state: BrowserLedgerLeaseState | undefined) => { next?: BrowserLedgerLeaseState | null; result: T }): Promise<T> {
      const database = await openIdb(databaseName);
      try {
        return await new Promise<T>((resolve, reject) => {
          const transaction = database.transaction(LEDGER_LEASE_STORE, 'readwrite');
          const store = transaction.objectStore(LEDGER_LEASE_STORE);
          const read = store.get(recordKey);
          let outcome: { next?: BrowserLedgerLeaseState | null; result: T } | undefined;
          read.onerror = () => reject(read.error);
          read.onsuccess = () => {
            outcome = work(read.result as BrowserLedgerLeaseState | undefined);
            if (outcome.next === null) store.delete(recordKey);
            else if (outcome.next) store.put(outcome.next, recordKey);
          };
          transaction.oncomplete = () => resolve(outcome!.result);
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => reject(transaction.error);
        });
      } finally { database.close(); }
    },
  };
}

/** The release callable also exposes `assertHeld` for save-time lease checks. */
export type BrowserLedgerLeaseHandle = (() => Promise<void>) & {
  assertHeld: () => Promise<void>;
  snapshotLease: LedgerSnapshotLease | null;
};

async function acquireWebLockLease(
  manager: BrowserLockManager,
  lockName = accountStorageKey(BROWSER_LEDGER_LOCK_NAME),
): Promise<{ release: () => Promise<void>; assertHeld: () => Promise<void>; snapshotLease: LedgerSnapshotLease | null }> {
  let acquiredSettled = false;
  let resolveAcquired!: (value: boolean) => void;
  let rejectAcquired!: (reason: unknown) => void;
  let releaseHold: (() => void) | undefined;
  let requestError: unknown;
  const acquired = new Promise<boolean>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const requestFlight = Promise.resolve().then(() => manager.request(
    lockName,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) {
        acquiredSettled = true;
        resolveAcquired(false);
        return;
      }
      await new Promise<void>((resolve) => {
        releaseHold = resolve;
        acquiredSettled = true;
        resolveAcquired(true);
      });
    },
  )).catch((error: unknown) => {
    requestError = error;
    if (!acquiredSettled) {
      acquiredSettled = true;
      rejectAcquired(error);
    }
  });

  const lockAcquired = await acquired;
  if (!lockAcquired) {
    await requestFlight;
    throw new BrowserLedgerAlreadyOpenError();
  }

  let released = false;
  return {
    snapshotLease: null,
    // A held Web Lock cannot be taken over, so the lease always still holds.
    async assertHeld(): Promise<void> {},
    async release(): Promise<void> {
      if (released) return;
      released = true;
      releaseHold?.();
      await requestFlight;
      if (requestError) throw requestError;
    },
  };
}

async function acquireIndexedDbLease(databaseName?: string, lockName?: string, ownerId?: string): Promise<{ release: () => Promise<void>; assertHeld: () => Promise<void>; snapshotLease: LedgerSnapshotLease }> {
  if (typeof globalThis.indexedDB?.open !== 'function') {
    throw new Error('当前浏览器既不支持 Web Locks 也无法使用 IndexedDB，无法建立跨标签页账本锁。请升级浏览器或使用桌面版。');
  }
  const backend = indexedDbLeaseBackend(databaseName, lockName);
  const owner = ownerId ?? ledgerLeaseTabId();
  const version = await claimLedgerLease(backend, owner, Date.now());
  if (version === null) throw new BrowserLedgerAlreadyOpenError();
  heldIndexedDbLease = { backend, owner, version };
  wirePageHideRelease();

  let heartbeatLost = false;
  const timer = setInterval(() => {
    void renewLedgerLease(backend, owner, version, Date.now())
      .then((renewed) => { if (!renewed) heartbeatLost = true; })
      .catch(() => { heartbeatLost = true; });
  }, Math.floor(BROWSER_LEDGER_LEASE_MS / 3));
  (timer as unknown as { unref?: () => void }).unref?.();

  let released = false;
  return {
    snapshotLease: { recordKey: lockName ?? accountStorageKey(BROWSER_LEDGER_LOCK_NAME), owner, version, leaseMs: BROWSER_LEDGER_LEASE_MS },
    async assertHeld(): Promise<void> {
      if (heartbeatLost) throw new BrowserLedgerAlreadyOpenError();
      if (!await assertLedgerLease(backend, owner, version)) throw new BrowserLedgerAlreadyOpenError();
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (heldIndexedDbLease?.owner === owner) heldIndexedDbLease = null;
      await releaseLedgerLease(backend, owner, version);
    },
  };
}

/**
 * Hold one exclusive cross-tab lease for the complete lifetime of the in-memory
 * sql.js store. sql.js persists a whole encrypted SQLite snapshot, so concurrent
 * tabs must never load and later overwrite independent copies of the same
 * database.
 *
 * Web Locks is preferred, but it is also a secure-context-only API. Where the
 * browser withholds it, an IndexedDB lease takes over instead of skipping the lock.
 */
export async function acquireBrowserLedgerLock(
  providedManager: BrowserLockManager | null | undefined = (
    typeof navigator === 'undefined'
      ? undefined
      : navigator.locks as unknown as BrowserLockManager | undefined
  ),
  scope?: { databaseName: string; lockName: string; ownerId?: string },
): Promise<BrowserLedgerLeaseHandle> {
  const previousLocalLease = localLeaseTail;
  let resolveLocalLease!: () => void;
  const currentLocalLease = new Promise<void>((resolve) => { resolveLocalLease = resolve; });
  localLeaseTail = currentLocalLease;
  if (previousLocalLease) await previousLocalLease;

  let handle: { release: () => Promise<void>; assertHeld: () => Promise<void>; snapshotLease: LedgerSnapshotLease | null };
  try {
    handle = providedManager
      ? await acquireWebLockLease(providedManager, scope?.lockName)
      : await acquireIndexedDbLease(scope?.databaseName, scope?.lockName, scope?.ownerId);
  } catch (error) {
    if (localLeaseTail === currentLocalLease) localLeaseTail = null;
    resolveLocalLease();
    throw error;
  }

  let finished = false;
  const lease = (async () => {
    if (finished) return;
    finished = true;
    try {
      await handle.release();
    } finally {
      if (localLeaseTail === currentLocalLease) localLeaseTail = null;
      resolveLocalLease();
    }
  }) as BrowserLedgerLeaseHandle;
  lease.assertHeld = () => handle.assertHeld();
  lease.snapshotLease = handle.snapshotLease;
  return lease;
}
