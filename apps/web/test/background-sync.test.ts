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
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
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
  vi.doUnmock('../src/attachment-sync.js');
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
    expect(syncConfiguredServers).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined,
      { deferAttachmentTransfers: true, skipAttachmentSync: true });
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, pulled: 4, pushed: 2, applied: 3, conflicts: 0, rounds: 1, converged: true, errors: [] });
  });

  it('runs bounded attachment batches after commit sync and publishes the final catalog', async () => {
    class TimerWindow extends EventTarget {
      private callbacks = new Map<number, () => void>();
      private next = 0;
      setTimeout(callback: () => void): number { this.callbacks.set(++this.next, callback); return this.next; }
      clearTimeout(id: number): void { this.callbacks.delete(id); }
      setInterval(): number { return ++this.next; }
      clearInterval(): void { /* No interval fires in this test. */ }
      pending(): number { return this.callbacks.size; }
      fireTimers(): void {
        const callbacks = [...this.callbacks.values()];
        this.callbacks.clear();
        for (const callback of callbacks) callback();
      }
    }
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const ledgerId = 'ledger-attachment-batch-0001';
    localStorage.setItem('zichan.sync.auto.v1', JSON.stringify({ enabled: true, minutes: 5 }));
    localStorage.setItem('zichan.sync.connections.v1', JSON.stringify({
      version: 1,
      servers: [{ id: 'home', alias: '家里电脑', serverId: 'server-home',
        sharedUrls: ['https://ledger.example.com', 'https://backup.example.com'] }],
      connections: [{ serverRef: 'home', activeUrl: 'https://ledger.example.com', deviceUrls: [],
        username: 'owner', enabled: true, status: 'online', serverId: 'server-home',
        ledgerId, replicaId: 'replica-home', streamEpoch: 'epoch-home' }],
    }));
    sessionStorage.setItem('zichan.sync.connectionCredentials.v1', JSON.stringify({
      home: { password: '', inviteCode: '', accessToken: 'session-token', accessExpiresAt: '2099-01-01T00:00:00.000Z' },
    }));
    const fakeWindow = new TimerWindow();
    const fakeDocument = new EventTarget() as EventTarget & { visibilityState: string };
    fakeDocument.visibilityState = 'visible';
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });
    const syncConfiguredServers = vi.fn().mockResolvedValue({
      pulled: 0, pushed: 0, applied: 0, conflicts: 0, skipped: 0, invalid: 0, pending: 0,
      rounds: 1, converged: true, endpoints: [{ id: 'home', alias: '家里电脑' }],
      finishedAt: '2026-10-08T10:00:00.000Z',
    });
    const syncAttachmentBatch = vi.fn().mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({ profileId: 'home', scanned: 8, uploaded: 8, migrated: 0, failed: 0,
        bytesUploaded: 8, references: 9, scannedThrough: 8, sweepComplete: false })
      .mockResolvedValueOnce({ profileId: 'home', scanned: 1, uploaded: 1, migrated: 1, failed: 0,
        bytesUploaded: 1, references: 9, scannedThrough: 9, sweepComplete: true });
    vi.doMock('../src/sync-orchestrator.js', () => ({ syncConfiguredServers }));
    vi.doMock('../src/attachment-sync.js', () => ({ syncAttachmentBatch, ATTACHMENT_BATCH_EVENT: 'zichan:attachment-batch' }));
    const { initializeLedgerKey } = await import('../src/ledger-key-vault.js');
    await initializeLedgerKey(ledgerId, 'ledger-passphrase');
    const { installSyncLifecycle } = await import('../src/background-sync.js');
    const cleanup = installSyncLifecycle({ getLedgerId: async () => ledgerId } as never, () => undefined);
    try {
      await vi.waitFor(() => expect(syncConfiguredServers).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(fakeWindow.pending()).toBeGreaterThan(0));
      fakeWindow.fireTimers();
      await vi.waitFor(() => expect(syncAttachmentBatch).toHaveBeenCalledTimes(2));
      expect(syncAttachmentBatch.mock.calls[0]?.[1].profile.baseUrl).toBe('https://ledger.example.com');
      expect(syncAttachmentBatch.mock.calls[1]?.[1].profile.baseUrl).toBe('https://backup.example.com');
      await vi.waitFor(() => expect(fakeWindow.pending()).toBeGreaterThan(0));
      fakeWindow.fireTimers();
      await vi.waitFor(() => expect(syncAttachmentBatch).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(fakeWindow.pending()).toBeGreaterThan(0));
      fakeWindow.fireTimers();
      await vi.waitFor(() => expect(syncConfiguredServers).toHaveBeenCalledTimes(2));
      expect(syncConfiguredServers.mock.calls[0]?.[3]).toMatchObject({ skipAttachmentSync: true });
      expect(syncConfiguredServers.mock.calls[1]?.[3]).toMatchObject({ skipAttachmentSync: false });
      const saved = JSON.parse(localStorage.getItem('zichan.sync.connections.v1')!) as {
        connections: Array<Record<string, unknown>>;
      };
      saved.connections[0]!['lastSyncAt'] = '2026-10-08T10:00:00.000Z';
      localStorage.setItem('zichan.sync.connections.v1', JSON.stringify(saved));
      fakeWindow.dispatchEvent(new CustomEvent('zichan:sync-config-changed', { detail: { kind: 'connections' } }));
      await vi.waitFor(() => expect(fakeWindow.pending()).toBeGreaterThan(0));
      fakeWindow.fireTimers();
      expect(syncAttachmentBatch).toHaveBeenCalledTimes(3);
    } finally {
      cleanup();
    }
  });
});
