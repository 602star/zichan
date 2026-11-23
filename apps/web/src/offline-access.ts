import { aesGcmDecrypt, aesGcmEncrypt, createLedgerKeyEnvelope, encryptJson, decryptJson, hasNativeSubtle, newId, secureRandomBytes, unlockLedgerKeyEnvelope, type LedgerKeyEnvelope, type Encrypted, type LedgerCryptoSession } from '@zichan/core';
import { accountLocalStorage, accountDatabaseName, activateWebAccount, webLedgerNamespace } from './account-storage.js';
import { accountProtection, accountProtectionRevision, adoptAccountProtection, unlockAccountProtection, type UnlockedProtection } from './account-protection.js';
import { unlockDeviceStorage, requireDeviceStorageSession, adoptBrowserDeviceSession } from './device-storage-key.js';
import { requireLedgerCryptoSession } from './ledger-key-vault.js';
import type { SyncConnection } from './sync-config.js';
import { isTauriRuntime } from './tauri.js';

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

async function trustedStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>, databaseName = accountDatabaseName()): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`${databaseName}:trusted-device`, 1);
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
  if (password.length < 8) throw new Error('账号密码至少需要 8 个字符');
  const created = await createLedgerKeyEnvelope(newId(), password);
  const payload = await encryptJson(created.session, state, AAD);
  if (accountProtection() !== state) return;
  accountLocalStorage.setItem(OFFLINE_KEY, JSON.stringify({ envelope: created.envelope, payload }));
}

export async function rememberDevice(): Promise<void> {
  const state = accountProtection();
  if (!state) throw new Error('请先解锁账号账本');
  const databaseName = accountDatabaseName();
  const aad = new TextEncoder().encode(databaseName);
  const pack = (session: LedgerCryptoSession) => ({ ...session,
    dataKeys: [...session.dataKeys].map(([id, key]) => [id, Array.from(key)]),
    attachmentSecret: Array.from(session.attachmentSecret), backupSecret: Array.from(session.backupSecret),
    retiredAttachmentSecrets: session.retiredAttachmentSecrets?.map(key => Array.from(key)),
    retiredBackupSecrets: session.retiredBackupSecrets?.map(key => Array.from(key)),
  });
  const device = requireDeviceStorageSession();
  const plaintext = new TextEncoder().encode(JSON.stringify(isTauriRuntime() ? state : { version: 2, protection: state,
    ledger: pack(requireLedgerCryptoSession()), device: { ...device, cryptoSession: pack(device.cryptoSession) } }));
  const expiresAt = Date.now() + 7 * 86400_000;
  if (hasNativeSubtle()) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext);
    if (accountProtection() === state) await trustedStore('readwrite', (store) => accountProtection() === state
      ? store.put({ key, iv, ciphertext, expiresAt } satisfies TrustedRecord, 'access') : store.get('access'), databaseName);
    return;
  }
  const key = secureRandomBytes(32);
  const iv = secureRandomBytes(12);
  const ciphertext = await aesGcmEncrypt(key, iv, plaintext, aad);
  if (accountProtection() === state) await trustedStore('readwrite', (store) => accountProtection() === state
    ? store.put({ kind: 'raw', key, iv, ciphertext, expiresAt } satisfies TrustedRecord, 'access') : store.get('access'), databaseName);
}

export async function forgetOfflineAccess(): Promise<void> {
  accountLocalStorage.removeItem(OFFLINE_KEY);
  await trustedStore('readwrite', (store) => store.delete('access'));
}

async function restore(profile: SyncConnection, state: UnlockedProtection): Promise<void> {
  if (state.profileId !== profile.id || state.info.replica?.serverId !== profile.serverId) throw new Error('离线授权不属于当前账号');
  await unlockAccountProtection(profile, { ...state.info, secret: state.info.mode === 'managed' ? state.secret : null });
  await unlockDeviceStorage(state.secret, true);
}

export async function unlockOffline(profile: SyncConnection, password: string): Promise<void> {
  const record = JSON.parse(accountLocalStorage.getItem(OFFLINE_KEY) ?? 'null') as OfflineRecord | null;
  if (!record) throw new Error('此设备尚未准备离线访问，请联网登录');
  const session = await unlockLedgerKeyEnvelope(password, record.envelope);
  await restore(profile, await decryptJson<UnlockedProtection>(session, record.payload, AAD));
}

export async function unlockRememberedDevice(profile: SyncConnection): Promise<boolean> {
  if (accountProtection()?.profileId === profile.id) return true;
  const revision = accountProtectionRevision();
  const databaseName = isTauriRuntime() ? accountDatabaseName()
    : `${webLedgerNamespace(profile.serverId!, profile.accountId!, profile.replicaId)}database`;
  const record = await trustedStore<TrustedRecord | undefined>('readonly', (store) => store.get('access'), databaseName);
  if (!record) return false;
  if (record.expiresAt <= Date.now()) { await trustedStore('readwrite', (store) => store.delete('access'), databaseName); return false; }
  const aad = new TextEncoder().encode(databaseName);
  const plaintext = 'kind' in record
    ? await aesGcmDecrypt(record.key, record.iv, record.ciphertext, aad)
    : new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad }, record.key, record.ciphertext));
  if (revision !== accountProtectionRevision()) return false;
  const payload = JSON.parse(new TextDecoder().decode(plaintext));
  const state: UnlockedProtection = payload.version === 2 ? payload.protection : payload;
  if (state.profileId !== profile.id || !state.info.replica || state.info.replica.serverId !== profile.serverId
    || state.info.replica.replicaId !== profile.replicaId || state.info.replica.streamEpoch !== profile.streamEpoch) return false;
  if (!isTauriRuntime()) activateWebAccount(profile.serverId!, profile.accountId!, profile.replicaId);
  if (payload.version === 2) {
    const unpack = (session: Omit<LedgerCryptoSession, 'dataKeys' | 'attachmentSecret' | 'backupSecret' | 'retiredAttachmentSecrets' | 'retiredBackupSecrets'>
      & { dataKeys: [string, number[]][]; attachmentSecret: number[]; backupSecret: number[]; retiredAttachmentSecrets?: number[][]; retiredBackupSecrets?: number[][] }): LedgerCryptoSession => ({
      ...session, dataKeys: new Map(session.dataKeys.map(([id, values]) => [id, new Uint8Array(values)])),
      attachmentSecret: new Uint8Array(session.attachmentSecret), backupSecret: new Uint8Array(session.backupSecret),
      retiredAttachmentSecrets: session.retiredAttachmentSecrets?.map(key => new Uint8Array(key)),
      retiredBackupSecrets: session.retiredBackupSecrets?.map(key => new Uint8Array(key)),
    });
    adoptAccountProtection(profile, { ...state.info, secret: state.secret }, unpack(payload.ledger));
    adoptBrowserDeviceSession({ ...payload.device, cryptoSession: unpack(payload.device.cryptoSession) });
  } else await restore(profile, state);
  return true;
}
