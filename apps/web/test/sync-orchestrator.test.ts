import { requestJson, HttpRequestError } from '../../../packages/db/src/http-request.js';
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
  it('fails over to an identity-pinned alternate URL and persists the working address', async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const primaryUrl = 'https://primary.example.com';
    const alternateUrl = 'https://backup.example.com';
    const profile = {
      id: 'home', serverRef: 'home', alias: '家里电脑',
      baseUrl: primaryUrl, activeUrl: primaryUrl,
      alternateUrls: [alternateUrl], sharedUrls: [primaryUrl, alternateUrl], deviceUrls: [],
      username: 'owner', enabled: true, status: 'online' as const,
      serverId: 'server-home', serverPublicKey: 'opaque-public-key-home',
    };
    sessionStorage.setItem('zichan.sync.connectionCredentials.v1', JSON.stringify({
      home: {
        password: 'sync-password',
        inviteCode: '',
        accessToken: 'fresh-token',
        accessExpiresAt: '2099-01-01T00:00:00.000Z',
      },
    }));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });
    const fetchHealth = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).startsWith(primaryUrl)) throw new TypeError('fetch failed: ECONNREFUSED');
      return new Response(JSON.stringify({
        serverId: 'server-home',
        serverPublicKey: 'opaque-public-key-home',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const httpCommitTransport = vi.fn((options: { baseUrl: string }) => ({
      async connect(ledgerId: string) {
        return { serverId: 'server-home', replicaId: 'replica-home', streamEpoch: 'epoch-home', ledgerId, headSeq: 0 };
      },
      async pullCommits() { throw new Error('not used'); },
      async pushCommits() { throw new Error('not used'); },
      endpoint: options.baseUrl,
    }));
    const syncReplicas = vi.fn(async (_store: unknown, targets: { id: string; endpoint: string; transport: { connect(ledgerId: string): Promise<unknown> } }[]) => {
      const identity = await targets[0]!.transport.connect('ledger-000000001');
      return {
        pulled: 0, pushed: 0, applied: 0, conflicts: 0, skipped: 0, invalid: 0, pending: 0,
        rounds: 1, converged: true,
        endpoints: [{ id: targets[0]!.id, endpoint: targets[0]!.endpoint, identity, pulled: 0, pushed: 0, headSeq: 0, cursor: 0, pendingPush: 0 }],
      };
    });
    vi.doMock('@zichan/db', () => ({
    requestJson, HttpRequestError,
      assertSecureSyncUrl: vi.fn(),
      isLocalNetworkSyncUrl: vi.fn(() => false),
      httpCommitTransport,
      loginAccount: vi.fn(),
      refreshAccountSession: vi.fn(),
      syncReplicas,
    }));

    const { initializeLedgerKey } = await import('../src/ledger-key-vault.js');
    await initializeLedgerKey('ledger-000000001', 'ledger-passphrase');
    const { loadSyncConnections, saveSyncConnections } = await import('../src/sync-config.js');
    saveSyncConnections([profile]);
    const { syncConfiguredServers } = await import('../src/sync-orchestrator.js');
    const result = await syncConfiguredServers({} as never, [profile]);

    expect(fetchHealth).toHaveBeenCalledWith(`${primaryUrl}/api/health`, { redirect: 'error', signal: expect.any(AbortSignal) });
    expect(fetchHealth).toHaveBeenCalledWith(`${alternateUrl}/api/health`, { redirect: 'error', signal: expect.any(AbortSignal) });
    expect(httpCommitTransport).toHaveBeenCalledTimes(1);
    expect(httpCommitTransport.mock.calls[0]?.[0]).toMatchObject({ baseUrl: alternateUrl, token: 'fresh-token' });
    expect(result.endpoints[0]?.url).toBe(alternateUrl);
    expect(loadSyncConnections()[0]).toMatchObject({
      baseUrl: alternateUrl,
      activeUrl: alternateUrl,
      alternateUrls: [primaryUrl],
      status: 'online',
    });
  });

  it('does not try an alternate URL after the pinned server identity changes', async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const primaryUrl = 'https://primary.example.com';
    const alternateUrl = 'https://backup.example.com';
    const profile = {
      id: 'home', serverRef: 'home', alias: '家里电脑',
      baseUrl: primaryUrl, activeUrl: primaryUrl,
      alternateUrls: [alternateUrl], sharedUrls: [primaryUrl, alternateUrl], deviceUrls: [],
      username: 'owner', enabled: true, status: 'online' as const,
      serverId: 'server-home', serverPublicKey: 'opaque-public-key-home',
    };
    sessionStorage.setItem('zichan.sync.connectionCredentials.v1', JSON.stringify({
      home: {
        password: 'sync-password',
        inviteCode: '',
        accessToken: 'fresh-token',
        accessExpiresAt: '2099-01-01T00:00:00.000Z',
      },
    }));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });
    const fetchHealth = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const expected = String(input).startsWith(alternateUrl)
        ? { serverId: 'server-home', serverPublicKey: 'opaque-public-key-home' }
        : { serverId: 'replacement-server', serverPublicKey: 'replacement-key' };
      return new Response(JSON.stringify(expected), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const httpCommitTransport = vi.fn();
    const syncReplicas = vi.fn(async (_store: unknown, targets: { id: string; endpoint: string; transport: { connect(ledgerId: string): Promise<unknown> } }[]) => {
      let error = '';
      try {
        await targets[0]!.transport.connect('ledger-000000001');
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
      }
      return {
        pulled: 0, pushed: 0, applied: 0, conflicts: 0, skipped: 0, invalid: 0, pending: 0,
        rounds: 0, converged: false,
        endpoints: [{ id: targets[0]!.id, endpoint: targets[0]!.endpoint, pulled: 0, pushed: 0, headSeq: 0, cursor: 0, pendingPush: 0, error }],
      };
    });
    vi.doMock('@zichan/db', () => ({
    requestJson, HttpRequestError,
      assertSecureSyncUrl: vi.fn(),
      isLocalNetworkSyncUrl: vi.fn(() => false),
      httpCommitTransport,
      loginAccount: vi.fn(),
      refreshAccountSession: vi.fn(),
      syncReplicas,
    }));

    const { saveSyncConnections } = await import('../src/sync-config.js');
    saveSyncConnections([profile]);
    const { syncConfiguredServers } = await import('../src/sync-orchestrator.js');
    const result = await syncConfiguredServers({} as never, [profile]);

    expect(result.endpoints[0]?.error).toContain('同步服务器身份已变化');
    expect(fetchHealth).toHaveBeenCalledTimes(1);
    expect(fetchHealth).toHaveBeenCalledWith(`${primaryUrl}/api/health`, { redirect: 'error', signal: expect.any(AbortSignal) });
    expect(httpCommitTransport).not.toHaveBeenCalled();
  });

  it('refreshes once without a password login when a cached token is rejected', async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const profile = {
      id: 'home', serverRef: 'home', alias: '家里电脑',
      baseUrl: 'https://ledger.example.com', activeUrl: 'https://ledger.example.com',
      alternateUrls: [], sharedUrls: ['https://ledger.example.com'], deviceUrls: [],
      username: 'owner', enabled: true, status: 'online' as const,
      serverId: 'server-home', serverPublicKey: 'opaque-public-key-home',
    };
    sessionStorage.setItem('zichan.sync.connectionCredentials.v1', JSON.stringify({
      home: {
        password: 'sync-password',
        inviteCode: '',
        accessToken: 'expired-token',
        refreshToken: 'old-refresh-token',
        accessExpiresAt: '2099-01-01T00:00:00.000Z',
      },
    }));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });
    const fetchHealth = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      serverId: 'server-home',
      serverPublicKey: 'opaque-public-key-home',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const loginAccount = vi.fn();
    const refreshAccountSession = vi.fn().mockResolvedValue({
      accessToken: 'fresh-token',
      refreshToken: 'fresh-refresh-token',
      accessExpiresAt: '2099-01-01T00:00:00.000Z',
      session: { id: 'session-home', username: 'owner' },
    });
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
    vi.doMock('@zichan/db', () => ({
    requestJson, HttpRequestError,
      assertSecureSyncUrl: vi.fn(),
      isLocalNetworkSyncUrl: vi.fn(() => false),
      httpCommitTransport,
      loginAccount,
      refreshAccountSession,
      syncReplicas,
    }));

    const { initializeLedgerKey } = await import('../src/ledger-key-vault.js');
    await initializeLedgerKey('ledger-000000001', 'ledger-passphrase');
    const { syncConfiguredServers } = await import('../src/sync-orchestrator.js');
    const result = await syncConfiguredServers({} as never, [profile]);
    expect(loginAccount).not.toHaveBeenCalled();
    expect(refreshAccountSession).toHaveBeenCalledTimes(1);
    expect(fetchHealth).toHaveBeenCalledTimes(2);
    expect(fetchHealth).toHaveBeenCalledWith('https://ledger.example.com/api/health', { redirect: 'error', signal: expect.any(AbortSignal) });
    expect(httpCommitTransport).toHaveBeenCalledTimes(2);
    expect(result.converged).toBe(true);
    expect(result.endpoints[0]?.alias).toBe('家里电脑');
    expect(result.endpoints[0]?.error).toBeUndefined();
    expect(JSON.parse(sessionStorage.getItem('zichan.sync.connectionCredentials.v1')!).home.accessToken).toBe('fresh-token');
  });

  it('serializes concurrent authentication for the same profile', async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const profile = {
      id: 'home', serverRef: 'home', alias: '家里电脑',
      baseUrl: 'https://ledger.example.com', activeUrl: 'https://ledger.example.com',
      alternateUrls: [], sharedUrls: ['https://ledger.example.com'], deviceUrls: [],
      username: 'owner', enabled: true, status: 'online' as const,
      serverId: 'server-home', serverPublicKey: 'opaque-public-key-home',
    };
    sessionStorage.setItem('zichan.sync.connectionCredentials.v1', JSON.stringify({
      home: { refreshToken: 'old-refresh-token' },
    }));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      serverId: 'server-home',
      serverPublicKey: 'opaque-public-key-home',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    let finishLogin!: (value: {
      accessToken: string;
      refreshToken: string;
      accessExpiresAt: string;
      session: { id: string; username: string };
    }) => void;
    const loginAccount = vi.fn();
    const refreshAccountSession = vi.fn(() => new Promise((resolve) => { finishLogin = resolve; }));
    vi.doMock('@zichan/db', () => ({
    requestJson, HttpRequestError,
      assertSecureSyncUrl: vi.fn(),
      isLocalNetworkSyncUrl: vi.fn(() => false),
      loginAccount,
      refreshAccountSession,
    }));

    const { authenticateSyncProfile } = await import('../src/sync-auth.js');
    const first = authenticateSyncProfile(profile, true);
    const second = authenticateSyncProfile(profile, true);
    await vi.waitFor(() => expect(refreshAccountSession).toHaveBeenCalledTimes(1));
    finishLogin({
      accessToken: 'fresh-token',
      refreshToken: 'fresh-refresh-token',
      accessExpiresAt: '2099-01-01T00:00:00.000Z',
      session: { id: 'session-home', username: 'owner' },
    });
    await expect(Promise.all([first, second])).resolves.toEqual(['fresh-token', 'fresh-token']);
    expect(loginAccount).not.toHaveBeenCalled();
    expect(refreshAccountSession).toHaveBeenCalledTimes(1);
  });

  it('checks each alternate URL independently during concurrent authentication', async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const primary = {
      id: 'home', serverRef: 'home', alias: '家里电脑',
      baseUrl: 'https://primary.example.com', activeUrl: 'https://primary.example.com',
      alternateUrls: ['https://backup.example.com'], sharedUrls: ['https://primary.example.com', 'https://backup.example.com'], deviceUrls: [],
      username: 'owner', enabled: true, status: 'online' as const,
      serverId: 'server-home', serverPublicKey: 'opaque-public-key-home',
    };
    const alternate = { ...primary, baseUrl: 'https://backup.example.com', activeUrl: 'https://backup.example.com' };
    sessionStorage.setItem('zichan.sync.connectionCredentials.v1', JSON.stringify({
      home: { refreshToken: 'old-refresh-token' },
    }));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });
    const fetchHealth = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      serverId: 'server-home',
      serverPublicKey: 'opaque-public-key-home',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const loginAccount = vi.fn();
    const refreshAccountSession = vi.fn(async (baseUrl: string) => ({
      accessToken: `token:${baseUrl}`,
      refreshToken: `refresh:${baseUrl}`,
      accessExpiresAt: '2099-01-01T00:00:00.000Z',
      session: { id: `session:${baseUrl}`, username: 'owner' },
    }));
    vi.doMock('@zichan/db', () => ({
    requestJson, HttpRequestError,
      assertSecureSyncUrl: vi.fn(),
      isLocalNetworkSyncUrl: vi.fn(() => false),
      loginAccount,
      refreshAccountSession,
    }));

    const { authenticateSyncProfile } = await import('../src/sync-auth.js');
    await expect(Promise.all([
      authenticateSyncProfile(primary, true),
      authenticateSyncProfile(alternate, true),
    ])).resolves.toEqual([
      'token:https://primary.example.com',
      'token:https://primary.example.com',
    ]);
    expect(fetchHealth).toHaveBeenCalledTimes(2);
    expect(fetchHealth).toHaveBeenCalledWith('https://primary.example.com/api/health', { redirect: 'error', signal: expect.any(AbortSignal) });
    expect(fetchHealth).toHaveBeenCalledWith('https://backup.example.com/api/health', { redirect: 'error', signal: expect.any(AbortSignal) });
    expect(loginAccount).not.toHaveBeenCalled();
    expect(refreshAccountSession).toHaveBeenCalledTimes(1);
  });

  it('blocks every credential before contacting a server whose pinned identity changed', async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const profile = {
      id: 'home', serverRef: 'home', alias: '家里电脑',
      baseUrl: 'https://ledger.example.com', activeUrl: 'https://ledger.example.com',
      alternateUrls: [], sharedUrls: ['https://ledger.example.com'], deviceUrls: [],
      username: 'owner', enabled: true, status: 'online' as const,
      serverId: 'server-home', serverPublicKey: 'opaque-public-key-home',
    };
    sessionStorage.setItem('zichan.sync.connectionCredentials.v1', JSON.stringify({
      home: {
        password: 'sync-password',
        accessToken: 'still-valid-token',
        refreshToken: 'refresh-token',
        accessExpiresAt: '2099-01-01T00:00:00.000Z',
      },
    }));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });

    const fetchHealth = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      serverId: 'replacement-server',
      serverPublicKey: 'replacement-public-key',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const loginAccount = vi.fn();
    const refreshAccountSession = vi.fn();
    vi.doMock('@zichan/db', () => ({
    requestJson, HttpRequestError,
      assertSecureSyncUrl: vi.fn(),
      isLocalNetworkSyncUrl: vi.fn(() => false),
      loginAccount,
      refreshAccountSession,
    }));

    const { authenticateSyncProfile } = await import('../src/sync-auth.js');
    await expect(authenticateSyncProfile(profile)).rejects.toThrow('同步服务器身份已变化');
    expect(fetchHealth).toHaveBeenCalledWith('https://ledger.example.com/api/health', { redirect: 'error', signal: expect.any(AbortSignal) });
    expect(loginAccount).not.toHaveBeenCalled();
    expect(refreshAccountSession).not.toHaveBeenCalled();
  });

  it('persists identity, authorization, and network failures as distinct connection states', async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });
    const profiles = [
      ['identity', '服务器身份已变化，已阻止发送会话或密码'],
      ['account', 'replica lookup failed: HTTP 401 unauthorized'],
      ['network', 'fetch failed: ECONNREFUSED'],
    ].map(([id, error]) => ({
      id: id!, serverRef: id!, alias: id!,
      baseUrl: `https://${id}.example.com`, activeUrl: `https://${id}.example.com`,
      alternateUrls: [], sharedUrls: [`https://${id}.example.com`], deviceUrls: [],
      username: 'owner', enabled: true, status: 'online' as const,
      serverId: `server-${id}`, serverPublicKey: `key-${id}`,
      testError: error!,
    }));
    const syncReplicas = vi.fn(async (_store: unknown, targets: { id: string; endpoint: string }[]) => ({
      pulled: 0, pushed: 0, applied: 0, conflicts: 0, skipped: 0, invalid: 0, pending: 0,
      rounds: 1, converged: false,
      endpoints: targets.map((target) => ({
        id: target.id,
        endpoint: target.endpoint,
        pulled: 0,
        pushed: 0,
        headSeq: 0,
        cursor: 0,
        pendingPush: 0,
        error: profiles.find((profile) => profile.id === target.id)!.testError,
      })),
    }));
    vi.doMock('@zichan/db', () => ({
    requestJson, HttpRequestError,
      assertSecureSyncUrl: vi.fn(),
      isLocalNetworkSyncUrl: vi.fn(() => false),
      httpCommitTransport: vi.fn(),
      loginAccount: vi.fn(),
      refreshAccountSession: vi.fn(),
      syncReplicas,
    }));

    const { loadSyncConnections, saveSyncConnections } = await import('../src/sync-config.js');
    saveSyncConnections(profiles.map(({ testError: _testError, ...profile }) => profile));
    const { syncConfiguredServers } = await import('../src/sync-orchestrator.js');
    const result = await syncConfiguredServers({} as never, profiles.map(({ testError: _testError, ...profile }) => profile));

    expect(result.endpoints.map((endpoint) => endpoint.error)).toEqual(profiles.map((profile) => profile.testError));
    expect(Object.fromEntries(loadSyncConnections().map((profile) => [profile.id, profile.status]))).toEqual({
      identity: 'identity_changed',
      account: 'login_required',
      network: 'offline',
    });
  });
});
