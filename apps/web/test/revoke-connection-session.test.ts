import { afterEach, describe, expect, it, vi } from 'vitest';
import { newSyncConnection } from '../src/sync-config.js';
import { revokeConnectionSession } from '../src/revoke-connection-session.js';

const profile = { ...newSyncConnection('https://ledger.example.com'), serverId: 'server', serverPublicKey: 'key' };
const credential = { password: '', inviteCode: '', sessionId: 'session', accessToken: 'access', refreshToken: 'refresh' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe('connection removal session revocation', () => {
  it('verifies identity before sending the session token', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ serverId: 'server', serverPublicKey: 'key' })).mockResolvedValueOnce(reply({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    expect(await revokeConnectionSession(profile, credential)).toBe(true);
    expect(fetcher.mock.calls[0]![1].headers).toBeUndefined();
    expect(fetcher.mock.calls[1]![1].headers).toEqual({ Authorization: 'Bearer access' });
  });
  it('never sends a token to an endpoint with changed identity', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ serverId: 'other', serverPublicKey: 'key' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await revokeConnectionSession(profile, credential)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not claim expired tokens or network failures revoke a refresh session', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ serverId: 'server', serverPublicKey: 'key' })).mockResolvedValueOnce(reply({}, 401)).mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetcher);
    expect(await revokeConnectionSession(profile, credential)).toBe(false);
    expect(await revokeConnectionSession(profile, credential)).toBe(false);
  });
});
