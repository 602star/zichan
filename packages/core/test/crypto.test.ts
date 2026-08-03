import { describe, it, expect } from 'vitest';
import {
  changeLedgerPassphrase,
  createLedgerCryptoSession,
  createLedgerKeyEnvelope,
  decryptJson,
  encryptJson,
  rotateLedgerDataKey,
  unlockLedgerKeyEnvelope,
} from '../src/index.js';

describe('crypto (E2E envelope)', () => {
  const context = { ledgerId: 'ledger-current', commitId: 'commit-current', contentHash: 'a'.repeat(64) };
  const session = () => createLedgerCryptoSession('ledger-current-123456');

  it('round-trips a JSON value', async () => {
    const data = { hello: 'world', n: 42, list: [1, 2, 3], zh: '中文' };
    const unlocked = session();
    const enc = await encryptJson(unlocked, data, context);
    expect(enc.v).toBe(3);
    expect(enc.ct).not.toContain('world'); // ciphertext, not plaintext
    const back = await decryptJson(unlocked, enc, context);
    expect(back).toEqual(data);
  });

  it('keeps the session keyring behind an Argon2id password envelope', async () => {
    const created = await createLedgerKeyEnvelope('ledger-current-123456', 'right-password');
    await expect(unlockLedgerKeyEnvelope('wrong-password', created.envelope)).rejects.toBeTruthy();
    const unlocked = await unlockLedgerKeyEnvelope('right-password', created.envelope);
    expect(unlocked.keyringId).toBe(created.session.keyringId);
  });

  it('rejects untrusted Argon2 parameters before allocating excessive memory', async () => {
    const created = await createLedgerKeyEnvelope('ledger-current-123456', 'right-password');
    await expect(unlockLedgerKeyEnvelope('right-password', {
      ...created.envelope,
      memoryKiB: 1024 * 1024,
    })).rejects.toThrow('超出安全范围');
  });

  it('fails when authenticated routing metadata is changed', async () => {
    const unlocked = session();
    const enc = await encryptJson(unlocked, { secret: 1 }, context);
    await expect(decryptJson(unlocked, enc, { ...context, commitId: 'other-commit' })).rejects.toBeTruthy();
  });

  it('produces different ciphertext each time with a random IV', async () => {
    const unlocked = session();
    const a = await encryptJson(unlocked, { x: 1 }, context);
    const b = await encryptJson(unlocked, { x: 1 }, context);
    expect(a.ct).not.toBe(b.ct);
    expect(a.iv).not.toBe(b.iv);
  });

  it('keeps old data readable across passphrase changes and data-key rotation', async () => {
    const unlocked = session();
    const old = await encryptJson(unlocked, { a: 1 }, context);
    const changed = await changeLedgerPassphrase(unlocked, 'new-password');
    expect(await decryptJson(changed.session, old, context)).toEqual({ a: 1 });
    const rotated = await rotateLedgerDataKey(changed.session, 'new-password');
    expect(rotated.session.activeKeyId).not.toBe(unlocked.activeKeyId);
    expect(await decryptJson(rotated.session, old, context)).toEqual({ a: 1 });
    const enc = await encryptJson(rotated.session, { a: 1 }, context);
    expect(enc.ct).not.toContain('new-password');
  });
});
