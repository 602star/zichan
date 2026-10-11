import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerCryptoSession,
  rotateLedgerProtection, signLedgerControlEvent, wrapLedgerCryptoSessionForMember } from '@zichan/core';
import { loadNodeIdentity } from '../src/node-identity.js';
import { signNodeRequest } from '../src/node-request-auth.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('stale node commit quarantine', () => {
  it('returns a conflict without advancing the ledger and records the rejected peer commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-epoch-quarantine-'));
    const server = createTestSyncServer({ dataDir: join(root, 'source') });
    let store: SyncServerStore | undefined;
    try {
      await server.ready;
      await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
      store = new SyncServerStore(join(server.dataDir, 'server.sqlite'), 'open', server.serverId);
      await store.register('owner', 'opaque-owner', undefined, true);
      await store.register('member', 'opaque-member');
      const ledgerId = 'ledger-epoch-quarantine-0001';
      await store.bindReplica('owner', ledgerId);
      const owner = (await store.getUser('owner'))!;
      const member = (await store.getUser('member'))!;
      const actor = { issuerNodeId: server.serverId, accountId: owner.accountId };
      const target = { issuerNodeId: server.serverId, accountId: member.accountId };
      const ownerKey = await createAccountEncryptionKey(server.serverId, owner.accountId, 'owner key passphrase');
      const memberKey = await createAccountEncryptionKey(server.serverId, member.accountId, 'member key passphrase');
      await store.putAccountEncryptionKey(server.serverId, owner.accountId,
        ownerKey.envelope.publicKey, ownerKey.envelope as unknown as Record<string, unknown>, 0);
      await store.putAccountEncryptionKey(server.serverId, member.accountId,
        memberKey.envelope.publicKey, memberKey.envelope as unknown as Record<string, unknown>, 0);
      const ledger = createLedgerCryptoSession(ledgerId);
      await store.putKeyEnvelope('owner', ledgerId, ledger.keyringId, ledger.generation,
        { ledgerId, keyringId: ledger.keyringId, generation: ledger.generation });
      const first = await store.initializeLedgerControl('owner', signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 1, previousHash: null, keyEpoch: 1, kind: 'MemberGenesis',
          actor, target: actor, role: 'OWNER', signingPublicKey: accountSigningPublicKey(ownerKey.privateKey),
          encryptionPublicKey: ownerKey.envelope.publicKey }));
      const second = await store.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 2, previousHash: first.headHash, keyEpoch: 1,
          kind: 'MemberAdded', actor, target, role: 'EDITOR',
          signingPublicKey: accountSigningPublicKey(memberKey.privateKey),
          encryptionPublicKey: memberKey.envelope.publicKey }));
      await store.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 3, previousHash: second.headHash, keyEpoch: 2,
          kind: 'MemberRemoved', actor, target }));
      const rotated = await rotateLedgerProtection(ledger, 'next ledger passphrase');
      await store.putLedgerMemberKeyEnvelope('owner', await wrapLedgerCryptoSessionForMember(rotated.session,
        { ...actor, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 2 }));
      mkdirSync(join(root, 'peer'));
      const peer = loadNodeIdentity(join(root, 'peer'), 'peer-node-epoch-control');
      const grant = await store.createNodeReplicationGrant('owner', peer.nodeId, peer.publicKey,
        new Date(Date.now() + 86_400_000).toISOString());
      const path = '/api/v4/replication/commits';
      const commitId = 'commit-stale-node-00001';
      const body = JSON.stringify({ commits: [{ commitId, ledgerId, contentHash: 'a'.repeat(64),
        encCommit: { v: 3, keyId: ledger.activeKeyId, iv: 'iv', ct: 'cipher' },
        keyEpoch: 1, writer: target }], requiredCapabilities: [] });
      const sendStale = () => fetch(`${url}${path}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json',
          'X-Zichan-Node-Proof': JSON.stringify(signNodeRequest(peer, grant.grantId, 'POST', path,
            Buffer.from(body))) }, body });
      const response = await sendStale();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'STALE_COMMIT_EPOCH' });
      expect((await store.listCommits('owner', 0, 10)).commits).toEqual([]);
      expect(await store.listRejectedNodeCommits('owner')).toMatchObject([{
        peerNodeId: peer.nodeId, commitId, keyEpoch: 1, writer: target,
        reason: 'STALE_COMMIT_EPOCH', archived: true,
      }]);
      expect(await store.rejectedNodeCommitCiphertext('owner', peer.nodeId, commitId))
        .toMatchObject({ commitId, ledgerId, contentHash: 'a'.repeat(64), keyEpoch: 1,
          writer: target, encCommit: { keyId: ledger.activeKeyId, ct: 'cipher' } });
      await expect(store.rejectedNodeCommitCiphertext('member', peer.nodeId, commitId))
        .rejects.toMatchObject({ code: 'LEDGER_MEMBER_REQUIRED' });
      expect((await store.replicaInventory('owner', ledgerId)).rejectedCommitCount).toBe(1);
      expect((await sendStale()).status).toBe(409);
      expect(await store.listRejectedNodeCommits('owner')).toHaveLength(1);
      // A browser may have pulled this commit from the old node and encrypted it
      // with the new key. Its unchanged ID must not silently become an owner write.
      await expect(store.pushCommits('owner', [{ commitId, ledgerId, contentHash: 'a'.repeat(64),
        encCommit: { v: 3, keyId: rotated.session.activeKeyId, iv: 'fresh-iv', ct: 'fresh-cipher' } }]))
        .rejects.toMatchObject({ code: 'REJECTED_COMMIT_REVIEW_REQUIRED', commitId });
      expect((await store.listCommits('owner', 0, 10)).commits).toEqual([]);
      await store.close();
      store = new SyncServerStore(join(server.dataDir, 'server.sqlite'), 'open', server.serverId);
      expect(await store.rejectedNodeCommitCiphertext('owner', peer.nodeId, commitId))
        .toMatchObject({ encCommit: { ct: 'cipher' } });
    } finally {
      await store?.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
