import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SyncServerStore } from '../src/store.js';

describe('node replication rescan', () => {
  it('keeps concurrent acknowledged chunk bytes when another status update writes the link', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-node-chunk-progress-'));
    const store = new SyncServerStore(join(root, 'server.sqlite'), 'open', 'srv-chunk-progress');
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      const ledgerId = 'ledger-node-chunk-progress-0001';
      const replica = await store.bindReplica('owner', ledgerId);
      const link = await store.createNodeReplicationLink({
        username: 'owner', ledgerId, localStreamEpoch: replica.streamEpoch,
        peerUrl: 'http://127.0.0.1:12345', peerNodeId: 'srv-chunk-peer',
        peerPublicKey: 'peer-public-key', peerReplicaId: 'rep-chunk-peer',
        peerStreamEpoch: 'epoch-chunk-peer', grantId: 'grant-chunk-peer-0001',
      });
      await Promise.all([
        ...Array.from({ length: 16 }, () => store.recordNodeBlobTransfer(link.linkId, 'pull', 64 * 1024)),
        ...Array.from({ length: 16 }, () => store.recordNodeBlobTransfer(link.linkId, 'push', 32 * 1024)),
        store.updateNodeReplicationLink(link.linkId, { peerBlobObjects: 2 }),
      ]);
      expect((await store.listNodeReplicationLinks('owner'))[0]).toMatchObject({
        peerBlobObjects: 2, pullBlobTransferredBytes: 16 * 64 * 1024,
        pushBlobTransferredBytes: 16 * 32 * 1024,
      });
      await expect(store.recordNodeBlobTransfer(link.linkId, 'pull', 0))
        .rejects.toMatchObject({ code: 'INVALID_REPLICATION_STATUS' });
    } finally {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resets only the link scan progress and verification while retaining the replica and grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-node-rescan-'));
    const store = new SyncServerStore(join(root, 'server.sqlite'), 'open', 'srv-rescan-owner');
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      const ledgerId = 'ledger-node-rescan-0001';
      const replica = await store.bindReplica('owner', ledgerId);
      const link = await store.createNodeReplicationLink({
        username: 'owner', ledgerId, localStreamEpoch: replica.streamEpoch,
        peerUrl: 'http://127.0.0.1:12345', peerNodeId: 'srv-rescan-peer',
        peerPublicKey: 'peer-public-key', peerReplicaId: 'rep-rescan-peer',
        peerStreamEpoch: 'epoch-rescan-peer', grantId: 'grant-rescan-peer-0001',
      });
      await store.updateNodeReplicationLink(link.linkId, {
        pullSeq: 8, pushSeq: 5, pullBlobCursor: 'a'.repeat(64),
        pushStateCursor: 'b'.repeat(64), pullBlobScannedBytes: 256,
        pullBlobTransferredBytes: 128, peerHeadSeq: 8, localHeadSeq: 5,
        pullBlobSwept: true, inventoryMatched: true, inventoryBlobHash: 'c'.repeat(64),
      });
      await store.recordReplicaPhysicalStatus('owner', ledgerId, 'c'.repeat(64));
      await store.recordNodeLinkLifecycle(link.linkId, 'READY');
      const reset = await store.rescanNodeReplicationLink('owner', link.linkId);
      expect(reset).toMatchObject({
        linkId: link.linkId, grantId: link.grantId, peerNodeId: link.peerNodeId,
        enabled: true, pullSeq: 0, pushSeq: 0, pullBlobCursor: '',
        pushStateCursor: '', pullBlobScannedBytes: 0,
        pullBlobTransferredBytes: 128, lifecycleState: 'BOOTSTRAPPING',
      });
      expect(reset.pullBlobSweepAt).toBeUndefined();
      expect(reset.inventoryMatchedAt).toBeUndefined();
      expect(reset.physicalVerifiedAt).toBeUndefined();
      expect(await store.replicaPhysicalStatus('owner', ledgerId)).toEqual({});
      expect(await store.getReplica('owner')).toMatchObject({
        ledgerId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
      });
      await expect(store.rescanNodeReplicationLink('other', link.linkId))
        .rejects.toMatchObject({ code: 'LINK_NOT_FOUND' });
      expect(await store.disableNodeReplicationLink('owner', link.linkId)).toBe(true);
      await expect(store.rescanNodeReplicationLink('owner', link.linkId))
        .rejects.toMatchObject({ code: 'LINK_DISABLED' });
    } finally {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
