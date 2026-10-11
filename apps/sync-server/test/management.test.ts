import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { registerAccount, loginAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { SyncServerStore } from '../src/store.js';

const password = 'test-management-password';
async function fixture() {
  const server = createTestSyncServer({ basePath: '/ledger' });
  await server.ready;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const addr = server.server.address();
  if (!addr || typeof addr === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${addr.port}/ledger`;
  await registerAccount(url, 'owner', password, { ownerSetupToken: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'manager', password);
  await registerAccount(url, 'member', password);
  const owner = await loginAccount(url, 'owner', password);
  const manager = await loginAccount(url, 'manager', password);
  const member = await loginAccount(url, 'member', password);
  const api = (token: string, path: string, body?: unknown) => fetch(`${url}/api/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { server, url, owner, manager, member, api };
}

describe('server management authorization', () => {
  it('shows shared replica attachment usage and rejects quotas on a member alias', async () => {
    const f = await fixture();
    const db = new NodeSqliteDriver(join(f.server.dataDir, 'server.sqlite'));
    const store = new SyncServerStore(join(f.server.dataDir, 'server.sqlite'), 'open', f.server.serverId);
    try {
      await store.ready;
      const replica = await store.bindReplica('owner', 'ledger-admin-shared-quota-0001');
      await db.run('INSERT INTO ledger_account_routes (username, replica_id, created_at) VALUES (?, ?, ?)',
        ['member', replica.replicaId, new Date().toISOString()]);
      await db.run('INSERT INTO account_ledger_index (username, replica_id, created_at) VALUES (?, ?, ?)',
        ['member', replica.replicaId, new Date().toISOString()]);
      const detailResponse = await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}`);
      const detail = await detailResponse.json();
      expect(detailResponse.status, JSON.stringify(detail)).toBe(200);
      expect(detail.capacity).toMatchObject({ blobQuotaOwnerUsername: 'owner',
        quotaNote: expect.stringContaining('共用附件容量') });
      const response = await f.api(f.owner.accessToken,
        `/accounts/${f.member.accountId}/blobs`, { quotaBytes: 4 * 1024 ** 2 });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('REPLICA_QUOTA_OWNER');
    } finally {
      await Promise.all([store.close(), db.close(), f.server.close()]);
    }
  });

  it('paginates invitations newest first and applies exclusive state filters before pagination', async () => {
    const f = await fixture();
    const db = new NodeSqliteDriver(join(f.server.dataDir, 'server.sqlite'));
    try {
      const codes: string[] = [];
      for (let i = 0; i < 4; i++) {
        const response = await f.api(f.owner.accessToken, '/invites', { days: 7 });
        expect(response.status).toBe(200);
        codes.push((await response.json()).invite.code);
      }
      await f.api(f.owner.accessToken, `/invites/${codes[1]}/disable`, { disabled: true });
      await db.run('UPDATE registration_invite_policy SET expires_at = ? WHERE code = ?', ['2000-01-01T00:00:00.000Z', codes[2]!]);
      await db.run('UPDATE registration_invites SET used_by = ?, disabled = 1 WHERE code = ?', ['member', codes[3]!]);
      const firstResponse = await f.api(f.owner.accessToken, '/invites?limit=2');
      expect(firstResponse.headers.get('cache-control')).toBe('no-store');
      const first = await firstResponse.json();
      expect(first.invites.map((invite: { code: string }) => invite.code)).toEqual([codes[3], codes[2]]);
      // The cursor follows the ordering, and the ordering never names the invitation code: a
      // pagination URL lands in browser history, referrer headers and pasted chat messages, so a
      // live single-use credential must not be in it. This is the property the numeric cursor used
      // to provide; asserting the invariant rather than the shape keeps it protected as the list
      // gains sortable columns.
      expect(first.nextCursor).toBeTruthy();
      for (const code of codes) expect(first.nextCursor).not.toContain(code);
      const second = await (await f.api(f.owner.accessToken, `/invites?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
      expect(second.invites.map((invite: { code: string }) => invite.code)).toEqual([codes[1], codes[0]]);
      expect(second.nextCursor).toBeUndefined();
      for (const [i, state] of ['available', 'revoked', 'expired', 'used'].entries()) {
        const filtered = await (await f.api(f.owner.accessToken, `/invites?limit=1&state=${state}`)).json();
        expect(filtered.invites.map((invite: { code: string }) => invite.code)).toEqual([codes[i]]);
        expect(filtered.nextCursor).toBeUndefined();
      }
      for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'cursor=-1', 'cursor=secret', 'cursor=9007199254740992', 'state=unknown']) {
        expect((await f.api(f.owner.accessToken, `/invites?${query}`)).status).toBe(400);
      }
      expect((await f.api(f.member.accessToken, '/invites')).status).toBe(403);
    } finally { await db.close(); await f.server.close(); }
  });

  it('identifies session owners and filters devices without exposing privileged accounts to administrators', async () => {
    const f = await fixture();
    try {
      const ownerDevices = await (await f.api(f.owner.accessToken, '/devices?search=owner')).json();
      expect(ownerDevices.devices).toHaveLength(1);
      expect(ownerDevices.devices[0]).toMatchObject({ id: f.owner.session.id, accountId: f.owner.accountId, role: 'owner', username: 'owner' });
      expect(ownerDevices.devices[0]).not.toHaveProperty('refreshHash');
      await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' });
      const manager = await loginAccount(f.url, 'manager', password);
      const devices = await (await f.api(manager.accessToken, '/devices')).json();
      expect(devices.devices).toHaveLength(1);
      expect(devices.devices[0]).toMatchObject({ accountId: f.member.accountId, role: 'member' });
      expect((await (await f.api(manager.accessToken, '/devices?search=owner')).json()).devices).toEqual([]);
      expect((await f.api(manager.accessToken, `/sessions/${f.owner.session.id}/revoke`, {})).status).toBe(403);
      expect((await f.api(manager.accessToken, `/devices?search=${'x'.repeat(129)}`)).status).toBe(400);
    } finally { await f.server.close(); }
  });
  it('exposes continuation cursors for aggregate quota and device reads', async () => {
    const f = await fixture();
    try {
      for (const path of ['/quotas', '/devices']) {
        const response = await f.api(f.owner.accessToken, `${path}?limit=1`);
        expect(response.status).toBe(200);
        const first = await response.json();
        expect(first.nextCursor).toBeTruthy();
        const next = await (await f.api(f.owner.accessToken, `${path}?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
        expect(next).not.toEqual(first);
        expect((await f.api(f.owner.accessToken, `${path}?limit=0`)).status).toBe(400);
      }
    } finally { await f.server.close(); }
  });
  it('searches audit before pagination so older matching records remain visible', async () => {
    const f = await fixture();
    try {
      await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}/commits`, { commitQuotaBytes: 64 * 1024 ** 2 });
      for (let i = 0; i < 51; i++) await f.api(f.owner.accessToken, '/registration', { mode: i % 2 ? 'open' : 'invite' });
      const response = await f.api(f.owner.accessToken, '/audit?search=commit-quota');
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].targetAccountId).toBe(f.member.accountId);
      expect((await f.api(f.owner.accessToken, `/audit?search=${'x'.repeat(129)}`)).status).toBe(400);
    } finally { await f.server.close(); }
  });
  it('allows owner quotas without allowing owner disable or administrator self-escalation', async () => {
    const f = await fixture();
    try {
      for (const kind of ['commits', 'blobs']) {
        const body = kind === 'commits' ? { commitQuotaBytes: 64 * 1024 ** 2 } : { quotaBytes: 64 * 1024 ** 2 };
        expect((await f.api(f.owner.accessToken, `/accounts/${f.owner.accountId}/${kind}`, body)).status).toBe(200);
        expect((await f.api(f.member.accessToken, `/accounts/${f.owner.accountId}/${kind}`, body)).status).toBe(403);
      }
      expect((await f.api(f.owner.accessToken, `/accounts/${f.owner.accountId}/state`, { disabled: true })).status).not.toBe(200);
      await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' });
      const manager = await loginAccount(f.url, 'manager', password);
      expect((await f.api(manager.accessToken, `/accounts/${manager.accountId}/commits`, { commitQuotaBytes: 64 * 1024 ** 2 })).status).toBe(403);
      expect((await f.api(manager.accessToken, `/accounts/${f.member.accountId}/commits`, { commitQuotaBytes: 64 * 1024 ** 2 })).status).toBe(200);
      expect((await f.api(f.owner.accessToken, `/accounts/${f.owner.accountId}/commits`, { commitQuotaBytes: null })).status).toBe(200);
    } finally { await f.server.close(); }
  });
  it('delegates administration without granting ownership and guards legacy mutation routes too', async () => {
    const f = await fixture();
    try {
      expect(f.owner.role).toBe('owner');
      expect((await f.api(f.member.accessToken, '/status')).status).toBe(403);
      expect((await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'owner' })).status).toBe(400);
      expect((await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' })).status).toBe(200);
      expect((await f.api(f.manager.accessToken, '/overview')).status).toBe(401);
      const manager = await loginAccount(f.url, 'manager', password);
      expect(manager.role).toBe('admin');
      expect((await f.api(manager.accessToken, '/overview')).status).toBe(200);
      for (const [path, body] of [
        ['/registration', { mode: 'open' }],
        [`/accounts/${f.member.accountId}/role`, { role: 'admin' }],
        ['/users/OWNER/disable', { disabled: true }],
        ['/quotas/owner/commits', { commitQuotaBytes: 1024 ** 2 }],
        ['/quotas/owner/blobs', { quotaBytes: 1024 ** 2 }],
        [`/sessions/${f.owner.session.id}/revoke`, {}],
      ] as const) expect((await f.api(manager.accessToken, path, body)).status).toBe(403);
      expect((await f.api(manager.accessToken, `/accounts/${f.member.accountId}/state`, { disabled: true })).status).toBe(200);
      expect((await fetch(`${f.url}/api/auth/me`, { headers: { Authorization: `Bearer ${f.member.accessToken}` } })).status).toBe(401);
      expect((await f.api(manager.accessToken, `/accounts/${f.member.accountId}/state`, { disabled: false })).status).toBe(200);
      expect((await fetch(`${f.url}/api/auth/me`, { headers: { Authorization: `Bearer ${f.member.accessToken}` } })).status).toBe(401);
      expect((await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'member' })).status).toBe(200);
      expect((await f.api(manager.accessToken, '/status')).status).toBe(401);
    } finally { await f.server.close(); }
  });

  it('paginates and filters accounts by stable identity and records quota changes durably', async () => {
    const f = await fixture();
    try {
      const first = await (await f.api(f.owner.accessToken, '/users?limit=1')).json();
      expect(first.users).toHaveLength(1);
      const second = await (await f.api(f.owner.accessToken, `/users?limit=1&cursor=${first.nextCursor}`)).json();
      expect(second.users[0].accountId).not.toBe(first.users[0].accountId);
      const filtered = await (await f.api(f.owner.accessToken, `/users?search=${f.member.accountId}&role=member&state=enabled`)).json();
      expect(filtered.users).toHaveLength(1);
      expect(filtered.users[0].username).toBe('member');
      expect((await f.api(f.owner.accessToken, '/users?limit=NaN')).status).toBe(400);
      expect((await f.api(f.owner.accessToken, '/audit?cursor=bad')).status).toBe(400);
      expect((await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}/blobs`, { quotaBytes: 4 * 1024 ** 2 })).status).toBe(200);
      expect((await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}/commits`, { commitQuotaBytes: 8 * 1024 ** 2 })).status).toBe(200);
      const usage = await (await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}/usage`)).json();
      expect(usage.quotaBytes).toBe(4 * 1024 ** 2);
      const audit = await (await f.api(f.owner.accessToken, '/audit')).json();
      expect(audit.entries).toHaveLength(2);
      expect(audit.entries[0]).toMatchObject({ actorAccountId: f.owner.accountId, targetAccountId: f.member.accountId, action: 'commit-quota' });
    } finally { await f.server.close(); }
  });

  it('requires a recent owner login for delegation, not just a freshly refreshed token', async () => {
    const f = await fixture();
    const db = new NodeSqliteDriver(join(f.server.dataDir, 'server.sqlite'));
    try {
      await db.run('UPDATE sync_sessions SET created_at = ? WHERE session_id = ?', [new Date(Date.now() - 6 * 60_000).toISOString(), f.owner.session.id]);
      const denied = await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'RECENT_LOGIN_REQUIRED' });
      const audit = await (await f.api(f.owner.accessToken, '/audit')).json();
      expect(audit.entries).toEqual([]);
    } finally { await db.close(); await f.server.close(); }
  });

  it('expires invitations and never leaks usable invite codes into management audit', async () => {
    const f = await fixture();
    const db = new NodeSqliteDriver(join(f.server.dataDir, 'server.sqlite'));
    try {
      await f.api(f.owner.accessToken, '/registration', { mode: 'invite' });
      const created = await (await f.api(f.owner.accessToken, '/invites', { days: 1 })).json();
      expect(created.invite.expiresAt).toBeTruthy();
      const audit = await (await f.api(f.owner.accessToken, '/audit')).json();
      expect(JSON.stringify(audit)).not.toContain(created.invite.code);
      await db.run('UPDATE registration_invite_policy SET expires_at = ? WHERE code = ?', ['2000-01-01T00:00:00.000Z', created.invite.code]);
      await expect(registerAccount(f.url, 'expired-user', password, { inviteCode: created.invite.code })).rejects.toThrow('INVALID_INVITE');
    } finally { await db.close(); await f.server.close(); }
  });
});

describe('management transaction safety', () => {
  it('rolls back role changes and session revocation when audit persistence fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-admin-atomic-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'open', 'server-atomic');
    const db = new NodeSqliteDriver(join(dir, 'server.sqlite'));
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      await store.register('member', 'opaque-member');
      const target = (await store.getUser('member'))!;
      for (const username of ['owner', 'member']) await store.createSession({ id: `session-${username}`, username, deviceId: 'device', deviceName: 'test', refreshHash: 'hash', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      await db.exec("CREATE TRIGGER fail_admin_audit BEFORE INSERT ON server_admin_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
      await expect(store.mutateAdmin('session-owner', { action: 'role', accountId: target.accountId, role: 'admin' })).rejects.toThrow('audit unavailable');
      expect(await store.roleForUser('member')).toBe('member');
      expect((await store.getSession('session-member'))?.revokedAt).toBeUndefined();
    } finally { await db.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
