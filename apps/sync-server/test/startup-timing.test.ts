import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStartupTiming } from '../src/startup-timing.js';
import { SyncServerStore } from '../src/store.js';

describe('browser startup telemetry', () => {
  it('accepts only known numeric stages and strips browser metadata', () => {
    const parsed = parseStartupTiming({ version: 1, totalMs: 1234, startedAt: 'client time',
      password: 'secret', stages: [{ name: 'remote.commit.pull', durationMs: 432, runs: 1 }],
      counts: { 'remote.commitsPulled': 9 } });
    expect(parsed).toEqual({ totalMs: 1234,
      stages: [{ name: 'remote.commit.pull', durationMs: 432, runs: 1 }],
      counts: { 'remote.commitsPulled': 9 } });
    expect(parseStartupTiming({ version: 1, totalMs: 10,
      stages: [{ name: 'password', durationMs: 1, runs: 1 }], counts: {} })).toBeUndefined();
    expect(parseStartupTiming({ version: 1, totalMs: 10, stages: [], counts: { secret: 1 } })).toBeUndefined();
  });

  it('aggregates anonymous samples in SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-startup-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'open', 'startup-test-server');
    try {
      await store.recordStartupTiming({ totalMs: 1000,
        stages: [{ name: 'account.unlockLedgerKey', durationMs: 200 }] });
      await store.recordStartupTiming({ totalMs: 2000,
        stages: [{ name: 'account.unlockLedgerKey', durationMs: 300 }] });
      const rows = await store.startupTimingSummary(new Date().toISOString().slice(0, 10));
      expect(rows.filter((row) => row.stage === 'total').reduce((sum, row) => sum + row.samples, 0)).toBe(2);
      expect(rows.filter((row) => row.stage === 'account.unlockLedgerKey').reduce((sum, row) => sum + row.durationSumMs, 0)).toBe(500);
      expect(rows.some((row) => row.stage === 'first_restore_total')).toBe(false);
      await store.recordStartupTiming({ kind: 'background', totalMs: 3000,
        stages: [{ name: 'background.syncCaughtUp', durationMs: 4000 }] });
      await store.recordStartupTiming({ kind: 'failure', totalMs: 5000,
        stages: [{ name: 'account.restoreFailed', durationMs: 5000 }] });
      await store.recordStartupTiming({ totalMs: 100,
        stages: [{ name: 'local.cacheOpen', durationMs: 10 }] });
      await store.recordStartupTiming({ totalMs: 500,
        stages: [{ name: 'local.installSnapshot', durationMs: 30 }] });
      const updated = await store.startupTimingSummary(new Date().toISOString().slice(0, 10));
      const samples = (stage: string) => updated.filter(row => row.stage === stage).reduce((sum, row) => sum + row.samples, 0);
      expect(samples('total')).toBe(4);
      expect(samples('first_restore_total')).toBe(1);
      expect(samples('cache_total')).toBe(1);
      expect(samples('failure.total')).toBe(1);
      expect(samples('background.syncCaughtUp')).toBe(1);
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
