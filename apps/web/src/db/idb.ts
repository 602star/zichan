import {
  decryptBackupChunk,
  encryptBackupChunk,
  type LedgerCryptoSession,
} from '@zichan/core';
import {
  DeviceStorageResetRequiredError,
  isDeviceStorageResetRequiredError,
} from '../device-storage-error.js';

/** Minimal IndexedDB store for the encrypted sql.js database and attachment objects. */
const DB_NAME = 'zichan-web';
const STORE = 'kv';
const KEY = 'ledger.sqlite';

export interface EncryptedDatabaseSnapshot {
  format: 'zichan-encrypted-database';
  version: 1;
  storageId: string;
  keyringId: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Delete ledger-bound WebView/browser KV data such as form drafts and browser archives. */
export function deleteWebDatabase(): Promise<void> {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('浏览器存储仍被占用，请关闭其他本应用页面后重试'));
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

export async function loadDbBytes(session: LedgerCryptoSession): Promise<Uint8Array | null> {
  return decodeDatabaseStorageValue(session, await loadKv<unknown>(KEY));
}

export async function saveDbBytes(bytes: Uint8Array, session: LedgerCryptoSession): Promise<void> {
  await saveKv(KEY, await encryptDatabaseSnapshot(session, bytes));
}

export async function loadKv<T>(key: string): Promise<T | null> {
  const db = await openIdb();
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

export async function saveKv<T>(key: string, value: T): Promise<void> {
  const db = await openIdb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteKv(key: string): Promise<void> {
  const db = await openIdb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function hasKv(key: string): Promise<boolean> {
  const db = await openIdb();
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
export async function moveKv(sourceKey: string, targetKey: string): Promise<boolean> {
  const db = await openIdb();
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
