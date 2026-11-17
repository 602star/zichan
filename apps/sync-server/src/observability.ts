import type { SqlDriver } from '@zichan/db';
import { randomUUID } from 'node:crypto';
import { captureLogContext } from './log-workspace.js';

/** Fixed, non-cumulative bins. Merge counts before calculating a percentile. */
export const LATENCY_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
export const OBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS obs_http_buckets (
  bucket_at TEXT NOT NULL, instance_id TEXT NOT NULL, route TEXT NOT NULL, method TEXT NOT NULL,
  status_class INTEGER NOT NULL, requests INTEGER NOT NULL, duration_ms REAL NOT NULL,
  histogram TEXT NOT NULL, PRIMARY KEY(bucket_at, instance_id, route, method, status_class)
);
CREATE INDEX IF NOT EXISTS obs_http_time ON obs_http_buckets(bucket_at);
CREATE TABLE IF NOT EXISTS obs_http_hour_buckets (
  bucket_at TEXT NOT NULL, instance_id TEXT NOT NULL, route TEXT NOT NULL, method TEXT NOT NULL,
  status_class INTEGER NOT NULL, requests INTEGER NOT NULL, duration_ms REAL NOT NULL,
  histogram TEXT NOT NULL, PRIMARY KEY(bucket_at, instance_id, route, method, status_class)
);
CREATE INDEX IF NOT EXISTS obs_http_hour_time ON obs_http_hour_buckets(bucket_at);
CREATE TABLE IF NOT EXISTS obs_heartbeats (
  job_key TEXT PRIMARY KEY, instance_id TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  success_at TEXT, failure_at TEXT, status TEXT NOT NULL, duration_ms REAL,
  failure_streak INTEGER NOT NULL DEFAULT 0, error_code TEXT
);
CREATE TABLE IF NOT EXISTS obs_traffic_ids (event_id TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS obs_traffic_ids_at ON obs_traffic_ids(at);
CREATE TABLE IF NOT EXISTS obs_http_events (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, method TEXT NOT NULL, route TEXT NOT NULL,
  status INTEGER NOT NULL, duration_ms REAL NOT NULL, source_ip TEXT NOT NULL, request_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS obs_http_events_at ON obs_http_events(at, id);
CREATE INDEX IF NOT EXISTS obs_http_events_request ON obs_http_events(request_id);
CREATE TABLE IF NOT EXISTS obs_notification_deliveries (
  id TEXT PRIMARY KEY, event_key TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT NOT NULL,
  finished_at TEXT, error_code TEXT
);
CREATE INDEX IF NOT EXISTS obs_delivery_due ON obs_notification_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS traffic_visitor_at ON traffic_page_views(visitor_hash, at);
`;

export interface HttpBucket {
  bucketAt: string; instanceId: string; route: string; method: string; statusClass: number;
  requests: number; durationMs: number; histogram: number[];
}
export interface HttpEvent { id: string; at: string; method: string; route: string; status: number; durationMs: number; ip: string; requestId: string; userAgent?: string; origin?: string; instanceId?: string; ttfbMs?: number }

const sumHistogram = `json_array(${Array.from({ length: LATENCY_BOUNDS.length + 1 }, (_, i) => `SUM(COALESCE(json_extract(histogram, '$[${i}]'), 0))`).join(',')})`;
const mergeHourHistogram = `json_array(${Array.from({ length: LATENCY_BOUNDS.length + 1 }, (_, i) => `COALESCE(json_extract(obs_http_hour_buckets.histogram, '$[${i}]'), 0) + COALESCE(json_extract(excluded.histogram, '$[${i}]'), 0)`).join(',')})`;
type HttpSqlRow = { bucket_at: string; instance_id: string; route: string; method: string; status_class: number; requests: number; duration_ms: number; histogram: string };
const httpBucket = (row: HttpSqlRow): HttpBucket => ({ bucketAt: row.bucket_at, instanceId: row.instance_id, route: row.route,
  method: row.method, statusClass: Number(row.status_class), requests: Number(row.requests), durationMs: Number(row.duration_ms), histogram: JSON.parse(row.histogram) as number[] });

/** Route vocabulary is bounded; opaque identifiers and private entry paths never reach storage. */
export function normalizeMetricRoute(path: string): string {
  const parts = path.split('?')[0]!.split('/').filter(Boolean);
  const safe = new Set(['api', 'admin', 'auth', 'v3', 'v1', 'node', 'health', 'login', 'logout', 'register', 'start', 'finish', 'refresh', 'me', 'accounts', 'users', 'sessions', 'invites', 'settings', 'overview', 'resources', 'system', 'metrics', 'logs', 'audit', 'jobs', 'alerts', 'blobs', 'commits', 'push', 'pull', 'traffic', 'view', 'ops', 'requests', 'summary', 'routes', 'heartbeats', 'database', 'current', 'runtime', 'collectors', 'security-events', 'sync', 'replicas', 'groups', 'status', 'members', 'startup-timing']);
  return '/' + parts.slice(0, 8).map((part) => safe.has(part) ? part : ':id').join('/');
}

export function latencyPercentile(histogram: number[], percentile: number): number | null {
  const count = histogram.reduce((sum, value) => sum + value, 0);
  if (!count) return null;
  const target = Math.ceil(count * percentile);
  let cumulative = 0;
  for (let i = 0; i < histogram.length; i++) {
    cumulative += histogram[i]!;
    // Overflow has no finite upper bound; report its lower bound explicitly in the contract.
    if (cumulative >= target) return LATENCY_BOUNDS[i] ?? LATENCY_BOUNDS.at(-1)!;
  }
  return null;
}

export function summarizeRequests(rows: HttpBucket[], windowMs: number) {
  const histogram = Array<number>(LATENCY_BOUNDS.length + 1).fill(0);
  let totalRequests = 0; let errors5xx = 0; let errors4xx = 0; let durationMs = 0;
  for (const row of rows) {
    totalRequests += row.requests; durationMs += row.durationMs;
    if (row.statusClass === 5) errors5xx += row.requests;
    if (row.statusClass === 4) errors4xx += row.requests;
    row.histogram.forEach((value, i) => { histogram[i] = (histogram[i] ?? 0) + value; });
  }
  return { totalRequests, errors5xx, errors4xx, errorRate5xx: totalRequests ? errors5xx / totalRequests : null,
    qpsAverage: totalRequests / (windowMs / 1000), averageMs: totalRequests ? durationMs / totalRequests : null,
    latencyMs: { p50: latencyPercentile(histogram, .5), p95: latencyPercentile(histogram, .95), p99: latencyPercentile(histogram, .99) },
    histogram, histogramScheme: 'http_latency_v1', percentileMethod: 'fixed_bucket_upper_bound_overflow_lower_bound', boundsMs: LATENCY_BOUNDS };
}

export function heartbeatStatus(row: { status: string; startedAt: string | null; finishedAt: string | null }, now = Date.now()) {
  if (row.status === 'running') return now - Date.parse(row.startedAt ?? '') > 30_000 ? 'timeout' : 'running';
  if (row.status === 'failed') return 'failed';
  if (!row.finishedAt) return 'unknown';
  return now - Date.parse(row.finishedAt) > 90_000 ? 'stale' : 'healthy';
}

export class ObservabilityStore {
  constructor(private readonly driver: SqlDriver) {}

  async enqueueNotification(id: string, eventKey: string, payload: unknown): Promise<void> {
    const at = new Date().toISOString();
    await this.driver.run("INSERT OR IGNORE INTO obs_notification_deliveries(id,event_key,payload,created_at,status,next_retry_at) VALUES(?,?,?,?,'pending',?)", [id, eventKey, JSON.stringify(payload), at, at]);
  }

  async dueNotifications() {
    return this.driver.transaction(async (driver) => {
      const rows = await driver.all<{ id: string; event_key: string; payload: string; attempts: number }>("SELECT id,event_key,payload,attempts FROM obs_notification_deliveries WHERE status IN ('pending','retrying') AND next_retry_at <= ? ORDER BY next_retry_at LIMIT 10", [new Date().toISOString()]);
      // Lease without a new public status: a crashed worker becomes eligible again in two minutes.
      for (const row of rows) await driver.run('UPDATE obs_notification_deliveries SET next_retry_at=? WHERE id=?', [new Date(Date.now() + 120000).toISOString(), row.id]);
      return rows;
    });
  }

  async finishNotification(id: string, attempts: number, state: string, error?: string): Promise<void> {
    const retry = state === 'failed' && attempts < 5;
    await this.driver.run('UPDATE obs_notification_deliveries SET status=?, attempts=?, next_retry_at=?, finished_at=?, error_code=? WHERE id=?',
      [retry ? 'retrying' : state, attempts, new Date(Date.now() + Math.min(3600000, 60000 * 2 ** (attempts - 1))).toISOString(), retry ? null : new Date().toISOString(), error?.slice(0, 300) ?? null, id]);
  }

  async deliveries() {
    return this.driver.all<{ id: string; event_key: string; created_at: string; status: string; attempts: number; next_retry_at: string; finished_at: string | null; error_code: string | null }>('SELECT id,event_key,created_at,status,attempts,next_retry_at,finished_at,error_code FROM obs_notification_deliveries ORDER BY created_at DESC LIMIT 100');
  }

  async insertEvents(events: HttpEvent[]): Promise<void> {
    await this.driver.transaction(async (driver) => {
      for (const e of events) {
        await driver.run('INSERT INTO obs_http_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [e.id, e.at, e.method, e.route, e.status, e.durationMs, e.ip, e.requestId]);
        await captureLogContext(driver, 'access', e.id, { userAgent: e.userAgent ?? null, origin: e.origin ?? null, instanceId: e.instanceId ?? null, ttfbMs: e.ttfbMs ?? null }, false);
      }
    });
  }

  async accessEvents(from: string, until: string, filters: { requestId?: string; route?: string; status?: string; ip?: string; cursor?: string }) {
    const conditions = ['at >= ?', 'at < ?'];
    const params: string[] = [from, until];
    for (const [key, column] of [['requestId', 'request_id'], ['route', 'route'], ['status', 'status'], ['ip', 'source_ip']] as const) {
      if (filters[key]) { conditions.push(`${column} = ?`); params.push(filters[key]!); }
    }
    if (filters.cursor) { conditions.push("at || '/' || id < ?"); params.push(filters.cursor); }
    const rows = await this.driver.all<{ id: string; at: string; method: string; route: string; status: number; duration_ms: number; source_ip: string; request_id: string }>(`SELECT * FROM obs_http_events WHERE ${conditions.join(' AND ')} ORDER BY at DESC, id DESC LIMIT 51`, params);
    const last = rows[49];
    return { events: rows.slice(0, 50).map((r) => ({ id: r.id, at: r.at, method: r.method, route: r.route, status: r.status, durationMs: r.duration_ms, ip: r.source_ip, requestId: r.request_id })),
      nextCursor: rows.length > 50 && last ? `${last.at}/${last.id}` : null };
  }

  async insertHttp(rows: HttpBucket[]): Promise<void> {
    await this.driver.transaction(async (driver) => {
      for (const row of rows) {
        const values = [row.bucketAt, row.instanceId, row.route, row.method, row.statusClass];
        const previous = await driver.get<{ requests: number; duration_ms: number; histogram: string }>(
          'SELECT requests, duration_ms, histogram FROM obs_http_buckets WHERE bucket_at=? AND instance_id=? AND route=? AND method=? AND status_class=?', values);
        const hist = previous ? (JSON.parse(previous.histogram) as number[]).map((n, i) => n + (row.histogram[i] ?? 0)) : row.histogram;
        await driver.run(`INSERT INTO obs_http_buckets VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(bucket_at, instance_id, route, method, status_class) DO UPDATE SET
          requests=excluded.requests, duration_ms=excluded.duration_ms, histogram=excluded.histogram`,
        [...values, row.requests + (previous?.requests ?? 0), row.durationMs + (previous?.duration_ms ?? 0), JSON.stringify(hist)]);
      }
    });
  }

  async httpRows(from: string, until: string, route?: string): Promise<HttpBucket[]> {
    const rows = await this.driver.all<{ bucket_at: string; instance_id: string; route: string; method: string; status_class: number; requests: number; duration_ms: number; histogram: string }>(
      `SELECT * FROM obs_http_buckets WHERE bucket_at >= ? AND bucket_at < ?${route ? ' AND route = ?' : ''} ORDER BY bucket_at LIMIT 50000`, [from, until, ...(route ? [route] : [])]);
    return rows.map((r) => ({ bucketAt: r.bucket_at, instanceId: r.instance_id, route: r.route, method: r.method,
      statusClass: r.status_class, requests: r.requests, durationMs: r.duration_ms, histogram: JSON.parse(r.histogram) as number[] }));
  }

  /** Aggregate the complete retained window in SQLite; no raw-row LIMIT can undercount it. */
  async httpHasHourly(from: string, until: string, route?: string) {
    const start = new Date(Math.floor(Date.parse(from) / 3_600_000) * 3_600_000).toISOString();
    return Boolean(await this.driver.get(`SELECT 1 AS present FROM obs_http_hour_buckets WHERE bucket_at >= ? AND bucket_at < ?${route ? ' AND route = ?' : ''} LIMIT 1`, [start, until, ...(route ? [route] : [])]));
  }

  async httpReport(from: string, until: string, granularity: 'minute' | 'hour' | 'day', route?: string) {
    return this.driver.transaction(driver => this.httpReportData(driver, from, until, granularity, route));
  }

  async httpWindowReport(from: string, until: string, route?: string) {
    return this.driver.transaction(async driver => {
      let fromMs = Date.parse(from); let untilMs = Date.parse(until);
      const start = new Date(Math.floor(fromMs / 3_600_000) * 3_600_000).toISOString();
      // Probe precision and read all summaries in the same snapshot as housekeeping moves rows.
      const hourly = untilMs - fromMs > 7 * 86_400_000 || Boolean(await driver.get(
        `SELECT 1 AS present FROM obs_http_hour_buckets WHERE bucket_at >= ? AND bucket_at < ?${route ? ' AND route = ?' : ''} LIMIT 1`, [start, until, ...(route ? [route] : [])]));
      if (hourly) { fromMs = Math.floor(fromMs / 3_600_000) * 3_600_000; untilMs = Math.ceil(untilMs / 3_600_000) * 3_600_000; }
      const spanMs = untilMs - fromMs;
      const granularity = spanMs > 7 * 86_400_000 ? 'day' : !hourly && spanMs <= 3_600_000 ? 'minute' : 'hour';
      const actualFrom = new Date(fromMs).toISOString(); const actualUntil = new Date(untilMs).toISOString();
      return { ...await this.httpReportData(driver, actualFrom, actualUntil, granularity, route), from: actualFrom, until: actualUntil,
        spanMs, sourceResolution: hourly ? 'hour' : 'minute', bucketMs: granularity === 'day' ? 86_400_000 : granularity === 'hour' ? 3_600_000 : 60_000 };
    });
  }

  private async httpReportData(driver: SqlDriver, from: string, until: string, granularity: 'minute' | 'hour' | 'day', route?: string) {
    const where = `bucket_at >= ? AND bucket_at < ?${route ? ' AND route = ?' : ''}`;
    const params = [from, until, ...(route ? [route] : [])];
    const base = `WITH data AS (SELECT * FROM obs_http_buckets WHERE ${where} UNION ALL SELECT * FROM obs_http_hour_buckets WHERE ${where})`;
    const bucket = granularity === 'minute' ? 'bucket_at' : granularity === 'hour'
      ? "strftime('%Y-%m-%dT%H:00:00.000Z', bucket_at)" : "strftime('%Y-%m-%dT00:00:00.000Z', bucket_at)";
    const totals = await driver.all<HttpSqlRow>(`${base} SELECT MIN(bucket_at) AS bucket_at, '' AS instance_id, '' AS route, '' AS method,
      status_class, SUM(requests) AS requests, SUM(duration_ms) AS duration_ms, ${sumHistogram} AS histogram FROM data GROUP BY status_class`, [...params, ...params]);
    const routes = await driver.all<HttpSqlRow>(`${base}, ranked AS (SELECT route, method FROM data GROUP BY route, method ORDER BY SUM(requests) DESC, route, method LIMIT 50)
      SELECT MIN(bucket_at) AS bucket_at, '' AS instance_id, route, method, status_class, SUM(requests) AS requests,
      SUM(duration_ms) AS duration_ms, ${sumHistogram} AS histogram FROM data JOIN ranked USING(route, method) GROUP BY route, method, status_class`, [...params, ...params]);
    const buckets = await driver.all<HttpSqlRow>(`${base} SELECT ${bucket} AS bucket_at, '' AS instance_id, '' AS route, '' AS method,
      status_class, SUM(requests) AS requests, SUM(duration_ms) AS duration_ms, ${sumHistogram} AS histogram FROM data GROUP BY ${bucket}, status_class ORDER BY bucket_at`, [...params, ...params]);
    return { totals: totals.map(httpBucket), routes: routes.map(httpBucket), buckets: buckets.map(httpBucket),
      observedSince: totals.map(row => row.bucket_at).sort()[0] ?? null };
  }

  async heartbeat(key: string, instance: string, status: 'running' | 'healthy' | 'failed', durationMs?: number): Promise<void> {
    const at = new Date().toISOString();
    await this.driver.run(`INSERT INTO obs_heartbeats(job_key, instance_id, status, started_at, finished_at, success_at, failure_at, duration_ms, failure_streak, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_key) DO UPDATE SET instance_id=excluded.instance_id, status=excluded.status,
      started_at=CASE WHEN excluded.status='running' THEN excluded.started_at ELSE obs_heartbeats.started_at END,
      finished_at=CASE WHEN excluded.status!='running' THEN excluded.started_at ELSE obs_heartbeats.finished_at END,
      success_at=CASE WHEN excluded.status='healthy' THEN excluded.started_at ELSE obs_heartbeats.success_at END,
      failure_at=CASE WHEN excluded.status='failed' THEN excluded.started_at ELSE obs_heartbeats.failure_at END,
      failure_streak=CASE WHEN excluded.status='failed' THEN failure_streak+1 WHEN excluded.status='healthy' THEN 0 ELSE failure_streak END,
      duration_ms=COALESCE(excluded.duration_ms, duration_ms), error_code=CASE WHEN excluded.status='failed' THEN 'COLLECTION_FAILED' ELSE NULL END`,
    [key, instance, status, at, status === 'running' ? null : at, status === 'healthy' ? at : null, status === 'failed' ? at : null, durationMs ?? null, status === 'failed' ? 1 : 0, status === 'failed' ? 'COLLECTION_FAILED' : null]);
  }

  async heartbeats() {
    const rows = await this.driver.all<{ job_key: string; instance_id: string; status: string; started_at: string | null; finished_at: string | null; success_at: string | null; failure_at: string | null; duration_ms: number | null; failure_streak: number; error_code: string | null }>('SELECT * FROM obs_heartbeats ORDER BY job_key');
    return rows.map((r) => ({ jobKey: r.job_key, instanceId: r.instance_id, status: heartbeatStatus({ status: r.status, startedAt: r.started_at, finishedAt: r.finished_at }),
      startedAt: r.started_at, finishedAt: r.finished_at, lastSuccessAt: r.success_at, lastFailureAt: r.failure_at,
      durationMs: r.duration_ms, failureStreak: r.failure_streak, errorCode: r.error_code,
      expectedIntervalSeconds: 30, maxRuntimeSeconds: 30, stale: !r.finished_at || Date.now() - Date.parse(r.finished_at) > 90_000 }));
  }

  async prune(cutoff: string): Promise<void> {
    // Move each source row once, atomically, with at most 2,000 source rows per pass.
    // A query can union both tables while a large housekeeping backlog is still being rolled up.
    await this.driver.transaction(async driver => {
      const selection = 'SELECT rowid FROM obs_http_buckets WHERE bucket_at < ? ORDER BY bucket_at LIMIT 2000';
      await driver.run(`INSERT INTO obs_http_hour_buckets
        SELECT strftime('%Y-%m-%dT%H:00:00.000Z', bucket_at), instance_id, route, method, status_class,
        SUM(requests), SUM(duration_ms), ${sumHistogram} FROM obs_http_buckets WHERE rowid IN (${selection})
        GROUP BY strftime('%Y-%m-%dT%H:00:00.000Z', bucket_at), instance_id, route, method, status_class
        ON CONFLICT(bucket_at, instance_id, route, method, status_class) DO UPDATE SET
        requests=obs_http_hour_buckets.requests+excluded.requests,
        duration_ms=obs_http_hour_buckets.duration_ms+excluded.duration_ms, histogram=${mergeHourHistogram}`, [cutoff]);
      await driver.run(`DELETE FROM obs_http_buckets WHERE rowid IN (${selection})`, [cutoff]);
    });
    const historyCutoff = new Date(Date.parse(cutoff) - 83 * 86_400_000).toISOString();
    await this.driver.run('DELETE FROM obs_http_hour_buckets WHERE rowid IN (SELECT rowid FROM obs_http_hour_buckets WHERE bucket_at < ? LIMIT 2000)', [historyCutoff]);
    // Each pass has a fixed write budget; the next tick continues where this pass stops.
    for (const table of ['obs_traffic_ids', 'obs_http_events', 'obs_notification_deliveries']) {
      const column = table === 'obs_notification_deliveries' ? 'created_at' : 'at';
      await this.driver.run(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT 2000)`, [table === 'obs_notification_deliveries' ? new Date(Date.now() - 90 * 86400000).toISOString() : cutoff]);
    }
  }
}

