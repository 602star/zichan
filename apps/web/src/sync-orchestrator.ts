import {
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
  patchSavedSyncProfile,
  type SyncServerProfile,
} from './sync-config.js';
import { authenticateSyncProfile } from './sync-auth.js';
import {
  syncAttachmentReplicas,
  type AttachmentReplicaSyncResult,
  type AttachmentSyncResult,
} from './attachment-sync.js';
import { requireLedgerCryptoSession, storedLedgerKeyEnvelope } from './ledger-key-vault.js';

export interface ConfiguredSyncEndpoint extends ReplicaSyncEndpointResult {
  alias: string;
  url: string;
  latencyMs: number;
  attachments?: AttachmentReplicaSyncResult;
}

export interface ConfiguredSyncResult extends Omit<MultiReplicaSyncResult, 'endpoints'> {
  endpoints: ConfiguredSyncEndpoint[];
  attachmentSync: AttachmentSyncResult;
  finishedAt: string;
}

type MeteredTransport = {
  transport: CommitTransport;
  latencyMs(): number;
};

function elapsedSince(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function authenticatedTransport(profile: SyncServerProfile): MeteredTransport {
  const baseUrl = buildSyncBaseUrl(profile);
  let inner: CommitTransport | undefined;
  let measuredMs = 0;

  const create = async (forceLogin = false): Promise<CommitTransport> => {
    const accessToken = await authenticateSyncProfile(profile, forceLogin);
    const keyEnvelope = storedLedgerKeyEnvelope();
    if (!keyEnvelope) throw new Error('本机没有账本密钥包，请先在同步页创建或获取');
    inner = httpCommitTransport({
      baseUrl,
      token: accessToken,
      cryptoSession: requireLedgerCryptoSession(keyEnvelope.ledgerId),
      keyEnvelope,
    });
    return inner;
  };

  const current = async (): Promise<CommitTransport> => inner ?? create();
  const invoke = async <T>(operation: (transport: CommitTransport) => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      try {
        return await operation(await current());
      } catch (error) {
        if (!isUnauthorizedSyncError(error)) throw error;
        inner = undefined;
        return await operation(await create(true));
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
  };
}

export async function syncConfiguredServers(
  store: SqlLedgerStore,
  profiles: SyncServerProfile[],
): Promise<ConfiguredSyncResult> {
  const selected = profiles.filter((profile) => profile.enabled);
  const meters = new Map<string, MeteredTransport>();
  const targets: SyncReplicaTarget[] = selected.map((profile) => {
    const meter = authenticatedTransport(profile);
    meters.set(profile.id, meter);
    return { id: profile.id, endpoint: buildSyncBaseUrl(profile), transport: meter.transport };
  });
  const result = await syncReplicas(store, targets);
  let attachmentSync: AttachmentSyncResult;
  try {
    attachmentSync = await syncAttachmentReplicas(store, result.endpoints.flatMap((endpoint) => {
      const profile = selected.find((row) => row.id === endpoint.id);
      return profile && endpoint.identity && !endpoint.error ? [{ profile, identity: endpoint.identity }] : [];
    }));
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
  const finishedAt = new Date().toISOString();
  const endpoints = result.endpoints.map((endpoint): ConfiguredSyncEndpoint => {
    const profile = selected.find((row) => row.id === endpoint.id)!;
    const latencyMs = meters.get(endpoint.id)?.latencyMs() ?? 0;
    const attachments = attachmentSync.endpoints.find((row) => row.profileId === endpoint.id);
    if (endpoint.error) {
      patchSavedSyncProfile(profile.id, {
        lastStatus: isUnauthorizedSyncError(endpoint.error) ? 'unauthorized' : 'offline',
        lastLatencyMs: latencyMs,
        lastError: endpoint.error,
      });
    } else {
      patchSavedSyncProfile(profile.id, {
        serverId: endpoint.identity?.serverId,
        replicaId: endpoint.identity?.replicaId,
        streamEpoch: endpoint.identity?.streamEpoch,
        ledgerId: endpoint.identity?.ledgerId,
        lastStatus: 'online',
        lastLatencyMs: latencyMs,
        lastSyncAt: finishedAt,
        lastError: attachments?.error ?? (result.converged ? undefined : '本轮尚未完全收敛，将在下次同步继续'),
      });
    }
    return { ...endpoint, alias: profile.alias, url: buildSyncBaseUrl(profile), latencyMs, attachments };
  });
  return { ...result, endpoints, attachmentSync, finishedAt };
}
