import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerCryptoSession,
  rotateLedgerProtection, signLedgerControlEvent, wrapLedgerCryptoSessionForMember } from '@zichan/core';
import { loadNodeIdentity } from '../src/node-identity.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('signed rejected-commit resolution', () => {
  it('quarantines an old stream row, copies the owner decision, and converges after replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-rejected-resolution-'));
    const source = createTestSyncServer({ dataDir: join(root, 'source') });
    const target = createTestSyncServer({ dataDir: join(root, 'target') });
    let sourceStore: SyncServerStore | undefined;
    let targetStore: SyncServerStore | undefined;
    try {
      await Promise.all([source.ready, target.ready]);
      await Promise.all([source, target].map((node) => new Promise<void>((resolve) =>
        node.server.listen(0, '127.0.0.1', resolve))));
      const sourceUrl = `http://127.0.0.1:${(source.server.address() as AddressInfo).port}`;
      sourceStore = new SyncServerStore(join(source.dataDir, 'server.sqlite'), 'open', source.serverId);
      targetStore = new SyncServerStore(join(target.dataDir, 'server.sqlite'), 'open', target.serverId);
      await sourceStore.register('owner', 'opaque-source-owner', undefined, true);
      await sourceStore.register('member', 'opaque-member');
      await targetStore.register('owner', 'opaque-target-owner', undefined, true);
      const ledgerId = 'ledger-rejected-resolution-0001';
      const sourceReplica = await sourceStore.bindReplica('owner', ledgerId);
      const targetReplica = await targetStore.bindReplica('owner', ledgerId);
      const ledger = createLedgerCryptoSession(ledgerId);
      const legacyEnvelope = { ledgerId, keyringId: ledger.keyringId, generation: 1 };
      await sourceStore.putKeyEnvelope('owner', ledgerId, ledger.keyringId, 1, legacyEnvelope);
      await targetStore.putKeyEnvelope('owner', ledgerId, ledger.keyringId, 1, legacyEnvelope);
      const owner = (await sourceStore.getUser('owner'))!;
      const member = (await sourceStore.getUser('member'))!;
      const actor = { issuerNodeId: source.serverId, accountId: owner.accountId };
      const removedMember = { issuerNodeId: source.serverId, accountId: member.accountId };
      const ownerKey = await createAccountEncryptionKey(source.serverId, owner.accountId, 'owner separate key');
      const memberKey = await createAccountEncryptionKey(source.serverId, member.accountId, 'member separate key');
      await sourceStore.putAccountEncryptionKey(source.serverId, owner.accountId,
        ownerKey.envelope.publicKey, ownerKey.envelope as unknown as Record<string, unknown>, 0);
      await sourceStore.putAccountEncryptionKey(source.serverId, member.accountId,
        memberKey.envelope.publicKey, memberKey.envelope as unknown as Record<string, unknown>, 0);
      const genesis = await sourceStore.initializeLedgerControl('owner', signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 1, previousHash: null, keyEpoch: 1,
          kind: 'MemberGenesis', actor, target: actor, role: 'OWNER',
          signingPublicKey: accountSigningPublicKey(ownerKey.privateKey),
          encryptionPublicKey: ownerKey.envelope.publicKey }));
      const added = await sourceStore.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 2, previousHash: genesis.headHash, keyEpoch: 1,
          kind: 'MemberAdded', actor, target: removedMember, role: 'EDITOR',
          signingPublicKey: accountSigningPublicKey(memberKey.privateKey),
          encryptionPublicKey: memberKey.envelope.publicKey }));
      await sourceStore.putLedgerMemberKeyEnvelope('owner', await wrapLedgerCryptoSessionForMember(ledger,
        { ...actor, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 1 }));
      await sourceStore.putLedgerMemberKeyEnvelope('owner', await wrapLedgerCryptoSessionForMember(ledger,
        { ...removedMember, recipientPublicKey: memberKey.envelope.publicKey, keyEpoch: 1 }));
      const grant = await sourceStore.createNodeReplicationGrant('owner', target.serverId,
        loadNodeIdentity(target.dataDir, target.serverId).publicKey,
        new Date(Date.now() + 86_400_000).toISOString());
      const link = await targetStore.createNodeReplicationLink({ username: 'owner', ledgerId,
        localStreamEpoch: targetReplica.streamEpoch, peerUrl: sourceUrl, peerNodeId: source.serverId,
        peerPublicKey: loadNodeIdentity(source.dataDir, source.serverId).publicKey,
        peerReplicaId: sourceReplica.replicaId, peerStreamEpoch: sourceReplica.streamEpoch,
        grantId: grant.grantId });
      await target.flushNodeReplication();
      expect((await targetStore.ledgerControlState('owner'))?.seq).toBe(2);

      const oldCommitId = 'commit-member-before-revocation-0001';
      const oldHash = 'a'.repeat(64);
      await sourceStore.pushCommits('member', [{ commitId: oldCommitId, ledgerId, contentHash: oldHash,
        encCommit: { v: 3, keyId: ledger.activeKeyId, iv: 'old-iv', ct: 'old-cipher' } }]);
      const rotated = await rotateLedgerProtection(ledger, 'new ledger password');
      const currentOwnerEnvelope = await wrapLedgerCryptoSessionForMember(rotated.session,
        { ...actor, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 2 });
      const removed = await targetStore.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 3, previousHash: added.headHash, keyEpoch: 2,
          kind: 'MemberRemoved', actor, target: removedMember }), [currentOwnerEnvelope]);
      await target.flushNodeReplication();
      expect(await targetStore.listRejectedNodeCommits('owner')).toMatchObject([{
        commitId: oldCommitId, contentHash: oldHash, archived: true,
      }]);
      expect((await targetStore.listNodeReplicationLinks('owner'))[0]?.lastError).toMatch(/旧密钥代次/);

      const replacementCommitId = 'commit-owner-reviewed-replay-0001';
      const replacementHash = 'b'.repeat(64);
      await targetStore.pushCommits('owner', [{ commitId: replacementCommitId, ledgerId,
        contentHash: replacementHash,
        encCommit: { v: 3, keyId: rotated.session.activeKeyId, iv: 'new-iv', ct: 'new-cipher' } }]);
      const replayed = await targetStore.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 4, previousHash: removed.headHash, keyEpoch: 2,
          kind: 'RejectedCommitResolved', actor, target: actor, rejectedCommitId: oldCommitId,
          rejectedContentHash: oldHash, decision: 'replay',
          replacementCommitId, replacementContentHash: replacementHash }));
      await target.flushNodeReplication();
      const sourceRows = (await sourceStore.listCommits('owner', 0, 10)).commits;
      expect(sourceRows).toMatchObject([{ commitId: oldCommitId, quarantined: true },
        { commitId: replacementCommitId }]);
      expect((await targetStore.listCommits('owner', 0, 10)).commits)
        .toMatchObject([{ commitId: replacementCommitId }]);
      const sourceInventory = await sourceStore.replicaInventory('owner', ledgerId);
      const targetInventory = await targetStore.replicaInventory('owner', ledgerId);
      expect(sourceInventory).toMatchObject({ commitCount: 1, rejectedCommitCount: 0,
        commitHash: targetInventory.commitHash });
      expect(targetInventory).toMatchObject({ commitCount: 1, rejectedCommitCount: 0 });
      const recovered = (await targetStore.listNodeReplicationLinks('owner'))[0]!;
      expect(recovered.linkId).toBe(link.linkId);
      expect(recovered.lastError).toBeUndefined();
      expect(recovered.pullSeq).toBe(sourceRows.at(-1)!.seq);
      expect(recovered.pushSeq).toBe(1);
      const discardedId = 'commit-reviewed-discard-0001';
      const discardedHash = 'c'.repeat(64);
      await targetStore.recordRejectedNodeCommit('owner', source.serverId, {
        commitId: discardedId, ledgerId, contentHash: discardedHash, keyEpoch: 1,
        writer: removedMember,
        encCommit: { v: 3, keyId: ledger.activeKeyId, iv: 'discard-iv', ct: 'discard-cipher' },
      }, 'STALE_COMMIT_EPOCH');
      await targetStore.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 5, previousHash: replayed.headHash, keyEpoch: 2,
          kind: 'RejectedCommitResolved', actor, target: actor, rejectedCommitId: discardedId,
          rejectedContentHash: discardedHash, decision: 'discard' }));
      await target.flushNodeReplication();
      expect(await targetStore.listRejectedNodeCommits('owner')).toEqual(expect.arrayContaining([
        expect.objectContaining({ commitId: discardedId, resolution: { decision: 'discard' } }),
      ]));
      expect((await sourceStore.ledgerControlState('owner'))?.seq).toBe(5);
      expect((await targetStore.replicaInventory('owner', ledgerId)).rejectedCommitCount).toBe(0);
      const restarted = new SyncServerStore(join(source.dataDir, 'server.sqlite'), 'open', source.serverId);
      try { expect((await restarted.verify()).ok).toBe(true); }
      finally { await restarted.close(); }
      const sql = new NodeSqliteDriver(join(source.dataDir, 'server.sqlite'));
      try { await sql.run('DELETE FROM ledger_control_resolutions WHERE rejected_commit_id = ?', [oldCommitId]); }
      finally { await sql.close(); }
      const altered = new SyncServerStore(join(source.dataDir, 'server.sqlite'), 'open', source.serverId);
      await expect(altered.verify()).rejects.toThrow('签名隔离提交处置索引与成员控制链不一致');
      await altered.close();
    } finally {
      await Promise.all([sourceStore?.close(), targetStore?.close()]);
      await Promise.all([source.close(), target.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
