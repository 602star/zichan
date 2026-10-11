import { describe, expect, it } from 'vitest';
import { newId, type Asset } from '@zichan/core';
import { aggregateKey, memoryCommitTransport, mergeReviewedCommit, replayReviewedCommit,
  syncReplicas } from '../src/index.js';
import { openLedger } from '../src/node.js';

function asset(): Asset {
  return { id: newId(), code: 'REPAIR', name: 'Recovered asset', type: 'crypto',
    decimals: 8, isActive: true, createdAt: '', updatedAt: '', version: 1,
    isDeleted: false } as Asset;
}

describe('reviewed old-epoch commit replay', () => {
  it('creates a new local commit and syncs it when the touched aggregate is unchanged', async () => {
    const source = await openLedger({ deviceId: 'old-source' });
    const target = await openLedger({ deviceId: 'current-owner' });
    try {
      await target.adoptLedgerId(await source.getLedgerId());
      const originalAsset = await source.assets.put(asset());
      const original = (await source.listSyncCommits())[0]!;
      const repaired = await replayReviewedCommit(target, original);
      expect(repaired.commitId).not.toBe(original.commitId);
      expect(repaired.revisions[0]?.revisionId).not.toBe(original.revisions[0]?.revisionId);
      expect(await target.assets.get(originalAsset.id)).toMatchObject({ name: 'Recovered asset' });
      expect((await target.listSyncCommits())[0]).toMatchObject({ commitId: repaired.commitId,
        source: 'local', state: 'applied' });
      const relay = memoryCommitTransport();
      expect((await syncReplicas(target, [{ id: 'current', endpoint: 'memory', transport: relay }])).converged).toBe(true);
      expect(relay.log[0]?.commit.commitId).toBe(repaired.commitId);
      await expect(replayReviewedCommit(target, original)).rejects.toThrow('手动合并');
    } finally { await source.close(); await target.close(); }
  });

  it('refuses an automatic rebase when the same aggregate has changed', async () => {
    const source = await openLedger({ deviceId: 'old-source' });
    const target = await openLedger({ deviceId: 'current-owner' });
    try {
      await target.adoptLedgerId(await source.getLedgerId());
      const originalAsset = await source.assets.put(asset());
      const original = (await source.listSyncCommits())[0]!;
      await target.assets.put({ ...originalAsset, name: 'Current value' });
      await expect(replayReviewedCommit(target, original)).rejects.toThrow('手动合并');
      expect((await target.assets.get(originalAsset.id))?.name).toBe('Current value');
      expect(await target.listSyncCommits()).toHaveLength(1);
    } finally { await source.close(); await target.close(); }
  });

  it('records an explicit reviewed merge on the current branch and can resume its owner decision', async () => {
    const source = await openLedger({ deviceId: 'old-source' });
    const target = await openLedger({ deviceId: 'current-owner' });
    try {
      await target.adoptLedgerId(await source.getLedgerId());
      const old = await source.assets.put(asset());
      const original = (await source.listSyncCommits())[0]!;
      const current = await target.assets.put({ ...old, name: 'Current value' });
      const key = aggregateKey('asset', old.id);
      const graph = await target.syncGraph();
      const reviewedHeads = { ledgerHeads: graph.ledgerHeads,
        entityHeads: { [key]: graph.entityHeads.get(key) ?? [] },
        currentPayloads: { [key]: await target.getSyncAggregate('asset', old.id) } };
      await expect(mergeReviewedCommit(target, original, {}, reviewedHeads)).rejects.toThrow('每项记录');
      await expect(mergeReviewedCommit(target, original, { [key]: old }, {
        ...reviewedHeads, currentPayloads: { [key]: old },
      })).rejects.toThrow('记录内容已变化');
      const merged = await mergeReviewedCommit(target, original, {
        [key]: { ...current, name: 'Reviewed combination', code: old.code },
      }, reviewedHeads);
      expect(merged.commitId).not.toBe(original.commitId);
      expect(merged.revisions[0]?.parentRevisionIds).toEqual([(await target.listSyncCommits())[0]!.revisions[0]!.revisionId]);
      expect((await target.assets.get(old.id))?.name).toBe('Reviewed combination');
      expect(await target.repairForReviewedCommit(original.commitId)).toMatchObject({ commitId: merged.commitId });
      await expect(mergeReviewedCommit(target, original, { [key]: old }, reviewedHeads))
        .rejects.toThrow('账本已变化');
      const relay = memoryCommitTransport();
      expect((await syncReplicas(target, [{ id: 'current', endpoint: 'memory', transport: relay }])).converged).toBe(true);
      expect(relay.log.map((row) => row.commit.commitId)).toContain(merged.commitId);
    } finally { await source.close(); await target.close(); }
  });
});
