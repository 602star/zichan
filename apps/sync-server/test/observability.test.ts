import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpCollector, heartbeatStatus, LATENCY_BOUNDS, normalizeMetricRoute, summarizeRequests } from '../src/observability.js';
import { SyncServerStore } from '../src/store.js';

describe('observability semantics', () => {
  it('merges latency distributions and separates 4xx from 5xx', () => {
    const row = { bucketAt: '2026-11-16T01:00:00.000Z', instanceId: 'instance', route: '/api/auth/login', method: 'POST', durationMs: 0 };
    const fast = Array<number>(LATENCY_BOUNDS.length + 1).fill(0); fast[0] = 99;
    const slow = Array<number>(LATENCY_BOUNDS.length + 1).fill(0); slow[7] = 1;
    const summary = summarizeRequests([{ ...row, statusClass: 4, requests: 99, histogram: fast }, { ...row, statusClass: 5, requests: 1, histogram: slow }], 60000);
    expect(summary).toMatchObject({ totalRequests: 100, errors4xx: 99, errors5xx: 1, errorRate5xx: .01, latencyMs: { p50: 5, p95: 5, p99: 5 } });
    expect(summarizeRequests([], 60000)).toMatchObject({ totalRequests: 0, errorRate5xx: null, latencyMs: { p95: null } });
  });

  it('never stores query strings, unknown paths or account identifiers in route dimensions', () => {
    expect(normalizeMetricRoute('/api/admin/accounts/alice-private/sessions?token=secret')).toBe('/api/admin/accounts/:id/sessions');
    expect(normalizeMetricRoute('/api/unknown-secret-path')).toBe('/api/:id');
  });

  it('prioritizes a timed out run and the latest failure over old successful data', () => {
    const now = Date.parse('2026-11-16T01:10:00Z');
    expect(heartbeatStatus({ status: 'failed', startedAt: null, finishedAt: '2026-11-16T00:00:00Z' }, now)).toBe('failed');
    expect(heartbeatStatus({ status: 'running', startedAt: '2026-11-16T01:09:00Z', finishedAt: null }, now)).toBe('timeout');
    expect(heartbeatStatus({ status: 'healthy', startedAt: null, finishedAt: '2026-11-16T00:00:00Z' }, now)).toBe('stale');
  });

  it('persists merged request buckets across collector restarts and idempotent page views', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-obs-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-obs');
    try {
      await store.ready;
      const collector = createHttpCollector(store.observability);
      collector.observe('/api/health', 'GET', 200, 1);
      collector.observe('/api/admin/accounts/alice?secret=x', 'GET', 503, 1100, { ip: '127.0.0.1', requestId: 'req-test' });
      await collector.flush();
      collector.observe('/api/admin/accounts/bob', 'GET', 503, 20);
      await collector.flush();
      const from = new Date(Date.now() - 3600000).toISOString(); const until = new Date(Date.now() + 60000).toISOString();
      const rows = await store.observability.httpRows(from, until);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ requests: 2, route: '/api/admin/accounts/:id' });
      expect(rows[0]!.histogram.reduce((a, b) => a + b, 0)).toBe(2);
      expect((await store.observability.accessEvents(from, until, { requestId: 'req-test' })).events).toMatchObject([{ status: 503, requestId: 'req-test', ip: '127.0.0.1' }]);
      const restarted = createHttpCollector(store.observability);
      expect(restarted.instanceId).not.toBe(collector.instanceId);
      expect((await store.observability.httpRows(from, until))[0]?.requests).toBe(2);
      const at = new Date('2026-11-16T01:00:00Z');
      await store.recordPageView('visitor', '/app', 'CN', at, 'idempotent-event');
      await store.recordPageView('visitor', '/app', 'CN', at, 'idempotent-event');
      await store.recordPageView('visitor', '/app', 'CN', new Date('2026-11-16T01:30:00Z'), 'second-event');
      const traffic = await store.trafficSummary('2026-11-16T00:00:00Z', '2026-11-16T01:31:00Z', 'hour');
      expect(traffic).toMatchObject({ pv: 2, uv: 1, sessions: 2, activeVisitors5m: 1, activeVisitors30m: 1 });
      const empty = await store.trafficSummary('2026-11-16T00:00:00Z', '2026-11-16T01:31:00Z', 'hour', 'US');
      expect(empty).toMatchObject({ pv: 0, uv: 0, sessions: 0, geoUnknownRatio: null });
      await store.observability.enqueueNotification('episode', 'request-failure', { state: 'active' });
      await store.observability.enqueueNotification('episode', 'request-failure', { state: 'active' });
      expect(await store.observability.dueNotifications()).toHaveLength(1);
      await store.observability.finishNotification('episode', 1, 'failed', 'NOTIFICATION_TIMEOUT');
      expect(await store.observability.dueNotifications()).toHaveLength(0);
      expect(await store.observability.deliveries()).toMatchObject([{ status: 'retrying', attempts: 1, error_code: 'NOTIFICATION_TIMEOUT' }]);
      await store.observability.heartbeat('first-completion', collector.instanceId, 'healthy', 12);
      expect((await store.observability.heartbeats()).find((item) => item.jobKey === 'first-completion')).toMatchObject({ status: 'healthy', durationMs: 12, failureStreak: 0 });
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
