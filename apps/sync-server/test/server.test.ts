import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as opaque from '@serenity-kit/opaque';
import { createSyncServer, type SyncServer } from '../src/server.js';
import { createServerBackup, restoreServerBackup, verifyServerBackup } from '../src/backup.js';
import { normalizeSyncUsername } from '@zichan/core';
import { NodeSqliteDriver } from '@zichan/db/node';

let sv: SyncServer;
let url: string;

beforeAll(async () => {
  sv = createSyncServer(); // in-memory
  await new Promise<void>((r) => sv.server.listen(0, r));
  const addr = sv.server.address() as AddressInfo;
  url = `http://localhost:${addr.port}`;
});
afterAll(() => sv.close());

const post2 = (base: string, p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function registerUser(base: string, username: string, password: string, inviteCode?: string, prefix = ''): Promise<Response> {
  const normalized = normalizeSyncUsername(username);
  await opaque.ready;
  const start = opaque.client.startRegistration({ password });
  const startResponse = await post2(base, `${prefix}/api/auth/register/start`, {
    username: normalized,
    registrationRequest: start.registrationRequest,
    inviteCode,
  });
  if (!startResponse.ok) return startResponse;
  const startBody = await startResponse.json() as {
    registrationResponse: string;
    registrationToken: string;
    serverId: string;
    serverPublicKey: string;
  };
  const finish = opaque.client.finishRegistration({
    password,
    registrationResponse: startBody.registrationResponse,
    clientRegistrationState: start.clientRegistrationState,
    identifiers: { client: normalized, server: startBody.serverId },
    keyStretching: 'memory-constrained',
  });
  expect(finish.serverStaticPublicKey).toBe(startBody.serverPublicKey);
  return post2(base, `${prefix}/api/auth/register/finish`, {
    registrationToken: startBody.registrationToken,
    registrationRecord: finish.registrationRecord,
  });
}

async function loginUser(
  base: string,
  username: string,
  password: string,
  prefix = '',
  deviceId = `device-${normalizeSyncUsername(username)}`,
): Promise<Response> {
  const normalized = normalizeSyncUsername(username);
  await opaque.ready;
  const start = opaque.client.startLogin({ password });
  const startResponse = await post2(base, `${prefix}/api/auth/login/start`, {
    username: normalized,
    startLoginRequest: start.startLoginRequest,
  });
  if (!startResponse.ok) return startResponse;
  const startBody = await startResponse.json() as {
    loginId: string;
    loginResponse: string;
    serverId: string;
    serverPublicKey: string;
  };
  const finish = opaque.client.finishLogin({
    clientLoginState: start.clientLoginState,
    loginResponse: startBody.loginResponse,
    password,
    identifiers: { client: normalized, server: startBody.serverId },
    keyStretching: 'memory-constrained',
  });
  if (finish) expect(finish.serverStaticPublicKey).toBe(startBody.serverPublicKey);
  return post2(base, `${prefix}/api/auth/login/finish`, {
    loginId: startBody.loginId,
    finishLoginRequest: finish?.finishLoginRequest ?? 'invalid-opaque-login-finish',
    deviceId,
    deviceName: `Test ${deviceId}`,
  });
}

async function accessToken(base: string, username: string, password: string, prefix = '', deviceId?: string): Promise<string> {
  const response = await loginUser(base, username, password, prefix, deviceId);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

describe('sync-server endpoints', () => {
  it('registers, binds one ledger replica, and stores encrypted commits idempotently', async () => {
    const health = (await (await fetch(url + '/api/health')).json()) as { ok: boolean; serverId: string; protocols: number[] };
    expect(health.ok).toBe(true);
    expect(health.serverId).toBeTruthy();
    expect(health.protocols).toEqual([3]);
    expect((await fetch(url + '/api/ready')).status).toBe(200);

    expect((await registerUser(url, 'alice', 'pw')).status).toBe(200);
    expect((await registerUser(url, 'alice', 'pw')).status).toBe(409); // dup

    // wrong proof
    expect((await loginUser(url, 'alice', 'nope')).status).toBe(401);

    const login = await loginUser(url, 'alice', 'pw');
    expect(login.status).toBe(200);
    const { accessToken: token } = (await login.json()) as { accessToken: string };
    expect(token).toBeTruthy();

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    expect((await fetch(url + '/api/v3/replica', { headers })).status).toBe(200);
    const ledgerId = 'ledger-000000000001';
    expect((await fetch(url + '/api/v3/replica/bind', { method: 'POST', headers, body: JSON.stringify({ ledgerId }) })).status).toBe(200);
    const replica = (await (await fetch(url + '/api/v3/replica', { headers })).json()) as { bound: boolean; ledgerId: string; replicaId: string; streamEpoch: string };
    expect(replica).toMatchObject({ bound: true, ledgerId });
    expect(replica.replicaId).toBeTruthy();
    expect(replica.streamEpoch).toBeTruthy();

    const commit = {
      commitId: 'commit-000000000001', ledgerId, contentHash: 'a'.repeat(64),
      encCommit: { v: 3, keyId: 'key-000000000001', iv: 'iv', ct: 'ciphertext' },
    };
    const first = await fetch(url + '/api/v3/commits', { method: 'POST', headers, body: JSON.stringify({ commits: [commit] }) });
    expect(first.status).toBe(200);
    expect((await first.json()) as unknown).toMatchObject({ assigned: [{ commitId: commit.commitId, seq: 1 }], headSeq: 1 });
    const repeated = await fetch(url + '/api/v3/commits', { method: 'POST', headers, body: JSON.stringify({ commits: [commit] }) });
    expect((await repeated.json()) as unknown).toMatchObject({ assigned: [{ commitId: commit.commitId, seq: 1 }], headSeq: 1 });
    const collision = await fetch(url + '/api/v3/commits', { method: 'POST', headers, body: JSON.stringify({ commits: [{ ...commit, contentHash: 'b'.repeat(64) }] }) });
    expect(collision.status).toBe(409);
    const duplicate = await fetch(url + '/api/v3/commits', { method: 'POST', headers, body: JSON.stringify({ commits: [commit, commit] }) });
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json()) as unknown).toMatchObject({ code: 'DUPLICATE_COMMIT_ID' });
    const duplicateCollision = await fetch(url + '/api/v3/commits', {
      method: 'POST', headers,
      body: JSON.stringify({ commits: [commit, { ...commit, contentHash: 'b'.repeat(64) }] }),
    });
    expect(duplicateCollision.status).toBe(409);
    expect((await duplicateCollision.json()) as unknown).toMatchObject({ code: 'COMMIT_ID_COLLISION' });

    const concurrentCommit = { ...commit, commitId: 'commit-000000000002', contentHash: 'c'.repeat(64) };
    const concurrent = await Promise.all([1, 2].map(() => fetch(url + '/api/v3/commits', {
      method: 'POST', headers, body: JSON.stringify({ commits: [concurrentCommit] }),
    })));
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    expect(await Promise.all(concurrent.map((response) => response.json()))).toEqual([
      expect.objectContaining({ assigned: [expect.objectContaining({ commitId: concurrentCommit.commitId, seq: 2 })], headSeq: 2 }),
      expect.objectContaining({ assigned: [expect.objectContaining({ commitId: concurrentCommit.commitId, seq: 2 })], headSeq: 2 }),
    ]);

    const commits = (await (await fetch(url + '/api/v3/commits?after=0&limit=1', { headers })).json()) as { commits: unknown[]; serverId: string; headSeq: number; nextSeq: number; hasMore: boolean };
    expect(commits.serverId).toBe(health.serverId);
    expect(commits.commits).toHaveLength(1);
    expect(commits).toMatchObject({ headSeq: 2, nextSeq: 1, hasMore: true });
    const nextPage = await (await fetch(url + `/api/v3/commits?after=${commits.nextSeq}&limit=1`, { headers })).json() as { commits: { seq: number }[]; nextSeq: number; hasMore: boolean };
    expect(nextPage).toMatchObject({ commits: [expect.objectContaining({ seq: 2 })], nextSeq: 2, hasMore: false });
    expect((await fetch(url + '/api/events?since=0', { headers })).status).toBe(404);

    // tampered token → 401 (HMAC signature check)
    const bad = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect((await fetch(url + '/api/v3/commits?after=0', { headers: { Authorization: `Bearer ${bad}` } })).status).toBe(401);
  });

  it('consumes OPAQUE login states once, rotates refresh tokens, and lets a user revoke a device', async () => {
    const username = 'session-user';
    const password = 'session-password';
    expect((await registerUser(url, username, password)).status).toBe(200);
    const clientStart = opaque.client.startLogin({ password });
    const startResponse = await post2(url, '/api/auth/login/start', {
      username,
      startLoginRequest: clientStart.startLoginRequest,
    });
    const serverStart = await startResponse.json() as {
      loginId: string;
      loginResponse: string;
      serverId: string;
    };
    const clientFinish = opaque.client.finishLogin({
      clientLoginState: clientStart.clientLoginState,
      loginResponse: serverStart.loginResponse,
      password,
      identifiers: { client: username, server: serverStart.serverId },
      keyStretching: 'memory-constrained',
    });
    expect(clientFinish).toBeTruthy();
    const loginBody = {
      loginId: serverStart.loginId,
      finishLoginRequest: clientFinish!.finishLoginRequest,
      deviceId: 'device-session-user',
      deviceName: 'Session test',
    };
    const login = await post2(url, '/api/auth/login/finish', loginBody);
    expect(login.status).toBe(200);
    expect((await post2(url, '/api/auth/login/finish', loginBody)).status).toBe(401);
    const first = await login.json() as { accessToken: string; refreshToken: string; session: { id: string } };

    const refreshedResponse = await post2(url, '/api/auth/refresh', { refreshToken: first.refreshToken });
    expect(refreshedResponse.status).toBe(200);
    const refreshed = await refreshedResponse.json() as { accessToken: string; refreshToken: string };
    expect(refreshed.refreshToken).not.toBe(first.refreshToken);
    expect((await post2(url, '/api/auth/refresh', { refreshToken: first.refreshToken })).status).toBe(401);

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${refreshed.accessToken}` };
    expect(await (await fetch(url + '/api/auth/devices', { headers })).json()).toMatchObject({
      currentSessionId: first.session.id,
      devices: [expect.objectContaining({ id: first.session.id, active: true })],
    });
    expect((await fetch(`${url}/api/auth/devices/${first.session.id}/revoke`, {
      method: 'POST', headers, body: '{}',
    })).status).toBe(200);
    expect((await fetch(url + '/api/v3/replica', { headers })).status).toBe(401);
  });

  it('resumes, verifies, downloads, trashes, and restores encrypted attachment chunks', async () => {
    const username = 'blob-user';
    expect((await registerUser(url, username, 'blob-password')).status).toBe(200);
    const token = await accessToken(url, username, 'blob-password');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const ledgerId = 'ledger-blob-00000001';
    expect((await fetch(url + '/api/v3/replica/bind', { method: 'POST', headers, body: JSON.stringify({ ledgerId }) })).status).toBe(200);

    const encrypted = new TextEncoder().encode('ciphertext-with-an-auth-tag');
    const blobId = 'b'.repeat(64);
    const manifest = {
      v: 1,
      blobId,
      cipherBytes: encrypted.byteLength,
      chunkCount: 1,
      chunks: [{
        index: 0,
        sizeBytes: encrypted.byteLength,
        ciphertextSha256: createHash('sha256').update(encrypted).digest('hex'),
        iv: 'AAECAwQFBgcICQoL',
      }],
    };
    const begin = await fetch(url + '/api/v3/blobs/uploads', { method: 'POST', headers, body: JSON.stringify({ manifest }) });
    expect(begin.status, await begin.clone().text()).toBe(201);
    const plan = await begin.json() as { uploadId: string; missingChunks: number[] };
    expect(plan.missingChunks).toEqual([0]);

    const resumed = await fetch(url + '/api/v3/blobs/uploads', { method: 'POST', headers, body: JSON.stringify({ manifest }) });
    expect(await resumed.json()).toMatchObject({ uploadId: plan.uploadId, missingChunks: [0] });
    const mismatched = await fetch(url + '/api/v3/blobs/uploads', {
      method: 'POST', headers, body: JSON.stringify({ manifest: { ...manifest, chunks: [{ ...manifest.chunks[0], iv: 'AQECAwQFBgcICQoL' }] } }),
    });
    expect(mismatched.status).toBe(409);
    const upload = await fetch(`${url}/api/v3/blobs/uploads/${plan.uploadId}/chunks/0`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(encrypted.byteLength) }, body: encrypted,
    });
    expect(upload.status).toBe(200);
    const afterChunk = await fetch(url + '/api/v3/blobs/uploads', { method: 'POST', headers, body: JSON.stringify({ manifest }) });
    expect(await afterChunk.json()).toMatchObject({ uploadId: plan.uploadId, missingChunks: [] });
    expect((await fetch(`${url}/api/v3/blobs/uploads/${plan.uploadId}/complete`, { method: 'POST', headers, body: '{}' })).status).toBe(200);

    expect(await (await fetch(url + '/api/v3/blobs/status', { method: 'POST', headers, body: JSON.stringify({ blobIds: [blobId] }) })).json())
      .toMatchObject({ objects: { [blobId]: 'available' } });
    expect(await (await fetch(`${url}/api/v3/blobs/${blobId}/manifest`, { headers })).json()).toEqual({ manifest });
    expect(new Uint8Array(await (await fetch(`${url}/api/v3/blobs/${blobId}/chunks/0`, { headers })).arrayBuffer())).toEqual(encrypted);

    expect((await fetch(`${url}/api/v3/blobs/${blobId}`, { method: 'DELETE', headers })).status).toBe(200);
    expect(await (await fetch(url + '/api/v3/blobs/status', { method: 'POST', headers, body: JSON.stringify({ blobIds: [blobId] }) })).json())
      .toMatchObject({ objects: { [blobId]: 'trash' } });
    expect((await fetch(`${url}/api/v3/blobs/${blobId}/restore`, { method: 'POST', headers, body: '{}' })).status).toBe(200);
    expect((await fetch(`${url}/api/v3/blobs/${blobId}/chunks/0`, { headers })).status).toBe(200);
  });

  it('catalogs encrypted backups and moves deleted archives to blob trash', async () => {
    const username = 'backup-user';
    expect((await registerUser(url, username, 'backup-password')).status).toBe(200);
    const token = await accessToken(url, username, 'backup-password');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const ledgerId = 'ledger-backup-000001';
    expect((await fetch(url + '/api/v3/replica/bind', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ledgerId }),
    })).status).toBe(200);

    const encryptedArchive = new TextEncoder().encode(
      'encrypted-zichan-backup-archive-with-authenticated-frames'.repeat(4),
    );
    const blobId = createHash('sha256').update(encryptedArchive).digest('hex');
    const chunk = {
      index: 0,
      sizeBytes: encryptedArchive.byteLength,
      ciphertextSha256: createHash('sha256').update(encryptedArchive).digest('hex'),
      iv: 'AAECAwQFBgcICQoL',
    };
    const manifest = {
      v: 1,
      blobId,
      cipherBytes: encryptedArchive.byteLength,
      chunkCount: 1,
      chunks: [chunk],
    };
    const archive = {
      archiveId: 'archive-000000000001',
      blobId,
      createdAt: '2026-07-23T12:00:00.000Z',
      reason: 'auto',
      kind: 'device',
      label: '自动设备备份',
      sizeBytes: encryptedArchive.byteLength,
      sourceGeneration: 'ledger:42:operation:8',
    };

    const beforeUpload = await fetch(url + '/api/v3/backups', {
      method: 'POST',
      headers,
      body: JSON.stringify({ archive }),
    });
    expect(beforeUpload.status).toBe(409);
    expect(await beforeUpload.json()).toMatchObject({ code: 'BACKUP_BLOB_MISSING' });

    const begin = await fetch(url + '/api/v3/blobs/uploads', {
      method: 'POST',
      headers,
      body: JSON.stringify({ manifest }),
    });
    expect(begin.status).toBe(201);
    const { uploadId } = await begin.json() as { uploadId: string };
    expect((await fetch(`${url}/api/v3/blobs/uploads/${uploadId}/chunks/0`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(encryptedArchive.byteLength),
      },
      body: encryptedArchive,
    })).status).toBe(200);
    expect((await fetch(`${url}/api/v3/blobs/uploads/${uploadId}/complete`, {
      method: 'POST',
      headers,
      body: '{}',
    })).status).toBe(200);

    const registered = await fetch(url + '/api/v3/backups', {
      method: 'POST',
      headers,
      body: JSON.stringify({ archive }),
    });
    expect(registered.status, await registered.clone().text()).toBe(201);
    expect(await registered.json()).toMatchObject({ backup: { ...archive, ledgerId } });
    expect(await (await fetch(url + '/api/v3/backups?limit=1', { headers })).json()).toEqual({
      backups: [{ ...archive, ledgerId }],
    });

    expect((await fetch(`${url}/api/v3/backups/${archive.archiveId}`, {
      method: 'DELETE',
      headers,
    })).status).toBe(200);
    expect(await (await fetch(url + '/api/v3/backups', { headers })).json()).toEqual({ backups: [] });
    expect(await (await fetch(url + '/api/v3/blobs/status', {
      method: 'POST',
      headers,
      body: JSON.stringify({ blobIds: [blobId] }),
    })).json()).toMatchObject({ objects: { [blobId]: 'trash' } });
  });

  it('rate-limits auth endpoints', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zichan-rate-limit-'));
    let s: SyncServer | null = createSyncServer({ dataDir });
    try {
      await new Promise<void>((r) => s!.server.listen(0, r));
      const u = `http://localhost:${(s.server.address() as AddressInfo).port}`;
      const startLoginRequest = opaque.client.startLogin({ password: 'rate-test' }).startLoginRequest;
      let got429 = false;
      for (let i = 0; i < 25; i++) {
        const res = await post2(u, '/api/auth/login/start', { username: 'rate-user', startLoginRequest });
        if (res.status === 429) { got429 = true; break; }
      }
      expect(got429).toBe(true);
      await s.close();
      s = createSyncServer({ dataDir });
      await new Promise<void>((r) => s!.server.listen(0, r));
      const restarted = `http://localhost:${(s.server.address() as AddressInfo).port}`;
      expect((await post2(restarted, '/api/auth/login/start', { username: 'rate-user', startLoginRequest })).status).toBe(429);
    } finally {
      await s?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('requires HTTPS for a proxied public client and enforces the CORS allowlist', async () => {
    const s = createSyncServer({
      trustedProxies: ['loopback'],
      allowedOrigins: ['https://ledger.example.test'],
    });
    await new Promise<void>((resolve) => s.server.listen(0, resolve));
    const base = `http://localhost:${(s.server.address() as AddressInfo).port}`;
    try {
      const forwarded = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.8' };
      const startLoginRequest = opaque.client.startLogin({ password: 'public-test' }).startLoginRequest;
      expect((await fetch(base + '/api/auth/login/start', {
        method: 'POST',
        headers: forwarded,
        body: JSON.stringify({ username: 'public-user', startLoginRequest }),
      })).status).toBe(426);
      expect((await fetch(base + '/api/auth/login/start', {
        method: 'POST',
        headers: {
          ...forwarded,
          'X-Forwarded-Proto': 'https',
          Origin: 'https://evil.example.test',
        },
        body: JSON.stringify({ username: 'public-user', startLoginRequest }),
      })).status).toBe(403);
      const allowed = await fetch(base + '/api/auth/login/start', {
        method: 'POST',
        headers: {
          ...forwarded,
          'X-Forwarded-Proto': 'https',
          Origin: 'https://ledger.example.test',
        },
        body: JSON.stringify({ username: 'public-user', startLoginRequest }),
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://ledger.example.test');
    } finally {
      await s.close();
    }
  });

  it('reserves upload capacity and rejects blobs beyond the account quota', async () => {
    const s = createSyncServer({ attachmentQuotaBytes: 1024 * 1024 });
    await new Promise<void>((r) => s.server.listen(0, r));
    const u = `http://localhost:${(s.server.address() as AddressInfo).port}`;
    try {
      const username = 'quota-user';
      await registerUser(u, username, 'quota-password');
      const token = await accessToken(u, username, 'quota-password');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      await fetch(u + '/api/v3/replica/bind', { method: 'POST', headers, body: JSON.stringify({ ledgerId: 'ledger-quota-000001' }) });
      const cipherBytes = 1024 * 1024 + 1;
      const response = await fetch(u + '/api/v3/blobs/uploads', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          manifest: {
            v: 1,
            blobId: 'c'.repeat(64),
            cipherBytes,
            chunkCount: 1,
            chunks: [{ index: 0, sizeBytes: cipherBytes, ciphertextSha256: 'd'.repeat(64), iv: 'AAECAwQFBgcICQoL' }],
          },
        }),
      });
      expect(response.status).toBe(507);
      expect(await response.json()).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    } finally {
      await s.close();
    }
  });

  it('supports invite registration and user disable via admin API', async () => {
    const s = createSyncServer({ adminToken: 'admin-token', registrationMode: 'invite' });
    await new Promise<void>((r) => s.server.listen(0, r));
    const u = `http://localhost:${(s.server.address() as AddressInfo).port}`;
    try {
      const adminHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' };
      expect((await registerUser(u, 'invite-user', 'pw')).status).toBe(403);

      const inviteRes = await fetch(u + '/admin/invites', { method: 'POST', headers: adminHeaders, body: '{}' });
      expect(inviteRes.status).toBe(200);
      const { invite } = (await inviteRes.json()) as { invite: { code: string } };
      expect(invite.code).toBeTruthy();

      expect((await registerUser(u, 'invite-user', 'pw', invite.code)).status).toBe(200);
      const usersRes = await fetch(u + '/admin/users', { headers: adminHeaders });
      const usersBody = await usersRes.json();
      expect(JSON.stringify(usersBody)).not.toContain('opaqueRegistrationRecord');
      expect((usersBody as { users: { username: string; commitCount: number }[] }).users).toEqual([
        expect.objectContaining({ username: 'invite-user', commitCount: 0 }),
      ]);
      const quota = await fetch(u + '/admin/blobs/invite-user/quota', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ quotaBytes: 8 * 1024 * 1024 }),
      });
      expect(quota.status).toBe(200);
      expect(await (await fetch(u + '/admin/blobs', { headers: adminHeaders })).json()).toMatchObject({
        users: [expect.objectContaining({ username: 'invite-user', quotaBytes: 8 * 1024 * 1024 })],
      });
      expect(await (await fetch(u + '/admin/blobs/verify', { method: 'POST', headers: adminHeaders, body: '{}' })).json()).toMatchObject({
        verification: { checkedObjects: 0, checkedChunks: 0, issues: [] },
      });
      expect((await fetch(u + '/admin/users/invite-user/quota', {
        method: 'POST', headers: adminHeaders, body: JSON.stringify({ commitQuotaBytes: 8 * 1024 * 1024 }),
      })).status).toBe(200);
      expect(await (await fetch(u + '/admin/users?limit=1', { headers: adminHeaders })).json()).toMatchObject({
        users: [expect.objectContaining({ username: 'invite-user', commitQuotaBytes: 8 * 1024 * 1024 })],
      });
      expect(await (await fetch(u + '/admin/database/verify', { headers: adminHeaders })).json()).toMatchObject({
        verification: { ok: true, result: 'ok', journalMode: 'wal', schemaVersion: 5 },
      });

      const login = await loginUser(u, 'invite-user', 'pw');
      const session = await login.json() as { accessToken: string; session: { id: string } };
      expect(await (await fetch(u + '/admin/users/invite-user/devices', { headers: adminHeaders })).json()).toMatchObject({
        devices: [expect.objectContaining({ id: session.session.id, active: true })],
      });
      expect((await fetch(`${u}/admin/sessions/${session.session.id}/revoke`, {
        method: 'POST', headers: adminHeaders, body: '{}',
      })).status).toBe(200);
      expect((await fetch(u + '/api/v3/replica', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      })).status).toBe(401);
      expect((await loginUser(u, 'invite-user', 'pw')).status).toBe(200);
      const disable = await fetch(u + '/admin/users/invite-user/disable', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ disabled: true }),
      });
      expect(disable.status).toBe(200);
      expect((await loginUser(u, 'invite-user', 'pw')).status).toBe(403);
    } finally {
      await s.close();
    }
  });

  it('mounts API/admin under a base path and exposes admin logs', async () => {
    const s = createSyncServer({ adminToken: 'admin-token', basePath: '/账本-2026' });
    await new Promise<void>((r) => s.server.listen(0, r));
    const u = `http://localhost:${(s.server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(u + '/api/health')).status).toBe(404);
      const health = await fetch(u + '/%E8%B4%A6%E6%9C%AC-2026/api/health');
      expect(health.status).toBe(200);
      expect(((await health.json()) as { basePath: string }).basePath).toBe('/账本-2026');

      const prefix = '/%E8%B4%A6%E6%9C%AC-2026';
      expect((await registerUser(u, 'logger', 'pw', undefined, prefix)).status).toBe(200);
      expect((await loginUser(u, 'logger', 'bad', prefix)).status).toBe(401);
      expect((await loginUser(u, 'logger', 'pw', prefix)).status).toBe(200);

      const logs = await fetch(u + '/%E8%B4%A6%E6%9C%AC-2026/admin/logs?limit=20', {
        headers: { Authorization: 'Bearer admin-token' },
      });
      expect(logs.status).toBe(200);
      const body = (await logs.json()) as { logs: { action: string; username?: string; opaqueRegistrationRecord?: string }[] };
      expect(body.logs.map((row) => row.action)).toContain('login_failed');
      expect(body.logs.map((row) => row.action)).toContain('login_success');
      expect(JSON.stringify(body)).not.toContain('opaqueRegistrationRecord');
      expect(body.logs.some((row) => row.username === 'logger')).toBe(true);
      const future = await fetch(u + '/%E8%B4%A6%E6%9C%AC-2026/admin/logs?from=2099-01-01T00%3A00%3A00.000Z', {
        headers: { Authorization: 'Bearer admin-token' },
      });
      expect(((await future.json()) as { logs: unknown[] }).logs).toEqual([]);
      const past = await fetch(u + '/%E8%B4%A6%E6%9C%AC-2026/admin/logs?until=2000-01-01T00%3A00%3A00.000Z', {
        headers: { Authorization: 'Bearer admin-token' },
      });
      expect(((await past.json()) as { logs: unknown[] }).logs).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it('serves a web directory independently from the sync API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Zichan Web</title><div id="root"></div>');
    const s = createSyncServer({ webDir: dir, enableWeb: true, enableSync: false });
    await new Promise<void>((r) => s.server.listen(0, r));
    const u = `http://localhost:${(s.server.address() as AddressInfo).port}`;
    try {
      const page = await fetch(u + '/');
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Zichan Web');
      expect((await post2(u, '/api/auth/login/start', { username: 'offline-user' })).status).toBe(503);
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects oversized bodies and rolls back a commit batch that exceeds quota', async () => {
    const s = createSyncServer({ commitQuotaBytes: 256 });
    await s.ready;
    await new Promise<void>((resolve) => s.server.listen(0, resolve));
    const base = `http://localhost:${(s.server.address() as AddressInfo).port}`;
    try {
      const oversized = await post2(base, '/api/auth/register/start', {
        username: 'large-body',
        registrationRequest: 'x'.repeat(70 * 1024),
      });
      expect(oversized.status).toBe(413);
      expect((await registerUser(base, 'commit-quota', 'pw')).status).toBe(200);
      const token = await accessToken(base, 'commit-quota', 'pw');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const ledgerId = 'ledger-commit-quota1';
      await fetch(base + '/api/v3/replica/bind', { method: 'POST', headers, body: JSON.stringify({ ledgerId }) });
      const response = await fetch(base + '/api/v3/commits', {
        method: 'POST', headers,
        body: JSON.stringify({ commits: [{
          commitId: 'commit-quota-000001', ledgerId, contentHash: 'a'.repeat(64),
          encCommit: { v: 3, keyId: 'key-quota-000001', iv: 'iv', ct: 'x'.repeat(1024) },
        }] }),
      });
      expect(response.status).toBe(507);
      expect(await response.json()).toMatchObject({ code: 'COMMIT_QUOTA_EXCEEDED' });
      expect(await (await fetch(base + '/api/v3/commits?after=0', { headers })).json()).toMatchObject({ commits: [], headSeq: 0 });
    } finally {
      await s.close();
    }
  });

  it('persists users in SQLite WAL and survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-state-'));
    const dataDir = join(dir, 'server');
    let first: SyncServer | null = createSyncServer({ dataDir, adminToken: 'admin-token' });
    try {
      await first.ready;
      await new Promise<void>((resolve) => first!.server.listen(0, resolve));
      const firstUrl = `http://localhost:${(first.server.address() as AddressInfo).port}`;
      expect((await registerUser(firstUrl, 'persisted', 'pw')).status).toBe(200);
      const status = await fetch(firstUrl + '/admin/status', { headers: { Authorization: 'Bearer admin-token' } });
      expect(await status.json()).toMatchObject({ journalMode: 'wal', schemaVersion: 5, userCount: 1 });
      await first.close();
      first = null;
      expect(existsSync(join(dataDir, 'server.sqlite'))).toBe(true);
      expect(existsSync(join(dataDir, 'server.secret'))).toBe(true);
      expect(existsSync(join(dataDir, 'server-id'))).toBe(true);
      expect(existsSync(join(dataDir, 'opaque.server-setup'))).toBe(true);
      const driver = new NodeSqliteDriver(join(dataDir, 'server.sqlite'));
      expect(await driver.get('SELECT username FROM sync_users WHERE username = ?', ['persisted'])).toMatchObject({ username: 'persisted' });
      expect(await driver.get('PRAGMA quick_check')).toMatchObject({ quick_check: 'ok' });
      await driver.close();

      const restarted = createSyncServer({ dataDir });
      try {
        await restarted.ready;
        await new Promise<void>((resolve) => restarted.server.listen(0, resolve));
        const restartedUrl = `http://localhost:${(restarted.server.address() as AddressInfo).port}`;
        expect((await loginUser(restartedUrl, 'persisted', 'pw')).status).toBe(200);
      } finally {
        await restarted.close();
      }
    } finally {
      await first?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a new nested data directory before writing server state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-state-parent-'));
    const dataDir = join(root, 'new', 'nested');
    const s = createSyncServer({ dataDir });
    await s.ready;
    await new Promise<void>((resolve) => s.server.listen(0, resolve));
    try {
      const base = `http://localhost:${(s.server.address() as AddressInfo).port}`;
      expect((await registerUser(base, 'fresh-path', 'pw')).status).toBe(200);
      expect(existsSync(join(dataDir, 'server.sqlite'))).toBe(true);
      expect(existsSync(join(dataDir, 'server.secret'))).toBe(true);
      expect(existsSync(join(dataDir, 'server-id'))).toBe(true);
      expect(existsSync(join(dataDir, 'opaque.server-setup'))).toBe(true);
    } finally {
      await s.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a server database that is not the current development schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-state-invalid-'));
    try {
      const database = join(dir, 'server.sqlite');
      const driver = new NodeSqliteDriver(database);
      await driver.exec('CREATE TABLE server_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);');
      await driver.run('INSERT INTO server_schema_migrations (version, name, applied_at) VALUES (99, ?, ?)', ['retired', new Date().toISOString()]);
      await driver.close();
      const s = createSyncServer({ dataDir: dir });
      await expect(s.ready).rejects.toThrow(/不是当前开发版结构/);
      await s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates, verifies, and restores an atomic server backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-backup-'));
    const dataDir = join(root, 'source');
    const backupDir = join(root, 'backup-1');
    const restoredDir = join(root, 'restored');
    const source = createSyncServer({ dataDir });
    try {
      await source.ready;
      await new Promise<void>((resolve) => source.server.listen(0, resolve));
      const base = `http://localhost:${(source.server.address() as AddressInfo).port}`;
      expect((await registerUser(base, 'recovered', 'pw')).status).toBe(200);
    } finally {
      await source.close();
    }
    try {
      const manifest = await createServerBackup(dataDir, backupDir);
      expect(manifest.files.some((file) => file.path === 'server.sqlite')).toBe(true);
      expect(await verifyServerBackup(backupDir)).toMatchObject({ ok: true, databaseResult: 'ok' });
      await restoreServerBackup(backupDir, restoredDir);
      const restored = createSyncServer({ dataDir: restoredDir });
      try {
        await restored.ready;
        await new Promise<void>((resolve) => restored.server.listen(0, resolve));
        const base = `http://localhost:${(restored.server.address() as AddressInfo).port}`;
        expect((await loginUser(base, 'recovered', 'pw')).status).toBe(200);
      } finally {
        await restored.close();
      }
      writeFileSync(join(backupDir, 'server-id'), 'tampered');
      expect(await verifyServerBackup(backupDir)).toMatchObject({ ok: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
