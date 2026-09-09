import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminClient, adminBaseUrl } from '../src/admin/client.js';
import { fetchAuthMe, loginAccount, refreshAccountSession, registerAccount } from '@zichan/db';

vi.mock('@zichan/db', () => ({ fetchAuthMe: vi.fn(), loginAccount: vi.fn(), refreshAccountSession: vi.fn(), registerAccount: vi.fn() }));
const health = { serverId: 'server-admin-test', serverPublicKey: 'pinned-key', claimed: true, capabilities: ['server-management-v1'] };
const auth = (expires = Date.now() + 60_000) => ({ accountId: 'account-test', accessToken: 'access-secret', refreshToken: '', accessExpiresAt: new Date(expires).toISOString(), session: { id: 'session-test', username: 'operator' }, role: 'owner' });
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
let client: AdminClient;
let fetcher: ReturnType<typeof vi.fn>;
const lost = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('BroadcastChannel', undefined);
  fetcher = vi.fn(async (url: string) => reply(url.endsWith('/api/health') ? health : { ok: true }));
  vi.stubGlobal('fetch', fetcher);
  vi.mocked(loginAccount).mockResolvedValue(auth() as never);
  vi.mocked(refreshAccountSession).mockResolvedValue(auth() as never);
  vi.mocked(fetchAuthMe).mockResolvedValue({ ...auth(), username: 'operator', role: 'owner' } as never);
  client = new AdminClient('http://localhost:8787/ledger', lost);
});
afterEach(() => { client.dispose(); vi.unstubAllGlobals(); });

describe('independent management session lifecycle', () => {
  it('reports committed initialization before a subsequent login failure', async () => {
    fetcher.mockResolvedValue(reply({ ...health, claimed: false }));
    vi.mocked(loginAccount).mockRejectedValue(new Error('offline'));
    const initialized = vi.fn();
    await expect(client.login('operator', 'password', true, initialized)).rejects.toThrow('offline');
    expect(initialized).toHaveBeenCalledTimes(1);
  });
  it('initializes the first owner with username and password only', async () => {
    fetcher.mockResolvedValue(reply({ ...health, claimed: false }));
    await client.login('operator', 'password', true);
    expect(registerAccount).toHaveBeenCalledWith(expect.any(String), 'operator', 'password', expect.objectContaining({ initializeOwner: true }));
    expect(vi.mocked(registerAccount).mock.calls[0]?.[3]).not.toHaveProperty('ownerSetupToken');
  });

  it('never reinitializes an already claimed server', async () => {
    await expect(client.login('operator', 'password', true)).rejects.toThrow('管理员已设置');
    expect(registerAccount).not.toHaveBeenCalled();
  });
  it('explains HTML fallback responses instead of exposing JSON parse errors', async () => {
    fetcher.mockResolvedValueOnce(new Response('<!DOCTYPE html><html></html>', { headers: { 'Content-Type': 'text/html' } }) as never);
    await expect(client.health()).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE', message: expect.stringContaining('npm run start:all') });
    expect(loginAccount).not.toHaveBeenCalled();
  });

  it('explains unavailable development proxy targets', async () => {
    fetcher.mockResolvedValueOnce(new Response('', { status: 500 }) as never);
    await expect(client.health()).rejects.toThrow('请确认服务器已启动');
  });
  it('routes management without routing ledger paths into the admin bootstrap', () => {
    expect(adminBaseUrl({ origin: 'https://example.com', pathname: '/ledger/admin/users' })).toBe('https://example.com/ledger');
    expect(adminBaseUrl({ origin: 'https://example.com', pathname: '/admin' })).toBe('https://example.com');
    expect(adminBaseUrl({ origin: 'https://example.com', pathname: '/ledger/app/' })).toBeUndefined();
  });

  it('uses the independent admin cookie context and refuses ordinary members', async () => {
    vi.mocked(fetchAuthMe).mockResolvedValue({ ...auth(), username: 'operator', role: 'member' } as never);
    await expect(client.login('operator', 'password')).rejects.toThrow('没有服务器管理权限');
    expect(loginAccount).toHaveBeenCalledWith(expect.any(String), 'operator', 'password', expect.objectContaining({ sessionContext: 'admin', sessionTransport: 'cookie' }));
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/api/auth/logout'), expect.objectContaining({ headers: expect.objectContaining({ 'X-Zichan-Session': 'admin-cookie' }) }));
  });

  it('coalesces refresh for concurrent reads without replaying writes', async () => {
    vi.mocked(loginAccount).mockResolvedValue(auth(0) as never);
    await client.login('operator', 'password');
    await Promise.all([client.request('/status'), client.request('/users')]);
    expect(refreshAccountSession).toHaveBeenCalledTimes(1);
    expect(refreshAccountSession).toHaveBeenCalledWith('http://localhost:8787/ledger', '', 'cookie', 'admin');
  });

  it('rejects late responses after logout instead of repopulating management data', async () => {
    await client.login('operator', 'password');
    let resolvePending!: (value: unknown) => void;
    fetcher.mockImplementation((url: string) => url.endsWith('/users') ? new Promise((resolve) => { resolvePending = resolve; }) : Promise.resolve(reply({ ok: true })));
    const pending = client.request('/users');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await client.logout();
    resolvePending(reply({ users: [{ username: 'private-user' }] }));
    await rejected;
    expect(lost).not.toHaveBeenCalled();
  });

  it('does not revoke a valid session for an action-specific denial but clears it on 401', async () => {
    await client.login('operator', 'password');
    fetcher.mockResolvedValueOnce(reply({ code: 'RECENT_LOGIN_REQUIRED', error: 'sign in again' }, 403));
    await expect(client.request('/accounts/test/role', { role: 'admin' })).rejects.toMatchObject({ code: 'RECENT_LOGIN_REQUIRED' });
    expect(lost).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(reply({ error: 'expired' }, 401));
    await expect(client.request('/users')).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('never sends an old access token after a refresh resolves to a different account', async () => {
    vi.mocked(loginAccount).mockResolvedValue(auth(0) as never);
    await client.login('operator', 'password');
    vi.mocked(refreshAccountSession).mockResolvedValue({ ...auth(), accountId: 'different-account' } as never);
    await expect(client.request('/users')).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/users'))).toBe(false);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
