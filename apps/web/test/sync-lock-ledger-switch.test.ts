import { describe, expect, it } from 'vitest';
import { suspendSyncForLedgerSwitch, withSyncLock } from '../src/sync-lock.js';

describe('ledger switching and synchronization', () => {
  it('waits for current sync and blocks queued work after the selected ledger changes', async () => {
    let finishSync!: () => void;
    const current = withSyncLock(() => new Promise<void>((resolve) => { finishSync = resolve; }));
    const switching = withSyncLock(async () => suspendSyncForLedgerSwitch());
    const queued = withSyncLock(async () => 'stale ledger sync');
    await Promise.resolve();
    finishSync();
    await current;
    const resume = await switching;
    await expect(queued).rejects.toThrow('账本正在切换');
    resume();
    await expect(withSyncLock(async () => 'next ledger')).resolves.toBe('next ledger');
  });
});
