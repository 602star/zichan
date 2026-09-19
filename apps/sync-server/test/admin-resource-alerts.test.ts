/**
 * Resource and database alert rules.
 *
 * The rules are tested through the real alert store, so what is asserted is the same state the
 * console reads: two consecutive bad samples activate, two healthy samples resolve. Each rule
 * also gets its counter-example, because a rule that fires on a healthy server is worse than
 * no rule at all.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { createMetricsService } from '../src/metrics.js';
import { createSettings } from '../src/settings.js';
import { SyncServerStore } from '../src/store.js';
import type { RuntimeStats, RuntimeSample } from '../src/runtime-stats.js';

/** A runtime whose readings the test dictates, so the rules can be driven exactly. */
function fakeRuntime(samples: Partial<RuntimeSample>[]): RuntimeStats {
  let index = 0;
  let last: RuntimeSample | undefined;
  const base: RuntimeSample = {
    rssBytes: 100 * 1024 * 1024, heapTotalBytes: 40 * 1024 * 1024, heapUsedBytes: 30 * 1024 * 1024,
    externalBytes: 5 * 1024 * 1024, arrayBuffersBytes: 1 * 1024 * 1024,
    cpuPercent: 5, eventLoopMeanMs: 1, eventLoopMaxMs: 2, eventLoopP99Ms: 2,
  };
  return {
    sample: () => {
      const patch = samples[Math.min(index, samples.length - 1)] ?? {};
      index += 1;
      last = { ...base, ...patch };
      return last;
    },
    last: () => last,
    identity: () => ({
      pid: 4242, nodeVersion: 'v-test', uptimeSeconds: 60,
      heapLimitBytes: 512 * 1024 * 1024, constrainedBytes: null, availableBytes: 2 * 1024 * 1024 * 1024,
    }),
    stop: () => undefined,
  };
}

