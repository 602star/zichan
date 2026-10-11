import { createHash } from 'node:crypto';
import type { BlobManifest } from './blob-store.js';

export const MAX_BLOB_PACK_BYTES = 8 * 1024 * 1024;
export const MAX_BLOB_PACK_OBJECTS = 20;
export const MAX_BLOB_PACK_CHUNK_BYTES = 256 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;

export interface BlobPackEntry {
  manifest: BlobManifest;
  chunk: Uint8Array;
}

function validEntry(manifest: BlobManifest, chunkBytes: number): boolean {
  return Boolean(manifest) && Array.isArray(manifest.chunks)
    && manifest.v === 2 && manifest.chunkCount === 1 && manifest.chunks.length === 1
    && manifest.chunks[0]?.index === 0 && Number.isSafeInteger(chunkBytes)
    && chunkBytes >= 16 && chunkBytes <= MAX_BLOB_PACK_CHUNK_BYTES
    && manifest.chunks[0]?.sizeBytes === chunkBytes && manifest.cipherBytes === chunkBytes
    && /^[a-f0-9]{64}$/.test(manifest.blobId);
}

/** A bounded JSON manifest header followed by raw, already encrypted chunks. */
export function encodeBlobPack(entries: readonly BlobPackEntry[]): Uint8Array {
  if (!entries.length || entries.length > MAX_BLOB_PACK_OBJECTS
    || new Set(entries.map((entry) => entry.manifest.blobId)).size !== entries.length
    || entries.some((entry) => !validEntry(entry.manifest, entry.chunk.byteLength))) {
    throw new Error('invalid encrypted attachment pack');
  }
  const header = Buffer.from(JSON.stringify({ v: 1, manifests: entries.map((entry) => entry.manifest) }));
  const size = 4 + header.byteLength + entries.reduce((sum, entry) => sum + entry.chunk.byteLength, 0);
  if (header.byteLength > MAX_HEADER_BYTES || size > MAX_BLOB_PACK_BYTES) {
    throw new Error('encrypted attachment pack exceeds size limit');
  }
  const pack = Buffer.allocUnsafe(size);
  pack.writeUInt32BE(header.byteLength, 0);
  header.copy(pack, 4);
  let offset = 4 + header.byteLength;
  for (const entry of entries) {
    pack.set(entry.chunk, offset);
    offset += entry.chunk.byteLength;
  }
  return pack;
}

export function decodeBlobPack(input: Uint8Array): BlobPackEntry[] {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < 4 || bytes.byteLength > MAX_BLOB_PACK_BYTES) throw new Error('invalid encrypted attachment pack size');
  const headerBytes = bytes.readUInt32BE(0);
  if (headerBytes < 2 || headerBytes > MAX_HEADER_BYTES || 4 + headerBytes > bytes.byteLength) {
    throw new Error('invalid encrypted attachment pack header');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.subarray(4, 4 + headerBytes).toString('utf8')); }
  catch { throw new Error('invalid encrypted attachment pack header'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid encrypted attachment pack header');
  const header = parsed as { v?: unknown; manifests?: unknown };
  if (header.v !== 1 || !Array.isArray(header.manifests)
    || !header.manifests.length || header.manifests.length > MAX_BLOB_PACK_OBJECTS) {
    throw new Error('invalid encrypted attachment pack header');
  }
  const entries: BlobPackEntry[] = [];
  const ids = new Set<string>();
  let offset = 4 + headerBytes;
  for (const value of header.manifests) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid encrypted attachment pack manifest');
    const manifest = value as BlobManifest;
    const chunkBytes = Number(manifest.chunks?.[0]?.sizeBytes);
    if (!validEntry(manifest, chunkBytes) || ids.has(manifest.blobId)
      || offset + chunkBytes > bytes.byteLength) throw new Error('invalid encrypted attachment pack manifest');
    ids.add(manifest.blobId);
    const chunk = bytes.subarray(offset, offset + chunkBytes);
    if (createHash('sha256').update(chunk).digest('hex') !== manifest.chunks[0]!.ciphertextSha256) {
      throw new Error('encrypted attachment pack chunk hash mismatch');
    }
    entries.push({ manifest, chunk });
    offset += chunkBytes;
  }
  if (offset !== bytes.byteLength) throw new Error('encrypted attachment pack has trailing bytes');
  return entries;
}
