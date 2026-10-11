import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeBlobPack, encodeBlobPack } from '../src/blob-pack.js';

function entry(id: string, byte: number) {
  const chunk = Buffer.alloc(64, byte);
  return { manifest: { v: 2 as const, blobId: id.repeat(64), cipherBytes: chunk.byteLength,
    chunkCount: 1, chunks: [{ index: 0, sizeBytes: chunk.byteLength,
      ciphertextSha256: createHash('sha256').update(chunk).digest('hex'),
      iv: 'AAAAAAAAAAAAAAAA' }] }, chunk };
}

describe('encrypted attachment pack', () => {
  it('round-trips bounded raw ciphertext without re-encoding its bytes', () => {
    const entries = [entry('a', 1), entry('b', 2)];
    const pack = encodeBlobPack(entries);
    expect(decodeBlobPack(pack)).toEqual(entries);
  });

  it('rejects duplicates, truncation, trailing data and oversized objects', () => {
    const first = entry('a', 1);
    expect(() => encodeBlobPack([first, first])).toThrow();
    const pack = encodeBlobPack([first]);
    expect(() => decodeBlobPack(pack.subarray(0, pack.byteLength - 1))).toThrow();
    expect(() => decodeBlobPack(Buffer.concat([pack, Buffer.from([0])]))).toThrow();
    const tampered = Buffer.from(pack);
    tampered[tampered.byteLength - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(() => decodeBlobPack(tampered)).toThrow('hash mismatch');
    const tooLarge = entry('b', 2);
    tooLarge.chunk = Buffer.alloc(256 * 1024 + 1, 2);
    tooLarge.manifest.cipherBytes = tooLarge.chunk.byteLength;
    tooLarge.manifest.chunks[0]!.sizeBytes = tooLarge.chunk.byteLength;
    expect(() => encodeBlobPack([tooLarge])).toThrow();
  });
});
