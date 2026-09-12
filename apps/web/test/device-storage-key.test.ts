import { describe, expect, it, vi } from 'vitest';
import { createLedgerKeyEnvelope, rotateLedgerProtection } from '@zichan/core';
import { adoptUnlockedLedgerKeyEnvelope, clearLedgerKey } from '../src/ledger-key-vault.js';
import { SchemaResetRequiredError } from '@zichan/db';
import {
  decryptDeviceAttachmentBlob,
  encryptDeviceAttachmentBlob,
  unlockDeviceStorage, lockDeviceStorage, stageDeviceStorageRewrap, clearDeviceStorageState,
} from '../src/device-storage-key.js';
import {
  DeviceStorageResetRequiredError,
  isDeviceStorageResetRequiredError,
} from '../src/device-storage-error.js';
import {
  decodeDatabaseStorageValue,
  decryptDatabaseSnapshot,
  encryptDatabaseSnapshot,
} from '../src/db/idb.js';
import { isInitializationResetRequiredError } from '../src/db/initialization-error.js';

async function sha256(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('device storage encryption', () => {
  it('opens another device cache with the new recovery code after a remote protection change', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    try {
      const original = await createLedgerKeyEnvelope('ledger-device-rotation', 'original-managed-secret');
      adoptUnlockedLedgerKeyEnvelope(original.envelope, original.session, true);
      const device = await unlockDeviceStorage('original-managed-secret', true);
      const encrypted = await encryptDatabaseSnapshot(device.cryptoSession, new TextEncoder().encode('local pending transaction'));
      await lockDeviceStorage();
      // No staged local rewrap: this key change happened on a different device.
      const next = await rotateLedgerProtection(original.session, 'new-private-recovery');
      adoptUnlockedLedgerKeyEnvelope(next.envelope, next.session, true);
      const restored = await unlockDeviceStorage('new-private-recovery', true);
      expect(new TextDecoder().decode(await decryptDatabaseSnapshot(restored.cryptoSession, encrypted))).toBe('local pending transaction');
    } finally { clearDeviceStorageState(); clearLedgerKey(); vi.unstubAllGlobals(); }
  });
  it('recovers a staged cache rewrap after an uncertain protection update without changing its data key', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    try {
      const original = await unlockDeviceStorage('old-managed-secret');
      const bytes = new TextEncoder().encode('unsynced local transaction');
      const encrypted = await encryptDatabaseSnapshot(original.cryptoSession, bytes);
      await stageDeviceStorageRewrap('new-private-secret');
      await lockDeviceStorage();
      const recovered = await unlockDeviceStorage('new-private-secret');
      expect(await decryptDatabaseSnapshot(recovered.cryptoSession, encrypted)).toEqual(bytes);
      await lockDeviceStorage();
      await expect(unlockDeviceStorage('old-managed-secret')).rejects.toThrow();
      expect([...values.values()].join('')).not.toContain('new-private-secret');
    } finally { clearDeviceStorageState(); vi.unstubAllGlobals(); }
  });
  it('encrypts browser database snapshots and rejects another device key', async () => {
    const left = await createLedgerKeyEnvelope('device-storage-left', 'correct horse battery staple');
    const right = await createLedgerKeyEnvelope('device-storage-right', 'correct horse battery staple');
    const plaintext = new TextEncoder().encode('SQLite format 3\0private ledger rows');
    const encrypted = await encryptDatabaseSnapshot(left.session, plaintext);

    expect(encrypted.ciphertext).not.toEqual(plaintext);
    expect(new TextDecoder().decode(encrypted.ciphertext)).not.toContain('private ledger rows');
    expect(await decryptDatabaseSnapshot(left.session, encrypted)).toEqual(plaintext);
    await expect(decryptDatabaseSnapshot(right.session, encrypted)).rejects.toThrow('不属于当前本机数据密钥');
  });

  it('classifies legacy browser data as reset-required without rewriting it', async () => {
    const storage = await createLedgerKeyEnvelope('device-storage-legacy', 'legacy storage password');
    const plaintext = new TextEncoder().encode('SQLite format 3\0legacy ledger rows');
    let caught: unknown;

    try {
      await decodeDatabaseStorageValue(storage.session, plaintext);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeviceStorageResetRequiredError);
    expect(isDeviceStorageResetRequiredError(caught)).toBe(true);
    expect(isInitializationResetRequiredError(caught)).toBe(true);
    expect(plaintext).toEqual(new TextEncoder().encode('SQLite format 3\0legacy ledger rows'));
    expect(isInitializationResetRequiredError(new SchemaResetRequiredError('legacy schema'))).toBe(true);
    expect(isInitializationResetRequiredError(new Error('temporary failure'))).toBe(false);
  });

  it('encrypts attachment content in independently authenticated chunks', async () => {
    const storage = await createLedgerKeyEnvelope('device-storage-attachment', 'attachment storage password');
    const plaintext = new Blob([
      new Uint8Array(1024 * 1024 + 17).fill(65),
      new TextEncoder().encode('private invoice body'),
    ], { type: 'application/pdf' });
    const hash = await sha256(plaintext);
    const encrypted = await encryptDeviceAttachmentBlob(storage.session, hash, plaintext);
    const encryptedBytes = new Uint8Array(await encrypted.arrayBuffer());

    expect(new TextDecoder().decode(encryptedBytes)).not.toContain('private invoice body');
    const restored = await decryptDeviceAttachmentBlob(storage.session, hash, encrypted, plaintext.type);
    expect(restored.type).toBe('application/pdf');
    expect(restored.size).toBe(plaintext.size);
    expect(await sha256(restored)).toBe(hash);

    encryptedBytes[encryptedBytes.length - 1] ^= 1;
    await expect(decryptDeviceAttachmentBlob(
      storage.session,
      hash,
      new Blob([encryptedBytes]),
      plaintext.type,
    )).rejects.toThrow();
  });
});
