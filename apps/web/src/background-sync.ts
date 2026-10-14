import { type SqlLedgerStore } from '@zichan/db';
import { runtimeCredential, CREDENTIALS_CHANGED_EVENT } from './credential-vault.js';
import { readDevicePreferences, sendDeviceNotification } from './device-capabilities.js';
import { getDeviceId, registerSync } from './db/cloud.js';
import {
  loadAutoSync,
  loadSyncConnections,
  patchSavedSyncConnection,
  SYNC_CONFIG_CHANGED_EVENT,
} from './sync-config.js';
import { syncConfiguredServers } from './sync-orchestrator.js';
import { runtimeLedgerCryptoSession } from './ledger-key-vault.js';
import { hasAccountSession } from './sync-auth.js';
import { ATTACHMENT_BATCH_EVENT, syncAttachmentBatch, type AttachmentBatchResult } from './attachment-sync.js';

export type SyncLifecycleReason = 'startup' | 'interval' | 'online' | 'foreground' | 'credentials' | 'write' | 'attachment-catalog';

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

function attachmentEndpointUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|fetch failed|network(?: error)?|econn(?:refused|reset|aborted)|enotfound|eai_again|timed? ?out|timeout|HTTP (?:404|408|5\d\d)\b/i.test(message);
}

let inFlight: Promise<LifecycleSyncResult | null> | null = null;
let lastAttemptAt = 0;

