import { describe, expect, it } from 'vitest';
import { newId, sha256Json, wireSyncCommit, type Asset, type PriceMark, type SyncCommitV2 } from '@zichan/core';
import {
  aggregateKey,
  applyPendingCommits,
  memoryCommitTransport,
  resolveConflictGroup,
  syncReplica,
  syncReplicas,
  replicaKey,
  type CommitTransport,
} from '../src/index.js';
import { openLedger } from '../src/node.js';
import { openDiagnosticLedger } from './diagnostic-ledger.js';

function base() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

function asset(code: string): Asset {
  return { ...base(), code, name: code, type: 'crypto', decimals: 8, isActive: true } as Asset;
}

function mark(id: string, price: string): PriceMark {
  return { ...base(), id, assetId: 'BTC', quoteAssetId: 'USD', price, date: '2026-07-13', source: 'manual' } as PriceMark;
}

async function shareLedgerId(...stores: Awaited<ReturnType<typeof openLedger>>[]) {
  const ledgerId = await stores[0]!.getLedgerId();
  for (const store of stores.slice(1)) await store.adoptLedgerId(ledgerId);
}

async function openPriceLedger(deviceId: string) {
  const { store, rawPut } = await openDiagnosticLedger({ deviceId });
  await rawPut('assets', { ...asset('BTC'), id: 'BTC' });
  await rawPut('assets', { ...asset('USD'), id: 'USD' });
  return store;
}

