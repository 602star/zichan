import { describe, expect, it, vi } from 'vitest';
import {
  acquireBrowserLedgerLock,
  BrowserLedgerAlreadyOpenError,
} from '../src/db/browser-ledger-lock.js';

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

  it('fails closed when the browser cannot provide a cross-tab lock', async () => {
    await expect(acquireBrowserLedgerLock(null)).rejects.toThrow(/不支持安全账本锁/);
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
