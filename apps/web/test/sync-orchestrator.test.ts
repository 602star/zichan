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
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
};

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  vi.doUnmock('@zichan/db');
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('configured sync orchestrator', () => {
  it('re-authenticates once when a cached token is rejected', async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const profile = {
      id: 'home', alias: '家里电脑', protocol: 'https' as const, host: 'ledger.example.com', port: '', basePath: '',
      username: 'owner', enabled: true, lastStatus: 'online' as const,
    };
    localStorage.setItem('zichan.sync.serverProfiles.v3', JSON.stringify([profile]));
    sessionStorage.setItem('zichan.sync.sessionCredentials.v3', JSON.stringify({
      home: {
        password: 'sync-password',
        inviteCode: '',
        accessToken: 'expired-token',
        accessExpiresAt: '2099-01-01T00:00:00.000Z',
      },
    }));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });

    const loginAccount = vi.fn().mockResolvedValue({
      accessToken: 'fresh-token',
      refreshToken: 'fresh-refresh-token',
      accessExpiresAt: '2099-01-01T00:00:00.000Z',
      session: { id: 'session-home' },
    });
    const refreshAccountSession = vi.fn();
    const httpCommitTransport = vi.fn((options: { token: string }) => ({
      async connect(ledgerId: string) {
        if (options.token === 'expired-token') throw new Error('replica lookup failed: HTTP 401 unauthorized');
        return { serverId: 'server-home', replicaId: 'replica-home', streamEpoch: 'epoch-home', ledgerId, headSeq: 0 };
      },
      async pullCommits() { throw new Error('not used'); },
      async pushCommits() { throw new Error('not used'); },
    }));
    const syncReplicas = vi.fn(async (_store: unknown, targets: { id: string; endpoint: string; transport: { connect(ledgerId: string): Promise<unknown> } }[]) => {
      const identity = await targets[0]!.transport.connect('ledger-000000001');
      return {
        pulled: 0, pushed: 0, applied: 0, conflicts: 0, skipped: 0, invalid: 0, pending: 0,
        rounds: 1, converged: true,
        endpoints: [{ id: targets[0]!.id, endpoint: targets[0]!.endpoint, identity, pulled: 0, pushed: 0, headSeq: 0, cursor: 0, pendingPush: 0 }],
      };
    });
    vi.doMock('@zichan/db', () => ({ httpCommitTransport, loginAccount, refreshAccountSession, syncReplicas }));

    const { initializeLedgerKey } = await import('../src/ledger-key-vault.js');
    await initializeLedgerKey('ledger-000000001', 'ledger-passphrase');
    const { syncConfiguredServers } = await import('../src/sync-orchestrator.js');
    const result = await syncConfiguredServers({} as never, [profile]);
    expect(loginAccount).toHaveBeenCalledTimes(1);
    expect(httpCommitTransport).toHaveBeenCalledTimes(2);
    expect(result.converged).toBe(true);
    expect(result.endpoints[0]?.alias).toBe('家里电脑');
    expect(result.endpoints[0]?.error).toBeUndefined();
    expect(JSON.parse(sessionStorage.getItem('zichan.sync.sessionCredentials.v3')!).home.accessToken).toBe('fresh-token');
  });

  it('serializes concurrent authentication for the same profile', async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const profile = {
      id: 'home', alias: '家里电脑', protocol: 'https' as const, host: 'ledger.example.com', port: '', basePath: '',
      username: 'owner', enabled: true, lastStatus: 'online' as const,
    };
    sessionStorage.setItem('zichan.sync.sessionCredentials.v3', JSON.stringify({
      home: { password: 'sync-password', inviteCode: '' },
    }));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });

    let finishLogin!: (value: {
      accessToken: string;
      refreshToken: string;
      accessExpiresAt: string;
      session: { id: string };
    }) => void;
    const loginAccount = vi.fn(() => new Promise((resolve) => { finishLogin = resolve; }));
    const refreshAccountSession = vi.fn();
    vi.doMock('@zichan/db', () => ({ loginAccount, refreshAccountSession }));

    const { authenticateSyncProfile } = await import('../src/sync-auth.js');
    const first = authenticateSyncProfile(profile, true);
    const second = authenticateSyncProfile(profile, true);
    expect(loginAccount).toHaveBeenCalledTimes(1);
    finishLogin({
      accessToken: 'fresh-token',
      refreshToken: 'fresh-refresh-token',
      accessExpiresAt: '2099-01-01T00:00:00.000Z',
      session: { id: 'session-home' },
    });
    await expect(Promise.all([first, second])).resolves.toEqual(['fresh-token', 'fresh-token']);
    expect(loginAccount).toHaveBeenCalledTimes(1);
  });
});
