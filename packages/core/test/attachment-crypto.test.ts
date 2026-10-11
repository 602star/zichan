import { describe, expect, it } from 'vitest';
import {
  attachmentRemoteBlobId,
  createLedgerCryptoSession,
  decryptAttachmentChunk,
  deriveAttachmentCryptoContext,
  encryptAttachmentChunk,
} from '../src/crypto.js';

describe('attachment chunk encryption', () => {
  it('uses opaque server-scoped IDs and authenticated independent chunks', async () => {
    const hash = 'a'.repeat(64);
    const session = createLedgerCryptoSession('ledger-1234567890');
    const left = await deriveAttachmentCryptoContext(session, { serverId: 'srv-a', ledgerId: session.ledgerId, username: 'alice' });
    const right = await deriveAttachmentCryptoContext(session, { serverId: 'srv-b', ledgerId: session.ledgerId, username: 'alice' });
    const portableA = await deriveAttachmentCryptoContext(session, { v: 2, ledgerId: session.ledgerId });
    const portableB = await deriveAttachmentCryptoContext(session, { v: 2, ledgerId: session.ledgerId });
    expect(await attachmentRemoteBlobId(left, hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(await attachmentRemoteBlobId(left, hash)).not.toBe(hash);
    expect(await attachmentRemoteBlobId(left, hash)).not.toBe(await attachmentRemoteBlobId(right, hash));
    expect(await attachmentRemoteBlobId(portableA, hash)).toBe(await attachmentRemoteBlobId(portableB, hash));
    expect(await attachmentRemoteBlobId(portableA, hash)).not.toBe(await attachmentRemoteBlobId(left, hash));

    const plaintext = new TextEncoder().encode('encrypted attachment chunk');
    const encrypted = await encryptAttachmentChunk(left, hash, plaintext, 0, 1, plaintext.byteLength);
    const resumed = await encryptAttachmentChunk(left, hash, plaintext, 0, 1, plaintext.byteLength);
    expect(encrypted.ciphertext).not.toEqual(plaintext);
    expect(resumed.iv).toBe(encrypted.iv);
    expect(resumed.ciphertextSha256).toBe(encrypted.ciphertextSha256);
    expect(resumed.ciphertext).toEqual(encrypted.ciphertext);
    await expect(decryptAttachmentChunk(left, hash, encrypted, 1, plaintext.byteLength))
      .resolves.toEqual(plaintext);

    const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.slice() };
    tampered.ciphertext[0] ^= 1;
    await expect(decryptAttachmentChunk(left, hash, tampered, 1, plaintext.byteLength))
      .rejects.toThrow(/checksum/);
    await expect(decryptAttachmentChunk(right, hash, encrypted, 1, plaintext.byteLength))
      .rejects.toThrow();
  });
});
