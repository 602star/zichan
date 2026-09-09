import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_EXIT_KEY, exitBrowserAccount } from '../src/browser-account-exit.js';
import { clearCredentialVaultRuntimeState } from '../src/credential-vault.js';

vi.mock('../src/credential-vault.js', () => ({ clearCredentialVaultRuntimeState: vi.fn() }));
vi.mock('../src/sync-config.js', () => ({ loadSyncConnections: () => ['https://example.com/ledger'], buildSyncBaseUrl: (value: string) => value }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('explicit browser account exit', () => {
  for (const offline of [false, true]) it(`preserves cache and records ${offline ? 'unconfirmed' : 'confirmed'} revocation`, async () => {
    const values = new Map<string, string>([['cache', 'encrypted-data']]);
    vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => values.set(key, value) });
    vi.stubGlobal('location', { origin: 'https://example.com' });
    const request = vi.fn(async () => { if (offline) throw new Error('offline'); return new Response('{}'); });
    vi.stubGlobal('fetch', request);
    await exitBrowserAccount();
    expect(clearCredentialVaultRuntimeState).toHaveBeenCalledTimes(1);
    expect(values.get(ACCOUNT_EXIT_KEY)).toBe(offline ? 'unconfirmed' : 'confirmed');
    expect(values.get('cache')).toBe('encrypted-data');
    expect(request).toHaveBeenCalledWith('https://example.com/ledger/api/auth/logout', expect.objectContaining({ headers: { 'X-Zichan-Session': 'cookie' } }));
  });
});
