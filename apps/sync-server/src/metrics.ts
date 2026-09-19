/**
 * Runtime sampling and alert evaluation.
 *
 * Request counters are accumulated in memory and flushed as one aggregate row every
 * sampling interval: with `synchronous = FULL` a write per request would be the
 * dominant cost of the whole server. Alerts need two consecutive bad samples to
 * become active and two healthy samples to resolve, so a single blip cannot flap.
 */
import { createRuntimeStats, type RuntimeStats, type RuntimeSample } from './runtime-stats.js';
import type { EncryptedBlobStore } from './blob-store.js';
import type { SettingsReader } from './settings.js';
import type { AdminAlert, DatabaseStats, JsonRecord, ServerLogLevel, SyncServerStore } from './store.js';

const SAMPLE_INTERVAL_MS = 30_000;
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
const SLOW_REQUEST_MS = 1_000;
/** How many past samples the resource alerts look at when deciding "still climbing". */
const RESOURCE_HISTORY = 12;

export interface AlertNotification {
  key: string;
  rule: string;
  scope: string;
  severity: string;
  state: 'active' | 'resolved';
  at: string;
  detail: JsonRecord;
}

/**
 * External notification channel. `skipped` means "no channel is configured", which is not a
 * failure: the alert stays visible in the console either way.
 */
export type AlertNotifier = (notification: AlertNotification) => Promise<{ state: 'sent' | 'failed' | 'skipped'; error?: string }>;

export interface PendingCounters {
  requests: number;
  errors: number;
  slowRequests: number;
  durationMs: number;
  syncPushOk: number;
  syncPushFailed: number;
  syncPullOk: number;
  blobOk: number;
  blobFailed: number;
}

const emptyCounters = (): PendingCounters => ({
  requests: 0, errors: 0, slowRequests: 0, durationMs: 0,
  syncPushOk: 0, syncPushFailed: 0, syncPullOk: 0, blobOk: 0, blobFailed: 0,
});

export interface BackupSummary {
  recordId: string;
  /** Latest attempt, whatever its outcome. */
  status: string;
  attemptedAt: string;
  verificationOk?: boolean;
  /** Newest attempt that succeeded *and* passed verification: the only one "backup overdue" may count. */
  lastSuccessRecordId?: string;
  lastSuccessAt?: string;
  /** Newest attempt whose verification actually ran and passed. */
  lastVerifiedRecordId?: string;
  lastVerifiedAt?: string;
}

export interface BackupRecordSummary {
  recordId: string;
  createdAt: string;
  status: string;
  verifiedAt?: string;
  verificationOk?: boolean;
}

export interface ServiceSnapshot {
  sampledAt: string;
  stale: boolean;
  counts: {
    userCount: number;
    disabledUserCount: number;
    inviteCount: number;
    commitCount: number;
    commitBytes: number;
    activeSessionCount: number;
  };
  storage: Awaited<ReturnType<EncryptedBlobStore['storageComposition']>>;
  cleanup: ReturnType<EncryptedBlobStore['cleanupStatus']>;
  jobs: Record<string, number>;
  alerts: { active: number; pending: number; silenced: number; items: AdminAlert[] };
  verification: { database?: JsonRecord; blobs?: JsonRecord };
  backup: BackupSummary | null;
  uptimeSeconds: number;
  sampledWithinMs: number;
  /** Point-in-time process readings. Only this process: the desktop shell is not included. */
  process: ProcessSnapshot;
  /** Database structure readings; never includes the whole-file `dbstat` scan. */
  database: DatabaseStats | null;
}

export interface ProcessSnapshot {
  pid: number;
  nodeVersion: string;
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  cpuPercent: number | null;
  eventLoopMeanMs: number | null;
  eventLoopMaxMs: number | null;
  eventLoopP99Ms: number | null;
  heapLimitBytes: number | null;
  constrainedBytes: number | null;
  availableBytes: number | null;
  /** Process start time, as opposed to the sample time. */
  startedAt: string;
  /** Whether the reading is the process's own, or the last one before sampling failed. */
  available: boolean;
}

