import {
  HttpRequestError,
  httpCommitTransport,
  syncReplicas,
  type CommitTransport,
  type MultiReplicaSyncResult,
  type ReplicaSyncEndpointResult,
  type SqlLedgerStore,
  type SyncReplicaTarget,
} from '@zichan/db';
import {
  buildSyncBaseUrl,
  isUnauthorizedSyncError,
  patchSavedSyncConnection,
  type SyncConnection,
} from './sync-config.js';
import { authenticateSyncProfile } from './sync-auth.js';
import {
  syncAttachmentReplicas,
  type AttachmentReplicaSyncResult,
  type AttachmentSyncResult,
} from './attachment-sync.js';
import { requireLedgerCryptoSession, storedLedgerKeyEnvelope } from './ledger-key-vault.js';
import { accountProtection, protectionRequest } from './account-protection.js';
import { withSyncLock } from './sync-lock.js';
import { clientIdentity } from './client-identity.js';
import { hasNodeReplicaGroup, preferredReplicaProfiles } from './node-replica-routing.js';
import { reportSyncRuns } from './sync-run-reports.js';
import { readBrowserReplicaInventory } from './browser-replica.js';
import { accountLocalStorage } from './account-storage.js';

export interface ConfiguredSyncEndpoint extends ReplicaSyncEndpointResult {
  alias: string;
  url: string;
  latencyMs: number;
  attachments?: AttachmentReplicaSyncResult;
  verificationIssue?: string;
}

export interface ConfiguredSyncResult extends Omit<MultiReplicaSyncResult, 'endpoints'> {
  endpoints: ConfiguredSyncEndpoint[];
  attachmentSync: AttachmentSyncResult;
  syncMode: 'node-group' | 'browser-bridge' | 'single-node';
  finishedAt: string;
}

type MeteredTransport = {
  transport: CommitTransport;
  latencyMs(): number;
  activeUrl(): string;
};

