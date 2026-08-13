import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSyncBaseUrl,
  isUnauthorizedSyncError,
  loadAutoSync,
  loadSyncProfiles,
  newSyncProfile,
  normalizeBasePath,
  saveAutoSync,
  saveSyncProfiles,
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

describe('sync configuration', () => {
  beforeEach(() => Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() }));
  afterEach(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('round-trips Chinese aliases, secure paths and independent ports', () => {
    const profile = {
      ...newSyncProfile(), alias: '家里电脑', protocol: 'https' as const, host: 'ledger.example.com', port: '9443',
      basePath: 'family-ledger/', username: 'owner', enabled: true,
    };
    saveSyncProfiles([profile]);
    const loaded = loadSyncProfiles()[0]!;
    expect(loaded).toMatchObject({ alias: '家里电脑', port: '9443', basePath: '/family-ledger', enabled: true });
    expect(buildSyncBaseUrl(loaded)).toBe('https://ledger.example.com:9443/family-ledger');
    expect(normalizeBasePath('/')).toBe('');
  });

  it('persists the application-level lifecycle interval', () => {
    saveAutoSync({ enabled: true, minutes: 15 });
    expect(loadAutoSync()).toEqual({ enabled: true, minutes: 15 });
  });

  it('recognizes authentication failures independently of server wording', () => {
    expect(isUnauthorizedSyncError(new Error('HTTP 401'))).toBe(true);
    expect(isUnauthorizedSyncError(new Error('Unauthorized'))).toBe(true);
    expect(isUnauthorizedSyncError('HTTP 403 account disabled')).toBe(true);
    expect(isUnauthorizedSyncError(new Error('network timeout'))).toBe(false);
  });

  it('creates distinct profile ids without depending on randomUUID', () => {
    const first = newSyncProfile();
    const second = newSyncProfile();
    expect(first.id).toMatch(/^server_/);
    expect(second.id).not.toBe(first.id);
  });
});
