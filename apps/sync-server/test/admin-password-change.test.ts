import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { currentStep, totpAtStep } from '../src/totp.js';

const accountPassword = ['admin', 'change', 'password', '0001'].join('-');
const nextPassword = ['admin', 'change', 'password', '0002'].join('-');

/**
 * The console's "change my own password" entry point.
 *
 * The server route already existed for the ledger app; what this pins is the shape the console
 * depends on: the authorization is a fresh password proof (not the console's own session), it is
 * good for exactly one redemption, and the change revokes every session the account had — which
 * is why the console signs the operator out afterwards instead of leaving a dead session on screen.
 *
 * Sessions here are token sessions. A cookie session additionally requires a same-origin browser
 * request, which only a browser can produce; the browser path is covered end to end separately.
 */
async function fixture() {
  const server = createTestSyncServer();
  await server.ready;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'operator', accountPassword, { ownerSetupToken: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'bystander', accountPassword);
  const db = new NodeSqliteDriver(join(server.dataDir, 'server.sqlite'));
  return { server, url, db, close: async () => { await db.close(); server.server.closeAllConnections(); await server.close(); } };
}

/** Signs in the way the console does: the console session plus a throwaway proof session. */
async function consoleAndProof(url: string, username: string, password: string) {
  const consoleSession = await loginAccount(url, username, password);
  const proof = await loginAccount(url, username, password);
  return { consoleSession, proof };
}

const authorize = (url: string, token: string) => fetch(`${url}/api/auth/password-change/authorize`, {
  method: 'POST', headers: { Authorization: 'Bearer ' + token },
});

describe('console self-service password change', () => {
  it('changes the password from a fresh proof and signs every session out afterwards', async () => {
    const f = await fixture();
    try {
      const { consoleSession, proof } = await consoleAndProof(f.url, 'operator', accountPassword);
      const response = await authorize(f.url, proof.accessToken);
      expect(response.status).toBe(200);
      const { code, expiresAt } = await response.json() as { code: string; expiresAt: string };
      expect(expiresAt).toBeDefined();
      await registerAccount(f.url, 'operator', nextPassword, { passwordResetCode: code });

      // The old password is gone, the new one works, and the identity is unchanged.
      await expect(loginAccount(f.url, 'operator', accountPassword)).rejects.toThrow();
      const reconnected = await loginAccount(f.url, 'operator', nextPassword);
      expect(reconnected.accountId).toBe(proof.accountId);
      expect(reconnected.role).toBe('owner');

      // Both the console session and the proof session are revoked, not just the proof.
      const alive = await f.db.all<{ session_id: string }>('SELECT session_id FROM sync_sessions WHERE username = ? AND revoked_at IS NULL', ['operator']);
      const ids = alive.map((row) => row.session_id);
      expect(ids).not.toContain(consoleSession.session.id);
      expect(ids).not.toContain(proof.session.id);
      // Someone else's sessions are untouched.
      expect((await loginAccount(f.url, 'bystander', accountPassword)).accountId).toBeDefined();
    } finally { await f.close(); }
  });

  it('refuses a proof session older than five minutes and a code that was already redeemed', async () => {
    const f = await fixture();
    try {
      const { proof } = await consoleAndProof(f.url, 'operator', accountPassword);
      await f.db.run('UPDATE sync_sessions SET created_at = ? WHERE session_id = ?', [new Date(Date.now() - 6 * 60_000).toISOString(), proof.session.id]);
      expect((await authorize(f.url, proof.accessToken)).status).toBe(403);

      await f.db.run('UPDATE sync_sessions SET created_at = ? WHERE session_id = ?', [new Date().toISOString(), proof.session.id]);
      const { code } = await (await authorize(f.url, proof.accessToken)).json() as { code: string };
      await registerAccount(f.url, 'operator', nextPassword, { passwordResetCode: code });
      // A second redemption of the same authorization is refused, not silently accepted.
      await expect(registerAccount(f.url, 'operator', ['admin', 'change', 'password', '0003'].join('-'), { passwordResetCode: code })).rejects.toThrow();
      expect((await authorize(f.url, proof.accessToken)).status).toBe(401);
    } finally { await f.close(); }
  });

  it('audits the authorization without recording the authorization code', async () => {
    const f = await fixture();
    try {
      const { proof } = await consoleAndProof(f.url, 'operator', accountPassword);
      const { code } = await (await authorize(f.url, proof.accessToken)).json() as { code: string };
      await registerAccount(f.url, 'operator', nextPassword, { passwordResetCode: code });
      const audit = await f.db.all<{ action: string }>('SELECT action FROM server_admin_audit');
      const actions = audit.map((row) => row.action);
      expect(actions).toContain('password-change-authorize');
      expect(actions).toContain('password-reset-complete');
      const stored = await f.db.all<{ after_json: string }>('SELECT after_json FROM server_admin_audit');
      expect(JSON.stringify(stored)).not.toContain(code);
    } finally { await f.close(); }
  });

  it('still changes the password after the second factor is enrolled', async () => {
    const f = await fixture();
    try {
      // The factor guards the console login, not this operation: an administrator must not be
      // locked out of changing their own password by a rule that only covers the console.
      const first = await consoleAndProof(f.url, 'operator', accountPassword);
      const enroll = await fetch(`${f.url}/api/admin/mfa/enroll`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + first.consoleSession.accessToken },
      });
      expect(enroll.status).toBe(200);
      const { secret } = await enroll.json() as { secret: string };
      const code = totpAtStep(secret, currentStep(Date.now()));
      const confirm = await fetch(`${f.url}/api/admin/mfa/confirm`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + first.consoleSession.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, requestId: 'mfa-confirm-test' }),
      });
      expect(confirm.status).toBe(200);

      const proof = await loginAccount(f.url, 'operator', accountPassword);
      expect((await authorize(f.url, proof.accessToken)).status).toBe(200);
    } finally { await f.close(); }
  });
});
