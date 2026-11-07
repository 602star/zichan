import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  attachmentRemoteBlobId,
  createLedgerCryptoSession,
  decryptAttachmentChunk,
  deriveAttachmentCryptoContext,
  encryptAttachmentChunk,
  normalizeSyncUsername,
  sha256Bytes,
  unlockLedgerKeyEnvelope,
  type Attachment,
  type LedgerCryptoSession,
} from '@zichan/core';
import { httpCommitTransport, loginAccount, registerAccount, syncReplica } from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import { LedgerPreviewRegistry } from '../src/ledger-preview.js';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { loadCustodyKey } from '../src/key-custody.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

/**
 * Attachment download from an administrator preview.
 *
 * The ledger backup carries attachment *metadata* but never the bytes, so this path is the only way
 * an operator can open a user's file. What makes it worth testing at this level is that the server
 * has to *reconstruct* the object id the user's device derived — and it has only its own records to
 * do it with.
 *
 * So the fixture does not fake the blob store. It uploads through the real `/api/v3/blobs` routes
 * into the server's own encrypted store, exactly as a real device does. A test that derived both
 * sides with its own helper would prove only that the helper is self-consistent; this one proves the
 * real upload path and the preview agree on the same id.
 */

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const PASSWORD = 'attachment-pw-0001';
const FILE_NAME = '发票.pdf';

/**
 * Upload one encrypted attachment the way a device does: derive the object id from the username the
 * account is known by, build the manifest, then use the blob routes.
 */
async function uploadAttachment(
  url: string,
  token: string,
  crypto: LedgerCryptoSession,
  serverId: string,
  username: string,
  sha256: string,
  plaintext: Uint8Array,
): Promise<string> {
  const context = await deriveAttachmentCryptoContext(crypto, {
    serverId,
    ledgerId: crypto.ledgerId,
    username,
  });
  const blobId = await attachmentRemoteBlobId(context, sha256);
  const midpoint = Math.ceil(plaintext.byteLength / 2);
  const chunks = await Promise.all([plaintext.slice(0, midpoint), plaintext.slice(midpoint)].map(
    (part, index) => encryptAttachmentChunk(context, sha256, part, index, 2, plaintext.byteLength),
  ));
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const begun = await fetch(`${url}/api/v3/blobs/uploads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      manifest: {
        v: 1,
        blobId,
        cipherBytes: chunks.reduce((sum, chunk) => sum + chunk.ciphertext.byteLength, 0),
        chunkCount: chunks.length,
        chunks: chunks.map((chunk) => ({
          index: chunk.index, sizeBytes: chunk.ciphertext.byteLength,
          ciphertextSha256: chunk.ciphertextSha256, iv: chunk.iv,
        })),
      },
    }),
  });
  expect(begun.status).toBe(201);
  const plan = (await begun.json()) as { uploadId: string; missingChunks: number[] };

  for (const encrypted of chunks) {
    const put = await fetch(`${url}/api/v3/blobs/uploads/${plan.uploadId}/chunks/${encrypted.index}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
      body: encrypted.ciphertext,
    });
    expect(put.status).toBe(200);
  }

  const done = await fetch(`${url}/api/v3/blobs/uploads/${plan.uploadId}/complete`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  expect(done.status).toBe(200);
  return blobId;
}

/**
 * A managed-custody account holding one attachment, whose encrypted body is on the server.
 *
 * `deriveAs` separates the two usernames that can differ: the one a device would derive from (what
 * `/auth/me` reports, i.e. the stored form) and the account the server knows. Passing them
 * differently reproduces the case mismatch this feature has to survive.
 */
