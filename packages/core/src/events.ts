/**
 * Sync protocol v2 primitives.
 *
 * A commit is one atomic business operation. Each aggregate revision names its
 * causal parents explicitly, so concurrent branches cannot be mistaken for a
 * later integer version. Servers only relay encrypted commits; all merge logic
 * remains on trusted clients.
 */

export type SyncRevisionOp = 'put' | 'delete';

export interface SyncRevisionV2 {
  revisionId: string;
  aggregateType: string;
  aggregateId: string;
  parentRevisionIds: string[];
  op: SyncRevisionOp;
  payload: Record<string, unknown> | null;
}

export interface SyncCommitV2 {
  protocol: 2;
  ledgerId: string;
  commitId: string;
  originDeviceId: string;
  originDeviceName?: string;
  createdAt: string;
  parentCommitIds: string[];
  /** Conflict branch commits explicitly subsumed by this merge commit. */
  resolvesConflictCommitIds?: string[];
  revisions: SyncRevisionV2[];
}

export interface SyncCommitEnvelope {
  commitId: string;
  ledgerId: string;
  contentHash: string;
  encCommit: unknown;
}

/** Strip client-local storage metadata before hashing or sending a commit. */
export function wireSyncCommit(commit: SyncCommitV2): SyncCommitV2 {
  return {
    protocol: 2,
    ledgerId: commit.ledgerId,
    commitId: commit.commitId,
    originDeviceId: commit.originDeviceId,
    ...(commit.originDeviceName ? { originDeviceName: commit.originDeviceName } : {}),
    createdAt: commit.createdAt,
    parentCommitIds: [...commit.parentCommitIds],
    ...(commit.resolvesConflictCommitIds?.length
      ? { resolvesConflictCommitIds: [...commit.resolvesConflictCommitIds] }
      : {}),
    revisions: commit.revisions.map((revision) => ({
      revisionId: revision.revisionId,
      aggregateType: revision.aggregateType,
      aggregateId: revision.aggregateId,
      parentRevisionIds: [...revision.parentRevisionIds],
      op: revision.op,
      payload: revision.payload,
    })),
  };
}

export type MergeOutcome =
  | { kind: 'merged'; payload: Record<string, unknown>; changedPaths: string[] }
  | { kind: 'conflict'; changedPaths: string[] };

const LOCAL_METADATA = new Set(['version', 'updatedAt']);

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Remove fields whose meaning is local to one SQLite materialization. */
export function syncPayload(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (LOCAL_METADATA.has(key)) continue;
    if (isRecord(item)) out[key] = syncPayload(item);
    else if (Array.isArray(item)) {
      out[key] = item.map((entry) => isRecord(entry) ? syncPayload(entry) : entry);
    } else out[key] = item;
  }
  return out;
}

function mergeRecord(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  incoming: Record<string, unknown>,
  prefix: string,
): MergeOutcome {
  const merged: Record<string, unknown> = { ...local };
  const changedPaths: string[] = [];
  const conflicts: string[] = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(incoming)]);

  for (const key of keys) {
    if (LOCAL_METADATA.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const before = base[key];
    const ours = local[key];
    const theirs = incoming[key];
    const localChanged = !same(before, ours);
    const incomingChanged = !same(before, theirs);

    if (!incomingChanged) continue;
    changedPaths.push(path);
    if (!localChanged || same(ours, theirs)) {
      if (theirs === undefined) delete merged[key];
      else merged[key] = theirs;
      continue;
    }

    if (isRecord(before) && isRecord(ours) && isRecord(theirs)) {
      const nested = mergeRecord(before, ours, theirs, path);
      if (nested.kind === 'conflict') conflicts.push(...nested.changedPaths);
      else merged[key] = nested.payload;
      continue;
    }

    // Same-field divergent edits are intentionally conservative. Ledger text
    // is user data too, so it must not be discarded by an automatic LWW rule.
    conflicts.push(path);
  }

  if (conflicts.length) return { kind: 'conflict', changedPaths: [...new Set(conflicts)].sort() };
  return { kind: 'merged', payload: merged, changedPaths: [...new Set(changedPaths)].sort() };
}

/** Three-way merge against the common ancestor snapshot. */
export function mergeSyncPayloads(
  base: Record<string, unknown> | null,
  local: Record<string, unknown> | null,
  incoming: Record<string, unknown> | null,
): MergeOutcome {
  if (!local && !incoming) return { kind: 'merged', payload: {}, changedPaths: [] };
  if (!local && incoming && !base) return { kind: 'merged', payload: incoming, changedPaths: Object.keys(incoming).sort() };
  if (local && !incoming && !base) return { kind: 'merged', payload: local, changedPaths: Object.keys(local).sort() };
  if (!local || !incoming) return { kind: 'conflict', changedPaths: ['isDeleted'] };
  if (same(local, incoming)) return { kind: 'merged', payload: local, changedPaths: [] };
  return mergeRecord(base ?? {}, local, incoming, '');
}
