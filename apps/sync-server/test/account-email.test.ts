import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { SyncServerStore } from '../src/store.js';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { createMetricsService } from '../src/metrics.js';
import { createSettings } from '../src/settings.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('account email verification and notifications', () => {
  it('reports unavailable delivery without issuing a verification code', async () => {
    const server = createTestSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    try {
      await registerAccount(url, 'owner', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      const owner = await loginAccount(url, 'owner', 'account-password');
      const headers = { Authorization: `Bearer ${owner.accessToken}` };
      const state = await fetch(`${url}/api/auth/email`, { headers });
      expect(state.headers.get('cache-control')).toBe('no-store');
      expect(await state.json()).toMatchObject({ available: false, quotaNotifications: false });
      const request = await fetch(`${url}/api/auth/email/request`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com' }),
      });
      expect(request.status).toBe(503);
      expect(request.headers.get('cache-control')).toBe('no-store');
      const reader = new NodeSqliteDriver(join(server.dataDir, 'server.sqlite'));
      try {
        expect(await reader.get('SELECT pending_hash FROM account_email_settings WHERE username = ?', ['owner'])).toBeUndefined();
      } finally { await reader.close(); }
    } finally { await server.close(); }
  });

  it('clears pending verification when delivery fails but retains the send limit', async () => {
    const server = createTestSyncServer({ accountEmailSender: async () => { throw new Error('SMTP unavailable'); } });
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    try {
      await registerAccount(url, 'owner', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      const owner = await loginAccount(url, 'owner', 'account-password');
      const headers = { Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' };
      const request = () => fetch(`${url}/api/auth/email/request`, { method: 'POST', headers, body: JSON.stringify({ email: 'owner@example.com' }) });
      expect((await request()).status).toBe(503);
      const state = await fetch(`${url}/api/auth/email`, { headers });
      expect(await state.json()).toMatchObject({ available: true, quotaNotifications: false });
      const reader = new NodeSqliteDriver(join(server.dataDir, 'server.sqlite'));
      try {
        const row = await reader.get<{ pending_hash: string | null; window_count: number }>('SELECT pending_hash, window_count FROM account_email_settings WHERE username = ?', ['owner']);
        expect(row).toMatchObject({ pending_hash: null, window_count: 1 });
      } finally { await reader.close(); }
      expect((await request()).status).toBe(429);
    } finally { await server.close(); }
  });

  it('verifies an optional email, protects codes, and sends only opted-in account mail', async () => {
    const sent: { to: string; subject: string; body: string }[] = [];
    const server = createTestSyncServer({ accountEmailSender: async (to, subject, body) => { sent.push({ to, subject, body }); } });
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    let store: SyncServerStore | undefined;
    try {
      await registerAccount(url, 'owner', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url, 'member', 'account-password');
      const owner = await loginAccount(url, 'owner', 'account-password');
      const member = await loginAccount(url, 'member', 'account-password');
      const call = async (token: string | undefined, path: string, method = 'GET', body?: object) => {
        const response = await fetch(`${url}/api/auth/email${path}`, {
          method,
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };

      expect((await call(undefined, '')).status).toBe(401);
      expect((await call(owner.accessToken, '')).body).toMatchObject({ available: true, quotaNotifications: false });
      expect((await call(owner.accessToken, '/preferences', 'PUT', { quotaNotifications: true })).status).toBe(400);
      expect((await call(owner.accessToken, '/request', 'POST', { email: 'owner@example.com' })).status).toBe(200);
      expect((await call(owner.accessToken, '/request', 'POST', { email: 'owner@example.com' })).status).toBe(429);
      expect(sent).toHaveLength(1);
      const code = /\d{8}/.exec(sent[0]!.body)?.[0];
      expect(code).toMatch(/^\d{8}$/);
      const reader = new NodeSqliteDriver(join(server.dataDir, 'server.sqlite'));
      try {
        const row = await reader.get<{ pending_hash: string }>('SELECT pending_hash FROM account_email_settings WHERE username = ?', ['owner']);
        expect(row?.pending_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(row?.pending_hash).not.toBe(code);
      } finally { await reader.close(); }

      expect((await call(member.accessToken, '/verify', 'POST', { code })).status).toBe(400);
      expect((await call(owner.accessToken, '/verify', 'POST', { code: '00000000' })).status).toBe(400);
      expect((await call(owner.accessToken, '/verify', 'POST', { code })).status).toBe(200);
      expect((await call(owner.accessToken, '')).body).toMatchObject({ email: 'owner@example.com', quotaNotifications: false });
      const adminDetail = await fetch(`${url}/api/admin/accounts/${owner.accountId}`, { headers: { Authorization: `Bearer ${owner.accessToken}` } });
      expect((await adminDetail.json()).account).toMatchObject({ email: 'owner@example.com', pendingEmail: null });
      expect((await call(owner.accessToken, '/preferences', 'PUT', { quotaNotifications: true })).status).toBe(200);

      store = new SyncServerStore(join(server.dataDir, 'server.sqlite'), 'open', server.serverId);
      await store.enqueueQuotaEmail('owner', 'quota-owner-1', '配额提醒', '请查看我的账号。');
      await server.flushAccountEmails();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({ to: 'owner@example.com', subject: '配额提醒' });
      expect((await store.dueAccountEmails()).length).toBe(0);

      expect((await call(owner.accessToken, '/preferences', 'PUT', { quotaNotifications: false })).status).toBe(200);
      await store.enqueueQuotaEmail('owner', 'quota-owner-2', '配额提醒', '不应发送');
      await server.flushAccountEmails();
      expect(sent).toHaveLength(2);
      expect((await call(owner.accessToken, '', 'DELETE')).status).toBe(200);
      expect((await call(owner.accessToken, '')).body).toMatchObject({ quotaNotifications: false });
    } finally {
      await store?.close();
      await server.close();
    }
  });

  it('queues one quota message per alert activation rather than per sample', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-account-mail-alert-'));
    const blobStore = new EncryptedBlobStore({ dataDir: dir });
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'open', 'srv-account-mail', 1000, blobStore.ready);
    try {
      await store.register('owner', 'opaque-record', undefined, true);
      await store.register('member', 'opaque-record');
      await store.bindReplica('member', 'test-ledger');
      await store.startEmailVerification('member', 'member@example.com', 'a'.repeat(64));
      await store.completeEmailVerification('member', 'a'.repeat(64));
      await store.setQuotaEmailNotifications('member', true);
      const driver = new NodeSqliteDriver(join(dir, 'server.sqlite'));
      try {
        await driver.run('INSERT INTO ledger_replica_commits (replica_id, seq, commit_id, ledger_id, content_hash, enc_commit_json, cipher_bytes, created_at) VALUES ((SELECT replica_id FROM sync_replicas WHERE username = ?), ?, ?, ?, ?, ?, ?, ?)', ['member', 1, 'test-commit', 'test-ledger', 'hash', '{}', 950, new Date().toISOString()]);
      } finally { await driver.close(); }
      const { settings } = createSettings(store);
      const metrics = createMetricsService({
        store, blobStore, settings, startedAt: Date.now(),
        log: async () => undefined,
        listBackupRecords: async () => [],
        notify: async () => ({ state: 'skipped' }),
        onCapacityActive: async (warning, episode) => store.enqueueQuotaEmail(warning.username, `quota:${warning.scope}:${episode}`, '配额提醒', '请查看我的账号。'),
      });
      await metrics.sample();
      expect(await store.dueAccountEmails()).toHaveLength(0);
      await metrics.sample();
      expect(await store.dueAccountEmails()).toHaveLength(1);
      await metrics.sample();
      expect(await store.dueAccountEmails()).toHaveLength(1);
    } finally {
      await store.close();
      await blobStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
