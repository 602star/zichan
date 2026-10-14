import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerCryptoSession,
  signLedgerControlEvent, wrapLedgerCryptoSessionForMember } from '@zichan/core';
import { CURRENT_SERVER_SCHEMA, SyncServerStore } from '../src/store.js';

describe('persisted ledger member control', () => {
  it('adds a shared ledger to an account with a personal ledger without redirecting its old route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-multiple-ledgers-'));
    const file = join(dir, 'server.sqlite');
    const serverId = 'srv-multiple-ledgers';
    const sharedLedgerId = 'ledger-shared-member-0001';
    const personalLedgerId = 'ledger-personal-member-001';
    const store = new SyncServerStore(file, 'open', serverId);
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      await store.register('member', 'opaque-member');
      const owner = (await store.getUser('owner'))!;
      const member = (await store.getUser('member'))!;
      const shared = await store.bindReplica('owner', sharedLedgerId);
      const personal = await store.bindReplica('member', personalLedgerId);
      const firstSession = await store.createSession({ id: 'session-personal-ledger', username: 'member',
        deviceId: 'device-personal-ledger', deviceName: 'Personal browser', refreshHash: 'hash-a',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const secondSession = await store.createSession({ id: 'session-shared-ledger', username: 'member',
        deviceId: 'device-shared-ledger', deviceName: 'Shared browser', refreshHash: 'hash-b',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect(firstSession.replicaId).toBe(personal.replicaId);
      expect(secondSession.replicaId).toBe(personal.replicaId);
      const ownerKey = await createAccountEncryptionKey(serverId, owner.accountId, 'owner account key password');
      const memberKey = await createAccountEncryptionKey(serverId, member.accountId, 'member account key password');
      await store.putAccountEncryptionKey(serverId, owner.accountId, ownerKey.envelope.publicKey,
        ownerKey.envelope as unknown as Record<string, unknown>, 0);
      await store.putAccountEncryptionKey(serverId, member.accountId, memberKey.envelope.publicKey,
        memberKey.envelope as unknown as Record<string, unknown>, 0);
      const actor = { issuerNodeId: serverId, accountId: owner.accountId };
      const target = { issuerNodeId: serverId, accountId: member.accountId };
      const genesis = signLedgerControlEvent(ownerKey.privateKey, { v: 1, ledgerId: sharedLedgerId,
        seq: 1, previousHash: null, keyEpoch: 1, kind: 'MemberGenesis', actor, target: actor,
        role: 'OWNER', signingPublicKey: accountSigningPublicKey(ownerKey.privateKey),
        encryptionPublicKey: ownerKey.envelope.publicKey });
      const first = await store.initializeLedgerControl('owner', genesis);
      const added = signLedgerControlEvent(ownerKey.privateKey, { v: 1, ledgerId: sharedLedgerId,
        seq: 2, previousHash: first.headHash, keyEpoch: 1, kind: 'MemberAdded', actor, target,
        role: 'EDITOR', signingPublicKey: accountSigningPublicKey(memberKey.privateKey),
        encryptionPublicKey: memberKey.envelope.publicKey });
      const addedState = await store.appendLedgerControlEvent('owner', added);
      expect((await store.getReplica('member'))?.replicaId).toBe(personal.replicaId);
      expect(await store.listAccountLedgers('member')).toEqual(expect.arrayContaining([
        expect.objectContaining({ ledgerId: personalLedgerId, replicaId: personal.replicaId }),
        expect.objectContaining({ ledgerId: sharedLedgerId, replicaId: shared.replicaId }),
      ]));
      await expect(store.selectSessionReplica('member', secondSession.id, shared.replicaId))
        .rejects.toMatchObject({ code: 'MEMBER_ENVELOPE_REQUIRED' });
      const sharedKey = createLedgerCryptoSession(sharedLedgerId);
      const memberEnvelope = await wrapLedgerCryptoSessionForMember(sharedKey, { issuerNodeId: serverId,
        accountId: member.accountId, recipientPublicKey: memberKey.envelope.publicKey, keyEpoch: 1 });
      await store.putLedgerMemberKeyEnvelope('owner', memberEnvelope);
      expect((await store.selectSessionReplica('member', secondSession.id, shared.replicaId)).replicaId)
        .toBe(shared.replicaId);
      expect((await store.getSession(firstSession.id))?.replicaId).toBe(personal.replicaId);
      expect((await store.getSession(secondSession.id))?.replicaId).toBe(shared.replicaId);
      const commit = (commitId: string, ledgerId: string, keyId: string) => ({ commitId, ledgerId,
        contentHash: 'c'.repeat(64), encCommit: { v: 3, keyId, iv: 'iv', ct: 'ciphertext' } });
      await store.pushCommits('member', [commit('personal-commit-0001', personalLedgerId,
        'personal-key-0000001')]);
      await store.pushCommits('member', [commit('shared-commit-000001', sharedLedgerId,
        memberEnvelope.activeKeyId)], ['asset-cost-v2'], [], 'account', shared.replicaId);
      expect((await store.listCommits('member', 0, 10)).commits.map((row) => row.ledgerId))
        .toEqual([personalLedgerId]);
      expect((await store.listCommits('member', 0, 10, 'account', shared.replicaId)).commits
        .map((row) => row.ledgerId)).toEqual([sharedLedgerId]);
      const removed = signLedgerControlEvent(ownerKey.privateKey, { v: 1, ledgerId: sharedLedgerId,
        seq: 3, previousHash: addedState.headHash,
        keyEpoch: 2, kind: 'MemberRemoved', actor, target });
      await store.appendLedgerControlEvent('owner', removed);
      expect((await store.listAccountLedgers('member')).map((row) => row.ledgerId)).toEqual([personalLedgerId]);
      await expect(store.listCommits('member', 0, 10, 'account', shared.replicaId))
        .rejects.toMatchObject({ code: 'REPLICA_UNBOUND' });
      expect((await store.listCommits('member', 0, 10)).commits).toHaveLength(1);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('binds genesis to an account key, checks owner signatures, and rejects tampering on restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-control-store-'));
    const file = join(dir, 'server.sqlite');
    const serverId = 'srv-control-001';
    const ledgerId = 'ledger-control-store-0001';
    const store = new SyncServerStore(file, 'open', serverId);
    let reopened: SyncServerStore | undefined;
    try {
      await store.register('nodeowner', 'opaque-nodeowner', undefined, true);
      await store.register('alice', 'opaque-alice');
      await store.register('bob', 'opaque-bob');
      const alice = (await store.getUser('alice'))!;
      const bob = (await store.getUser('bob'))!;
      await store.bindReplica('alice', ledgerId);
      const aliceKey = await createAccountEncryptionKey(serverId, alice.accountId, 'alice separate key password');
      const bobKey = await createAccountEncryptionKey(serverId, bob.accountId, 'bob separate key password');
      const actor = { issuerNodeId: serverId, accountId: alice.accountId };
      const target = { issuerNodeId: serverId, accountId: bob.accountId };
      const genesis = signLedgerControlEvent(aliceKey.privateKey, { v: 1, ledgerId, seq: 1,
        previousHash: null, keyEpoch: 1, kind: 'MemberGenesis', actor, target: actor,
        role: 'OWNER', signingPublicKey: accountSigningPublicKey(aliceKey.privateKey),
        encryptionPublicKey: aliceKey.envelope.publicKey });
      await expect(store.initializeLedgerControl('alice', genesis))
        .rejects.toMatchObject({ code: 'ACCOUNT_KEY_REQUIRED' });
      await store.putAccountEncryptionKey(serverId, alice.accountId, aliceKey.envelope.publicKey,
        aliceKey.envelope as unknown as Record<string, unknown>, 0);
      const first = await store.initializeLedgerControl('alice', genesis);
      expect(first).toMatchObject({ seq: 1, keyEpoch: 1 });
      expect((await store.initializeLedgerControl('alice', genesis)).headHash).toBe(first.headHash);
      const added = signLedgerControlEvent(aliceKey.privateKey, { v: 1, ledgerId, seq: 2,
        previousHash: first.headHash, keyEpoch: 1, kind: 'MemberAdded', actor, target,
        role: 'EDITOR', signingPublicKey: accountSigningPublicKey(bobKey.privateKey),
        encryptionPublicKey: bobKey.envelope.publicKey });
      await expect(store.appendLedgerControlEvent('alice', added))
        .rejects.toMatchObject({ code: 'ACCOUNT_KEY_REQUIRED' });
      await store.putAccountEncryptionKey(serverId, bob.accountId, bobKey.envelope.publicKey,
        bobKey.envelope as unknown as Record<string, unknown>, 0);
      const next = await store.appendLedgerControlEvent('alice', added);
      expect(next).toMatchObject({ seq: 2, keyEpoch: 1 });
      expect((await store.listAccountLedgers('bob')).map((item) => item.ledgerId)).toEqual([ledgerId]);
      expect((await store.appendLedgerControlEvent('alice', added)).headHash).toBe(next.headHash);
      expect(await store.ledgerControlState('alice')).toMatchObject({ seq: 2, headHash: next.headHash });
      const ledger = createLedgerCryptoSession(ledgerId);
      const bobEnvelope = await wrapLedgerCryptoSessionForMember(ledger, { issuerNodeId: serverId,
        accountId: bob.accountId, recipientPublicKey: bobKey.envelope.publicKey, keyEpoch: 1 });
      await store.putLedgerMemberKeyEnvelope('alice', bobEnvelope);
      expect((await store.getReplica('bob'))?.replicaId).toBe((await store.getReplica('alice'))?.replicaId);
      expect(await store.currentLedgerMemberKeyEnvelope('bob')).toEqual(bobEnvelope);
      await expect(store.assertLedgerAccess('bob', 'write')).resolves.toBeUndefined();
      await expect(store.putLedgerMemberKeyEnvelope('bob', bobEnvelope))
        .rejects.toMatchObject({ code: 'LEDGER_OWNER_REQUIRED' });
      const viewer = signLedgerControlEvent(aliceKey.privateKey, { v: 1, ledgerId, seq: 3,
        previousHash: next.headHash, keyEpoch: 1, kind: 'MemberRoleChanged', actor, target,
        role: 'VIEWER' });
      const withViewer = await store.appendLedgerControlEvent('alice', viewer);
      await expect(store.assertLedgerAccess('bob', 'read')).resolves.toBeUndefined();
      await expect(store.assertLedgerAccess('bob', 'write'))
        .rejects.toMatchObject({ code: 'LEDGER_WRITE_REQUIRED' });
      const removed = signLedgerControlEvent(aliceKey.privateKey, { v: 1, ledgerId, seq: 4,
        previousHash: withViewer.headHash, keyEpoch: 2, kind: 'MemberRemoved', actor, target });
      const afterRemoval = await store.appendLedgerControlEvent('alice', removed);
      expect(afterRemoval.keyEpoch).toBe(2);
      expect(await store.listAccountLedgers('bob')).toEqual([]);
      await expect(store.assertLedgerAccess('bob', 'read'))
        .rejects.toMatchObject({ code: 'LEDGER_MEMBER_REQUIRED' });
      await expect(store.listCommits('bob', 0, 10))
        .rejects.toMatchObject({ code: 'LEDGER_MEMBER_REQUIRED' });
      expect(await store.currentLedgerMemberKeyEnvelope('bob')).toBeUndefined();
      await expect(store.putLedgerMemberKeyEnvelope('alice', bobEnvelope))
        .rejects.toMatchObject({ code: 'MEMBER_ENVELOPE_MISMATCH' });
      const peerNodeId = 'peer-node-control';
      const peerPublicKey = generateKeyPairSync('ed25519').publicKey
        .export({ format: 'der', type: 'spki' }).toString('base64url');
      const grant = await store.createNodeReplicationGrant('alice', peerNodeId, peerPublicKey,
        new Date(Date.now() + 86_400_000).toISOString());
      const readded = await store.appendLedgerControlEvent('alice', signLedgerControlEvent(aliceKey.privateKey,
        { v: 1, ledgerId, seq: 5, previousHash: afterRemoval.headHash, keyEpoch: 2,
          kind: 'MemberAdded', actor, target, role: 'OWNER',
          signingPublicKey: accountSigningPublicKey(bobKey.privateKey),
          encryptionPublicKey: bobKey.envelope.publicKey }));
      const final = await store.appendLedgerControlEvent('alice', signLedgerControlEvent(aliceKey.privateKey,
        { v: 1, ledgerId, seq: 6, previousHash: readded.headHash, keyEpoch: 3,
          kind: 'MemberRemoved', actor, target: actor }));
      await expect(store.listCommits('alice', 0, 10))
        .rejects.toMatchObject({ code: 'LEDGER_MEMBER_REQUIRED' });
      expect(await store.listAccountLedgers('alice')).toEqual([]);
      expect((await store.listCommits('alice', 0, 10, 'node')).commits).toEqual([]);
      expect(await store.consumeNodeReplicationNonce(grant.grantId, 'nonce-after-owner-removal', peerNodeId))
        .toBe(true);
      await store.close();
      reopened = new SyncServerStore(file, 'closed', serverId);
      expect(await reopened.ledgerControlState('alice')).toMatchObject({ seq: 6, headHash: final.headHash });
      await reopened.close();
      reopened = undefined;
      const sql = new NodeSqliteDriver(file);
      try {
        await sql.run('UPDATE ledger_control_events SET event_hash = ? WHERE seq = 2', ['0'.repeat(64)]);
      } finally { await sql.close(); }
      reopened = new SyncServerStore(file, 'closed', serverId);
      await expect(reopened.ready).rejects.toThrow('成员控制链校验失败');
    } finally {
      await (reopened ?? store).close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
