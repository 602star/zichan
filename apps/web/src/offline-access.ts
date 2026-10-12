import { aesGcmDecrypt, aesGcmEncrypt, createLedgerKeyEnvelope, encryptJson, decryptJson, hasNativeSubtle, newId, secureRandomBytes, unlockLedgerKeyEnvelope, type LedgerKeyEnvelope, type Encrypted } from '@zichan/core';
import { accountLocalStorage, accountDatabaseName } from './account-storage.js';
import { accountProtection, unlockAccountProtection, type UnlockedProtection } from './account-protection.js';
import { unlockDeviceStorage } from './device-storage-key.js';
import type { SyncConnection } from './sync-config.js';

const OFFLINE_KEY = 'zichan.offline-access.v1';
const AAD = 'zichan-offline-access-v1';
interface OfflineRecord { envelope: LedgerKeyEnvelope; payload: Encrypted }
/**
 * Native records keep a non-extractable CryptoKey that JavaScript can never read
 * back. Plain HTTP withholds SubtleCrypto, so the fallback must persist raw key
 * bytes: that is strictly weaker (any script on this origin can read the key) and
 * is reached only when the deployment explicitly enabled plain-HTTP LAN access.
 */
type TrustedRecord =
  | { key: CryptoKey; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer; expiresAt: number }
  | { kind: 'raw'; key: Uint8Array; iv: Uint8Array; ciphertext: Uint8Array; expiresAt: number };

async function trustedStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`${accountDatabaseName()}:trusted-device`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('vault');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('vault', mode);
      const operation = action(transaction.objectStore('vault'));
      transaction.oncomplete = () => { db.close(); resolve(operation.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  });
}

export function hasOfflinePassword(): boolean { return !!accountLocalStorage.getItem(OFFLINE_KEY); }

export async function enableOfflinePassword(password: string): Promise<void> {
  const state = accountProtection();
  if (!state) throw new Error('请先在线解锁账号账本');
  if (password.length < 8) throw new Error('离线密码至少需要 8 个字符');
  const created = await createLedgerKeyEnvelope(newId(), password);
  const payload = await encryptJson(created.session, state, AAD);
  accountLocalStorage.setItem(OFFLINE_KEY, JSON.stringify({ envelope: created.envelope, payload }));
}

export async function rememberDevice(): Promise<void> {
  const state = accountProtection();
  if (!state) throw new Error('请先解锁账号账本');
  const aad = new TextEncoder().encode(accountDatabaseName());
  const plaintext = new TextEncoder().encode(JSON.stringify(state));
  const expiresAt = Date.now() + 7 * 86400_000;
  if (hasNativeSubtle()) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext);
    await trustedStore('readwrite', (store) => store.put({ key, iv, ciphertext, expiresAt } satisfies TrustedRecord, 'access'));
    return;
  }
  const key = secureRandomBytes(32);
  const iv = secureRandomBytes(12);
  const ciphertext = await aesGcmEncrypt(key, iv, plaintext, aad);
  await trustedStore('readwrite', (store) => store.put({ kind: 'raw', key, iv, ciphertext, expiresAt } satisfies TrustedRecord, 'access'));
}

export async function forgetOfflineAccess(): Promise<void> {
  accountLocalStorage.removeItem(OFFLINE_KEY);
  await trustedStore('readwrite', (store) => store.delete('access'));
}

async function restore(profile: SyncConnection, state: UnlockedProtection): Promise<void> {
  if (state.profileId !== profile.id || state.info.replica?.serverId !== profile.serverId) throw new Error('离线授权不属于当前账号');
  await unlockAccountProtection(profile, { ...state.info, secret: state.info.mode === 'managed' ? state.secret : null },
    state.secret, state.unlockEnvelope);
  await unlockDeviceStorage(state.secret, true);
}

export async function unlockOffline(profile: SyncConnection, password: string): Promise<void> {
  const record = JSON.parse(accountLocalStorage.getItem(OFFLINE_KEY) ?? 'null') as OfflineRecord | null;
  if (!record) throw new Error('此设备未设置离线密码，请联网登录');
  const session = await unlockLedgerKeyEnvelope(password, record.envelope);
  await restore(profile, await decryptJson<UnlockedProtection>(session, record.payload, AAD));
}

export async function unlockRememberedDevice(profile: SyncConnection): Promise<boolean> {
  const record = await trustedStore<TrustedRecord | undefined>('readonly', (store) => store.get('access'));
  if (!record) return false;
  if (record.expiresAt <= Date.now()) { await trustedStore('readwrite', (store) => store.delete('access')); return false; }
  const aad = new TextEncoder().encode(accountDatabaseName());
  const plaintext = 'kind' in record
    ? await aesGcmDecrypt(record.key, record.iv, record.ciphertext, aad)
    : new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad }, record.key, record.ciphertext));
  await restore(profile, JSON.parse(new TextDecoder().decode(plaintext)) as UnlockedProtection);
  return true;
}
