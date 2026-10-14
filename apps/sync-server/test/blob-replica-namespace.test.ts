import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

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

  it('lets another member resume a V2 upload without exposing it to another replica', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-shared-resume-'));
    const blob = new EncryptedBlobStore({ dataDir: root });
    const ledgerId = 'ledger-shared-resume-0001';
    const chunks = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
    const manifest = { v: 2 as const, blobId: 'a'.repeat(64), cipherBytes: 64, chunkCount: 2,
      chunks: chunks.map((chunk, index) => ({ index, sizeBytes: chunk.byteLength,
        ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: `test-iv-${index}-123456` })) };
    try {
      blob.setReplicaIdResolver(async (username) => username === 'stranger' ? 'rep-other-1' : 'rep-shared-1');
      const first = await blob.beginUpload('owner', ledgerId, manifest);
      await blob.putChunk('owner', first.uploadId!, 0, chunks[0]!);
      const resumed = await blob.beginUpload('member', ledgerId, manifest);
      expect(resumed).toMatchObject({ uploadId: first.uploadId, missingChunks: [1] });
      await expect(blob.putChunk('stranger', first.uploadId!, 1, chunks[1]!))
        .rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
      await expect(blob.completeUpload('stranger', first.uploadId!, 2))
        .rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
      await blob.putChunk('member', first.uploadId!, 1, chunks[1]!);
      await blob.completeUpload('member', first.uploadId!, 2);
      expect(await blob.status('owner', ledgerId, [manifest.blobId]))
        .toEqual({ [manifest.blobId]: 'available' });
      expect(await blob.status('stranger', ledgerId, [manifest.blobId]))
        .toEqual({ [manifest.blobId]: 'missing' });
    } finally {
      await blob.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('charges V2 uploads from every member against one replica quota', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-shared-quota-'));
    const blob = new EncryptedBlobStore({ dataDir: root });
    const store = new SyncServerStore(join(root, 'server.sqlite'), 'open',
      'srv-blob-shared-quota', undefined, blob.ready);
    try {
      await Promise.all([blob.ready, store.ready]);
      await store.register('owner', 'opaque-owner', undefined, true);
      await store.register('member', 'opaque-member');
      const ledgerId = 'ledger-shared-quota-0001';
      const replica = await store.bindReplica('owner', ledgerId);
      const db = new NodeSqliteDriver(join(root, 'server.sqlite'));
      try {
        await db.run('INSERT INTO ledger_account_routes (username, replica_id, created_at) VALUES (?, ?, ?)',
          ['member', replica.replicaId, new Date().toISOString()]);
      } finally { await db.close(); }
      blob.setReplicaIdResolver(async (username) => (await store.getReplica(username))!.replicaId);
      await blob.setUserQuota('owner', 1024 * 1024);
      const bytes = 600 * 1024;
      const manifest = (blobId: string) => ({ v: 2 as const, blobId, cipherBytes: bytes, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: bytes, ciphertextSha256: 'a'.repeat(64), iv: 'test-iv-123456' }] });
      await blob.beginUpload('owner', ledgerId, manifest('a'.repeat(64)));
      expect(await blob.usage('member', ledgerId)).toMatchObject({
        quotaBytes: 1024 * 1024, usedBytes: bytes, stagingBytes: bytes, stagingCount: 1,
      });
      await expect(blob.beginUpload('member', ledgerId, manifest('b'.repeat(64))))
        .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      const quotaDb = new NodeSqliteDriver(join(root, 'server.sqlite'));
      try {
        expect((await quotaDb.get<{ quota_bytes: number }>(
          'SELECT quota_bytes FROM ledger_replica_blob_quotas WHERE replica_id = ?',
          [replica.replicaId]))?.quota_bytes).toBe(1024 * 1024);
        await quotaDb.run('UPDATE ledger_replica_blob_quotas SET quota_bytes = ? WHERE replica_id = ?',
          [2 * 1024 * 1024, replica.replicaId]);
        expect((await quotaDb.get<{ quota_bytes: number }>(
          'SELECT quota_bytes FROM blob_user_quotas WHERE username = ?', ['owner']))?.quota_bytes)
          .toBe(1024 * 1024);
      } finally { await quotaDb.close(); }
      expect((await blob.usage('member', ledgerId)).quotaBytes).toBe(2 * 1024 * 1024);
      await blob.beginUpload('member', ledgerId, manifest('b'.repeat(64)));
      expect((await blob.usage('owner', ledgerId)).stagingCount).toBe(2);
      await blob.setUserQuota('owner', 1024 * 1024);
      expect((await blob.usage('member', ledgerId)).quotaBytes).toBe(1024 * 1024);
    } finally {
      await Promise.all([store.close(), blob.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports member attachment usage against the replica owner and its canonical quota', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-owner-warning-'));
    const blob = new EncryptedBlobStore({ dataDir: root });
    const store = new SyncServerStore(join(root, 'server.sqlite'), 'open',
      'srv-blob-owner-warning', undefined, blob.ready);
    try {
      await Promise.all([blob.ready, store.ready]);
      await store.register('admin', 'opaque-admin', undefined, true);
      await store.register('alice', 'opaque-alice');
      await store.register('bob', 'opaque-bob');
      const ledgerId = 'ledger-blob-owner-warning-0001';
      const replica = await store.bindReplica('alice', ledgerId);
      const db = new NodeSqliteDriver(join(root, 'server.sqlite'));
      try {
        await db.run('INSERT INTO ledger_account_routes (username, replica_id, created_at) VALUES (?, ?, ?)',
          ['bob', replica.replicaId, new Date().toISOString()]);
      } finally { await db.close(); }
      blob.setReplicaIdResolver(async (username) => (await store.getReplica(username))!.replicaId);
      await blob.setUserQuota('alice', 1024 * 1024);
      const bytes = 950 * 1024;
      await blob.beginUpload('bob', ledgerId, { v: 2, blobId: 'c'.repeat(64),
        cipherBytes: bytes, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: bytes, ciphertextSha256: 'd'.repeat(64), iv: 'test-iv-123456' }] });
      expect(await store.capacityWarnings(0.9)).toEqual(expect.arrayContaining([
        expect.objectContaining({ username: 'alice', scope: 'blobs', usedBytes: bytes,
          quotaBytes: 1024 * 1024 }),
      ]));
      expect((await store.capacityWarnings(0.9)).some((warning) =>
        warning.username === 'bob' && warning.scope === 'blobs')).toBe(false);
    } finally {
      await Promise.all([store.close(), blob.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

});
