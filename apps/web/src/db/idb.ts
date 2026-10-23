import { accountDatabaseName } from '../account-storage.js';
import {
  decryptBackupChunk,
  encryptBackupChunk,
  type LedgerCryptoSession,
} from '@zichan/core';
import {
  DeviceStorageResetRequiredError,
  isDeviceStorageResetRequiredError,
} from '../device-storage-error.js';
import { BrowserLedgerAlreadyOpenError } from './browser-ledger-error.js';

/** Minimal IndexedDB store for the encrypted sql.js database and attachment objects. */

const STORE = 'kv';
export const LEDGER_LEASE_STORE = 'lease';
export const BACKUP_ARCHIVE_STORE = 'backup-archives';
const KEY = 'ledger.sqlite';
const DATABASE_VERSION = 3;

export interface LedgerSnapshotLease {
  recordKey: string;
  owner: string;
  version: number;
  leaseMs: number;
}

export interface EncryptedDatabaseSnapshot {
  format: 'zichan-encrypted-database';
  version: 1;
  storageId: string;
  keyringId: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export function openIdb(databaseName = accountDatabaseName()): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(databaseName, DATABASE_VERSION);
    let blocked = false;
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      if (!req.result.objectStoreNames.contains(LEDGER_LEASE_STORE)) req.result.createObjectStore(LEDGER_LEASE_STORE);
      if (!req.result.objectStoreNames.contains(BACKUP_ARCHIVE_STORE)) req.result.createObjectStore(BACKUP_ARCHIVE_STORE);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      if (blocked) req.result.close();
      else resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      blocked = true;
      reject(new Error('浏览器存储升级被其他页面占用，请关闭其他本应用页面后重试'));
    };
  });
}

/** Delete ledger-bound WebView/browser KV data such as form drafts and browser archives. */
export function deleteWebDatabase(databaseName = accountDatabaseName()): Promise<void> {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    // A blocked deletion is still pending. Rejecting here lets reset clear its
    // other state while IndexedDB may delete the database much later.
    request.onblocked = () => undefined;
  });
}

function databaseContext(session: LedgerCryptoSession): Record<string, unknown> {
  return {
    purpose: 'zichan-browser-database',
    version: 1,
    storageId: session.ledgerId,
    keyringId: session.keyringId,
  };
}

function validEncryptedDatabaseSnapshot(value: unknown): value is EncryptedDatabaseSnapshot {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<EncryptedDatabaseSnapshot>;
  return row.format === 'zichan-encrypted-database'
    && row.version === 1
    && typeof row.storageId === 'string'
    && typeof row.keyringId === 'string'
    && row.iv instanceof Uint8Array && row.iv.length === 12
    && row.ciphertext instanceof Uint8Array && row.ciphertext.length >= 16;
}

export async function encryptDatabaseSnapshot(
  session: LedgerCryptoSession,
  bytes: Uint8Array,
): Promise<EncryptedDatabaseSnapshot> {
  const encrypted = await encryptBackupChunk(session, bytes, databaseContext(session));
  return {
    format: 'zichan-encrypted-database',
    version: 1,
    storageId: session.ledgerId,
    keyringId: session.keyringId,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
  };
}

export async function decryptDatabaseSnapshot(
  session: LedgerCryptoSession,
  snapshot: EncryptedDatabaseSnapshot,
): Promise<Uint8Array> {
  if (snapshot.storageId !== session.ledgerId || snapshot.keyringId !== session.keyringId) {
    throw new DeviceStorageResetRequiredError('浏览器数据库不属于当前本机数据密钥，请重置本机开发数据后重新导入备份');
  }
  return decryptBackupChunk(session, {
    v: 1,
    iv: snapshot.iv,
    ciphertext: snapshot.ciphertext,
  }, databaseContext(session));
}

export async function decodeDatabaseStorageValue(
  session: LedgerCryptoSession,
  stored: unknown,
): Promise<Uint8Array | null> {
  if (stored == null) return null;
  if (!validEncryptedDatabaseSnapshot(stored)) {
    throw new DeviceStorageResetRequiredError('发现未加密的旧版浏览器数据库，请重置本机开发数据后重新导入备份');
  }
  try {
    return await decryptDatabaseSnapshot(session, stored);
  } catch (error) {
    if (isDeviceStorageResetRequiredError(error)) throw error;
    throw new DeviceStorageResetRequiredError('浏览器加密数据库无法解密或已损坏，请重置本机开发数据后重新导入备份');
  }
}

export async function loadDbBytes(session: LedgerCryptoSession, databaseName = accountDatabaseName()): Promise<Uint8Array | null> {
  return decodeDatabaseStorageValue(session, await loadKv<unknown>(KEY, databaseName));
}

export async function saveDbBytes(
  bytes: Uint8Array,
  session: LedgerCryptoSession,
  databaseName = accountDatabaseName(),
  lease?: LedgerSnapshotLease | null,
): Promise<void> {
  const snapshot = await encryptDatabaseSnapshot(session, bytes);
  if (!lease) {
    await saveKv(KEY, snapshot, databaseName);
    return;
  }
  const db = await openIdb(databaseName);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([LEDGER_LEASE_STORE, STORE], 'readwrite');
      const leaseStore = tx.objectStore(LEDGER_LEASE_STORE);
      const snapshotStore = tx.objectStore(STORE);
      const read = leaseStore.get(lease.recordKey);
      let lostLease = false;
      let writeError: unknown;
      read.onsuccess = () => {
        const current = read.result as { owner?: string; version?: number; heartbeat?: number } | undefined;
        if (current?.owner !== lease.owner || current.version !== lease.version
          || typeof current.heartbeat !== 'number' || current.heartbeat + lease.leaseMs <= Date.now()) {
          lostLease = true;
          tx.abort();
          return;
        }
        try { snapshotStore.put(snapshot, KEY); }
        catch (error) { writeError = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(lostLease
        ? new BrowserLedgerAlreadyOpenError('账本租约已失效，请重新打开账本')
        : writeError ?? tx.error ?? new Error('IndexedDB snapshot write aborted'));
    });
  } finally {
    db.close();
  }
}

export async function loadKv<T>(key: string, databaseName = accountDatabaseName()): Promise<T | null> {
  const db = await openIdb(databaseName);
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveKv<T>(key: string, value: T, databaseName = accountDatabaseName()): Promise<void> {
  const db = await openIdb(databaseName);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
    });
  } finally {
    db.close();
  }
}

export async function deleteKv(key: string, databaseName = accountDatabaseName()): Promise<void> {
  const db = await openIdb(databaseName);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB delete aborted'));
    });
  } finally {
    db.close();
  }
}

export async function hasKv(key: string, databaseName = accountDatabaseName()): Promise<boolean> {
  const db = await openIdb(databaseName);
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count(key);
      req.onsuccess = () => resolve(req.result > 0);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Move a value inside one IndexedDB transaction. Existing immutable targets win. */
export async function moveKv(sourceKey: string, targetKey: string, databaseName = accountDatabaseName()): Promise<boolean> {
  const db = await openIdb(databaseName);
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let moved = false;
      const source = store.get(sourceKey);
      source.onerror = () => reject(source.error);
      source.onsuccess = () => {
        if (source.result === undefined) return;
        const target = store.get(targetKey);
        target.onerror = () => reject(target.error);
        target.onsuccess = () => {
          if (target.result === undefined) store.put(source.result, targetKey);
          store.delete(sourceKey);
          moved = true;
        };
      };
      tx.oncomplete = () => resolve(moved);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB move aborted'));
    });
  } finally {
    db.close();
  }
}
