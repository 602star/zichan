/**
 * Sync protocol v2. Commits form a causal DAG and each aggregate revision names
 * its parents. Remote commits are persisted before cursors move, then applied in
 * dependency order. Conflicted commits and every descendant remain quarantined
 * until one explicit merge commit resolves all branch tips.
 */
import {
  mergeSyncPayloads,
  newId,
  sha256Json,
  wireSyncCommit,
  type SyncCommitV2,
  type SyncRevisionV2,
} from '@zichan/core';
import type { SqlLedgerStore } from './repository.js';
import { rebuildConversionDerivedInTransaction } from './services.js';
import { syncAggregateApplyPriority } from './domain-validation.js';
import {
  aggregateKey,
  replicaKey,
  type StoredSyncCommit,
  type SyncConflictBranchRow,
  type SyncConflictGroupRow,
  type SyncGraph,
  type SyncReplicaIdentity,
} from './sync-types.js';

export type { SyncConflictBranchRow, SyncConflictGroupRow, SyncReplicaIdentity } from './sync-types.js';

export interface ReplicaConnection extends SyncReplicaIdentity {
  headSeq: number;
}

export interface PulledCommitRow {
  seq: number;
  commit: SyncCommitV2;
  contentHash: string;
}

export interface CommitTransport {
  connect(ledgerId: string): Promise<ReplicaConnection>;
  pullCommits(identity: SyncReplicaIdentity, afterSeq: number, limit?: number): Promise<{
    commits: PulledCommitRow[];
    nextSeq: number;
    headSeq: number;
    hasMore: boolean;
  }>;
  pushCommits(identity: SyncReplicaIdentity, commits: SyncCommitV2[]): Promise<{
    assigned: { commitId: string; seq: number; contentHash: string }[];
    headSeq: number;
  }>;
}

function syncApplyOrder(
  left: { aggregateType: string; op: 'put' | 'delete'; payload: Record<string, unknown> | null },
  right: { aggregateType: string; op: 'put' | 'delete'; payload: Record<string, unknown> | null },
): number {
  const priority = syncAggregateApplyPriority(left.aggregateType, left.op)
    - syncAggregateApplyPriority(right.aggregateType, right.op);
  if (priority) return priority;
  if (left.aggregateType === 'transaction' && right.aggregateType === 'transaction') {
    const leftRefund = (left.payload?.['transaction'] as Record<string, unknown> | undefined)?.['type'] === 'refund';
    const rightRefund = (right.payload?.['transaction'] as Record<string, unknown> | undefined)?.['type'] === 'refund';
    if (leftRefund !== rightRefund) {
      const deleting = left.op === 'delete' && right.op === 'delete';
      return leftRefund === deleting ? -1 : 1;
    }
  }
  return 0;
}

export interface ApplyCommitsResult {
  applied: number;
  conflicts: number;
  skipped: number;
  invalid: number;
  pending: number;
}

export interface CommitSyncResult extends ApplyCommitsResult {
  pushed: number;
  pulled: number;
  identity: SyncReplicaIdentity;
  endpoint: string;
}

export interface SyncReplicaTarget {
  id: string;
  endpoint: string;
  transport: CommitTransport;
}

export interface ReplicaSyncEndpointResult {
  id: string;
  endpoint: string;
  identity?: SyncReplicaIdentity;
  pulled: number;
  pushed: number;
  headSeq: number;
  cursor: number;
  pendingPush: number;
  error?: string;
}

export interface MultiReplicaSyncResult extends ApplyCommitsResult {
  pulled: number;
  pushed: number;
  rounds: number;
  converged: boolean;
  endpoints: ReplicaSyncEndpointResult[];
}

type RevisionDecision = {
  revision: SyncRevisionV2;
  action: 'apply' | 'skip' | 'conflict';
  payload: Record<string, unknown> | null;
  nextHeads: string[];
  changedPaths: string[];
};

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function safeSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

async function assertPulledPage(
  identity: SyncReplicaIdentity,
  afterSeq: number,
  page: Awaited<ReturnType<CommitTransport['pullCommits']>>,
): Promise<void> {
  if (!safeSequence(page.nextSeq) || !safeSequence(page.headSeq)) throw new Error('同步服务器返回了无效游标');
  if (page.commits.length > 200) throw new Error('同步服务器返回的提交分页超过上限');
  const ids = new Set<string>();
  let expectedSeq = afterSeq;
  for (const row of page.commits) {
    expectedSeq += 1;
    if (!safeSequence(row.seq) || row.seq !== expectedSeq) throw new Error(`同步服务器提交序号不连续：期望 ${expectedSeq}，收到 ${row.seq}`);
    if (ids.has(row.commit.commitId)) throw new Error(`同步服务器在同一分页重复返回提交 ${row.commit.commitId}`);
    ids.add(row.commit.commitId);
    if (row.commit.protocol !== 2) throw new Error(`同步提交 ${row.commit.commitId} 协议版本无效`);
    if (row.commit.ledgerId !== identity.ledgerId) throw new Error(`LEDGER_MISMATCH:${row.commit.ledgerId}`);
    const actualHash = await sha256Json(wireSyncCommit(row.commit));
    if (actualHash !== row.contentHash) throw new Error(`同步提交 ${row.commit.commitId} 内容哈希不一致`);
  }
  if (page.nextSeq !== expectedSeq) throw new Error(`同步服务器游标跳跃：期望 ${expectedSeq}，收到 ${page.nextSeq}`);
  if (page.headSeq < page.nextSeq) throw new Error('同步服务器远端头小于返回游标');
  if (page.hasMore !== (page.nextSeq < page.headSeq)) throw new Error('同步服务器分页状态与远端头不一致');
}

