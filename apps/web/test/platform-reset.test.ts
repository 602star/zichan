import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { LedgerCryptoSession, LedgerKeyEnvelope } from '@zichan/core';
import {
  clearCredentialVaultRuntimeState,
  runtimeCredentialMap,
  setRuntimeCredential,
} from '../src/credential-vault.js';
import {
  clearDeviceStorageState,
  DEVICE_STORAGE_ENVELOPE_KEY,
  requireDeviceStorageSession,
  unlockDeviceStorage,
} from '../src/device-storage-key.js';
import {
  adoptUnlockedLedgerKeyEnvelope,
  clearLedgerKey,
  ledgerKeyState,
  LEDGER_KEY_ENVELOPE_KEY,
} from '../src/ledger-key-vault.js';
import {
  AUTO_SYNC_KEY,
  clearSyncConfiguration,
  loadAutoSync,
  loadSessionCredentials,
  loadSyncConnections,
  saveAutoSync,
  saveSessionCredentials,
  saveSyncConnections,
  SESSION_CREDENTIALS_KEY,
  SYNC_CONNECTIONS_KEY,
} from '../src/sync-config.js';
import {
  clearCloudIdentity,
  CLOUD_DEVICE_ID_KEY,
  CLOUD_DEVICES_KEY,
} from '../src/db/cloud.js';
import { resetPlatformData } from '../src/db/platform-driver.js';
import { openIdb } from '../src/db/idb.js';
import { clearSafetyState, SAFETY_STATE_KEY } from '../src/db/safety.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

interface DeleteRequestStub {
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
}

const ledgerEnvelope: LedgerKeyEnvelope = {
  v: 1,
  ledgerId: 'ledger-old',
  keyringId: 'keyring-old',
  generation: 1,
  kdf: 'argon2id',
  salt: 'salt',
  iv: 'iv',
  ct: 'ciphertext',
};

const ledgerSession: LedgerCryptoSession = {
  v: 1,
  ledgerId: 'ledger-old',
  keyringId: 'keyring-old',
  generation: 1,
  activeKeyId: 'key-old',
  dataKeys: new Map([['key-old', new Uint8Array(32)]]),
  attachmentSecret: new Uint8Array(32),
  backupSecret: new Uint8Array(32),
};

function seedLedgerBoundState(): void {
  adoptUnlockedLedgerKeyEnvelope(ledgerEnvelope, ledgerSession, true);
  saveSyncConnections([{
    id: 'server-old',
    serverRef: 'server-old',
    alias: '旧服务器',
    baseUrl: 'https://sync.example.test',
    activeUrl: 'https://sync.example.test',
    alternateUrls: [],
    sharedUrls: ['https://sync.example.test'],
    deviceUrls: [],
    username: 'old-user',
    enabled: true,
    status: 'online',
    ledgerId: 'ledger-old',
  }]);
  saveAutoSync({ enabled: true, minutes: 15 });
  const credential = { password: 'old-password', inviteCode: '', accessToken: 'old-token' };
  saveSessionCredentials({ 'server-old': credential });
  setRuntimeCredential('server-old', credential);
  localStorage.setItem(DEVICE_STORAGE_ENVELOPE_KEY, 'old-device-envelope');
  localStorage.setItem(CLOUD_DEVICE_ID_KEY, 'device-old');
  localStorage.setItem(CLOUD_DEVICES_KEY, '[{"deviceId":"device-old"}]');
  localStorage.setItem(SAFETY_STATE_KEY, '{"lastCheckAt":"2026-01-01T00:00:00.000Z"}');
}

function expectLedgerBoundStateCleared(): void {
  expect(ledgerKeyState()).toMatchObject({ initialized: false, unlocked: false });
  expect(localStorage.getItem(LEDGER_KEY_ENVELOPE_KEY)).toBeNull();
  expect(localStorage.getItem(DEVICE_STORAGE_ENVELOPE_KEY)).toBeNull();
  expect(localStorage.getItem(SYNC_CONNECTIONS_KEY)).toBeNull();
  expect(localStorage.getItem(AUTO_SYNC_KEY)).toBeNull();
  expect(sessionStorage.getItem(SESSION_CREDENTIALS_KEY)).toBeNull();
  expect(loadSyncConnections()).toHaveLength(1);
  expect(loadSyncConnections()[0]).toMatchObject({ enabled: false, status: 'unchecked' });
  expect(loadSyncConnections()[0]?.ledgerId).toBeUndefined();
  expect(loadAutoSync()).toEqual({ enabled: false, minutes: 5 });
  expect(loadSessionCredentials()).toEqual({});
  expect(runtimeCredentialMap()).toEqual({});
  expect(localStorage.getItem(CLOUD_DEVICE_ID_KEY)).toBeNull();
  expect(localStorage.getItem(CLOUD_DEVICES_KEY)).toBeNull();
  expect(localStorage.getItem(SAFETY_STATE_KEY)).toBeNull();
}

