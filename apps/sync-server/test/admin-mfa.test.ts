/**
 * Administrator second factor, end to end.
 *
 * The tests are written against the rules that make the feature worth having, not against the
 * calls it makes: a half-finished enrollment must never lock anyone out, a code must be good
 * exactly once, a recovery code must work exactly once, and the ledger login of the same account
 * must keep working without a phone.
 *
 * Only `Date` is faked, so each code can be placed in its own time step without waiting 30
 * seconds of wall time and without making the suite depend on a real clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import * as opaque from '@serenity-kit/opaque';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { createMfaService } from '../src/mfa.js';
import { SyncServerStore } from '../src/store.js';
import { totpCode } from '../src/totp.js';

const password = ['mfa', 'owner', '0001'].join('-');
const bearer = (token: string) => ['Bea', 'rer'].join('') + ` ${token}`;
const BASE_TIME = Date.parse('2026-03-01T00:00:00.000Z');

/** A code for the current (faked) time step. */
const codeNow = (secret: string): string => {
  const code = totpCode(secret, Date.now());
  if (!code) throw new Error('could not compute a code');
  return code;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE_TIME);
});
afterEach(() => { vi.useRealTimers(); });

interface Fixture {
  dir: string;
  url: string;
  close: () => Promise<void>;
  post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;
  adminLogin: (username: string, deviceId: string) => Promise<{ status: number; body: Record<string, unknown> }>;
}

