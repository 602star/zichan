/**
 * Shared attachment fixtures: a real object directory plus its catalog row, so a scan reads
 * actual files instead of a stubbed store.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeSqliteDriver } from '@zichan/db/node';

export function objectNamespace(username: string, ledgerId: string): string {
  return createHash('sha256').update(`${username}\0${ledgerId}`).digest('hex');
}

export function objectDirectory(dataDir: string, namespace: string, blobId: string): string {
  return join(dataDir, 'blobs', 'objects', namespace, blobId.slice(0, 2), blobId);
}

export function writeObjectTree(dataDir: string, username: string, ledgerId: string, blobId: string, contents: Buffer): void {
  const directory = objectDirectory(dataDir, objectNamespace(username, ledgerId), blobId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '0.chunk'), contents);
  writeFileSync(join(directory, 'object.json'), JSON.stringify({
    username,
    ledgerId,
    blobId,
    state: 'available',
    createdAt: new Date().toISOString(),
    manifest: {
      v: 1,
      blobId,
      cipherBytes: contents.byteLength,
      chunkCount: 1,
      chunks: [{ index: 0, sizeBytes: contents.byteLength, ciphertextSha256: createHash('sha256').update(contents).digest('hex'), iv: 'AAECAwQFBgcICQoL' }],
    },
  }));
}

/** Inserts catalog rows directly so a scan has many objects without HTTP round trips. */
export async function seedObjects(dataDir: string, username: string, ledgerId: string, count: number, withFiles: boolean): Promise<string[]> {
  const driver = new NodeSqliteDriver(join(dataDir, 'server.sqlite'));
  const namespace = objectNamespace(username, ledgerId);
  const blobIds: string[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const blobId = createHash('sha256').update(`seeded-${index}`).digest('hex');
      blobIds.push(blobId);
      const contents = Buffer.alloc(32, index % 251);
      const manifest = {
        v: 1,
        blobId,
        cipherBytes: contents.byteLength,
        chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: contents.byteLength, ciphertextSha256: createHash('sha256').update(contents).digest('hex'), iv: 'AAECAwQFBgcICQoL' }],
      };
      if (withFiles) writeObjectTree(dataDir, username, ledgerId, blobId, contents);
      await driver.run(
        `INSERT OR REPLACE INTO blob_objects
         (username, ledger_id, blob_id, namespace, state, cipher_bytes, chunk_count, manifest_json, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, 'available', ?, 1, ?, ?, ?, NULL)`,
        [username, ledgerId, blobId, namespace, contents.byteLength, JSON.stringify(manifest), new Date().toISOString(), new Date().toISOString()],
      );
      // Yield periodically: synchronous file writes for a large seed would otherwise block the
      // event loop long enough to leave the HTTP keep-alive timers and the caller racing.
      if ((index + 1) % 200 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally { await driver.close(); }
  return blobIds;
}
