import { afterEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const originals = {
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
};

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  vi.doUnmock('@zichan/db');
  vi.doUnmock('../src/sync-orchestrator.js');
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('background sync lifecycle', () => {
  it('runs all ready profiles through the shared multi-server orchestrator', async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    localStorage.setItem('zichan.sync.auto.v1', JSON.stringify({ enabled: true, minutes: 5 }));
    localStorage.setItem('zichan.sync.connections.v1', JSON.stringify({
      version: 1,
      servers: [{ id: 'home', alias: '家里电脑', sharedUrls: ['https://ledger.example.com'] }],
      connections: [{
        serverRef: 'home', activeUrl: 'https://ledger.example.com', deviceUrls: [],
        username: 'owner', enabled: true, status: 'online',
      }],
    }));
    sessionStorage.setItem('zichan.sync.connectionCredentials.v1', JSON.stringify({
      home: { password: 'sync-password', inviteCode: '', accessToken: 'expired-token', accessExpiresAt: '2099-01-01T00:00:00.000Z' },
    }));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });

    const syncConfiguredServers = vi.fn().mockResolvedValue({
      pulled: 4, pushed: 2, applied: 3, conflicts: 0, skipped: 0, invalid: 0, pending: 0,
      rounds: 1, converged: true, endpoints: [{ id: 'home', alias: '家里电脑' }],
      finishedAt: '2026-07-13T10:00:00.000Z',
    });
    vi.doMock('../src/sync-orchestrator.js', () => ({ syncConfiguredServers }));

    const { initializeLedgerKey } = await import('../src/ledger-key-vault.js');
    await initializeLedgerKey('ledger-000000001', 'ledger-passphrase');
    const { runLifecycleSync } = await import('../src/background-sync.js');
    const result = await runLifecycleSync({} as never, 'startup');
    expect(syncConfiguredServers).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, pulled: 4, pushed: 2, applied: 3, conflicts: 0, rounds: 1, converged: true, errors: [] });
  });
});
