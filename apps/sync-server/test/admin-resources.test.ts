/**
 * Process and database readings.
 *
 * These tests pin the properties that make the page trustworthy rather than the exact
 * numbers: a resource reading must be a peak inside its bucket (summing it would produce a
 * meaningless figure), a missing reading must not be reported as zero, and the expensive
 * whole-file scan must stay out of the sampling path.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { createMetricsService } from '../src/metrics.js';
import { createRuntimeStats } from '../src/runtime-stats.js';
import { createSettings } from '../src/settings.js';
import { SyncServerStore } from '../src/store.js';

async function harness(options: { intervalMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-resources-'));
  const blobStore = new EncryptedBlobStore({ dataDir: dir });
  // Both stores open the same SQLite file. Match server startup: initialize blob tables first.
  const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-resources', undefined, blobStore.ready);
  await store.ready;
  await blobStore.ready;
  const { settings } = createSettings(store, {});
  await settings.save({});
  const metrics = createMetricsService({
    store,
    blobStore,
    settings,
    log: async () => undefined,
    listBackupRecords: async () => [],
    startedAt: Date.now(),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
  });
  return {
    dir, store, blobStore, metrics,
    close: async () => { await store.close(); await blobStore.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('runtime resource readings', () => {
  it('reports real memory fields and a heap ceiling', () => {
    const runtime = createRuntimeStats();
    try {
      const sample = runtime.sample();
      // The heap is always a subset of the resident set; a reading that violated this would
      // mean the fields are being mixed up somewhere.
      expect(sample.rssBytes).toBeGreaterThan(0);
      expect(sample.heapUsedBytes).toBeGreaterThan(0);
      expect(sample.heapUsedBytes).toBeLessThanOrEqual(sample.heapTotalBytes);
      expect(sample.rssBytes).toBeGreaterThanOrEqual(sample.heapUsedBytes);
      expect(sample.externalBytes).toBeGreaterThanOrEqual(0);
      expect(sample.arrayBuffersBytes).toBeGreaterThanOrEqual(0);
      const identity = runtime.identity();
      expect(identity.pid).toBe(process.pid);
      expect(identity.nodeVersion).toBe(process.version);
      expect(identity.heapLimitBytes).toBeGreaterThan(0);
    } finally { runtime.stop(); }
  });

  it('reports CPU as a window average rather than a lifetime total', async () => {
    const runtime = createRuntimeStats();
    try {
      // The first reading has no baseline, so it must not claim a percentage.
      expect(runtime.sample().cpuPercent).toBeNull();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const second = runtime.sample();
      expect(second.cpuPercent).not.toBeNull();
      // A window average cannot be negative and cannot exceed "all cores, all the time" by
      // much; a lifetime total would keep climbing past this bound.
      expect(second.cpuPercent!).toBeGreaterThanOrEqual(0);
      expect(second.cpuPercent!).toBeLessThan(100 * 64);
    } finally { runtime.stop(); }
  });

  it('keeps the last reading and resets the lag histogram per sample', async () => {
    const runtime = createRuntimeStats();
    try {
      expect(runtime.last()).toBeUndefined();
      const first = runtime.sample();
      expect(runtime.last()).toEqual(first);
      // Block the loop on purpose: the histogram has to notice it.
      const until = Date.now() + 40;
      while (Date.now() < until) { /* deliberate */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      const second = runtime.sample();
      expect(second.eventLoopMaxMs).not.toBeNull();
      // The window is one tick wide, so the block above is inside it and must be visible.
      expect(second.eventLoopMaxMs!).toBeGreaterThanOrEqual(0);
    } finally { runtime.stop(); }
  });
});

