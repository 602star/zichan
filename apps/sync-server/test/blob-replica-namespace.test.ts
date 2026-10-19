import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { SyncServerStore } from '../src/store.js';

describe('portable attachment replica namespace', () => {
  it('refuses to join a replica with staged or trashed attachment material', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-join-empty-'));
    const blob = new EncryptedBlobStore({ dataDir: root });
    const store = new SyncServerStore(join(root, 'server.sqlite'), 'open',
      'srv-blob-join-empty', undefined, blob.ready);
    try {
      await store.register('alice', 'opaque-alice', undefined, true);
      const ledgerId = 'ledger-blob-join-empty-0001';
      const replica = await store.bindReplica('alice', ledgerId);
      blob.setReplicaIdResolver(async (username) => (await store.getReplica(username))!.replicaId);
      const chunk = Buffer.alloc(32, 7);
      const blobId = 'e'.repeat(64);
      const plan = await blob.beginUpload('alice', ledgerId, { v: 2, blobId,
        cipherBytes: chunk.byteLength, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: chunk.byteLength,
          ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] });
      const joinReplica = () => store.createNodeReplicationLink({ username: 'alice', ledgerId,
        localStreamEpoch: replica.streamEpoch, peerUrl: 'http://127.0.0.1:9911',
        peerNodeId: 'peer-blob-join-empty', peerPublicKey: 'test-peer-key',
        peerReplicaId: 'rep-peer-blob-join', peerStreamEpoch: 'epoch-peer-blob-join',
        grantId: 'grant-peer-blob-join' });
      await expect(joinReplica()).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
      await blob.putChunk('alice', plan.uploadId!, 0, chunk);
      await blob.completeUpload('alice', plan.uploadId!, 2);
      await blob.remove('alice', ledgerId, blobId);
      await expect(joinReplica()).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
      const db = new NodeSqliteDriver(join(root, 'server.sqlite'));
      try {
        await db.run('DELETE FROM blob_objects WHERE username = ? AND ledger_id = ? AND blob_id = ?',
          ['alice', ledgerId, blobId]);
      } finally { await db.close(); }
      await expect(joinReplica()).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
    } finally {
      await Promise.all([store.close(), blob.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows an empty target replica when another account has attachments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-join-other-'));
    const blob = new EncryptedBlobStore({ dataDir: root });
    const store = new SyncServerStore(join(root, 'server.sqlite'), 'open',
      'srv-blob-join-other', undefined, blob.ready);
    try {
      await store.register('alice', 'opaque-alice', undefined, true);
      await store.register('bob', 'opaque-bob');
      const replica = await store.bindReplica('alice', 'ledger-blob-join-other-a');
      await store.bindReplica('bob', 'ledger-blob-join-other-b');
      blob.setReplicaIdResolver(async (username) => (await store.getReplica(username))!.replicaId);
      await blob.beginUpload('bob', 'ledger-blob-join-other-b', { v: 2, blobId: 'f'.repeat(64),
        cipherBytes: 32, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: 32, ciphertextSha256: 'a'.repeat(64), iv: 'test-iv-123456' }] });
      const link = await store.createNodeReplicationLink({ username: 'alice',
        ledgerId: replica.ledgerId, localStreamEpoch: replica.streamEpoch,
        peerUrl: 'http://127.0.0.1:9912', peerNodeId: 'peer-blob-join-other',
        peerPublicKey: 'test-peer-key', peerReplicaId: 'rep-peer-blob-other',
        peerStreamEpoch: 'epoch-peer-blob-other', grantId: 'grant-peer-blob-other' });
      expect(link.username).toBe('alice');
    } finally {
      await Promise.all([store.close(), blob.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });


});
