import { authenticateSyncProfile } from './sync-auth.js';
import { buildSyncBaseUrl, type SyncConnection } from './sync-config.js';

const CERTIFICATE_PREFIX = 'zichan:node-replica-group:';
const SERVER_MANAGED_PREFIX = 'zichan:server-managed-replica-group:';
const MAX_EVIDENCE_AGE_MS = 2 * 60 * 1000;

class ReplicaGroupRejectedError extends Error {}

interface ReplicaLinkSummary {
  peerNodeId: string;
  localStreamEpoch: string;
  peerStreamEpoch: string;
  enabled: boolean;
  lastSuccessAt?: string;
  lastError?: string;
  inventoryMatchedAt?: string;
  inventoryIssue?: string;
}

export interface ReplicaTopology {
  serverId: string;
  bound: boolean;
  ledgerId?: string;
  replicaId?: string;
  streamEpoch?: string;
  headSeq: number;
  links?: ReplicaLinkSummary[];
  readinessState: 'BOOTSTRAPPING' | 'CATCHING_UP' | 'VERIFYING' | 'READY';
  readinessCheckedAt: string;
  readinessIssues?: string[];
  commitCount?: number;
  promisedBlobCount?: number;
  missingPromisedBlobCount?: number;
  serverManagedReplication?: boolean;
}

export interface ReplicaGroupInspection {
  ready: boolean;
  nodes: { profileId: string; alias: string; topology?: ReplicaTopology; error?: string }[];
}

interface ReplicaGroupCertificate {
  ledgerId: string;
  nodes: { serverId: string; replicaId: string; streamEpoch: string }[];
  checkedAt?: string;
}

function certificateKey(ledgerId: string): string {
  return `${CERTIFICATE_PREFIX}${ledgerId}`;
}

function serverManagedKey(ledgerId: string): string {
  return `${SERVER_MANAGED_PREFIX}${ledgerId}`;
}

function serverManagedPreviouslySeen(ledgerId: string): boolean {
  try { return localStorage.getItem(serverManagedKey(ledgerId)) === '1'; }
  catch { return false; }
}

function rememberServerManagedGroup(ledgerId: string): void {
  try { localStorage.setItem(serverManagedKey(ledgerId), '1'); }
  catch { /* Live topology still determines this synchronization run. */ }
}

function recent(value: string | undefined, now: number): boolean {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) && at <= now + 30_000 && now - at <= MAX_EVIDENCE_AGE_MS;
}

/** Certify only a connected, recently reconciled group; older browser bridge targets stay separate. */
export function verifiedReplicaGroup(topologies: ReplicaTopology[], ledgerId: string,
  now = Date.now()): ReplicaGroupCertificate | undefined {
  if (topologies.length < 2 || topologies.some((node) => !node.bound || node.ledgerId !== ledgerId
    || !node.serverId || !node.replicaId || !node.streamEpoch || !Number.isSafeInteger(node.headSeq)
    || node.readinessState !== 'READY' || !recent(node.readinessCheckedAt, now))) return undefined;
  const byId = new Map(topologies.map((node) => [node.serverId, node]));
  if (byId.size !== topologies.length) return undefined;
  const connected = new Set<string>([topologies[0]!.serverId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of topologies) for (const link of node.links ?? []) {
      const peer = byId.get(link.peerNodeId);
      if (!peer || !link.enabled || link.localStreamEpoch !== node.streamEpoch
        || link.peerStreamEpoch !== peer.streamEpoch || link.lastError || link.inventoryIssue
        || !recent(link.lastSuccessAt, now) || !recent(link.inventoryMatchedAt, now)) continue;
      if (connected.has(node.serverId) && !connected.has(peer.serverId)) {
        connected.add(peer.serverId);
        changed = true;
      } else if (connected.has(peer.serverId) && !connected.has(node.serverId)) {
        connected.add(node.serverId);
        changed = true;
      }
    }
  }
  if (connected.size !== topologies.length) return undefined;
  return { ledgerId, checkedAt: new Date(now).toISOString(),
    nodes: topologies.map((node) => ({ serverId: node.serverId,
    replicaId: node.replicaId!, streamEpoch: node.streamEpoch! }))
    .sort((left, right) => left.serverId.localeCompare(right.serverId)) };
}

function certificateMatches(value: ReplicaGroupCertificate, profiles: SyncConnection[], ledgerId: string): boolean {
  if (value.ledgerId !== ledgerId || !Array.isArray(value.nodes) || value.nodes.length !== profiles.length) return false;
  const nodes = new Map(value.nodes.map((node) => [node.serverId, node]));
  return nodes.size === profiles.length && profiles.every((profile) => {
    const node = nodes.get(profile.serverId ?? '');
    return node && (!profile.replicaId || profile.replicaId === node.replicaId)
      && (!profile.streamEpoch || profile.streamEpoch === node.streamEpoch);
  });
}

function storedCertificate(profiles: SyncConnection[], ledgerId: string): ReplicaGroupCertificate | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(certificateKey(ledgerId)) ?? 'null') as ReplicaGroupCertificate | null;
    return value && certificateMatches(value, profiles, ledgerId) ? value : undefined;
  } catch { return undefined; }
}

export function invalidateReplicaGroupCertificate(ledgerId: string): void {
  try { localStorage.removeItem(certificateKey(ledgerId)); }
  catch { /* The next live inspection remains authoritative. */ }
}

