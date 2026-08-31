import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserLocalCapability,
  browserPersistenceStatus,
  browserStorageDisposition,
  clearFirstUseMode,
  loadFirstUseMode,
  prepareBrowserStorageForMode,
  saveFirstUseMode,
} from '../src/browser-storage-policy.js';

function installBrowserPrimitives(options: {
  persisted: () => Promise<boolean>;
  persist: () => Promise<boolean>;
}) {
  vi.stubGlobal('indexedDB', { open: vi.fn() });
  vi.stubGlobal('crypto', { subtle: {} });
  vi.stubGlobal('WebAssembly', { compile: vi.fn() });
  vi.stubGlobal('navigator', {
    locks: { request: vi.fn() },
    storage: { persisted: options.persisted, persist: options.persist },
  });
}

describe('browser local storage policy', () => {
  afterEach(() => {
    clearFirstUseMode();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('persists only the new explicit first-use mode', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    expect(loadFirstUseMode()).toBeNull();
    saveFirstUseMode('local');
    expect(loadFirstUseMode()).toBe('local');
    localStorage.setItem('zichan.firstUse.mode.v1', 'legacy');
    expect(loadFirstUseMode()).toBeNull();
  });

  it('requires every browser primitive used by encrypted local storage', () => {
    vi.stubGlobal('indexedDB', { open: vi.fn() });
    vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist: async () => true } });
    expect(browserLocalCapability().missing).toContain('Web Locks');
  });

  it('does not treat a denied persistence request as durable storage', async () => {
    const persisted = vi.fn(async () => false);
    const persist = vi.fn(async () => false);
    installBrowserPrimitives({ persisted, persist });
    await expect(browserPersistenceStatus(true)).resolves.toMatchObject({ supported: true, persisted: false });
    expect(persist).toHaveBeenCalledOnce();
  });

  it('requires persisted() to confirm a persistence grant before local creation', async () => {
    const persisted = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    const persist = vi.fn(async () => true);
    installBrowserPrimitives({ persisted, persist });

    await expect(prepareBrowserStorageForMode('local')).resolves.toMatchObject({
      supported: true,
      persisted: false,
      reason: expect.stringContaining('没有确认'),
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(persisted).toHaveBeenCalledTimes(2);
  });

  it('accepts local creation only after the browser confirms persistence', async () => {
    const persisted = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const persist = vi.fn(async () => true);
    installBrowserPrimitives({ persisted, persist });

    await expect(prepareBrowserStorageForMode('local')).resolves.toEqual({
      supported: true,
      persisted: true,
    });
  });

  it('never requests persistence merely to enter server mode', async () => {
    const persisted = vi.fn(async () => false);
    const persist = vi.fn(async () => true);
    installBrowserPrimitives({ persisted, persist });

    await expect(prepareBrowserStorageForMode('server')).resolves.toMatchObject({
      supported: true,
      persisted: false,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('routes denied local storage to blocking or read-only recovery while server mode remains writable', () => {
    expect(browserStorageDisposition({
      mode: 'local', persistenceChecked: true, persisted: false, hasExistingLocalData: false,
    })).toBe('blocked');
    expect(browserStorageDisposition({
      mode: 'local', persistenceChecked: true, persisted: false, hasExistingLocalData: true,
    })).toBe('recovery');
    expect(browserStorageDisposition({
      mode: 'server', persistenceChecked: true, persisted: false, hasExistingLocalData: false,
    })).toBe('writable');
    expect(browserStorageDisposition({
      mode: 'local', persistenceChecked: false, persisted: false, hasExistingLocalData: true,
    })).toBe('pending');
  });
});
