import { accountLocalStorage } from './account-storage.js';
import { authenticateSyncProfile } from './sync-auth.js';
import { buildSyncBaseUrl, type SyncConnection } from './sync-config.js';

const KEY = 'zichan.pending-sync-runs.v1';
export interface PendingSyncRun {
  profileId: string;
  runId: string;
  outcome: 'converged' | 'partial' | 'failed';
  pulled: number;
  pushed: number;
  attachmentUploads: number;
  attachmentDownloads: number;
  durationMs: number;
}

function pending(): PendingSyncRun[] {
  try {
    const values = JSON.parse(accountLocalStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(values) ? values.filter((item): item is PendingSyncRun =>
      !!item && typeof item === 'object' && typeof item.profileId === 'string'
      && typeof item.runId === 'string') : [];
  } catch { return []; }
}

export async function reportSyncRuns(profiles: SyncConnection[], completed: PendingSyncRun[]): Promise<void> {
  const queue = [...pending(), ...completed].slice(-1000);
  accountLocalStorage.setItem(KEY, JSON.stringify(queue));
  const remaining: PendingSyncRun[] = [];
  for (const [index, run] of queue.entries()) {
    if (index >= 10) { remaining.push(run); continue; }
    const profile = profiles.find((item) => item.id === run.profileId);
    if (!profile) { remaining.push(run); continue; }
    try {
      const token = await authenticateSyncProfile(profile);
      const response = await fetch(`${buildSyncBaseUrl(profile)}/api/v4/sync-runs`, {
        method: 'POST', cache: 'no-store', redirect: 'error', credentials: 'omit',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(run),
      });
      if (!response.ok) remaining.push(run);
    } catch { remaining.push(run); }
  }
  accountLocalStorage.setItem(KEY, JSON.stringify(remaining));
}