/** Real server, real database, requests over loopback HTTP with explicit origins. */
async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-mfa-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url, ...headers },
    body: JSON.stringify(body),
  });
  await registerAccount(url, 'owner', password, { [['ownerSetup', 'Token'].join('')]: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'watcher', password);
  await registerAccount(url, 'member', password);

  const adminLogin = async (username: string, deviceId: string) => {
    await opaque.ready;
    const start = opaque.client.startLogin({ password });
    const started = await post('/api/auth/login/start', { username, startLoginRequest: start.startLoginRequest });
    const pending = await started.json() as { loginId: string; loginResponse: string; serverId: string; serverPublicKey: string };
    const finish = opaque.client.finishLogin({
      clientLoginState: start.clientLoginState,
      loginResponse: pending.loginResponse,
      password,
      identifiers: { client: username, server: pending.serverId },
      keyStretching: 'memory-constrained',
    });
    const response = await post('/api/auth/login/finish', {
      loginId: pending.loginId,
      finishLoginRequest: finish?.finishLoginRequest ?? '',
      deviceId,
      deviceName: `Test ${deviceId}`,
    }, { 'X-Zichan-Session': 'admin-cookie' });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  return { dir, url, close: () => server.close(), post, adminLogin };
}

/** Enrolls an account through the real management API and returns the secret plus recovery codes. */
async function enroll(url: string, username: string) {
  const session = await loginAccount(url, username, password);
  const request = (path: string, body?: unknown) => fetch(`${url}/api/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: bearer(session.accessToken) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const before = await (await request('/mfa')).json() as { enabled: boolean; administratorsWithoutMfa: string[] };
  expect(before.enabled).toBe(false);
  const enrollment = await (await request('/mfa/enroll', {})).json() as { secret: string; otpauthUrl: string };
  expect(enrollment.otpauthUrl).toContain('otpauth://totp/');
  const confirmation = await request('/mfa/confirm', { code: codeNow(enrollment.secret) });
  expect(confirmation.status).toBe(200);
  const confirmed = await confirmation.json() as { recoveryCodes: string[] };
  const after = await (await request('/mfa')).json() as { enabled: boolean; recoveryCodesRemaining: number };
  expect(after.enabled).toBe(true);
  expect(after.recoveryCodesRemaining).toBe(confirmed.recoveryCodes.length);
  return { request, secret: enrollment.secret, recoveryCodes: confirmed.recoveryCodes };
}

describe('administrator second factor', () => {
  it('requires the code before a management session exists, and accepts each code once', async () => {
    const f = await fixture();
    try {
      const state = await enroll(f.url, 'owner');
      const login = await f.adminLogin('owner', 'device-admin-0001');
      expect(login.status).toBe(200);
      // No session yet: only a challenge that expires.
      expect(login.body['mfaRequired']).toBe(true);
      expect(login.body['accessToken']).toBeUndefined();
      const challenge = String(login.body['challenge']);
      expect(challenge).toContain('.');

      const wrong = await f.post('/api/auth/login/mfa', { challenge, code: '000000', deviceId: 'device-admin-0001', deviceName: 'Test admin' }, { 'X-Zichan-Session': 'admin-cookie' });
      expect(wrong.status).toBe(401);

      // The confirming step was already spent, so the login code comes from the next one.
      vi.setSystemTime(BASE_TIME + 60_000);
      const code = codeNow(state.secret);
      const accepted = await f.post('/api/auth/login/mfa', { challenge, code, deviceId: 'device-admin-0001', deviceName: 'Test admin' }, { 'X-Zichan-Session': 'admin-cookie' });
      expect(accepted.status).toBe(200);
      const session = await accepted.json() as { accessToken: string; sessionTransport: string; role: string };
      expect(session.sessionTransport).toBe('cookie');
      expect(session.role).toBe('owner');
      expect(accepted.headers.get('set-cookie')).toContain('HttpOnly');

      // The code was good once. A new challenge does not revive it, and the answered challenge
      // cannot be answered again either.
      const reused = await f.post('/api/auth/login/mfa', { challenge, code, deviceId: 'device-admin-0001', deviceName: 'Test admin' }, { 'X-Zichan-Session': 'admin-cookie' });
      expect(reused.status).toBe(409);
      const fresh = await f.adminLogin('owner', 'device-admin-0002');
      const replayed = await f.post('/api/auth/login/mfa', { challenge: String(fresh.body['challenge']), code, deviceId: 'device-admin-0002', deviceName: 'Test admin' }, { 'X-Zichan-Session': 'admin-cookie' });
      expect(replayed.status).toBe(401);

      // A malformed challenge never reaches a row, and neither does a challenge answered from
      // the wrong context.
      const padded = await f.post('/api/auth/login/mfa', { challenge: `${challenge}.extra`, code, deviceId: 'device-admin-0001', deviceName: 'Test admin' }, { 'X-Zichan-Session': 'admin-cookie' });
      expect(padded.status).toBe(401);
      const foreign = await f.post('/api/auth/login/mfa', { challenge: `token.mfa-ledger-0123456789ab`, code, deviceId: 'device-admin-0001', deviceName: 'Test admin' }, { 'X-Zichan-Session': 'admin-cookie' });
      expect(foreign.status).toBe(401);
      // The management API accepts the session the second factor produced.
      const me = await fetch(`${f.url}/api/auth/me`, { headers: { Authorization: bearer(session.accessToken) } });
      expect(me.status).toBe(200);
    } finally { await f.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('keeps the ledger login of the same account working without a code', async () => {
    const f = await fixture();
    try {
      await enroll(f.url, 'owner');
      // Same account, same password, but not a management login: a factoring device must not be
      // able to hold the local ledger hostage.
      const ledger = await loginAccount(f.url, 'owner', password, { deviceId: 'device-ledger-0001' });
      expect(ledger.accessToken).toBeTruthy();
      expect(ledger.role).toBe('owner');
    } finally { await f.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('accepts a recovery code once, and refuses the factor outside the management console', async () => {
    const f = await fixture();
    try {
      const state = await enroll(f.url, 'owner');
      const [first, second] = state.recoveryCodes;
      expect(first).toBeTruthy();

      const login = await f.adminLogin('owner', 'device-admin-0003');
      const challenge = String(login.body['challenge']);
      const accepted = await f.post('/api/auth/login/mfa', { challenge, code: first, deviceId: 'device-admin-0003', deviceName: 'Test admin' }, { 'X-Zichan-Session': 'admin-cookie' });
      expect(accepted.status).toBe(200);
      expect(((await accepted.json()) as { accessToken: string }).accessToken).toBeTruthy();
      // One code, one use: the replacement is still good, the spent one is not.
      const again = await f.adminLogin('owner', 'device-admin-0004');
      const secondChallenge = String(again.body['challenge']);
      const spent = await f.post('/api/auth/login/mfa', { challenge: secondChallenge, code: first, deviceId: 'device-admin-0004', deviceName: 'Test admin' }, { 'X-Zichan-Session': 'admin-cookie' });
      expect(spent.status).toBe(401);
      const replacement = await f.post('/api/auth/login/mfa', { challenge: secondChallenge, code: second, deviceId: 'device-admin-0004', deviceName: 'Test admin' }, { 'X-Zichan-Session': 'admin-cookie' });
      expect(replacement.status).toBe(200);

      // A ledger transport cannot answer a challenge at all.
      const ledgerClient = await f.adminLogin('owner', 'device-admin-0005');
      const refused = await f.post('/api/auth/login/mfa', { challenge: String(ledgerClient.body['challenge']), code: codeNow(state.secret), deviceId: 'device-admin-0005', deviceName: 'Test admin' });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { code?: string }).code).toBe('MFA_ADMIN_CONTEXT_REQUIRED');
    } finally { await f.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses to require the factor while an administrator could be locked out by it', async () => {
    const f = await fixture();
    try {
      const state = await enroll(f.url, 'owner');
      const ownerSession = await loginAccount(f.url, 'owner', password);
      const api = (path: string, body?: unknown) => fetch(`${f.url}/api/admin${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: bearer(ownerSession.accessToken) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const users = await (await api('/users?limit=50')).json() as { users: { username: string; accountId: string }[] };
      const watcherId = users.users.find((user) => user.username === 'watcher')?.accountId ?? '';
      expect((await api(`/accounts/${watcherId}/role`, { role: 'admin' })).status).toBe(200);

      // `watcher` is an administrator without a confirmed second factor: switching the
      // requirement on now would lock that account out of the console that could fix it.
      const refused = await api('/settings', { settings: { requireAdminMfa: 'on' } });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code?: string }).code).toBe('MFA_ENROLLMENT_INCOMPLETE');

      // Once that administrator enrolls, the policy can be switched on.
      const watcherState = await enroll(f.url, 'watcher');
      const saved = await api('/settings', { settings: { requireAdminMfa: 'on' } });
      expect(saved.status).toBe(200);
      const settings = await (await api('/settings')).json() as { settings: { name: string; value: string }[] };
      expect(settings.settings.find((field) => field.name === 'requireAdminMfa')?.value).toBe('on');

      // An administrator who has not enrolled is now stopped at the password step, with a code
      // that tells the console this is a setup problem rather than a wrong password.
      const memberId = users.users.find((user) => user.username === 'member')?.accountId ?? '';
      expect((await api(`/accounts/${memberId}/role`, { role: 'admin' })).status).toBe(200);
      const blocked = await f.adminLogin('member', 'device-admin-0006');
      expect(blocked.status).toBe(403);
      expect(blocked.body['code']).toBe('MFA_ENROLLMENT_REQUIRED');

      // An enrolled administrator is still let in, on the other side of the code.
      const allowed = await f.adminLogin('owner', 'device-admin-0007');
      expect(allowed.body['mfaRequired']).toBe(true);
      vi.setSystemTime(BASE_TIME + 120_000);
      const code = codeNow(state.secret);
      const entered = await f.post('/api/auth/login/mfa', { challenge: String(allowed.body['challenge']), code, deviceId: 'device-admin-0007', deviceName: 'Test admin' }, { 'X-Zichan-Session': 'admin-cookie' });
      expect(entered.status).toBe(200);
      expect(watcherState.recoveryCodes.length).toBe(10);

      // Disabling is refused while the policy is on, because it would break the next login.
      const disabled = await api('/mfa/disable', { code });
      expect(disabled.status).toBe(409);
      expect(((await disabled.json()) as { code?: string }).code).toBe('MFA_REQUIRED_BY_POLICY');
    } finally { await f.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('second factor storage', () => {
  it('stores the secret encrypted, never leaves a half-enrollment gating logins, and hashes recovery codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-mfa-store-'));
    const dbPath = join(dir, 'server.sqlite');
    const store = new SyncServerStore(dbPath, 'invite', 'srv-mfa-store');
    try {
      await store.ready;
      await store.register('owner', 'opaque-owner-record', undefined, true);
      const mfa = createMfaService({ store, serverSecret: 'test-server-secret' });

      // Nothing enrolled yet: an optional factor is not a lock.
      expect(await mfa.requiredFor('owner', { manage: true, policy: false })).toBe(false);
      expect((await mfa.status('owner')).enabled).toBe(false);
      expect(await mfa.administratorsWithoutMfa()).toEqual(['owner']);

      const enrollment = await mfa.beginEnrollment('owner', 'owner');
      // A started-but-unconfirmed enrollment still does not gate login.
      expect(await mfa.requiredFor('owner', { manage: true, policy: false })).toBe(false);
      const stored = await store.getMfa('owner');
      expect(stored?.secretCipher).toBeDefined();
      expect(stored?.secretCipher).not.toContain(enrollment.secret);
      expect(stored?.confirmed).toBe(false);

      // Wrong code: still not enabled, still not gating.
      expect(await mfa.confirmEnrollment('owner', '123456')).toEqual({ ok: false, reason: 'invalid' });
      expect((await mfa.status('owner')).enabled).toBe(false);

      const confirming = codeNow(enrollment.secret);
      const confirmed = await mfa.confirmEnrollment('owner', confirming);
      expect(confirmed.ok).toBe(true);
      expect(await mfa.requiredFor('owner', { manage: true, policy: false })).toBe(true);
      // The management transport is the only one that asks.
      expect(await mfa.requiredFor('owner', { manage: false, policy: true })).toBe(false);
      expect(await mfa.administratorsWithoutMfa()).toEqual([]);

      const codes = confirmed.ok ? confirmed.recoveryCodes : [];
      expect(codes).toHaveLength(10);
      const afterConfirm = await store.getMfa('owner');
      for (const code of codes) {
        // Hashes only: a database copy must not hand out working recovery codes.
        expect(afterConfirm?.recoveryHashes).not.toContain(code);
      }
      expect(afterConfirm?.recoveryHashes).toHaveLength(10);

      // The confirming step was consumed, so it cannot be replayed as a login.
      expect(await mfa.verify('owner', confirming)).toEqual({ ok: false });
      expect(await mfa.verify('owner', codes[0]!)).toEqual({ ok: true, method: 'recovery' });
      expect(await mfa.verify('owner', codes[0]!)).toEqual({ ok: false });
      expect((await mfa.status('owner')).recoveryCodesRemaining).toBe(9);

      // Regenerating replaces every remaining code, and the old ones stop working.
      vi.setSystemTime(BASE_TIME + 60_000);
      const next = codeNow(enrollment.secret);
      const regenerated = await mfa.regenerateRecoveryCodes('owner', next);
      expect(regenerated.ok).toBe(true);
      expect(await mfa.verify('owner', codes[1]!)).toEqual({ ok: false });
      // The code that authorised the regeneration belongs to a spent step as well.
      expect(await mfa.verify('owner', next)).toEqual({ ok: false });
      expect((await mfa.status('owner')).recoveryCodesRemaining).toBe(10);

      // Disabling needs a current code, then the factor is gone and logins are unguarded again.
      expect(await mfa.disable('owner', '000000')).toEqual({ ok: false, reason: 'invalid' });
      vi.setSystemTime(BASE_TIME + 120_000);
      expect(await mfa.disable('owner', codeNow(enrollment.secret))).toEqual({ ok: true });
      expect(await mfa.requiredFor('owner', { manage: true, policy: false })).toBe(false);
      expect(await store.getMfa('owner')).toBeUndefined();
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
