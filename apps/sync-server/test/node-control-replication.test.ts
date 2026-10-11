import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerCryptoSession,
  rotateLedgerProtection, signLedgerControlEvent, wrapLedgerCryptoSessionForMember } from '@zichan/core';
import { loadNodeIdentity } from '../src/node-identity.js';
import { verifyNodeReplicaInventory } from '../src/node-replication.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('node member control replication', () => {
  it('pulls and pushes signed events, resumes idempotently, and stops on a fork', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-node-control-'));
    const source = createTestSyncServer({ dataDir: join(root, 'source') });
    const peer = createTestSyncServer({ dataDir: join(root, 'peer') });
    let sourceStore: SyncServerStore | undefined;
    let peerStore: SyncServerStore | undefined;
    try {
      await Promise.all([source.ready, peer.ready]);
      await Promise.all([source, peer].map((node) => new Promise<void>((resolve) =>
        node.server.listen(0, '127.0.0.1', resolve))));
      const sourceUrl = `http://127.0.0.1:${(source.server.address() as AddressInfo).port}`;
      sourceStore = new SyncServerStore(join(source.dataDir, 'server.sqlite'), 'open', source.serverId);
      peerStore = new SyncServerStore(join(peer.dataDir, 'server.sqlite'), 'open', peer.serverId);
      await sourceStore.register('owner', 'opaque-source-owner', undefined, true);
      await peerStore.register('owner', 'opaque-peer-owner', undefined, true);
      const ledgerId = 'ledger-node-control-0001';
      const sourceReplica = await sourceStore.bindReplica('owner', ledgerId);
      const peerReplica = await peerStore.bindReplica('owner', ledgerId);
      const ledger = createLedgerCryptoSession(ledgerId);
      const keyringId = ledger.keyringId;
      const oldEnvelope = { ledgerId, keyringId, generation: 1 };
      await sourceStore.putKeyEnvelope('owner', ledgerId, keyringId, 1, oldEnvelope);
      await peerStore.putKeyEnvelope('owner', ledgerId, keyringId, 1, oldEnvelope);
      const owner = (await sourceStore.getUser('owner'))!;
      const accountKey = await createAccountEncryptionKey(source.serverId, owner.accountId,
        'separate account encryption password');
      await sourceStore.putAccountEncryptionKey(source.serverId, owner.accountId,
        accountKey.envelope.publicKey, accountKey.envelope as unknown as Record<string, unknown>, 0);
      const actor = { issuerNodeId: source.serverId, accountId: owner.accountId };
      const first = await sourceStore.initializeLedgerControl('owner', signLedgerControlEvent(accountKey.privateKey,
        { v: 1, ledgerId, seq: 1, previousHash: null, keyEpoch: 1,
          kind: 'MemberGenesis', actor, target: actor, role: 'OWNER',
          signingPublicKey: accountSigningPublicKey(accountKey.privateKey),
          encryptionPublicKey: accountKey.envelope.publicKey }));
      const ownerEnvelope = await wrapLedgerCryptoSessionForMember(ledger, { issuerNodeId: source.serverId,
        accountId: owner.accountId, recipientPublicKey: accountKey.envelope.publicKey, keyEpoch: 1 });
      await sourceStore.putLedgerMemberKeyEnvelope('owner', ownerEnvelope);
      const grant = await sourceStore.createNodeReplicationGrant('owner', peer.serverId,
        loadNodeIdentity(peer.dataDir, peer.serverId).publicKey,
        new Date(Date.now() + 86_400_000).toISOString());
      const link = await peerStore.createNodeReplicationLink({ username: 'owner', ledgerId,
        localStreamEpoch: peerReplica.streamEpoch, peerUrl: sourceUrl, peerNodeId: source.serverId,
        peerPublicKey: loadNodeIdentity(source.dataDir, source.serverId).publicKey,
        peerReplicaId: sourceReplica.replicaId, peerStreamEpoch: sourceReplica.streamEpoch,
        grantId: grant.grantId });
      await peer.flushNodeReplication();
      expect(await peerStore.ledgerControlState('owner')).toMatchObject({ seq: 1, headHash: first.headHash });
      expect(await peerStore.currentLedgerMemberKeyEnvelope('owner')).toEqual(ownerEnvelope);
      expect(await peerStore.replicaInventory('owner', ledgerId)).toMatchObject({
        memberAccountKeyCount: 1, missingMemberAccountKeyCount: 0,
      });
      const damagedKeys = new NodeSqliteDriver(join(peer.dataDir, 'server.sqlite'));
      try {
        await damagedKeys.run('DELETE FROM account_encryption_keys WHERE issuer_node_id = ? AND subject_account_id = ?',
          [source.serverId, owner.accountId]);
      } finally { await damagedKeys.close(); }
      expect(await peerStore.replicaInventory('owner', ledgerId)).toMatchObject({
        memberAccountKeyCount: 0, missingMemberAccountKeyCount: 1,
      });
      expect(await verifyNodeReplicaInventory(peerStore, loadNodeIdentity(peer.dataDir, peer.serverId), link))
        .toBeUndefined();
      expect((await peerStore.listNodeReplicationLinks('owner'))[0]?.inventoryIssue)
        .toMatch(/成员账号密钥待补齐/);
      await peer.flushNodeReplication();
      expect(await peerStore.replicaInventory('owner', ledgerId)).toMatchObject({
        memberAccountKeyCount: 1, missingMemberAccountKeyCount: 0,
      });
      expect((await peerStore.listNodeReplicationLinks('owner'))[0]?.inventoryIssue).toBeUndefined();
      expect(await peerStore.ledgerControlState('owner')).toMatchObject({ seq: 1, headHash: first.headHash });

      await sourceStore.register('newmember', 'opaque-newmember');
      const newMember = (await sourceStore.getUser('newmember'))!;
      const newKey = await createAccountEncryptionKey(source.serverId, newMember.accountId,
        'new member encryption password');
      await sourceStore.putAccountEncryptionKey(source.serverId, newMember.accountId,
        newKey.envelope.publicKey, newKey.envelope as unknown as Record<string, unknown>, 0);
      const target = { issuerNodeId: source.serverId, accountId: newMember.accountId };
      const second = await sourceStore.appendLedgerControlEvent('owner', signLedgerControlEvent(accountKey.privateKey,
        { v: 1, ledgerId, seq: 2, previousHash: first.headHash, keyEpoch: 1,
          kind: 'MemberAdded', actor, target, role: 'EDITOR',
          signingPublicKey: accountSigningPublicKey(newKey.privateKey),
          encryptionPublicKey: newKey.envelope.publicKey }));
      await peer.flushNodeReplication();
      const incomplete = (await peerStore.listNodeReplicationLinks('owner'))[0];
      expect(incomplete?.lastError).toBeUndefined();
      expect(incomplete?.inventoryIssue).toMatch(/成员密钥待补齐/);
      expect(await peerStore.replicaInventory('owner', ledgerId)).toMatchObject({
        missingMemberEnvelopeCount: 1, missingMemberAccountCount: 1,
      });
      const newMemberEnvelope = await wrapLedgerCryptoSessionForMember(ledger, { issuerNodeId: source.serverId,
        accountId: newMember.accountId, recipientPublicKey: newKey.envelope.publicKey, keyEpoch: 1 });
      await sourceStore.putLedgerMemberKeyEnvelope('owner', newMemberEnvelope);
      await peer.flushNodeReplication();
      expect(await peerStore.ledgerControlState('owner')).toMatchObject({ seq: 2, headHash: second.headHash });
      const copiedEnvelopes = (await peerStore.ledgerMemberEnvelopePage('owner', '', 10)).envelopes;
      expect(copiedEnvelopes).toHaveLength(2);
      expect(copiedEnvelopes).toEqual(expect.arrayContaining([ownerEnvelope, newMemberEnvelope]));
      const third = await peerStore.appendLedgerControlEvent('owner', signLedgerControlEvent(accountKey.privateKey,
        { v: 1, ledgerId, seq: 3, previousHash: second.headHash, keyEpoch: 1,
          kind: 'MemberRoleChanged', actor, target, role: 'VIEWER' }));
      await peer.flushNodeReplication();
      expect(await sourceStore.ledgerControlState('owner')).toMatchObject({ seq: 3, headHash: third.headHash });

      const removed = await sourceStore.appendLedgerControlEvent('owner', signLedgerControlEvent(accountKey.privateKey,
        { v: 1, ledgerId, seq: 4, previousHash: third.headHash, keyEpoch: 2,
          kind: 'MemberRemoved', actor, target }));
      const rotated = await rotateLedgerProtection(ledger, 'new ledger recovery password');
      const currentOwnerEnvelope = await wrapLedgerCryptoSessionForMember(rotated.session,
        { issuerNodeId: source.serverId, accountId: owner.accountId,
          recipientPublicKey: accountKey.envelope.publicKey, keyEpoch: 2 });
      await sourceStore.putLedgerMemberKeyEnvelope('owner', currentOwnerEnvelope);
      await peer.flushNodeReplication();
      expect(await peerStore.ledgerControlState('owner')).toMatchObject({ seq: 4, headHash: removed.headHash, keyEpoch: 2 });
      expect(await peerStore.currentLedgerMemberKeyEnvelope('owner')).toEqual(currentOwnerEnvelope);
      expect((await peerStore.ledgerMemberEnvelopePage('owner', '', 10)).envelopes).toEqual([currentOwnerEnvelope]);
      const sourceInventory = await sourceStore.replicaInventory('owner', ledgerId);
      const peerInventory = await peerStore.replicaInventory('owner', ledgerId);
      expect(peerInventory).toMatchObject({ controlSeq: 4, keyEpoch: 2,
        controlHash: sourceInventory.controlHash,
        memberEnvelopeCount: 1, memberEnvelopeHash: sourceInventory.memberEnvelopeHash,
        missingMemberEnvelopeCount: 0, missingMemberAccountCount: 0 });

      const newMemberKeyRecord = (await sourceStore.accountEncryptionKey(source.serverId, newMember.accountId))!;
      await peerStore.importAccountEncryptionKey(newMemberKeyRecord);
      await sourceStore.appendLedgerControlEvent('owner', signLedgerControlEvent(accountKey.privateKey,
        { v: 1, ledgerId, seq: 5, previousHash: removed.headHash, keyEpoch: 2,
          kind: 'MemberAdded', actor, target, role: 'EDITOR',
          signingPublicKey: accountSigningPublicKey(newKey.privateKey),
          encryptionPublicKey: newKey.envelope.publicKey }));
      await peerStore.appendLedgerControlEvent('owner', signLedgerControlEvent(accountKey.privateKey,
        { v: 1, ledgerId, seq: 5, previousHash: removed.headHash, keyEpoch: 2,
          kind: 'MemberAdded', actor, target, role: 'VIEWER',
          signingPublicKey: accountSigningPublicKey(newKey.privateKey),
          encryptionPublicKey: newKey.envelope.publicKey }));
      await peer.flushNodeReplication();
      const stopped = (await peerStore.listNodeReplicationLinks('owner'))[0];
      expect(stopped?.linkId).toBe(link.linkId);
      expect(stopped?.lastError).toMatch(/同序号成员控制链哈希不同/);
      expect((await sourceStore.ledgerControlState('owner'))?.headHash)
        .not.toBe((await peerStore.ledgerControlState('owner'))?.headHash);
    } finally {
      await Promise.all([sourceStore?.close(), peerStore?.close()]);
      await Promise.all([source.close(), peer.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
