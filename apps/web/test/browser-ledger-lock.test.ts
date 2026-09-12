import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireBrowserLedgerLock,
  assertLedgerLease,
  BrowserLedgerAlreadyOpenError,
  BROWSER_LEDGER_LEASE_MS,
  claimLedgerLease,
  releaseLedgerLease,
  renewLedgerLease,
  type BrowserLedgerLeaseState,
} from '../src/db/browser-ledger-lock.js';

/** In-memory LedgerLeaseBackend; one shared object stands in for one IDB store. */
function memoryLeaseBackend() {
  let state: BrowserLedgerLeaseState | undefined;
  return {
    async transact<T>(
      work: (current: BrowserLedgerLeaseState | undefined) => { next?: BrowserLedgerLeaseState | null; result: T },
    ): Promise<T> {
      const outcome = work(state);
      if (outcome.next === null) state = undefined;
      else if (outcome.next) state = outcome.next;
      return outcome.result;
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

class FakeLockManager {
  held = false;
  requests = 0;

  async request(
    _name: string,
    options: { ifAvailable: true },
    callback: (lock: object | null) => Promise<void>,
  ): Promise<void> {
    this.requests += 1;
    if (options.ifAvailable && this.held) {
      await callback(null);
      return;
    }
    this.held = true;
    try {
      await callback({});
    } finally {
      this.held = false;
    }
  }
}

describe('browser ledger lifetime lock', () => {
  it('rejects when another tab already owns the browser lock', async () => {
    const manager = new FakeLockManager();
    manager.held = true;
    await expect(acquireBrowserLedgerLock(manager)).rejects.toBeInstanceOf(BrowserLedgerAlreadyOpenError);
    manager.held = false;
    const releaseSecond = await acquireBrowserLedgerLock(manager);
    await releaseSecond();
  });

  it('serializes StrictMode reopen attempts inside one browser document', async () => {
    const manager = new FakeLockManager();
    const releaseFirst = await acquireBrowserLedgerLock(manager);
    const second = acquireBrowserLedgerLock(manager);
    await Promise.resolve();
    expect(manager.requests).toBe(1);
    await releaseFirst();
    const releaseSecond = await second;
    expect(manager.requests).toBe(2);
    await releaseSecond();
  });

  it('lets the same tab reclaim its own lease after a reload', async () => {
    const backend = memoryLeaseBackend();
    expect(await claimLedgerLease(backend, 'tab-a', 1_000)).toBe(1);
    // Reload: same browsing context, so takeover is allowed and the version advances.
    expect(await claimLedgerLease(backend, 'tab-a', 1_050)).toBe(2);
    // The document that owned version 1 can no longer write its stale snapshot.
    expect(await assertLedgerLease(backend, 'tab-a', 1)).toBe(false);
    expect(await assertLedgerLease(backend, 'tab-a', 2)).toBe(true);
    // A genuinely different tab is still refused while the lease is fresh.
    expect(await claimLedgerLease(backend, 'tab-b', 1_060)).toBeNull();
  });

  it('fails closed when neither Web Locks nor IndexedDB can provide a cross-tab lock', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(acquireBrowserLedgerLock(null)).rejects.toThrow(/无法建立跨标签页账本锁/);
  });

  it('excludes a second tab, expires abandoned leases and keeps the version moving', async () => {
    const backend = memoryLeaseBackend();
    expect(await claimLedgerLease(backend, 'tab-a', 1_000)).toBe(1);
    expect(await claimLedgerLease(backend, 'tab-b', 1_001)).toBeNull();
    expect(await renewLedgerLease(backend, 'tab-a', 1, 1_500)).toBe(true);
    // renew pushed the heartbeat forward, so the lease genuinely extends with it.
    expect(await claimLedgerLease(backend, 'tab-b', 1_500 + BROWSER_LEDGER_LEASE_MS - 1)).toBeNull();
    // A frozen tab stops heart-beating, so its lease expires and tab-b takes over.
    expect(await claimLedgerLease(backend, 'tab-b', 1_500 + BROWSER_LEDGER_LEASE_MS + 1)).toBe(2);
    expect(await assertLedgerLease(backend, 'tab-a', 1)).toBe(false);
    expect(await renewLedgerLease(backend, 'tab-a', 1, 20_000)).toBe(false);
    expect(await assertLedgerLease(backend, 'tab-b', 2)).toBe(true);
    await releaseLedgerLease(backend, 'tab-b', 2);
    expect(await assertLedgerLease(backend, 'tab-b', 2)).toBe(false);
    expect(await claimLedgerLease(backend, 'tab-c', 20_001)).toBe(3);
  });

  it('releases idempotently', async () => {
    const manager = new FakeLockManager();
    const release = await acquireBrowserLedgerLock(manager);
    const spy = vi.spyOn(manager, 'request');
    await Promise.all([release(), release()]);
    expect(manager.held).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