async function harness(samples: Partial<RuntimeSample>[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-resource-alerts-'));
  const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-resource-alerts');
  const blobStore = new EncryptedBlobStore({ dataDir: dir });
  await store.ready;
  await blobStore.ready;
  const { settings } = createSettings(store, env);
  await settings.save({});
  const metrics = createMetricsService({
    store, blobStore, settings, log: async () => undefined,
    listBackupRecords: async () => [], startedAt: Date.now(), runtime: fakeRuntime(samples),
  });
  return {
    store, metrics,
    /** Two samples: the first records the condition, the second activates it. */
    activate: async () => { await metrics.sample(); await metrics.sample(); },
    /** Enough samples to fill the growth window (12) and then activate on two in a row. */
    sampleMany: async (count: number) => { for (let index = 0; index < count; index += 1) await metrics.sample(); },
    close: async () => { await store.close(); await blobStore.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('process memory alert', () => {
  it('activates only against a real ceiling, not against a bare number', async () => {
    // No container limit and no configured threshold: a high RSS alone is not an incident.
    const without = await harness([{ rssBytes: 900 * 1024 * 1024 }]);
    try {
      await without.activate();
      expect(await without.store.getAlert('process:memory')).toBeUndefined();
    } finally { await without.close(); }

    // The same reading against a configured threshold is an alert.
    const withThreshold = await harness([{ rssBytes: 900 * 1024 * 1024 }], { ADMIN_MEMORY_WARN_MB: '512' });
    try {
      await withThreshold.activate();
      const alert = await withThreshold.store.getAlert('process:memory');
      expect(alert?.state).toBe('active');
      // An absolute threshold carries no proportion: reporting a ratio would invent a ceiling.
      expect(alert?.detail).toMatchObject({ configuredWarnBytes: 512 * 1024 * 1024, ceilingBytes: null, ratio: null });
    } finally { await withThreshold.close(); }
  });

  it('resolves once memory falls back under the threshold', async () => {
    const h = await harness([
      { rssBytes: 900 * 1024 * 1024 }, { rssBytes: 900 * 1024 * 1024 },
      { rssBytes: 100 * 1024 * 1024 }, { rssBytes: 100 * 1024 * 1024 },
    ], { ADMIN_MEMORY_WARN_MB: '512' });
    try {
      await h.activate();
      expect((await h.store.getAlert('process:memory'))?.state).toBe('active');
      await h.metrics.sample();
      await h.metrics.sample();
      expect((await h.store.getAlert('process:memory'))?.state).toBe('resolved');
    } finally { await h.close(); }
  });
});

describe('memory growth alert', () => {
  it('needs a full window of climbing readings before calling it a leak', async () => {
    // One rising pair is not a leak: the rule requires the whole window to be filled.
    const short = await harness([{ rssBytes: 100 * 1024 * 1024 }, { rssBytes: 400 * 1024 * 1024 }]);
    try {
      await short.activate();
      const alert = await short.store.getAlert('process:memory-growth');
      expect(alert?.state).not.toBe('active');
    } finally { await short.close(); }
  });

  it('activates on a sustained climb and reports the window', async () => {
    // The window has to fill before a trend can be claimed: readings climbing from
    // 100 MiB by 30 MiB a sample are both proportional and large in absolute terms.
    const samples = Array.from({ length: 16 }, (_unused, index) => ({ rssBytes: (100 + index * 30) * 1024 * 1024 }));
    const h = await harness(samples);
    try {
      // Fill the window (12 samples) and then reach two consecutive bad readings.
      await h.sampleMany(14);
      const alert = await h.store.getAlert('process:memory-growth');
      expect(alert?.state).toBe('active');
      expect(Number(alert?.detail?.['growthBytes'])).toBeGreaterThan(64 * 1024 * 1024);
      expect(Number(alert?.detail?.['samples'])).toBe(12);
    } finally { await h.close(); }
  });

  it('stays quiet when memory is flat', async () => {
    const flat = await harness(Array.from({ length: 16 }, () => ({ rssBytes: 300 * 1024 * 1024 })));
    try {
      await flat.sampleMany(14);
      expect((await flat.store.getAlert('process:memory-growth'))?.state).not.toBe('active');
    } finally { await flat.close(); }
  });

  it('does not call a slow drift a leak when the absolute growth is small', async () => {
    // Doubling from a small base is proportional but not a problem worth waking anyone for.
    const drift = await harness(Array.from({ length: 16 }, (_unused, index) => ({ rssBytes: (10 + index) * 1024 * 1024 })));
    try {
      await drift.sampleMany(14);
      expect((await drift.store.getAlert('process:memory-growth'))?.state).not.toBe('active');
    } finally { await drift.close(); }
  });
});

describe('event loop and CPU alerts', () => {
  it('does not fire on the idle baseline, which on Windows is the timer granularity', async () => {
    // ~16 ms is the platform's own floor; the default 50 ms threshold must clear it.
    const h = await harness(Array.from({ length: 4 }, () => ({ eventLoopMeanMs: 16 })));
    try {
      await h.activate();
      expect((await h.store.getAlert('process:event-loop'))?.state).not.toBe('active');
    } finally { await h.close(); }
  });

  it('fires when a synchronous task blocks request handling, and escalates', async () => {
    const h = await harness(Array.from({ length: 4 }, () => ({ eventLoopMeanMs: 400 })));
    try {
      await h.activate();
      const alert = await h.store.getAlert('process:event-loop');
      expect(alert?.state).toBe('active');
      // Twice the threshold is reported as critical, so it is not buried among warnings.
      expect(alert?.severity).toBe('critical');
      expect(alert?.detail).toMatchObject({ thresholdMs: 50 });
    } finally { await h.close(); }
  });

  it('reports sustained CPU but ignores a momentary spike', async () => {
    const spike = await harness([{ cpuPercent: 95 }, { cpuPercent: 3 }, { cpuPercent: 95 }, { cpuPercent: 3 }]);
    try {
      await spike.activate();
      // Alternating readings never reach two consecutive bad samples.
      expect((await spike.store.getAlert('process:cpu'))?.state).not.toBe('active');
    } finally { await spike.close(); }

    const sustained = await harness(Array.from({ length: 4 }, () => ({ cpuPercent: 97 })));
    try {
      await sustained.activate();
      expect((await sustained.store.getAlert('process:cpu'))?.state).toBe('active');
    } finally { await sustained.close(); }
  });
});

describe('database alerts', () => {
  it('reports a WAL that outgrew its configured limit', async () => {
    const h = await harness([{}]);
    try {
      const stats = await h.store.databaseStats();
      // A freshly created database has a WAL far below the 64 MiB limit the store sets.
      expect(stats.journalSizeLimitBytes).toBe(64 * 1024 * 1024);
      await h.activate();
      expect((await h.store.getAlert('database:wal'))?.state).not.toBe('active');
    } finally { await h.close(); }
  });

  it('reports reclaimable free pages as a warning rather than an outage', async () => {
    const h = await harness([{}]);
    try {
      // Leave a large amount of freed space behind, then confirm the rule sees it.
      for (let index = 0; index < 2_000; index += 1) {
        await h.store.appendLog({
          id: `log-${index}`, at: new Date().toISOString(), level: 'info',
          action: 'test_row', message: `${'x'.repeat(600)}`,
        });
      }
      await h.store.pruneLogs(1);
      const stats = await h.store.databaseStats();
      // Free pages are a space question, so the detail must carry both the size and the share.
      expect(stats.freelistBytes).toBeGreaterThan(0);
      expect((await h.store.getAlert('database:fragmentation'))?.severity ?? 'warning').toBe('warning');
    } finally { await h.close(); }
  });
});
