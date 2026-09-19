import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminClient, AdminError } from '../src/admin/client.js';
import { fetchAuthMe, loginAccount, refreshAccountSession, registerAccount } from '@zichan/db';

vi.mock('@zichan/db', () => ({
  fetchAuthMe: vi.fn(),
  loginAccount: vi.fn(),
  refreshAccountSession: vi.fn(),
  registerAccount: vi.fn(),
  completeMfaLogin: vi.fn(),
  MfaRequiredError: class MfaRequiredError extends Error {},
}));

const health = { serverId: 'server-pw-test', serverPublicKey: 'pinned-key', claimed: true, capabilities: ['server-management-v1'] };
const session = (id: string) => ({
  accountId: 'account-test',
  accessToken: `token-${id}`,
  refreshToken: `refresh-${id}`,
  accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  session: { id, username: 'operator' },
  role: 'owner',
});
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

let client: AdminClient;
let fetcher: ReturnType<typeof vi.fn>;
const lost = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('BroadcastChannel', undefined);
  fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/api/health')) return reply(health);
    if (url.endsWith('/api/auth/password-change/authorize')) return reply({ code: 'reset-code-from-server', expiresAt: new Date(Date.now() + 300_000).toISOString() });
    return reply({ ok: true });
  });
  vi.stubGlobal('fetch', fetcher);
  vi.mocked(loginAccount).mockResolvedValue(session('proof') as never);
  vi.mocked(refreshAccountSession).mockResolvedValue(session('console') as never);
  vi.mocked(fetchAuthMe).mockResolvedValue({ ...session('console'), username: 'operator', role: 'owner' } as never);
  client = new AdminClient('http://localhost:8787/ledger', lost);
});
afterEach(() => { client.dispose(); vi.unstubAllGlobals(); });

const urlsCalled = () => fetcher.mock.calls.map(([url]) => String(url));

describe('console self-service password change', () => {
  it('proves the current password with its own session, authorizes, and redeems the code', async () => {
    await client.login('operator', 'current-secret');
    fetcher.mockClear();
    await client.changePassword('current-secret', 'next-secret-01');

    // The proof is a fresh login with the *current* password, not a reuse of the console session.
    expect(vi.mocked(loginAccount)).toHaveBeenLastCalledWith('http://localhost:8787/ledger', 'operator', 'current-secret', expect.objectContaining({ sessionTransport: 'token' }));
    const calls = urlsCalled();
    expect(calls).toContain('http://localhost:8787/ledger/api/auth/password-change/authorize');
    expect(calls).toContain('http://localhost:8787/ledger/api/auth/logout');
    // The authorization code the server handed back is what redeems the new password.
    expect(vi.mocked(registerAccount)).toHaveBeenLastCalledWith('http://localhost:8787/ledger', 'operator', 'next-secret-01', expect.objectContaining({ passwordResetCode: 'reset-code-from-server' }));
  });

  it('sends the proof token on the authorize request, never the console cookie token', async () => {
    await client.login('operator', 'current-secret');
    fetcher.mockClear();
    await client.changePassword('current-secret', 'next-secret-01');
    const authorizeCall = fetcher.mock.calls.find(([url]) => String(url).endsWith('/api/auth/password-change/authorize'));
    expect(authorizeCall).toBeDefined();
    const headers = (authorizeCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer ' + 'token-proof');
  });

  it('leaves the console session alone when the current password is wrong', async () => {
    await client.login('operator', 'current-secret');
    vi.mocked(loginAccount).mockRejectedValueOnce(new Error('同步用户名或密码错误'));
    fetcher.mockClear();
    await expect(client.changePassword('wrong-secret', 'next-secret-01')).rejects.toThrow('同步用户名或密码错误');
    // Nothing was authorized, no new password was submitted, and no proof session was left behind.
    expect(urlsCalled().some((url) => url.endsWith('/password-change/authorize'))).toBe(false);
    expect(vi.mocked(registerAccount)).not.toHaveBeenCalled();
  });

  it('rejects an unchanged, short or empty password before touching the server', async () => {
    await client.login('operator', 'current-secret');
    vi.mocked(loginAccount).mockClear();
    await expect(client.changePassword('', 'next-secret-01')).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
    await expect(client.changePassword('current-secret', 'short')).rejects.toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
    await expect(client.changePassword('current-secret', 'current-secret')).rejects.toMatchObject({ code: 'PASSWORD_UNCHANGED' });
    expect(vi.mocked(loginAccount)).not.toHaveBeenCalled();
  });

  it('refuses to guess whose password to change when the console session is gone', async () => {
    client.dispose();
    await expect(client.changePassword('current-secret', 'next-secret-01')).rejects.toBeInstanceOf(AdminError);
    await expect(client.changePassword('current-secret', 'next-secret-01')).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
  });
});
