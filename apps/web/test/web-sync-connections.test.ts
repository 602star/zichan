import { afterEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); }, clear: () => data.clear(), key: (index) => [...data.keys()][index] ?? null, get length() { return data.size; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('Web account multi-server connections', () => {
  it('preserves extra endpoints, primary profile identity and auto-sync preferences when signing in again', async () => {
    vi.stubGlobal('localStorage', memoryStorage()); vi.stubGlobal('sessionStorage', memoryStorage());
    const storage = await import('../src/account-storage.js');
    storage.enableWebAccounts(); storage.activateWebAccount('home', 'alice');
    const config = await import('../src/sync-config.js');
    const web = await import('../src/web-sync-connections.js');
    const primary = { ...config.newSyncConnection('https://home.example.com'), serverId: 'home', accountId: 'alice', username: 'alice' };
    const local = { ...config.newSyncConnection('http://127.0.0.1:8788'), serverId: 'local', username: 'local-user' };
    const remote = { ...config.newSyncConnection('https://public.example.com/ledger'), serverId: 'public', username: 'public-user' };
    config.saveSyncConnections([primary, local, remote]);
    config.saveAutoSync({ enabled: false, minutes: 15 });
    const restored = web.restoreWebSyncConnections({ ...primary, id: 'new-login-id', serverRef: 'new-login-id' });
    expect(restored.id).toBe(primary.id);
    expect(web.isPrimaryWebConnection(restored)).toBe(true);
    expect(web.isPrimaryWebConnection(local)).toBe(false);
    expect(config.loadSyncConnections().map((row) => row.baseUrl)).toEqual([primary.baseUrl, local.baseUrl, remote.baseUrl]);
    expect(config.loadAutoSync()).toEqual({ enabled: false, minutes: 15 });
  });

  it('loads secondary sessions only after selecting the account namespace', async () => {
    vi.stubGlobal('localStorage', memoryStorage()); vi.stubGlobal('sessionStorage', memoryStorage());
    const storage = await import('../src/account-storage.js');
    storage.enableWebAccounts();
    const vault = await import('../src/credential-vault.js');
    storage.activateWebAccount('home', 'alice');
    const config = await import('../src/sync-config.js');
    config.saveSessionCredentials({ secondary: { password: '', inviteCode: '', sessionTransport: 'token', accessToken: 'token-a', refreshToken: 'refresh-a' } });
    expect(vault.runtimeCredential('secondary')).toBeUndefined();
    vault.restoreBrowserCredentialRuntimeState();
    expect(vault.runtimeCredential('secondary')?.refreshToken).toBe('refresh-a');
    vi.resetModules();
    const nextStorage = await import('../src/account-storage.js');
    nextStorage.enableWebAccounts(); nextStorage.activateWebAccount('home', 'bob');
    const nextVault = await import('../src/credential-vault.js');
    nextVault.restoreBrowserCredentialRuntimeState();
    expect(nextVault.runtimeCredential('secondary')).toBeUndefined();
    const nextWeb = await import('../src/web-sync-connections.js');
    const nextConfig = await import('../src/sync-config.js');
    nextWeb.restoreWebSyncConnections({ ...nextConfig.newSyncConnection('https://home.example.com'), serverId: 'home', accountId: 'bob', username: 'bob' });
    expect(nextConfig.loadSyncConnections()).toHaveLength(1);
  });
});
