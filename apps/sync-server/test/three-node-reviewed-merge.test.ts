import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerCryptoSession,
  encryptJson, rotateLedgerProtection, sha256Json, signLedgerControlEvent,
  wireSyncCommit, wrapLedgerCryptoSessionForMember, type Asset } from '@zichan/core';
import { aggregateKey, mergeReviewedCommit } from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import { loadNodeIdentity } from '../src/node-identity.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('three-node owner-reviewed stale write', () => {
  it('quarantines an old member write, publishes a manual merge, and converges all replicas', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-three-node-reviewed-'));
    const nodes = ['hub', 'home', 'office'].map((name) =>
      createTestSyncServer({ dataDir: join(root, name) }));
    const stores: SyncServerStore[] = [];
    const oldWriter = await openLedger({ deviceId: 'stale-member' });
    const ownerDevice = await openLedger({ deviceId: 'reviewing-owner' });
    try {
      await Promise.all(nodes.map((node) => node.ready));
      await Promise.all(nodes.map((node) => new Promise<void>((resolve) =>
        node.server.listen(0, '127.0.0.1', resolve))));
      const urls = nodes.map((node) => `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`);
      for (const node of nodes) {
        const store = new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId);
        stores.push(store);
        await store.ready;
        await store.register('owner', `opaque-${node.serverId}`, undefined, true);
      }
      await stores[0]!.register('member', 'opaque-member');
      const ledgerId = 'ledger-three-node-reviewed-0001';
      await oldWriter.adoptLedgerId(ledgerId);
      await ownerDevice.adoptLedgerId(ledgerId);
      const initialKey = createLedgerCryptoSession(ledgerId);
      const envelope = { ledgerId, keyringId: initialKey.keyringId, generation: 1 };
      const replicas = await Promise.all(stores.map((store) => store.bindReplica('owner', ledgerId)));
      await Promise.all(stores.map((store) => store.putKeyEnvelope('owner', ledgerId,
        initialKey.keyringId, 1, envelope)));
      const owner = (await stores[0]!.getUser('owner'))!;
      const member = (await stores[0]!.getUser('member'))!;
      const actor = { issuerNodeId: nodes[0]!.serverId, accountId: owner.accountId };
      const revoked = { issuerNodeId: nodes[0]!.serverId, accountId: member.accountId };
      const ownerKey = await createAccountEncryptionKey(nodes[0]!.serverId, owner.accountId, 'owner-key-password');
      const memberKey = await createAccountEncryptionKey(nodes[0]!.serverId, member.accountId, 'member-key-password');
      for (const [account, key] of [[owner, ownerKey], [member, memberKey]] as const) {
        await stores[0]!.putAccountEncryptionKey(nodes[0]!.serverId, account.accountId,
          key.envelope.publicKey, key.envelope as unknown as Record<string, unknown>, 0);
      }
      const genesis = await stores[0]!.initializeLedgerControl('owner', signLedgerControlEvent(ownerKey.privateKey, {
        v: 1, ledgerId, seq: 1, previousHash: null, keyEpoch: 1, kind: 'MemberGenesis',
        actor, target: actor, role: 'OWNER', signingPublicKey: accountSigningPublicKey(ownerKey.privateKey),
        encryptionPublicKey: ownerKey.envelope.publicKey,
      }));
      const added = await stores[0]!.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey, {
        v: 1, ledgerId, seq: 2, previousHash: genesis.headHash, keyEpoch: 1,
        kind: 'MemberAdded', actor, target: revoked, role: 'EDITOR',
        signingPublicKey: accountSigningPublicKey(memberKey.privateKey),
        encryptionPublicKey: memberKey.envelope.publicKey,
      }));
      await stores[0]!.putLedgerMemberKeyEnvelope('owner', await wrapLedgerCryptoSessionForMember(initialKey,
        { ...actor, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 1 }));
      await stores[0]!.putLedgerMemberKeyEnvelope('owner', await wrapLedgerCryptoSessionForMember(initialKey,
        { ...revoked, recipientPublicKey: memberKey.envelope.publicKey, keyEpoch: 1 }));
      for (const index of [1, 2]) {
        const grant = await stores[0]!.createNodeReplicationGrant('owner', nodes[index]!.serverId,
          loadNodeIdentity(nodes[index]!.dataDir, nodes[index]!.serverId).publicKey,
          new Date(Date.now() + 86_400_000).toISOString());
        await stores[index]!.createNodeReplicationLink({ username: 'owner', ledgerId,
          localStreamEpoch: replicas[index]!.streamEpoch, peerUrl: urls[0]!, peerNodeId: nodes[0]!.serverId,
          peerPublicKey: loadNodeIdentity(nodes[0]!.dataDir, nodes[0]!.serverId).publicKey,
          peerReplicaId: replicas[0]!.replicaId, peerStreamEpoch: replicas[0]!.streamEpoch,
          grantId: grant.grantId });
      }
      await Promise.all([nodes[1]!.flushNodeReplication(), nodes[2]!.flushNodeReplication()]);
      expect((await stores[1]!.ledgerControlState('owner'))?.seq).toBe(2);

      const asset: Asset = { id: 'asset-reviewed-merge-0001', code: 'OLD', name: 'Old member value',
        type: 'crypto', decimals: 8, isActive: true, createdAt: '', updatedAt: '',
        version: 1, isDeleted: false } as Asset;
      await oldWriter.assets.put(asset);
      const stale = wireSyncCommit((await oldWriter.listSyncCommits())[0]!);
      const staleHash = await sha256Json(stale);
      await stores[0]!.pushCommits('member', [{ commitId: stale.commitId, ledgerId,
        contentHash: staleHash, encCommit: await encryptJson(initialKey, stale,
          { protocol: 2, ledgerId, commitId: stale.commitId, contentHash: staleHash }) }]);

      const rotated = await rotateLedgerProtection(initialKey, 'new-ledger-password');
      const removed = await stores[1]!.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey, {
        v: 1, ledgerId, seq: 3, previousHash: added.headHash, keyEpoch: 2,
        kind: 'MemberRemoved', actor, target: revoked,
      }), [await wrapLedgerCryptoSessionForMember(rotated.session,
        { ...actor, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 2 })]);
      const current = await ownerDevice.assets.put({ ...asset, code: 'CURRENT', name: 'Current owner value' });
      const currentCommit = wireSyncCommit((await ownerDevice.listSyncCommits())[0]!);
      const currentHash = await sha256Json(currentCommit);
      await stores[1]!.pushCommits('owner', [{ commitId: currentCommit.commitId, ledgerId,
        contentHash: currentHash, encCommit: await encryptJson(rotated.session, currentCommit,
          { protocol: 2, ledgerId, commitId: currentCommit.commitId, contentHash: currentHash }) }]);
      for (let round = 0; round < 3; round += 1) {
        await Promise.all([nodes[1]!.flushNodeReplication(), nodes[2]!.flushNodeReplication()]);
      }
      expect((await stores[1]!.listRejectedNodeCommits('owner'))[0]?.commitId).toBe(stale.commitId);
      const key = aggregateKey('asset', asset.id);
      const graph = await ownerDevice.syncGraph();
      const merged = await mergeReviewedCommit(ownerDevice, stale, {
        [key]: { ...current, name: asset.name },
      }, { ledgerHeads: graph.ledgerHeads, entityHeads: { [key]: graph.entityHeads.get(key) ?? [] },
        currentPayloads: { [key]: await ownerDevice.getSyncAggregate('asset', asset.id) } });
      expect((await ownerDevice.assets.get(asset.id))?.name).toBe(asset.name);
      expect((await ownerDevice.assets.get(asset.id))?.code).toBe('CURRENT');
      const replacement = wireSyncCommit(merged);
      const replacementHash = await sha256Json(replacement);
      await stores[1]!.pushCommits('owner', [{ commitId: replacement.commitId, ledgerId,
        contentHash: replacementHash, encCommit: await encryptJson(rotated.session, replacement,
          { protocol: 2, ledgerId, commitId: replacement.commitId, contentHash: replacementHash }) }]);
      await stores[1]!.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey, {
        v: 1, ledgerId, seq: 4, previousHash: removed.headHash, keyEpoch: 2,
        kind: 'RejectedCommitResolved', actor, target: actor, rejectedCommitId: stale.commitId,
        rejectedContentHash: staleHash, decision: 'replay', replacementCommitId: replacement.commitId,
        replacementContentHash: replacementHash,
      }));
      for (let round = 0; round < 8; round += 1) {
        await Promise.all([nodes[1]!.flushNodeReplication(), nodes[2]!.flushNodeReplication()]);
        const inventories = await Promise.all(stores.map((store) => store.replicaInventory('owner', ledgerId)));
        if (inventories.every((inventory) => inventory.commitCount === 2
          && inventory.rejectedCommitCount === 0)) break;
      }
      const inventories = await Promise.all(stores.map((store) => store.replicaInventory('owner', ledgerId)));
      expect(inventories.map((inventory) => ({ commits: inventory.commitCount,
        rejected: inventory.rejectedCommitCount, hash: inventory.commitHash }))).toEqual(
        Array.from({ length: 3 }, () => ({ commits: 2, rejected: 0, hash: inventories[0]!.commitHash })));
      for (const store of stores) {
        expect((await store.ledgerControlState('owner'))?.seq).toBe(4);
        expect((await store.listCommits('owner', 0, 10)).commits
          .filter((row) => !row.quarantined).map((row) => row.commitId).sort())
          .toEqual([currentCommit.commitId, replacement.commitId].sort());
      }
    } finally {
      await Promise.all([oldWriter.close(), ownerDevice.close()]);
      await Promise.all(stores.map((store) => store.close()));
      await Promise.all(nodes.map((node) => node.close()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