function elapsedSince(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function endpointUnavailable(error: unknown): boolean {
  if (error instanceof HttpRequestError && (error.kind === 'network' || error.kind === 'timeout')) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|fetch failed|network(?: error)?|econn(?:refused|reset|aborted)|enotfound|eai_again|timed? ?out|timeout|HTTP (?:404|408|5\d\d)\b/i.test(message);
}

function identityChanged(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /身份(?:已变化|与已信任记录不一致)|公钥|fingerprint|指纹/i.test(message);
}

function authenticatedTransport(profile: SyncConnection): MeteredTransport {
  const urls = [...new Set([profile.baseUrl, ...profile.alternateUrls].map((baseUrl) => buildSyncBaseUrl({ baseUrl })))];
  let inner: CommitTransport | undefined;
  let activeIndex = 0;
  let measuredMs = 0;

  const create = async (index: number, forceRefresh = false): Promise<CommitTransport> => {
    const baseUrl = urls[index]!;
    const candidate = { ...profile, baseUrl, activeUrl: baseUrl };
    const accessToken = await authenticateSyncProfile(candidate, forceRefresh);
    const keyEnvelope = storedLedgerKeyEnvelope();
    if (!keyEnvelope) throw new Error('本机没有账本密钥包，请先在同步页创建或获取');
    const protection = accountProtection();
    if (protection && protection.info.mode !== 'member' && protection.profileId !== profile.id) {
      const remote = await protectionRequest(candidate);
      if (!remote.controlled && remote.mode === 'managed'
        && remote.envelope?.keyringId === keyEnvelope.keyringId && remote.envelope.generation < keyEnvelope.generation) {
        // Existing authorization follows managed rewrapping. Private transitions
        // revoke custody instead; a relay never receives a plaintext key.
        await protectionRequest(candidate, 'PUT', { version: remote.version, envelope: keyEnvelope,
          ...(protection.info.mode === 'managed' ? { mode: 'managed', secret: protection.secret, confirmation: '允许此服务器解密账本' } : { mode: 'relay' }),
        });
      }
    }
    return httpCommitTransport({
      baseUrl,
      token: accessToken,
      cryptoSession: requireLedgerCryptoSession(keyEnvelope.ledgerId),
      keyEnvelope,
      memberKeyEnvelope: protection?.info.mode === 'member',
      clientIdentity: clientIdentity(),
    });
  };

  const executeAt = async <T>(
    index: number,
    operation: (transport: CommitTransport) => Promise<T>,
    forceRefresh = false,
  ): Promise<T> => {
    let candidate = await create(index, forceRefresh);
    try {
      const result = await operation(candidate);
      inner = candidate;
      activeIndex = index;
      return result;
    } catch (error) {
      if (forceRefresh || !isUnauthorizedSyncError(error)) throw error;
      candidate = await create(index, true);
      const result = await operation(candidate);
      inner = candidate;
      activeIndex = index;
      return result;
    }
  };

  const tryCandidates = async <T>(
    operation: (transport: CommitTransport) => Promise<T>,
    startIndex: number,
  ): Promise<T> => {
    let lastError: unknown = new Error('同步服务器没有可用地址');
    for (let offset = 0; offset < urls.length; offset += 1) {
      const index = (startIndex + offset) % urls.length;
      try {
        return await executeAt(index, operation);
      } catch (error) {
        lastError = error;
        if (identityChanged(error) || isUnauthorizedSyncError(error) || !endpointUnavailable(error)) throw error;
      }
    }
    throw lastError;
  };

  const invoke = async <T>(operation: (transport: CommitTransport) => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      if (!inner) return await tryCandidates(operation, activeIndex);
      try {
        return await operation(inner);
      } catch (error) {
        if (identityChanged(error)) throw error;
        if (endpointUnavailable(error)) {
          inner = undefined;
          return await tryCandidates(operation, (activeIndex + 1) % urls.length);
        }
        if (!isUnauthorizedSyncError(error)) throw error;
        inner = undefined;
        try {
          return await executeAt(activeIndex, operation, true);
        } catch (retryError) {
          if (identityChanged(retryError) || isUnauthorizedSyncError(retryError) || !endpointUnavailable(retryError)) throw retryError;
          return await tryCandidates(operation, (activeIndex + 1) % urls.length);
        }
      }
    } finally {
      measuredMs += elapsedSince(started);
    }
  };

  return {
    transport: {
      connect: (ledgerId) => invoke((transport) => transport.connect(ledgerId)),
      pullCommits: (identity, afterSeq, limit) => invoke((transport) => transport.pullCommits(identity, afterSeq, limit)),
      pushCommits: (identity, commits) => invoke((transport) => transport.pushCommits(identity, commits)),
    },
    latencyMs: () => measuredMs,
    activeUrl: () => urls[activeIndex]!,
  };
}

export function syncConfiguredServers(store: SqlLedgerStore, profiles: SyncConnection[],
  options: { deferAttachmentTransfers?: boolean; skipAttachmentSync?: boolean } = {}): Promise<ConfiguredSyncResult> {
  return withSyncLock(() => syncConfiguredServersNow(store, profiles, options));
}

