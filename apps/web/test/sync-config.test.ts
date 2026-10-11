import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSyncBaseUrl,
  buildSyncUrlFromParts,
  hasSavedSyncConnection,
  isUnauthorizedSyncError,
  loadAutoSync,
  loadSyncConnections,
  mergeSyncUrlScopes,
  newSyncConnection,
  normalizeSyncPath,
  saveAutoSync,
  saveSyncConnections,
  syncAddressPresetUrl,
} from '../src/sync-config.js';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

describe('sync configuration', () => {
  beforeEach(() => Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() }));
  afterEach(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });

  it('round-trips Chinese aliases, canonical URLs and split shared/device state', () => {
    const profile = {
      ...newSyncConnection('https://ledger.example.com:9443/family-ledger/'),
      alias: '家里电脑',
      username: 'owner',
      enabled: true,
      nodePublicKey: 'trusted-node-signing-key',
    };
    saveSyncConnections([profile]);
    const loaded = loadSyncConnections()[0]!;
    expect(loaded).toMatchObject({
      alias: '家里电脑',
      baseUrl: 'https://ledger.example.com:9443/family-ledger',
      activeUrl: 'https://ledger.example.com:9443/family-ledger',
      sharedUrls: ['https://ledger.example.com:9443/family-ledger'],
      deviceUrls: [],
      enabled: true,
      nodePublicKey: 'trusted-node-signing-key',
      status: 'unchecked',
    });
    expect(buildSyncBaseUrl(loaded)).toBe('https://ledger.example.com:9443/family-ledger');
    expect(normalizeSyncPath('/')).toBe('');
    expect(buildSyncUrlFromParts({
      protocol: 'https',
      host: 'ledger.example.com',
      port: '9443',
      path: 'family-ledger/',
    })).toBe('https://ledger.example.com:9443/family-ledger');
  });

  it('persists the application-level lifecycle interval', () => {
    saveAutoSync({ enabled: true, minutes: 15 });
    expect(loadAutoSync()).toEqual({ enabled: true, minutes: 15 });
  });

  it('keeps private HTTPS endpoints device-local by default', () => {
    const connection = newSyncConnection('https://192.168.1.20:8787/zichan');
    expect(connection.sharedUrls).toEqual([]);
    expect(connection.deviceUrls).toEqual(['https://192.168.1.20:8787/zichan']);
  });

  it('preserves explicit endpoint scopes when the same server identity is merged', () => {
    const publicUrl = 'https://ledger.example.com';
    const privateSharedUrl = 'http://192.168.1.20:8787';
    const publicDeviceUrl = 'https://private-route.example.com';
    const result = mergeSyncUrlScopes(
      { sharedUrls: [privateSharedUrl], deviceUrls: [publicDeviceUrl] },
      { sharedUrls: [publicUrl], deviceUrls: [] },
      [publicDeviceUrl, privateSharedUrl, publicUrl],
    );
    expect(result).toEqual({
      sharedUrls: [privateSharedUrl, publicUrl],
      deviceUrls: [publicDeviceUrl],
    });
  });

  it('derives the current server base path from its bundled /app URL', () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { baseURI: 'https://ledger.example.com/home-ledger/app/index.html' },
    });
    expect(syncAddressPresetUrl('current')).toBe('https://ledger.example.com/home-ledger');
  });

  it('recognizes authentication failures independently of server wording', () => {
    expect(isUnauthorizedSyncError(new Error('HTTP 401'))).toBe(true);
    expect(isUnauthorizedSyncError(new Error('Unauthorized'))).toBe(true);
    expect(isUnauthorizedSyncError('HTTP 403 account disabled')).toBe(true);
    expect(isUnauthorizedSyncError(new Error('network timeout'))).toBe(false);
  });

  it('creates distinct connection ids without depending on randomUUID', () => {
    const first = newSyncConnection();
    const second = newSyncConnection();
    expect(first.id).toMatch(/^server_/);
    expect(second.id).not.toBe(first.id);
  });

  it('only treats an identity-pinned account connection as completed server onboarding', () => {
    const connection = { ...newSyncConnection('https://ledger.example.com'), username: 'owner' };
    saveSyncConnections([connection]);
    expect(hasSavedSyncConnection()).toBe(false);
    saveSyncConnections([{ ...connection, serverId: 'server-1', serverPublicKey: 'opaque-key-1' }]);
    expect(hasSavedSyncConnection()).toBe(true);
  });

  it('does not read the removed legacy profile storage', () => {
    const removedStorageKey = ['zichan.sync.server', 'Profiles.v3'].join('');
    localStorage.setItem(removedStorageKey, JSON.stringify([{
      id: 'legacy',
      alias: '旧配置',
      protocol: 'https',
      host: 'legacy.example.com',
      port: '',
      basePath: '',
      username: 'owner',
      enabled: true,
    }]));
    expect(loadSyncConnections()).toEqual([
      expect.objectContaining({ enabled: false, status: 'unchecked' }),
    ]);
    expect(loadSyncConnections()[0]?.id).not.toBe('legacy');
  });
});