export function createHttpCollector(store: ObservabilityStore, instanceId = randomUUID()) {
  let pending = new Map<string, HttpBucket>();
  let dropped = 0; let failures = 0; let lastSuccessAt: string | null = null;
  let flight: Promise<void> | undefined;
  let events: HttpEvent[] = [];
  return {
    instanceId,
    observe(path: string, method: string, status: number, duration: number, context?: { ip: string; requestId: string; userAgent?: string; origin?: string; ttfbMs?: number }) {
      if (!path.startsWith('/api/') || ['/api/health', '/api/traffic/view'].includes(path) || path.startsWith('/api/admin/ops/')) return;
      const route = normalizeMetricRoute(path);
      const bucketAt = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
      const safeMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(method) ? method : 'OTHER';
      const statusClass = Math.floor(status / 100);
      const key = `${bucketAt}:${route}:${safeMethod}:${statusClass}`;
      if (!pending.has(key)) {
        if (pending.size >= 2000) { dropped++; return; }
        pending.set(key, { bucketAt, instanceId, route, method: safeMethod, statusClass, requests: 0, durationMs: 0, histogram: Array<number>(LATENCY_BOUNDS.length + 1).fill(0) });
      }
      const row = pending.get(key)!;
      const ms = Math.max(0, duration);
      row.requests++; row.durationMs += ms;
      const index = LATENCY_BOUNDS.findIndex((bound) => ms <= bound);
      row.histogram[index < 0 ? LATENCY_BOUNDS.length : index]!++;
      if (context && (status >= 400 || ms >= 1000)) {
        if (events.length < 500) events.push({ id: randomUUID(), at: new Date().toISOString(), method: safeMethod, route, status, durationMs: ms, instanceId, ...context });
        else dropped++;
      }
    },
    flush(): Promise<void> {
      if (flight) return flight;
      const rows = [...pending.values()]; pending = new Map();
      const batchEvents = events; events = [];
      flight = store.insertHttp(rows).then(() => store.insertEvents(batchEvents)).then(() => { lastSuccessAt = new Date().toISOString(); })
        .catch(() => { failures++; dropped += rows.reduce((sum, r) => sum + r.requests, 0); })
        .finally(() => { flight = undefined; });
      return flight;
    },
    health: () => ({ instanceId, queueDepth: pending.size, dropped, writeFailures: failures, lastSuccessAt, source: 'http_finish_histogram', samplingIntervalSeconds: 30 }),
  };
}
