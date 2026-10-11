import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  accountSigningPublicKey, applyLedgerControlEvent, ledgerControlEventHash,
  signLedgerControlEvent, type LedgerControlPayload,
} from '../src/ledger-control.js';

const ledgerId = 'ledger-control-00000001';
const owner = { issuerNodeId: 'issuer-node-001', accountId: 'account-owner-001' };
const other = { issuerNodeId: 'issuer-node-001', accountId: 'account-other-001' };
const ownerPrivate = randomBytes(32);
const otherPrivate = randomBytes(32);
const encPublic = (key: Uint8Array) => Buffer.from(x25519.getPublicKey(key)).toString('base64');
const ownerKey = accountSigningPublicKey(ownerPrivate);
const otherKey = accountSigningPublicKey(otherPrivate);

function genesis(): LedgerControlPayload {
  return { v: 1, ledgerId, seq: 1, previousHash: null, keyEpoch: 1,
    kind: 'MemberGenesis', actor: owner, target: owner, role: 'OWNER',
    signingPublicKey: ownerKey, encryptionPublicKey: encPublic(ownerPrivate) };
}

describe('signed ledger member control', () => {
  it('pins the genesis owner, verifies a linear event chain, and advances the key epoch on removal', () => {
    const first = signLedgerControlEvent(ownerPrivate, genesis());
    const initial = applyLedgerControlEvent(undefined, first, { ...owner, signingPublicKey: ownerKey });
    expect(initial).toMatchObject({ seq: 1, keyEpoch: 1, headHash: ledgerControlEventHash(first) });
    const added = signLedgerControlEvent(ownerPrivate, { v: 1, ledgerId, seq: 2,
      previousHash: initial.headHash, keyEpoch: 1, kind: 'MemberAdded', actor: owner, target: other,
      role: 'EDITOR', signingPublicKey: otherKey, encryptionPublicKey: encPublic(otherPrivate) });
    const withEditor = applyLedgerControlEvent(initial, added);
    expect(withEditor.members[`${other.issuerNodeId}/${other.accountId}`]).toMatchObject({ role: 'EDITOR', removed: false });
    const roleChanged = signLedgerControlEvent(ownerPrivate, { v: 1, ledgerId, seq: 3,
      previousHash: withEditor.headHash, keyEpoch: 1, kind: 'MemberRoleChanged', actor: owner,
      target: other, role: 'VIEWER' });
    const withViewer = applyLedgerControlEvent(withEditor, roleChanged);
    expect(withViewer.members[`${other.issuerNodeId}/${other.accountId}`]?.role).toBe('VIEWER');
    const removed = signLedgerControlEvent(ownerPrivate, { v: 1, ledgerId, seq: 4,
      previousHash: withViewer.headHash, keyEpoch: 2, kind: 'MemberRemoved', actor: owner, target: other });
    const afterRemoval = applyLedgerControlEvent(withViewer, removed);
    expect(afterRemoval.keyEpoch).toBe(2);
    expect(afterRemoval.members[`${other.issuerNodeId}/${other.accountId}`]?.removed).toBe(true);
    expect(() => applyLedgerControlEvent(afterRemoval, removed)).toThrow('不连续');
  });

  it('rejects forged, forked, stale and unauthorized changes', () => {
    const first = signLedgerControlEvent(ownerPrivate, genesis());
    expect(() => applyLedgerControlEvent(undefined, first, { ...other, signingPublicKey: ownerKey })).toThrow('受信任身份');
    const initial = applyLedgerControlEvent(undefined, first, { ...owner, signingPublicKey: ownerKey });
    const addPayload: LedgerControlPayload = { v: 1, ledgerId, seq: 2, previousHash: initial.headHash,
      keyEpoch: 1, kind: 'MemberAdded', actor: owner, target: other, role: 'EDITOR',
      signingPublicKey: otherKey, encryptionPublicKey: encPublic(otherPrivate) };
    const forged = signLedgerControlEvent(otherPrivate, addPayload);
    expect(() => applyLedgerControlEvent(initial, forged)).toThrow('签名');
    const valid = signLedgerControlEvent(ownerPrivate, addPayload);
    expect(() => applyLedgerControlEvent(initial, { ...valid, role: 'VIEWER' })).toThrow('签名');
    const withEditor = applyLedgerControlEvent(initial, valid);
    const stale = signLedgerControlEvent(ownerPrivate, { v: 1, ledgerId, seq: 3,
      previousHash: withEditor.headHash, kind: 'MemberRemoved', keyEpoch: 1,
      actor: owner, target: other });
    expect(() => applyLedgerControlEvent(withEditor, stale)).toThrow('代次');
    const unauthorized = signLedgerControlEvent(otherPrivate, { v: 1, ledgerId, seq: 3,
      previousHash: withEditor.headHash, keyEpoch: 1, kind: 'MemberRoleChanged', actor: other,
      target: owner, role: 'VIEWER' });
    expect(() => applyLedgerControlEvent(withEditor, unauthorized)).toThrow('仅账本所有者');
    const lastOwner = signLedgerControlEvent(ownerPrivate, { v: 1, ledgerId, seq: 3,
      previousHash: withEditor.headHash, keyEpoch: 2, kind: 'MemberRemoved', actor: owner, target: owner });
    expect(() => applyLedgerControlEvent(withEditor, lastOwner)).toThrow('保留所有者');
  });

  it('signs a reviewed rejected-commit decision without changing membership', () => {
    const first = signLedgerControlEvent(ownerPrivate, genesis());
    const initial = applyLedgerControlEvent(undefined, first, { ...owner, signingPublicKey: ownerKey });
    const decision = signLedgerControlEvent(ownerPrivate, { v: 1, ledgerId, seq: 2,
      previousHash: initial.headHash, keyEpoch: 1, kind: 'RejectedCommitResolved',
      actor: owner, target: owner, rejectedCommitId: 'commit-old-00000001',
      rejectedContentHash: 'a'.repeat(64), decision: 'replay',
      replacementCommitId: 'commit-new-00000001', replacementContentHash: 'b'.repeat(64) });
    const applied = applyLedgerControlEvent(initial, decision);
    expect(applied.members).toEqual(initial.members);
    expect(applied.keyEpoch).toBe(1);
    expect(() => applyLedgerControlEvent(initial, { ...decision,
      replacementContentHash: 'c'.repeat(64) })).toThrow('签名');
    expect(() => signLedgerControlEvent(ownerPrivate, { v: 1, ledgerId, seq: 2,
      previousHash: initial.headHash, keyEpoch: 1, kind: 'RejectedCommitResolved',
      actor: owner, target: other, rejectedCommitId: 'commit-old-00000001',
      rejectedContentHash: 'a'.repeat(64), decision: 'discard' })).toThrow('处置字段');
  });
});
