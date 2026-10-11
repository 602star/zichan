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
  it('records an explicit ownership decision in the sidecar and restores it after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-owner-decision-'));
    const file = join(root, 'server.sqlite');
    const ledgerId = 'ledger-blob-owner-decision';
    const blobId = '8'.repeat(64);
    const chunk = Buffer.alloc(32, 8);
    let blob = new EncryptedBlobStore({ dataDir: root });
    let store = new SyncServerStore(file, 'open', 'srv-blob-owner-decision', undefined, blob.ready);
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      const old = await store.bindReplica('owner', ledgerId);
      const upload = await blob.beginUpload('owner', ledgerId, { v: 2, blobId,
        cipherBytes: chunk.byteLength, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: chunk.byteLength,
          ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] });
      await blob.putChunk('owner', upload.uploadId!, 0, chunk);
      await blob.completeUpload('owner', upload.uploadId!, 2);
      const db = new NodeSqliteDriver(file);
      try {
        await db.run(`INSERT INTO ledger_replacement_checkpoints
          (checkpoint_id, username, replica_id, ledger_id, stream_epoch, head_seq, envelope_json, created_at)
          VALUES (?, ?, ?, ?, ?, 0, '{}', ?)`,
        ['checkpoint-' + 'd'.repeat(32), 'owner', old.replicaId, ledgerId,
          old.streamEpoch, new Date().toISOString()]);
        await db.run(`UPDATE sync_replicas SET replica_id = ?, stream_epoch = ?, updated_at = ?
          WHERE username = ?`, ['rep-blob-owner-decision-new', 'epoch-blob-owner-decision-new',
          new Date().toISOString(), 'owner']);
      } finally { await db.close(); }
      expect((await blob.reconcileReplicaOwnership()).unownedObjects).toBe(1);
      expect((await blob.listUnownedReplicaRecords('object')).records[0]?.formatVersion).toBe(2);
      const catalogDb = new NodeSqliteDriver(file);
      let objectNamespace: string;
      try {
        const row = await catalogDb.get<{ namespace: string }>(
          'SELECT namespace FROM blob_objects WHERE blob_id = ?', [blobId]);
        objectNamespace = row!.namespace;
      } finally { await catalogDb.close(); }
      const chunkPath = join(root, 'blobs', 'objects', objectNamespace,
        blobId.slice(0, 2), blobId, '0.chunk');
      writeFileSync(chunkPath, Buffer.alloc(chunk.byteLength, 9));
      await expect(blob.assignUnownedObject({ username: 'owner', ledgerId, blobId,
        replicaId: old.replicaId, actorAccountId: 'account-operator',
        reason: 'Checked the original ledger key and attachment ciphertext.' }))
        .rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_FAILED' });
      expect(await blob.listOwnershipDecisions()).toEqual([]);
      writeFileSync(chunkPath, chunk);
      await expect(blob.assignUnownedObject({ username: 'owner', ledgerId, blobId,
        replicaId: 'rep-not-a-candidate', actorAccountId: 'account-operator',
        reason: 'Checked the original ledger key and attachment ciphertext.' }))
        .rejects.toMatchObject({ code: 'REPLICA_CANDIDATE_REQUIRED' });
      const decision = await blob.assignUnownedObject({ username: 'owner', ledgerId, blobId,
        replicaId: old.replicaId, actorAccountId: 'account-operator',
        reason: 'Checked the original ledger key and attachment ciphertext.' });
      expect(decision).toMatchObject({ kind: 'object', fromReplicaId: null,
        toReplicaId: old.replicaId, actorAccountId: 'account-operator' });
      expect(await blob.unownedReplicaRecords()).toEqual({ objects: 0, states: 0, uploads: 0 });
      expect(await blob.listOwnershipDecisions()).toEqual([decision]);
      blob.setReplicaIdResolver(async () => old.replicaId);
      expect(await blob.remove('owner', ledgerId, blobId)).toBe(true);
      expect(await blob.restore('owner', ledgerId, blobId)).toBe(true);
      await store.close();
      await blob.close();
      blob = new EncryptedBlobStore({ dataDir: root });
      store = new SyncServerStore(file, 'closed', 'srv-blob-owner-decision', undefined, blob.ready);
      await store.ready;
      expect(await blob.listOwnershipDecisions()).toEqual([decision]);
      const reopened = new NodeSqliteDriver(file);
      try {
        const row = await reopened.get<{ replica_id: string; namespace: string }>(
          'SELECT replica_id, namespace FROM blob_objects WHERE blob_id = ?', [blobId]);
        expect(row?.replica_id).toBe(old.replicaId);
        const sidecar = JSON.parse(readFileSync(join(root, 'blobs', 'objects', row!.namespace,
          blobId.slice(0, 2), blobId, 'object.json'), 'utf8')) as { ownershipDecision: unknown };
        expect(sidecar.ownershipDecision).toEqual(decision);
      } finally { await reopened.close(); }
    } finally {
      await Promise.all([store.close(), blob.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the replica namespace to resolve ambiguous old objects, tombstones and uploads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-ambiguous-'));
    const file = join(root, 'server.sqlite');
    const blob = new EncryptedBlobStore({ dataDir: root });
    const store = new SyncServerStore(file, 'open', 'srv-blob-ambiguous', undefined, blob.ready);
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      const ledgerId = 'ledger-blob-ambiguous-0001';
      const old = await store.bindReplica('owner', ledgerId);
      const chunk = Buffer.alloc(32, 4);
      const manifest = (blobId: string) => ({ v: 2 as const, blobId,
        cipherBytes: chunk.byteLength, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: chunk.byteLength,
          ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] });
      const legacyId = '1'.repeat(64);
      const portableId = '2'.repeat(64);
      const pendingId = '3'.repeat(64);
      const legacy = await blob.beginUpload('owner', ledgerId, manifest(legacyId));
      await blob.putChunk('owner', legacy.uploadId!, 0, chunk);
      await blob.completeUpload('owner', legacy.uploadId!, 2);
      blob.setReplicaIdResolver(async () => old.replicaId);
      const portable = await blob.beginUpload('owner', ledgerId, manifest(portableId));
      await blob.putChunk('owner', portable.uploadId!, 0, chunk);
      await blob.completeUpload('owner', portable.uploadId!, 2);
      await blob.remove('owner', ledgerId, portableId);
      await blob.beginUpload('owner', ledgerId, manifest(pendingId));
      const db = new NodeSqliteDriver(file);
      try {
        const row = await db.get<{ namespace: string }>(
          'SELECT namespace FROM blob_objects WHERE blob_id = ?', [portableId]);
        const sidecarPath = join(root, 'blobs', 'trash', row!.namespace,
          portableId.slice(0, 2), portableId, 'object.json');
        const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>;
        delete sidecar['replicaId'];
        writeFileSync(sidecarPath, JSON.stringify(sidecar));
        await db.run('UPDATE blob_objects SET replica_id = NULL WHERE blob_id = ?', [portableId]);
        await db.run('UPDATE blob_replica_states SET replica_id = NULL WHERE blob_id = ?', [portableId]);
        await db.run('UPDATE blob_uploads SET replica_id = NULL WHERE blob_id = ?', [pendingId]);
        await db.run(`INSERT INTO ledger_replacement_checkpoints
          (checkpoint_id, username, replica_id, ledger_id, stream_epoch, head_seq, envelope_json, created_at)
          VALUES (?, ?, ?, ?, ?, 0, '{}', ?)`,
        ['checkpoint-' + 'c'.repeat(32), 'owner', old.replicaId, ledgerId,
          old.streamEpoch, new Date().toISOString()]);
        await db.run(`UPDATE sync_replicas SET replica_id = ?, stream_epoch = ?, updated_at = ?
          WHERE username = ?`, ['rep-blob-ambiguous-new', 'epoch-blob-ambiguous-new',
          new Date().toISOString(), 'owner']);
      } finally { await db.close(); }
      const result = await blob.reconcileReplicaOwnership();
      expect(result).toMatchObject({ objectsUpdated: 1, statesUpdated: 1, uploadsUpdated: 1,
        unownedObjects: 1 });
      const unowned = await blob.listUnownedReplicaRecords('object');
      expect(unowned.records).toMatchObject([{ kind: 'object', username: 'owner', ledgerId,
        blobId: legacyId, replicaId: null, formatVersion: 2, namespaceMatches: [] }]);
      expect(new Set(unowned.records[0]?.candidateReplicaIds))
        .toEqual(new Set([old.replicaId, 'rep-blob-ambiguous-new']));
      blob.setReplicaIdResolver(async () => 'rep-blob-ambiguous-new');
      expect(await blob.status('owner', ledgerId, [legacyId, portableId]))
        .toEqual({ [legacyId]: 'missing', [portableId]: 'missing' });
      expect((await blob.listPortableManifests('owner', ledgerId, '', 10)).manifests).toEqual([]);
      expect((await blob.usage('owner', ledgerId)).usedBytes).toBe(0);
      await expect(blob.beginUpload('owner', ledgerId, manifest(legacyId)))
        .rejects.toMatchObject({ code: 'BLOB_OWNERSHIP_UNRESOLVED' });
      const ambiguousState = new NodeSqliteDriver(file);
      try {
        await ambiguousState.run(`INSERT INTO blob_replica_states
          (username, ledger_id, replica_id, blob_id, state, counter, writer_node_id, changed_at)
          VALUES (?, ?, NULL, ?, 'available', 1, 'migration', ?)`,
        ['owner', ledgerId, legacyId, new Date().toISOString()]);
        await expect(blob.applyReplicaState('owner', ledgerId, { blobId: legacyId,
          state: 'trash', counter: 2, writerNodeId: 'peer-node', changedAt: new Date().toISOString() }))
          .rejects.toMatchObject({ code: 'BLOB_OWNERSHIP_UNRESOLVED' });
        expect(await ambiguousState.get<{ replica_id: string | null; state: string }>(
          'SELECT replica_id, state FROM blob_replica_states WHERE blob_id = ?', [legacyId]))
          .toEqual({ replica_id: null, state: 'available' });
      } finally { await ambiguousState.close(); }
      const checked = new NodeSqliteDriver(file);
      try {
        expect((await checked.get<{ replica_id: string }>(
          'SELECT replica_id FROM blob_objects WHERE blob_id = ?', [portableId]))?.replica_id).toBe(old.replicaId);
        expect((await checked.get<{ replica_id: string }>(
          'SELECT replica_id FROM blob_replica_states WHERE blob_id = ?', [portableId]))?.replica_id).toBe(old.replicaId);
        expect((await checked.get<{ replica_id: string }>(
          'SELECT replica_id FROM blob_uploads WHERE blob_id = ?', [pendingId]))?.replica_id).toBe(old.replicaId);
        expect((await checked.get<{ replica_id: string | null }>(
          'SELECT replica_id FROM blob_objects WHERE blob_id = ?', [legacyId]))?.replica_id).toBeNull();
      } finally { await checked.close(); }
    } finally {
      await Promise.all([store.close(), blob.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves unresolved trash and staged ciphertext when normal retention expires', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-unowned-retention-'));
    const file = join(root, 'server.sqlite');
    const blob = new EncryptedBlobStore({ dataDir: root, trashRetentionMs: 1000 });
    const store = new SyncServerStore(file, 'open', 'srv-unowned-retention', undefined, blob.ready);
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      const ledgerId = 'ledger-unowned-retention';
      const old = await store.bindReplica('owner', ledgerId);
      const chunk = Buffer.alloc(32, 5);
      const manifest = (blobId: string) => ({ v: 2 as const, blobId,
        cipherBytes: chunk.byteLength, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: chunk.byteLength,
          ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] });
      const unownedTrashId = 'a'.repeat(64);
      const ownedTrashId = 'b'.repeat(64);
      const unownedUploadId = 'c'.repeat(64);
      const ownedUploadId = 'd'.repeat(64);
      const createTrash = async (blobId: string) => {
        const plan = await blob.beginUpload('owner', ledgerId, manifest(blobId));
        await blob.putChunk('owner', plan.uploadId!, 0, chunk);
        await blob.completeUpload('owner', plan.uploadId!, 2);
        await blob.remove('owner', ledgerId, blobId);
      };
      await createTrash(unownedTrashId);
      const unownedPlan = await blob.beginUpload('owner', ledgerId, manifest(unownedUploadId));
      await blob.putChunk('owner', unownedPlan.uploadId!, 0, chunk);
      blob.setReplicaIdResolver(async () => old.replicaId);
      await createTrash(ownedTrashId);
      await blob.beginUpload('owner', ledgerId, manifest(ownedUploadId));
      const db = new NodeSqliteDriver(file);
      try {
        await db.run(`INSERT INTO ledger_replacement_checkpoints
          (checkpoint_id, username, replica_id, ledger_id, stream_epoch, head_seq, envelope_json, created_at)
          VALUES (?, ?, ?, ?, ?, 0, '{}', ?)`,
        ['checkpoint-' + 'e'.repeat(32), 'owner', old.replicaId, ledgerId,
          old.streamEpoch, new Date().toISOString()]);
        await db.run(`UPDATE sync_replicas SET replica_id = ?, stream_epoch = ?, updated_at = ?
          WHERE username = ?`, ['rep-unowned-retention-new', 'epoch-unowned-retention-new',
          new Date().toISOString(), 'owner']);
      } finally { await db.close(); }
      expect(await blob.reconcileReplicaOwnership()).toMatchObject({ unownedObjects: 1, unownedUploads: 1 });
      const removed = await blob.cleanup(new Date(Date.now() + 60 * 24 * 60 * 60 * 1000));
      expect(removed).toMatchObject({ removedObjects: 1, removedUploads: 1 });
      expect(await blob.unownedReplicaRecords()).toMatchObject({ objects: 1, uploads: 1 });
      const reopened = new NodeSqliteDriver(file);
      let uploadNamespace = '';
      try {
        const trash = await reopened.get<{ namespace: string }>(
          'SELECT namespace FROM blob_objects WHERE blob_id = ?', [unownedTrashId]);
        const upload = await reopened.get<{ namespace: string; upload_id: string }>(
          'SELECT namespace, upload_id FROM blob_uploads WHERE blob_id = ?', [unownedUploadId]);
        uploadNamespace = upload!.namespace;
        expect(existsSync(join(root, 'blobs', 'trash', trash!.namespace,
          unownedTrashId.slice(0, 2), unownedTrashId, 'object.json'))).toBe(true);
        expect(existsSync(join(root, 'blobs', 'staging', upload!.namespace,
          upload!.upload_id, 'manifest.json'))).toBe(true);
        expect(await reopened.get('SELECT 1 FROM blob_objects WHERE blob_id = ?', [ownedTrashId])).toBeUndefined();
        expect(await reopened.get('SELECT 1 FROM blob_uploads WHERE blob_id = ?', [ownedUploadId])).toBeUndefined();
      } finally { await reopened.close(); }
      const uploadRow = await blob.listUnownedReplicaRecords('upload');
      expect(uploadRow.records).toMatchObject([{ blobId: unownedUploadId,
        recordId: unownedPlan.uploadId, formatVersion: 2 }]);
      const uploadedChunk = join(root, 'blobs', 'staging', uploadNamespace,
        unownedPlan.uploadId!, '0.chunk');
      writeFileSync(uploadedChunk, Buffer.alloc(chunk.byteLength, 8));
      const repair = { username: 'owner', ledgerId, blobId: unownedUploadId,
        uploadId: unownedPlan.uploadId!, replicaId: old.replicaId,
        actorAccountId: 'account-operator',
        reason: 'Checked the source ledger key and every saved encrypted chunk.' };
      await expect(blob.assignUnownedUpload(repair)).rejects.toMatchObject({ code: 'UPLOAD_CATALOG_CONFLICT' });
      writeFileSync(uploadedChunk, chunk);
      expect(await blob.assignUnownedUpload(repair)).toMatchObject({ kind: 'upload',
        fromReplicaId: null, toReplicaId: old.replicaId });
      expect(await blob.unownedReplicaRecords()).toMatchObject({ objects: 1, uploads: 0 });
      expect((await blob.cleanup(new Date(Date.now() + 60 * 24 * 60 * 60 * 1000))).removedUploads)
        .toBe(0);
      await blob.completeUpload('owner', unownedPlan.uploadId!, 2);
    } finally {
      await Promise.all([store.close(), blob.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pages unowned state records and reports a replica bound to the wrong ledger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-unowned-inventory-'));
    const file = join(root, 'server.sqlite');
    const blob = new EncryptedBlobStore({ dataDir: root });
    const store = new SyncServerStore(file, 'open', 'srv-unowned-inventory', undefined, blob.ready);
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      await store.register('other', 'opaque-other');
      const ledgerId = 'ledger-unowned-inventory';
      const correct = await store.bindReplica('owner', ledgerId);
      const wrong = await store.bindReplica('other', 'ledger-other-inventory');
      blob.setReplicaIdResolver(async () => correct.replicaId);
      const db = new NodeSqliteDriver(file);
      try {
        for (const [blobId, replicaId] of [['1'.repeat(64), null], ['2'.repeat(64), wrong.replicaId]]) {
          await db.run(`INSERT INTO blob_replica_states
            (username, ledger_id, replica_id, blob_id, state, counter, writer_node_id, changed_at)
            VALUES (?, ?, ?, ?, 'trash', 1, 'migration', ?)`,
          ['owner', ledgerId, replicaId, blobId, new Date().toISOString()]);
        }
        const uploadId = 'a'.repeat(32);
        const blobId = '3'.repeat(64);
        await db.run(`INSERT INTO blob_uploads
          (upload_id, username, ledger_id, replica_id, blob_id, namespace, cipher_bytes,
            chunk_count, manifest_json, created_at, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, 32, 1, ?, ?, ?, ?)`,
        [uploadId, 'owner', wrong.ledgerId, correct.replicaId, blobId, 'f'.repeat(64),
          JSON.stringify({ v: 2, blobId, cipherBytes: 32, chunkCount: 1,
            chunks: [{ index: 0, sizeBytes: 32, ciphertextSha256: 'e'.repeat(64), iv: 'test-iv-123456' }] }),
          new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()]);
      } finally { await db.close(); }
      expect(await blob.unownedReplicaRecords()).toEqual({ objects: 0, states: 2, uploads: 1 });
      expect((await blob.usage('owner', ledgerId)).usedBytes).toBe(0);
      const first = await blob.listUnownedReplicaRecords('state', '', 1);
      expect(first.records).toMatchObject([{ blobId: '1'.repeat(64), replicaId: null,
        candidateReplicaIds: [correct.replicaId] }]);
      expect(first.nextCursor).toBeTruthy();
      const second = await blob.listUnownedReplicaRecords('state', first.nextCursor, 1);
      expect(second.records).toMatchObject([{ blobId: '2'.repeat(64), replicaId: wrong.replicaId,
        candidateReplicaIds: [correct.replicaId] }]);
      expect(second.nextCursor).toBeUndefined();
      await expect(blob.assignUnownedState({ username: 'owner', ledgerId, blobId: '1'.repeat(64),
        replicaId: wrong.replicaId, actorAccountId: 'account-operator',
        reason: 'Checked the original deletion event and its ledger identity.' }))
        .rejects.toMatchObject({ code: 'REPLICA_CANDIDATE_REQUIRED' });
      const decision = await blob.assignUnownedState({ username: 'owner', ledgerId,
        blobId: '1'.repeat(64), replicaId: correct.replicaId,
        actorAccountId: 'account-operator',
        reason: 'Checked the original deletion event and its ledger identity.' });
      expect(decision).toMatchObject({ kind: 'state', fromReplicaId: null,
        toReplicaId: correct.replicaId });
      expect(await blob.listOwnershipDecisions()).toEqual([decision]);
      expect((await blob.listUnownedReplicaRecords('state')).records)
        .toMatchObject([{ blobId: '2'.repeat(64) }]);
    } finally {
      await Promise.all([store.close(), blob.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it('reconciles an old object sidecar during real server startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-startup-ownership-'));
    const serverId = 'srv-blob-startup-owner';
    const first = createTestSyncServer({ dataDir: root, serverId });
    await first.ready;
    await first.close();
    const blob = new EncryptedBlobStore({ dataDir: root });
    const store = new SyncServerStore(join(root, 'server.sqlite'), 'open', serverId, undefined, blob.ready);
    let storeClosed = false;
    let blobClosed = false;
    const ledgerId = 'ledger-blob-startup-owner-0001';
    const blobId = '9'.repeat(64);
    const chunk = Buffer.alloc(32, 9);
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      const replica = await store.bindReplica('owner', ledgerId);
      const upload = await blob.beginUpload('owner', ledgerId, { v: 2 as const, blobId,
        cipherBytes: chunk.byteLength, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: chunk.byteLength,
          ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] });
      await blob.putChunk('owner', upload.uploadId!, 0, chunk);
      await blob.completeUpload('owner', upload.uploadId!, 2);
      await store.close(); storeClosed = true;
      await blob.close(); blobClosed = true;
      const restarted = createTestSyncServer({ dataDir: root, serverId });
      try {
        await restarted.ready;
        const database = new NodeSqliteDriver(join(root, 'server.sqlite'));
        try {
          const row = await database.get<{ namespace: string; replica_id: string }>(
            'SELECT namespace, replica_id FROM blob_objects WHERE blob_id = ?', [blobId]);
          expect(row?.replica_id).toBe(replica.replicaId);
          const sidecar = JSON.parse(readFileSync(join(root, 'blobs', 'objects', row!.namespace,
            blobId.slice(0, 2), blobId, 'object.json'), 'utf8')) as { replicaId?: string };
          expect(sidecar.replicaId).toBe(replica.replicaId);
        } finally { await database.close(); }
      } finally { await restarted.close(); }
    } finally {
      if (!storeClosed) await store.close();
      if (!blobClosed) await blob.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes uniquely proven archived ownership back to legacy sidecars and leaves true orphans unassigned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-orphan-recovery-'));
    const file = join(root, 'server.sqlite');
    const oldLedgerId = 'ledger-orphan-owner-old-0001';
    const chunk = Buffer.alloc(32, 5);
    const manifest = (blobId: string) => ({ v: 2 as const, blobId,
      cipherBytes: chunk.byteLength, chunkCount: 1,
      chunks: [{ index: 0, sizeBytes: chunk.byteLength,
        ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] });
    const oldBlobId = '1'.repeat(64);
    const orphanId = '2'.repeat(64);
    const trashId = '3'.repeat(64);
    const pendingId = '4'.repeat(64);
    let blob = new EncryptedBlobStore({ dataDir: root });
    let store: SyncServerStore | undefined;
    try {
      for (const [username, blobId] of [['owner', oldBlobId], ['orphan', orphanId]]) {
        const upload = await blob.beginUpload(username!, oldLedgerId, manifest(blobId!));
        await blob.putChunk(username!, upload.uploadId!, 0, chunk);
        await blob.completeUpload(username!, upload.uploadId!, 2);
      }
      const trashed = await blob.beginUpload('owner', oldLedgerId, manifest(trashId));
      await blob.putChunk('owner', trashed.uploadId!, 0, chunk);
      await blob.completeUpload('owner', trashed.uploadId!, 2);
      await blob.remove('owner', oldLedgerId, trashId);
      const pending = await blob.beginUpload('owner', oldLedgerId, manifest(pendingId));
      await blob.putChunk('owner', pending.uploadId!, 0, chunk);
      store = new SyncServerStore(file, 'open', 'srv-blob-orphan-recovery', undefined, blob.ready);
      await store.register('owner', 'opaque-owner', undefined, true);
      const oldReplica = await store.bindReplica('owner', oldLedgerId);
      const database = new NodeSqliteDriver(file);
      try {
        await database.run(`INSERT INTO ledger_replacement_checkpoints
          (checkpoint_id, username, replica_id, ledger_id, stream_epoch, head_seq, envelope_json, created_at)
          VALUES (?, ?, ?, ?, ?, 0, '{}', ?)`,
        ['checkpoint-' + 'a'.repeat(32), 'owner', oldReplica.replicaId,
          oldLedgerId, oldReplica.streamEpoch, new Date().toISOString()]);
        await database.run(`UPDATE sync_replicas SET ledger_id = ?, replica_id = ?, stream_epoch = ?, updated_at = ?
          WHERE username = ?`, ['ledger-orphan-owner-new-0001', 'rep-orphan-new-0001',
          'epoch-orphan-new-0001', new Date().toISOString(), 'owner']);
      } finally { await database.close(); }
      await store.close(); store = undefined;
      await blob.close();
      blob = new EncryptedBlobStore({ dataDir: root });
      store = new SyncServerStore(file, 'closed', 'srv-blob-orphan-recovery', undefined, blob.ready);
      await store.ready;
      const result = await blob.reconcileReplicaOwnership();
      expect(result.objectsUpdated).toBe(2);
      expect(result.statesUpdated).toBe(1);
      expect(result.uploadsUpdated).toBe(1);
      expect(result.unownedObjects).toBe(1);
      expect(await blob.unownedReplicaRecords()).toMatchObject({ objects: 1, states: 0, uploads: 0 });
      const checked = new NodeSqliteDriver(file);
      try {
        const owner = await checked.get<{ replica_id: string; namespace: string }>(
          'SELECT replica_id, namespace FROM blob_objects WHERE username = ? AND blob_id = ?',
          ['owner', oldBlobId]);
        expect(owner?.replica_id).toBe(oldReplica.replicaId);
        const sidecar = JSON.parse(readFileSync(join(root, 'blobs', 'objects', owner!.namespace,
          oldBlobId.slice(0, 2), oldBlobId, 'object.json'), 'utf8')) as { replicaId?: string };
        expect(sidecar.replicaId).toBe(oldReplica.replicaId);
        expect((await checked.get<{ replica_id: string | null }>(
          'SELECT replica_id FROM blob_objects WHERE username = ?', ['orphan']))?.replica_id).toBeNull();
        expect((await checked.get<{ replica_id: string }>(
          'SELECT replica_id FROM blob_replica_states WHERE blob_id = ?', [trashId]))?.replica_id)
          .toBe(oldReplica.replicaId);
        expect((await checked.get<{ replica_id: string }>(
          'SELECT replica_id FROM blob_uploads WHERE blob_id = ?', [pendingId]))?.replica_id)
          .toBe(oldReplica.replicaId);
      } finally { await checked.close(); }
      await store.close(); store = undefined;
      await blob.close();
      blob = new EncryptedBlobStore({ dataDir: root });
      store = new SyncServerStore(file, 'closed', 'srv-blob-orphan-recovery', undefined, blob.ready);
      await store.ready;
      const restarted = new NodeSqliteDriver(file);
      try {
        expect((await restarted.get<{ replica_id: string }>(
          'SELECT replica_id FROM blob_objects WHERE username = ?', ['owner']))?.replica_id)
          .toBe(oldReplica.replicaId);
      } finally { await restarted.close(); }
    } finally {
      await store?.close();
      await blob.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('backfills an old account attachment quota into its replica during schema 23 upgrade', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-quota-upgrade-'));
    const file = join(root, 'server.sqlite');
    let blob = new EncryptedBlobStore({ dataDir: root });
    let store = new SyncServerStore(file, 'open', 'srv-blob-quota-upgrade', undefined, blob.ready);
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      const replica = await store.bindReplica('owner', 'ledger-blob-quota-upgrade-0001');
      await blob.setUserQuota('owner', 3 * 1024 * 1024);
      await store.close();
      await blob.close();
      const database = new NodeSqliteDriver(file);
      try {
        await database.run('DELETE FROM ledger_replica_blob_quotas');
        await database.run(`UPDATE server_schema_migrations SET version = 23,
          name = 'ledger_replacement_checkpoints_v23'`);
      } finally { await database.close(); }
      blob = new EncryptedBlobStore({ dataDir: root });
      store = new SyncServerStore(file, 'closed', 'srv-blob-quota-upgrade', undefined, blob.ready);
      await store.ready;
      const reopened = new NodeSqliteDriver(file);
      try {
        expect((await reopened.get<{ quota_bytes: number }>(
          'SELECT quota_bytes FROM ledger_replica_blob_quotas WHERE replica_id = ?',
          [replica.replicaId]))?.quota_bytes).toBe(3 * 1024 * 1024);
      } finally { await reopened.close(); }
    } finally {
      await Promise.all([store.close(), blob.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers V1 source accounts only inside the selected replica', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-legacy-routes-'));
    const blob = new EncryptedBlobStore({ dataDir: root });
    const ledgerId = 'ledger-legacy-routes-0001';
    const blobId = 'f'.repeat(64);
    const chunk = Buffer.alloc(32, 9);
    const manifest = { v: 1 as const, blobId, cipherBytes: chunk.byteLength, chunkCount: 1,
      chunks: [{ index: 0, sizeBytes: chunk.byteLength,
        ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] };
    try {
      const plan = await blob.beginUpload('old-owner', ledgerId, manifest);
      await blob.putChunk('old-owner', plan.uploadId!, 0, chunk);
      await blob.completeUpload('old-owner', plan.uploadId!, 1);
      const database = new NodeSqliteDriver(join(root, 'server.sqlite'));
      try {
        const object = await database.get<{ namespace: string }>(
          'SELECT namespace FROM blob_objects WHERE blob_id = ?', [blobId]);
        await database.run('UPDATE blob_objects SET replica_id = ? WHERE blob_id = ?', ['rep-original-1', blobId]);
        const sidecarPath = join(root, 'blobs', 'objects', object!.namespace, blobId.slice(0, 2), blobId, 'object.json');
        const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>;
        writeFileSync(sidecarPath, JSON.stringify({ ...sidecar, replicaId: 'rep-original-1' }));
      }
      finally { await database.close(); }
      blob.setReplicaIdResolver(async (username) => username === 'new-member' ? 'rep-original-1' : 'rep-other-1');
      expect(await blob.listLegacyRoutes('new-member', ledgerId)).toEqual(['old-owner']);
      expect(await blob.status('new-member', ledgerId, [blobId])).toEqual({ [blobId]: 'available' });
      expect(await blob.chunk('new-member', ledgerId, blobId, 0)).toEqual(chunk);
      expect(await blob.listLegacyRoutes('old-owner', ledgerId)).toEqual([]);
      expect(await blob.status('old-owner', ledgerId, [blobId])).toEqual({ [blobId]: 'missing' });
      const portableId = 'e'.repeat(64);
      const portable = { ...manifest, v: 2 as const, blobId: portableId };
      const portableUpload = await blob.beginUpload('new-member', ledgerId, portable);
      await blob.putChunk('new-member', portableUpload.uploadId!, 0, chunk);
      await blob.completeUpload('new-member', portableUpload.uploadId!, 2);
      expect((await blob.usage('new-member', ledgerId)).usedBytes).toBe(chunk.byteLength * 2);
      await expect(blob.markLegacyMigrated('old-owner', ledgerId, blobId, portableId, 'account-old-owner'))
        .rejects.toMatchObject({ code: 'BLOB_MIGRATION_UNAVAILABLE' });
      await blob.markLegacyMigrated('new-member', ledgerId, blobId, portableId, 'account-new-member');
      expect(await blob.usage('new-member', ledgerId)).toMatchObject({
        usedBytes: chunk.byteLength, objectCount: 1,
      });
      expect((await blob.usage('old-owner')).usedBytes).toBe(0);
      expect(await blob.listLegacyRoutes('new-member', ledgerId)).toEqual([]);
      expect((await blob.listPortableManifests('new-member', ledgerId, '', 10)).legacyObjects).toBe(0);
      expect(await blob.status('new-member', ledgerId, [blobId])).toEqual({ [blobId]: 'available' });
      await blob.remove('new-member', ledgerId, portableId);
      expect((await blob.usage('new-member', ledgerId)).usedBytes).toBe(chunk.byteLength * 2);
      expect(await blob.listLegacyRoutes('new-member', ledgerId)).toEqual(['old-owner']);
      expect((await blob.listPortableManifests('new-member', ledgerId, '', 10)).legacyObjects).toBe(1);
      await blob.restore('new-member', ledgerId, portableId);
      expect((await blob.usage('new-member', ledgerId)).usedBytes).toBe(chunk.byteLength);
      expect(await blob.listLegacyRoutes('new-member', ledgerId)).toEqual([]);
      const audit = new NodeSqliteDriver(join(root, 'server.sqlite'));
      try {
        expect(await audit.get(`SELECT actor_account_id, portable_blob_id FROM blob_v1_migrations
          WHERE replica_id = ? AND legacy_blob_id = ?`, ['rep-original-1', blobId]))
          .toEqual({ actor_account_id: 'account-new-member', portable_blob_id: portableId });
      } finally { await audit.close(); }
      const restarted = new EncryptedBlobStore({ dataDir: root });
      try {
        await restarted.ready;
        restarted.setReplicaIdResolver(async (username) => username === 'new-member'
          ? 'rep-original-1' : 'rep-other-1');
        expect(await restarted.listLegacyRoutes('new-member', ledgerId)).toEqual([]);
        expect((await restarted.listPortableManifests('new-member', ledgerId, '', 10)).legacyObjects).toBe(0);
        expect(await restarted.status('new-member', ledgerId, [blobId])).toEqual({ [blobId]: 'available' });
      } finally { await restarted.close(); }
    } finally {
      await blob.close();
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

  it('keeps legacy objects readable while new V2 objects use independent replica slots after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-replica-slot-'));
    const ledgerId = 'ledger-shared-0001';
    const chunk = Buffer.alloc(32, 7);
    const manifest = (blobId: string) => ({ v: 2 as const, blobId, cipherBytes: chunk.byteLength, chunkCount: 1,
      chunks: [{ index: 0, sizeBytes: chunk.byteLength,
        ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] });
    const legacyId = 'a'.repeat(64);
    const newId = 'b'.repeat(64);
    let store = new EncryptedBlobStore({ dataDir: root });
    let closed = false;
    const upload = async (username: string, blobId: string): Promise<void> => {
      const plan = await store.beginUpload(username, ledgerId, manifest(blobId));
      await store.putChunk(username, plan.uploadId!, 0, chunk);
      await store.completeUpload(username, plan.uploadId!, 2);
    };
    try {
      await upload('alice', legacyId);
      store.setReplicaIdResolver(async (username) => username === 'bob' ? 'rep-bob-1' : 'rep-alice');
      const pending = await store.beginUpload('alice', ledgerId, manifest(newId));
      expect(await store.beginUpload('member', ledgerId, manifest(newId)))
        .toMatchObject({ uploadId: pending.uploadId, missingChunks: [0] });
      await store.putChunk('alice', pending.uploadId!, 0, chunk);
      await store.completeUpload('alice', pending.uploadId!, 2);
      expect((await store.beginUpload('member', ledgerId, manifest(newId))).status).toBe('available');
      await upload('bob', newId);
      expect(await store.status('member', ledgerId, [newId])).toEqual({ [newId]: 'available' });
      expect(await store.manifest('member', ledgerId, newId)).toEqual(manifest(newId));
      expect(await store.chunk('member', ledgerId, newId, 0)).toEqual(chunk);
      expect(await store.remove('member', ledgerId, newId)).toBe(true);
      expect(await store.status('alice', ledgerId, [newId])).toEqual({ [newId]: 'trash' });
      await expect(store.beginUpload('member', ledgerId, manifest(newId)))
        .rejects.toMatchObject({ code: 'BLOB_IN_TRASH' });
      expect(await store.restore('member', ledgerId, newId)).toBe(true);
      const restoredState = (await store.listReplicaStates('member', ledgerId, '', 10)).states[0]!;
      expect(await store.applyReplicaState('member', ledgerId,
        { ...restoredState, state: 'trash', counter: restoredState.counter + 1,
          writerNodeId: 'node-peer', changedAt: new Date().toISOString() })).toBe(true);
      expect(await store.status('alice', ledgerId, [newId])).toEqual({ [newId]: 'trash' });
      expect(await store.applyReplicaState('member', ledgerId,
        { ...restoredState, state: 'available', counter: restoredState.counter + 2,
          writerNodeId: 'node-peer', changedAt: new Date().toISOString() })).toBe(true);
      expect((await store.listPortableManifests('member', ledgerId, '', 10)).manifests.map((row) => row.blobId))
        .toEqual([newId]);
      expect((await store.listReplicaStates('member', ledgerId, '', 10)).states)
        .toMatchObject([{ blobId: newId, state: 'available' }]);
      expect(await store.verify({ username: 'member', ledgerId, replicaObjectsOnly: true }))
        .toMatchObject({ checkedObjects: 1, checkedChunks: 1, issues: [] });
      expect((await store.listPortableManifests('bob', ledgerId, '', 10)).manifests.map((row) => row.blobId))
        .toEqual([newId]);
      expect((await store.listPortableManifests('member', 'ledger-other-0001', '', 10)).manifests)
        .toEqual([]);
      const database = new NodeSqliteDriver(join(root, 'server.sqlite'));
      let before: { username: string; blob_id: string; namespace: string; replica_id: string | null }[];
      try {
        before = await database.all('SELECT username, blob_id, namespace, replica_id FROM blob_objects ORDER BY username, blob_id');
        expect(await database.get<{ replica_id: string }>(
          'SELECT replica_id FROM blob_replica_states WHERE username = ? AND blob_id = ?', ['alice', newId]))
          .toEqual({ replica_id: 'rep-alice' });
        expect(await database.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM blob_replica_states WHERE replica_id = ?', ['rep-alice']))
          .toEqual({ count: 1 });
      } finally { await database.close(); }
      expect(before).toHaveLength(3);
      expect(new Set(before.map((row) => row.namespace)).size).toBe(3);
      expect(before.map((row) => row.replica_id)).toEqual([null, 'rep-alice', 'rep-bob-1']);
      expect(await store.chunk('alice', ledgerId, legacyId, 0)).toEqual(chunk);
      expect(await store.chunk('alice', ledgerId, newId, 0)).toEqual(chunk);
      expect(await store.chunk('bob', ledgerId, newId, 0)).toEqual(chunk);
      store.setReplicaIdResolver(async (username) => username === 'alice' ? 'rep-new-1'
        : username === 'bob' ? 'rep-bob-1' : 'rep-alice');
      expect(await store.status('alice', ledgerId, [newId])).toEqual({ [newId]: 'missing' });
      expect(await store.manifest('alice', ledgerId, newId)).toBeUndefined();
      expect((await store.listReplicaStates('alice', ledgerId, '', 10)).states).toEqual([]);
      expect(await store.chunk('member', ledgerId, newId, 0)).toEqual(chunk);

      await store.close();
      closed = true;
      store = new EncryptedBlobStore({ dataDir: root });
      closed = false;
      expect(await store.chunk('alice', ledgerId, legacyId, 0)).toEqual(chunk);
      expect(await store.chunk('alice', ledgerId, newId, 0)).toEqual(chunk);
      expect(await store.chunk('bob', ledgerId, newId, 0)).toEqual(chunk);
      const restored = new NodeSqliteDriver(join(root, 'server.sqlite'));
      try {
        expect(await restored.all('SELECT username, blob_id, namespace, replica_id FROM blob_objects ORDER BY username, blob_id'))
          .toEqual(before);
      } finally { await restored.close(); }
    } finally {
      if (!closed) await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('backfills legacy attachment objects, tombstones and active uploads without copying ciphertext', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-slot-backfill-'));
    const file = join(root, 'server.sqlite');
    const username = 'owner';
    const ledgerId = 'ledger-old-blob-0001';
    const chunk = Buffer.alloc(32, 3);
    const manifest = (blobId: string) => ({ v: 2 as const, blobId, cipherBytes: chunk.byteLength, chunkCount: 1,
      chunks: [{ index: 0, sizeBytes: chunk.byteLength,
        ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] });
    const storedId = 'c'.repeat(64);
    const pendingId = 'd'.repeat(64);
    const memberLegacyId = 'b'.repeat(64);
    const backupId = '9'.repeat(64);
    const secondChunk = Buffer.alloc(32, 4);
    const pendingManifest = { v: 2 as const, blobId: pendingId, cipherBytes: chunk.byteLength + secondChunk.byteLength,
      chunkCount: 2, chunks: [chunk, secondChunk].map((part, index) => ({ index,
        sizeBytes: part.byteLength, ciphertextSha256: createHash('sha256').update(part).digest('hex'),
        iv: `test-iv-${index}-123456` })) };
    const firstBlob = new EncryptedBlobStore({ dataDir: root });
    let firstBlobClosed = false;
    let firstStore: SyncServerStore | undefined;
    let restoredBlob: EncryptedBlobStore | undefined;
    let restoredStore: SyncServerStore | undefined;
    try {
      const plan = await firstBlob.beginUpload(username, ledgerId, manifest(storedId));
      await firstBlob.putChunk(username, plan.uploadId!, 0, chunk);
      await firstBlob.completeUpload(username, plan.uploadId!, 2);
      await firstBlob.remove(username, ledgerId, storedId);
      const pending = await firstBlob.beginUpload(username, ledgerId, pendingManifest);
      await firstBlob.putChunk(username, pending.uploadId!, 0, chunk);
      const memberLegacy = await firstBlob.beginUpload('member', ledgerId,
        { ...manifest(memberLegacyId), v: 1 });
      await firstBlob.putChunk('member', memberLegacy.uploadId!, 0, chunk);
      await firstBlob.completeUpload('member', memberLegacy.uploadId!, 1);
      const backup = await firstBlob.beginUpload(username, ledgerId,
        { ...manifest(backupId), v: 1 });
      await firstBlob.putChunk(username, backup.uploadId!, 0, chunk);
      await firstBlob.completeUpload(username, backup.uploadId!, 1);
      firstStore = new SyncServerStore(file, 'open', 'srv-blob-backfill', undefined, firstBlob.ready);
      await firstStore.register(username, 'opaque-record', undefined, true);
      await firstStore.register('member', 'opaque-member');
      const replica = await firstStore.bindReplica(username, ledgerId);
      const routeDatabase = new NodeSqliteDriver(file);
      try { await routeDatabase.run('INSERT INTO ledger_account_routes (username, replica_id, created_at) VALUES (?, ?, ?)',
        ['member', replica.replicaId, new Date().toISOString()]); }
      finally { await routeDatabase.close(); }
      await firstStore.putKeyEnvelope(username, ledgerId, 'keyring-legacy', 1,
        { ledgerId, keyringId: 'keyring-legacy', generation: 1 });
      await firstStore.putBackupArchive(username, ledgerId, {
        archiveId: 'archive-backfill-0001', blobId: backupId,
        createdAt: new Date().toISOString(), reason: 'auto', kind: 'device',
        label: 'Automatic backup', sizeBytes: chunk.byteLength,
      });
      await firstStore.close();
      firstStore = undefined;
      await firstBlob.close();
      firstBlobClosed = true;

      restoredBlob = new EncryptedBlobStore({ dataDir: root });
      restoredStore = new SyncServerStore(file, 'closed', 'srv-blob-backfill', undefined, restoredBlob.ready);
      await restoredStore.ready;
      const database = new NodeSqliteDriver(file);
      try {
        for (const table of ['blob_objects', 'blob_replica_states', 'blob_uploads']) {
          expect(await database.get<{ replica_id: string }>(
            `SELECT replica_id FROM ${table} WHERE username = ? AND ledger_id = ?`, [username, ledgerId]))
            .toEqual({ replica_id: replica.replicaId });
        }
        expect(await database.get<{ replica_id: string }>(
          "SELECT replica_id FROM blob_objects WHERE username = 'member' AND blob_id = ?", [memberLegacyId]))
          .toEqual({ replica_id: replica.replicaId });
        const at = new Date().toISOString();
        for (const [scopedLedger, blobId] of [[ledgerId, 'e'.repeat(64)], ['ledger-other-0001', 'f'.repeat(64)]]) {
          await database.run(`INSERT INTO blob_objects
            (username, ledger_id, replica_id, blob_id, namespace, state, cipher_bytes, chunk_count,
             manifest_json, created_at, updated_at)
            VALUES ('member', ?, ?, ?, ?, 'available', ?, 1, ?, ?, ?)`,
          [scopedLedger, replica.replicaId, blobId, 'a'.repeat(64), chunk.byteLength,
            JSON.stringify(manifest(blobId)), at, at]);
        }
      } finally { await database.close(); }
      expect((await restoredBlob.listReplicaStates(username, ledgerId, '', 10)).states)
        .toMatchObject([{ blobId: storedId, state: 'trash' }]);
      expect(await restoredStore.replicaInventory(username, ledgerId))
        .toMatchObject({ blobCount: 1, tombstoneCount: 1, legacyBlobCount: 1 });
      restoredBlob.setReplicaIdResolver(async (account) => (await restoredStore!.getReplica(account))!.replicaId);
      expect((await restoredBlob.listPortableManifests(username, ledgerId, '', 10)).legacyObjects).toBe(1);
      expect(await restoredBlob.listLegacyRoutes(username, ledgerId)).toEqual(['member']);
      expect(await restoredBlob.beginUpload('member', ledgerId, pendingManifest))
        .toMatchObject({ uploadId: pending.uploadId, missingChunks: [1] });
      await restoredBlob.putChunk('member', pending.uploadId!, 1, secondChunk);
      await restoredBlob.completeUpload('member', pending.uploadId!, 2);
      expect(await restoredBlob.chunk(username, ledgerId, pendingId, 1)).toEqual(secondChunk);
    } finally {
      await restoredStore?.close();
      await restoredBlob?.close();
      await firstStore?.close();
      if (!firstBlobClosed) await firstBlob.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
