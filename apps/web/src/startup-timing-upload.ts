import { requestJson } from '@zichan/db';
import { newId } from '@zichan/core';
import { authenticateSyncProfile, hasAccountSession } from './sync-auth.js';
import { runtimeCredential } from './credential-vault.js';
import { buildSyncBaseUrl, type SyncConnection } from './sync-config.js';
import type { StartupTimingReport } from './startup-timing.js';

interface Pending { id: string; report: StartupTimingReport }
const flights = new Map<string, Promise<void>>();
const key = (baseUrl: string) => `zichan.startup-pending.v1:${baseUrl}`;
function pending(baseUrl: string): Pending[] {
  try { const rows = JSON.parse(localStorage.getItem(key(baseUrl)) ?? '[]'); return Array.isArray(rows) ? rows : []; } catch { return []; }
}
function save(baseUrl: string, rows: Pending[]): void {
  try { localStorage.setItem(key(baseUrl), JSON.stringify(rows.slice(-20))); } catch { /* Diagnostics never block a ledger. */ }
}
export function queueStartupTiming(baseUrl: string, report: StartupTimingReport): void {
  if (report.totalMs === undefined) return;
  save(baseUrl, [...pending(baseUrl), { id: newId(), report }]);
}
export function flushStartupTimings(connection: SyncConnection): Promise<void> {
  const baseUrl = buildSyncBaseUrl(connection);
  if (!pending(baseUrl).length || !hasAccountSession(runtimeCredential(connection.id))) return Promise.resolve();
  const existing = flights.get(baseUrl);
  if (existing) return existing;
  const run = async () => {
    const token = await authenticateSyncProfile(connection);
    for (const item of pending(baseUrl)) {
      const response = await requestJson(`${baseUrl}/api/v4/diagnostics/ledger-open`, {
        method: 'POST', cache: 'no-store', redirect: 'error', credentials: 'omit',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(item.report),
      });
      if (!response.ok) throw new Error(`打开性能上报失败：HTTP ${response.status}`);
      save(baseUrl, pending(baseUrl).filter(row => row.id !== item.id));
    }
  };
  const flight = (navigator.locks ? navigator.locks.request(`zichan:startup-upload:${baseUrl}`, run) : run())
    .finally(() => flights.delete(baseUrl));
  flights.set(baseUrl, flight);
  return flight;
}
export async function uploadStartupTiming(connection: SyncConnection, report: StartupTimingReport): Promise<void> {
  queueStartupTiming(buildSyncBaseUrl(connection), report);
  await flushStartupTimings(connection);
}
