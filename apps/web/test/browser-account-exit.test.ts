import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_EXIT_KEY, exitBrowserAccount } from '../src/browser-account-exit.js';
import { clearCredentialVaultRuntimeState } from '../src/credential-vault.js';

vi.mock('../src/credential-vault.js', () => ({ clearCredentialVaultRuntimeState: vi.fn(), runtimeCredentialMap: () => ({ remote: { sessionId: 'remote-session', sessionTransport: 'token', accessToken: 'remote-token' } }) }));
vi.mock('../src/web-sync-connections.js', () => ({ isPrimaryWebConnection: (profile: { id: string }) => profile.id === 'primary' }));
vi.mock('../src/sync-config.js', () => ({
  loadSyncConnections: () => [{ id: 'primary', baseUrl: 'https://example.com/ledger' }, { id: 'remote', baseUrl: 'https://remote.example.com', serverId: 'remote-id', serverPublicKey: 'remote-key' }],
  buildSyncBaseUrl: (value: { baseUrl: string }) => value.baseUrl,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('explicit browser account exit', () => {
  for (const offline of [false, true]) it(`preserves cache and records ${offline ? 'unconfirmed' : 'confirmed'} revocation`, async () => {
    const values = new Map<string, string>([['cache', 'encrypted-data']]);
    vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => values.set(key, value) });
    vi.stubGlobal('location', { origin: 'https://example.com' });
    const request = vi.fn(async (url: string) => { if (offline) throw new Error('offline'); return new Response(url.endsWith('/health') ? JSON.stringify({ serverId: 'remote-id', serverPublicKey: 'remote-key' }) : '{}'); });
    vi.stubGlobal('fetch', request);
    await exitBrowserAccount();
    expect(clearCredentialVaultRuntimeState).toHaveBeenCalledTimes(1);
    expect(values.get(ACCOUNT_EXIT_KEY)).toBe(offline ? 'unconfirmed' : 'confirmed');
    expect(values.get('cache')).toBe('encrypted-data');
    expect(request).toHaveBeenCalledWith('https://example.com/ledger/api/auth/logout', expect.objectContaining({ headers: { 'X-Zichan-Session': 'cookie' } }));
    if (!offline) expect(request).toHaveBeenCalledWith('https://remote.example.com/api/auth/logout', expect.objectContaining({ credentials: 'omit', headers: { Authorization: 'Bearer remote-token' } }));
  });
  it('does not send a remote token to an address with a different identity', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => values.set(key, value) });
    vi.stubGlobal('location', { origin: 'https://example.com' });
    const request = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', request);
    await exitBrowserAccount();
    expect(values.get(ACCOUNT_EXIT_KEY)).toBe('unconfirmed');
    expect(request.mock.calls.some(([url]) => url === 'https://remote.example.com/api/auth/logout')).toBe(false);
  });
});
