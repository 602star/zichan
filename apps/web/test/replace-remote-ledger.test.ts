import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerKeyEnvelope, signLedgerControlEvent } from '@zichan/core';
import { fetchAuthMe, httpCommitTransport, loginAccount, registerAccount, syncReplica } from '@zichan/db';
import { NodeSqliteDriver, openLedger } from '@zichan/db/node';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from '../../sync-server/test/support/server-fixture.js';
import { SyncServerStore } from '../../sync-server/src/store.js';
import { EncryptedBlobStore } from '../../sync-server/src/blob-store.js';
import { initializeEmptyLedger } from '../src/db/ledger-initialization.js';
import { replaceRemoteLedger } from '../src/replace-remote-ledger.js';
import { prepareRemoteLedgerJoin } from '../src/remote-ledger-join.js';
import { runtimeLedgerCryptoSession, clearLedgerKey, storedLedgerKeyEnvelope } from '../src/ledger-key-vault.js';
import { loadSyncConnections, newSyncConnection, saveSyncConnections } from '../src/sync-config.js';

const auth = vi.hoisted(() => ({ token: '' }));
const NEW_LEDGER_SECRET = 'new-ledger-managed-secret-0000000000000000';
const ANOTHER_LEDGER_SECRET = 'another-managed-secret-000000000000000000';
vi.mock('../src/sync-auth.js', () => ({ authenticateSyncProfile: async () => auth.token }));

afterEach(() => { clearLedgerKey(); vi.unstubAllGlobals(); });

