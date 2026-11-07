import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { loadNodeIdentity } from '../src/node-identity.js';
import { replicateNodeBlobs, signedCall } from '../src/node-replication.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('node attachment chunk progress', () => {
  it('reports an unfinished encrypted object and resumes only its missing chunks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-node-blob-progress-'));
    const source = createTestSyncServer({ dataDir: join(root, 'source') });
    const targetDir = join(root, 'target');
    mkdirSync(targetDir, { recursive: true });
    const targetId = 'node-blob-progress-target';
    await source.ready;
    const sourceStore = new SyncServerStore(join(source.dataDir, 'server.sqlite'), 'open', source.serverId);
    await sourceStore.ready;
    const sourceBlobs = new EncryptedBlobStore({ dataDir: source.dataDir });
    await sourceBlobs.ready;
    const targetStore = new SyncServerStore(join(targetDir, 'server.sqlite'), 'open', targetId);
    await targetStore.ready;
    const targetBlobs = new EncryptedBlobStore({ dataDir: targetDir });
    await targetBlobs.ready;
    try {
      await new Promise<void>((resolve) => source.server.listen(0, '127.0.0.1', resolve));
      const ledgerId = 'ledger-node-blob-progress-0001';
      await Promise.all([sourceStore.register('owner', 'opaque-owner', undefined, true),
        targetStore.register('owner', 'opaque-owner', undefined, true)]);
      const sourceReplica = await sourceStore.bindReplica('owner', ledgerId);
      const targetReplica = await targetStore.bindReplica('owner', ledgerId);
      sourceBlobs.setReplicaIdResolver(async () => sourceReplica.replicaId);
      targetBlobs.setReplicaIdResolver(async () => targetReplica.replicaId);
      const chunks = [0, 1, 2].map((index) => Buffer.alloc(256 * 1024, index + 1));
      const manifest = { v: 2 as const, blobId: randomBytes(32).toString('hex'),
        cipherBytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
        chunkCount: chunks.length, chunks: chunks.map((chunk, index) => ({ index,
          sizeBytes: chunk.byteLength, ciphertextSha256: createHash('sha256').update(chunk).digest('hex'),
          iv: randomBytes(12).toString('base64url') })) };
      const upload = await sourceBlobs.beginUpload('owner', ledgerId, manifest);
      expect(upload.uploadId).toBeTruthy();
      for (const [index, chunk] of chunks.entries()) {
        await sourceBlobs.putChunk('owner', upload.uploadId!, index, chunk);
      }
      await sourceBlobs.completeUpload('owner', upload.uploadId!, 2);
      const targetIdentity = loadNodeIdentity(targetDir, targetId);
      const sourceIdentity = loadNodeIdentity(source.dataDir, source.serverId);
      const grant = await sourceStore.createNodeReplicationGrant('owner', targetId,
        targetIdentity.publicKey, new Date(Date.now() + 60_000).toISOString());
      const sourceUrl = `http://127.0.0.1:${(source.server.address() as AddressInfo).port}`;
      const link = await targetStore.createNodeReplicationLink({ username: 'owner', ledgerId,
        localStreamEpoch: targetReplica.streamEpoch, peerUrl: sourceUrl,
        peerNodeId: source.serverId, peerPublicKey: sourceIdentity.publicKey,
        peerReplicaId: sourceReplica.replicaId, peerStreamEpoch: sourceReplica.streamEpoch,
        grantId: grant.grantId });
      const recordChunk = targetStore.recordNodeBlobTransfer.bind(targetStore);
      let interrupted = false;
      targetStore.recordNodeBlobTransfer = async (linkId, direction, bytes) => {
        await recordChunk(linkId, direction, bytes);
        if (direction === 'pull' && !interrupted) {
          interrupted = true;
          throw new Error('simulated interruption after first confirmed chunk');
        }
      };
      await expect(replicateNodeBlobs(targetStore, targetBlobs, targetIdentity, link,
        { push: false })).rejects.toThrow('simulated interruption');
      expect(interrupted).toBe(true);
      expect((await targetStore.listNodeReplicationLinks('owner'))[0]!.pullBlobTransferredBytes)
        .toBe(chunks[0]!.byteLength);
      expect(await targetBlobs.manifest('owner', ledgerId, manifest.blobId)).toBeUndefined();
      expect((await targetBlobs.beginUpload('owner', ledgerId, manifest)).missingChunks).toEqual([1, 2]);
      targetStore.recordNodeBlobTransfer = recordChunk;
      await replicateNodeBlobs(targetStore, targetBlobs, targetIdentity, link, { push: false });
      expect((await targetStore.listNodeReplicationLinks('owner'))[0]!.pullBlobTransferredBytes)
        .toBe(manifest.cipherBytes);
      expect(await targetBlobs.manifest('owner', ledgerId, manifest.blobId)).toEqual(manifest);
      for (const index of [0, 1]) {
        const chunk = Buffer.alloc(64, index + 4);
        const smallManifest = { v: 2 as const, blobId: randomBytes(32).toString('hex'),
          cipherBytes: chunk.byteLength, chunkCount: 1,
          chunks: [{ index: 0, sizeBytes: chunk.byteLength,
            ciphertextSha256: createHash('sha256').update(chunk).digest('hex'),
            iv: randomBytes(12).toString('base64url') }] };
        const smallUpload = await sourceBlobs.beginUpload('owner', ledgerId, smallManifest);
        await sourceBlobs.putChunk('owner', smallUpload.uploadId!, 0, chunk);
        await sourceBlobs.completeUpload('owner', smallUpload.uploadId!, 2);
      }
      let pageWrites = 0;
      targetStore.recordNodeBlobTransfer = async (linkId, direction, bytes) => {
        pageWrites += 1;
        await recordChunk(linkId, direction, bytes);
      };
      let readPackRequests = 0;
      let individualChunkReads = 0;
      const observeRead = (request: { url?: string }) => {
        if (request.url?.startsWith('/api/v4/replication/blobs/pack/read?ids=')) readPackRequests += 1;
        if (/^\/api\/v4\/replication\/blobs\/[a-f0-9]{64}\/chunks\/0$/.test(request.url ?? '')) {
          individualChunkReads += 1;
        }
      };
      source.server.on('request', observeRead);
      try { await replicateNodeBlobs(targetStore, targetBlobs, targetIdentity, link, { push: false }); }
      finally { source.server.off('request', observeRead); }
      expect(readPackRequests).toBe(1);
      expect(individualChunkReads).toBe(0);
      expect(pageWrites).toBe(1);
      expect((await targetStore.listNodeReplicationLinks('owner'))[0]!.pullBlobTransferredBytes)
        .toBe(manifest.cipherBytes + 2 * 64);
      const outgoingIds: string[] = [];
      for (const index of [0, 1]) {
        const chunk = Buffer.alloc(64, index + 8);
        const outgoing = { v: 2 as const, blobId: randomBytes(32).toString('hex'),
          cipherBytes: chunk.byteLength, chunkCount: 1,
          chunks: [{ index: 0, sizeBytes: chunk.byteLength,
            ciphertextSha256: createHash('sha256').update(chunk).digest('hex'),
            iv: randomBytes(12).toString('base64url') }] };
        outgoingIds.push(outgoing.blobId);
        const plan = await targetBlobs.beginUpload('owner', ledgerId, outgoing);
        await targetBlobs.putChunk('owner', plan.uploadId!, 0, chunk);
        await targetBlobs.completeUpload('owner', plan.uploadId!, 2);
      }
      let packRequests = 0;
      let individualUploadRequests = 0;
      const observe = (request: { url?: string }) => {
        if (request.url === '/api/v4/replication/blobs/pack') packRequests += 1;
        if (request.url === '/api/v4/replication/blobs/uploads') individualUploadRequests += 1;
      };
      source.server.on('request', observe);
      try { await replicateNodeBlobs(targetStore, targetBlobs, targetIdentity, link, { pull: false }); }
      finally { source.server.off('request', observe); }
      expect(packRequests).toBe(1);
      expect(individualUploadRequests).toBe(0);
      expect((await targetStore.listNodeReplicationLinks('owner'))[0]!.pushBlobTransferredBytes).toBe(2 * 64);
      for (const blobId of outgoingIds) {
        expect(await sourceBlobs.manifest('owner', ledgerId, blobId)).toBeDefined();
      }
      await expect(signedCall(targetIdentity, link, 'POST', '/api/v4/replication/blobs/pack',
        Buffer.from([0, 0, 0, 12, 123]))).rejects.toThrow('HTTP 400');
      await expect(signedCall(targetIdentity, link, 'GET',
        '/api/v4/replication/blobs/pack/read?ids=invalid')).rejects.toThrow('HTTP 400');
    } finally {
      await Promise.all([sourceBlobs.close(), targetBlobs.close(), sourceStore.close(), targetStore.close()]);
      await source.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 360_000);
});
