import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fetchAuthMe, loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('account profile', () => {
  it('accepts a two-character Chinese login account and keeps the nickname separate', async () => {
    const server = createTestSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    try {
      await registerAccount(url, '小明', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN, displayName: '小明的账本' });
      const session = await loginAccount(url, '小明', 'account-password');
      expect(await fetchAuthMe(url, session.accessToken)).toMatchObject({ username: '小明', displayName: '小明的账本' });

      const response = await fetch(`${url}/api/auth/profile`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: '明明' }),
      });
      expect(response.status).toBe(200);
      expect(await fetchAuthMe(url, session.accessToken)).toMatchObject({ username: '小明', displayName: '明明' });
      expect((await loginAccount(url, '小明', 'account-password')).session.username).toBe('小明');
      const adminDetail = await fetch(`${url}/api/admin/accounts/${session.accountId}`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
      expect((await adminDetail.json()).account).toMatchObject({ username: '小明', displayName: '明明' });
      const adminSearch = await fetch(`${url}/api/admin/users?search=${encodeURIComponent('明明')}`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
      expect((await adminSearch.json()).users).toEqual(expect.arrayContaining([expect.objectContaining({ username: '小明', displayName: '明明', commitQuotaBytes: null })]));

      const invalid = await fetch(`${url}/api/auth/profile`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: '' }),
      });
      expect(invalid.status).toBe(400);
      expect((await fetchAuthMe(url, session.accessToken)).displayName).toBe('明明');
    } finally {
      await server.close();
    }
  });

  it('shows each authenticated user only their own commit and attachment quotas', async () => {
    const server = createTestSyncServer({ commitQuotaBytes: 8 * 1024 * 1024, attachmentQuotaBytes: 16 * 1024 * 1024 });
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    try {
      await registerAccount(url, 'owner', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url, 'member', 'account-password');
      const owner = await loginAccount(url, 'owner', 'account-password');
      const member = await loginAccount(url, 'member', 'account-password');
      const catalog = new SyncServerStore(join(server.dataDir, 'server.sqlite'), 'open', server.serverId);
      const replica = await catalog.bindReplica('owner', 'test-ledger');
      await catalog.close();
      const driver = new NodeSqliteDriver(join(server.dataDir, 'server.sqlite'));
      try {
        await driver.run('INSERT INTO sync_user_quotas (username, commit_quota_bytes, updated_at) VALUES (?, ?, ?)', ['owner', 1024, new Date().toISOString()]);
        await driver.run('INSERT INTO ledger_replica_commits (replica_id, seq, commit_id, ledger_id, content_hash, enc_commit_json, cipher_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [replica.replicaId, 1, 'test-commit', 'test-ledger', 'hash', '{}', 2048, new Date().toISOString()]);
      } finally { await driver.close(); }

      const read = async (token?: string, query = '') => fetch(`${url}/api/auth/usage${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      expect((await read()).status).toBe(401);
      expect(await (await read(owner.accessToken, '?username=member')).json()).toMatchObject({
        commits: { usedBytes: 2048, quotaBytes: null, commitCount: 1 },
        attachments: { usedBytes: 0, quotaBytes: null },
      });
      expect(await (await read(member.accessToken)).json()).toMatchObject({
        commits: { usedBytes: 0, quotaBytes: 8 * 1024 * 1024, commitCount: 0 },
      });
      const over = await fetch(`${url}/api/admin/users?quota=over`, { headers: { Authorization: `Bearer ${owner.accessToken}` } });
      expect((await over.json()).users).toEqual([]);
    } finally { await server.close(); }
  });

  it('defaults members to 20 GiB and exempts owner and admin roles from both quotas', async () => {
    const defaults = createTestSyncServer();
    await new Promise<void>((resolve) => defaults.server.listen(0, resolve));
    const defaultUrl = `http://localhost:${(defaults.server.address() as AddressInfo).port}`;
    try {
      await registerAccount(defaultUrl, 'owner', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(defaultUrl, 'member', 'account-password');
      const member = await loginAccount(defaultUrl, 'member', 'account-password');
      const response = await fetch(`${defaultUrl}/api/auth/usage`, { headers: { Authorization: `Bearer ${member.accessToken}` } });
      expect(await response.json()).toMatchObject({
        commits: { quotaBytes: 20 * 1024 ** 3 }, attachments: { quotaBytes: 20 * 1024 ** 3 },
      });
    } finally { await defaults.close(); }

    const server = createTestSyncServer({ commitQuotaBytes: 256, attachmentQuotaBytes: 1024 * 1024 });
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    try {
      await registerAccount(url, 'owner', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url, 'member', 'account-password');
      const owner = await loginAccount(url, 'owner', 'account-password');
      let member = await loginAccount(url, 'member', 'account-password');
      const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
      const write = (token: string, path: string, body: object) => fetch(`${url}${path}`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
      const usage = async (token: string) => (await fetch(`${url}/api/auth/usage`, { headers: headers(token) })).json() as Promise<{ commits: { quotaBytes: number | null }; attachments: { quotaBytes: number | null } }>;
      const ledgerId = 'ledger-quota-role-0001';
      for (const token of [owner.accessToken, member.accessToken]) expect((await write(token, '/api/v3/replica/bind', { ledgerId })).status).toBe(200);
      const commit = (id: string) => ({ commits: [{ commitId: id, ledgerId, contentHash: 'a'.repeat(64), encCommit: { v: 3, keyId: 'key-quota-role-0001', iv: 'iv', ct: 'x'.repeat(512) } }] });
      expect((await write(owner.accessToken, '/api/v3/commits', commit('commit-role-owner01'))).status).toBe(200);
      expect((await write(member.accessToken, '/api/v3/commits', commit('commit-role-member1'))).status).toBe(507);
      const manifest = (id: string) => ({ manifest: { v: 1, blobId: id.repeat(64), cipherBytes: 1024 * 1024 + 1, chunkCount: 1, chunks: [{ index: 0, sizeBytes: 1024 * 1024 + 1, ciphertextSha256: 'd'.repeat(64), iv: 'AAECAwQFBgcICQoL' }] } });
      expect((await write(owner.accessToken, '/api/v3/blobs/uploads', manifest('a'))).status).toBe(201);
      expect((await write(member.accessToken, '/api/v3/blobs/uploads', manifest('b'))).status).toBe(507);
      expect(await usage(owner.accessToken)).toMatchObject({ commits: { quotaBytes: null }, attachments: { quotaBytes: null } });

      expect((await write(owner.accessToken, `/api/admin/accounts/${member.accountId}/role`, { role: 'admin' })).status).toBe(200);
      member = await loginAccount(url, 'member', 'account-password');
      expect(await usage(member.accessToken)).toMatchObject({ commits: { quotaBytes: null }, attachments: { quotaBytes: null } });
      expect((await write(member.accessToken, '/api/v3/commits', commit('commit-role-admin01'))).status).toBe(200);
      expect((await write(member.accessToken, '/api/v3/blobs/uploads', manifest('c'))).status).toBe(201);

      expect((await write(owner.accessToken, `/api/admin/accounts/${member.accountId}/role`, { role: 'member' })).status).toBe(200);
      member = await loginAccount(url, 'member', 'account-password');
      expect(await usage(member.accessToken)).toMatchObject({ commits: { quotaBytes: 256 }, attachments: { quotaBytes: 1024 * 1024 } });
      expect((await write(member.accessToken, '/api/v3/commits', commit('commit-role-member2'))).status).toBe(507);
      expect((await write(member.accessToken, '/api/v3/blobs/uploads', manifest('e'))).status).toBe(507);
      const inspector = new SyncServerStore(join(server.dataDir, 'server.sqlite'), 'open', server.serverId, 256, undefined, 1024 * 1024);
      try {
        expect(await inspector.capacityWarnings(0.9)).toEqual(expect.arrayContaining([
          expect.objectContaining({ username: 'member', scope: 'blobs', usedBytes: 1024 * 1024 + 1 }),
        ]));
        expect((await inspector.capacityWarnings(0.9)).some((warning) => warning.username === 'owner')).toBe(false);
      } finally { await inspector.close(); }
    } finally { await server.close(); }
  });
});
