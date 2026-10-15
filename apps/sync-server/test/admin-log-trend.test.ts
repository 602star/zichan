import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SyncServerStore } from '../src/store.js';

describe('retained run log trend', () => {
  it('aggregates all matching rows by UTC bucket, beyond a list page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-log-trend-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-log-trend');
    try {
      await store.ready;
      await store.appendLog({ id: 'log-1', at: '2026-10-14T10:02:00.000Z', level: 'info', action: 'test', message: 'ok' });
      await store.appendLog({ id: 'log-2', at: '2026-10-14T10:03:00.000Z', level: 'warn', action: 'test', message: 'slow' });
      await store.appendLog({ id: 'log-3', at: '2026-10-14T10:04:00.000Z', level: 'error', action: 'test', message: 'failed' });
      await store.appendLog({ id: 'log-4', at: '2026-10-14T11:00:00.000Z', level: 'error', action: 'test', message: 'later' });
      const from = '2026-10-14T10:00:00.000Z';
      const until = '2026-10-14T11:00:00.000Z';
      expect(await store.logLevelTrend(from, until, 'hour')).toEqual([
        { bucketAt: from, info: 1, warn: 1, error: 1 },
      ]);
      expect(await store.logLevelTrend(from, until, 'minute')).toHaveLength(3);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