export interface MetricsServiceDeps {
  store: SyncServerStore;
  blobStore: EncryptedBlobStore;
  settings: SettingsReader;
  log: (level: ServerLogLevel, action: string, message: string, meta?: Record<string, unknown>) => Promise<void>;
  listBackupRecords: () => Promise<BackupRecordSummary[]>;
  startedAt: number;
  intervalMs?: number;
  /** Injected in tests; the default reads `process` and `perf_hooks` directly. */
  runtime?: RuntimeStats;
  /** Injected in tests; the default posts to the configured webhook when one is set. */
  notify?: AlertNotifier;
}

export function createMetricsService(deps: MetricsServiceDeps) {
  const { store, blobStore, settings, log, listBackupRecords } = deps;
  const intervalMs = deps.intervalMs ?? SAMPLE_INTERVAL_MS;
  const runtime = deps.runtime ?? createRuntimeStats();
  const startedAtIso = new Date(deps.startedAt).toISOString();
  /** Previous state per alert: notifications fire on transitions, never on every sample. */
  const lastStates = new Map<string, AdminAlert['state']>();
  /** Rolling window of RSS readings, used to tell "high" apart from "still climbing". */
  const rssHistory: number[] = [];
  const defaultNotifier: AlertNotifier = async (notification) => {
    const url = String(settings.effective('alertWebhookUrl') ?? '').trim();
    if (!url) return { state: 'skipped' };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notification),
      });
      return response.ok ? { state: 'sent' } : { state: 'failed', error: `HTTP ${String(response.status)}` };
    } catch (error) {
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  };
  const notifier = deps.notify ?? defaultNotifier;

  /**
   * A notification is worth sending exactly twice per incident: when the alert becomes active
   * and when it recovers. Silenced alerts keep their record but stay out of the channel.
   */
  const notifyTransitions = async (alerts: AdminAlert[]): Promise<void> => {
    const now = Date.now();
    for (const alert of alerts) {
      const previous = lastStates.get(alert.key);
      lastStates.set(alert.key, alert.state);
      // The first observation of an alert is history, not a new incident.
      if (previous === undefined || previous === alert.state) continue;
      const entered = alert.state === 'active' && previous !== 'active';
      const recovered = alert.state === 'resolved' && previous === 'active';
      if (!entered && !recovered) continue;
      if (alert.silencedUntil && Date.parse(alert.silencedUntil) > now) {
        await store.recordAlertNotification(alert.key, { state: 'skipped', error: 'silenced' });
        continue;
      }
      const notification: AlertNotification = {
        key: alert.key,
        rule: alert.rule,
        scope: alert.scope,
        severity: alert.severity,
        state: alert.state === 'active' ? 'active' : 'resolved',
        at: new Date().toISOString(),
        detail: alert.detail ?? {},
      };
      let result: { state: 'sent' | 'failed' | 'skipped'; error?: string };
      try {
        result = await notifier(notification);
      } catch (error) {
        result = { state: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
      await store.recordAlertNotification(alert.key, result);
      // A failing notification must never break sampling: it is recorded, not thrown.
      const action = result.state === 'sent' ? 'alert_notified' : result.state === 'skipped' ? 'alert_notify_skipped' : 'alert_notify_failed';
      await log(result.state === 'sent' ? 'info' : 'warn', action, `Alert ${notification.state}: ${alert.key}`, {
        detail: { key: alert.key, state: notification.state, notify: result.state, ...(result.error ? { error: result.error } : {}) },
      });
    }
  };
  let pending = emptyCounters();
  let snapshot: ServiceSnapshot | undefined;
  let snapshotAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let housekeepingTimer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const observeRequest = (request: {
    durationMs: number;
    status: number;
    kind: 'sync' | 'auth' | 'admin' | 'blob' | 'web' | 'other';
    operation?: 'push' | 'pull';
  }): void => {
    pending.requests += 1;
    pending.durationMs += Math.max(0, Math.round(request.durationMs));
    if (request.durationMs >= SLOW_REQUEST_MS) pending.slowRequests += 1;
    const failed = request.status >= 400;
    if (failed) pending.errors += 1;
    if (request.kind === 'blob') { if (failed) pending.blobFailed += 1; else pending.blobOk += 1; }
    else if (request.operation === 'push') { if (failed) pending.syncPushFailed += 1; else pending.syncPushOk += 1; }
    else if (request.operation === 'pull' && !failed) pending.syncPullOk += 1;
  };

  const flushCounters = async (): Promise<void> => {
    if (!pending.requests) return;
    const counters = pending;
    pending = emptyCounters();
    await store.recordServiceSample(counters);
  };

  /** The resource reading travels with the request counters so one row describes the whole tick. */
  const recordResourceSample = async (sample_: RuntimeSample): Promise<void> => {
    await store.recordServiceSample({
      rssBytes: sample_.rssBytes,
      heapUsedBytes: sample_.heapUsedBytes,
      externalBytes: sample_.externalBytes,
      cpuPercent: sample_.cpuPercent ?? 0,
      eventLoopMaxMs: sample_.eventLoopMaxMs ?? 0,
    });
  };

  /**
   * Resource rules. Each one answers a question an operator can act on, and each is derived
   * from a reading the server can actually defend:
   *
   * - Memory has no single "too much" number, so there are two rules: one for a ceiling
   *   (container limit, or a configured warning size) and one for a leak, which is a *trend*
   *   over the window this process has been running rather than a level.
   * - Event-loop delay is the honest "is this process still responsive" signal on a
   *   single-threaded server. The threshold has to clear the platform's timer granularity:
   *   Windows resolves timers at ~16 ms, so a threshold near zero would fire permanently.
   * - CPU is a window average, so a momentary burst cannot trip it.
   * - The two database rules are the ones a public server actually hits: a WAL that outgrew
   *   its own configured limit (checkpointing is behind) and a file whose free pages mean a
   *   `VACUUM` would return real disk space.
   */
  const evaluateResourceAlerts = async (current: ServiceSnapshot): Promise<void> => {
    const process_ = current.process;
    const memoryWarnBytes = Number(settings.effective('memoryWarnBytes')) * 1024 * 1024;
    // Two different things can define "too much memory", and they mean different things:
    // a container limit is a hard ceiling (crossing it is a kill), while a configured
    // threshold is an absolute size the operator chose to be told about. They are kept
    // apart so the alert text never claims a proportion that does not exist.
    const ceiling = process_.constrainedBytes && process_.constrainedBytes > 0 ? process_.constrainedBytes : null;
    if (ceiling === null && memoryWarnBytes <= 0) {
      // Without either, there is nothing to compare against, so no record is created at all:
      // a "pending" row for a rule that cannot apply would sit in the console as noise. An
      // alert left over from when a limit existed is closed instead.
      const existing = await store.getAlert('process:memory');
      if (existing && existing.state !== 'resolved') {
        await store.upsertAlert({
          key: 'process:memory', rule: 'process-memory', scope: 'process', severity: 'warning',
          active: false, detail: { rssBytes: process_.rssBytes, ceilingBytes: null, configuredWarnBytes: null, ratio: null },
        });
      }
    } else if (ceiling !== null) {
      const ratio = process_.rssBytes / ceiling;
      await store.upsertAlert({
        key: 'process:memory',
        rule: 'process-memory',
        scope: 'process',
        severity: ratio >= 0.95 ? 'critical' : 'warning',
        active: ratio >= 0.85,
        detail: {
          rssBytes: process_.rssBytes, heapUsedBytes: process_.heapUsedBytes,
          externalBytes: process_.externalBytes, arrayBuffersBytes: process_.arrayBuffersBytes,
          ceilingBytes: ceiling, ratio: Number(ratio.toFixed(3)), configuredWarnBytes: null,
        },
      });
    } else {
      await store.upsertAlert({
        key: 'process:memory',
        rule: 'process-memory',
        scope: 'process',
        severity: 'warning',
        active: process_.rssBytes > memoryWarnBytes,
        detail: {
          rssBytes: process_.rssBytes, heapUsedBytes: process_.heapUsedBytes,
          externalBytes: process_.externalBytes, arrayBuffersBytes: process_.arrayBuffersBytes,
          ceilingBytes: null, ratio: null, configuredWarnBytes: memoryWarnBytes,
        },
      });
    }

    // A leak is only claimed when the whole window is full and the climb is both proportional
    // and large in absolute terms; otherwise a busy afternoon would look like a leak.
    const oldest = rssHistory[0];
    const newest = rssHistory.at(-1);
    const fullWindow = rssHistory.length >= RESOURCE_HISTORY;
    const grew = oldest !== undefined && newest !== undefined ? newest - oldest : 0;
    const growthActive = fullWindow && grew > 64 * 1024 * 1024 && newest! > oldest! * 1.5;
    await store.upsertAlert({
      key: 'process:memory-growth',
      rule: 'process-memory-growth',
      scope: 'process',
      severity: 'warning',
      active: growthActive,
      detail: {
        samples: rssHistory.length,
        windowMinutes: Number(((RESOURCE_HISTORY * intervalMs) / 60_000).toFixed(1)),
        oldestBytes: oldest ?? null,
        newestBytes: newest ?? null,
        growthBytes: fullWindow ? grew : null,
      },
    });

    const lag = process_.eventLoopMeanMs;
    const lagThreshold = Number(settings.effective('eventLoopLagWarnMs'));
    await store.upsertAlert({
      key: 'process:event-loop',
      rule: 'event-loop-lag',
      scope: 'process',
      severity: (lag ?? 0) >= lagThreshold * 2 ? 'critical' : 'warning',
      active: lag !== null && lag >= lagThreshold,
      detail: {
        meanMs: lag,
        maxMs: process_.eventLoopMaxMs,
        p99Ms: process_.eventLoopP99Ms,
        thresholdMs: lagThreshold,
      },
    });

    const cpu = process_.cpuPercent;
    const cpuThreshold = Number(settings.effective('cpuWarnPercent'));
    await store.upsertAlert({
      key: 'process:cpu',
      rule: 'process-cpu',
      scope: 'process',
      severity: 'warning',
      active: cpu !== null && cpu >= cpuThreshold,
      detail: { cpuPercent: cpu, thresholdPercent: cpuThreshold },
    });

    const database = current.database;
    if (database) {
      // The WAL is supposed to be truncated back to `journal_size_limit` after a checkpoint,
      // so a file larger than that limit means checkpoints are not completing.
      const limit = database.journalSizeLimitBytes;
      const wal = current.storage.walBytes;
      const walOver = limit > 0 && wal > limit;
      await store.upsertAlert({
        key: 'database:wal',
        rule: 'database-wal',
        scope: 'database',
        severity: walOver && wal > limit * 2 ? 'critical' : 'warning',
        active: walOver,
        detail: { walBytes: wal, journalSizeLimitBytes: limit, ratio: limit > 0 ? Number((wal / limit).toFixed(2)) : null },
      });

      // Free pages are not corruption and not urgency: they are disk space a VACUUM would
      // return. Reported so the number is visible before the disk fills, not after.
      await store.upsertAlert({
        key: 'database:fragmentation',
        rule: 'database-fragmentation',
        scope: 'database',
        severity: 'warning',
        active: database.freelistRatio >= 0.25 && database.freelistBytes > 32 * 1024 * 1024,
        detail: {
          freelistBytes: database.freelistBytes,
          freelistRatio: database.freelistRatio,
          logicalBytes: database.logicalBytes,
        },
      });
    }
  };

  /** Capacity, backup, verification, cleanup and sync-error alert rules. */
  const evaluateAlerts = async (current: ServiceSnapshot): Promise<void> => {
    const ratio = Number(settings.effective('quotaWarnRatio'));
    const capacity = await store.capacityWarnings(ratio);
    const warningKeys = new Set(capacity.map((warning) => `capacity:${warning.scope}:${warning.accountId ?? warning.username}`));
    for (const warning of capacity) {
      await store.upsertAlert({
        key: `capacity:${warning.scope}:${warning.accountId ?? warning.username}`,
        rule: 'capacity',
        scope: warning.scope,
        severity: 'warning',
        active: true,
        detail: { username: warning.username, accountId: warning.accountId, usedBytes: warning.usedBytes, quotaBytes: warning.quotaBytes, ratio },
      });
    }
    // Recovery has to be verified too: an account that fell back under the threshold resolves.
    for (const alert of await store.listAlerts({})) {
      if (alert.rule !== 'capacity' || warningKeys.has(alert.key)) continue;
      if (alert.state === 'resolved') continue;
      await store.upsertAlert({
        key: alert.key,
        rule: 'capacity',
        scope: alert.scope,
        severity: alert.severity,
        active: false,
        detail: alert.detail ?? {},
      });
    }

    const cleanupFailures = current.cleanup.consecutiveFailures;
    await store.upsertAlert({
      key: 'cleanup:failures',
      rule: 'cleanup-failure',
      scope: 'storage',
      severity: 'warning',
      active: cleanupFailures >= 2,
      detail: { consecutiveFailures: cleanupFailures, lastError: current.cleanup.lastError ?? null, lastOk: current.cleanup.lastOk },
    });

    const databaseVerification = current.verification.database;
    if (databaseVerification && typeof databaseVerification['result'] === 'string') {
      await store.upsertAlert({
        key: 'verification:database',
        rule: 'verification-issue',
        scope: 'database',
        severity: 'critical',
        active: databaseVerification['result'] !== 'ok',
        detail: { result: databaseVerification['result'], checkedAt: databaseVerification['checkedAt'] ?? null },
      });
    }
    const blobVerification = current.verification.blobs;
    if (blobVerification) {
      const issues = Number(blobVerification['issueCount'] ?? 0);
      await store.upsertAlert({
        key: 'verification:blobs',
        rule: 'verification-issue',
        scope: 'attachments',
        severity: 'critical',
        active: issues > 0,
        detail: { issueCount: issues, checkedObjects: blobVerification['checkedObjects'] ?? null },
      });
    }

    const backup = current.backup;
    // A record whose verification failed is a failed backup even if creation succeeded.
    const failed = backup ? backup.status === 'failed' || backup.verificationOk === false : false;
    await store.upsertAlert({
      key: 'backup:failure',
      rule: 'backup-failure',
      scope: 'backup',
      severity: 'critical',
      active: failed,
      detail: {
        status: backup?.status ?? 'none',
        attemptedAt: backup?.attemptedAt ?? null,
        verificationOk: backup?.verificationOk ?? null,
        lastSuccessAt: backup?.lastSuccessAt ?? null,
      },
    });
    // Backups are overdue only when no backup both succeeded and passed verification.
    const intervalHours = Number(settings.effective('backupIntervalHours'));
    if (intervalHours > 0) {
      const lastSuccessAt = backup?.lastSuccessAt;
      const due = !lastSuccessAt || Date.now() - Date.parse(lastSuccessAt) > intervalHours * 3_600_000;
      await store.upsertAlert({
        key: 'backup:overdue',
        rule: 'backup-overdue',
        scope: 'backup',
        severity: 'warning',
        active: due,
        detail: {
          intervalHours,
          lastSuccessAt: lastSuccessAt ?? null,
          lastAttemptAt: backup?.attemptedAt ?? null,
          lastVerifiedAt: backup?.lastVerifiedAt ?? null,
        },
      });
    }

    const threshold = Number(settings.effective('syncErrorWarnCount'));
    const syncErrors = await store.recentSyncErrorCount(10);
    await store.upsertAlert({
      key: 'sync:errors',
      rule: 'sync-errors',
      scope: 'sync',
      severity: 'warning',
      active: syncErrors >= threshold,
      detail: { recentErrors: syncErrors, threshold },
    });

    const disk = current.storage.diskFreeBytes;
    const total = current.storage.diskTotalBytes;
    if (disk !== null && total) {
      await store.upsertAlert({
        key: 'storage:disk',
        rule: 'disk-space',
        scope: 'storage',
        severity: disk / total < 0.05 ? 'critical' : 'warning',
        active: disk / total < 0.1,
        detail: { freeBytes: disk, totalBytes: total, freeRatio: Number((disk / total).toFixed(3)) },
      });
    }

    await evaluateResourceAlerts(current);

    const alerts = await store.listAlerts({ limit: 200 });
    const now = Date.now();
    const silenced = alerts.filter((alert) => alert.silencedUntil && Date.parse(alert.silencedUntil) > now);
    current.alerts = {
      active: alerts.filter((alert) => alert.state === 'active' && !silenced.includes(alert)).length,
      pending: alerts.filter((alert) => alert.state === 'pending' && !silenced.includes(alert)).length,
      silenced: silenced.length,
      items: alerts.filter((alert) => alert.state !== 'resolved').slice(0, 20),
    };
    await notifyTransitions(alerts);
  };

  const sample = async (): Promise<ServiceSnapshot> => {
    const reading = runtime.sample();
    // The histogram counts since the previous read, so this window is exactly one tick wide.
    rssHistory.push(reading.rssBytes);
    if (rssHistory.length > RESOURCE_HISTORY) rssHistory.shift();
    const counts = await store.status();
    const [storage, jobs, database] = await Promise.all([
      blobStore.storageComposition(),
      store.countJobsByStatus(),
      // Structure readings are constant-time pragmas, safe on the sampling timer.
      store.databaseStats().catch(() => null),
    ]);
    const identity = runtime.identity();
    const verification = {
      ...(await store.maintenanceState('verification:database') ? { database: (await store.maintenanceState('verification:database'))! } : {}),
      ...(await store.maintenanceState('verification:blobs') ? { blobs: (await store.maintenanceState('verification:blobs'))! } : {}),
    };
    const records = await listBackupRecords();
    const latest = records[0];
    // "Latest attempt", "latest success" and "latest verified" are three different facts:
    // a failed attempt must not postpone the overdue alert, and a failed verification must be
    // visible even when the attempt itself succeeded.
    const lastSuccess = records.find((record) => record.status === 'completed' && record.verificationOk !== false);
    const lastVerified = records.find((record) => record.verificationOk === true && typeof record.verifiedAt === 'string');
    const backup: BackupSummary | null = latest
      ? {
        recordId: latest.recordId,
        status: latest.status,
        attemptedAt: latest.createdAt,
        ...(latest.verificationOk === undefined ? {} : { verificationOk: latest.verificationOk }),
        ...(lastSuccess ? { lastSuccessRecordId: lastSuccess.recordId, lastSuccessAt: lastSuccess.createdAt } : {}),
        ...(lastVerified ? { lastVerifiedRecordId: lastVerified.recordId, lastVerifiedAt: lastVerified.verifiedAt! } : {}),
      }
      : null;
    const next: ServiceSnapshot = {
      sampledAt: new Date().toISOString(),
      stale: false,
      counts: {
        userCount: counts.userCount,
        disabledUserCount: counts.disabledUserCount,
        inviteCount: counts.inviteCount,
        commitCount: counts.commitCount,
        commitBytes: counts.commitBytes,
        activeSessionCount: counts.activeSessionCount,
      },
      storage,
      cleanup: blobStore.cleanupStatus(),
      jobs,
      alerts: { active: 0, pending: 0, silenced: 0, items: [] },
      verification,
      backup,
      uptimeSeconds: Math.max(0, Math.round((Date.now() - deps.startedAt) / 1000)),
      sampledWithinMs: 0,
      process: {
        pid: identity.pid,
        nodeVersion: identity.nodeVersion,
        rssBytes: reading.rssBytes,
        heapTotalBytes: reading.heapTotalBytes,
        heapUsedBytes: reading.heapUsedBytes,
        externalBytes: reading.externalBytes,
        arrayBuffersBytes: reading.arrayBuffersBytes,
        cpuPercent: reading.cpuPercent,
        eventLoopMeanMs: reading.eventLoopMeanMs,
        eventLoopMaxMs: reading.eventLoopMaxMs,
        eventLoopP99Ms: reading.eventLoopP99Ms,
        heapLimitBytes: identity.heapLimitBytes,
        constrainedBytes: identity.constrainedBytes,
        availableBytes: identity.availableBytes,
        startedAt: startedAtIso,
        available: true,
      },
      database,
    };
    await evaluateAlerts(next);
    snapshot = next;
    snapshotAt = Date.now();
    await recordResourceSample(reading);
    await store.setMaintenanceState('snapshot:service', next as unknown as JsonRecord);
    return next;
  };

  const housekeeping = async (): Promise<void> => {
    try {
      await store.pruneLogs(Number(settings.effective('logRetention')));
      await store.pruneSyncEvents(Number(settings.effective('syncEventRetention')));
      const minuteDays = Number(settings.effective('metricsMinuteRetentionDays'));
      await store.pruneMetrics(new Date(Date.now() - (7 - minuteDays) * 24 * 60 * 60 * 1000));
      await store.recordServiceSample(emptyCounters());
      await log('info', 'housekeeping_completed', 'Retention housekeeping completed', {});
    } catch (error) {
      await log('warn', 'housekeeping_failed', 'Retention housekeeping failed', {
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await flushCounters();
      await sample();
    } catch (error) {
      // A failed sample must not stop the next one; the page keeps the last good snapshot.
      await log('warn', 'metrics_sample_failed', 'Runtime sample failed', {
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      running = false;
    }
  };

  return {
    observeRequest,
    /** Cached snapshot: the overview page polls this instead of recomputing aggregates. */
    async current(): Promise<ServiceSnapshot> {
      if (snapshot && Date.now() - snapshotAt < intervalMs) return { ...snapshot, sampledWithinMs: Date.now() - snapshotAt };
      try {
        return { ...(await sample()), sampledWithinMs: 0 };
      } catch (error) {
        // The previous snapshot is kept, but the process reading in it is now old: saying so
        // is the difference between "memory is fine" and "memory was fine a minute ago".
        if (snapshot) {
          return {
            ...snapshot,
            stale: true,
            sampledWithinMs: Date.now() - snapshotAt,
            process: { ...snapshot.process, available: false },
          };
        }
        throw error;
      }
    },
    sample,
    async flush(): Promise<void> { await flushCounters(); },
    /** Exposed so the resources page can refresh a reading without waiting for the next tick. */
    runtime,
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
      housekeepingTimer = setInterval(() => { void housekeeping(); }, HOUSEKEEPING_INTERVAL_MS);
      housekeepingTimer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      if (housekeepingTimer) clearInterval(housekeepingTimer);
      timer = undefined;
      housekeepingTimer = undefined;
      runtime.stop();
    },
  };
}

export type MetricsService = ReturnType<typeof createMetricsService>;
