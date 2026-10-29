import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentRemoteBlobId, deriveAttachmentCryptoContext, newId,
  rotateLedgerProtection, type LedgerCryptoSession, type LedgerKeyEnvelope } from '@zichan/core';
import { httpCommitTransport, loginAccount, registerAccount } from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import type { SyncServer } from '../../sync-server/src/server.js';
import { createTestSyncServer as createSyncServer, OWNER_SETUP_TOKEN } from '../../sync-server/test/support/server-fixture.js';
import { ensureAttachmentBlobAvailable, syncAttachmentBatch, syncAttachmentReplicas } from '../src/attachment-sync.js';
import { runtimeCredential, setRuntimeCredential } from '../src/credential-vault.js';
import {
  attachmentStorageStatus,
  commitPreparedAttachment,
  finalizePreparedAttachment,
  prepareAttachmentDraft,
  readAttachmentBlob,
  reconcileAttachmentStorage,
} from '../src/db/attachment-storage.js';
import { saveSyncConnections, type SyncConnection } from '../src/sync-config.js';
import { initializeLedgerKey, requireLedgerCryptoSession, storedLedgerKeyEnvelope, adoptUnlockedLedgerKeyEnvelope } from '../src/ledger-key-vault.js';
import { lockDeviceStorage, unlockDeviceStorage } from '../src/device-storage-key.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function installAttachmentMock() {
  const files = new Map<string, number[]>();
  const key = (area: string, value: string) => `${area}:${value}`;
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const tempKey = String(args?.['tempKey'] ?? '');
    const sha256 = String(args?.['sha256'] ?? '');
    const area = String(args?.['area'] ?? 'objects');
    if (command === 'native_attachment_storage_status') {
      return { directory: 'memory', availableBytes: Number.MAX_SAFE_INTEGER } as T;
    }
    if (command === 'native_attachment_stage_begin') {
      files.set(key('staging', tempKey), []);
      return { path: tempKey, sizeBytes: 0 } as T;
    }
    if (command === 'native_attachment_stage_append') {
      const current = files.get(key('staging', tempKey));
      if (!current) throw new Error('missing staged fixture file');
      const next = current.concat(args?.['chunk'] as number[]);
      files.set(key('staging', tempKey), next);
      return { path: tempKey, sizeBytes: next.length } as T;
    }
    if (command === 'native_attachment_stage_commit' || command === 'native_attachment_stage_status') {
      const value = files.get(key('staging', tempKey));
      if (value === undefined) throw new Error('missing staged fixture file');
      return { path: tempKey, sizeBytes: value.length } as T;
    }
    if (command === 'native_attachment_stage_read_range') {
      const value = files.get(key('staging', tempKey));
      if (value === undefined) throw new Error('missing staged fixture file');
      const offset = Number(args?.['offset'] ?? 0);
      return value.slice(offset, offset + Number(args?.['length'] ?? 0)) as T;
    }
    if (command === 'native_attachment_stage_discard') {
      files.delete(key('staging', tempKey));
      return undefined as T;
    }
    if (command === 'native_attachment_promote') {
      const staged = files.get(key('staging', tempKey));
      if (!files.has(key('objects', sha256)) && staged === undefined) throw new Error('missing staged fixture file');
      if (staged !== undefined) files.set(key('objects', sha256), staged);
      files.delete(key('staging', tempKey));
      return { path: sha256, sizeBytes: staged?.length ?? 0 } as T;
    }
    if (command === 'native_attachment_status') {
      const value = files.get(key(area, sha256));
      if (value === undefined) throw new Error('missing fixture file');
      return { path: sha256, sizeBytes: value.length } as T;
    }
    if (command === 'native_attachment_read_range') {
      const value = files.get(key(area, sha256));
      if (value === undefined) throw new Error('missing fixture file');
      const offset = Number(args?.['offset'] ?? 0);
      return value.slice(offset, offset + Number(args?.['length'] ?? 0)) as T;
    }
    if (command === 'native_attachment_exists') return files.has(key(area, sha256)) as T;
    if (command === 'native_attachment_trash') {
      const value = files.get(key('objects', sha256));
      if (value !== undefined) files.set(key('trash', sha256), value);
      files.delete(key('objects', sha256));
      return undefined as T;
    }
    if (command === 'native_attachment_restore') {
      const value = files.get(key('trash', sha256));
      if (value !== undefined) files.set(key('objects', sha256), value);
      files.delete(key('trash', sha256));
      return undefined as T;
    }
    if (command === 'native_attachment_purge') {
      for (const name of ['objects', 'trash', 'quarantine']) files.delete(key(name, sha256));
      return undefined as T;
    }
    return undefined as T;
  };
  (globalThis as unknown as { window: unknown }).window = {
    crypto: globalThis.crypto,
    __TAURI_INTERNALS__: { invoke },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
  return files;
}

