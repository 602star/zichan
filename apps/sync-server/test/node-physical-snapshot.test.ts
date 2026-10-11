import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { verifyReplicaPhysical } from '../src/node-replication.js';
import { SyncServerStore } from '../src/store.js';

describe('replica physical scan snapshot', () => {
  it('refuses to certify an old catalog after a valid attachment appears before the scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-physical-snapshot-'));
    const blob = new EncryptedBlobStore({ dataDir: root });
    const store = new SyncServerStore(join(root, 'server.sqlite'), 'open',
      'server-physical-snapshot', undefined, blob.ready);
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      const ledgerId = 'ledger-physical-snapshot-0001';
      const replica = await store.bindReplica('owner', ledgerId);
      await store.putKeyEnvelope('owner', ledgerId, 'keyring-physical-snapshot', 1,
        { ledgerId, keyringId: 'keyring-physical-snapshot', generation: 1 });
      blob.setReplicaIdResolver(async () => replica.replicaId);
      const before = await store.replicaInventory('owner', ledgerId);
      const bytes = Buffer.alloc(32, 7);
      const blobId = '7'.repeat(64);
      const upload = await blob.beginUpload('owner', ledgerId, { v: 2, blobId,
        cipherBytes: bytes.byteLength, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: bytes.byteLength,
          ciphertextSha256: createHash('sha256').update(bytes).digest('hex'), iv: 'test-iv-123456' }] });
      await blob.putChunk('owner', upload.uploadId!, 0, bytes);
      await blob.completeUpload('owner', upload.uploadId!, 2);
      await verifyReplicaPhysical(store, blob, 'owner', ledgerId, () => false, before);
      expect(await store.replicaPhysicalStatus('owner', ledgerId)).toMatchObject({
        issue: expect.stringContaining('目录发生变化'),
      });
      expect((await store.replicaPhysicalStatus('owner', ledgerId)).verifiedAt).toBeUndefined();
      const current = await store.replicaInventory('owner', ledgerId);
      await expect(verifyReplicaPhysical(store, blob, 'owner', ledgerId, () => false,
        { ...current, streamEpoch: 'epoch-replaced-0001' }))
        .rejects.toMatchObject({ code: 'REPLICA_CHANGED' });
      expect((await store.replicaPhysicalStatus('owner', ledgerId)).verifiedAt).toBeUndefined();
      await verifyReplicaPhysical(store, blob, 'owner', ledgerId);
      expect(await store.replicaPhysicalStatus('owner', ledgerId)).toMatchObject({
        verifiedAt: expect.any(String),
      });
      await expect(store.recordReplicaPhysicalStatus('owner', ledgerId, current.blobHash, undefined,
        { replicaId: current.replicaId, streamEpoch: 'epoch-replaced-0001' }))
        .rejects.toMatchObject({ code: 'REPLICA_CHANGED' });
    } finally {
      await store.close();
      await blob.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