async function fixture(options: { typed?: string; deriveAs?: string; storedAs?: string } = {}) {
  const typed = options.typed ?? 'attach-user';
  const dataDir = mkdtempSync(join(tmpdir(), 'zichan-preview-att-'));
  const custodyKeyPath = join(dataDir, 'custody.key');
  const server = createTestSyncServer({
    dataDir,
    custodyKeyPath,
    custodyEnabled: true,
    accountProtection: 'managed',
  });
  await server.ready;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

  // The first account claims ownership, which needs the deployment setup secret.
  await registerAccount(url, typed, PASSWORD, { ownerSetupToken: OWNER_SETUP_TOKEN });
  if (options.storedAs) {
    const db = new DatabaseSync(join(dataDir, 'server.sqlite'));
    db.prepare('UPDATE sync_users SET username = ? WHERE username = ?').run(options.storedAs, typed);
    db.close();
  }
  const account = await loginAccount(url, typed, PASSWORD, {
    deviceId: 'attachment-device',
    deviceName: 'Attachment',
  });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${account.accessToken}` };

  const init = await fetch(`${url}/api/v3/protection/initialize`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'managed' }),
  });
  expect(init.status).toBe(200);
  const protection = (await init.json()) as {
    secret: string;
    envelope: { ledgerId: string } & Record<string, unknown>;
  };
  const crypto = await unlockLedgerKeyEnvelope(protection.secret, protection.envelope as never);

  const plaintext = new TextEncoder().encode('PREVIEW-ATTACHMENT-BODY-77');
  const sha256 = await sha256Bytes(plaintext);
  // The stored spelling, which is what a device learns from the login session and derives from.
  const storedUsername = account.session.username;
  // The device derives from the username it holds; `/auth/me` gave it the stored spelling.
  const blobId = await uploadAttachment(
    url,
    account.accessToken,
    crypto,
    server.serverId,
    options.deriveAs ?? storedUsername,
    sha256,
    plaintext,
  );

  const author = await openLedger({ deviceId: 'ATTACHMENT-AUTHOR' });
  await author.adoptLedgerId(protection.envelope.ledgerId);
  // An attachment must reference a real entity, so the ledger gets an asset and a transaction for
  // the file to hang on — the same shape a real ledger has.
  await author.assets.put({
    id: 'CNY', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, isActive: true,
  } as never);
  await author.transactions.put({
    id: 'transaction-1', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    date: '2026-09-01', type: 'expense', category: 'food', amount: '42.50', assetId: 'CNY',
  } as never);
  await author.attachments.put({
    id: 'attachment-1',
    createdAt: '',
    updatedAt: '',
    version: 1,
    isDeleted: false,
    entityType: 'transaction',
    entityId: 'transaction-1',
    fileName: FILE_NAME,
    mimeType: 'application/pdf',
    sizeBytes: plaintext.byteLength,
    sha256,
  } as Attachment);

  const bound = await fetch(`${url}/api/v3/replica/bind`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ledgerId: protection.envelope.ledgerId }),
  });
  expect(bound.status).toBe(200);

  await syncReplica(
    author,
    httpCommitTransport({
      baseUrl: url,
      token: account.accessToken,
      cryptoSession: crypto,
      keyEnvelope: protection.envelope as never,
    }),
    url,
  );
  await author.close();

  const store = new SyncServerStore(join(dataDir, 'server.sqlite'), 'open', server.serverId);
  // The server keeps its own blob store open, so a second handle on the same directory is used for
  // reading — the same pattern the blob-store restart test uses. Every test closes it.
  const blobs = new EncryptedBlobStore({ dataDir });
  await blobs.ready;
  const registry = new LedgerPreviewRegistry({
    store,
    custodyKey: loadCustodyKey(custodyKeyPath, true),
    serverId: server.serverId,
    readManifest: ({ username, ledgerId, blobId }) => blobs.manifest(username, ledgerId, blobId),
    readChunk: ({ username, ledgerId, blobId, index }) => blobs.chunk(username, ledgerId, blobId, index),
  });

  return {
    server,
    registry,
    store,
    blobs,
    sha256,
    plaintext,
    blobId,
    storedUsername,
    headers,
    url,
    close: async () => {
      await blobs.close();
      await server.close();
    },
  };
}

describe('preview attachment download', () => {
  it('derives the same object id the device uploaded under, and returns the exact bytes', async () => {
    const f = await fixture();
    try {
      const preview = await f.registry.open(f.storedUsername, 'operator');
      expect(preview.attachmentCount).toBe(1);

      const opened = await f.registry.decryptAttachment(preview.id, f.sha256);
      expect(opened).toBeDefined();
      expect(opened!.file.fileName).toBe(FILE_NAME);
      expect(opened!.file.mimeType).toBe('application/pdf');
      // Byte-for-byte, and the checksum the ledger recorded is what proves it.
      expect(Array.from(opened!.file.bytes)).toEqual(Array.from(f.plaintext));
      expect(await sha256Bytes(opened!.file.bytes)).toBe(f.sha256);
    } finally {
      await f.close();
    }
  }, 480_000);

  it('finds the body when the account was registered with a different case than the server stores', async () => {
    // The hazard, end to end: registration lowercases, so a person who types `Alice` gets an account
    // named `alice`, and `/auth/me` hands that back — so the device derives from `alice` and the
    // server reconstructs `alice`. They agree. This test pins that agreement against the real upload
    // path rather than against a helper both sides share.
    const f = await fixture({ typed: 'Alice' });
    try {
      expect(f.storedUsername).toBe('alice');
      const preview = await f.registry.open('alice', 'operator');
      expect(preview.username).toBe('alice');

      const opened = await f.registry.decryptAttachment(preview.id, f.sha256);
      expect(opened).toBeDefined();
      expect(await sha256Bytes(opened!.file.bytes)).toBe(f.sha256);
    } finally {
      await f.close();
    }
  }, 480_000);

  it.each(['Alice', 'alice'])('downloads with stored Alice and AAD %s through real HTTP', async (deriveAs) => {
    const f = await fixture({ typed: 'Alice', storedAs: 'Alice', deriveAs });
    try {
      expect(f.storedUsername).toBe('Alice');
      const opened = await fetch(`${f.url}/api/admin/users/alice/preview`, {
        method: 'POST', headers: f.headers, body: JSON.stringify({ reason: '核对附件' }),
      });
      expect(opened.status).toBe(201);
      const { previewId } = await opened.json() as { previewId: string };
      const download = await fetch(`${f.url}/api/admin/previews/${previewId}/attachments/${f.sha256}`, { headers: f.headers });
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toContain(`filename*=UTF-8''${encodeURIComponent(FILE_NAME)}`);
      expect(download.headers.get('cache-control')).toBe('no-store');
      expect(download.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(f.plaintext);
      const logs = await f.store.listLogs({ limit: 100 });
      expect(JSON.stringify(logs)).toContain('ledger_preview_attachment_read');
    } finally { await f.close(); }
  }, 480_000);

  it('preserves an original AAD spelling supplied when opening the preview', async () => {
    const f = await fixture({ typed: 'Alice', deriveAs: 'Alice' });
    try {
      const preview = await f.registry.open('Alice', 'operator');
      expect(preview.username).toBe('alice');
      expect(f.registry.find('ALICE')?.id).toBe(preview.id);
      const opened = await f.registry.decryptAttachment(preview.id, f.sha256);
      expect(new Uint8Array(opened!.file.bytes)).toEqual(f.plaintext);
    } finally { await f.close(); }
  }, 480_000);

  it('reports a file the ledger does not contain rather than an expired preview', async () => {
    const f = await fixture();
    try {
      const preview = await f.registry.open(f.storedUsername, 'operator');
      // A checksum the ledger never recorded is a different answer from "your preview ended": one
      // means reopen, the other means this file is not there.
      await expect(f.registry.decryptAttachment(preview.id, 'f'.repeat(64)))
        .rejects.toThrow(/账本里没有该附件/);
    } finally {
      await f.close();
    }
  }, 480_000);

  it('refuses a body the server does not hold, and says so', async () => {
    const f = await fixture();
    try {
      const preview = await f.registry.open(f.storedUsername, 'operator');
      // Remove the stored object, as a store that never received the upload would look.
      expect(await f.blobs.remove(f.storedUsername, preview.ledgerId, f.blobId)).toBe(true);
      await expect(f.registry.decryptAttachment(preview.id, f.sha256))
        .rejects.toThrow(/没有这份附件的正文/);
    } finally {
      await f.close();
    }
  }, 480_000);

  it('drops decrypted files when the preview closes', async () => {
    const f = await fixture();
    try {
      const preview = await f.registry.open(f.storedUsername, 'operator');
      await f.registry.decryptAttachment(preview.id, f.sha256);
      expect(preview.attachments.size).toBe(1);

      f.registry.close(preview.id);
      // Closing is the operator saying "I am done": the plaintext must not outlive that, and the
      // session lookup must stop answering at all.
      expect(preview.attachments.size).toBe(0);
      expect(await f.registry.decryptAttachment(preview.id, f.sha256)).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 480_000);

  it('rejects corrupt ciphertext without caching it', async () => {
    const f = await fixture();
    try {
      const preview = await f.registry.open(f.storedUsername, 'operator');
      vi.spyOn(f.blobs, 'chunk').mockResolvedValue(new Uint8Array([1, 2, 3]));
      await expect(f.registry.decryptAttachment(preview.id, f.sha256)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' });
      expect(preview.attachments.size).toBe(0);
    } finally { await f.close(); }
  }, 480_000);

  it('does not return or cache plaintext if the preview closes during download', async () => {
    const f = await fixture();
    try {
      const preview = await f.registry.open(f.storedUsername, 'operator');
      const read = f.blobs.chunk.bind(f.blobs);
      vi.spyOn(f.blobs, 'chunk').mockImplementation(async (...args) => {
        f.registry.close(preview.id);
        return read(...args);
      });
      expect(await f.registry.decryptAttachment(preview.id, f.sha256)).toBeUndefined();
      expect(preview.attachments.size).toBe(0);
    } finally { await f.close(); }
  }, 480_000);

  it('answers an unknown preview id as gone, not as a missing file', async () => {
    const f = await fixture();
    try {
      expect(await f.registry.decryptAttachment('preview-nope', f.sha256)).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 480_000);

  it('rejects a malformed checksum before touching any storage', async () => {
    const f = await fixture();
    try {
      const preview = await f.registry.open(f.storedUsername, 'operator');
      await expect(f.registry.decryptAttachment(preview.id, 'not-a-hash'))
        .rejects.toThrow(/附件校验和无效/);
    } finally {
      await f.close();
    }
  }, 480_000);
});

/** Guards the assumptions this file depends on, so a change upstream fails loudly here. */
describe('attachment crypto assumptions', () => {
  it('derives different object ids for different username spellings', async () => {
    const session = createLedgerCryptoSession('ledger-case-check-1');
    const upper = await deriveAttachmentCryptoContext(session, { serverId: 'srv', ledgerId: session.ledgerId, username: 'Alice' });
    const lower = await deriveAttachmentCryptoContext(session, { serverId: 'srv', ledgerId: session.ledgerId, username: 'alice' });
    const hash = 'a'.repeat(64);
    // Not a case-insensitive match: the ids differ, which is why a spelling mismatch is a miss and
    // never a wrong file. If this ever became equal, the limitation test above would be moot.
    expect(await attachmentRemoteBlobId(upper, hash)).not.toBe(await attachmentRemoteBlobId(lower, hash));
    // Registration lowercases, which is why the stored form is the only one derivable server-side.
    expect(normalizeSyncUsername('Alice')).toBe('alice');
  });

  it('accepts the ciphertext the preview later decrypts', async () => {
    // A round trip through the same helpers the fixture uses, so a change in the chunk AAD shows up
    // here rather than as an unexplained failure in the download tests.
    const session = createLedgerCryptoSession('ledger-round-trip-1');
    const hash = 'b'.repeat(64);
    const context = await deriveAttachmentCryptoContext(session, { serverId: 'srv', ledgerId: session.ledgerId, username: 'alice' });
    const plaintext = new TextEncoder().encode('round trip');
    const encrypted = await encryptAttachmentChunk(context, hash, plaintext, 0, 1, plaintext.byteLength);
    expect(await decryptAttachmentChunk(context, hash, encrypted, 1, plaintext.byteLength)).toEqual(plaintext);
  });
});