async function listen(server: SyncServer): Promise<string> {
  await new Promise<void>((resolve) => server.server.listen(0, resolve));
  return `http://localhost:${(server.server.address() as AddressInfo).port}`;
}

function filesUnder(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(path));
    else result.push(path);
  }
  return result;
}

function profile(id: string, alias: string, url: string, username: string): SyncConnection {
  return {
    id,
    serverRef: id,
    alias,
    baseUrl: url,
    activeUrl: url,
    alternateUrls: [],
    sharedUrls: [],
    deviceUrls: [url],
    username,
    enabled: true,
    status: 'online',
  };
}

async function bind(
  profileRow: SyncConnection,
  password: string,
  ledgerId: string,
  cryptoSession: LedgerCryptoSession,
  keyEnvelope: LedgerKeyEnvelope,
) {
  const baseUrl = profileRow.baseUrl;
  const healthResponse = await fetch(`${baseUrl}/api/health`, { redirect: 'error' });
  expect(healthResponse.ok).toBe(true);
  const health = await healthResponse.json() as { serverId: string; serverPublicKey: string };
  profileRow.serverId = health.serverId;
  profileRow.serverPublicKey = health.serverPublicKey;
  await registerAccount(baseUrl, profileRow.username, password, {
    ownerSetupToken: OWNER_SETUP_TOKEN,
    expectedServerId: health.serverId,
    expectedServerPublicKey: health.serverPublicKey,
  });
  const session = await loginAccount(baseUrl, profileRow.username, password, {
    deviceId: `device-${profileRow.id}`,
    deviceName: `Attachment ${profileRow.alias}`,
    expectedServerId: health.serverId,
    expectedServerPublicKey: health.serverPublicKey,
  });
  setRuntimeCredential(profileRow.id, {
    password,
    inviteCode: '',
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessExpiresAt: session.accessExpiresAt,
    sessionId: session.session.id,
  }, false);
  return httpCommitTransport({ baseUrl, token: session.accessToken, cryptoSession, keyEnvelope }).connect(ledgerId);
}

beforeEach(async () => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage();
  await unlockDeviceStorage('device-storage-test-password');
});

afterEach(async () => {
  await lockDeviceStorage();
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
});