async function assertPushAcknowledgements(
  commits: SyncCommitV2[],
  response: Awaited<ReturnType<CommitTransport['pushCommits']>>,
): Promise<void> {
  const expected = new Map<string, string>();
  for (const commit of commits) expected.set(commit.commitId, await sha256Json(wireSyncCommit(commit)));
  if (response.assigned.length !== expected.size) throw new Error('同步服务器没有确认完整的提交批次');
  const seen = new Set<string>();
  let maxSeq = 0;
  for (const ack of response.assigned) {
    if (seen.has(ack.commitId)) throw new Error(`同步服务器重复确认提交 ${ack.commitId}`);
    seen.add(ack.commitId);
    const hash = expected.get(ack.commitId);
    if (!hash) throw new Error(`同步服务器确认了未发送的提交 ${ack.commitId}`);
    if (ack.contentHash !== hash) throw new Error(`同步服务器对提交 ${ack.commitId} 返回了错误哈希`);
    if (!Number.isSafeInteger(ack.seq) || ack.seq <= 0) throw new Error(`同步服务器对提交 ${ack.commitId} 返回了无效序号`);
    maxSeq = Math.max(maxSeq, ack.seq);
  }
  if (!safeSequence(response.headSeq) || response.headSeq < maxSeq) throw new Error('同步服务器返回的提交头无效');
}

function revisionParents(graph: SyncGraph, id: string): string[] {
  return graph.revisions.get(id)?.parentRevisionIds ?? [];
}

function commitParents(graph: SyncGraph, id: string): string[] {
  return graph.commits.get(id)?.parentCommitIds ?? [];
}

function isAncestor(start: string, target: string, parents: (id: string) => string[]): boolean {
  if (start === target) return true;
  const seen = new Set<string>();
  const queue = [...parents(target)];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === start) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...parents(current));
  }
  return false;
}

function distances(starts: string[], parents: (id: string) => string[]): Map<string, number> {
  const out = new Map<string, number>();
  const queue = starts.map((id) => ({ id, distance: 0 }));
  while (queue.length) {
    const current = queue.shift()!;
    const known = out.get(current.id);
    if (known !== undefined && known <= current.distance) continue;
    out.set(current.id, current.distance);
    for (const parent of parents(current.id)) queue.push({ id: parent, distance: current.distance + 1 });
  }
  return out;
}

function nearestCommonRevision(graph: SyncGraph, left: string[], right: string[]): string | undefined {
  const a = distances(left, (id) => revisionParents(graph, id));
  const b = distances(right, (id) => revisionParents(graph, id));
  let best: { id: string; score: number } | undefined;
  for (const [id, da] of a) {
    const db = b.get(id);
    if (db === undefined) continue;
    const score = da + db;
    if (!best || score < best.score || (score === best.score && id < best.id)) best = { id, score };
  }
  return best?.id;
}

function commitForRevision(graph: SyncGraph, revisionId: string): StoredSyncCommit | undefined {
  for (const commit of graph.commits.values()) {
    if (commit.revisions.some((revision) => revision.revisionId === revisionId)) return commit;
  }
  return undefined;
}

function isDeletedPayload(type: string, payload: Record<string, unknown> | null): boolean {
  if (!payload) return true;
  if (type === 'conversion') return (payload['chain'] as Record<string, unknown> | undefined)?.['isDeleted'] === true;
  if (type === 'transaction') return (payload['transaction'] as Record<string, unknown> | undefined)?.['isDeleted'] === true;
  return payload['isDeleted'] === true;
}