function installTauriMock(failVaultReset = false): string[] {
  const calls: string[] = [];
  const request: DeleteRequestStub = { error: null, onsuccess: null, onerror: null, onblocked: null };
  (globalThis as unknown as { indexedDB: { deleteDatabase(name: string): DeleteRequestStub } }).indexedDB = {
    deleteDatabase(name) {
      expect(name).toBe('zichan-web');
      calls.push(`indexeddb:${name}`);
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  const invoke = async <T>(command: string): Promise<T> => {
    calls.push(command);
    if (command === 'native_sql_database_url') return 'sqlite:D:/portable/data/ledger/ledger.sqlite' as T;
    if (command === 'native_reset_security_vault' && failVaultReset) throw new Error('vault reset failed');
    return undefined as T;
  };
  (globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: { invoke } };
  return calls;
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage();
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = new MemoryStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearDeviceStorageState();
  clearLedgerKey();
  clearSyncConfiguration();
  clearCredentialVaultRuntimeState();
  clearCloudIdentity();
  clearSafetyState();
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
});

describe('resetPlatformData', () => {
  it('waits for a blocked IndexedDB deletion before clearing ledger credentials', async () => {
    vi.stubGlobal('navigator', { locks: { async request(_name: string, _options: unknown, callback: (lock: object) => Promise<void>) { await callback({}); } } });
    vi.stubGlobal('indexedDB', new IDBFactory());
    const blocker = await openIdb();
    blocker.onversionchange = () => undefined;
    seedLedgerBoundState();
    let completed = false;
    const reset = resetPlatformData().then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toBe(false);
    expect(ledgerKeyState()).toMatchObject({ initialized: true, unlocked: true });
    blocker.close();
    await reset;
    expectLedgerBoundStateCleared();
  });

  it('does not recreate the ledger database when releasing a fallback lease after reset', async () => {
    vi.stubGlobal('navigator', {});
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const db = await openIdb();
    db.close();
    seedLedgerBoundState();
    await resetPlatformData();
    expect((await factory.databases()).some((entry) => entry.name === 'zichan-web')).toBe(false);
  });

  it('clears browser database keys, sync configuration, identities and safety state', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        async request(_name: string, _options: unknown, callback: (lock: object) => Promise<void>) {
          await callback({});
        },
      },
    });
    const request: DeleteRequestStub = { error: null, onsuccess: null, onerror: null, onblocked: null };
    (globalThis as unknown as { indexedDB: { deleteDatabase(name: string): DeleteRequestStub } }).indexedDB = {
      deleteDatabase(name) {
        expect(name).toBe('zichan-web');
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    };
    await unlockDeviceStorage('browser-password');
    seedLedgerBoundState();

    await resetPlatformData();

    expect(() => requireDeviceStorageSession()).toThrow('请先解锁');
    expectLedgerBoundStateCleared();
  });

  it('clears the same ledger-bound state after native data and Stronghold reset', async () => {
    const calls = installTauriMock();
    seedLedgerBoundState();

    await resetPlatformData();

    expect(calls).toEqual([
      'native_sql_database_url',
      'native_sql_close',
      'native_sql_delete_database',
      'native_attachment_clear',
      'native_reset_security_vault',
      'indexeddb:zichan-web',
    ]);
    expectLedgerBoundStateCleared();
  });

  it('reports a native security-vault reset failure and does not pretend cleanup completed', async () => {
    installTauriMock(true);
    seedLedgerBoundState();

    await expect(resetPlatformData()).rejects.toThrow('vault reset failed');

    expect(ledgerKeyState()).toMatchObject({ initialized: true, unlocked: true, ledgerId: 'ledger-old' });
    expect(localStorage.getItem(SYNC_CONNECTIONS_KEY)).not.toBeNull();
    expect(localStorage.getItem(CLOUD_DEVICE_ID_KEY)).toBe('device-old');
    expect(localStorage.getItem(SAFETY_STATE_KEY)).not.toBeNull();
  });
});
