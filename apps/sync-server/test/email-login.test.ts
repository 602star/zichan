import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import { loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

const password = 'email-login-password';

async function fixture(delivery = false) {
  const sent: string[] = [];
  const server = createTestSyncServer(delivery ? { accountEmailSender: async (_to, _subject, body) => { sent.push(body); } } : {});
  await server.ready;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', password, { ownerSetupToken: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'member', password);
  const owner = await loginAccount(url, 'owner', password);
  const member = await loginAccount(url, 'member', password);
  const store = new SyncServerStore(join(server.dataDir, 'server.sqlite'), 'open', server.serverId);
  await store.ready;
  const db = new NodeSqliteDriver(join(server.dataDir, 'server.sqlite'));
  const call = (token: string | undefined, path = '', method = 'GET', body?: object) => fetch(`${url}/api/auth/email${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const bind = (token: string, email: string) => call(token, '', 'PUT', { email });
  return { server, url, sent, owner, member, store, db, call, bind,
    close: async () => { await db.close(); await store.close(); await server.close(); } };
}

describe('email aliases for password login', () => {
  it('binds without SMTP and logs into the canonical account without granting email recovery', async () => {
    const f = await fixture();
    try {
      expect((await f.bind('', 'owner@example.com')).status).toBe(401);
      expect((await f.bind(f.owner.accessToken, 'invalid-address')).status).toBe(400);
      const bound = await f.bind(f.owner.accessToken, ' Owner@Example.COM ');
      expect(bound.status).toBe(200);
      expect(bound.headers.get('cache-control')).toBe('no-store');
      const state = await bound.json();
      expect(state).toMatchObject({ email: 'owner@example.com', available: false, quotaNotifications: false });
      expect(state.verifiedAt).toBeUndefined();
      const session = await loginAccount(f.url, ' OWNER@example.COM ', password);
      expect(session.accountId).toBe(f.owner.accountId);
      expect(session.session.username).toBe('owner');
      expect(session.role).toBe('owner');
      expect((await loginAccount(f.url, 'owner', password)).accountId).toBe(f.owner.accountId);
      await expect(loginAccount(f.url, 'owner@example.com', 'incorrect-password')).rejects.toThrow();
      await expect(loginAccount(f.url, 'unknown@example.com', password)).rejects.toThrow();
      expect(await f.store.issueEmailPasswordReset('owner', 'a'.repeat(64), new Date(Date.now() + 600_000).toISOString())).toBeNull();
      expect((await f.call(f.owner.accessToken, '/preferences', 'PUT', { quotaNotifications: true })).status).toBe(400);
      await f.store.enqueueQuotaEmail('owner', 'unverified-quota', '提醒', '不应发送');
      expect(await f.store.dueAccountEmails()).toEqual([]);
      expect((await f.call(f.owner.accessToken, '', 'DELETE')).status).toBe(200);
      await expect(loginAccount(f.url, 'owner@example.com', password)).rejects.toThrow();
      expect((await loginAccount(f.url, 'owner', password)).accountId).toBe(f.owner.accountId);
    } finally { await f.close(); }
  });

  it('allows only one account to claim an address, including concurrent requests', async () => {
    const f = await fixture(true);
    try {
      const claims = await Promise.all([
        f.bind(f.owner.accessToken, 'shared@example.com'),
        f.bind(f.member.accessToken, 'SHARED@example.com'),
      ]);
      expect(claims.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = claims[0]!.status === 200 ? f.owner : f.member;
      const loser = winner === f.owner ? f.member : f.owner;
      const duplicate = await f.bind(loser.accessToken, 'shared@example.com');
      expect(await duplicate.json()).toMatchObject({ code: 'EMAIL_IN_USE' });
      expect((await f.call(loser.accessToken, '/request', 'POST', { email: 'shared@example.com' })).status).toBe(409);
      expect(f.sent).toEqual([]);
      expect((await loginAccount(f.url, 'shared@example.com', password)).accountId).toBe(winner.accountId);
    } finally { await f.close(); }
  });

  it('preserves verification on an unchanged binding and clears old recovery, codes and mail when changed', async () => {
    const f = await fixture(true);
    try {
      await f.bind(f.owner.accessToken, 'first@example.com');
      expect((await f.call(f.owner.accessToken, '/request', 'POST', { email: 'first@example.com' })).status).toBe(200);
      const code = /\d{8}/.exec(f.sent[0]!)![0];
      expect((await f.call(f.owner.accessToken, '/verify', 'POST', { code })).status).toBe(200);
      await f.store.setQuotaEmailNotifications('owner', true);
      const verified = await f.store.accountEmail('owner');
      expect(verified.verifiedAt).toBeTruthy();
      await f.bind(f.owner.accessToken, 'FIRST@example.com');
      expect(await f.store.accountEmail('owner')).toEqual(verified);
      expect(await f.store.issueEmailPasswordReset('owner', 'a'.repeat(64), new Date(Date.now() + 600_000).toISOString())).toBeTruthy();
      await f.store.enqueueQuotaEmail('owner', 'old-quota', '提醒', '不应发送');
      expect((await f.bind(f.owner.accessToken, 'next@example.com')).status).toBe(200);
      expect(await f.store.accountEmail('owner')).toEqual({ email: 'next@example.com', quotaNotifications: false });
      expect(await f.db.get('SELECT 1 FROM account_password_email_codes WHERE account_id = ?', [f.owner.accountId!])).toBeUndefined();
      expect(await f.store.dueAccountEmails()).toEqual([]);
      expect((await f.call(f.owner.accessToken, '/verify', 'POST', { code })).status).toBe(400);
      await expect(loginAccount(f.url, 'first@example.com', password)).rejects.toThrow();
      expect((await loginAccount(f.url, 'next@example.com', password)).accountId).toBe(f.owner.accountId);
      expect(await f.db.get('SELECT window_count FROM account_email_settings WHERE username = ?', ['owner'])).toMatchObject({ window_count: 1 });
    } finally { await f.close(); }
  });

  it('rechecks ownership when verifying and cannot overwrite another account binding', async () => {
    const f = await fixture(true);
    try {
      expect((await f.call(f.owner.accessToken, '/request', 'POST', { email: 'pending@example.com' })).status).toBe(200);
      expect((await f.bind(f.member.accessToken, 'pending@example.com')).status).toBe(200);
      const code = /\d{8}/.exec(f.sent[0]!)![0];
      expect((await f.call(f.owner.accessToken, '/verify', 'POST', { code })).status).toBe(409);
      expect((await loginAccount(f.url, 'pending@example.com', password)).accountId).toBe(f.member.accountId);
      expect((await f.store.accountEmail('owner')).email).toBeUndefined();
    } finally { await f.close(); }
  });

  it('invalidates pending verification on rebinding without resetting mail limits and clears recovery on removal', async () => {
    const f = await fixture(true);
    try {
      await f.bind(f.owner.accessToken, 'pending-old@example.com');
      expect((await f.call(f.owner.accessToken, '/request', 'POST', { email: 'pending-old@example.com' })).status).toBe(200);
      const code = /\d{8}/.exec(f.sent[0]!)![0];
      await f.bind(f.owner.accessToken, 'pending-new@example.com');
      expect((await f.store.accountEmail('owner')).pendingEmail).toBeUndefined();
      expect((await f.call(f.owner.accessToken, '/verify', 'POST', { code })).status).toBe(400);
      expect((await f.call(f.owner.accessToken, '/request', 'POST', { email: 'pending-new@example.com' })).status).toBe(429);
      await f.call(f.owner.accessToken, '', 'DELETE');
      await f.bind(f.owner.accessToken, 'third@example.com');
      expect((await f.call(f.owner.accessToken, '/request', 'POST', { email: 'third@example.com' })).status).toBe(429);

      await f.bind(f.member.accessToken, 'member@example.com');
      await f.store.startEmailVerification('member', 'member@example.com', 'b'.repeat(64));
      await f.store.completeEmailVerification('member', 'b'.repeat(64));
      expect(await f.store.issueEmailPasswordReset('member', 'c'.repeat(64), new Date(Date.now() + 600_000).toISOString())).toBeTruthy();
      await f.call(f.member.accessToken, '', 'DELETE');
      expect(await f.db.get('SELECT 1 FROM account_password_email_codes WHERE account_id = ?', [f.member.accountId!])).toBeUndefined();
    } finally { await f.close(); }
  });

  it('rejects ambiguous legacy addresses and resumes email login after users resolve the duplicate', async () => {
    const f = await fixture();
    try {
      await f.db.run('INSERT INTO account_email_settings (username, email, verified_at) VALUES (?, ?, ?), (?, ?, ?)',
        ['owner', 'legacy@example.com', new Date().toISOString(), 'member', 'LEGACY@example.com', new Date().toISOString()]);
      await expect(loginAccount(f.url, 'legacy@example.com', password)).rejects.toThrow();
      expect((await loginAccount(f.url, 'owner', password)).accountId).toBe(f.owner.accountId);
      expect((await f.bind(f.member.accessToken, 'member@example.com')).status).toBe(200);
      expect((await loginAccount(f.url, 'legacy@example.com', password)).accountId).toBe(f.owner.accountId);
    } finally { await f.close(); }
  });

  it('rejects a login begun using an email that has since been removed', async () => {
    const f = await fixture();
    try {
      await f.bind(f.owner.accessToken, 'old@example.com');
      const start = opaque.client.startLogin({ password });
      const post = (path: string, body: object) => fetch(`${f.url}/api/auth/login/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const pending = await (await post('start', { username: 'old@example.com', startLoginRequest: start.startLoginRequest })).json();
      const finish = opaque.client.finishLogin({ clientLoginState: start.clientLoginState, loginResponse: pending.loginResponse,
        password, identifiers: { client: pending.credentialClientId, server: pending.credentialServerId }, keyStretching: 'memory-constrained' });
      expect(finish).toBeTruthy();
      await f.call(f.owner.accessToken, '', 'DELETE');
      expect((await post('finish', { loginId: pending.loginId, finishLoginRequest: finish!.finishLoginRequest, deviceId: 'old-email-device' })).status).toBe(401);
    } finally { await f.close(); }
  });

  it('continues to reject disabled accounts through the email alias', async () => {
    const f = await fixture();
    try {
      await f.bind(f.member.accessToken, 'member@example.com');
      await f.db.run('UPDATE sync_users SET disabled = 1 WHERE username = ?', ['member']);
      await expect(loginAccount(f.url, 'member@example.com', password)).rejects.toThrow(/disabled/);
    } finally { await f.close(); }
  });
});