async function decideRevision(store: SqlLedgerStore, graph: SyncGraph, revision: SyncRevisionV2): Promise<RevisionDecision> {
  const key = aggregateKey(revision.aggregateType, revision.aggregateId);
  const active = graph.entityHeads.get(key) ?? [];
  const missingParents = revision.parentRevisionIds.filter((id) => !graph.revisions.has(id));
  if (missingParents.length) return { revision, action: 'conflict', payload: revision.payload, nextHeads: active, changedPaths: missingParents.map((id) => `missingParent:${id}`) };

  if (!active.length) {
    return { revision, action: 'apply', payload: revision.payload, nextHeads: [revision.revisionId], changedPaths: [] };
  }
  const revParent = (id: string) => revisionParents(graph, id);
  if (active.every((head) => isAncestor(head, revision.revisionId, revParent))) {
    return { revision, action: 'apply', payload: revision.payload, nextHeads: [revision.revisionId], changedPaths: [] };
  }
  if (active.every((head) => isAncestor(revision.revisionId, head, revParent))) {
    return { revision, action: 'skip', payload: null, nextHeads: active, changedPaths: [] };
  }

  const activeDeleted = active.every((head) => graph.revisions.get(head)?.op === 'delete');
  if ((revision.op === 'delete') !== activeDeleted) {
    return { revision, action: 'conflict', payload: revision.payload, nextHeads: active, changedPaths: ['isDeleted'] };
  }

  const baseId = nearestCommonRevision(graph, active, [revision.revisionId]);
  const base = baseId ? graph.revisions.get(baseId)?.payload ?? null : null;
  const local = await store.getSyncAggregate(revision.aggregateType, revision.aggregateId);
  const incoming = revision.op === 'delete' ? null : revision.payload;
  if (revision.op === 'delete' && activeDeleted) {
    return { revision, action: 'apply', payload: revision.payload, nextHeads: unique([...active, revision.revisionId]), changedPaths: [] };
  }
  const merge = mergeSyncPayloads(base, local, incoming);
  if (merge.kind === 'conflict') {
    return { revision, action: 'conflict', payload: revision.payload, nextHeads: active, changedPaths: merge.changedPaths };
  }
  return {
    revision,
    action: 'apply',
    payload: merge.payload,
    nextHeads: unique([...active, revision.revisionId]),
    changedPaths: merge.changedPaths,
  };
}

async function conflictBranches(
  store: SqlLedgerStore,
  graph: SyncGraph,
  commit: StoredSyncCommit,
): Promise<SyncConflictBranchRow[]> {
  const branches: SyncConflictBranchRow[] = [];
  for (const revision of commit.revisions) {
    const key = aggregateKey(revision.aggregateType, revision.aggregateId);
    const active = graph.entityHeads.get(key) ?? [];
    branches.push({
      groupId: '',
      revisionId: `workspace:${commit.commitId}:${revision.aggregateType}:${revision.aggregateId}`,
      commitId: graph.ledgerHeads.join(',') || 'workspace',
      aggregateType: revision.aggregateType,
      aggregateId: revision.aggregateId,
      role: 'local',
      originDeviceId: store.syncDeviceId(),
      parentRevisionIds: active,
      payload: await store.getSyncAggregate(revision.aggregateType, revision.aggregateId),
    });
    branches.push({
      groupId: '',
      revisionId: revision.revisionId,
      commitId: commit.commitId,
      aggregateType: revision.aggregateType,
      aggregateId: revision.aggregateId,
      role: 'remote',
      originDeviceId: commit.originDeviceId,
      sourceReplicaKey: commit.sourceReplicaKey,
      parentRevisionIds: revision.parentRevisionIds,
      payload: revision.payload,
    });
  }
  return branches;
}

function nextLedgerHeads(graph: SyncGraph, commit: StoredSyncCommit): string[] {
  const parent = (id: string) => commitParents(graph, id);
  if (!graph.ledgerHeads.length) return [commit.commitId];
  if (graph.ledgerHeads.every((head) => isAncestor(head, commit.commitId, parent))) return [commit.commitId];
  if (graph.ledgerHeads.every((head) => isAncestor(commit.commitId, head, parent))) return graph.ledgerHeads;
  return unique([...graph.ledgerHeads, commit.commitId]);
}

function sourceServerId(commit: StoredSyncCommit): string | undefined {
  return commit.sourceReplicaKey?.split('\u0000')[0] || undefined;
}

async function beginRemoteAudit(store: SqlLedgerStore, commit: StoredSyncCommit): Promise<void> {
  await store.createAuditBatch({
    id: commit.commitId,
    type: 'sync',
    label: `同步提交 · ${commit.originDeviceName ?? commit.originDeviceId}`,
    actorName: commit.originDeviceName ?? commit.originDeviceId,
    deviceId: commit.originDeviceId,
    entityCount: 0,
    sourceCommitId: commit.commitId,
    sourceServerId: sourceServerId(commit),
    sourceReplicaKey: commit.sourceReplicaKey,
  });
}

async function finishRemoteAudit(
  store: SqlLedgerStore,
  commit: StoredSyncCommit,
  patch: { applied?: number; skipped?: number; conflicts?: number; outcome: 'applied' | 'partial' | 'conflict' | 'invalid' | 'duplicate'; summary?: string },
): Promise<void> {
  const entityCount = (await store.operationLog({ batchId: commit.commitId })).length;
  await store.finishAuditBatch(commit.commitId, {
    entityCount,
    appliedCount: patch.applied ?? 0,
    skippedCount: patch.skipped ?? 0,
    conflictCount: patch.conflicts ?? 0,
    outcome: patch.outcome,
    summary: patch.summary,
  });
}

