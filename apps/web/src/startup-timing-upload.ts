import { authenticateSyncProfile } from './sync-auth.js';
import { buildSyncBaseUrl, type SyncConnection } from './sync-config.js';
import type { StartupTimingReport } from './startup-timing.js';

/** Best-effort diagnostics upload after the ledger becomes usable. */
export async function uploadStartupTiming(connection: SyncConnection, report: StartupTimingReport): Promise<void> {
  if (report.totalMs === undefined) return;
  const token = await authenticateSyncProfile(connection);
  await fetch(`${buildSyncBaseUrl(connection)}/api/v4/diagnostics/ledger-open`, {
    method: 'POST', cache: 'no-store', redirect: 'error', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
  });
}