describe('sync protocol v2', () => {
  it('converges disjoint commits through one replica', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();

    const btc = await a.assets.put(asset('BTC'));
    await b.assets.put(asset('ETH'));

    await syncReplica(a, transport, 'memory');
    await syncReplica(b, transport, 'memory');
    await syncReplica(a, transport, 'memory');

    expect((await a.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);
    expect((await b.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);
    expect(transport.log).toHaveLength(2);
    const remoteLog = await b.operationLog({ entityType: 'asset', entityId: btc.id });
    expect(remoteLog).toEqual([expect.objectContaining({ source: 'remote_sync', actorName: 'A', deviceId: 'B' })]);
    const remoteBatch = (await b.listAuditBatches()).find((row) => row.sourceCommitId === remoteLog[0]!.batchId);
    expect(remoteBatch).toMatchObject({ type: 'sync', outcome: 'applied', appliedCount: 1, deviceId: 'A', sourceCommitId: remoteLog[0]!.batchId });

    await a.close();
    await b.close();
  });

  it('converges two servers in one pull-all/apply/push-all operation', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    await shareLedgerId(a, b);
    const first = memoryCommitTransport('server-1');
    const second = memoryCommitTransport('server-2');

    await a.assets.put(asset('BTC'));
    await b.assets.put(asset('ETH'));
    await syncReplica(a, first, 'server-1');
    await syncReplica(b, second, 'server-2');

    const targets = [
      { id: 'first', endpoint: 'server-1', transport: first },
      { id: 'second', endpoint: 'server-2', transport: second },
    ];
    const aResult = await syncReplicas(a, targets);
    const bResult = await syncReplicas(b, targets);

    expect(aResult.converged, JSON.stringify(aResult)).toBe(true);
    expect(bResult.converged).toBe(true);
    expect((await a.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);
    expect((await b.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);
    expect(first.log.map((row) => row.commit.commitId).sort()).toEqual(second.log.map((row) => row.commit.commitId).sort());
    expect(first.log).toHaveLength(2);

    await a.close();
    await b.close();
  });

  it('preserves concurrent branches and resolves them with an explicit merge commit', async () => {
    const a = await openPriceLedger('A');
    const b = await openPriceLedger('B');
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();
    const id = newId();

    await a.priceMarks.put(mark(id, '100'));
    await syncReplica(a, transport, 'memory');
    await syncReplica(b, transport, 'memory');

    await a.priceMarks.put({ ...(await a.priceMarks.get(id))!, price: '101' });
    await syncReplica(a, transport, 'memory');
    await b.priceMarks.put({ ...(await b.priceMarks.get(id))!, price: '102' });
    const result = await syncReplica(b, transport, 'memory');
    const [group] = await b.listConflicts();

    expect(result.conflicts).toBe(1);
    expect(group?.changedPaths).toContain('price_mark.price');
    expect(group?.branches.filter((branch) => branch.aggregateId === id)).toHaveLength(2);
    expect((await b.priceMarks.get(id))?.price).toBe('102');

    await syncReplica(a, transport, 'memory');
    expect(await a.listConflicts()).toHaveLength(1);

    const remote = group!.branches.find((branch) => branch.role === 'remote' && branch.originDeviceId === 'A')!;
    const merge = await resolveConflictGroup(b, group!.id, {
      action: 'keep_branch',
      branchRevisionIds: { [aggregateKey('price_mark', id)]: remote.revisionId },
    });

    expect(merge.parentCommitIds).toEqual(expect.arrayContaining(group!.remoteCommitIds));
    expect((await b.priceMarks.get(id))?.price).toBe('101');
    expect(await b.listConflicts()).toHaveLength(0);
    expect(await b.listConflictResolutions()).toEqual([
      expect.objectContaining({ groupId: group!.id, action: 'keep_branch', resolvedCommitId: merge.commitId }),
    ]);
    expect((await b.listAuditBatches()).find((batch) => batch.id === merge.commitId)).toMatchObject({
      type: 'conflict_resolution', outcome: 'applied', conflictCount: group!.remoteCommitIds.length,
    });

    await syncReplica(b, transport, 'memory');
    await syncReplica(a, transport, 'memory');
    expect((await a.priceMarks.get(id))?.price).toBe('101');
    expect(await a.listConflicts()).toHaveLength(0);
    expect(await a.listConflictResolutions()).toEqual([
      expect.objectContaining({ action: 'accept_remote_merge', resolvedCommitId: merge.commitId, resolverDeviceId: 'B' }),
    ]);

    await a.close();
    await b.close();
  });

  it('quarantines an atomic commit and every descendant when one aggregate conflicts', async () => {
    const a = await openPriceLedger('A');
    const b = await openPriceLedger('B');
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();
    const priceId = newId();

    await a.priceMarks.put(mark(priceId, '100'));
    await syncReplica(a, transport, 'memory');
    await syncReplica(b, transport, 'memory');
    await b.priceMarks.put({ ...(await b.priceMarks.get(priceId))!, price: '102' });

    const eth = asset('ETH');
    const batchId = newId();
    await a.withAuditContext({ batchId, source: 'local', actorName: 'atomic-test' }, (scoped) => scoped.transaction(async (tx) => {
      await tx.assets.put(eth);
      await tx.priceMarks.put({ ...(await tx.priceMarks.get(priceId))!, price: '101' });
    }));
    const ltc = await a.assets.put(asset('LTC'));
    await syncReplica(a, transport, 'memory');

    const result = await syncReplica(b, transport, 'memory');
    const [group] = await b.listConflicts();
    expect(result.conflicts).toBe(2);
    expect(group?.remoteCommitIds).toHaveLength(2);
    expect(await b.assets.get(eth.id)).toBeNull();
    expect(await b.assets.get(ltc.id)).toBeNull();
    expect((await b.priceMarks.get(priceId))?.price).toBe('102');
    expect(group?.branches.some((branch) => branch.aggregateId === eth.id)).toBe(true);
    expect(group?.branches.some((branch) => branch.aggregateId === ltc.id)).toBe(true);

    await a.close();
    await b.close();
  });

  it('rejects a merge claim that does not cover every resolved revision', async () => {
    const store = await openPriceLedger('A');
    const transport = memoryCommitTransport();
    const original = await store.priceMarks.put(mark(newId(), '100'));
    await syncReplica(store, transport, 'memory');
    const parent = transport.log[0]!.commit;
    const injected = asset('INJECTED');
    const malicious: SyncCommitV2 = {
      protocol: 2,
      ledgerId: await store.getLedgerId(),
      commitId: newId(),
      originDeviceId: 'malicious-device',
      createdAt: new Date().toISOString(),
      parentCommitIds: [parent.commitId],
      resolvesConflictCommitIds: [parent.commitId],
      revisions: [{
        revisionId: newId(),
        aggregateType: 'asset',
        aggregateId: injected.id,
        parentRevisionIds: [],
        op: 'put',
        payload: injected as unknown as Record<string, unknown>,
      }],
    };

    await store.storeSyncCommit(malicious, { source: 'remote', state: 'pending' });
    const result = await applyPendingCommits(store);

    expect(result.invalid).toBe(1);
    expect(await store.assets.get(injected.id)).toBeNull();
    expect((await store.listSyncCommits({ includeInvalid: true })).find((row) => row.commitId === malicious.commitId))
      .toMatchObject({ state: 'invalid', error: '冲突合并声明没有覆盖对应提交及修订' });
    expect(await store.priceMarks.get(original.id)).not.toBeNull();
    await store.close();
  });

  it('marks an unapplyable authenticated payload invalid without crashing the sync engine', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const malformed: SyncCommitV2 = {
      protocol: 2,
      ledgerId: await store.getLedgerId(),
      commitId: newId(),
      originDeviceId: 'broken-client',
      createdAt: new Date().toISOString(),
      parentCommitIds: [],
      revisions: [{
        revisionId: newId(), aggregateType: 'conversion', aggregateId: newId(),
        parentRevisionIds: [], op: 'put', payload: {},
      }],
    };
    await store.storeSyncCommit(malformed, { source: 'remote', state: 'pending' });

    const result = await applyPendingCommits(store);

    expect(result.invalid).toBe(1);
    expect((await store.listSyncCommits({ includeInvalid: true })).find((row) => row.commitId === malformed.commitId))
      .toMatchObject({ state: 'invalid', error: '应用失败：资产转换同步快照缺少 chain' });
    expect(await store.operationLog()).toEqual([]);
    await store.close();
  });

  it('applies a parent before a child even when the child has an earlier timestamp', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const row = asset('ORDERED');
    const parentRevisionId = newId();
    const parentCommitId = newId();
    const parent: SyncCommitV2 = {
      protocol: 2, ledgerId: await store.getLedgerId(), commitId: parentCommitId,
      originDeviceId: 'remote', createdAt: '2026-07-13T00:00:02.000Z', parentCommitIds: [],
      revisions: [{
        revisionId: parentRevisionId, aggregateType: 'asset', aggregateId: row.id,
        parentRevisionIds: [], op: 'put', payload: row as unknown as Record<string, unknown>,
      }],
    };
    const child: SyncCommitV2 = {
      protocol: 2, ledgerId: parent.ledgerId, commitId: newId(),
      originDeviceId: 'remote', createdAt: '2026-07-13T00:00:01.000Z', parentCommitIds: [parentCommitId],
      revisions: [{
        revisionId: newId(), aggregateType: 'asset', aggregateId: row.id,
        parentRevisionIds: [parentRevisionId], op: 'put',
        payload: { ...(row as unknown as Record<string, unknown>), name: 'ORDERED CHILD' },
      }],
    };
    await store.storeSyncCommit(child, { source: 'remote', state: 'pending' });
    await store.storeSyncCommit(parent, { source: 'remote', state: 'pending' });

    const result = await applyPendingCommits(store);

    expect(result.invalid).toBe(0);
    expect(result.applied).toBe(2);
    expect((await store.assets.get(row.id))?.name).toBe('ORDERED CHILD');
    expect(await store.operationLog({ entityType: 'asset', entityId: row.id })).toHaveLength(2);
    await store.close();
  });

  it('marks cyclic commit dependencies invalid', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const firstId = newId();
    const secondId = newId();
    const makeCyclic = (commitId: string, parentCommitId: string, row: Asset): SyncCommitV2 => ({
      protocol: 2, ledgerId: '', commitId, originDeviceId: 'remote',
      createdAt: new Date().toISOString(), parentCommitIds: [parentCommitId],
      revisions: [{
        revisionId: newId(), aggregateType: 'asset', aggregateId: row.id,
        parentRevisionIds: [], op: 'put', payload: row as unknown as Record<string, unknown>,
      }],
    });
    const first = makeCyclic(firstId, secondId, asset('CYCLE-A'));
    const second = makeCyclic(secondId, firstId, asset('CYCLE-B'));
    first.ledgerId = await store.getLedgerId();
    second.ledgerId = first.ledgerId;
    await store.storeSyncCommit(first, { source: 'remote', state: 'pending' });
    await store.storeSyncCommit(second, { source: 'remote', state: 'pending' });

    const result = await applyPendingCommits(store);

    expect(result.invalid).toBe(2);
    expect((await store.listSyncCommits({ includeInvalid: true })).filter((row) => row.state === 'invalid')).toHaveLength(2);
    expect(await store.assets.list()).toEqual([]);
    await store.close();
  });

  it('rejects a replica already bound to another ledger', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    const transport = memoryCommitTransport();
    await syncReplica(a, transport, 'memory');
    await expect(syncReplica(b, transport, 'memory')).rejects.toThrow('LEDGER_MISMATCH');
    await a.close();
    await b.close();
  });

  it('rejects a pulled page that skips a server sequence without advancing the cursor', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const identity = {
      serverId: 'hostile-server', replicaId: 'hostile-replica', streamEpoch: 'hostile-epoch',
      ledgerId: await store.getLedgerId(),
    };
    const remote = asset('REMOTE');
    const commit: SyncCommitV2 = {
      protocol: 2, ledgerId: identity.ledgerId, commitId: newId(), originDeviceId: 'remote',
      createdAt: new Date().toISOString(), parentCommitIds: [],
      revisions: [{
        revisionId: newId(), aggregateType: 'asset', aggregateId: remote.id,
        parentRevisionIds: [], op: 'put', payload: remote as unknown as Record<string, unknown>,
      }],
    };
    const contentHash = await sha256Json(wireSyncCommit(commit));
    const transport: CommitTransport = {
      async connect() { return { ...identity, headSeq: 2 }; },
      async pullCommits() {
        return { commits: [{ seq: 2, commit, contentHash }], nextSeq: 2, headSeq: 2, hasMore: false };
      },
      async pushCommits() { return { assigned: [], headSeq: 2 }; },
    };

    await expect(syncReplica(store, transport, 'hostile')).rejects.toThrow('提交序号不连续');
    expect((await store.getReplicaState(identity)).cursor).toBe(0);
    expect(await store.assets.get(remote.id)).toBeNull();
    await store.close();
  });

  it('does not acknowledge a push response with a mismatched content hash', async () => {
    const store = await openLedger({ deviceId: 'A' });
    await store.assets.put(asset('LOCAL'));
    const identity = {
      serverId: 'hostile-server', replicaId: 'hostile-replica', streamEpoch: 'hostile-epoch',
      ledgerId: await store.getLedgerId(),
    };
    const transport: CommitTransport = {
      async connect() { return { ...identity, headSeq: 0 }; },
      async pullCommits(_identity, afterSeq) {
        return { commits: [], nextSeq: afterSeq, headSeq: 0, hasMore: false };
      },
      async pushCommits(_identity, commits) {
        return {
          assigned: commits.map((commit) => ({ commitId: commit.commitId, seq: 1, contentHash: 'b'.repeat(64) })),
          headSeq: 1,
        };
      },
    };

    await expect(syncReplica(store, transport, 'hostile')).rejects.toThrow('返回了错误哈希');
    expect(await store.commitsPendingForReplica(replicaKey(identity))).toHaveLength(1);
    await store.close();
  });

  it('rejects a remote commit-id collision before assigning a hash to the local commit', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const local = await store.assets.put(asset('LOCAL'));
    const existing = (await store.listSyncCommits())[0]!;
    const collision = wireSyncCommit(existing);
    collision.originDeviceId = 'remote';
    collision.revisions[0]!.payload = {
      ...(collision.revisions[0]!.payload ?? {}), id: local.id, code: 'COLLISION', name: 'COLLISION',
    };
    const contentHash = await sha256Json(collision);
    const identity = {
      serverId: 'hostile-server', replicaId: 'hostile-replica', streamEpoch: 'hostile-epoch',
      ledgerId: await store.getLedgerId(),
    };
    const transport: CommitTransport = {
      async connect() { return { ...identity, headSeq: 1 }; },
      async pullCommits() {
        return { commits: [{ seq: 1, commit: collision, contentHash }], nextSeq: 1, headSeq: 1, hasMore: false };
      },
      async pushCommits() { return { assigned: [], headSeq: 1 }; },
    };

    await expect(syncReplica(store, transport, 'hostile')).rejects.toThrow('对应了不同内容');
    expect((await store.getReplicaState(identity)).cursor).toBe(0);
    expect((await store.assets.get(local.id))?.code).toBe('LOCAL');
    await store.close();
  });

  it('does not expose a local atomic batch until the batch is sealed', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const transport = memoryCommitTransport();
    const batchId = newId();
    let release!: () => void;
    let written!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstWrite = new Promise<void>((resolve) => { written = resolve; });

    const ongoing = store.withAuditContext({ batchId, source: 'local' }, async (scoped) => {
      await scoped.assets.put(asset('BTC'));
      written();
      await gate;
      await scoped.assets.put(asset('ETH'));
    });
    await firstWrite;

    expect(await store.commitsPendingForReplica('test-replica')).toEqual([]);
    const blocked = await syncReplicas(store, [{ id: 'test', endpoint: 'memory', transport }]);
    expect(blocked.endpoints[0]?.error).toContain('未完成的原子批次');

    release();
    await ongoing;
    const pending = await store.commitsPendingForReplica('test-replica');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.revisions).toHaveLength(2);
    expect((await syncReplicas(store, [{ id: 'test', endpoint: 'memory', transport }])).converged).toBe(true);
    expect(transport.log).toHaveLength(1);

    await store.close();
  });

  it('can explicitly discard a local ledger before joining an existing ledger id', async () => {
    const store = await openLedger({ deviceId: 'new-device' });
    const local = await store.assets.put(asset('LOCAL'));
    await store.attachmentState.putBlob({ sha256: 'a'.repeat(64), sizeBytes: 10, mimeType: 'text/plain', state: 'ready' });
    await store.attachmentState.putReplicaBlob({
      profileId: 'old-profile', sha256: 'a'.repeat(64), remoteBlobId: 'b'.repeat(64), state: 'available',
      keyVersion: 1, updatedAt: new Date().toISOString(),
    });
    const remoteLedgerId = 'ledger-remote-000001';
    await store.resetToLedger(remoteLedgerId);

    expect(await store.getLedgerId()).toBe(remoteLedgerId);
    expect(await store.assets.get(local.id)).toBeNull();
    expect(await store.listSyncCommits()).toEqual([]);
    expect(await store.operationLog()).toEqual([]);
    expect(await store.attachmentState.listReplicaBlobs()).toEqual([]);
    expect(await store.attachmentState.listBlobs()).toHaveLength(1);
    await store.close();
  });
});