async function syncConfiguredServersNow(
  store: SqlLedgerStore,
  profiles: SyncConnection[],
  options: { deferAttachmentTransfers?: boolean; skipAttachmentSync?: boolean } = {},
): Promise<ConfiguredSyncResult> {
  const startedAt = performance.now();
  const runId = crypto.randomUUID();
  const selected = profiles.filter((profile) => profile.enabled);
  const meters = new Map<string, MeteredTransport>();
  const targets: SyncReplicaTarget[] = selected.map((profile) => {
    const meter = authenticatedTransport(profile);
    meters.set(profile.id, meter);
    return { id: profile.id, endpoint: buildSyncBaseUrl(profile), transport: meter.transport };
  });
  const ledgerId = typeof store.getLedgerId === 'function' ? await store.getLedgerId() : '';
  const groupProfiles = selected.filter((profile) => !profile.browserBridge);
  const browserProfiles = selected.filter((profile) => profile.browserBridge);
  const nodeGroup = groupProfiles.length > 1 && Boolean(ledgerId)
    && await hasNodeReplicaGroup(groupProfiles, ledgerId);
  if (!nodeGroup && groupProfiles.length > 1) throw new Error('多台普通服务器需要先由管理员组成同步组');
  let result: MultiReplicaSyncResult;
  if (!nodeGroup) {
    result = await syncReplicas(store, targets);
  } else {
    const attempts: MultiReplicaSyncResult[] = [];
    for (const profile of preferredReplicaProfiles(groupProfiles)) {
      const groupTarget = targets.find((item) => item.id === profile.id)!;
      const browserTargets = targets.filter((item) => browserProfiles.some((row) => row.id === item.id));
      const attempt = await syncReplicas(store, [groupTarget, ...browserTargets]);
      attempts.push(attempt);
      if (!attempt.endpoints.find((endpoint) => endpoint.id === groupTarget.id)?.error) break;
    }
    const latest = attempts.at(-1)!;
    const total = (field: 'applied' | 'conflicts' | 'skipped' | 'invalid' | 'pulled' | 'pushed' | 'rounds') =>
      attempts.reduce((sum, attempt) => sum + attempt[field], 0);
    result = { ...latest, applied: total('applied'), conflicts: total('conflicts'),
      skipped: total('skipped'), invalid: total('invalid'), pulled: total('pulled'),
      pushed: total('pushed'), rounds: total('rounds'),
      converged: latest.converged && total('invalid') === 0,
      endpoints: attempts.flatMap((attempt) => attempt.endpoints) };
  }
  let attachmentSync: AttachmentSyncResult;
  try {
    attachmentSync = options.skipAttachmentSync ? {
      endpoints: [], references: 0, localReady: 0, localMissing: 0,
    } : await syncAttachmentReplicas(store, result.endpoints.flatMap((endpoint) => {
      const profile = selected.find((row) => row.id === endpoint.id);
      const meter = meters.get(endpoint.id);
      if (!profile || !meter || !endpoint.identity || endpoint.error) return [];
      const activeUrl = meter.activeUrl();
      return [{
        profile: {
          ...profile,
          baseUrl: activeUrl,
          activeUrl,
          alternateUrls: [...new Set([profile.baseUrl, ...profile.alternateUrls])].filter((url) => url !== activeUrl),
        },
        identity: endpoint.identity,
        headSeq: endpoint.headSeq,
      }];
    }), result.converged && result.invalid === 0, options.deferAttachmentTransfers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    attachmentSync = {
      endpoints: result.endpoints.filter((endpoint) => endpoint.identity && !endpoint.error).map((endpoint) => ({
        profileId: endpoint.id,
        alias: selected.find((profile) => profile.id === endpoint.id)?.alias ?? endpoint.id,
        uploaded: 0,
        downloaded: 0,
        restored: 0,
        deleted: 0,
        available: 0,
        pending: 0,
        failed: 1,
        error: message,
      })),
      references: 0,
      localReady: 0,
      localMissing: 0,
    };
  }
  let verificationIssue: string | undefined;
  const verificationScope = `${ledgerId}:${selected.map((profile) => profile.id).sort().join(',')}`;
  const verificationKey = `zichan.browser-replica-verified:${verificationScope}`;
  const rescanKey = `zichan.browser-replica-rescan:${verificationScope}`;
  const lastVerification = Number(accountLocalStorage?.getItem(verificationKey) ?? 0);
  const verificationDue = !lastVerification || Date.now() - lastVerification > 24 * 60 * 60_000;
  if (browserProfiles.length && verificationDue && result.converged
    && result.endpoints.length > 1 && result.endpoints.every((endpoint) => !endpoint.error)
    && !attachmentSync.endpoints.some((endpoint) => endpoint.error || endpoint.pending || endpoint.failed)) {
    try {
      const checked = await Promise.all(result.endpoints.filter((endpoint) => !endpoint.error)
        .map(async (endpoint) => {
          const profile = selected.find((row) => row.id === endpoint.id)!;
          const inventory = await readBrowserReplicaInventory(profile);
          if (inventory.serverId !== endpoint.identity?.serverId
            || inventory.replicaId !== endpoint.identity.replicaId
            || inventory.streamEpoch !== endpoint.identity.streamEpoch
            || inventory.ledgerId !== ledgerId) throw new Error(`${profile.alias} 的账本身份已变化`);
          return inventory;
        }));
      const first = checked[0];
      if (checked.length > 1 && first) {
        const commitsDiffer = checked.some((row) => row.commitCount !== first.commitCount
          || row.commitHash !== first.commitHash);
        const attachmentsDiffer = checked.some((row) => row.attachmentPromiseCurrent !== 1
          || row.missingPromisedBlobCount !== 0 || row.promisedBlobCount !== first.promisedBlobCount
          || row.promisedBlobHash !== first.promisedBlobHash);
        if (commitsDiffer) {
          verificationIssue = '服务器账目目录不一致；请再次同步以重新核对';
          const last = Number(accountLocalStorage?.getItem(rescanKey) ?? 0);
          if (!last || Date.now() - last > 24 * 60 * 60_000) {
            for (const endpoint of result.endpoints) if (!endpoint.error && endpoint.identity) {
              await store.saveReplicaState(endpoint.identity, 0, endpoint.headSeq);
            }
            accountLocalStorage?.setItem(rescanKey, String(Date.now()));
          }
        } else if (attachmentsDiffer) {
          verificationIssue = '服务器图片目录尚未一致；下次同步会继续补传';
        } else {
          accountLocalStorage?.removeItem(rescanKey);
          accountLocalStorage?.setItem(verificationKey, String(Date.now()));
        }
      }
    } catch (error) {
      verificationIssue = `无法核对服务器目录：${error instanceof Error ? error.message : String(error)}`;
    }
    if (verificationIssue) result.converged = false;
  }
  const finishedAt = new Date().toISOString();
  const endpoints = result.endpoints.map((endpoint): ConfiguredSyncEndpoint => {
    const profile = selected.find((row) => row.id === endpoint.id)!;
    const meter = meters.get(endpoint.id);
    const latencyMs = meter?.latencyMs() ?? 0;
    const activeUrl = meter?.activeUrl() ?? buildSyncBaseUrl(profile);
    const alternateUrls = [...new Set([profile.baseUrl, ...profile.alternateUrls])].filter((url) => url !== activeUrl);
    const attachments = attachmentSync.endpoints.find((row) => row.profileId === endpoint.id);
    if (endpoint.error) {
      const identityChanged = /身份|公钥|fingerprint|指纹/i.test(endpoint.error);
      const replicaRetired = /\bREPLICA_RETIRED\b/.test(endpoint.error);
      patchSavedSyncConnection(profile.id, {
        status: identityChanged ? 'identity_changed' : replicaRetired ? 'replica_retired'
          : isUnauthorizedSyncError(endpoint.error) ? 'login_required' : 'offline',
        lastLatencyMs: latencyMs,
        lastError: endpoint.error,
        lastSyncError: endpoint.error,
      });
    } else {
      const syncError = verificationIssue ?? attachments?.error
        ?? (result.converged ? undefined : '本轮尚未完全收敛，将在下次同步继续');
      patchSavedSyncConnection(profile.id, {
        baseUrl: activeUrl,
        activeUrl,
        alternateUrls,
        serverId: endpoint.identity?.serverId,
        replicaId: endpoint.identity?.replicaId,
        streamEpoch: endpoint.identity?.streamEpoch,
        ledgerId: endpoint.identity?.ledgerId,
        status: 'online',
        lastLatencyMs: latencyMs,
        lastSyncAt: finishedAt,
        lastError: syncError,
        lastSyncError: syncError,
      });
    }
    return { ...endpoint, alias: profile.alias, url: activeUrl, latencyMs, attachments,
      verificationIssue: endpoint.error ? undefined : verificationIssue };
  });
  await reportSyncRuns(selected, endpoints.map((endpoint) => {
    const outcome = endpoint.error ? 'failed'
      : endpoint.pendingPush || endpoint.attachments?.pending || endpoint.attachments?.failed
      || endpoint.attachments?.error || endpoint.verificationIssue || !result.converged ? 'partial' : 'converged';
    return { profileId: endpoint.id, runId, outcome, pulled: endpoint.pulled, pushed: endpoint.pushed,
      attachmentUploads: endpoint.attachments?.uploaded ?? 0,
      attachmentDownloads: endpoint.attachments?.downloaded ?? 0,
      durationMs: elapsedSince(startedAt) };
  })).catch(() => undefined);
  return { ...result, endpoints, attachmentSync,
    syncMode: browserProfiles.length ? 'browser-bridge' : nodeGroup ? 'node-group' : 'single-node', finishedAt };
}
