import { type SqlLedgerStore } from '@zichan/db';
import { runtimeCredential, CREDENTIALS_CHANGED_EVENT } from './credential-vault.js';
import { readDevicePreferences, sendDeviceNotification } from './device-capabilities.js';
import { getDeviceId, registerSync } from './db/cloud.js';
import {
  loadAutoSync,
  loadSyncConnections,
  SYNC_CONFIG_CHANGED_EVENT,
} from './sync-config.js';
import { syncConfiguredServers } from './sync-orchestrator.js';
import { runtimeLedgerCryptoSession } from './ledger-key-vault.js';

export type SyncLifecycleReason = 'startup' | 'interval' | 'online' | 'foreground' | 'credentials' | 'write';

export interface LifecycleSyncResult {
  reason: SyncLifecycleReason;
  attempted: number;
  succeeded: number;
  pulled: number;
  pushed: number;
  applied: number;
  conflicts: number;
  rounds: number;
  converged: boolean;
  errors: string[];
  finishedAt: string;
}

export const SYNC_LIFECYCLE_RESULT_EVENT = 'zichan:sync-lifecycle-result';
let inFlight: Promise<LifecycleSyncResult | null> | null = null;
let lastAttemptAt = 0;

export function runLifecycleSync(store: SqlLedgerStore, reason: SyncLifecycleReason): Promise<LifecycleSyncResult | null> {
  const config = loadAutoSync();
  if (!config.enabled || !navigator.onLine) return Promise.resolve(null);
  if (!runtimeLedgerCryptoSession()) return Promise.resolve(null);
  const now = Date.now();
  if (inFlight) return inFlight;
  if (reason !== 'interval' && reason !== 'credentials' && reason !== 'write' && now - lastAttemptAt < 5_000) return Promise.resolve(null);
  const profiles = loadSyncConnections().filter((profile) => profile.enabled && profile.username.trim() && runtimeCredential(profile.id)?.password);
  if (profiles.length === 0) return Promise.resolve(null);
  lastAttemptAt = now;
  inFlight = (async () => {
    const result: LifecycleSyncResult = {
      reason, attempted: profiles.length, succeeded: 0, pulled: 0, pushed: 0, applied: 0,
      conflicts: 0, rounds: 0, converged: false, errors: [], finishedAt: '',
    };
    const synced = await syncConfiguredServers(store, profiles);
    result.succeeded = synced.endpoints.filter((row) => !row.error && !row.attachments?.error).length;
    result.pulled = synced.pulled;
    result.pushed = synced.pushed;
    result.applied = synced.applied;
    result.conflicts = synced.conflicts;
    result.rounds = synced.rounds;
    result.converged = synced.converged;
    result.errors = synced.endpoints.flatMap((row) => {
      const messages = [row.error, row.attachments?.error].filter((value): value is string => Boolean(value));
      return messages.map((message) => `${row.alias}：${message}`);
    });
    result.finishedAt = synced.finishedAt;
    const deviceId = getDeviceId();
    registerSync(deviceId, deviceId, result.applied);
    globalThis.dispatchEvent?.(new CustomEvent(SYNC_LIFECYCLE_RESULT_EVENT, { detail: result }));
    if (readDevicePreferences().syncNotifications) {
      if (result.conflicts > 0) await sendDeviceNotification('同步需要处理', `发现 ${result.conflicts} 条数据冲突，请打开同步页处理。`);
      else if (result.errors.length > 0) await sendDeviceNotification('自动同步未完成', result.errors[0]!);
    }
    return result;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function installSyncLifecycle(
  store: SqlLedgerStore,
  onApplied: () => void,
  runner: (store: SqlLedgerStore, reason: SyncLifecycleReason) => Promise<LifecycleSyncResult | null> = runLifecycleSync,
): () => void {
  let timer = 0;
  let credentialTimer = 0;
  let writeTimer = 0;
  const run = (reason: SyncLifecycleReason) => {
    void runner(store, reason).then((result) => {
      if (result?.applied) onApplied();
    }).catch((error) => {
      const result: LifecycleSyncResult = {
        reason,
        attempted: 0,
        succeeded: 0,
        pulled: 0,
        pushed: 0,
        applied: 0,
        conflicts: 0,
        rounds: 0,
        converged: false,
        errors: [error instanceof Error ? error.message : String(error)],
        finishedAt: new Date().toISOString(),
      };
      window.dispatchEvent(new CustomEvent(SYNC_LIFECYCLE_RESULT_EVENT, { detail: result }));
    });
  };
  const configureTimer = () => {
    window.clearInterval(timer);
    const config = loadAutoSync();
    if (config.enabled) timer = window.setInterval(() => run('interval'), config.minutes * 60_000);
  };
  const onOnline = () => run('online');
  const onVisibility = () => {
    if (document.visibilityState === 'visible') run('foreground');
  };
  const onCredentials = () => {
    window.clearTimeout(credentialTimer);
    credentialTimer = window.setTimeout(() => run('credentials'), 1_500);
  };
  const unsubscribeWrites = typeof store.subscribe === 'function'
    ? store.subscribe(() => {
      window.clearTimeout(writeTimer);
      writeTimer = window.setTimeout(() => run('write'), 1_500);
    })
    : () => undefined;
  const onConfig = (event: Event) => {
    configureTimer();
    if ((event as CustomEvent<{ kind?: string }>).detail?.kind === 'auto') run('startup');
  };
  configureTimer();
  queueMicrotask(() => run('startup'));
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener(CREDENTIALS_CHANGED_EVENT, onCredentials);
  window.addEventListener(SYNC_CONFIG_CHANGED_EVENT, onConfig);
  return () => {
    window.clearInterval(timer);
    window.clearTimeout(credentialTimer);
    window.clearTimeout(writeTimer);
    unsubscribeWrites();
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener(CREDENTIALS_CHANGED_EVENT, onCredentials);
    window.removeEventListener(SYNC_CONFIG_CHANGED_EVENT, onConfig);
  };
}