describe('replace a forgotten encrypted ledger using an existing account', () => {
  it('reports a completed remote replacement when the local transaction rolls back', async () => {
    const server = createTestSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const baseUrl = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    const old = await openLedger({ deviceId: 'remote-replacement-before-local-failure' });
    const local = await openLedger({ deviceId: 'local-replacement-rollback' });
    try {
      await registerAccount(baseUrl, 'replacement-rollback-user', 'account-password',
        { ownerSetupToken: OWNER_SETUP_TOKEN });
      auth.token = (await loginAccount(baseUrl, 'replacement-rollback-user', 'account-password')).accessToken;
      await initializeEmptyLedger(old, { baseCurrencyCode: 'EUR', ledgerMode: 'assets' });
      const oldKeys = await createLedgerKeyEnvelope(await old.getLedgerId(), 'forgotten-password');
      await syncReplica(old, httpCommitTransport({ baseUrl, token: auth.token,
        cryptoSession: oldKeys.session, keyEnvelope: oldKeys.envelope }), baseUrl);
      const before = await fetchAuthMe(baseUrl, auth.token);
      const health = await (await fetch(`${baseUrl}/api/health`)).json();
      const connection = { ...newSyncConnection(baseUrl), ...before,
        serverId: health.serverId, serverPublicKey: health.serverPublicKey };
      const originalTransaction = local.transaction.bind(local);
      vi.spyOn(local, 'transaction').mockImplementation(async (operation) => originalTransaction(async (transaction) => {
        await operation(transaction);
        throw new Error('simulated local commit failure');
      }));
      await expect(replaceRemoteLedger(local, connection, NEW_LEDGER_SECRET))
        .rejects.toThrow('服务器已完成替换，但本机初始化未完成');
      expect(await local.settings.count()).toBe(0);
      const after = await fetchAuthMe(baseUrl, auth.token);
      expect(after.ledgerId).toBe(await local.getLedgerId());
      expect(after.ledgerId).not.toBe(before.ledgerId);
      const recovered = await prepareRemoteLedgerJoin({ baseUrl, token: auth.token,
        ledgerId: after.ledgerId!, passphrase: NEW_LEDGER_SECRET, expectedServerId: health.serverId });
      expect(recovered.ledger.settings).toHaveLength(1);
    } finally {
      await Promise.all([old.close(), local.close()]);
      await server.close();
    }
  });

  it('refuses a controlled ledger before creating local replacement data', async () => {
    const server = createTestSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const baseUrl = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    const local = await openLedger({ deviceId: 'blocked-ledger-replacement' });
    const serverStore = new SyncServerStore(join(server.dataDir, 'server.sqlite'), 'open', server.serverId);
    try {
      await registerAccount(baseUrl, 'controlled-owner', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      auth.token = (await loginAccount(baseUrl, 'controlled-owner', 'account-password')).accessToken;
      const ledgerId = 'ledger-controlled-replacement-0001';
      const replica = await serverStore.bindReplica('controlled-owner', ledgerId);
      const owner = (await serverStore.getUser('controlled-owner'))!;
      const accountKey = await createAccountEncryptionKey(server.serverId, owner.accountId, 'separate-account-key-password');
      await serverStore.putAccountEncryptionKey(server.serverId, owner.accountId,
        accountKey.envelope.publicKey, accountKey.envelope as unknown as Record<string, unknown>, 0);
      const actor = { issuerNodeId: server.serverId, accountId: owner.accountId };
      await serverStore.initializeLedgerControl('controlled-owner', signLedgerControlEvent(accountKey.privateKey, {
        v: 1, ledgerId, seq: 1, previousHash: null, keyEpoch: 1, kind: 'MemberGenesis',
        actor, target: actor, role: 'OWNER', signingPublicKey: accountSigningPublicKey(accountKey.privateKey),
        encryptionPublicKey: accountKey.envelope.publicKey,
      }));
      const connection = { ...newSyncConnection(baseUrl), id: 'controlled-owner', username: 'controlled-owner',
        serverId: server.serverId, ledgerId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch };
      await expect(replaceRemoteLedger(local, connection, NEW_LEDGER_SECRET))
        .rejects.toThrow('成员账本不能通过单账号替换');
      expect(await local.settings.count()).toBe(0);
      expect(await local.listSyncCommits()).toEqual([]);
      expect((await serverStore.getReplica('controlled-owner'))?.ledgerId).toBe(ledgerId);
    } finally {
      await serverStore.close();
      await local.close();
      await server.close();
    }
  });

  it('replaces atomically, restores the new ledger, rejects stale devices, and rolls back rejected attempts', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    const server = createTestSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const baseUrl = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    const old = await openLedger({ deviceId: 'old-ledger' });
    const local = await openLedger({ deviceId: 'new-ledger' });
    const rejected = await openLedger({ deviceId: 'stale-replacement' });
    const serverStore = new SyncServerStore(join(server.dataDir, 'server.sqlite'), 'open', server.serverId);
    const blobs = new EncryptedBlobStore({ dataDir: server.dataDir });
    try {
      await registerAccount(baseUrl, 'restart-user', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      auth.token = (await loginAccount(baseUrl, 'restart-user', 'account-password', { deviceId: 'current-device', deviceName: 'Current' })).accessToken;
      const other = (await loginAccount(baseUrl, 'restart-user', 'account-password', { deviceId: 'old-device', deviceName: 'Old' })).accessToken;
      await initializeEmptyLedger(old, { baseCurrencyCode: 'EUR', ledgerMode: 'assets' });
      const oldKeys = await createLedgerKeyEnvelope(await old.getLedgerId(), 'forgotten-password');
      await syncReplica(old, httpCommitTransport({ baseUrl, token: auth.token, cryptoSession: oldKeys.session, keyEnvelope: oldKeys.envelope }), baseUrl);
      const before = await fetchAuthMe(baseUrl, auth.token);
      blobs.setReplicaIdResolver(async (username, ledgerId) => {
        const bound = await serverStore.getReplica(username);
        return bound?.ledgerId === ledgerId ? bound.replicaId : 'replica-inactive';
      });
      const oldBlobId = 'a'.repeat(64);
      const oldCiphertext = Buffer.alloc(64, 7);
      const oldManifest = { v: 2 as const, blobId: oldBlobId, cipherBytes: oldCiphertext.byteLength,
        chunkCount: 1, chunks: [{ index: 0, sizeBytes: oldCiphertext.byteLength,
          ciphertextSha256: createHash('sha256').update(oldCiphertext).digest('hex'), iv: 'test-iv-123456' }] };
      const upload = await blobs.beginUpload('restart-user', before.ledgerId!, oldManifest);
      await blobs.putChunk('restart-user', upload.uploadId!, 0, oldCiphertext);
      await blobs.completeUpload('restart-user', upload.uploadId!, 2);
      const health = await (await fetch(`${baseUrl}/api/health`)).json();
      const connection = { ...newSyncConnection(baseUrl), ...before, serverId: health.serverId, serverPublicKey: health.serverPublicKey };
      saveSyncConnections([connection]);

      await expect(replaceRemoteLedger(local, { ...connection, streamEpoch: 'stale-epoch' }, NEW_LEDGER_SECRET)).rejects.toThrow('服务器账本已变化');
      expect(await local.settings.count()).toBe(0);
      expect(await local.listSyncCommits()).toEqual([]);
      expect((await fetchAuthMe(baseUrl, auth.token)).ledgerId).toBe(before.ledgerId);
      expect(storedLedgerKeyEnvelope()).toBeUndefined();

      const setting = await replaceRemoteLedger(local, connection, NEW_LEDGER_SECRET);
      expect(setting.ledgerMode).toBe('spending');
      const after = await fetchAuthMe(baseUrl, auth.token);
      expect(after.accountId).toBe(before.accountId);
      expect(after.role).toBe(before.role);
      expect(after.ledgerId).toBe(await local.getLedgerId());
      expect(after.ledgerId).not.toBe(before.ledgerId);
      expect(after.streamEpoch).not.toBe(before.streamEpoch);
      expect(after.replicaId).not.toBe(before.replicaId);
      expect(loadSyncConnections()[0]!.ledgerId).toBe(after.ledgerId);
      const checkpointDb = new NodeSqliteDriver(join(server.dataDir, 'server.sqlite'));
      try {
        const checkpoint = await checkpointDb.get<{ replica_id: string; ledger_id: string; head_seq: number; envelope_json: string }>(
          'SELECT replica_id, ledger_id, head_seq, envelope_json FROM ledger_replacement_checkpoints WHERE username = ?', ['restart-user']);
        expect(checkpoint?.replica_id).toBe(before.replicaId);
        expect(checkpoint?.ledger_id).toBe(before.ledgerId);
        expect(checkpoint?.head_seq).toBeGreaterThan(0);
        expect(JSON.parse(checkpoint!.envelope_json).ledgerId).toBe(before.ledgerId);
        expect((await checkpointDb.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_replacement_checkpoint_commits'))?.count).toBe(checkpoint!.head_seq);
        expect((await checkpointDb.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_replica_slots WHERE replica_id = ?', [before.replicaId]))?.count).toBe(1);
        expect((await checkpointDb.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM account_ledger_index WHERE replica_id = ?', [before.replicaId]))?.count).toBe(0);
      } finally { await checkpointDb.close(); }
      await expect(fetchAuthMe(baseUrl, other)).rejects.toThrow();
      const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
      const page = await (await fetch(`${baseUrl}/api/v3/commits?after=0`, { headers })).json();
      const replacement = { expectedLedgerId: before.ledgerId, expectedStreamEpoch: before.streamEpoch, confirmation: '替换旧账本', envelope: storedLedgerKeyEnvelope(), commits: page.commits, secret: NEW_LEDGER_SECRET };
      const repeat = () => fetch(`${baseUrl}/api/v3/replica/replace`, { method: 'POST', headers, body: JSON.stringify(replacement) });
      expect((await Promise.all([repeat(), repeat()])).map((response) => response.status)).toEqual([200, 200]);
      expect(await fetchAuthMe(baseUrl, auth.token)).toEqual(after);
      expect((await fetch(`${baseUrl}/api/v3/replica/replace`, { method: 'POST', headers, body: JSON.stringify({ ...replacement, confirmation: '' }) })).status).toBe(400);
      expect((await fetch(`${baseUrl}/api/v3/replica/replace`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(replacement) })).status).toBe(401);
      // Even a newly authenticated old device cannot put its old key or commits into the new stream.
      await expect(syncReplica(old, httpCommitTransport({ baseUrl, token: auth.token, cryptoSession: oldKeys.session, keyEnvelope: oldKeys.envelope }), baseUrl)).rejects.toThrow('LEDGER_MISMATCH');
      await expect(replaceRemoteLedger(rejected, connection, ANOTHER_LEDGER_SECRET)).rejects.toThrow('服务器账本已变化');
      expect(await rejected.settings.count()).toBe(0);

      const restored = await prepareRemoteLedgerJoin({ baseUrl, token: auth.token, ledgerId: after.ledgerId!, passphrase: NEW_LEDGER_SECRET, expectedServerId: health.serverId });
      expect(restored.ledger.settings[0]!.id).toBe(setting.id);
      expect(restored.ledger.assets.map((asset) => asset.code)).toEqual(['CNY']);
      await syncReplica(local, httpCommitTransport({ baseUrl, token: auth.token, cryptoSession: runtimeLedgerCryptoSession()!, keyEnvelope: storedLedgerKeyEnvelope()! }), baseUrl);
      const relogin = await loginAccount(baseUrl, 'restart-user', 'account-password', { deviceId: 'relogin-device', deviceName: 'Relogin' });
      expect((await fetchAuthMe(baseUrl, relogin.accessToken)).ledgerId).toBe(after.ledgerId);

      const recoveryUrl = `${baseUrl}/api/v3/replica/recovery`;
      const recovery = await (await fetch(recoveryUrl, { headers })).json() as {
        checkpoints: { checkpointId: string; ledgerId: string; headSeq: number }[];
      };
      expect(recovery.checkpoints).toHaveLength(1);
      expect(recovery.checkpoints[0]!.ledgerId).toBe(before.ledgerId);
      expect(recovery.checkpoints[0]!.headSeq).toBeGreaterThan(0);
      await registerAccount(baseUrl, 'unrelated-user', 'another-account-password');
      const unrelatedToken = (await loginAccount(baseUrl, 'unrelated-user', 'another-account-password')).accessToken;
      await serverStore.bindReplica('unrelated-user', 'ledger-unrelated-recovery-0001');
      const unrelatedHeaders = { Authorization: `Bearer ${unrelatedToken}`, 'Content-Type': 'application/json' };
      expect((await (await fetch(recoveryUrl, { headers: unrelatedHeaders })).json()).checkpoints).toEqual([]);
      expect((await fetch(`${recoveryUrl}/restore`, { method: 'POST', headers: unrelatedHeaders,
        body: JSON.stringify({ checkpointId: recovery.checkpoints[0]!.checkpointId,
          expectedLedgerId: 'ledger-unrelated-recovery-0001', expectedStreamEpoch: 'unrelated-epoch',
          confirmation: '恢复旧账本' }) })).status).toBe(404);
      const restore = (body: Record<string, unknown>) => fetch(`${recoveryUrl}/restore`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      const restoreBody = { checkpointId: recovery.checkpoints[0]!.checkpointId,
        expectedLedgerId: after.ledgerId, expectedStreamEpoch: after.streamEpoch, confirmation: '恢复旧账本' };
      expect((await restore({ ...restoreBody, confirmation: '' })).status).toBe(400);
      expect((await restore({ ...restoreBody, expectedStreamEpoch: 'stale-epoch' })).status).toBe(409);
      expect((await fetchAuthMe(baseUrl, auth.token)).ledgerId).toBe(after.ledgerId);
      expect((await restore(restoreBody)).status).toBe(200);
      const recovered = await fetchAuthMe(baseUrl, auth.token);
      expect(recovered.ledgerId).toBe(before.ledgerId);
      expect(recovered.replicaId).toBe(before.replicaId);
      expect(recovered.streamEpoch).toBe(before.streamEpoch);
      await expect(fetchAuthMe(baseUrl, relogin.accessToken)).rejects.toThrow();
      const oldRestored = await prepareRemoteLedgerJoin({ baseUrl, token: auth.token,
        ledgerId: before.ledgerId!, passphrase: 'forgotten-password', expectedServerId: health.serverId });
      expect(oldRestored.ledger.assets.find((asset) =>
        asset.id === oldRestored.ledger.settings[0]!.baseCurrencyAssetId)?.code).toBe('EUR');
      const oldBlobStatus = await fetch(`${baseUrl}/api/v3/blobs/status`, {
        method: 'POST', headers, body: JSON.stringify({ blobIds: [oldBlobId] }),
      });
      expect(oldBlobStatus.status).toBe(200);
      expect((await oldBlobStatus.json()).objects[oldBlobId]).toBe('available');
      const reverseCheckpoints = await (await fetch(recoveryUrl, { headers })).json() as {
        checkpoints: { ledgerId: string }[];
      };
      expect(reverseCheckpoints.checkpoints.some((row) => row.ledgerId === after.ledgerId)).toBe(true);
      expect((await restore(restoreBody)).status).toBe(200);
    } finally {
      await Promise.all([old.close(), local.close(), rejected.close(), serverStore.close(), blobs.close()]);
      await server.close();
    }
  }, 30_000);
});