async function readTopology(profile: SyncConnection): Promise<ReplicaTopology> {
  const token = await authenticateSyncProfile(profile);
  const headers = { Authorization: `Bearer ${token}` };
  const [response, readinessResponse] = await Promise.all([
    fetch(`${buildSyncBaseUrl(profile)}/api/v3/replica`, {
      headers, credentials: 'omit', redirect: 'error',
    }),
    fetch(`${buildSyncBaseUrl(profile)}/api/v4/ledger/readiness`, {
      headers, credentials: 'omit', redirect: 'error',
    }),
  ]);
  if (!response.ok) throw response.status >= 400 && response.status < 500
    ? new ReplicaGroupRejectedError(`副本拓扑读取失败：HTTP ${response.status}`)
    : new Error(`副本拓扑读取失败：HTTP ${response.status}`);
  if (!readinessResponse.ok) throw readinessResponse.status >= 400 && readinessResponse.status < 500
    ? new ReplicaGroupRejectedError(`副本完整性读取失败：HTTP ${readinessResponse.status}`)
    : new Error(`副本完整性读取失败：HTTP ${readinessResponse.status}`);
  const topology = await response.json() as ReplicaTopology;
  const readiness = await readinessResponse.json() as { state?: ReplicaTopology['readinessState'];
    checkedAt?: string; issues?: string[]; commitCount?: number; promisedBlobCount?: number;
    missingPromisedBlobCount?: number };
  if (topology.serverId !== profile.serverId
    || profile.ledgerId && topology.ledgerId !== profile.ledgerId
    || profile.replicaId && topology.replicaId !== profile.replicaId
    || profile.streamEpoch && topology.streamEpoch !== profile.streamEpoch) {
    throw new ReplicaGroupRejectedError('副本拓扑身份与已信任记录不一致');
  }
  return { ...topology, readinessState: readiness.state ?? 'VERIFYING',
    readinessCheckedAt: readiness.checkedAt ?? '', readinessIssues: readiness.issues ?? [],
    commitCount: readiness.commitCount, promisedBlobCount: readiness.promisedBlobCount,
    missingPromisedBlobCount: readiness.missingPromisedBlobCount };
}

/** Read every configured node now; a past certificate is not live health evidence. */
export async function inspectReplicaGroup(profiles: SyncConnection[], ledgerId: string): Promise<ReplicaGroupInspection> {
  const results = await Promise.allSettled(profiles.map(readTopology));
  const nodes: ReplicaGroupInspection['nodes'] = results.map((result, index) => ({
    profileId: profiles[index]!.id, alias: profiles[index]!.alias,
    ...(result.status === 'fulfilled' ? { topology: result.value } : {
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    }),
  }));
  const topologies = nodes.flatMap((node) => node.topology ? [node.topology] : []);
  return { ready: topologies.length === profiles.length
    && Boolean(verifiedReplicaGroup(topologies, ledgerId)), nodes };
}

/** Once a ledger uses node replication, the browser must never become its peer transport. */
export async function hasNodeReplicaGroup(profiles: SyncConnection[], ledgerId: string): Promise<boolean> {
  if (profiles.length < 2) return false;
  if (serverManagedPreviouslySeen(ledgerId)) return true;
  const previous = storedCertificate(profiles, ledgerId);
  if (previous) {
    rememberServerManagedGroup(ledgerId);
    return true;
  }
  const candidates = profiles.filter((profile) => profile.serverId
    && (!profile.ledgerId || profile.ledgerId === ledgerId));
  if (!candidates.length) return false;
  const results = await Promise.allSettled(candidates.map(readTopology));
  if (results.some((result) => result.status === 'fulfilled'
    && result.value.serverManagedReplication === true)) {
    rememberServerManagedGroup(ledgerId);
    return true;
  }
  if (results.some((result) => result.status === 'rejected'
    && result.reason instanceof ReplicaGroupRejectedError)) {
    invalidateReplicaGroupCertificate(ledgerId);
    return false;
  }
  if (results.some((result) => result.status === 'rejected')) return false;
  if (candidates.length !== profiles.length) return false;
  const certificate = verifiedReplicaGroup(results.map((result) =>
    (result as PromiseFulfilledResult<ReplicaTopology>).value), ledgerId);
  if (!certificate) {
    invalidateReplicaGroupCertificate(ledgerId);
    return false;
  }
  try { localStorage.setItem(certificateKey(ledgerId), JSON.stringify(certificate)); }
  catch { /* The current run can still use the verified topology. */ }
  rememberServerManagedGroup(ledgerId);
  return true;
}

export function preferredReplicaProfiles(profiles: SyncConnection[]): SyncConnection[] {
  const page = globalThis.document?.baseURI ?? globalThis.location?.href;
  return [...profiles].sort((left, right) => {
    const siteScore = (profile: SyncConnection): number => {
      if (!page) return 0;
      try {
        const site = new URL(page);
        const node = new URL(buildSyncBaseUrl(profile));
        return site.origin === node.origin && site.pathname.startsWith(`${node.pathname.replace(/\/$/, '')}/`) ? node.pathname.length : 0;
      } catch { return 0; }
    };
    return siteScore(right) - siteScore(left)
      || (left.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (right.lastLatencyMs ?? Number.MAX_SAFE_INTEGER);
  });
}