/** Apply every dependency-complete pending commit. */
export async function applyPendingCommits(store: SqlLedgerStore): Promise<ApplyCommitsResult> {
  const result: ApplyCommitsResult = { applied: 0, conflicts: 0, skipped: 0, invalid: 0, pending: 0 };
  const graph = await store.syncGraph();
  let progressed = true;
  while (progressed) {
    progressed = false;
    const pending = [...graph.commits.values()]
      .filter((commit) => commit.state === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commitId.localeCompare(b.commitId));
    for (const commit of pending) {
      let auditStarted = false;
      const ensureAudit = async () => {
        if (auditStarted) return;
        await beginRemoteAudit(store, commit);
        auditStarted = true;
      };
      const parents = commit.parentCommitIds.map((id) => graph.commits.get(id));
      if (parents.some((parent) => !parent)) continue;
      const cyclicCommit = commit.parentCommitIds.some((parentId) =>
        isAncestor(commit.commitId, parentId, (id) => commitParents(graph, id)),
      );
      if (cyclicCommit) {
        await ensureAudit();
        await store.setSyncCommitState(commit.commitId, 'invalid', '提交 DAG 包含循环依赖');
        await finishRemoteAudit(store, commit, { outcome: 'invalid', summary: '提交 DAG 包含循环依赖' });
        commit.state = 'invalid';
        result.invalid += 1;
        progressed = true;
        continue;
      }
      if (parents.some((parent) => parent?.state === 'invalid')) {
        await ensureAudit();
        await store.setSyncCommitState(commit.commitId, 'invalid', '父提交无效');
        await finishRemoteAudit(store, commit, { outcome: 'invalid', summary: '父提交无效' });
        commit.state = 'invalid';
        result.invalid += 1;
        progressed = true;
        continue;
      }
      if (parents.some((parent) => parent?.state === 'pending')) continue;
      const missingRevisionParent = commit.revisions.some((revision) => revision.parentRevisionIds.some((id) => !graph.revisions.has(id)));
      if (missingRevisionParent) continue;
      const invalidRevisionGraph = commit.revisions.some((revision) => revision.parentRevisionIds.some((parentRevisionId) => {
        if (isAncestor(revision.revisionId, parentRevisionId, (id) => revisionParents(graph, id))) return true;
        const parentCommit = commitForRevision(graph, parentRevisionId);
        return !parentCommit || !isAncestor(parentCommit.commitId, commit.commitId, (id) => commitParents(graph, id));
      }));
      if (invalidRevisionGraph) {
        await ensureAudit();
        await store.setSyncCommitState(commit.commitId, 'invalid', '聚合修订父节点不属于提交祖先或包含循环');
        await finishRemoteAudit(store, commit, { outcome: 'invalid', summary: '聚合修订父节点不属于提交祖先或包含循环' });
        commit.state = 'invalid';
        result.invalid += 1;
        progressed = true;
        continue;
      }

      const claimedResolutions = commit.resolvesConflictCommitIds ?? [];
      const invalidResolutionClaim = claimedResolutions.some((resolvedCommitId) => {
        const resolvedCommit = graph.commits.get(resolvedCommitId);
        if (!resolvedCommit || !isAncestor(resolvedCommitId, commit.commitId, (id) => commitParents(graph, id))) return true;
        return resolvedCommit.revisions.some((resolvedRevision) => {
          const mergeRevision = commit.revisions.find((revision) =>
            revision.aggregateType === resolvedRevision.aggregateType
            && revision.aggregateId === resolvedRevision.aggregateId,
          );
          return !mergeRevision || !isAncestor(resolvedRevision.revisionId, mergeRevision.revisionId, (id) => revisionParents(graph, id));
        });
      });
      if (invalidResolutionClaim) {
        await ensureAudit();
        await store.setSyncCommitState(commit.commitId, 'invalid', '冲突合并声明没有覆盖对应提交及修订');
        await finishRemoteAudit(store, commit, { outcome: 'invalid', summary: '冲突合并声明没有覆盖对应提交及修订' });
        commit.state = 'invalid';
        result.invalid += 1;
        progressed = true;
        continue;
      }

      const blockedCommitIds = commit.parentCommitIds.filter((id) => graph.commits.get(id)?.state === 'conflict');
      const resolvedCommitIds = new Set(commit.resolvesConflictCommitIds ?? []);
      const blockedByConflict = blockedCommitIds.some((id) => !resolvedCommitIds.has(id));
      const decisions: RevisionDecision[] = [];
      for (const revision of commit.revisions) decisions.push(await decideRevision(store, graph, revision));
      const conflicted = blockedByConflict || decisions.some((decision) => decision.action === 'conflict');
      if (conflicted) {
        await ensureAudit();
        const changedPaths = blockedByConflict
          ? [`blockedBy:${commit.parentCommitIds.filter((id) => graph.commits.get(id)?.state === 'conflict').join(',')}`]
          : decisions.flatMap((decision) => decision.changedPaths.map((path) => `${decision.revision.aggregateType}.${path}`));
        await store.recordSyncConflict({
          commit,
          localCommitIds: graph.ledgerHeads,
          changedPaths,
          branches: await conflictBranches(store, graph, commit),
        });
        await store.setSyncCommitState(commit.commitId, 'conflict');
        await finishRemoteAudit(store, commit, {
          conflicts: decisions.filter((decision) => decision.action === 'conflict').length || 1,
          outcome: 'conflict',
          summary: changedPaths.join(', '),
        });
        commit.state = 'conflict';
        result.conflicts += 1;
        progressed = true;
        continue;
      }

      try {
        await ensureAudit();
        await store.withAuditContext(
          { batchId: commit.commitId, source: 'remote_sync', actorName: commit.originDeviceName ?? commit.originDeviceId, suppressSync: true },
          (scoped) => scoped.transaction(async (tx) => {
            let conversionChanged = false;
            for (const decision of [...decisions].sort((left, right) => syncApplyOrder(
              {
                aggregateType: left.revision.aggregateType,
                op: left.revision.op,
                payload: left.payload,
              },
              {
                aggregateType: right.revision.aggregateType,
                op: right.revision.op,
                payload: right.payload,
              },
            ))) {
              if (decision.action === 'skip') continue;
              await tx.applySyncAggregate(
                decision.revision.aggregateType,
                decision.revision.aggregateId,
                decision.payload,
                decision.revision.op,
              );
              if (decision.revision.aggregateType === 'conversion') conversionChanged = true;
            }
            if (conversionChanged) await rebuildConversionDerivedInTransaction(tx);
            for (const decision of decisions) {
              await tx.setSyncEntityHeads(decision.revision.aggregateType, decision.revision.aggregateId, decision.nextHeads);
            }
            const ledgerHeads = nextLedgerHeads(graph, commit);
            await tx.setSyncLedgerHeads(ledgerHeads);
            await tx.setSyncCommitState(commit.commitId, 'applied');
            for (const resolvedId of resolvedCommitIds) await tx.setSyncCommitState(resolvedId, 'applied');
            if (resolvedCommitIds.size) {
              const groups = await tx.listConflicts();
              for (const group of groups) {
                if (!group.remoteCommitIds.length || !group.remoteCommitIds.every((id) => resolvedCommitIds.has(id))) continue;
                await tx.finishConflictGroup({
                  groupId: group.id,
                  action: 'accept_remote_merge',
                  resolvedCommitId: commit.commitId,
                  resolverDeviceId: commit.originDeviceId,
                  detail: {
                    aggregates: unique(group.branches.map((branch) => aggregateKey(branch.aggregateType, branch.aggregateId))),
                    changedPaths: group.changedPaths,
                    resolvedConflictCommitIds: [...resolvedCommitIds],
                  },
                  note: '接受其他设备生成的冲突合并提交',
                });
              }
            }
            graph.ledgerHeads = ledgerHeads;
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await store.setSyncCommitState(commit.commitId, 'invalid', `应用失败：${message}`);
        await finishRemoteAudit(store, commit, { outcome: 'invalid', summary: `应用失败：${message}` });
        commit.state = 'invalid';
        result.invalid += 1;
        progressed = true;
        continue;
      }
      for (const decision of decisions) {
        graph.entityHeads.set(aggregateKey(decision.revision.aggregateType, decision.revision.aggregateId), decision.nextHeads);
        if (decision.action === 'skip') result.skipped += 1;
        else result.applied += 1;
      }
      const appliedCount = decisions.filter((decision) => decision.action === 'apply').length;
      const skippedCount = decisions.filter((decision) => decision.action === 'skip').length;
      await finishRemoteAudit(store, commit, {
        applied: appliedCount,
        skipped: skippedCount,
        outcome: appliedCount === 0 ? 'duplicate' : skippedCount > 0 ? 'partial' : 'applied',
      });
      commit.state = 'applied';
      for (const resolvedId of resolvedCommitIds) {
        const resolved = graph.commits.get(resolvedId);
        if (resolved) resolved.state = 'applied';
      }
      progressed = true;
    }
  }
  result.pending = [...graph.commits.values()].filter((commit) => commit.state === 'pending').length;
  return result;
}

export async function connectReplica(store: SqlLedgerStore, transport: CommitTransport): Promise<ReplicaConnection> {
  await store.assertSyncReady();
  const ledgerId = await store.getLedgerId();
  const connection = await transport.connect(ledgerId);
  if (connection.ledgerId !== ledgerId) throw new Error(`同步服务器绑定的是其他账本：${connection.ledgerId}`);
  return connection;
}

export async function pullReplica(
  store: SqlLedgerStore,
  transport: CommitTransport,
  connection: ReplicaConnection,
): Promise<{ pulled: number; headSeq: number }> {
  const identity: SyncReplicaIdentity = connection;
  const key = replicaKey(identity);
  let state = await store.getReplicaState(identity);
  let pulled = 0;
  let headSeq = connection.headSeq;
  while (true) {
    const page = await transport.pullCommits(identity, state.cursor, 200);
    await assertPulledPage(identity, state.cursor, page);
    await store.transaction(async (tx) => {
      for (const row of page.commits) {
        await tx.storeSyncCommit(row.commit, { source: 'remote', sourceReplicaKey: key, state: 'pending', contentHash: row.contentHash });
      }
      await tx.markCommitsAcknowledged(key, page.commits.map((row) => ({ commitId: row.commit.commitId, seq: row.seq, contentHash: row.contentHash })));
      await tx.saveReplicaState(identity, page.nextSeq, page.headSeq);
    });
    pulled += page.commits.length;
    headSeq = page.headSeq;
    state = { ...state, cursor: page.nextSeq, headSeq: page.headSeq };
    if (!page.hasMore) break;
  }
  return { pulled, headSeq };
}

export async function pushReplica(
  store: SqlLedgerStore,
  transport: CommitTransport,
  connection: ReplicaConnection,
): Promise<{ pushed: number; headSeq: number }> {
  const identity: SyncReplicaIdentity = connection;
  const key = replicaKey(identity);
  const pending = await store.commitsPendingForReplica(key);
  let pushed = 0;
  let headSeq = connection.headSeq;
  for (let offset = 0; offset < pending.length; offset += 100) {
    const page = pending.slice(offset, offset + 100);
    const wirePage = page.map(wireSyncCommit);
    const response = await transport.pushCommits(identity, wirePage);
    await assertPushAcknowledgements(wirePage, response);
    await store.transaction(async (tx) => {
      for (const ack of response.assigned) await tx.setCommitContentHash(ack.commitId, ack.contentHash);
      await tx.markCommitsAcknowledged(key, response.assigned);
      const current = await tx.getReplicaState(identity);
      await tx.saveReplicaState(identity, current.cursor, response.headSeq);
    });
    pushed += response.assigned.length;
    headSeq = response.headSeq;
  }
  return { pushed, headSeq };
}

/** One complete round against one replica. Multi-replica orchestration uses the phase functions above. */
export async function syncReplica(store: SqlLedgerStore, transport: CommitTransport, endpoint: string): Promise<CommitSyncResult> {
  const connection = await connectReplica(store, transport);
  const pulled = await pullReplica(store, transport, connection);
  const applied = await applyPendingCommits(store);
  const pushed = await pushReplica(store, transport, { ...connection, headSeq: pulled.headSeq });
  return { ...applied, pulled: pulled.pulled, pushed: pushed.pushed, identity: connection, endpoint };
}

/**
 * Converge every available replica as one sync operation. Each round pulls all
 * replicas before applying anything, then pushes the resulting graph to all of
 * them and verifies their new heads. A failed replica is isolated without
 * preventing the healthy replicas from converging.
 */
export async function syncReplicas(
  store: SqlLedgerStore,
  targets: SyncReplicaTarget[],
  options: { maxRounds?: number } = {},
): Promise<MultiReplicaSyncResult> {
  const maxRounds = Math.max(1, Math.min(10, options.maxRounds ?? 3));
  const rows = new Map<string, ReplicaSyncEndpointResult>();
  const connected: {
    target: SyncReplicaTarget;
    connection: ReplicaConnection;
    row: ReplicaSyncEndpointResult;
  }[] = [];
  const replicaKeys = new Set<string>();

  for (const target of targets) {
    const row: ReplicaSyncEndpointResult = {
      id: target.id,
      endpoint: target.endpoint,
      pulled: 0,
      pushed: 0,
      headSeq: 0,
      cursor: 0,
      pendingPush: 0,
    };
    rows.set(target.id, row);
    try {
      const connection = await connectReplica(store, target.transport);
      const key = replicaKey(connection);
      if (replicaKeys.has(key)) throw new Error('同一个同步副本被重复配置');
      replicaKeys.add(key);
      row.identity = connection;
      row.headSeq = connection.headSeq;
      connected.push({ target, connection, row });
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
    }
  }

  const total: MultiReplicaSyncResult = {
    pulled: 0,
    pushed: 0,
    applied: 0,
    conflicts: 0,
    skipped: 0,
    invalid: 0,
    pending: 0,
    rounds: 0,
    converged: false,
    endpoints: [],
  };

  const apply = async () => {
    const result = await applyPendingCommits(store);
    total.applied += result.applied;
    total.conflicts += result.conflicts;
    total.skipped += result.skipped;
    total.invalid += result.invalid;
    total.pending = result.pending;
  };

  for (let round = 1; round <= maxRounds && connected.some(({ row }) => !row.error); round += 1) {
    total.rounds = round;

    for (const current of connected) {
      if (current.row.error) continue;
      try {
        const pulled = await pullReplica(store, current.target.transport, current.connection);
        current.connection = { ...current.connection, headSeq: pulled.headSeq };
        current.row.pulled += pulled.pulled;
        current.row.headSeq = pulled.headSeq;
        total.pulled += pulled.pulled;
      } catch (error) {
        current.row.error = error instanceof Error ? error.message : String(error);
      }
    }

    await apply();

    for (const current of connected) {
      if (current.row.error) continue;
      try {
        const pushed = await pushReplica(store, current.target.transport, current.connection);
        current.connection = { ...current.connection, headSeq: pushed.headSeq };
        current.row.pushed += pushed.pushed;
        current.row.headSeq = pushed.headSeq;
        total.pushed += pushed.pushed;
      } catch (error) {
        current.row.error = error instanceof Error ? error.message : String(error);
      }
    }

    // Pull once more so cursors include our own newly assigned commits and any
    // concurrent writes that arrived while this round was pushing.
    for (const current of connected) {
      if (current.row.error) continue;
      try {
        const pulled = await pullReplica(store, current.target.transport, current.connection);
        current.connection = { ...current.connection, headSeq: pulled.headSeq };
        current.row.pulled += pulled.pulled;
        current.row.headSeq = pulled.headSeq;
        total.pulled += pulled.pulled;
      } catch (error) {
        current.row.error = error instanceof Error ? error.message : String(error);
      }
    }

    await apply();

    let healthyConverged = true;
    for (const current of connected) {
      if (current.row.error) continue;
      const state = await store.getReplicaState(current.connection);
      current.row.cursor = state.cursor;
      current.row.headSeq = state.headSeq;
      current.row.pendingPush = (await store.commitsPendingForReplica(replicaKey(current.connection))).length;
      if (state.cursor < state.headSeq || current.row.pendingPush > 0) healthyConverged = false;
    }
    if (healthyConverged && total.pending === 0) break;
  }

  total.endpoints = targets.map((target) => rows.get(target.id)!);
  total.converged = connected.length === targets.length
    && total.endpoints.every((row) => !row.error && row.cursor >= row.headSeq && row.pendingPush === 0)
    && total.pending === 0;
  return total;
}

export interface ResolveConflictInput {
  action: 'keep_local' | 'keep_branch' | 'manual_merge';
  /** aggregateKey(type,id) -> selected remote revision id */
  branchRevisionIds?: Record<string, string>;
  /** aggregateKey(type,id) -> manually merged payload */
  payloads?: Record<string, Record<string, unknown> | null>;
  note?: string;
}

export async function resolveConflictGroup(
  store: SqlLedgerStore,
  groupId: string,
  input: ResolveConflictInput,
): Promise<SyncCommitV2> {
  const group = (await store.listConflicts()).find((row) => row.id === groupId);
  if (!group) throw new Error('同步冲突不存在或已经解决');
  const graph = await store.syncGraph();
  const aggregateKeys = unique(group.branches.map((branch) => aggregateKey(branch.aggregateType, branch.aggregateId)));
  const commitId = newId();
  const revisions: SyncRevisionV2[] = [];
  const resolvedPayloads = new Map<string, Record<string, unknown> | null>();

  for (const key of aggregateKeys) {
    const [type, id] = key.split('\u0000');
    const branches = group.branches.filter((branch) => branch.aggregateType === type && branch.aggregateId === id);
    let payload: Record<string, unknown> | null;
    if (input.action === 'keep_local') payload = await store.getSyncAggregate(type!, id!);
    else if (input.action === 'manual_merge') {
      if (!input.payloads || !(key in input.payloads)) throw new Error(`缺少 ${type}:${id} 的合并结果`);
      payload = input.payloads[key] ?? null;
    } else {
      const selectedId = input.branchRevisionIds?.[key];
      const selected = selectedId ? branches.find((branch) => branch.revisionId === selectedId) : undefined;
      if (!selected) throw new Error(`没有为 ${type}:${id} 选择冲突分支`);
      payload = selected.payload;
    }
    const parentRevisionIds = unique([
      ...(graph.entityHeads.get(key) ?? []),
      ...branches.map((branch) => branch.revisionId).filter((revisionId) => graph.revisions.has(revisionId)),
    ]);
    revisions.push({
      revisionId: newId(), aggregateType: type!, aggregateId: id!, parentRevisionIds,
      op: isDeletedPayload(type!, payload) ? 'delete' : 'put', payload,
    });
    resolvedPayloads.set(key, payload);
  }

  const commit: SyncCommitV2 = {
    protocol: 2,
    ledgerId: group.ledgerId,
    commitId,
    originDeviceId: store.syncDeviceId(),
    createdAt: new Date().toISOString(),
    parentCommitIds: unique([...graph.ledgerHeads, ...group.remoteCommitIds]),
    resolvesConflictCommitIds: unique([
      ...group.remoteCommitIds,
      ...group.branches
        .filter((branch) => branch.role === 'local')
        .flatMap((branch) => branch.parentRevisionIds)
        .map((revisionId) => commitForRevision(graph, revisionId)?.commitId)
        .filter((commitId): commitId is string => !!commitId),
    ]),
    revisions,
  };

  await store.createAuditBatch({
    id: commitId,
    type: 'conflict_resolution',
    label: `解决同步冲突 · ${groupId}`,
    actorName: '冲突解决',
    entityCount: 0,
    conflictCount: group.remoteCommitIds.length,
  });
  try {
    await store.withAuditContext(
      { batchId: commitId, source: 'conflict_resolution', actorName: '冲突解决', suppressSync: true },
      (scoped) => scoped.transaction(async (tx) => {
        await tx.storeSyncCommit(commit, { source: 'local', state: 'applied' });
        let conversionChanged = false;
        for (const revision of [...revisions].sort((left, right) => syncApplyOrder(left, right))) {
          await tx.applySyncAggregate(revision.aggregateType, revision.aggregateId, resolvedPayloads.get(aggregateKey(revision.aggregateType, revision.aggregateId)) ?? null, revision.op);
          await tx.setSyncEntityHeads(revision.aggregateType, revision.aggregateId, [revision.revisionId]);
          if (revision.aggregateType === 'conversion') conversionChanged = true;
        }
        if (conversionChanged) await rebuildConversionDerivedInTransaction(tx);
        await tx.setSyncLedgerHeads([commitId]);
        for (const resolvedCommitId of commit.resolvesConflictCommitIds ?? []) await tx.setSyncCommitState(resolvedCommitId, 'applied');
        await tx.finishConflictGroup({
          groupId,
          action: input.action,
          resolvedCommitId: commitId,
          detail: { branchRevisionIds: input.branchRevisionIds, aggregates: aggregateKeys, changedPaths: group.changedPaths },
          note: input.note,
        });
      }),
    );
    const entityCount = (await store.operationLog({ batchId: commitId })).length;
    await store.finishAuditBatch(commitId, {
      entityCount,
      appliedCount: entityCount,
      conflictCount: group.remoteCommitIds.length,
      outcome: 'applied',
      summary: input.note,
    });
  } catch (error) {
    await store.finishAuditBatch(commitId, {
      entityCount: 0,
      appliedCount: 0,
      conflictCount: group.remoteCommitIds.length,
      outcome: 'invalid',
      summary: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return commit;
}

/** In-memory protocol-v2 replica used by unit tests. */
export function memoryCommitTransport(serverId = 'memory'): CommitTransport & {
  log: { seq: number; commit: SyncCommitV2; contentHash: string }[];
} {
  const log: { seq: number; commit: SyncCommitV2; contentHash: string }[] = [];
  let boundLedgerId: string | undefined;
  const replicaId = `${serverId}-replica`;
  const streamEpoch = `${serverId}-epoch`;
  return {
    log,
    async connect(ledgerId) {
      boundLedgerId ??= ledgerId;
      if (boundLedgerId !== ledgerId) throw new Error(`LEDGER_MISMATCH:${boundLedgerId}`);
      return { serverId, replicaId, streamEpoch, ledgerId, headSeq: log.at(-1)?.seq ?? 0 };
    },
    async pullCommits(identity, afterSeq, limit = 200) {
      if (identity.ledgerId !== boundLedgerId) throw new Error('LEDGER_MISMATCH');
      const rows = log.filter((row) => row.seq > afterSeq).slice(0, limit);
      const headSeq = log.at(-1)?.seq ?? 0;
      const nextSeq = rows.at(-1)?.seq ?? afterSeq;
      return {
        commits: rows.map((row) => ({ seq: row.seq, commit: row.commit, contentHash: row.contentHash })),
        nextSeq, headSeq, hasMore: nextSeq < headSeq,
      };
    },
    async pushCommits(identity, commits) {
      if (identity.ledgerId !== boundLedgerId) throw new Error('LEDGER_MISMATCH');
      const assigned: { commitId: string; seq: number; contentHash: string }[] = [];
      for (const commit of commits) {
        const contentHash = await sha256Json(commit);
        const existing = log.find((row) => row.commit.commitId === commit.commitId);
        if (existing) {
          if (existing.contentHash !== contentHash) throw new Error(`COMMIT_ID_COLLISION:${commit.commitId}`);
          assigned.push({ commitId: commit.commitId, seq: existing.seq, contentHash });
          continue;
        }
        const seq = (log.at(-1)?.seq ?? 0) + 1;
        log.push({ seq, commit, contentHash });
        assigned.push({ commitId: commit.commitId, seq, contentHash });
      }
      return { assigned, headSeq: log.at(-1)?.seq ?? 0 };
    },
  };
}
