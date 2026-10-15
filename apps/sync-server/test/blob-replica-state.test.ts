import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { EncryptedBlobStore } from '../src/blob-store.js';

describe('portable attachment replica state', () => {
  it('keeps existing attachments readable after lowering the upload limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-limit-'));
    const store = new EncryptedBlobStore({ dataDir: root });
    const chunk = Buffer.alloc(32 * 1024, 8);
    const manifest = { v: 2 as const, blobId: 'd'.repeat(64), cipherBytes: chunk.byteLength, chunkCount: 1,
      chunks: [{ index: 0, sizeBytes: chunk.byteLength,
        ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] };
    try {
      const plan = await store.beginUpload('owner', 'ledger-limit', manifest);
      await store.putChunk('owner', plan.uploadId!, 0, chunk);
      await store.completeUpload('owner', plan.uploadId!, 2);
      store.setStoragePolicy(20 * 1024 ** 3, 16, 30 * 86_400_000);
      expect(await store.manifest('owner', 'ledger-limit', manifest.blobId)).toMatchObject({ blobId: manifest.blobId });
      expect(Buffer.from((await store.chunk('owner', 'ledger-limit', manifest.blobId, 0))!)).toEqual(chunk);
      expect((await store.beginUpload('owner', 'ledger-limit', manifest)).status).toBe('available');
      await expect(store.beginUpload('owner', 'ledger-limit', { ...manifest, blobId: 'e'.repeat(64) }))
        .rejects.toThrow(/single-file limit/);
    } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('renews an active staged upload when a chunk arrives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-upload-renew-'));
    const store = new EncryptedBlobStore({ dataDir: root, uploadTtlMs: 60_000 });
    const blobId = 'f'.repeat(64);
    const chunk = Buffer.alloc(32, 6);
    const database = new NodeSqliteDriver(join(root, 'server.sqlite'));
    try {
      const plan = await store.beginUpload('owner', 'ledger-upload-renew', {
        v: 2, blobId, cipherBytes: chunk.byteLength, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: chunk.byteLength,
          ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }],
      });
      await database.run('UPDATE blob_uploads SET expires_at = ? WHERE upload_id = ?',
        [new Date(Date.now() - 1000).toISOString(), plan.uploadId]);
      await store.putChunk('owner', plan.uploadId!, 0, chunk);
      const row = await database.get<{ expires_at: string }>(
        'SELECT expires_at FROM blob_uploads WHERE upload_id = ?', [plan.uploadId]);
      expect(Date.parse(row!.expires_at)).toBeGreaterThan(Date.now() + 50_000);
      expect((await store.cleanup()).removedUploads).toBe(0);
      expect((await store.cleanup(new Date(Date.now() + 120_000))).removedUploads).toBe(1);
    } finally {
      await database.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a tombstone after trash cleanup and accepts only a later explicit restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-state-'));
    const store = new EncryptedBlobStore({ dataDir: root, trashRetentionMs: 1000 });
    store.setReplicationNodeId('node-test-1');
    const username = 'owner';
    const ledgerId = 'ledger-test';
    const chunk = Buffer.alloc(32, 7);
    const blobId = 'a'.repeat(64);
    const manifest = { v: 2, blobId, cipherBytes: chunk.byteLength, chunkCount: 1,
      chunks: [{ index: 0, sizeBytes: chunk.byteLength,
        ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] };
    try {
      const plan = await store.beginUpload(username, ledgerId, manifest);
      await store.putChunk(username, plan.uploadId!, 0, chunk);
      await store.completeUpload(username, plan.uploadId!, 2);
      expect(await store.remove(username, ledgerId, blobId)).toBe(true);
      const deletion = (await store.listReplicaStates(username, ledgerId, '', 20)).states[0]!;
      expect(deletion).toMatchObject({ blobId, state: 'trash', counter: 1, writerNodeId: 'node-test-1' });
      await store.cleanup(new Date(Date.now() + 2000));
      expect(await store.status(username, ledgerId, [blobId])).toEqual({ [blobId]: 'missing' });
      await expect(store.beginUpload(username, ledgerId, manifest)).rejects.toMatchObject({ code: 'BLOB_IN_TRASH' });
      expect(await store.applyReplicaState(username, ledgerId,
        { ...deletion, state: 'available', counter: 2, writerNodeId: 'node-test-2' })).toBe(true);
      const restoredPlan = await store.beginUpload(username, ledgerId, manifest);
      await store.putChunk(username, restoredPlan.uploadId!, 0, chunk);
      await store.completeUpload(username, restoredPlan.uploadId!, 2);
      expect(await store.applyReplicaState(username, ledgerId, deletion)).toBe(false);
      expect(await store.status(username, ledgerId, [blobId])).toEqual({ [blobId]: 'available' });
    } finally {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('backfills deletion state for an older V2 object already in trash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-state-migration-'));
    const username = 'owner';
    const ledgerId = 'ledger-test';
    const chunk = Buffer.alloc(32, 9);
    const blobId = 'b'.repeat(64);
    const manifest = { v: 2, blobId, cipherBytes: chunk.byteLength, chunkCount: 1,
      chunks: [{ index: 0, sizeBytes: chunk.byteLength,
        ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] };
    const original = new EncryptedBlobStore({ dataDir: root });
    let originalOpen = true;
    try {
      const plan = await original.beginUpload(username, ledgerId, manifest);
      await original.putChunk(username, plan.uploadId!, 0, chunk);
      await original.completeUpload(username, plan.uploadId!, 2);
      await original.remove(username, ledgerId, blobId);
      await original.close();
      originalOpen = false;
      const database = new NodeSqliteDriver(join(root, 'server.sqlite'));
      try { await database.run('DELETE FROM blob_replica_states'); }
      finally { await database.close(); }
      const migrated = new EncryptedBlobStore({ dataDir: root });
      try {
        expect((await migrated.listReplicaStates(username, ledgerId, '', 20)).states)
          .toMatchObject([{ blobId, state: 'trash', counter: 1, writerNodeId: 'migration' }]);
        await expect(migrated.beginUpload(username, ledgerId, manifest)).rejects.toMatchObject({ code: 'BLOB_IN_TRASH' });
      } finally { await migrated.close(); }
    } finally {
      if (originalOpen) await original.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes a bounded verification scan across username prefixes and page boundaries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-verify-pages-'));
    const store = new EncryptedBlobStore({ dataDir: root });
    const database = new NodeSqliteDriver(join(root, 'server.sqlite'));
    try {
      await store.ready;
      const at = new Date().toISOString();
      for (let index = 0; index < 102; index += 1) {
        const username = index === 0 ? 'ab' : 'ab1';
        const blobId = index.toString(16).padStart(64, '0');
        const manifest = { v: 2, blobId, cipherBytes: 32, chunkCount: 1,
          chunks: [{ index: 0, sizeBytes: 32, ciphertextSha256: 'a'.repeat(64), iv: 'test-iv-123456' }] };
        await database.run(`INSERT INTO blob_objects
          (username, ledger_id, blob_id, namespace, state, cipher_bytes, chunk_count,
           manifest_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'available', 32, 1, ?, ?, ?)`,
        [username, 'ledger-test', blobId, 'f'.repeat(64), JSON.stringify(manifest), at, at]);
      }
      const duplicateId = (50).toString(16).padStart(64, '0');
      const duplicateManifest = { v: 2, blobId: duplicateId, cipherBytes: 32, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: 32, ciphertextSha256: 'a'.repeat(64), iv: 'test-iv-123456' }] };
      await database.run(`INSERT INTO blob_objects
        (username, ledger_id, blob_id, namespace, state, cipher_bytes, chunk_count,
         manifest_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'available', 32, 1, ?, ?, ?)`,
      ['ab1', 'ledger-zz', duplicateId, 'f'.repeat(64), JSON.stringify(duplicateManifest), at, at]);
      const first = await store.verify({ batchSize: 1, shouldCancel: () => true });
      expect(first.cancelled).toBe(true);
      expect(first.lastKey).toBe(`ab|ledger-test|${'0'.repeat(64)}`);
      const progress: { processed: number; total: number }[] = [];
      const resumed = await store.verify({ resumeFrom: first.lastKey, batchSize: 25,
        onProgress: (value) => { progress.push(value); } });
      expect(resumed.cancelled).toBe(false);
      expect(resumed.issues).toHaveLength(102);
      expect(resumed.lastKey).toBe(`ab1|ledger-zz|${duplicateId}`);
      expect(progress.at(-1)).toMatchObject({ processed: 102, total: 102 });
      const legacy = await store.verify({ resumeFrom: `ab|${'0'.repeat(64)}` });
      expect(legacy.issues).toHaveLength(103);
      const scoped = await store.verify({ username: 'ab1', ledgerId: 'ledger-zz' });
      expect(scoped.issues).toHaveLength(1);
    } finally {
      await Promise.all([store.close(), database.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
