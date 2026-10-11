/**
 * Maintenance mode: the write gate, its auto-expiry, and the drain signal.
 *
 * The deployment-side procedure (backup, restore) has to stop this process. The console cannot
 * call a flow that must stop the server to complete, so what it can do instead is:
 *
 * 1. **Declare the window** — a state that is recorded, audited, and shown to clients.
 * 2. **Stop new data landing** — refuse client writes so a snapshot taken during the window is not
 *    racing new commits. This is the part that makes the window mean anything.
 * 3. **Say whether it is safe to stop now** — a running backup must not be interrupted halfway by
 *    an operator who could not see that a write was still in flight.
 *
 * Three properties are deliberate, and each one exists because the alternative is a silent lie:
 *
 * - **Reads stay open.** A client that cannot even pull has no way to learn why it is failing, and
 *   the console needs its own reads to turn the mode back off. Only the data plane's writes close.
 * - **The mode can expire on its own.** A maintenance flag nobody remembers to clear is an outage
 *   with a friendly name. `until` is optional but strongly encouraged; once it passes, writes
 *   resume without anyone having to act.
 * - **The gate and the display read the same function.** If the console showed the stored flag
 *   while the gate had already expired it, the page would report "维护中" during normal operation.
 *   Both call `resolveMaintenance`, so they cannot disagree.
 */

export interface MaintenanceState {
  enabled: boolean;
  /** Shown to clients so a failed sync says when it will work again. */
  message: string;
  /** ISO-8601 end of the window, or null for an open-ended window. */
  until: string | null;
  /** When the operator declared it, for the console's audit-style display. */
  startedAt: string | null;
  startedBy: string | null;
}

export interface MaintenanceView {
  /** Whether writes are being refused *right now*. */
  active: boolean;
  /** The stored flag, regardless of expiry. */
  enabled: boolean;
  message: string;
  until: string | null;
  startedAt: string | null;
  startedBy: string | null;
  /**
   * True when the operator set an end time and it has passed. Reported so the console can say
   * "expired, writes resumed" instead of showing a state that no longer applies.
   */
  expired: boolean;
}

export const MAINTENANCE_KEY = 'maintenance:mode';

export const DEFAULT_MAINTENANCE_MESSAGE = '服务器正在维护，暂时无法写入。维护结束后会自动恢复，无需重新配置。';

export function emptyMaintenance(): MaintenanceState {
  return { enabled: false, message: '', until: null, startedAt: null, startedBy: null };
}

/**
 * The single interpretation of the stored state.
 *
 * Used by the request gate and by the console payload, so "writes are refused" and "the page says
 * 维护中" are the same decision rather than two implementations of it.
 */
export function resolveMaintenance(state: MaintenanceState | undefined, now: number = Date.now()): MaintenanceView {
  const stored = state ?? emptyMaintenance();
  const untilMs = stored.until ? Date.parse(stored.until) : Number.NaN;
  // An unparseable end time is treated as no end time: refusing writes forever because of a typo
  // in a timestamp is worse than the open-ended window the operator already had.
  const expired = stored.enabled && Number.isFinite(untilMs) && untilMs <= now;
  return {
    active: stored.enabled && !expired,
    enabled: stored.enabled,
    message: stored.message || DEFAULT_MAINTENANCE_MESSAGE,
    until: stored.until,
    startedAt: stored.startedAt,
    startedBy: stored.startedBy,
    expired,
  };
}

/**
 * Read-shaped POSTs on the data plane.
 *
 * The gate is a deny-list of *reads*, not an allow-list of writes: a newly added write endpoint is
 * then gated automatically. Getting that backwards would mean every future write route silently
 * bypasses maintenance until someone remembers to add it. A forgotten exception here fails closed
 * (a read is refused during maintenance), which is visible and harmless.
 */
const DATA_PLANE_READ_POSTS = new Set(['/api/v3/blobs/status']);

/**
 * Whether this request is a client data-plane write that maintenance mode must refuse.
 *
 * Scoped to `/api/v3/` on purpose:
 * - `/api/admin/*` stays open, or the mode could never be turned off again.
 * - `/api/auth/*` stays open, so people can still sign in and out while the window is open.
 *   Registration and session traffic do not touch the data being snapshotted.
 */
export function isClientWrite(method: string, apiPath: string): boolean {
  if (apiPath === '/api/v4/replication/commits') return method === 'POST';
  if (apiPath === '/api/v4/replication/key-envelope') return method === 'POST';
  if (apiPath.startsWith('/api/v4/replication/blobs/')) return method !== 'GET' && method !== 'HEAD' && apiPath !== '/api/v4/replication/blobs/status';
  if (!apiPath.startsWith('/api/v3/')) return false;
  if (method === 'GET' || method === 'HEAD') return false;
  return !DATA_PLANE_READ_POSTS.has(apiPath);
}

export interface DrainView {
  /** Client writes currently being served. */
  inFlightWrites: number;
  runningJobs: number;
  queuedJobs: number;
  /**
   * Whether stopping the process now would interrupt work in progress.
   *
   * Queued jobs are reported but do not block this: they have not started, and a restart marks
   * them interrupted rather than losing anything already done.
   */
  safeToStop: boolean;
  note: string;
}

/**
 * Counts client writes in flight.
 *
 * A module-level counter rather than a database row: this describes *this* process, and a
 * persisted number would be stale the moment the process died — which is exactly when an operator
 * reads it.
 */
export function createWriteTracker() {
  let inFlight = 0;
  return {
    begin(): void { inFlight += 1; },
    end(): void { inFlight = Math.max(0, inFlight - 1); },
    get count(): number { return inFlight; },
  };
}

export type WriteTracker = ReturnType<typeof createWriteTracker>;

export function drainView(tracker: WriteTracker, jobs: { running: number; queued: number }): DrainView {
  const safeToStop = tracker.count === 0 && jobs.running === 0;
  return {
    inFlightWrites: tracker.count,
    runningJobs: jobs.running,
    queuedJobs: jobs.queued,
    safeToStop,
    note: safeToStop
      ? jobs.queued > 0
        ? `没有进行中的写入与任务，现在停机不会中断任何工作；${jobs.queued} 个排队任务尚未开始，重启后会被标记为中断。`
        : '没有进行中的写入与任务，现在停机不会中断任何工作。'
      : `仍有 ${tracker.count} 个写入与 ${jobs.running} 个任务在执行，现在停机会中断它们。`,
  };
}
