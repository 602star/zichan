import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as opaque from '@serenity-kit/opaque';
import type { SyncServer } from '../src/server.js';
import { createTestSyncServer as createSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { createServerBackup, restoreServerBackup, verifyServerBackup } from '../src/backup.js';
import { CURRENT_SERVER_SCHEMA, SyncServerStore } from '../src/store.js';
import { normalizeSyncUsername, PLAIN_HTTP_HOST_ALLOWLIST } from '@zichan/core';
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

const post2 = (base: string, p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Maintenance work is asynchronous now: polls one job until it leaves the running states. */
async function waitForJob(base: string, headers: Record<string, string>, jobId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${base}/api/admin/jobs/${jobId}`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json() as { job: { status: string } };
    if (!['queued', 'running'].includes(body.job.status)) return body as { job: { status: string; result?: Record<string, unknown>; errorCode?: string; errorMessage?: string } };
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} never finished`);
}

async function registerUser(base: string, username: string, password: string, inviteCode?: string, prefix = '', initializeOwner = true): Promise<Response> {
  const normalized = normalizeSyncUsername(username);
  await opaque.ready;
  const start = opaque.client.startRegistration({ password });
  const health = await (await fetch(`${base}${prefix}/api/health`)).json() as { claimed: boolean };
  const startResponse = await post2(base, `${prefix}/api/auth/register/start`, {
    ...(!health.claimed && initializeOwner ? { ownerSetupToken: OWNER_SETUP_TOKEN } : {}),
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
    credentialServerPublicKey?: string;
  };
  const finish = opaque.client.finishRegistration({
    password,
    registrationResponse: startBody.registrationResponse,
    clientRegistrationState: start.clientRegistrationState,
    identifiers: { client: normalized, server: startBody.serverId },
    keyStretching: 'memory-constrained',
  });
  expect(finish.serverStaticPublicKey).toBe(startBody.credentialServerPublicKey ?? startBody.serverPublicKey);
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
  headers: Record<string, string> = {},
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
    credentialServerPublicKey?: string;
  };
  const finish = opaque.client.finishLogin({
    clientLoginState: start.clientLoginState,
    loginResponse: startBody.loginResponse,
    password,
    identifiers: { client: normalized, server: startBody.serverId },
    keyStretching: 'memory-constrained',
  });
  if (finish) expect(finish.serverStaticPublicKey).toBe(startBody.credentialServerPublicKey ?? startBody.serverPublicKey);
  return post2(base, `${prefix}/api/auth/login/finish`, {
    loginId: startBody.loginId,
    finishLoginRequest: finish?.finishLoginRequest ?? 'invalid-opaque-login-finish',
    deviceId,
    deviceName: `Test ${deviceId}`,
  }, headers);
}

async function accessToken(base: string, username: string, password: string, prefix = '', deviceId?: string): Promise<string> {
  const response = await loginUser(base, username, password, prefix, deviceId);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

describe('sync-server endpoints', () => {
  it('keeps browser refresh secrets in same-origin HttpOnly cookies and rejects mixed or cross-site refresh', async () => {
    const app = createSyncServer({ basePath: '/ledger' });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      expect((await registerUser(base, 'cookie-user', 'cookie-password', undefined, '/ledger')).status).toBe(200);
      const headers = { Origin: base, 'X-Zichan-Session': 'cookie' };
      const loggedIn = await loginUser(base, 'cookie-user', 'cookie-password', '/ledger', 'device-cookie', headers);
      expect(loggedIn.status).toBe(200);
      const login = await loggedIn.json() as { accessToken: string; refreshToken?: string; sessionTransport: string };
      expect(login.refreshToken).toBeUndefined();
      expect(login.sessionTransport).toBe('cookie');
      const setCookie = loggedIn.headers.get('set-cookie')!;
      expect(setCookie).toContain('Path=/ledger/api/auth; HttpOnly; SameSite=Lax');
      expect(setCookie).not.toContain('Max-Age');
      const cookie = setCookie.split(';')[0]!;
      const endpoint = '/ledger/api/auth/refresh';
      expect((await post2(base, endpoint, {}, { ...headers, Origin: 'https://evil.example', Cookie: cookie })).status).toBe(403);
      expect((await post2(base, endpoint, {}, { 'X-Zichan-Session': 'cookie', Cookie: cookie })).status).toBe(403);
      expect((await post2(base, endpoint, { refreshToken: 'body-token' }, { ...headers, Cookie: cookie })).status).toBe(400);
      expect((await post2(base, endpoint, {}, { Cookie: cookie })).status).toBe(401);
      const refreshed = await post2(base, endpoint, {}, { ...headers, Cookie: cookie });
      expect(refreshed.status).toBe(200);
      const next = await refreshed.json() as { accessToken: string; refreshToken?: string };
      expect(next.refreshToken).toBeUndefined();
      const nextCookie = refreshed.headers.get('set-cookie')!.split(';')[0]!;
      expect(nextCookie).not.toBe(cookie);
      expect((await post2(base, endpoint, {}, { ...headers, Cookie: cookie })).status).toBe(401);
      const logout = await post2(base, '/ledger/api/auth/logout', {}, { ...headers, Cookie: nextCookie, Authorization: `Bearer ${next.accessToken}` });
      expect(logout.status).toBe(200);
      expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
      expect((await post2(base, endpoint, {}, { ...headers, Cookie: nextCookie })).status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('requires explicit setup and allows exactly one concurrent owner claim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-owner-race-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'open', 'srv-owner-race');
    try {
      await store.ready;
      await expect(store.register('ordinary-visitor', 'opaque-record')).rejects.toMatchObject({ code: 'OWNER_SETUP_REQUIRED' });
      const registrations = await Promise.allSettled(Array.from({ length: 100 }, (_, index) =>
        store.register(`race-user-${String(index).padStart(3, '0')}`, `opaque-record-${index}`, undefined, true)));
      expect(registrations.filter((registration) => registration.status === 'fulfilled')).toHaveLength(1);
      expect(registrations.filter((registration) => registration.status === 'rejected')).toHaveLength(99);
      const users = await store.listUsers('', 200);
      expect(users.users).toHaveLength(1);
      expect(users.users.filter((user) => user['role'] === 'owner')).toHaveLength(1);
      expect(await store.ownerUsername()).toBeTruthy();
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers, binds one ledger replica, and stores encrypted commits idempotently', async () => {
    const health = (await (await fetch(url + '/api/health')).json()) as {
      ok: boolean;
      serverId: string;
      serverPublicKey: string;
      claimed: boolean;
      protocols: number[];
      capabilities: string[];
    };
    expect(health.ok).toBe(true);
    expect(health.serverId).toBe(readFileSync(join(sv.dataDir, 'server-id'), 'utf8').trim());
    expect(health.serverPublicKey).toBeTruthy();
    expect(health.claimed).toBe(false);
    expect(health.protocols).toEqual([3]);
    expect(health.capabilities).toContain('admin-session-v1');
    const ready = await fetch(url + '/api/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ok: true,
      serverId: health.serverId,
      database: { ok: true, tempStore: 'memory' },
    });

    const registration = await registerUser(url, 'alice', 'pw');
    expect(registration.status).toBe(200);
    expect(await registration.json()).toMatchObject({ role: 'owner' });
    expect(await (await fetch(url + '/api/health')).json()).toMatchObject({ claimed: true });
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
    expect(await (await fetch(url + '/api/auth/me', { headers })).json()).toMatchObject({
      username: 'alice',
      role: 'owner',
      disabled: false,
      ledgerId,
      replicaId: replica.replicaId,
      streamEpoch: replica.streamEpoch,
      session: { replicaId: replica.replicaId },
    });

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

  it('allows repeated authenticated account reads during replica browsing', async () => {
    const app = createSyncServer();
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      expect((await registerUser(base, 'account-read-user', 'account-read-password')).status).toBe(200);
      const token = await accessToken(base, 'account-read-user', 'account-read-password');
      for (let index = 0; index < 25; index += 1) {
        const response = await fetch(`${base}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        await response.body?.cancel();
      }
    } finally {
      await app.close();
    }
  });

  it('keeps ordinary replica API reads available through a busy signed-in session', async () => {
    const app = createSyncServer();
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      expect((await registerUser(base, 'replica-read-user', 'replica-read-password')).status).toBe(200);
      const token = await accessToken(base, 'replica-read-user', 'replica-read-password');
      for (let index = 0; index < 125; index += 1) {
        const response = await fetch(`${base}/api/v3/replica`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        await response.body?.cancel();
      }
    } finally {
      await app.close();
    }
  });

  it('requires HTTPS for a proxied public client and allows credential-free CORS from any origin', async () => {
    const s = createSyncServer({
      trustedProxies: ['loopback'],
    });
    await new Promise<void>((resolve) => s.server.listen(0, resolve));
    const base = `http://localhost:${(s.server.address() as AddressInfo).port}`;
    try {
      const preflight = await fetch(base + '/api/auth/me', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://official-web.example.test',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      // `X-Zichan-Client` is the client's self-reported build identification. A browser drops a
      // custom header unless the preflight allows it by name, and the loss is silent: syncing
      // still works, only the diagnostics lose the client version.
      expect(preflight.headers.get('access-control-allow-headers')).toBe('Content-Type,Authorization,X-Zichan-Client');
      expect(preflight.headers.has('access-control-allow-credentials')).toBe(false);
      const forwarded = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.8' };
      const startLoginRequest = opaque.client.startLogin({ password: 'public-test' }).startLoginRequest;
      expect((await fetch(base + '/api/auth/login/start', {
        method: 'POST',
        headers: forwarded,
        body: JSON.stringify({ username: 'public-user', startLoginRequest }),
      })).status).toBe(426);
      const crossOrigin = await fetch(base + '/api/auth/login/start', {
        method: 'POST',
        headers: {
          ...forwarded,
          'X-Forwarded-Proto': 'https',
          Origin: 'https://evil.example.test',
        },
        body: JSON.stringify({ username: 'public-user', startLoginRequest }),
      });
      expect(crossOrigin.status).toBe(200);
      expect(crossOrigin.headers.get('access-control-allow-origin')).toBe('*');
      expect(crossOrigin.headers.has('access-control-allow-credentials')).toBe(false);
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
      expect(allowed.headers.get('access-control-allow-origin')).toBe('*');
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
      expect((await registerUser(u, 'owner', 'owner-password')).status).toBe(200);
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

  it('requires the deployment secret for the owner and protects management with account sessions', async () => {
    const s = createSyncServer({ registrationMode: 'invite' });
    await new Promise<void>((r) => s.server.listen(0, r));
    const u = `http://localhost:${(s.server.address() as AddressInfo).port}`;
    try {
      const ordinary = await registerUser(u, 'visitor-user', 'visitor-password', undefined, '', false);
      expect(ordinary.status).toBe(403);
      expect(await ordinary.json()).toMatchObject({ code: 'OWNER_SETUP_REQUIRED' });
      const rejected = await post2(u, '/api/auth/register/start', { username: 'visitor-user', registrationRequest: 'not-an-opaque-request', ownerSetupToken: 'wrong-secret' });
      expect(await rejected.json()).toMatchObject({ code: 'INVALID_OWNER_SETUP' });
      const ownerRegistration = await registerUser(u, 'owner-user', 'owner-password');
      expect(ownerRegistration.status).toBe(200);
      expect(await ownerRegistration.json()).toMatchObject({ role: 'owner' });
      const reused = await post2(u, '/api/auth/register/start', { username: 'another-owner', registrationRequest: 'not-an-opaque-request', ownerSetupToken: OWNER_SETUP_TOKEN });
      expect(await reused.json()).toMatchObject({ code: 'OWNER_ALREADY_CLAIMED' });
      const ownerToken = await accessToken(u, 'owner-user', 'owner-password');
      const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` };
      expect(await (await fetch(u + '/api/auth/me', { headers: adminHeaders })).json()).toMatchObject({
        username: 'owner-user',
        role: 'owner',
        disabled: false,
        session: { username: 'owner-user', active: true },
      });
      expect((await fetch(u + '/api/admin/overview', {
        headers: { Authorization: 'Bearer retired-static-credential' },
      })).status).toBe(401);
      const retiredHeaderName = ['X', 'Admin', 'Token'].join('-');
      expect((await fetch(u + '/api/admin/overview', {
        headers: { [retiredHeaderName]: 'retired-static-credential' },
      })).status).toBe(401);
      expect((await registerUser(u, 'invite-user', 'pw')).status).toBe(403);

      const inviteRes = await fetch(u + '/api/admin/invites', { method: 'POST', headers: adminHeaders, body: '{}' });
      expect(inviteRes.status).toBe(200);
      const { invite } = (await inviteRes.json()) as { invite: { code: string } };
      expect(invite.code).toBeTruthy();

      const memberRegistration = await registerUser(u, 'invite-user', 'pw', invite.code);
      expect(memberRegistration.status).toBe(200);
      expect(await memberRegistration.json()).toMatchObject({ role: 'member' });
      const memberToken = await accessToken(u, 'invite-user', 'pw');
      expect((await fetch(u + '/api/admin/overview', {
        headers: { Authorization: `Bearer ${memberToken}` },
      })).status).toBe(403);
      const usersRes = await fetch(u + '/api/admin/users', { headers: adminHeaders });
      const usersBody = await usersRes.json();
      expect(JSON.stringify(usersBody)).not.toContain('opaqueRegistrationRecord');
      expect((usersBody as { users: { username: string; role: string; commitCount: number }[] }).users).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ username: 'owner-user', role: 'owner', commitCount: 0 }),
          expect.objectContaining({ username: 'invite-user', role: 'member', commitCount: 0 }),
        ]),
      );
      const quota = await fetch(u + '/api/admin/quotas/invite-user/blobs', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ quotaBytes: 8 * 1024 * 1024 }),
      });
      expect(quota.status).toBe(200);
      expect(await (await fetch(u + '/api/admin/quotas', { headers: adminHeaders })).json()).toMatchObject({
        users: expect.arrayContaining([expect.objectContaining({ username: 'invite-user', quotaBytes: 8 * 1024 * 1024 })]),
      });
      // Heavy verification left the request path: the endpoint queues a job and returns 202.
      const verifyResponse = await fetch(u + '/api/admin/quotas/blobs/verify', { method: 'POST', headers: adminHeaders, body: '{}' });
      expect(verifyResponse.status).toBe(202);
      const queued = await verifyResponse.json() as { job: { jobId: string; type: string; status: string } };
      expect(queued.job).toMatchObject({ type: 'blobs.verify', status: 'queued' });
      const verifyJob = await waitForJob(u, adminHeaders, queued.job.jobId);
      expect(verifyJob.job.status).toBe('succeeded');
      expect(verifyJob.job.result).toMatchObject({ checkedObjects: 0, checkedChunks: 0, issueCount: 0 });
      expect((await fetch(u + '/api/admin/quotas/invite-user/commits', {
        method: 'POST', headers: adminHeaders, body: JSON.stringify({ commitQuotaBytes: 8 * 1024 * 1024 }),
      })).status).toBe(200);
      expect(await (await fetch(u + '/api/admin/users?limit=10', { headers: adminHeaders })).json()).toMatchObject({
        users: expect.arrayContaining([expect.objectContaining({ username: 'invite-user', commitQuotaBytes: 8 * 1024 * 1024 })]),
      });
      // The deep check is a maintenance job; the legacy GET only reports the recorded result.
      expect(await (await fetch(u + '/api/admin/database/verify', { headers: adminHeaders })).json()).toMatchObject({
        verification: { ok: null, result: 'not-run' },
        mode: 'recorded',
      });
      const deepResponse = await fetch(u + '/api/admin/database/verify', { method: 'POST', headers: adminHeaders, body: '{}' });
      expect(deepResponse.status).toBe(202);
      const deepJob = await waitForJob(u, adminHeaders, ((await deepResponse.json()) as { job: { jobId: string } }).job.jobId);
      expect(deepJob.job.status).toBe('succeeded');
      expect(deepJob.job.result).toMatchObject({ ok: true, result: 'ok' });
      expect(await (await fetch(u + '/api/admin/database/verify', { headers: adminHeaders })).json()).toMatchObject({
        verification: { ok: true, result: 'ok', schemaVersion: CURRENT_SERVER_SCHEMA },
      });

      const login = await loginUser(u, 'invite-user', 'pw');
      const session = await login.json() as { accessToken: string; session: { id: string } };
      expect(await (await fetch(u + '/api/admin/users/invite-user/devices', { headers: adminHeaders })).json()).toMatchObject({
        devices: expect.arrayContaining([expect.objectContaining({ id: session.session.id, active: true })]),
      });
      expect((await fetch(`${u}/api/admin/sessions/${session.session.id}/revoke`, {
        method: 'POST', headers: adminHeaders, body: '{}',
      })).status).toBe(200);
      expect((await fetch(u + '/api/v3/replica', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      })).status).toBe(401);
      expect((await loginUser(u, 'invite-user', 'pw')).status).toBe(200);
      expect((await fetch(u + '/api/admin/users/owner-user/disable', {
        method: 'POST', headers: adminHeaders, body: JSON.stringify({ disabled: true }),
      })).status).toBe(409);
      const disable = await fetch(u + '/api/admin/users/invite-user/disable', {
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

  it('mounts account, sync, and management APIs under a base path and exposes logs', async () => {
    const s = createSyncServer({ basePath: '/账本-2026' });
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
      const ownerAccessToken = await accessToken(u, 'logger', 'pw', prefix);

      expect((await fetch(u + '/%E8%B4%A6%E6%9C%AC-2026/admin/logs', {
        headers: { Authorization: `Bearer ${ownerAccessToken}` },
      })).status).toBe(404);
      const logs = await fetch(u + '/%E8%B4%A6%E6%9C%AC-2026/api/admin/logs?limit=20', {
        headers: { Authorization: `Bearer ${ownerAccessToken}` },
      });
      expect(logs.status).toBe(200);
      const body = (await logs.json()) as { logs: { action: string; username?: string; opaqueRegistrationRecord?: string }[] };
      expect(body.logs.map((row) => row.action)).toContain('login_failed');
      expect(body.logs.map((row) => row.action)).toContain('login_success');
      expect(JSON.stringify(body)).not.toContain('opaqueRegistrationRecord');
      expect(body.logs.some((row) => row.username === 'logger')).toBe(true);
      const future = await fetch(u + '/%E8%B4%A6%E6%9C%AC-2026/api/admin/logs?from=2099-01-01T00%3A00%3A00.000Z', {
        headers: { Authorization: `Bearer ${ownerAccessToken}` },
      });
      expect(((await future.json()) as { logs: unknown[] }).logs).toEqual([]);
      const past = await fetch(u + '/%E8%B4%A6%E6%9C%AC-2026/api/admin/logs?until=2000-01-01T00%3A00%3A00.000Z', {
        headers: { Authorization: `Bearer ${ownerAccessToken}` },
      });
      expect(((await past.json()) as { logs: unknown[] }).logs).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it('serves a web directory independently from the sync API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Zichan Web</title><div id="root"></div>');
    const s = createSyncServer({ webDir: dir, enableWeb: true, enableSync: false, basePath: '/ledger' });
    await new Promise<void>((r) => s.server.listen(0, r));
    const u = `http://localhost:${(s.server.address() as AddressInfo).port}`;
    try {
      const page = await fetch(u + '/');
      expect(page.status).toBe(200);
      const csp = page.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(csp).toContain("connect-src 'self' https:");
      expect(csp).not.toMatch(/connect-src[^;]*\shttp:(?:\s|;|$)/);
      expect(csp).not.toContain("script-src 'self' 'unsafe-eval'");
      expect(await page.text()).toContain('Zichan Web');
      expect((await post2(u, '/ledger/api/auth/login/start', { username: 'offline-user' })).status).toBe(503);
      const account = await fetch(u + '/ledger/api/auth/me');
      expect(account.status).toBe(503);
      expect(account.headers.get('content-type')).toContain('application/json');
      expect((await fetch(u + '/ledger/app/')).status).toBe(200);
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows LAN HTTP endpoints in the hosted app when LAN HTTP is enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-web-lan-csp-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Zichan Web</title>');
    const app = createSyncServer({ webDir: dir, enableWeb: true, enableSync: false,
      allowInsecureHttp: true });
    await new Promise<void>((resolve) => app.server.listen(0, resolve));
    const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
    try {
      const csp = (await fetch(`${base}/app/`)).headers.get('content-security-policy') ?? '';
      const connectSrc = csp.split('; ').find((directive) => directive.startsWith('connect-src')) ?? '';
      expect(connectSrc).toMatch(/\shttp:$/);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * The plain-HTTP exception has to be granted twice: once by the app gate
   * (`assertSecureSyncUrl`) and once by the browser, through `connect-src`. When
   * only the first was told, the fetch was blocked with no hint that a header was
   * responsible. This keeps the two layers on one list.
   */
  it('lets the hosted app reach every reviewed plain-HTTP host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-web-csp-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Zichan Web</title><div id="root"></div>');
    const s = createSyncServer({ webDir: dir, enableWeb: true, enableSync: false });
    await new Promise<void>((r) => s.server.listen(0, r));
    const u = `http://localhost:${(s.server.address() as AddressInfo).port}`;
    try {
      const csp = (await fetch(u + '/')).headers.get('content-security-policy') ?? '';
      const connectSrc = csp.split('; ').find((directive) => directive.startsWith('connect-src')) ?? '';
      // Assert the directive itself, not only the exceptions: an empty allowlist
      // is a valid state and must not be propped up by a synthetic entry.
      expect(connectSrc).toContain("'self'");
      expect(connectSrc).toContain('https:');
      for (const host of PLAIN_HTTP_HOST_ALLOWLIST) expect(connectSrc).toContain(host);
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
      expect((await registerUser(base, 'owner', 'owner-password')).status).toBe(200);
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
    let first: SyncServer | null = createSyncServer({ dataDir });
    try {
      await first.ready;
      await new Promise<void>((resolve) => first!.server.listen(0, resolve));
      const firstUrl = `http://localhost:${(first.server.address() as AddressInfo).port}`;
      expect((await registerUser(firstUrl, 'persisted', 'pw')).status).toBe(200);
      const ownerAccessToken = await accessToken(firstUrl, 'persisted', 'pw');
      const ready = await fetch(firstUrl + '/api/ready');
      expect(await ready.json()).toMatchObject({ mode: 'light', database: { journalMode: 'wal', tempStore: 'memory', schemaVersion: CURRENT_SERVER_SCHEMA } });
      const overview = await fetch(firstUrl + '/api/admin/overview', { headers: { Authorization: `Bearer ${ownerAccessToken}` } });
      expect(await overview.json()).toMatchObject({ snapshot: { counts: { userCount: 1 } } });
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

  it('serializes SQLite initialization while recovering a non-empty blob catalog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-blob-restart-'));
    const dataDir = join(root, 'server');
    const encrypted = new TextEncoder().encode('encrypted-blob-survives-a-server-restart');
    const blobId = createHash('sha256').update(encrypted).digest('hex');
    const manifest = {
      v: 1 as const,
      blobId,
      cipherBytes: encrypted.byteLength,
      chunkCount: 1,
      chunks: [{
        index: 0,
        sizeBytes: encrypted.byteLength,
        ciphertextSha256: blobId,
        iv: 'stable-restart-vector',
      }],
    };
    const initialized = createSyncServer({ dataDir });
    await initialized.ready;
    await initialized.close();
    const writer = new EncryptedBlobStore({ dataDir });
    let writerOpen = true;
    let restarted: SyncServer | undefined;
    try {
      await writer.ready;
      const plan = await writer.beginUpload('restart-user', 'restart-ledger', manifest);
      expect(plan.status).toBe('upload');
      await writer.putChunk('restart-user', plan.uploadId!, 0, encrypted);
      await writer.completeUpload('restart-user', plan.uploadId!);
      await writer.close();
      writerOpen = false;

      restarted = createSyncServer({ dataDir });
      await restarted.ready;
      expect(existsSync(join(dataDir, 'server.sqlite'))).toBe(true);
      await restarted.close();
      restarted = undefined;

      const reader = new EncryptedBlobStore({ dataDir });
      try {
        expect(await reader.status('restart-user', 'restart-ledger', [blobId]))
          .toEqual({ [blobId]: 'available' });
        expect(Array.from(await reader.chunk('restart-user', 'restart-ledger', blobId, 0)))
          .toEqual(Array.from(encrypted));
      } finally {
        await reader.close();
      }
    } finally {
      await restarted?.close();
      if (writerOpen) await writer.close();
      rmSync(root, { recursive: true, force: true });
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

  it('fails closed when an existing server identity is incomplete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-state-partial-'));
    const dataDir = join(root, 'server');
    const seed = createSyncServer({ dataDir });
    let seedOpen = true;
    try {
      await seed.ready;
      await seed.close();
      seedOpen = false;
      const names = ['server.secret', 'server-id', 'opaque.server-setup'] as const;
      for (const name of names) {
        const path = join(dataDir, name);
        const original = readFileSync(path, 'utf8');
        rmSync(path);
        const before = readdirSync(dataDir).sort();
        expect(() => createSyncServer({ dataDir })).toThrow(/数据目录不完整.*拒绝自动重建/);
        expect(readdirSync(dataDir).sort()).toEqual(before);
        expect(existsSync(path)).toBe(false);
        writeFileSync(path, original, 'utf8');
      }
    } finally {
      if (seedOpen) await seed.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not add identity files to an existing unidentified database', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zichan-state-unidentified-'));
    try {
      const driver = new NodeSqliteDriver(join(dataDir, 'server.sqlite'));
      await driver.exec('CREATE TABLE legacy_state (id INTEGER PRIMARY KEY);');
      await driver.close();
      const before = readdirSync(dataDir).sort();
      expect(() => createSyncServer({ dataDir })).toThrow(/缺少 server.secret.*server-id.*opaque.server-setup/);
      expect(readdirSync(dataDir).sort()).toEqual(before);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a server database that is not the current development schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-state-invalid-'));
    try {
      const seed = createSyncServer({ dataDir: dir });
      await seed.ready;
      await seed.close();
      const database = join(dir, 'server.sqlite');
      const driver = new NodeSqliteDriver(database);
      await driver.run('UPDATE server_schema_migrations SET version = 99, name = ?', ['retired']);
      await driver.close();
      const s = createSyncServer({ dataDir: dir });
      try {
        await expect(s.ready).rejects.toThrow(/数据库版本不匹配/);
      } finally {
        await s.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([CURRENT_SERVER_SCHEMA])('creates, verifies, and restores a schema %i server backup', async (_version) => {
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
