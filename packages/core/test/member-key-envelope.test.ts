import { describe, expect, it } from 'vitest';
import {
  createAccountEncryptionKey, createLedgerCryptoSession, decryptJson, encryptJson,
  rotateLedgerProtection, unlockAccountEncryptionKey, unlockLedgerMemberKeyEnvelope,
  wrapAccountEncryptionKey, wrapLedgerCryptoSessionForMember,
} from '../src/crypto.js';

describe('member ledger key envelopes', () => {
  it('binds each copy to its member and keeps a removed member off the next key epoch', async () => {
    const issuerNodeId = 'srv-issuer-001';
    const ownerId = 'account-owner-001';
    const removedId = 'account-removed-001';
    const passphrase = 'separate account encryption password';
    const owner = await createAccountEncryptionKey(issuerNodeId, ownerId, passphrase);
    const removed = await createAccountEncryptionKey(issuerNodeId, removedId, passphrase);
    expect(await unlockAccountEncryptionKey(passphrase, owner.envelope)).toEqual(owner.privateKey);
    await expect(unlockAccountEncryptionKey('incorrect password', owner.envelope)).rejects.toThrow();
    const rewrapped = await wrapAccountEncryptionKey(owner.privateKey, issuerNodeId, ownerId, 'new private key password');
    expect(rewrapped.publicKey).toBe(owner.envelope.publicKey);
    expect(await unlockAccountEncryptionKey('new private key password', rewrapped)).toEqual(owner.privateKey);

    const ledger = createLedgerCryptoSession('ledger-family-00000001');
    const ownerCopy = await wrapLedgerCryptoSessionForMember(ledger,
      { issuerNodeId, accountId: ownerId, recipientPublicKey: owner.envelope.publicKey, keyEpoch: 1 });
    const removedCopy = await wrapLedgerCryptoSessionForMember(ledger,
      { issuerNodeId, accountId: removedId, recipientPublicKey: removed.envelope.publicKey, keyEpoch: 1 });
    const ownerSession = await unlockLedgerMemberKeyEnvelope(owner.privateKey, ownerCopy);
    const removedSession = await unlockLedgerMemberKeyEnvelope(removed.privateKey, removedCopy);
    const first = await encryptJson(ledger, { amount: '12.34' }, { ledgerId: ledger.ledgerId, commitId: 'first' });
    expect(await decryptJson(ownerSession, first, { ledgerId: ledger.ledgerId, commitId: 'first' }))
      .toEqual({ amount: '12.34' });
    expect(await decryptJson(removedSession, first, { ledgerId: ledger.ledgerId, commitId: 'first' }))
      .toEqual({ amount: '12.34' });
    await expect(unlockLedgerMemberKeyEnvelope(removed.privateKey, ownerCopy)).rejects.toThrow();
    await expect(unlockLedgerMemberKeyEnvelope(owner.privateKey,
      { ...ownerCopy, accountId: removedId })).rejects.toThrow();

    const rotated = await rotateLedgerProtection(ledger, 'ledger encryption password');
    const nextOwnerCopy = await wrapLedgerCryptoSessionForMember(rotated.session,
      { issuerNodeId, accountId: ownerId, recipientPublicKey: owner.envelope.publicKey, keyEpoch: 2 });
    const nextOwnerSession = await unlockLedgerMemberKeyEnvelope(owner.privateKey, nextOwnerCopy);
    const future = await encryptJson(rotated.session, { amount: '56.78' },
      { ledgerId: ledger.ledgerId, commitId: 'future' });
    expect(await decryptJson(nextOwnerSession, future, { ledgerId: ledger.ledgerId, commitId: 'future' }))
      .toEqual({ amount: '56.78' });
    await expect(decryptJson(removedSession, future,
      { ledgerId: ledger.ledgerId, commitId: 'future' })).rejects.toThrow(/缺少数据密钥/);
  }, 20_000);
});
