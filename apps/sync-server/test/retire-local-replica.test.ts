import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerCryptoSession,
  signLedgerControlEvent, wrapLedgerCryptoSessionForMember } from '@zichan/core';
import { createServerBackup, verifyServerBackup } from '../src/backup.js';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { assertNoPendingLocalReplicaRetirement, inspectLocalReplicaRetirement,
  LOCAL_REPLICA_RETIREMENT_MARKER, retireLocalReplica } from '../src/retire-local-replica.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('one ledger replica retirement on a multi-ledger node', () => {
  it('removes one canonical replica and its ciphertext while preserving the other ledger and accounts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-retire-one-replica-'));
    const dataDir = join(root, 'node');
    const server = createTestSyncServer({ dataDir });
    let serverClosed = false;
    try {
      await server.ready;
      await server.close();
      serverClosed = true;
      const blob = new EncryptedBlobStore({ dataDir });
      const store = new SyncServerStore(join(dataDir, 'server.sqlite'), 'open', server.serverId, undefined, blob.ready);
      const firstLedger = 'ledger-retire-only-first';
      const secondLedger = 'ledger-retire-only-second';
      const firstBlob = 'a'.repeat(64);
      const secondBlob = 'b'.repeat(64);
      let firstReplicaId = '';
      let secondReplicaId = '';
      try {
        await store.register('first', 'opaque-first', undefined, true);
        firstReplicaId = (await store.bindReplica('first', firstLedger)).replicaId;
        await store.register('second', 'opaque-second');
        secondReplicaId = (await store.bindReplica('second', secondLedger)).replicaId;
        const firstAccount = (await store.getUser('first'))!;
        const secondAccount = (await store.getUser('second'))!;
        const firstKey = await createAccountEncryptionKey(server.serverId, firstAccount.accountId,
          'first account password');
        const secondKey = await createAccountEncryptionKey(server.serverId, secondAccount.accountId,
          'second account password');
        await store.putAccountEncryptionKey(server.serverId, firstAccount.accountId,
          firstKey.envelope.publicKey, firstKey.envelope as unknown as Record<string, unknown>, 0);
        await store.putAccountEncryptionKey(server.serverId, secondAccount.accountId,
          secondKey.envelope.publicKey, secondKey.envelope as unknown as Record<string, unknown>, 0);
        const sharedLedger = createLedgerCryptoSession(secondLedger);
        await store.putKeyEnvelope('second', secondLedger, sharedLedger.keyringId, 1,
          { ledgerId: secondLedger, keyringId: sharedLedger.keyringId, generation: 1 });
        const owner = { issuerNodeId: server.serverId, accountId: secondAccount.accountId };
        const member = { issuerNodeId: server.serverId, accountId: firstAccount.accountId };
        const genesis = await store.initializeLedgerControl('second', signLedgerControlEvent(
          secondKey.privateKey, { v: 1, ledgerId: secondLedger, seq: 1, previousHash: null,
            keyEpoch: 1, kind: 'MemberGenesis', actor: owner, target: owner, role: 'OWNER',
            signingPublicKey: accountSigningPublicKey(secondKey.privateKey),
            encryptionPublicKey: secondKey.envelope.publicKey }));
        const memberEnvelope = await wrapLedgerCryptoSessionForMember(sharedLedger, {
          ...member, recipientPublicKey: firstKey.envelope.publicKey, keyEpoch: 1,
        });
        await store.appendLedgerControlEvent('second', signLedgerControlEvent(secondKey.privateKey, {
          v: 1, ledgerId: secondLedger, seq: 2, previousHash: genesis.headHash,
          keyEpoch: 1, kind: 'MemberAdded', actor: owner, target: member, role: 'EDITOR',
          signingPublicKey: accountSigningPublicKey(firstKey.privateKey),
          encryptionPublicKey: firstKey.envelope.publicKey,
        }), [memberEnvelope]);
        expect((await store.getReplicaForLedger('first', secondLedger))?.replicaId)
          .toBe(secondReplicaId);
        blob.setReplicaIdResolver(async (username, ledgerId) =>
          (await store.getReplicaForLedger(username, ledgerId))!.replicaId);
        const upload = async (username: string, ledgerId: string, blobId: string, fill: number) => {
          const chunk = Buffer.alloc(32, fill);
          const plan = await blob.beginUpload(username, ledgerId, { v: 2, blobId,
            cipherBytes: chunk.length, chunkCount: 1,
            chunks: [{ index: 0, sizeBytes: chunk.length,
              ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] });
          await blob.putChunk(username, plan.uploadId!, 0, chunk);
          await blob.completeUpload(username, plan.uploadId!, 2);
        };
        await upload('first', firstLedger, firstBlob, 1);
        await upload('second', secondLedger, secondBlob, 2);
      } finally { await store.close(); await blob.close(); }
      const custodyDb = new NodeSqliteDriver(join(dataDir, 'server.sqlite'));
      try {
        await custodyDb.run(`INSERT INTO server_meta (key, value, updated_at) VALUES (?, ?, ?)`,
          [`replica_retired:${firstReplicaId}`,
            JSON.stringify({ sourceNodeId: 'srv-prior-hub', retiredAt: new Date().toISOString(),
              observedAt: new Date().toISOString() }), new Date().toISOString()]);
        for (const username of ['first', 'second']) {
          await custodyDb.run(`INSERT INTO sync_key_custody
            (username, mode, version, sealed_secret, updated_at) VALUES (?, 'private', 1, NULL, ?)`,
          [username, new Date().toISOString()]);
        }
      } finally { await custodyDb.close(); }
      const inspection = await inspectLocalReplicaRetirement(dataDir, firstReplicaId);
      expect(inspection.issues).toEqual([]);
      expect(inspection.otherLedgerIds).toContain(secondLedger);
      expect(inspection.objectCount).toBe(1);
      await expect(retireLocalReplica(dataDir, firstReplicaId, join(root, 'wrong-backup'),
        server.serverId, secondLedger)).rejects.toThrow(/确认的账本 ID/);
      const backup = join(root, 'retirement-backup');
      const result = await retireLocalReplica(dataDir, firstReplicaId, backup, server.serverId, firstLedger);
      expect(result.resumed).toBe(false);
      expect((await verifyServerBackup(backup)).ok).toBe(true);
      expect(existsSync(join(dataDir, LOCAL_REPLICA_RETIREMENT_MARKER))).toBe(false);
      for (const namespace of inspection.namespaces) {
        expect(existsSync(join(dataDir, 'blobs', 'objects', namespace))).toBe(false);
      }
      const db = new NodeSqliteDriver(join(dataDir, 'server.sqlite'));
      try {
        expect(await db.get('SELECT 1 FROM ledger_replica_slots WHERE replica_id = ?', [firstReplicaId])).toBeUndefined();
        expect(await db.get('SELECT 1 FROM ledger_replica_slots WHERE replica_id = ?', [secondReplicaId])).toBeDefined();
        expect(await db.get('SELECT 1 FROM blob_objects WHERE blob_id = ?', [firstBlob])).toBeUndefined();
        expect(await db.get('SELECT 1 FROM blob_objects WHERE blob_id = ?', [secondBlob])).toBeDefined();
        expect((await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM sync_users'))?.count).toBe(2);
        expect(await db.get('SELECT 1 FROM sync_key_custody WHERE username = ?', ['first'])).toBeDefined();
        expect(await db.get('SELECT 1 FROM sync_key_custody WHERE username = ?', ['second'])).toBeDefined();
        expect(await db.get('SELECT 1 FROM account_ledger_index WHERE username = ? AND replica_id = ?',
          ['first', secondReplicaId])).toBeDefined();
        expect(await db.get('SELECT 1 FROM server_meta WHERE key = ?',
          [`replica_retired:${firstReplicaId}`])).toBeUndefined();
        expect(await db.get('PRAGMA foreign_key_check')).toBeUndefined();
      } finally { await db.close(); }
      const reopened = new EncryptedBlobStore({ dataDir });
      const reopenedStore = new SyncServerStore(join(dataDir, 'server.sqlite'), 'open', server.serverId,
        undefined, reopened.ready);
      try {
        await reopenedStore.ready;
        reopened.setReplicaIdResolver(async (username, ledgerId) =>
          (await reopenedStore.getReplicaForLedger(username, ledgerId))!.replicaId);
        expect(await reopened.manifest('second', secondLedger, secondBlob)).toBeDefined();
        expect(await reopenedStore.getReplicaForLedger('first', firstLedger)).toBeUndefined();
        expect((await reopenedStore.getReplicaForLedger('first', secondLedger))?.replicaId)
          .toBe(secondReplicaId);
        const firstUser = await reopenedStore.getUser('first');
        expect(firstUser).toBeDefined();
        const newSession = await reopenedStore.createSession({
          expectedRegistrationRecord: firstUser!.opaqueRegistrationRecord,
          id: 'session-after-replica-retirement', username: 'first', deviceId: 'retired-ledger-test',
          deviceName: 'Retirement Test', refreshHash: 'test-hash',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        expect(newSession.replicaId).toBe(secondReplicaId);
      } finally { await reopenedStore.close(); await reopened.close(); }
    } finally {
      if (!serverClosed) await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps startup blocked while a verified retirement marker is pending, then resumes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-retire-resume-'));
    const dataDir = join(root, 'node');
    const server = createTestSyncServer({ dataDir });
    let serverClosed = false;
    try {
      await server.ready;
      await server.close();
      serverClosed = true;
      const store = new SyncServerStore(join(dataDir, 'server.sqlite'), 'open', server.serverId);
      let replicaId = '';
      const ledgerId = 'ledger-retire-resume';
      try {
        await store.register('owner', 'opaque-owner', undefined, true);
        replicaId = (await store.bindReplica('owner', ledgerId)).replicaId;
        await store.register('other', 'opaque-other');
        await store.bindReplica('other', 'ledger-retire-resume-other');
      } finally { await store.close(); }
      const foreignNamespace = 'd'.repeat(64);
      const catalog = new NodeSqliteDriver(join(dataDir, 'server.sqlite'));
      try {
        await catalog.run(`INSERT INTO blob_objects
          (username, ledger_id, replica_id, blob_id, namespace, state, cipher_bytes,
            chunk_count, manifest_json, created_at, updated_at)
          VALUES (?, ?, (SELECT replica_id FROM sync_replicas WHERE username = ?), ?, ?,
            'available', 32, 1, '{}', ?, ?)`,
        ['other', 'ledger-retire-resume-other', 'other', 'e'.repeat(64), foreignNamespace,
          new Date().toISOString(), new Date().toISOString()]);
      } finally { await catalog.close(); }
      const inspection = await inspectLocalReplicaRetirement(dataDir, replicaId);
      expect(inspection.issues).toEqual([]);
      const backup = join(root, 'retirement-backup');
      await createServerBackup(dataDir, backup);
      writeFileSync(join(dataDir, LOCAL_REPLICA_RETIREMENT_MARKER), JSON.stringify({ version: 1,
        serverId: server.serverId, replicaId, ledgerId, backupPath: backup,
        otherLedgerIds: inspection.otherLedgerIds, objectCount: inspection.objectCount,
        uploadCount: inspection.uploadCount,
        namespaces: [...inspection.namespaces, foreignNamespace] }));
      expect(() => assertNoPendingLocalReplicaRetirement(dataDir)).toThrow(/未完成的单副本清理/);
      expect(() => createTestSyncServer({ dataDir })).toThrow(/未完成的单副本清理/);
      await expect(retireLocalReplica(dataDir, replicaId, backup, server.serverId,
        'ledger-other')).rejects.toThrow(/已有不同/);
      await expect(retireLocalReplica(dataDir, replicaId, backup, server.serverId,
        ledgerId)).rejects.toThrow(/已被其他账本引用/);
      writeFileSync(join(dataDir, LOCAL_REPLICA_RETIREMENT_MARKER), JSON.stringify({ version: 1,
        serverId: server.serverId, replicaId, ledgerId, backupPath: backup,
        otherLedgerIds: inspection.otherLedgerIds, objectCount: inspection.objectCount,
        uploadCount: inspection.uploadCount,
        namespaces: inspection.namespaces }));
      const completed = await retireLocalReplica(dataDir, replicaId, backup, server.serverId, ledgerId);
      expect(completed.resumed).toBe(true);
      expect(completed.otherLedgerIds).toEqual(inspection.otherLedgerIds);
      expect(existsSync(join(dataDir, LOCAL_REPLICA_RETIREMENT_MARKER))).toBe(false);
      expect(() => assertNoPendingLocalReplicaRetirement(dataDir)).not.toThrow();
    } finally {
      if (!serverClosed) await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