export function runLifecycleSync(store: SqlLedgerStore, reason: SyncLifecycleReason): Promise<LifecycleSyncResult | null> {
  const config = loadAutoSync();
  if (!config.enabled || !navigator.onLine) return Promise.resolve(null);
  if (!runtimeLedgerCryptoSession()) return Promise.resolve(null);
  const now = Date.now();
  if (inFlight) return inFlight;
  if (reason !== 'interval' && reason !== 'credentials' && reason !== 'write'
    && reason !== 'attachment-catalog' && now - lastAttemptAt < 5_000) return Promise.resolve(null);
  const profiles = loadSyncConnections().filter((profile) => profile.enabled && profile.username.trim() && hasAccountSession(runtimeCredential(profile.id)));
  if (profiles.length === 0) return Promise.resolve(null);
  lastAttemptAt = now;
  inFlight = (async () => {
    const result: LifecycleSyncResult = {
      reason, attempted: profiles.length, succeeded: 0, pulled: 0, pushed: 0, applied: 0,
      conflicts: 0, rounds: 0, converged: false, errors: [], finishedAt: '',
    };
    const synced = await syncConfiguredServers(store, profiles, {
      deferAttachmentTransfers: true,
      skipAttachmentSync: reason !== 'attachment-catalog',
    });
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
  let attachmentTimer = 0;
  let disposed = false;
  let running = false;
  let attachmentRunning = false;
  let attachmentSweepFinished = false;
  let attachmentRescanNeeded = false;
  const attachmentComplete = new Set<string>();
  const attachmentConfigSignature = () => JSON.stringify(loadSyncConnections().map((profile) => [
    profile.id, profile.enabled, profile.username, profile.ledgerId, profile.serverId,
    profile.replicaId, profile.streamEpoch,
    ...[...new Set([profile.baseUrl, ...profile.alternateUrls])].sort(),
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
  let lastAttachmentConfigSignature = attachmentConfigSignature();
  let pendingWrite = false;
  const scheduleAttachments = (delay: number) => {
    if (disposed || runner !== runLifecycleSync) return;
    window.clearTimeout(attachmentTimer);
    attachmentTimer = window.setTimeout(() => { void runAttachmentBatch(); }, delay);
  };
  const runAttachmentBatch = async () => {
    if (disposed || running || attachmentRunning || !loadAutoSync().enabled || !navigator.onLine
      || document.visibilityState !== 'visible' || !runtimeLedgerCryptoSession()) return;
    attachmentRunning = true;
    let activeProfileId = '';
    try {
      const ledgerId = await store.getLedgerId();
      const profiles = loadSyncConnections().filter((profile) => profile.enabled && !attachmentComplete.has(profile.id)
        && profile.ledgerId === ledgerId && profile.serverId && profile.replicaId && profile.streamEpoch
        && hasAccountSession(runtimeCredential(profile.id)));
      const profile = profiles[0];
      if (!profile) {
        if (attachmentRescanNeeded) {
          attachmentRescanNeeded = false;
          attachmentComplete.clear();
          scheduleAttachments(1_000);
          return;
        }
        if (attachmentSweepFinished) { attachmentSweepFinished = false; run('attachment-catalog'); }
        return;
      }
      activeProfileId = profile.id;
      const addresses = [...new Set([profile.baseUrl, ...profile.alternateUrls])];
      let batch: AttachmentBatchResult | undefined;
      let lastError: unknown;
      for (const baseUrl of addresses) {
        try {
          batch = await syncAttachmentBatch(store, {
            profile: { ...profile, baseUrl, activeUrl: baseUrl },
            identity: { serverId: profile.serverId!, replicaId: profile.replicaId!,
              streamEpoch: profile.streamEpoch!, ledgerId },
          });
          if (baseUrl !== profile.baseUrl) patchSavedSyncConnection(profile.id, {
            baseUrl, activeUrl: baseUrl,
            alternateUrls: addresses.filter((address) => address !== baseUrl),
          });
          break;
        } catch (error) {
          lastError = error;
          if (!attachmentEndpointUnavailable(error)) throw error;
        }
      }
      if (!batch) throw lastError ?? new Error('附件批次没有可用的服务器地址');
      if (batch.sweepComplete) {
        attachmentComplete.add(profile.id);
        attachmentSweepFinished = true;
      }
    } catch (error) {
      const failed: AttachmentBatchResult = {
        profileId: activeProfileId, references: 0, scannedThrough: 0,
        scanned: 0, uploaded: 0, downloaded: 0, failed: 1,
        bytesUploaded: 0, bytesDownloaded: 0,
        sweepComplete: false, error: error instanceof Error ? error.message : String(error),
      };
      window.dispatchEvent(new CustomEvent(ATTACHMENT_BATCH_EVENT, { detail: failed }));
      if (activeProfileId) {
        attachmentComplete.add(activeProfileId);
        scheduleAttachments(1_000);
      }
      // Keep commit sync independent of attachment transfer; retry this profile next lifecycle wakeup.
      return;
    } finally {
      attachmentRunning = false;
    }
    scheduleAttachments(1_000);
  };
  const run = (reason: SyncLifecycleReason) => {
    if (disposed) return;
    if (running) { if (reason === 'write') pendingWrite = true; return; }
    running = true;
    void runner(store, reason).then((result) => {
      if (!disposed && result?.applied) onApplied();
      if (!disposed) scheduleAttachments(1_000);
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
      if (!disposed) window.dispatchEvent(new CustomEvent(SYNC_LIFECYCLE_RESULT_EVENT, { detail: result }));
    }).finally(() => {
      running = false;
      if (pendingWrite && !disposed) { pendingWrite = false; run('write'); }
    });
  };
  const configureTimer = () => {
    window.clearInterval(timer);
    const config = loadAutoSync();
    if (config.enabled) timer = window.setInterval(() => {
      attachmentComplete.clear();
      run('interval');
    }, config.minutes * 60_000);
  };
  const onOnline = () => { attachmentComplete.clear(); run('online'); };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') { attachmentComplete.clear(); run('foreground'); }
  };
  const onCredentials = () => {
    attachmentComplete.clear();
    window.clearTimeout(credentialTimer);
    credentialTimer = window.setTimeout(() => run('credentials'), 1_500);
  };
  const unsubscribeWrites = typeof store.subscribe === 'function'
    ? store.subscribe(() => {
      attachmentRescanNeeded = true;
      if (running) { pendingWrite = true; return; }
      window.clearTimeout(writeTimer);
      writeTimer = window.setTimeout(() => run('write'), 1_500);
    })
    : () => undefined;
  const onConfig = (event: Event) => {
    const kind = (event as CustomEvent<{ kind?: string }>).detail?.kind;
    const signature = attachmentConfigSignature();
    if (signature !== lastAttachmentConfigSignature) {
      lastAttachmentConfigSignature = signature;
      attachmentComplete.clear();
      scheduleAttachments(1_000);
    }
    if (kind === 'auto' || kind === 'reset') configureTimer();
    if (kind === 'auto') run('startup');
  };
  configureTimer();
  queueMicrotask(() => run('startup'));
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener(CREDENTIALS_CHANGED_EVENT, onCredentials);
  window.addEventListener(SYNC_CONFIG_CHANGED_EVENT, onConfig);
  return () => {
    disposed = true;
    pendingWrite = false;
    window.clearInterval(timer);
    window.clearTimeout(credentialTimer);
    window.clearTimeout(writeTimer);
    window.clearTimeout(attachmentTimer);
    unsubscribeWrites();
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener(CREDENTIALS_CHANGED_EVENT, onCredentials);
    window.removeEventListener(SYNC_CONFIG_CHANGED_EVENT, onConfig);
  };
}
