import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadNodeIdentity } from '../src/node-identity.js';
import { replicateNodeAttachmentPromise } from '../src/node-replication.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('node attachment promise replication', () => {
  it('resumes a paged pull and later pushes a newer catalog with the commit frontier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-node-promise-'));
    const source = createTestSyncServer({ dataDir: join(root, 'source') });
    const peer = createTestSyncServer({ dataDir: join(root, 'peer') });
    let sourceStore: SyncServerStore | undefined;
    let peerStore: SyncServerStore | undefined;
    try {
      await Promise.all([source.ready, peer.ready]);
      await new Promise<void>((resolve) => source.server.listen(0, '127.0.0.1', resolve));
      sourceStore = new SyncServerStore(join(source.dataDir, 'server.sqlite'), 'open', source.serverId);
      peerStore = new SyncServerStore(join(peer.dataDir, 'server.sqlite'), 'open', peer.serverId);
      await sourceStore.register('owner', 'opaque-source-owner', undefined, true);
      await peerStore.register('owner', 'opaque-peer-owner', undefined, true);
      const ledgerId = 'ledger-node-promise-0001';
      const sourceReplica = await sourceStore.bindReplica('owner', ledgerId);
      const peerReplica = await peerStore.bindReplica('owner', ledgerId);
      const keyringId = 'keyring-node-promise-0001';
      const envelope = { ledgerId, keyringId, generation: 1 };
      await sourceStore.putKeyEnvelope('owner', ledgerId, keyringId, 1, envelope);
      await peerStore.putKeyEnvelope('owner', ledgerId, keyringId, 1, envelope);
      const grant = await sourceStore.createNodeReplicationGrant('owner', peer.serverId,
        loadNodeIdentity(peer.dataDir, peer.serverId).publicKey,
        new Date(Date.now() + 86_400_000).toISOString());
      const link = await peerStore.createNodeReplicationLink({ username: 'owner', ledgerId,
        localStreamEpoch: peerReplica.streamEpoch,
        peerUrl: `http://127.0.0.1:${(source.server.address() as AddressInfo).port}`,
        peerNodeId: source.serverId,
        peerPublicKey: loadNodeIdentity(source.dataDir, source.serverId).publicKey,
        peerReplicaId: sourceReplica.replicaId, peerStreamEpoch: sourceReplica.streamEpoch,
        grantId: grant.grantId });
      const ids = Array.from({ length: 4_001 }, (_, index) => index.toString(16).padStart(64, '0'));
      const first = await sourceStore.beginAttachmentPromise('owner', ids.length);
      for (let offset = 0; offset < ids.length; offset += 2_000) {
        await sourceStore.appendAttachmentPromisePage('owner', first.uploadId, ids.slice(offset, offset + 2_000));
      }
      const original = await sourceStore.completeAttachmentPromise('owner', first.uploadId);
      const interrupted = await peerStore.beginReplicatedAttachmentPromise('owner', source.serverId, original);
      expect(interrupted).not.toBeNull();
      await peerStore.appendAttachmentPromisePage('owner', interrupted!.uploadId,
        ids.slice(0, 2_000), undefined, source.serverId);
      expect(await replicateNodeAttachmentPromise(peerStore,
        loadNodeIdentity(peer.dataDir, peer.serverId), link)).toBe(true);
      const copied = await peerStore.attachmentPromisePage('owner', ids[3_999], 10);
      expect(copied.catalog).toMatchObject({ commitCount: original.commitCount,
        commitHash: original.commitHash, blobCount: original.blobCount, blobHash: original.blobHash });
      expect(copied.blobIds).toEqual([ids[4_000]]);
      expect((await peerStore.replicaInventory('owner', ledgerId)).missingPromisedBlobCount).toBe(ids.length);

      const commitId = 'commit-node-promise-0001';
      await peerStore.pushCommits('owner', [{ commitId, ledgerId, contentHash: 'a'.repeat(64),
        encCommit: { v: 3, keyId: 'test-key-id-0000001', iv: 'test-iv', ct: 'test-ciphertext' } }]);
      const next = await peerStore.beginAttachmentPromise('owner', 1);
      await peerStore.appendAttachmentPromisePage('owner', next.uploadId, [ids[4_000]!]);
      const replacement = await peerStore.completeAttachmentPromise('owner', next.uploadId);
      await peer.flushNodeReplication();
      expect((await sourceStore.attachmentPromisePage('owner')).catalog).toMatchObject({
        commitCount: replacement.commitCount, commitHash: replacement.commitHash,
        blobCount: replacement.blobCount, blobHash: replacement.blobHash,
      });
      expect((await sourceStore.attachmentPromisePage('owner')).blobIds).toEqual([ids[4_000]]);
      expect((await sourceStore.replicaInventory('owner', ledgerId)).missingPromisedBlobCount).toBe(1);
      expect((await peerStore.listNodeReplicationLinks('owner'))[0]?.inventoryIssue)
        .toMatch(/附件承诺目录/);
    } finally {
      await Promise.all([sourceStore?.close(), peerStore?.close()]);
      await Promise.all([source.close(), peer.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
