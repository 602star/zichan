import { legacyWebAccountNamespace, webLedgerNamespace } from './account-storage.js';
import { hasKv } from './db/idb.js';

interface LedgerBinding {
  serverId?: string;
  accountId?: string;
  ledgerId?: string;
  replicaId?: string;
}

const PRIMARY_REPLICA_PREFIX = 'zichan.account.primary-replica.v1:';
const LEGACY_ENVELOPE_KEY = 'zichan.ledger.keyEnvelope.v1';
const LEGACY_DEVICE_RECOVERY_KEY = 'zichan.account.device-recovery.v1';
const LEGACY_CONNECTIONS_KEY = 'zichan.sync.connections.v1';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try { return record(JSON.parse(value)); } catch { return undefined; }
}

function legacyReplicaCandidates(serverId: string, accountId: string, ledgerId: string | undefined,
  namespace: string): Map<string, string> {
  const candidates = new Map<string, string>();
  const document = parseRecord(globalThis.localStorage?.getItem(`${namespace}${LEGACY_CONNECTIONS_KEY}`) ?? null);
  const servers = Array.isArray(document?.['servers']) ? document['servers'] : [];
  const connections = Array.isArray(document?.['connections']) ? document['connections'] : [];
  const matchingRefs = new Set(servers.flatMap((item) => {
    const server = record(item);
    return server?.['serverId'] === serverId && typeof server['id'] === 'string' ? [server['id']] : [];
  }));
  for (const item of connections) {
    const connection = record(item);
    if (connection && matchingRefs.has(connection['serverRef'] as string)
      && connection['accountId'] === accountId && typeof connection['ledgerId'] === 'string'
      && (!ledgerId || connection['ledgerId'] === ledgerId)
      && typeof connection['replicaId'] === 'string') {
      candidates.set(connection['replicaId'], connection['ledgerId']);
    }
  }
  return candidates;
}

export interface WebLedgerNamespaceChoice {
  namespace: string;
  primaryReplicaId?: string;
  legacyOccupied: boolean;
}

/** Identify the old cache from ledger metadata without decrypting or moving its large payload. */
export async function resolveWebLedgerNamespace(serverId: string, accountId: string,
  selected: { ledgerId?: string; replicaId?: string }, binding?: LedgerBinding): Promise<WebLedgerNamespaceChoice> {
  const legacy = legacyWebAccountNamespace(serverId, accountId);
  const markerKey = `${PRIMARY_REPLICA_PREFIX}${encodeURIComponent(serverId)}:${encodeURIComponent(accountId)}`;
  const hasSnapshot = globalThis.indexedDB
    ? await hasKv('ledger.sqlite', `${legacy}database`) : false;
  const storedEnvelope = globalThis.localStorage?.getItem(`${legacy}${LEGACY_ENVELOPE_KEY}`) ?? null;
  const envelope = parseRecord(storedEnvelope);
  const envelopeLedgerId = typeof envelope?.['ledgerId'] === 'string' ? envelope['ledgerId'] : undefined;
  const recovery = parseRecord(globalThis.localStorage?.getItem(`${legacy}${LEGACY_DEVICE_RECOVERY_KEY}`) ?? null);
  const recoveryLedgerId = typeof recovery?.['ledgerId'] === 'string' ? recovery['ledgerId'] : undefined;
  // The encrypted snapshot's storageId identifies the device key, not the ledger.
  const legacyLedgerId = envelopeLedgerId ?? recoveryLedgerId;
  const storage = globalThis.localStorage;
  const legacyOccupied = hasSnapshot || storedEnvelope !== null
    || Array.from({ length: storage?.length ?? 0 }, (_, index) => storage?.key(index))
      .some((key) => key?.startsWith(legacy));
  const marker = parseRecord(globalThis.localStorage?.getItem(markerKey) ?? null);
  const markerReplicaId = typeof marker?.['replicaId'] === 'string' ? marker['replicaId'] : undefined;
  const markerLedgerId = typeof marker?.['ledgerId'] === 'string' ? marker['ledgerId'] : undefined;
  let primaryReplicaId: string | undefined;
  let primaryLedgerId = legacyLedgerId;
  if (markerReplicaId && (!legacyLedgerId || markerLedgerId === legacyLedgerId)) {
    primaryReplicaId = markerReplicaId;
  } else if (!markerReplicaId && legacyOccupied) {
    const candidates = legacyReplicaCandidates(serverId, accountId, legacyLedgerId, legacy);
    if (candidates.size === 1) {
      const [replicaId, ledgerId] = [...candidates][0]!;
      primaryReplicaId = replicaId;
      primaryLedgerId = ledgerId;
    }
    else if (candidates.size === 0 && legacyLedgerId
      && binding?.serverId === serverId && binding.accountId === accountId
      && binding.ledgerId === legacyLedgerId && binding.replicaId) primaryReplicaId = binding.replicaId;
  } else if (!legacyOccupied) {
    primaryReplicaId = selected.replicaId;
  }
  const namespace = webLedgerNamespace(serverId, accountId, selected.replicaId,
    primaryReplicaId, legacyOccupied);
  if (primaryReplicaId && !markerReplicaId) {
    globalThis.localStorage?.setItem(markerKey, JSON.stringify({
      ledgerId: primaryLedgerId ?? selected.ledgerId ?? null, replicaId: primaryReplicaId,
    }));
  }
  return { namespace, primaryReplicaId, legacyOccupied };
}
