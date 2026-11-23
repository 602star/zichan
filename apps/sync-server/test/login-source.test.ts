import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import { loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { totpCode } from '../src/totp.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

const password = 'correct-login-source-password';
async function fixture(run: (url: string, driver: NodeSqliteDriver) => Promise<void>) {
  const server = createTestSyncServer({ trustedProxies: ['loopback'], allowInsecureHttp: true });
  await server.ready;
  await new Promise<void>(resolve => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing HTTP listener');
  const url = `http://127.0.0.1:${address.port}`;
  const driver = new NodeSqliteDriver(join(server.dataDir, 'server.sqlite'));
  try {
    await registerAccount(url, 'owner', password, { ownerSetupToken: OWNER_SETUP_TOKEN });
    await run(url, driver);
  } finally { await driver.close(); await server.close(); }
}
const post = (url: string, path: string, body: unknown, ip: string, transport?: string) => fetch(url + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip,
    Origin: url, ...(transport ? { 'X-Zichan-Session': transport } : {}) }, body: JSON.stringify(body),
});
async function prepare(url: string, transport?: string) {
  await opaque.ready;
  const start = opaque.client.startLogin({ password });
  const response = await post(url, '/api/auth/login/start', {
    username: 'owner', startLoginRequest: start.startLoginRequest,
    sessionContext: transport === 'admin-cookie' ? 'admin' : 'ledger',
  }, '104.22.101.160', transport);
  expect(response.status).toBe(200);
  const pending = await response.json();
  const input = { clientLoginState: start.clientLoginState, loginResponse: pending.loginResponse,
    password, identifiers: { client: 'owner', server: pending.serverId }, keyStretching: 'memory-constrained' as const };
  expect(opaque.client.finishLogin({ ...input, password: 'wrong-account-password' })).toBeFalsy();
  const proof = opaque.client.finishLogin(input)!;
  return { loginId: pending.loginId, finishLoginRequest: proof.finishLoginRequest,
    deviceId: 'device-source-test', deviceName: 'Source test browser' };
}

describe('OPAQUE login through changing proxy sources', () => {
  it.each([undefined, 'cookie', 'admin-cookie'])('accepts a valid proof across IPs using %s without mixing cookies', async transport => {
    await fixture(async (url, driver) => {
      const body = await prepare(url, transport);
      const response = await post(url, '/api/auth/login/finish', body, '104.22.101.161', transport);
      expect(response.status).toBe(200);
      const session = await response.json();
      expect(session.session.username).toBe('owner');
      const cookie = response.headers.get('set-cookie');
      if (transport) expect(cookie).toMatch(new RegExp(`^${transport === 'admin-cookie' ? 'zichan_admin_session' : 'zichan_session_v2'}=`));
      else expect(cookie).toBeNull();
      const changed = await driver.get<{ level: string; detail_json: string }>("SELECT level, detail_json FROM server_logs WHERE action = 'login_source_changed'");
      expect(changed?.level).toBe('info');
      expect(JSON.parse(changed!.detail_json)).toMatchObject({ startIp: '104.22.101.160', finishIp: '104.22.101.161', peerIp: '127.0.0.1', ipSource: 'trusted_xff' });
      expect(await driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM obs_login_events WHERE json_extract(record_json, '$.result') = 'failure'")).toMatchObject({ n: 0 });
    });
  });

  it('rejects invalid proofs across IPs and consumes the exchange before it can be replayed', async () => {
    await fixture(async (url, driver) => {
      const body = await prepare(url);
      const invalid = { ...body, finishLoginRequest: body.finishLoginRequest.replace(/^./, c => c === '0' ? '1' : '0') };
      const rejected = await post(url, '/api/auth/login/finish', invalid, '104.22.101.161');
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toEqual({ code: 'INVALID_CREDENTIALS', error: '账号或密码不正确' });
      const replay = await post(url, '/api/auth/login/finish', body, '104.22.101.160');
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({ code: 'LOGIN_STATE_INVALID' });
      const events = await driver.all<{ record_json: string }>('SELECT record_json FROM obs_login_events ORDER BY at');
      expect(events.map(row => JSON.parse(row.record_json).reasonCode)).toContain('INVALID_CREDENTIALS');
      expect(events.map(row => JSON.parse(row.record_json).reasonCode)).toContain('LOGIN_STATE_INVALID');
      expect(JSON.stringify(events)).not.toContain(body.finishLoginRequest);
    });
  });

  it('allows only one concurrent finish and distinguishes expiry from a wrong password', async () => {
    await fixture(async (url, driver) => {
      const body = await prepare(url);
      const responses = await Promise.all(['104.22.101.160', '104.22.101.161']
        .map(ip => post(url, '/api/auth/login/finish', body, ip)));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const expired = await prepare(url);
      await driver.run('UPDATE sync_opaque_login_states SET expires_at = ? WHERE login_id = ?', ['2000-01-01T00:00:00.000Z', expired.loginId]);
      const response = await post(url, '/api/auth/login/finish', expired, '104.22.101.161');
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ code: 'LOGIN_STATE_EXPIRED', error: '登录验证已超时，请重新登录' });
    });
  });

  it('still requires an administrator second factor when all three request sources differ', async () => {
    await fixture(async (url) => {
      const setup = await loginAccount(url, 'owner', password);
      const admin = (path: string, body: unknown) => fetch(`${url}/api/admin${path}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${setup.accessToken}` }, body: JSON.stringify(body) });
      const enrollment = await (await admin('/mfa/enroll', {})).json();
      const confirmation = await admin('/mfa/confirm', { code: totpCode(enrollment.secret, Date.now()) });
      expect(confirmation.status).toBe(200);
      const { recoveryCodes } = await confirmation.json();
      const body = await prepare(url, 'admin-cookie');
      const response = await post(url, '/api/auth/login/finish', body, '104.22.101.161', 'admin-cookie');
      expect(response.status).toBe(200);
      const pending = await response.json();
      expect(pending.mfaRequired).toBe(true);
      expect(pending.accessToken).toBeUndefined();
      expect(response.headers.get('set-cookie')).toBeNull();
      const identity = { challenge: pending.challenge, deviceId: body.deviceId, deviceName: body.deviceName };
      expect((await post(url, '/api/auth/login/mfa', { ...identity, code: 'invalid-code' }, '104.22.101.162', 'admin-cookie')).status).toBe(401);
      const completed = await post(url, '/api/auth/login/mfa', { ...identity, code: recoveryCodes[0] }, '104.22.101.163', 'admin-cookie');
      expect(completed.status).toBe(200);
      expect(completed.headers.get('set-cookie')).toMatch(/^zichan_admin_session=/);
      expect((await post(url, '/api/auth/login/mfa', { ...identity, code: recoveryCodes[0] }, '104.22.101.164', 'admin-cookie')).status).toBe(409);
    });
  });
});
