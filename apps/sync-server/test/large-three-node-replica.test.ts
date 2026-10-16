import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachmentRemoteBlobId, createLedgerCryptoSession, decryptAttachmentChunk, deriveAttachmentCryptoContext,
  encryptAttachmentChunk, encryptJson, sha256Bytes, sha256Json } from '@zichan/core';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { loadNodeIdentity } from '../src/node-identity.js';
import { replicateNodeBlobs, replicateNodeLink } from '../src/node-replication.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('large three-node replica recovery', () => {
  it('converges paged commits and attachment ciphertext after outage and a mid-copy restart', async () => {
    const stress = process.env['ZICHAN_REPLICA_STRESS'] === '1';
    const stressBlobCount = Number(process.env['ZICHAN_REPLICA_STRESS_BLOBS'] ?? '1000');
    if (stress && (!Number.isSafeInteger(stressBlobCount) || stressBlobCount < 3 || stressBlobCount > 10_000)) {
      throw new Error('ZICHAN_REPLICA_STRESS_BLOBS must be an integer from 3 to 10000');
    }
    const attachmentCounts = stress
      ? [Math.ceil(stressBlobCount / 3), Math.ceil((stressBlobCount - 1) / 3), Math.floor(stressBlobCount / 3)]
      : [40, 40, 40];
    const expectedAttachmentCount = attachmentCounts.reduce((count, next) => count + next, 0);
    const root = mkdtempSync(join(tmpdir(), 'zichan-large-replica-'));
    let hub = createTestSyncServer({ dataDir: join(root, 'hub') });
    let home = createTestSyncServer({ dataDir: join(root, 'home') });
    let office = createTestSyncServer({ dataDir: join(root, 'office') });
    const nodes = () => [hub, home, office];
    let stores: SyncServerStore[] = [];
    let blobs: EncryptedBlobStore[] = [];
    let sample: { blobId: string; plainHash: string; contents: Buffer } | undefined;
    try {
      await Promise.all(nodes().map((node) => node.ready));
      stores = nodes().map((node) => new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId));
      await Promise.all(stores.map((store) => store.ready));
      await Promise.all(nodes().map((node) => new Promise<void>((resolve) =>
        node.server.listen(0, '127.0.0.1', resolve))));
      await Promise.all(stores.map((store) => store.register('owner', 'opaque-owner', undefined, true)));
      const ledgerId = 'ledger-large-three-node-0001';
      const session = createLedgerCryptoSession(ledgerId);
      const replicas = await Promise.all(stores.map((store) => store.bindReplica('owner', ledgerId)));
      const envelope = { ledgerId, keyringId: session.keyringId, generation: 1 };
      await Promise.all(stores.map((store) => store.putKeyEnvelope('owner', ledgerId,
        envelope.keyringId, 1, envelope)));
      blobs = nodes().map((node, index) => {
        const result = new EncryptedBlobStore({ dataDir: node.dataDir });
        result.setReplicaIdResolver(async () => replicas[index]!.replicaId);
        result.setReplicationNodeId(node.serverId);
        return result;
      });
      await Promise.all(blobs.map((blob) => blob.ready));
      const hubUrl = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
      const hubKey = loadNodeIdentity(hub.dataDir, hub.serverId).publicKey;
      for (const [index, node] of [[1, home], [2, office]] as const) {
        const grant = await stores[0]!.createNodeReplicationGrant('owner', node.serverId,
          loadNodeIdentity(node.dataDir, node.serverId).publicKey,
          new Date(Date.now() + 86_400_000).toISOString());
        await stores[index]!.createNodeReplicationLink({ username: 'owner', ledgerId,
          localStreamEpoch: replicas[index]!.streamEpoch, peerUrl: hubUrl,
          peerNodeId: hub.serverId, peerPublicKey: hubKey,
          peerReplicaId: replicas[0]!.replicaId, peerStreamEpoch: replicas[0]!.streamEpoch,
          grantId: grant.grantId });
      }
      const write = async (index: number, count: number) => {
        const nodeId = nodes()[index]!.serverId;
        const commits = await Promise.all(Array.from({ length: count }, async (_, number) => {
          const commitId = `commit-${nodeId}-${String(number).padStart(5, '0')}`;
          const commit = { protocol: 2, ledgerId, commitId, originDeviceId: nodeId,
            createdAt: '2026-10-08T00:00:00.000Z', parentCommitIds: [], revisions: [] };
          const contentHash = await sha256Json(commit);
          return { commitId, ledgerId, contentHash,
            encCommit: await encryptJson(session, commit, { protocol: 2, ledgerId, commitId, contentHash }) };
        }));
        for (let offset = 0; offset < commits.length; offset += 100) {
          await stores[index]!.pushCommits('owner', commits.slice(offset, offset + 100));
        }
      };
      const upload = async (index: number, count: number) => {
        const nodeId = nodes()[index]!.serverId;
        const context = await deriveAttachmentCryptoContext(session, { v: 2, ledgerId });
        for (let number = 0; number < count; number += 1) {
          const contents = Buffer.alloc(index === 2 && number === 0
            ? 5 * 1024 * 1024 + 17 : 64 * 1024, (number + index * 37) % 251);
          // Fixed width prevents a short label plus its fill byte from matching a longer label.
          contents.write(`${nodeId}/${String(number).padStart(6, '0')}`);
          const plainHash = await sha256Bytes(contents);
          const blobId = await attachmentRemoteBlobId(context, plainHash);
          if (index === 2 && number === 0) sample = { blobId, plainHash, contents };
          const chunkSize = 1024 * 1024;
          const chunkCount = Math.ceil(contents.length / chunkSize);
          const encrypted = [];
          for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
            encrypted.push(await encryptAttachmentChunk(context, plainHash,
              contents.subarray(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize),
              chunkIndex, chunkCount, contents.length));
          }
          const manifest = { v: 2 as const, blobId,
            cipherBytes: encrypted.reduce((total, chunk) => total + chunk.ciphertext.length, 0),
            chunkCount, chunks: encrypted.map((chunk) => ({ index: chunk.index,
              sizeBytes: chunk.ciphertext.length, ciphertextSha256: chunk.ciphertextSha256, iv: chunk.iv })) };
          const plan = await blobs[index]!.beginUpload('owner', ledgerId, manifest);
          if (!plan.uploadId) throw new Error(`new attachment upload expected at node ${index} object ${number}`);
          for (const chunk of encrypted) {
            await blobs[index]!.putChunk('owner', plan.uploadId, chunk.index, chunk.ciphertext);
          }
          await blobs[index]!.completeUpload('owner', plan.uploadId, 2);
        }
      };
      await write(0, 401);
      await upload(0, attachmentCounts[0]);
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      await new Promise<void>((resolve, reject) => hub.server.close((error) => error ? reject(error) : resolve()));
      await Promise.all([write(1, 401), write(2, 401)]);
      await Promise.all([upload(1, attachmentCounts[1]), upload(2, attachmentCounts[2])]);
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      expect((await stores[0]!.replicaInventory('owner', ledgerId)).commitCount).toBe(401);
      // The receiver has only the first encrypted photo chunk when connectivity returns.
      // Node replication must ask for the remaining chunks instead of restarting the object.
      const partialManifest = await blobs[2]!.manifest('owner', ledgerId, sample!.blobId);
      expect(partialManifest?.chunkCount).toBeGreaterThan(1);
      const partialChunk = await blobs[2]!.chunk('owner', ledgerId, sample!.blobId, 0);
      const partialPlan = await blobs[0]!.beginUpload('owner', ledgerId, partialManifest);
      expect(partialPlan.uploadId).toBeTruthy();
      await blobs[0]!.putChunk('owner', partialPlan.uploadId!, 0, partialChunk!);
      expect((await blobs[0]!.beginUpload('owner', ledgerId, partialManifest)).missingChunks)
        .toEqual(Array.from({ length: partialManifest!.chunkCount - 1 }, (_, index) => index + 1));
      await new Promise<void>((resolve) => hub.server.listen(new URL(hubUrl).port, '127.0.0.1', resolve));
      const officeLink = (await stores[2]!.listNodeReplicationLinks('owner'))[0]!;
      await replicateNodeLink(stores[2]!, loadNodeIdentity(office.dataDir, office.serverId), officeLink);
      await replicateNodeBlobs(stores[2]!, blobs[2]!, loadNodeIdentity(office.dataDir, office.serverId), officeLink);
      // Keep the test's observer connections open. Reinitializing a second
      // schema writer while the restarted service is catching up can take
      // SQLite's write lock away from the service under a large backlog.
      await office.close();
      office = createTestSyncServer({ dataDir: join(root, 'office') });
      await office.ready;
      await new Promise<void>((resolve) => office.server.listen(0, '127.0.0.1', resolve));
      let inventories = await Promise.all(stores.map((store) => store.replicaInventory('owner', ledgerId)));
      let links = await Promise.all(stores.slice(1).map(async (store) =>
        (await store.listNodeReplicationLinks('owner'))[0]!));
      for (let round = 0; round < (stress ? Math.max(40, Math.ceil(expectedAttachmentCount / 25)) : 12); round += 1) {
        await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
        inventories = await Promise.all(stores.map((store) => store.replicaInventory('owner', ledgerId)));
        links = await Promise.all(stores.slice(1).map(async (store) =>
          (await store.listNodeReplicationLinks('owner'))[0]!));
        if (stress) console.log('stress progress', round + 1,
          inventories.map((inventory) => inventory.blobCount),
          links.map((link) => ({ pull: link.pullBlobCursor.slice(0, 10),
            push: link.pushBlobCursor.slice(0, 10), error: link.lastError,
            issue: link.inventoryIssue })));
        if (inventories.every((inventory) => inventory.commitCount === 1_203
          && inventory.blobCount === expectedAttachmentCount)
          && links.every((link) => link.pullBlobSweepAt && link.pushBlobSweepAt
            && link.inventoryMatchedAt && !link.lastError && !link.inventoryIssue)) break;
      }
      for (const inventory of inventories) {
        expect(inventory).toMatchObject({ commitCount: 1_203,
          blobCount: expectedAttachmentCount, legacyBlobCount: 0 });
        expect(inventory.commitHash).toBe(inventories[0]!.commitHash);
        expect(inventory.blobHash).toBe(inventories[0]!.blobHash);
      }
      for (const link of links) {
        expect(link.lastError).toBeUndefined();
        expect(link.inventoryIssue).toBeUndefined();
        expect(link.pullBlobSweepAt).toBeDefined();
        expect(link.pushBlobSweepAt).toBeDefined();
        expect(link.inventoryMatchedAt).toBeDefined();
      }
      expect(sample).toBeDefined();
      const context = await deriveAttachmentCryptoContext(session, { v: 2, ledgerId });
      for (const blob of blobs) {
        const manifest = await blob.manifest('owner', ledgerId, sample!.blobId);
        expect(manifest?.v).toBe(2);
        expect(manifest?.chunkCount).toBeGreaterThan(1);
        const plaintextChunks = [];
        for (const entry of manifest!.chunks) {
          const ciphertext = await blob.chunk('owner', ledgerId, sample!.blobId, entry.index);
          expect(ciphertext).toBeDefined();
          plaintextChunks.push(Buffer.from(await decryptAttachmentChunk(context, sample!.plainHash,
            { index: entry.index, iv: entry.iv, ciphertext: ciphertext!,
              ciphertextSha256: entry.ciphertextSha256 }, manifest!.chunkCount, sample!.contents.length)));
        }
        expect(Buffer.concat(plaintextChunks)).toEqual(sample!.contents);
      }
    } finally {
      await Promise.all(nodes().map((node) => node.close()));
      await Promise.all(blobs.map((blob) => blob.close()));
      await Promise.all(stores.map((store) => store.close()));
      rmSync(root, { recursive: true, force: true });
    }
  }, process.env['ZICHAN_REPLICA_STRESS'] === '1'
    ? Math.max(600_000, Number(process.env['ZICHAN_REPLICA_STRESS_BLOBS'] ?? '1000') * 600)
    : 120_000);
});
