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
  alerts: { active: number; pending: number; items: AdminAlert[] };
  verification: { database?: JsonRecord; blobs?: JsonRecord };
  backup: JsonRecord | null;
  uptimeSeconds: number;
  sampledWithinMs: number;
}

export interface MetricsServiceDeps {
  store: SyncServerStore;
  blobStore: EncryptedBlobStore;
  settings: SettingsReader;
  log: (level: ServerLogLevel, action: string, message: string, meta?: Record<string, unknown>) => Promise<void>;
  listBackupRecords: () => Promise<{ recordId: string; createdAt: string; status: string; verifiedAt?: string; verificationOk?: boolean }[]>;
  startedAt: number;
  intervalMs?: number;
}

export function createMetricsService(deps: MetricsServiceDeps) {
  const { store, blobStore, settings, log, listBackupRecords } = deps;
  const intervalMs = deps.intervalMs ?? SAMPLE_INTERVAL_MS;
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
    const recorded = backup && typeof backup['status'] === 'string' ? String(backup['status']) : undefined;
    // A record whose verification failed is a failed backup even if creation succeeded.
    const status = recorded === 'failed' || backup?.['verificationOk'] === false ? 'failed' : recorded;
    const lastSuccess = backup && typeof backup['createdAt'] === 'string' ? String(backup['createdAt']) : undefined;
    await store.upsertAlert({
      key: 'backup:failure',
      rule: 'backup-failure',
      scope: 'backup',
      severity: 'critical',
      active: status === 'failed',
      detail: { status: status ?? 'none', createdAt: lastSuccess ?? null },
    });
    const intervalHours = Number(settings.effective('backupIntervalHours'));
    if (intervalHours > 0) {
      const due = !lastSuccess || Date.now() - Date.parse(lastSuccess) > intervalHours * 3_600_000;
      await store.upsertAlert({
        key: 'backup:overdue',
        rule: 'backup-overdue',
        scope: 'backup',
        severity: 'warning',
        active: due,
        detail: { intervalHours, lastSuccess: lastSuccess ?? null },
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

    const alerts = await store.listAlerts({ limit: 100 });
    current.alerts = {
      active: alerts.filter((alert) => alert.state === 'active').length,
      pending: alerts.filter((alert) => alert.state === 'pending').length,
      items: alerts.filter((alert) => alert.state !== 'resolved').slice(0, 20),
    };
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
      alerts: { active: 0, pending: 0, items: [] },
      verification,
      backup: latest
        ? {
          recordId: latest.recordId, status: latest.status, createdAt: latest.createdAt,
          ...(latest.verifiedAt ? { verifiedAt: latest.verifiedAt } : {}),
        }
        : null,
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