describe('attachment replica sync', () => {
  it('keeps automatic transfers bounded across a V2 attachment sweep', async () => {
    installAttachmentMock();
    const dataDir = mkdtempSync(join(tmpdir(), 'zichan-attachment-batch-'));
    const server = createSyncServer({ dataDir });
    const url = await listen(server);
    const store = await openLedger({ deviceId: 'attachment-batch-test' });
    try {
      const ledgerId = await store.getLedgerId();
      const owner = await store.assets.put({ id: newId(), code: 'DOC', name: '附件批次', type: 'fixed',
        decimals: 2, isActive: true, createdAt: '', updatedAt: '', version: 1, isDeleted: false });
      await initializeLedgerKey(ledgerId, 'attachment-ledger-passphrase');
      const cryptoSession = requireLedgerCryptoSession(ledgerId);
      const connection = profile('batch-profile', '批次服务器', url, 'batch-owner');
      const identity = await bind(connection, 'batch-owner-password', ledgerId,
        cryptoSession, storedLedgerKeyEnvelope()!);
      Object.assign(connection, identity);
      const attachments = [];
      for (let index = 0; index < 9; index += 1) {
        const prepared = await prepareAttachmentDraft(store, newId(), { fileName: `附件-${index}.txt`,
          mimeType: 'text/plain', contentBlob: new Blob([`batch attachment ${index}`], { type: 'text/plain' }) });
        attachments.push(await store.transaction((tx) => commitPreparedAttachment(tx, prepared, 'asset', owner.id)));
        await finalizePreparedAttachment(store, prepared);
      }
      const deferred = await syncAttachmentReplicas(store, [{ profile: connection, identity }], false, true);
      expect(deferred.endpoints[0]).toMatchObject({ uploaded: 0, pending: 9 });
      const first = await syncAttachmentBatch(store, { profile: connection, identity });
      expect(first).toMatchObject({ scanned: 8, failed: 0, sweepComplete: false });
      const second = await syncAttachmentBatch(store, { profile: connection, identity });
      expect(second).toMatchObject({ scanned: 1, failed: 0, sweepComplete: true });
      expect(first.uploaded + second.uploaded).toBe(9);
      const portableContext = await deriveAttachmentCryptoContext(cryptoSession, { v: 2, ledgerId });
      const portableIds = await Promise.all(attachments.map((attachment) =>
        attachmentRemoteBlobId(portableContext, attachment.sha256)));
      const status = await fetch(`${url}/api/v3/blobs/status`, { method: 'POST',
        headers: { Authorization: `Bearer ${runtimeCredential(connection.id).accessToken}`,
          'Content-Type': 'application/json' }, body: JSON.stringify({ blobIds: portableIds }) });
      const states = (await status.json() as { objects: Record<string, string> }).objects;
      expect(portableIds.every((id) => states[id] === 'available')).toBe(true);
    } finally {
      await store.close();
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('encrypts portable replica objects, resumes missing content, relays, and soft-deletes remote copies', async () => {
    const files = installAttachmentMock();
    const firstDataDir = mkdtempSync(join(tmpdir(), 'zichan-attachment-server-a-'));
    const secondDataDir = mkdtempSync(join(tmpdir(), 'zichan-attachment-server-b-'));
    const thirdDataDir = mkdtempSync(join(tmpdir(), 'zichan-attachment-server-c-'));
    const firstServer = createSyncServer({ dataDir: firstDataDir });
    const secondServer = createSyncServer({ dataDir: secondDataDir });
    const thirdServer = createSyncServer({ dataDir: thirdDataDir });
    const firstUrl = await listen(firstServer);
    const secondUrl = await listen(secondServer);
    const thirdUrl = await listen(thirdServer);
    const store = await openLedger({ deviceId: 'attachment-replica-test' });
    try {
      const ledgerId = await store.getLedgerId();
      const attachmentOwner = await store.assets.put({
        id: newId(), code: 'DOC', name: '附件归档', type: 'fixed', decimals: 2, isActive: true,
        createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      });
      await initializeLedgerKey(ledgerId, 'attachment-ledger-passphrase');
      const cryptoSession = requireLedgerCryptoSession(ledgerId);
      const keyEnvelope = storedLedgerKeyEnvelope()!;
      const firstProfile = profile('profile-a', '服务器 A', firstUrl, 'alice-a');
      const secondProfile = profile('profile-b', '服务器 B', secondUrl, 'alice-b');
      const thirdProfile = profile('profile-c', '服务器 C', thirdUrl, 'alice-c');
      const firstIdentity = await bind(firstProfile, 'password-for-a', ledgerId, cryptoSession, keyEnvelope);
      const secondIdentity = await bind(secondProfile, 'different-password-for-b', ledgerId, cryptoSession, keyEnvelope);
      const thirdIdentity = await bind(thirdProfile, 'third-password', ledgerId, cryptoSession, keyEnvelope);
      Object.assign(firstProfile, firstIdentity);
      Object.assign(secondProfile, secondIdentity);
      Object.assign(thirdProfile, thirdIdentity);
      saveSyncConnections([firstProfile, secondProfile, thirdProfile]);

      const attachmentId = newId();
      const prepared = await prepareAttachmentDraft(store, attachmentId, {
        fileName: '跨设备发票.txt',
        mimeType: 'text/plain',
        contentBlob: new Blob(['cross-device attachment body'], { type: 'text/plain' }),
      });
      const attachment = await store.transaction((transaction) => commitPreparedAttachment(transaction, prepared, 'asset', attachmentOwner.id));
      await finalizePreparedAttachment(store, prepared);

      const uploaded = await syncAttachmentReplicas(store, [
        { profile: firstProfile, identity: firstIdentity },
        { profile: secondProfile, identity: secondIdentity },
      ]);
      expect(uploaded.endpoints.map((row) => row.uploaded)).toEqual([1, 1]);
      const replicas = await store.attachmentState.listReplicaBlobs();
      expect(replicas).toHaveLength(2);
      expect(new Set(replicas.map((row) => row.remoteBlobId)).size).toBe(1);
      const plaintext = Buffer.from('cross-device attachment body');
      expect(filesUnder(firstDataDir).some((path) => readFileSync(path).includes(plaintext))).toBe(false);
      expect(filesUnder(secondDataDir).some((path) => readFileSync(path).includes(plaintext))).toBe(false);

      // Existing remote objects must remain retrievable after revoking a custodian;
      // relaying to a new server must use the new attachment secret.
      const rotated = await rotateLedgerProtection(cryptoSession, 'new-private-recovery-code');
      adoptUnlockedLedgerKeyEnvelope(rotated.envelope, rotated.session, true);

      files.delete(`objects:${attachment.sha256}`);
      await reconcileAttachmentStorage(store);
      expect(await attachmentStorageStatus(attachment.sha256)).toBe('missing');
      const relayed = await syncAttachmentReplicas(store, [
        { profile: firstProfile, identity: firstIdentity },
        { profile: thirdProfile, identity: thirdIdentity },
      ]);
      expect(relayed.endpoints.find((row) => row.profileId === firstProfile.id)?.downloaded).toBe(1);
      expect(relayed.endpoints.find((row) => row.profileId === thirdProfile.id)?.uploaded).toBe(1);

      files.delete(`objects:${attachment.sha256}`);
      await reconcileAttachmentStorage(store);
      const alreadyReplicated = await syncAttachmentReplicas(store, [
        { profile: firstProfile, identity: firstIdentity },
        { profile: thirdProfile, identity: thirdIdentity },
      ]);
      expect(alreadyReplicated.endpoints.every((row) => row.downloaded === 0)).toBe(true);
      expect(await attachmentStorageStatus(attachment.sha256)).toBe('missing');
      await ensureAttachmentBlobAvailable(store, {
        sha256: attachment.sha256,
        sizeBytes: attachment.sizeBytes,
        mimeType: attachment.mimeType || 'application/octet-stream',
      });
      expect(await (await readAttachmentBlob(attachment.sha256, attachment.mimeType)).text()).toBe('cross-device attachment body');

      await store.attachments.remove(attachment.id, attachment.version);
      await reconcileAttachmentStorage(store);
      const removed = await syncAttachmentReplicas(store, [
        { profile: firstProfile, identity: firstIdentity },
        { profile: secondProfile, identity: secondIdentity },
        { profile: thirdProfile, identity: thirdIdentity },
      ]);
      expect(removed.endpoints.map((row) => row.deleted)).toEqual([1, 1, 1]);
      expect((await store.attachmentState.listReplicaBlobs()).every((row) => row.state === 'trash')).toBe(true);
    } finally {
      await store.close();
      await firstServer.close();
      await secondServer.close();
      await thirdServer.close();
      rmSync(firstDataDir, { recursive: true, force: true });
      rmSync(secondDataDir, { recursive: true, force: true });
      rmSync(thirdDataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
