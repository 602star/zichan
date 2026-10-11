import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { httpCommitTransport, loginAccount, registerAccount } from '@zichan/db';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerCryptoSession, createLedgerKeyEnvelope,
  changeLedgerPassphrase, rotateLedgerProtection, signLedgerControlEvent,
  unlockLedgerMemberKeyEnvelope, wrapLedgerCryptoSessionForMember } from '@zichan/core';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('ledger member HTTP authorization', () => {
  it('lets a viewer pull but refuses writes, then denies a removed member the legacy key and blob routes', async () => {
    const server = createTestSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    let store: SyncServerStore | undefined;
    try {
      await registerAccount(url, 'nodeadmin', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url, 'alice', 'account-password');
      await registerAccount(url, 'bob', 'account-password');
      const aliceSession = await loginAccount(url, 'alice', 'account-password');
      const bobSession = await loginAccount(url, 'bob', 'account-password');
      store = new SyncServerStore(join(server.dataDir, 'server.sqlite'), 'open', server.serverId);
      const alice = (await store.getUser('alice'))!;
      const bob = (await store.getUser('bob'))!;
      const ledgerId = 'ledger-control-http-0001';
      await store.bindReplica('alice', ledgerId);
      const aliceKey = await createAccountEncryptionKey(server.serverId, alice.accountId, 'alice separate password');
      const bobKey = await createAccountEncryptionKey(server.serverId, bob.accountId, 'bob separate password');
      await store.putAccountEncryptionKey(server.serverId, alice.accountId, aliceKey.envelope.publicKey,
        aliceKey.envelope as unknown as Record<string, unknown>, 0);
      await store.putAccountEncryptionKey(server.serverId, bob.accountId, bobKey.envelope.publicKey,
        bobKey.envelope as unknown as Record<string, unknown>, 0);
      const actor = { issuerNodeId: server.serverId, accountId: alice.accountId };
      const target = { issuerNodeId: server.serverId, accountId: bob.accountId };
      const aliceHeaders = { Authorization: `Bearer ${aliceSession.accessToken}`, 'Content-Type': 'application/json' };
      const aliceRequest = (path: string, method: 'GET' | 'POST' | 'PUT', body?: object) => fetch(`${url}${path}`,
        { method, headers: aliceHeaders, ...(body ? { body: JSON.stringify(body) } : {}) });
      const genesis = signLedgerControlEvent(aliceKey.privateKey,
        { v: 1, ledgerId, seq: 1, previousHash: null, keyEpoch: 1,
          kind: 'MemberGenesis', actor, target: actor, role: 'OWNER',
          signingPublicKey: accountSigningPublicKey(aliceKey.privateKey),
          encryptionPublicKey: aliceKey.envelope.publicKey });
      const initialResponse = await aliceRequest('/api/v4/ledger/control', 'POST', { event: genesis });
      expect(initialResponse.status).toBe(201);
      const first = (await initialResponse.json() as { state: { headHash: string } }).state;
      expect((await aliceRequest('/api/v4/ledger/control', 'GET')).status).toBe(200);
      const legacyEnvelope = (await createLedgerKeyEnvelope(ledgerId, 'legacy-recovery-password')).envelope;
      const protection = await aliceRequest('/api/v3/protection', 'GET');
      expect((await protection.json() as { controlled: boolean }).controlled).toBe(true);
      const legacyChange = await aliceRequest('/api/v3/protection', 'PUT', {
        mode: 'private', version: 0, envelope: legacyEnvelope,
      });
      expect(legacyChange.status).toBe(409);
      expect((await legacyChange.json() as { code: string }).code).toBe('PROTECTION_CONTROLLED');
      expect(await store.getLedgerProtection('alice')).toBeUndefined();
      const legacyKeyUpdate = await aliceRequest('/api/v3/key-envelope', 'PUT', { envelope: legacyEnvelope });
      expect(legacyKeyUpdate.status).toBe(409);
      expect((await legacyKeyUpdate.json() as { code: string }).code).toBe('KEY_ENVELOPE_CONTROLLED');
      const replacement = await createLedgerKeyEnvelope('ledger-control-replaced-0001', 'replacement-password');
      const legacyReplace = await aliceRequest('/api/v3/replica/replace', 'POST', {
        expectedLedgerId: ledgerId, expectedStreamEpoch: (await store.getReplica('alice'))!.streamEpoch,
        confirmation: '替换旧账本', envelope: replacement.envelope, commits: [{
          commitId: 'commit-replacement-0001', ledgerId: replacement.envelope.ledgerId,
          contentHash: 'a'.repeat(64), encCommit: { v: 3, keyId: replacement.session.activeKeyId,
            iv: 'test-iv', ct: 'test-ciphertext' },
        }],
      });
      expect(legacyReplace.status).toBe(409);
      expect((await legacyReplace.json() as { code: string }).code).toBe('REPLICA_CONTROLLED');
      const ledgerSession = createLedgerCryptoSession(ledgerId);
      const aliceEnvelope = await wrapLedgerCryptoSessionForMember(ledgerSession,
        { ...actor, recipientPublicKey: aliceKey.envelope.publicKey, keyEpoch: 1 });
      expect((await aliceRequest('/api/v4/ledger/member-envelope', 'PUT', { envelope: aliceEnvelope })).status).toBe(200);
      const added = signLedgerControlEvent(aliceKey.privateKey,
        { v: 1, ledgerId, seq: 2, previousHash: first.headHash, keyEpoch: 1,
          kind: 'MemberAdded', actor, target, role: 'EDITOR',
          signingPublicKey: accountSigningPublicKey(bobKey.privateKey),
          encryptionPublicKey: bobKey.envelope.publicKey });
      const bobEnvelope = await wrapLedgerCryptoSessionForMember(ledgerSession,
        { ...target, recipientPublicKey: bobKey.envelope.publicKey, keyEpoch: 1 });
      const editorResponse = await aliceRequest('/api/v4/ledger/control/events', 'POST',
        { event: added, envelopes: [bobEnvelope] });
      expect(editorResponse.status).toBe(201);
      const editor = (await editorResponse.json() as { state: { headHash: string } }).state;
      const ownerList = await aliceRequest('/api/v4/ledger/member-envelopes?limit=10', 'GET');
      expect(ownerList.status).toBe(200);
      expect((await ownerList.json() as { envelopes: unknown[] }).envelopes)
        .toEqual(expect.arrayContaining([aliceEnvelope, bobEnvelope]));
      const headers = { Authorization: `Bearer ${bobSession.accessToken}`, 'Content-Type': 'application/json' };
      const request = (path: string, method: 'GET' | 'POST', body?: object) => fetch(`${url}${path}`,
        { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      const rejectedId = 'commit-rejected-http-0001';
      await store.recordRejectedNodeCommit('alice', 'peer-quarantine-0001', {
        commitId: rejectedId, ledgerId, contentHash: 'a'.repeat(64), keyEpoch: 1, writer: target,
        encCommit: { v: 3, keyId: ledgerSession.activeKeyId, iv: 'iv', ct: 'cipher' },
      }, 'STALE_COMMIT_EPOCH');
      const rejectedPath = `/api/v4/ledger/rejected-commits/peer-quarantine-0001/${rejectedId}`;
      expect((await request(rejectedPath, 'GET')).status).toBe(403);
      const archived = await aliceRequest(rejectedPath, 'GET');
      expect(archived.status).toBe(200);
      expect(await archived.json()).toMatchObject({ commit: { commitId: rejectedId,
        encCommit: { ct: 'cipher' } } });
      const ownEnvelope = await request('/api/v4/ledger/member-envelope', 'GET');
      expect(ownEnvelope.status).toBe(200);
      expect((await ownEnvelope.json() as { envelope: unknown }).envelope).toEqual(bobEnvelope);
      expect((await request('/api/v4/ledger/member-envelopes', 'GET')).status).toBe(403);
      const memberSession = await unlockLedgerMemberKeyEnvelope(bobKey.privateKey, bobEnvelope);
      const localKey = await changeLedgerPassphrase(memberSession, 'bob local key password');
      const memberTransport = httpCommitTransport({ baseUrl: url, token: bobSession.accessToken,
        cryptoSession: localKey.session, keyEnvelope: localKey.envelope, memberKeyEnvelope: true });
      const connection = await memberTransport.connect(ledgerId);
      expect(connection.replicaId).toBe((await store.getReplica('bob'))?.replicaId);
      const memberCommitId = 'commit-member-http-0001';
      const pushed = await memberTransport.pushCommits(connection, [{
        protocol: 2, ledgerId, commitId: memberCommitId,
        originDeviceId: 'device-bob-0001', createdAt: new Date().toISOString(),
        parentCommitIds: [], revisions: [{ revisionId: 'revision-bob-0001',
          aggregateType: 'transaction', aggregateId: 'transaction-bob-0001',
          parentRevisionIds: [], op: 'put', payload: { id: 'transaction-bob-0001' } }],
      }]);
      expect(pushed.assigned).toHaveLength(1);
      expect((await store.listCommits('alice', 0, 10)).commits[0])
        .toMatchObject({ commitId: memberCommitId, keyEpoch: 1, writer: target });
      expect((await fetch(`${url}/api/v4/ledger/member-envelope`,
        { method: 'PUT', headers, body: JSON.stringify({ envelope: bobEnvelope }) })).status).toBe(403);
      expect((await request('/api/v3/commits', 'GET')).status).toBe(200);
      expect((await request('/api/v3/commits', 'POST', { commits: [] })).status).toBe(200);
      const viewerEvent = signLedgerControlEvent(aliceKey.privateKey,
        { v: 1, ledgerId, seq: 3, previousHash: editor.headHash, keyEpoch: 1,
          kind: 'MemberRoleChanged', actor, target, role: 'VIEWER' });
      const viewerResponse = await aliceRequest('/api/v4/ledger/control/events', 'POST', { event: viewerEvent });
      expect(viewerResponse.status).toBe(201);
      const viewer = (await viewerResponse.json() as { state: { headHash: string } }).state;
      expect((await request('/api/v3/commits', 'GET')).status).toBe(200);
      expect((await request('/api/v3/commits', 'POST', { commits: [] })).status).toBe(403);
      expect((await request('/api/v3/blobs/legacy-migrations', 'POST', {
        legacyBlobId: 'a'.repeat(64), portableBlobId: 'b'.repeat(64),
      })).status).toBe(403);
      expect((await request('/api/v3/key-envelope', 'GET')).status).toBe(403);
      expect((await request('/api/v3/protection', 'GET')).status).toBe(403);
      expect((await request('/api/v4/ledger/control', 'GET')).status).toBe(200);
      const removed = signLedgerControlEvent(aliceKey.privateKey,
        { v: 1, ledgerId, seq: 4, previousHash: viewer.headHash, keyEpoch: 2,
          kind: 'MemberRemoved', actor, target });
      const incomplete = await aliceRequest('/api/v4/ledger/control/events', 'POST',
        { event: removed, envelopes: [bobEnvelope] });
      expect(incomplete.status).toBe(409);
      expect((await store.ledgerControlState('alice'))?.keyEpoch).toBe(1);
      const rotated = await rotateLedgerProtection(ledgerSession, 'next ledger secret');
      const nextAliceEnvelope = await wrapLedgerCryptoSessionForMember(rotated.session,
        { ...actor, recipientPublicKey: aliceKey.envelope.publicKey, keyEpoch: 2 });
      expect((await aliceRequest('/api/v4/ledger/control/events', 'POST',
        { event: removed, envelopes: [nextAliceEnvelope] })).status).toBe(201);
      expect((await aliceRequest('/api/v4/ledger/control/events', 'POST',
        { event: removed, envelopes: [nextAliceEnvelope] })).status).toBe(201);
      expect((await request('/api/v3/commits', 'GET')).status).toBe(403);
      expect((await request('/api/v4/ledger/control', 'GET')).status).toBe(403);
      expect((await request('/api/v4/ledger/member-envelope', 'GET')).status).toBe(403);
      expect((await request('/api/v3/key-envelope', 'GET')).status).toBe(403);
      expect((await request('/api/v3/blobs/status', 'POST', { blobIds: [] })).status).toBe(403);
      expect((await request('/api/v3/blobs/legacy-migrations', 'POST', {
        legacyBlobId: 'a'.repeat(64), portableBlobId: 'b'.repeat(64),
      })).status).toBe(403);
    } finally {
      await store?.close();
      await server.close();
    }
  }, 20_000);
});