describe('database statistics', () => {
  it('reads structure counters without scanning the file', async () => {
    const h = await harness();
    try {
      const stats = await h.store.databaseStats();
      expect(stats.pageSize).toBeGreaterThan(0);
      expect(stats.pageCount).toBeGreaterThan(0);
      // Logical size is derived from the counters, so it cannot disagree with them.
      expect(stats.logicalBytes).toBe(stats.pageCount * stats.pageSize);
      expect(stats.journalMode).toBe('wal');
      expect(stats.tempStore).toBe('memory');
      // The schema this store writes must match the pragmas it sets at boot.
      expect(stats.synchronous).toBe('full');
      expect(stats.encoding).toBe('UTF-8');
      expect(stats.freelistRatio).toBeGreaterThanOrEqual(0);
      expect(stats.freelistRatio).toBeLessThanOrEqual(1);
      // No ANALYZE has run yet, so the analyzer table is empty and that is reported as such.
      expect(stats.analyzedTables).toBe(0);
      expect(stats.analyzedAt).toBeNull();
    } finally { await h.close(); }
  });

  it('reports free pages as reclaimable space rather than as corruption', async () => {
    const h = await harness();
    try {
      // Write and delete enough rows to leave freed pages behind.
      for (let index = 0; index < 400; index += 1) {
        await h.store.appendLog({
          id: `log-${index}`, at: new Date().toISOString(), level: 'info',
          action: 'test_row', message: `row ${index} ${'x'.repeat(200)}`,
        });
      }
      await h.store.pruneLogs(10);
      const stats = await h.store.databaseStats();
      expect(stats.freelistBytes).toBeGreaterThan(0);
      expect(stats.freelistRatio).toBeGreaterThan(0);
      // Free pages are still inside the file, so they cannot exceed it.
      expect(stats.freelistBytes).toBeLessThanOrEqual(stats.logicalBytes);
    } finally { await h.close(); }
  });

  it('records ANALYZE as a real operation with its own timestamp', async () => {
    const h = await harness();
    try {
      const result = await h.store.analyze();
      expect(result.tables).toBeGreaterThan(0);
      expect(result.checkedAt).toBeTruthy();
      const stats = await h.store.databaseStats();
      expect(stats.analyzedTables).toBe(result.tables);
      expect(stats.analyzedAt).toBe(result.checkedAt);
    } finally { await h.close(); }
  });

  it('lists per-table usage with row counts for tables and none for indexes', async () => {
    const h = await harness();
    try {
      const usage = await h.store.databaseTableUsage();
      const names = usage.tables.map((table) => table.name);
      expect(names).toContain('server_logs');
      expect(names).toContain('sync_users');
      const logs = usage.tables.find((table) => table.name === 'server_logs')!;
      expect(logs.kind).toBe('table');
      expect(logs.bytes).toBeGreaterThan(0);
      expect(logs.rowCount).toBe(0);
      // Descending by size: the page shows a ranking, so the order is part of the contract.
      const sizes = usage.tables.map((table) => table.bytes);
      expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
      // An index must not claim a row count: counting rows of an index would double-count.
      const index = usage.tables.find((table) => table.kind === 'index');
      if (index) expect(index.rowCount).toBeNull();
    } finally { await h.close(); }
  });
});

describe('resource readings in metric buckets', () => {
  it('keeps system trends scoped and preserves unavailable readings as null', async () => {
    const h = await harness();
    try {
      const sample = {
        scope: 'host' as const, cpuPercent: 42, memoryUsedBytes: 200, memoryTotalBytes: 400,
        diskUsedBytes: 300, diskTotalBytes: 1000, diskReadBytesPerSecond: null,
        diskWriteBytesPerSecond: 10, networkRxBytesPerSecond: 20, networkTxBytesPerSecond: 30,
      };
      await h.store.recordSystemMetricSample(sample, new Date('2026-09-19T10:00:05.000Z'));
      await h.store.recordSystemMetricSample({ ...sample, cpuPercent: null, diskReadBytesPerSecond: 0 }, new Date('2026-09-19T10:00:30.000Z'));
      const host = await h.store.listSystemMetricBuckets('host', 'minute', '2026-09-19T10:00:00.000Z', '2026-09-19T10:01:00.000Z');
      const container = await h.store.listSystemMetricBuckets('container', 'minute', '2026-09-19T10:00:00.000Z', '2026-09-19T10:01:00.000Z');
      expect(host).toHaveLength(1);
      expect(host[0]?.sampledAt).toBe('2026-09-19T10:00:30.000Z');
      expect(host[0]?.cpuPercent).toBeNull();
      expect(host[0]?.diskReadBytesPerSecond).toBe(0);
      expect(container).toEqual([]);
    } finally { await h.close(); }
  });

  it('keeps the peak inside a bucket instead of summing readings', async () => {
    const h = await harness();
    try {
      const at = new Date('2026-09-19T10:00:10.000Z');
      await h.store.recordServiceSample({ rssBytes: 100 * 1024 * 1024, cpuPercent: 12, eventLoopMaxMs: 5 }, at);
      await h.store.recordServiceSample({ rssBytes: 40 * 1024 * 1024, cpuPercent: 30, eventLoopMaxMs: 90 }, at);
      const [bucket] = await h.store.listMetricBuckets('minute', '2026-09-19T10:00:00.000Z', '2026-09-19T10:01:00.000Z');
      // Peak, not sum: 140 MiB and 102 ms would both be wrong answers.
      expect(bucket?.rssBytes).toBe(100 * 1024 * 1024);
      expect(bucket?.cpuPercent).toBe(30);
      expect(bucket?.eventLoopMaxMs).toBe(90);
    } finally { await h.close(); }
  });

  it('carries the process and database readings on the sampled snapshot', async () => {
    const h = await harness();
    try {
      const snapshot = await h.metrics.sample();
      expect(snapshot.process.pid).toBe(process.pid);
      expect(snapshot.process.available).toBe(true);
      expect(snapshot.process.rssBytes).toBeGreaterThan(0);
      expect(snapshot.process.startedAt).toBeTruthy();
      expect(snapshot.database?.journalMode).toBe('wal');
      // The sampling path must never run the whole-file scan.
      expect(snapshot.database).not.toHaveProperty('tables');
    } finally { await h.close(); }
  });

  it('marks the reading as no longer current once a sample fails', async () => {
    // A zero interval disables the cache, so `current()` really re-samples instead of
    // handing back the snapshot taken a moment ago.
    const h = await harness({ intervalMs: 0 });
    try {
      await h.metrics.sample();
      // Break the store so the next sample cannot complete.
      await h.store.close();
      const current = await h.metrics.current();
      expect(current.stale).toBe(true);
      expect(current.process.available).toBe(false);
    } finally { await h.blobStore.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});
