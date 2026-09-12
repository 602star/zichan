import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as opaque from '@serenity-kit/opaque';
import { SyncServerStore } from '../src/store.js';
import { createServerBackup, restoreServerBackup, verifyServerBackup } from '../src/backup.js';
import { registerAccount, loginAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

async function fixture() {
  const server = createTestSyncServer();
  await server.ready;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'reviewer', 'reviewer-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'recover-user', 'old-user-password');
  const owner = await loginAccount(url, 'reviewer', 'reviewer-password');
  const member = await loginAccount(url, 'recover-user', 'old-user-password');
  const api = (token: string, path: string, body: unknown = {}) => fetch(`${url}/api/admin${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const issue = async () => {
    const response = await api(owner.accessToken, `/accounts/${member.accountId}/password-reset`);
    expect(response.status).toBe(200);
    return await response.json() as { code: string; expiresAt: string };
  };
  const db = new NodeSqliteDriver(join(server.dataDir, 'server.sqlite'));
  return { server, url, owner, member, api, issue, db, close: async () => { await db.close(); await server.close(); } };
}

describe('administrator-reviewed password recovery', () => {
  it('allows a fresh session to change its own password and rejects revoked or stale sessions', async () => {
    const f = await fixture();
    try {
      const authorize = () => fetch(`${f.url}/api/auth/password-change/authorize`, { method: 'POST', headers: { Authorization: `Bearer ${f.member.accessToken}` } });
      await f.db.run('UPDATE sync_sessions SET created_at = ? WHERE session_id = ?', [new Date(Date.now() - 6 * 60_000).toISOString(), f.member.session.id]);
      expect((await authorize()).status).toBe(403);
      await f.db.run('UPDATE sync_sessions SET created_at = ? WHERE session_id = ?', [new Date().toISOString(), f.member.session.id]);
      const response = await authorize();
      expect(response.status).toBe(200);
      const { code } = await response.json() as { code: string };
      await registerAccount(f.url, 'recover-user', 'changed-password', { passwordResetCode: code });
      expect((await authorize()).status).toBe(401);
      await expect(loginAccount(f.url, 'recover-user', 'old-user-password')).rejects.toThrow();
      expect((await loginAccount(f.url, 'recover-user', 'changed-password')).accountId).toBe(f.member.accountId);
      await expect(loginAccount(f.url, 'reviewer', 'reviewer-password')).resolves.toBeDefined();
    } finally { await f.close(); }
  });
  it('restores managed ledger custody after an account password reset', async () => {
    const f = await fixture();
    try {
      const response = await fetch(`${f.url}/api/v3/protection/initialize`, { method: 'POST', headers: { Authorization: `Bearer ${f.member.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'managed' }) });
      expect(response.status).toBe(200);
      const before = await response.json();
      const code = await f.issue();
      await registerAccount(f.url, 'recover-user', 'new-account-password', { passwordResetCode: code.code });
      const next = await loginAccount(f.url, 'recover-user', 'new-account-password');
      const after = await (await fetch(`${f.url}/api/v3/protection`, { headers: { Authorization: `Bearer ${next.accessToken}` } })).json();
      expect(after.secret).toBe(before.secret);
      expect(after.envelope).toEqual(before.envelope);
      expect(after.replica.ledgerId).toBe(before.replica.ledgerId);
    } finally { await f.close(); }
  });
  it('rejects login begun before reset and session creation with stale credentials', async () => {
    const f = await fixture();
    const store = new SyncServerStore(join(f.server.dataDir, 'server.sqlite'), 'open', f.server.serverId);
    try {
      await store.ready;
      const previous = await f.db.get<{ opaque_registration_record: string }>('SELECT opaque_registration_record FROM sync_users WHERE username = ?', ['recover-user']);
      const start = opaque.client.startLogin({ password: 'old-user-password' });
      const post = (path: string, body: unknown) => fetch(`${f.url}/api/auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const response = await post('login/start', { username: 'recover-user', startLoginRequest: start.startLoginRequest });
      const pending = await response.json() as { loginId: string; loginResponse: string; serverId: string };
      const finish = opaque.client.finishLogin({ clientLoginState: start.clientLoginState, loginResponse: pending.loginResponse, password: 'old-user-password', identifiers: { client: 'recover-user', server: pending.serverId }, keyStretching: 'memory-constrained' });
      expect(finish).toBeTruthy();
      const issued = await f.issue();
      await registerAccount(f.url, 'recover-user', 'new-user-password', { passwordResetCode: issued.code });
      expect((await post('login/finish', { loginId: pending.loginId, finishLoginRequest: finish!.finishLoginRequest, deviceId: 'stale-device', deviceName: 'stale' })).status).toBe(401);
      await expect(store.createSession({ id: 'stale-session', username: 'recover-user', deviceId: 'stale-device', deviceName: 'stale', refreshHash: 'stale', expiresAt: new Date(Date.now() + 60_000).toISOString(), expectedRegistrationRecord: previous!.opaque_registration_record })).rejects.toMatchObject({ code: 'CREDENTIALS_CHANGED' });
      expect(await f.db.get('SELECT session_id FROM sync_sessions WHERE session_id = ?', ['stale-session'])).toBeUndefined();
    } finally { await store.close(); await f.close(); }
  });

  it('restores data without reviving recovery codes, pending logins or sessions', async () => {
    const f = await fixture();
    const root = mkdtempSync(join(tmpdir(), 'zichan-recovery-backup-'));
    try {
      await f.issue();
      const start = opaque.client.startLogin({ password: 'old-user-password' });
      await fetch(`${f.url}/api/auth/login/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'recover-user', startLoginRequest: start.startLoginRequest }) });
      await createServerBackup(f.server.dataDir, join(root, 'backup'));
      await restoreServerBackup(join(root, 'backup'), join(root, 'restored'));
      const restored = new NodeSqliteDriver(join(root, 'restored', 'server.sqlite'));
      try {
        expect(await restored.all('SELECT account_id FROM account_password_resets')).toEqual([]);
        expect(await restored.all('SELECT * FROM sync_opaque_login_states')).toEqual([]);
        expect(await restored.all('SELECT session_id FROM sync_sessions WHERE revoked_at IS NULL')).toEqual([]);
        expect((await restored.all('SELECT username FROM sync_users')).length).toBe(2);
      } finally { await restored.close(); }
      expect((await verifyServerBackup(join(root, 'backup'))).ok).toBe(true);
      expect(await f.db.get('SELECT account_id FROM account_password_resets')).toBeTruthy();
    } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('stores only a digest, consumes once, preserves identity and revokes all old sessions', async () => {
    const f = await fixture();
    try {
      expect((await f.api(f.member.accessToken, `/accounts/${f.member.accountId}/password-reset`)).status).toBe(403);
      expect((await f.api(f.owner.accessToken, `/accounts/${f.owner.accountId}/password-reset`)).status).toBe(403);
      const issued = await f.issue();
      const stored = await f.db.get<{ code_hash: string }>('SELECT code_hash FROM account_password_resets WHERE account_id = ?', [f.member.accountId]);
      expect(stored?.code_hash).toBe(createHash('sha256').update(issued.code).digest('hex'));
      await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}/commits`, { commitQuotaBytes: 64 * 1024 ** 2 });
      await registerAccount(f.url, 'recover-user', 'new-user-password', { passwordResetCode: issued.code });
      await expect(loginAccount(f.url, 'recover-user', 'old-user-password')).rejects.toThrow();
      const updated = await loginAccount(f.url, 'recover-user', 'new-user-password');
      expect(updated.accountId).toBe(f.member.accountId);
      expect(updated.role).toBe('member');
      expect((await fetch(`${f.url}/api/auth/me`, { headers: { Authorization: `Bearer ${f.member.accessToken}` } })).status).toBe(401);
      expect(await f.db.get('SELECT commit_quota_bytes FROM sync_user_quotas WHERE username = ?', ['recover-user'])).toEqual({ commit_quota_bytes: 64 * 1024 ** 2 });
      expect(await f.db.get('SELECT account_id FROM account_password_resets WHERE account_id = ?', [f.member.accountId])).toBeUndefined();
      await expect(registerAccount(f.url, 'recover-user', 'another-password', { passwordResetCode: issued.code })).rejects.toThrow();
      const audit = await f.db.all('SELECT * FROM server_admin_audit');
      expect(JSON.stringify(audit)).not.toContain(issued.code);
      expect(JSON.stringify(audit)).toContain('password-reset-complete');
    } finally { await f.close(); }
  });

  it('invalidates older codes, rejects expiration and handles simultaneous redemption atomically', async () => {
    const f = await fixture();
    try {
      const old = await f.issue();
      const current = await f.issue();
      await expect(registerAccount(f.url, 'recover-user', 'reset-password', { passwordResetCode: old.code })).rejects.toThrow();
      await f.db.run('UPDATE account_password_resets SET expires_at = ?', ['2000-01-01T00:00:00.000Z']);
      await expect(registerAccount(f.url, 'recover-user', 'reset-password', { passwordResetCode: current.code })).rejects.toThrow();
      const fresh = await f.issue();
      const attempts = await Promise.allSettled([1, 2].map(() => registerAccount(f.url, 'recover-user', 'reset-password', { passwordResetCode: fresh.code })));
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const another = await f.issue();
      await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}/state`, { disabled: true });
      await expect(registerAccount(f.url, 'recover-user', 'reset-password', { passwordResetCode: another.code })).rejects.toThrow();
    } finally { await f.close(); }
  });
});
