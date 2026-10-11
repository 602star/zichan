import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerCryptoSession,
  rotateLedgerProtection, signLedgerControlEvent, wrapLedgerCryptoSessionForMember } from '@zichan/core';
import { SyncServerStore } from '../src/store.js';

describe('commit key epoch', () => {
  it('records the writer and epoch, rejects stale writes, and accepts an idempotent old commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-commit-epoch-'));
    const serverId = 'server-epoch-control';
    const ledgerId = 'ledger-commit-epoch-0001';
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'open', serverId);
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      await store.register('member', 'opaque-member');
      const owner = (await store.getUser('owner'))!;
      const member = (await store.getUser('member'))!;
      await store.bindReplica('owner', ledgerId);
      const ownerIdentity = { issuerNodeId: serverId, accountId: owner.accountId };
      const memberIdentity = { issuerNodeId: serverId, accountId: member.accountId };
      const ledger = createLedgerCryptoSession(ledgerId);
      const preControl = { commitId: 'commit-before-control-0001', ledgerId, contentHash: 'c'.repeat(64),
        encCommit: { v: 3, keyId: ledger.activeKeyId, iv: 'iv', ct: 'cipher' } };
      await store.pushCommits('owner', [preControl]);
      expect((await store.listCommits('owner', 0, 10)).commits[0]?.keyEpoch).toBe(0);
      const ownerKey = await createAccountEncryptionKey(serverId, owner.accountId, 'owner account key');
      const memberKey = await createAccountEncryptionKey(serverId, member.accountId, 'member account key');
      for (const [account, key] of [[owner, ownerKey], [member, memberKey]] as const) {
        await store.putAccountEncryptionKey(serverId, account.accountId, key.envelope.publicKey,
          key.envelope as unknown as Record<string, unknown>, 0);
      }
      const first = await store.initializeLedgerControl('owner', signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 1, previousHash: null, keyEpoch: 1, kind: 'MemberGenesis',
          actor: ownerIdentity, target: ownerIdentity, role: 'OWNER',
          signingPublicKey: accountSigningPublicKey(ownerKey.privateKey),
          encryptionPublicKey: ownerKey.envelope.publicKey }));
      expect((await store.listCommits('owner', 0, 10)).commits[0])
        .toMatchObject({ commitId: preControl.commitId, keyEpoch: 1, writer: ownerIdentity });
      await store.createSession({ id: 'owner-replace-session', username: 'owner', deviceId: 'owner-device',
        deviceName: 'test', refreshHash: 'hash', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const bound = (await store.getReplica('owner'))!;
      await expect(store.replaceReplica('owner', 'owner-replace-session',
        { ledgerId, streamEpoch: bound.streamEpoch },
        { ledgerId: 'ledger-other-epoch-0001', keyringId: 'keyring-other-0001', generation: 1 }, []))
        .rejects.toMatchObject({ code: 'REPLICA_CONTROLLED' });
      const second = await store.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 2, previousHash: first.headHash, keyEpoch: 1,
          kind: 'MemberAdded', actor: ownerIdentity, target: memberIdentity, role: 'EDITOR',
          signingPublicKey: accountSigningPublicKey(memberKey.privateKey),
          encryptionPublicKey: memberKey.envelope.publicKey }));
      await store.putLedgerMemberKeyEnvelope('owner', await wrapLedgerCryptoSessionForMember(ledger,
        { ...ownerIdentity, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 1 }));
      await store.putLedgerMemberKeyEnvelope('owner', await wrapLedgerCryptoSessionForMember(ledger,
        { ...memberIdentity, recipientPublicKey: memberKey.envelope.publicKey, keyEpoch: 1 }));
      const inconsistent = await rotateLedgerProtection(ledger, 'inconsistent key passphrase');
      await expect(store.putLedgerMemberKeyEnvelope('owner', await wrapLedgerCryptoSessionForMember(
        inconsistent.session, { ...memberIdentity, recipientPublicKey: memberKey.envelope.publicKey,
          keyEpoch: 1 }))).rejects.toMatchObject({ code: 'MEMBER_ACTIVE_KEY_MISMATCH' });
      const oldCommit = { commitId: 'commit-member-epoch-0001', ledgerId, contentHash: 'a'.repeat(64),
        encCommit: { v: 3, keyId: ledger.activeKeyId, iv: 'iv', ct: 'cipher' } };
      await store.pushCommits('member', [oldCommit]);
      expect((await store.listCommits('owner', 0, 10)).commits[1])
        .toMatchObject({ commitId: oldCommit.commitId, keyEpoch: 1, writer: memberIdentity });
      const removedEvent = signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 3, previousHash: second.headHash, keyEpoch: 2,
          kind: 'MemberRemoved', actor: ownerIdentity, target: memberIdentity });
      const staleEnvelope = await wrapLedgerCryptoSessionForMember(ledger,
        { ...ownerIdentity, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 2 });
      await expect(store.appendLedgerControlEvent('owner', removedEvent, [staleEnvelope]))
        .rejects.toMatchObject({ code: 'MEMBER_KEY_NOT_ROTATED' });
      expect((await store.ledgerControlState('owner'))?.keyEpoch).toBe(1);
      const rotated = await rotateLedgerProtection(ledger, 'next ledger passphrase');
      const currentOwnerEnvelope = await wrapLedgerCryptoSessionForMember(rotated.session,
        { ...ownerIdentity, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 2 });
      const removed = await store.appendLedgerControlEvent('owner', removedEvent, [currentOwnerEnvelope]);
      expect(removed.keyEpoch).toBe(2);
      expect(await store.currentLedgerMemberKeyEnvelope('owner')).toEqual(currentOwnerEnvelope);
      await expect(store.pushCommits('member', [{ ...oldCommit, commitId: 'commit-member-epoch-0002' }]))
        .rejects.toMatchObject({ code: 'LEDGER_MEMBER_REQUIRED' });
      await expect(store.pushCommits('owner', [{ ...oldCommit, commitId: 'commit-owner-oldkey-0001' }]))
        .rejects.toMatchObject({ code: 'COMMIT_KEY_EPOCH_MISMATCH' });
      await expect(store.pushCommits('owner', [{ ...oldCommit, commitId: 'commit-remote-stale-0001',
        keyEpoch: 1, writer: memberIdentity }], [], [], 'node'))
        .rejects.toMatchObject({ code: 'STALE_COMMIT_EPOCH', commitId: 'commit-remote-stale-0001' });
      await expect(store.pushCommits('owner', [{ ...oldCommit, commitId: 'commit-remote-unattributed-0001',
        keyEpoch: 0 }], [], [], 'node'))
        .rejects.toMatchObject({ code: 'STALE_COMMIT_EPOCH', commitId: 'commit-remote-unattributed-0001' });
      expect((await store.pushCommits('owner', [{ ...oldCommit, keyEpoch: 1,
        writer: memberIdentity }], [], [], 'node')).assigned).toHaveLength(1);
      const fresh = { ...oldCommit, commitId: 'commit-owner-fresh-0001', contentHash: 'b'.repeat(64),
        encCommit: { ...oldCommit.encCommit, keyId: rotated.session.activeKeyId } };
      await store.pushCommits('owner', [fresh]);
      expect((await store.listCommits('owner', 0, 10)).commits.at(-1))
        .toMatchObject({ commitId: fresh.commitId, keyEpoch: 2, writer: ownerIdentity });
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
