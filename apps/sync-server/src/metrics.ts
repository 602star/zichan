/**
 * Runtime sampling and alert evaluation.
 *
 * Request counters are accumulated in memory and flushed as one aggregate row every
 * sampling interval: with `synchronous = FULL` a write per request would be the
 * dominant cost of the whole server. Alerts need two consecutive bad samples to
 * become active and two healthy samples to resolve, so a single blip cannot flap.
 */
import type { EncryptedBlobStore } from './blob-store.js';
import type { SettingsReader } from './settings.js';
import type { AdminAlert, JsonRecord, ServerLogLevel, SyncServerStore } from './store.js';

const SAMPLE_INTERVAL_MS = 30_000;
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
const SLOW_REQUEST_MS = 1_000;

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
}

export interface MetricsServiceDeps {
  store: SyncServerStore;
  blobStore: EncryptedBlobStore;
  settings: SettingsReader;
  log: (level: ServerLogLevel, action: string, message: string, meta?: Record<string, unknown>) => Promise<void>;
  listBackupRecords: () => Promise<BackupRecordSummary[]>;
  startedAt: number;
  intervalMs?: number;
  /** Injected in tests; the default posts to the configured webhook when one is set. */
  notify?: AlertNotifier;
}

export function createMetricsService(deps: MetricsServiceDeps) {
  const { store, blobStore, settings, log, listBackupRecords } = deps;
  const intervalMs = deps.intervalMs ?? SAMPLE_INTERVAL_MS;
  /** Previous state per alert: notifications fire on transitions, never on every sample. */
  const lastStates = new Map<string, AdminAlert['state']>();
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
    const counts = await store.status();
    const [storage, jobs] = await Promise.all([blobStore.storageComposition(), store.countJobsByStatus()]);
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
    };
    await evaluateAlerts(next);
    snapshot = next;
    snapshotAt = Date.now();
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
        if (snapshot) return { ...snapshot, stale: true, sampledWithinMs: Date.now() - snapshotAt };
        throw error;
      }
    },
    sample,
    async flush(): Promise<void> { await flushCounters(); },
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
    },
  };
}

export type MetricsService = ReturnType<typeof createMetricsService>;
