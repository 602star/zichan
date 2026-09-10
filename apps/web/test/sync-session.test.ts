import { requestJson, HttpRequestError } from '../../../packages/db/src/http-request.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage {
  private rows = new Map<string, string>();
  getItem(key: string) { return this.rows.get(key) ?? null; }
  setItem(key: string, value: string) { this.rows.set(key, value); }
  removeItem(key: string) { this.rows.delete(key); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock('@zichan/db');
  vi.resetModules();
});

async function setup(transport: 'token' | 'cookie' = 'token') {
  vi.stubGlobal('window', undefined);
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('location', { origin: 'https://ledger.example.com' });
  const refresh = vi.fn();
  const login = vi.fn();
  vi.doMock('@zichan/db', () => ({
    requestJson, HttpRequestError,
    assertSecureSyncUrl: vi.fn(), isLocalNetworkSyncUrl: vi.fn(() => false),
    refreshAccountSession: refresh, loginAccount: login,
  }));
  const fetchHealth = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    serverId: 'server-home', serverPublicKey: 'opaque-public-key-home',
  })));
  const config = await import('../src/sync-config.js');
  const vault = await import('../src/credential-vault.js');
  const auth = await import('../src/sync-auth.js');
  const profile = {
    ...config.newSyncConnection('https://ledger.example.com'),
    username: 'owner', enabled: true, serverId: 'server-home', serverPublicKey: 'opaque-public-key-home',
  };
  config.saveSyncConnections([profile]);
  vault.setRuntimeCredential(profile.id, {
    password: 'must-not-login-with-this', inviteCode: 'private-invite',
    sessionTransport: transport, sessionId: 'session-home',
    ...(transport === 'token' ? { refreshToken: 'old-refresh' } : {}),
  });
  const session = {
    sessionTransport: transport, accessToken: 'fresh-access', refreshToken: transport === 'cookie' ? '' : 'fresh-refresh',
    accessExpiresAt: '2099-01-01T00:00:00Z', session: { id: 'session-home', username: 'owner' },
  };
  return { config, vault, auth, profile, refresh, login, session, fetchHealth };
}

describe('account session boundaries', () => {
  it('never serializes passwords or invites and strips old password fields on load', async () => {
    const { config, profile } = await setup();
    const raw = sessionStorage.getItem(config.SESSION_CREDENTIALS_KEY)!;
    expect(raw).not.toContain('must-not-login');
    expect(raw).not.toContain('private-invite');
    sessionStorage.setItem(config.SESSION_CREDENTIALS_KEY, JSON.stringify({ [profile.id]: { password: 'legacy', inviteCode: 'legacy' } }));
    expect(config.loadSessionCredentials()[profile.id]).toMatchObject({ password: '', inviteCode: '' });
  });

  it('keeps cookie access and refresh tokens out of browser storage', async () => {
    const { config, vault, auth, profile, refresh, session, login } = await setup('cookie');
    refresh.mockResolvedValue(session);
    await expect(auth.authenticateSyncProfile(profile)).resolves.toBe('fresh-access');
    expect(refresh).toHaveBeenCalledWith(profile.baseUrl, '', 'cookie');
    expect(sessionStorage.getItem(config.SESSION_CREDENTIALS_KEY)).not.toMatch(/fresh-access|fresh-refresh|must-not-login/);
    expect(config.loadSessionCredentials()[profile.id]?.accessToken).toBeUndefined();
    expect(vault.runtimeCredential(profile.id)?.password).toBe('');
    expect(login).not.toHaveBeenCalled();
  });

  it.each([401, 403])('requires user login after HTTP %s instead of resurrecting a revoked session', async (status) => {
    const { vault, auth, profile, refresh, login, config } = await setup();
    refresh.mockRejectedValue(new Error(`session refresh failed: HTTP ${status}`));
    await expect(auth.authenticateSyncProfile(profile)).rejects.toThrow(`HTTP ${status}`);
    expect(vault.runtimeCredential(profile.id)).toEqual({ password: '', inviteCode: '' });
    expect(config.loadSyncConnections()[0]?.status).toBe('login_required');
    await expect(auth.authenticateSyncProfile(profile)).rejects.toThrow('请先登录');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
  });

  it.each(['fetch failed', 'HTTP 503'])('retains the session during retryable %s', async (message) => {
    const { vault, auth, profile, refresh, login } = await setup();
    refresh.mockRejectedValue(new Error(message));
    await expect(auth.authenticateSyncProfile(profile)).rejects.toThrow(message);
    expect(vault.runtimeCredential(profile.id)?.refreshToken).toBe('old-refresh');
    expect(login).not.toHaveBeenCalled();
  });

  it('discards a refresh completing after local logout', async () => {
    const { vault, auth, profile, refresh, session } = await setup();
    let finish!: (value: unknown) => void;
    refresh.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = auth.authenticateSyncProfile(profile);
    const rejected = expect(pending).rejects.toThrow('已忽略旧请求');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    vault.removeRuntimeCredential(profile.id);
    finish(session);
    await rejected;
    expect(vault.runtimeCredential(profile.id)).toBeUndefined();
  });

  it('refuses a cookie session that now belongs to another account', async () => {
    const { vault, auth, profile, refresh, session } = await setup('cookie');
    refresh.mockResolvedValue({ ...session, session: { ...session.session, username: 'another-user' } });
    await expect(auth.authenticateSyncProfile(profile)).rejects.toThrow('切换账号');
    expect(vault.runtimeCredential(profile.id)?.accessToken).toBeUndefined();
  });

  it('never uses a same-origin cookie grant on an alternate origin', async () => {
    const { auth, profile, refresh, fetchHealth } = await setup('cookie');
    await expect(auth.authenticateSyncProfile({ ...profile, baseUrl: 'https://another.example.com' })).rejects.toThrow('不能用于其他网站');
    expect(fetchHealth).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
