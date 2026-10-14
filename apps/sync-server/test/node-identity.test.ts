import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import * as opaque from '@serenity-kit/opaque';
import { loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { encryptJson, sha256Json, unlockLedgerKeyEnvelope, type LedgerKeyEnvelope } from '@zichan/core';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { createServerBackup, restoreServerBackup, verifyServerBackup } from '../src/backup.js';
import { loadNodeIdentity, NODE_SIGNING_KEY_FILE, verifyNodeSignature } from '../src/node-identity.js';
import { signNodeRequest, verifyNodeRequest } from '../src/node-request-auth.js';

describe('node signing identity', () => {
  it('persists an Ed25519 identity and rejects a missing or changed bound key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-node-identity-'));
    try {
      const first = loadNodeIdentity(dir, 'srv-test');
      const payload = Buffer.from('ledger:one:replicate');
      const signature = first.sign(payload);
      expect(verifyNodeSignature(first.publicKey, payload, signature)).toBe(true);
      expect(verifyNodeSignature(first.publicKey, Buffer.from('ledger:two:replicate'), signature)).toBe(false);
      expect(loadNodeIdentity(dir, 'srv-test', first.publicKey).publicKey).toBe(first.publicKey);
      expect(() => loadNodeIdentity(dir, 'srv-test', 'another-key')).toThrow(/不一致/);
      rmSync(join(dir, NODE_SIGNING_KEY_FILE));
      expect(() => loadNodeIdentity(dir, 'srv-test', first.publicKey)).toThrow(/缺失/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('binds a node proof to its grant, body, method, path and time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-node-proof-'));
    try {
      const identity = loadNodeIdentity(dir, 'srv-test');
      const body = Buffer.from('{"ledgerId":"ledger-test"}');
      const proof = signNodeRequest(identity, 'grant-test', 'POST', '/api/v4/replication/commits', body);
      expect(verifyNodeRequest(proof, identity.publicKey, 'POST', '/api/v4/replication/commits', body)).toBe(true);
      expect(verifyNodeRequest(proof, identity.publicKey, 'GET', '/api/v4/replication/commits', body)).toBe(false);
      expect(verifyNodeRequest(proof, identity.publicKey, 'POST', '/api/v4/replication/other', body)).toBe(false);
      expect(verifyNodeRequest(proof, identity.publicKey, 'POST', '/api/v4/replication/commits', Buffer.from('{}'))).toBe(false);
      expect(verifyNodeRequest({ ...proof, grantId: 'another-grant' }, identity.publicKey, 'POST', '/api/v4/replication/commits', body)).toBe(false);
      expect(verifyNodeRequest(proof, identity.publicKey, 'POST', '/api/v4/replication/commits', body, Date.now() + 3600_000)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('includes the bound signing key in a verified server backup and preserves it on restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-node-backup-'));
    const dataDir = join(root, 'source');
    const server = createTestSyncServer({ dataDir });
    let sourceClosed = false;
    let restored: ReturnType<typeof createTestSyncServer> | undefined;
    try {
      await server.ready;
      const original = loadNodeIdentity(dataDir, server.serverId);
      await server.close();
      sourceClosed = true;
      const backup = join(root, 'backup');
      const manifest = await createServerBackup(dataDir, backup);
      expect(manifest.files.some((file) => file.path === NODE_SIGNING_KEY_FILE)).toBe(true);
      expect((await verifyServerBackup(backup)).ok).toBe(true);
      await restoreServerBackup(backup, join(root, 'restored'));
      restored = createTestSyncServer({ dataDir: join(root, 'restored') });
      await restored.ready;
      expect(loadNodeIdentity(restored.dataDir, restored.serverId).publicKey).toBe(original.publicKey);
      await restored.close();
      restored = undefined;
      rmSync(join(dataDir, NODE_SIGNING_KEY_FILE));
      const invalid = createTestSyncServer({ dataDir });
      await expect(invalid.ready).rejects.toThrow(/签名私钥缺失/);
      await invalid.close();
      expect(existsSync(join(dataDir, NODE_SIGNING_KEY_FILE))).toBe(false);
    } finally {
      await restored?.close();
      if (!sourceClosed) await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows a scoped peer to pull once and refuses replay or revocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-node-grant-'));
    const source = createTestSyncServer({ dataDir: join(root, 'source') });
    const peer = createTestSyncServer({ dataDir: join(root, 'peer') });
    try {
      await Promise.all([source.ready, peer.ready]);
      await Promise.all([source, peer].map((server) => new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve))));
      const url = `http://127.0.0.1:${(source.server.address() as AddressInfo).port}`;
      await registerAccount(url, 'owner', 'node-grant-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      const session = await loginAccount(url, 'owner', 'node-grant-password');
      const authorization = { Authorization: `Bearer ${session.accessToken}` };
      const initialized = await fetch(`${url}/api/v3/protection/initialize`, {
        method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'managed' }),
      });
      expect(initialized.status).toBe(200);
      const { replica, secret, envelope } = await initialized.json() as { replica: { ledgerId: string }; secret: string; envelope: LedgerKeyEnvelope };
      expect((await (await fetch(`${url}/api/v3/replica`, { headers: authorization })).json() as {
        serverManagedReplication: boolean;
      }).serverManagedReplication).toBe(false);
      const identity = loadNodeIdentity(peer.dataDir, peer.serverId);
      const grantResponse = await fetch(`${url}/api/v4/replication/grants`, {
        method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerNodeId: peer.serverId, peerPublicKey: identity.publicKey, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
      });
      expect(grantResponse.status).toBe(201);
      const { grantId } = await grantResponse.json() as { grantId: string };
      expect((await (await fetch(`${url}/api/v3/replica`, { headers: authorization })).json() as {
        serverManagedReplication: boolean;
      }).serverManagedReplication).toBe(true);
      const commit = { protocol: 2, ledgerId: replica.ledgerId, commitId: 'test-commit-00000000000001', originDeviceId: 'test-device',
        createdAt: new Date().toISOString(), parentCommitIds: [], revisions: [] };
      const contentHash = await sha256Json(commit);
      const encCommit = await encryptJson(await unlockLedgerKeyEnvelope(secret, envelope), commit,
        { protocol: 2, ledgerId: replica.ledgerId, commitId: commit.commitId, contentHash });
      const postPath = '/api/v4/replication/commits';
      const postBody = JSON.stringify({ commits: [{ commitId: commit.commitId, ledgerId: replica.ledgerId,
        contentHash, encCommit, keyEpoch: 0 }], requiredCapabilities: [] });
      const postProof = signNodeRequest(identity, grantId, 'POST', postPath, Buffer.from(postBody));
      const pushed = await fetch(`${url}${postPath}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Zichan-Node-Proof': JSON.stringify(postProof) }, body: postBody });
      expect(pushed.status).toBe(200);
      expect(await pushed.json()).toMatchObject({ assigned: [{ commitId: commit.commitId, contentHash }] });
      const path = '/api/v4/replication/commits?after=0&limit=200';
      const proof = signNodeRequest(identity, grantId, 'GET', path);
      const pull = () => fetch(`${url}${path}`, { headers: { 'X-Zichan-Node-Proof': JSON.stringify(proof) } });
      const first = await pull();
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ ledgerId: replica.ledgerId, commits: [{ commitId: commit.commitId, contentHash }] });
      expect((await pull()).status).toBe(403);
      expect((await fetch(`${url}/api/v4/replication/grants/${grantId}`, { method: 'DELETE', headers: authorization })).status).toBe(200);
      expect((await (await fetch(`${url}/api/v3/replica`, { headers: authorization })).json() as {
        serverManagedReplication: boolean;
      }).serverManagedReplication).toBe(true);
      const next = signNodeRequest(identity, grantId, 'GET', path);
      expect((await fetch(`${url}${path}`, { headers: { 'X-Zichan-Node-Proof': JSON.stringify(next) } })).status).toBe(403);
    } finally {
      await Promise.all([source.close(), peer.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renews only opted-in active grants after authenticated requests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-node-grant-renew-'));
    const source = createTestSyncServer({ dataDir: join(root, 'source') });
    const peer = createTestSyncServer({ dataDir: join(root, 'peer') });
    const database = new NodeSqliteDriver(join(source.dataDir, 'server.sqlite'));
    try {
      await Promise.all([source.ready, peer.ready]);
      await new Promise<void>((resolve) => source.server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(source.server.address() as AddressInfo).port}`;
      await registerAccount(url, 'owner', 'node-grant-renew-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      const session = await loginAccount(url, 'owner', 'node-grant-renew-password');
      const authorization = { Authorization: `Bearer ${session.accessToken}` };
      expect((await fetch(`${url}/api/v3/protection/initialize`, { method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'managed' }) })).status).toBe(200);
      const identity = loadNodeIdentity(peer.dataDir, peer.serverId);
      const createGrant = async (renewable?: boolean) => {
        const response = await fetch(`${url}/api/v4/replication/grants`, { method: 'POST',
          headers: { ...authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify({ peerNodeId: peer.serverId, peerPublicKey: identity.publicKey,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...(renewable === undefined ? {} : { renewable }) }) });
        expect(response.status).toBe(201);
        return await response.json() as { grantId: string; renewable: boolean };
      };
      const path = '/api/v4/replication/commits?after=0&limit=1';
      const pull = (grantId: string) => {
        const proof = signNodeRequest(identity, grantId, 'GET', path);
        return fetch(`${url}${path}`, { headers: { 'X-Zichan-Node-Proof': JSON.stringify(proof) } });
      };
      const expiry = async (grantId: string) => (await database.get<{ expires_at: string }>(
        'SELECT expires_at FROM node_replication_grants WHERE grant_id = ?', [grantId]))!.expires_at;
      const soon = new Date(Date.now() + 60_000).toISOString();
      const active = await createGrant(true);
      expect(active.renewable).toBe(true);
      const listed = await (await fetch(`${url}/api/v4/replication/grants`, { headers: authorization })).json() as {
        grants: { grantId: string; renewable: boolean }[];
      };
      expect(listed.grants).toContainEqual(expect.objectContaining({ grantId: active.grantId, renewable: true }));
      await database.run('UPDATE node_replication_grants SET expires_at = ? WHERE grant_id = ?', [soon, active.grantId]);
      expect((await pull(active.grantId)).status).toBe(200);
      expect(Date.parse(await expiry(active.grantId))).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      expect((await fetch(`${url}/api/v4/replication/grants/${active.grantId}`, { method: 'DELETE', headers: authorization })).status).toBe(200);
      expect((await pull(active.grantId)).status).toBe(403);
      const afterRevoke = await (await fetch(`${url}/api/v4/replication/grants`, { headers: authorization })).json() as {
        grants: { grantId: string }[];
      };
      expect(afterRevoke.grants.some((grant) => grant.grantId === active.grantId)).toBe(false);

      const fixed = await createGrant();
      expect(fixed.renewable).toBe(false);
      await database.run('UPDATE node_replication_grants SET expires_at = ? WHERE grant_id = ?', [soon, fixed.grantId]);
      expect((await pull(fixed.grantId)).status).toBe(200);
      expect(await expiry(fixed.grantId)).toBe(soon);

      const expired = await createGrant(true);
      const past = new Date(Date.now() - 1000).toISOString();
      await database.run('UPDATE node_replication_grants SET expires_at = ? WHERE grant_id = ?', [past, expired.grantId]);
      expect((await pull(expired.grantId)).status).toBe(403);
      expect(await expiry(expired.grantId)).toBe(past);
    } finally {
      await Promise.all([source.close(), peer.close(), database.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

});
