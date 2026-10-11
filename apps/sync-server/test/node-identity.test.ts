import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import * as opaque from '@serenity-kit/opaque';
import { loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { accountSigningPublicKey, attachmentRemoteBlobId, createAccountEncryptionKey,
  deriveAttachmentCryptoContext, encryptAttachmentChunk, encryptJson, sha256Bytes, sha256Json,
  signLedgerControlEvent, unlockLedgerKeyEnvelope, wrapLedgerCryptoSessionForMember,
  type LedgerKeyEnvelope } from '@zichan/core';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { createServerBackup, restoreServerBackup, verifyServerBackup } from '../src/backup.js';
import { loadNodeIdentity, NODE_SIGNING_KEY_FILE, verifyNodeSignature } from '../src/node-identity.js';
import { signNodeRequest, verifyNodeRequest } from '../src/node-request-auth.js';
import { SyncServerStore } from '../src/store.js';

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

  it('converges three nodes without browsers and resumes after a peer restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-node-worker-'));
    const source = createTestSyncServer({ dataDir: join(root, 'source') });
    let sourceClosed = false;
    let peer = createTestSyncServer({ dataDir: join(root, 'peer') });
    const third = createTestSyncServer({ dataDir: join(root, 'third') });
    try {
      await Promise.all([source.ready, peer.ready, third.ready]);
      await Promise.all([source, peer, third].map((server) => new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve))));
      const sourceUrl = `http://127.0.0.1:${(source.server.address() as AddressInfo).port}`;
      let peerUrl = `http://127.0.0.1:${(peer.server.address() as AddressInfo).port}`;
      const thirdUrl = `http://127.0.0.1:${(third.server.address() as AddressInfo).port}`;
      const auth = async (url: string) => {
        await registerAccount(url, 'owner', 'node-worker-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
        const session = await loginAccount(url, 'owner', 'node-worker-password');
        return { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' };
      };
      const sourceAuth = await auth(sourceUrl);
      const peerAuth = await auth(peerUrl);
      const thirdAuth = await auth(thirdUrl);
      const sourceInit = await fetch(`${sourceUrl}/api/v3/protection/initialize`, { method: 'POST', headers: sourceAuth, body: JSON.stringify({ mode: 'managed' }) });
      expect(sourceInit.status).toBe(200);
      const sourceProtection = await sourceInit.json() as { replica: { ledgerId: string }; secret: string; envelope: LedgerKeyEnvelope };
      const peerInit = await fetch(`${peerUrl}/api/v3/protection/initialize`, { method: 'POST', headers: peerAuth,
        body: JSON.stringify({ mode: 'private', envelope: sourceProtection.envelope }) });
      expect(peerInit.status).toBe(200);
      expect((await fetch(`${thirdUrl}/api/v3/protection/initialize`, { method: 'POST', headers: thirdAuth,
        body: JSON.stringify({ mode: 'private', envelope: sourceProtection.envelope }) })).status).toBe(200);
      const identity = loadNodeIdentity(peer.dataDir, peer.serverId);
      const grantResponse = await fetch(`${sourceUrl}/api/v4/replication/grants`, { method: 'POST', headers: sourceAuth,
        body: JSON.stringify({ peerNodeId: peer.serverId, peerPublicKey: identity.publicKey, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }) });
      expect(grantResponse.status).toBe(201);
      const { grantId } = await grantResponse.json() as { grantId: string };
      const linkResponse = await fetch(`${peerUrl}/api/v4/replication/links`, { method: 'POST', headers: peerAuth,
        body: JSON.stringify({ peerUrl: sourceUrl, peerNodeId: source.serverId,
          peerPublicKey: loadNodeIdentity(source.dataDir, source.serverId).publicKey, grantId }) });
      expect(linkResponse.status).toBe(201);
      const { link } = await linkResponse.json() as { link: { linkId: string } };
      const thirdIdentity = loadNodeIdentity(third.dataDir, third.serverId);
      const thirdGrant = await (await fetch(`${sourceUrl}/api/v4/replication/grants`, { method: 'POST', headers: sourceAuth,
        body: JSON.stringify({ peerNodeId: third.serverId, peerPublicKey: thirdIdentity.publicKey,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString() }) })).json() as { grantId: string };
      expect((await fetch(`${thirdUrl}/api/v4/replication/links`, { method: 'POST', headers: thirdAuth,
        body: JSON.stringify({ peerUrl: sourceUrl, peerNodeId: source.serverId,
          peerPublicKey: loadNodeIdentity(source.dataDir, source.serverId).publicKey, grantId: thirdGrant.grantId }) })).status).toBe(201);
      const peerTopology = await (await fetch(`${peerUrl}/api/v3/replica`, { headers: peerAuth })).json() as {
        serverId: string; streamEpoch: string; links: { peerNodeId: string; localStreamEpoch: string;
          peerStreamEpoch: string; enabled: boolean }[];
      };
      expect(peerTopology.links).toMatchObject([{ peerNodeId: source.serverId,
        localStreamEpoch: peerTopology.streamEpoch, enabled: true }]);
      expect(peerTopology.links[0]?.peerStreamEpoch).toBeTruthy();
      expect((await (await fetch(`${sourceUrl}/api/v3/replica`, { headers: sourceAuth })).json() as {
        links: unknown[];
      }).links).toEqual([]);
      const key = await unlockLedgerKeyEnvelope(sourceProtection.secret, sourceProtection.envelope);
      const publish = async (url: string, headers: Record<string, string>, commitId: string) => {
        const commit = { protocol: 2, ledgerId: sourceProtection.replica.ledgerId, commitId, originDeviceId: 'test-device',
          createdAt: new Date().toISOString(), parentCommitIds: [], revisions: [] };
        const contentHash = await sha256Json(commit);
        const encCommit = await encryptJson(key, commit, { protocol: 2, ledgerId: commit.ledgerId, commitId, contentHash });
        const response = await fetch(`${url}/api/v3/commits`, { method: 'POST', headers,
          body: JSON.stringify({ commits: [{ commitId, ledgerId: commit.ledgerId, contentHash, encCommit }],
            capabilities: ['asset-cost-v2'] }) });
        expect(response.status).toBe(200);
      };
      await publish(sourceUrl, sourceAuth, 'source-commit-0000000000001');
      await publish(peerUrl, peerAuth, 'peer-commit-00000000000001');
      await peer.flushNodeReplication();
      await peer.flushNodeReplication();
      const readIds = async (url: string, headers: Record<string, string>) => {
        const response = await fetch(`${url}/api/v3/commits?after=0`, { headers });
        const page = await response.json() as { commits: { commitId: string }[] };
        return page.commits.map((item) => item.commitId).sort();
      };
      const expected = ['peer-commit-00000000000001', 'source-commit-0000000000001'];
      expect(await readIds(sourceUrl, sourceAuth)).toEqual(expected);
      expect(await readIds(peerUrl, peerAuth)).toEqual(expected);
      await third.flushNodeReplication();
      expect(await readIds(thirdUrl, thirdAuth)).toEqual(expected);
      const sourceMe = await (await fetch(`${sourceUrl}/api/auth/me`, { headers: sourceAuth })).json() as { accountId: string };
      const peerMe = await (await fetch(`${peerUrl}/api/auth/me`, { headers: peerAuth })).json() as {
        accountId: string; federatedIdentity: { issuerNodeId: string; subjectAccountId: string };
      };
      const thirdMe = await (await fetch(`${thirdUrl}/api/auth/me`, { headers: thirdAuth })).json() as {
        federatedIdentity: { issuerNodeId: string; subjectAccountId: string };
      };
      expect(peerMe.accountId).not.toBe(sourceMe.accountId);
      expect(peerMe.federatedIdentity).toMatchObject({ issuerNodeId: source.serverId, subjectAccountId: sourceMe.accountId });
      expect(thirdMe.federatedIdentity).toMatchObject({ issuerNodeId: source.serverId, subjectAccountId: sourceMe.accountId });
      const accountKey = await createAccountEncryptionKey(source.serverId, sourceMe.accountId,
        'separate account encryption password');
      const publishedAccountKey = await fetch(`${sourceUrl}/api/v4/account/encryption-key`, {
        method: 'PUT', headers: sourceAuth,
        body: JSON.stringify({ envelope: accountKey.envelope, expectedRevision: 0 }),
      });
      expect(publishedAccountKey.status).toBe(200);
      const controlStore = new SyncServerStore(join(source.dataDir, 'server.sqlite'), 'open', source.serverId);
      let controlHash: string;
      try {
        const actor = { issuerNodeId: source.serverId, accountId: sourceMe.accountId };
        const control = await controlStore.initializeLedgerControl('owner',
          signLedgerControlEvent(accountKey.privateKey, { v: 1, ledgerId: sourceProtection.replica.ledgerId,
            seq: 1, previousHash: null, keyEpoch: 1, kind: 'MemberGenesis', actor,
            target: actor, role: 'OWNER',
            signingPublicKey: accountSigningPublicKey(accountKey.privateKey),
            encryptionPublicKey: accountKey.envelope.publicKey }));
        controlHash = control.headHash;
        await controlStore.putLedgerMemberKeyEnvelope('owner',
          await wrapLedgerCryptoSessionForMember(key, { issuerNodeId: source.serverId,
            accountId: sourceMe.accountId, recipientPublicKey: accountKey.envelope.publicKey, keyEpoch: 1 }));
      } finally { await controlStore.close(); }
      await peer.flushNodeReplication();
      await third.flushNodeReplication();
      for (const node of [peer, third]) {
        const catalog = new NodeSqliteDriver(join(node.dataDir, 'server.sqlite'));
        try {
          expect(await catalog.get<{ event_hash: string }>(
            'SELECT event_hash FROM ledger_control_events WHERE seq = 1')).toEqual({ event_hash: controlHash });
          expect(await catalog.get<{ count: number }>(
            'SELECT COUNT(*) AS count FROM ledger_member_key_envelopes WHERE key_epoch = 1'))
            .toEqual({ count: 1 });
        } finally { await catalog.close(); }
      }
      const peerAccountKey = await (await fetch(`${peerUrl}/api/v4/account/encryption-key`, { headers: peerAuth }))
        .json() as { record: { issuerNodeId: string; subjectAccountId: string; publicKey: string; revision: number } };
      expect(peerAccountKey.record).toMatchObject({ issuerNodeId: source.serverId,
        subjectAccountId: sourceMe.accountId, publicKey: accountKey.envelope.publicKey, revision: 1 });
      expect((await fetch(`${peerUrl}/api/v4/account/encryption-key`, { method: 'PUT', headers: peerAuth,
        body: JSON.stringify({ envelope: accountKey.envelope, expectedRevision: 1 }) })).status).toBe(409);
      const cookieLogin = async () => {
        await opaque.ready;
        const started = opaque.client.startLogin({ password: 'node-worker-password' });
        const startResponse = await fetch(`${sourceUrl}/api/auth/login/start`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'owner', startLoginRequest: started.startLoginRequest }) });
        const challenge = await startResponse.json() as { loginId: string; loginResponse: string };
        const finished = opaque.client.finishLogin({ clientLoginState: started.clientLoginState,
          loginResponse: challenge.loginResponse, password: 'node-worker-password',
          identifiers: { client: 'owner', server: source.serverId }, keyStretching: 'memory-constrained' });
        const response = await fetch(`${sourceUrl}/api/auth/login/finish`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: sourceUrl, 'X-Zichan-Session': 'cookie' },
          body: JSON.stringify({ loginId: challenge.loginId, finishLoginRequest: finished!.finishLoginRequest,
            deviceId: 'federation-test-device', deviceName: 'Federation test browser' }) });
        expect(response.status).toBe(200);
        return response.headers.get('set-cookie')!.split(';')[0]!;
      };
      const sourceCookie = await cookieLogin();
      const startFederation = await fetch(`${peerUrl}/api/auth/federation/start?issuer=${source.serverId}`, { redirect: 'manual' });
      expect(startFederation.status).toBe(302);
      const targetStateCookie = startFederation.headers.get('set-cookie')!.split(';')[0]!;
      const authorize = await fetch(startFederation.headers.get('location')!, { redirect: 'manual', headers: { Cookie: sourceCookie } });
      expect(authorize.status).toBe(302);
      const callbackUrl = authorize.headers.get('location')!;
      const callback = await fetch(callbackUrl, { redirect: 'manual', headers: { Cookie: targetStateCookie } });
      expect(callback.status).toBe(303);
      const targetSessionCookie = callback.headers.get('set-cookie')!.match(/zichan_session=[^;]+/)?.[0];
      expect(targetSessionCookie).toBeTruthy();
      const localRefresh = await fetch(`${peerUrl}/api/auth/refresh`, { method: 'POST',
        headers: { Origin: peerUrl, 'X-Zichan-Session': 'cookie', Cookie: targetSessionCookie!,
          'Content-Type': 'application/json' }, body: '{}' });
      expect(localRefresh.status).toBe(200);
      expect((await localRefresh.json() as { accountId: string }).accountId).toBe(peerMe.accountId);
      const rotatedTargetCookie = localRefresh.headers.get('set-cookie')!.match(/zichan_session=[^;]+/)?.[0];
      expect(rotatedTargetCookie).toBeTruthy();
      expect((await fetch(callbackUrl, { redirect: 'manual', headers: { Cookie: targetStateCookie } })).status).toBe(403);
      const status = await (await fetch(`${peerUrl}/api/v4/replication/links`, { headers: peerAuth })).json() as {
        links: { linkId: string; pullSeq: number; pushSeq: number; inventoryMatchedAt?: string;
          inventoryIssue?: string; lastError?: string }[];
      };
      expect(status.links).toMatchObject([{ linkId: link.linkId, pullSeq: 2, pushSeq: 2 }]);
      expect(status.links[0]?.lastError).toBeUndefined();
      expect(status.links[0]?.inventoryMatchedAt).toBeTruthy();
      expect(status.links[0]?.inventoryIssue).toBeUndefined();
      const metadataDb = new NodeSqliteDriver(join(source.dataDir, 'server.sqlite'));
      try {
        await metadataDb.run(`INSERT INTO ledger_replica_requirements (replica_id, capability)
          SELECT route.replica_id, ? FROM ledger_account_routes route
            JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
            WHERE route.username = ? AND slot.ledger_id = ?`,
        ['asset-cost-v2', 'owner', sourceProtection.replica.ledgerId]);
      } finally { await metadataDb.close(); }
      await peer.flushNodeReplication();
      await third.flushNodeReplication();
      const metadataStatus = await (await fetch(`${peerUrl}/api/v4/replication/links`, { headers: peerAuth })).json() as {
        links: { inventoryIssue?: string; lastError?: string }[];
      };
      expect(metadataStatus.links[0]?.lastError).toBeUndefined();
      expect(metadataStatus.links[0]?.inventoryIssue).toBeUndefined();
      const peerMetadataDb = new NodeSqliteDriver(join(peer.dataDir, 'server.sqlite'));
      try {
        expect(await peerMetadataDb.get<{ capability: string }>(
          `SELECT requirement.capability FROM ledger_replica_requirements requirement
            JOIN ledger_account_routes route ON route.replica_id = requirement.replica_id
            JOIN ledger_replica_slots slot ON slot.replica_id = route.replica_id
            WHERE route.username = ? AND slot.ledger_id = ?`,
          ['owner', sourceProtection.replica.ledgerId])).toEqual({ capability: 'asset-cost-v2' });
      } finally { await peerMetadataDb.close(); }

      const context = await deriveAttachmentCryptoContext(key, { v: 2, ledgerId: sourceProtection.replica.ledgerId });
      const uploadBlob = async (url: string, headers: Record<string, string>, value: string) => {
        const plaintext = Buffer.from(value);
        const sha256 = await sha256Bytes(plaintext);
        const blobId = await attachmentRemoteBlobId(context, sha256);
        const chunk = await encryptAttachmentChunk(context, sha256, plaintext, 0, 1, plaintext.byteLength);
        const manifest = { v: 2, blobId, cipherBytes: chunk.ciphertext.byteLength, chunkCount: 1,
          chunks: [{ index: 0, sizeBytes: chunk.ciphertext.byteLength, ciphertextSha256: chunk.ciphertextSha256, iv: chunk.iv }] };
        const begin = await fetch(`${url}/api/v3/blobs/uploads`, { method: 'POST', headers, body: JSON.stringify({ manifest }) });
        expect(begin.status).toBe(201);
        const plan = await begin.json() as { uploadId: string };
        expect((await fetch(`${url}/api/v3/blobs/uploads/${plan.uploadId}/chunks/0`, { method: 'PUT',
          headers: { Authorization: headers.Authorization! }, body: Buffer.from(chunk.ciphertext) })).status).toBe(200);
        expect((await fetch(`${url}/api/v3/blobs/uploads/${plan.uploadId}/complete`, { method: 'POST', headers })).status).toBe(200);
        return { blobId, ciphertextSha256: chunk.ciphertextSha256 };
      };
      const sourceBlob = await uploadBlob(sourceUrl, sourceAuth, 'portable attachment from public node');
      await peer.flushNodeReplication();
      const peerManifest = await fetch(`${peerUrl}/api/v3/blobs/${sourceBlob.blobId}/manifest`, { headers: peerAuth });
      expect(peerManifest.status).toBe(200);
      const peerChunk = await fetch(`${peerUrl}/api/v3/blobs/${sourceBlob.blobId}/chunks/0`, { headers: peerAuth });
      expect(await sha256Bytes(new Uint8Array(await peerChunk.arrayBuffer()))).toBe(sourceBlob.ciphertextSha256);
      for (const dataDir of [source.dataDir, peer.dataDir]) {
        const catalog = new NodeSqliteDriver(join(dataDir, 'server.sqlite'));
        try {
          const row = await catalog.get<{ namespace: string; replica_id: string; stored_replica_id: string }>(
            `SELECT b.namespace, replica.replica_id, b.replica_id AS stored_replica_id FROM blob_objects b
             JOIN sync_replicas replica ON replica.username = b.username AND replica.ledger_id = b.ledger_id
             WHERE b.blob_id = ?`, [sourceBlob.blobId]);
          expect(row?.stored_replica_id).toBe(row?.replica_id);
          expect(row?.namespace).toBe(createHash('sha256')
            .update(`replica-v2\0${sourceProtection.replica.ledgerId}\0${row?.replica_id}`).digest('hex'));
        } finally { await catalog.close(); }
      }
      const peerBlob = await uploadBlob(peerUrl, peerAuth, 'portable attachment from LAN node');
      await peer.flushNodeReplication();
      expect((await fetch(`${sourceUrl}/api/v3/blobs/${peerBlob.blobId}/manifest`, { headers: sourceAuth })).status).toBe(200);
      const largePlaintext = Buffer.alloc(4 * 1024 * 1024 + 17, 7);
      const largeHash = await sha256Bytes(largePlaintext);
      const largeId = await attachmentRemoteBlobId(context, largeHash);
      const parts = [largePlaintext.subarray(0, 4 * 1024 * 1024), largePlaintext.subarray(4 * 1024 * 1024)];
      const encryptedParts = await Promise.all(parts.map((part, index) =>
        encryptAttachmentChunk(context, largeHash, part, index, parts.length, largePlaintext.byteLength)));
      const largeManifest = { v: 2, blobId: largeId, cipherBytes: encryptedParts.reduce((sum, part) => sum + part.ciphertext.byteLength, 0),
        chunkCount: encryptedParts.length, chunks: encryptedParts.map((part) => ({ index: part.index,
          sizeBytes: part.ciphertext.byteLength, ciphertextSha256: part.ciphertextSha256, iv: part.iv })) };
      const beginLarge = async (url: string, headers: Record<string, string>) => {
        const response = await fetch(`${url}/api/v3/blobs/uploads`, { method: 'POST', headers,
          body: JSON.stringify({ manifest: largeManifest }) });
        expect(response.status).toBe(201);
        return response.json() as Promise<{ uploadId: string; missingChunks: number[] }>;
      };
      const sourceLarge = await beginLarge(sourceUrl, sourceAuth);
      for (const [index, chunk] of encryptedParts.entries()) {
        expect((await fetch(`${sourceUrl}/api/v3/blobs/uploads/${sourceLarge.uploadId}/chunks/${index}`, { method: 'PUT',
          headers: { Authorization: sourceAuth.Authorization }, body: Buffer.from(chunk.ciphertext) })).status).toBe(200);
      }
      expect((await fetch(`${sourceUrl}/api/v3/blobs/uploads/${sourceLarge.uploadId}/complete`, { method: 'POST', headers: sourceAuth })).status).toBe(200);
      const peerLarge = await beginLarge(peerUrl, peerAuth);
      expect((await fetch(`${peerUrl}/api/v3/blobs/uploads/${peerLarge.uploadId}/chunks/0`, { method: 'PUT',
        headers: { Authorization: peerAuth.Authorization }, body: Buffer.from(encryptedParts[0]!.ciphertext) })).status).toBe(200);
      expect((await beginLarge(peerUrl, peerAuth)).missingChunks).toEqual([1]);
      await peer.flushNodeReplication();
      expect((await fetch(`${peerUrl}/api/v3/blobs/${largeId}/manifest`, { headers: peerAuth })).status).toBe(200);
      await third.flushNodeReplication();
      expect((await fetch(`${thirdUrl}/api/v3/blobs/${sourceBlob.blobId}/manifest`, { headers: thirdAuth })).status).toBe(200);
      expect((await fetch(`${thirdUrl}/api/v3/blobs/${peerBlob.blobId}/manifest`, { headers: thirdAuth })).status).toBe(200);
      const progress = await (await fetch(`${peerUrl}/api/v4/replication/links`, { headers: peerAuth })).json() as {
        links: { peerBlobObjects: number; localBlobObjects: number; peerLegacyObjects: number;
          peerBlobBytes: number; localBlobBytes: number; pullBlobScannedBytes: number; pushBlobScannedBytes: number;
          pullBlobTransferredBytes: number; pushBlobTransferredBytes: number;
          pullBlobSweepAt?: string; pushBlobSweepAt?: string }[];
      };
      expect(progress.links[0]).toMatchObject({ peerBlobObjects: 3, localBlobObjects: 3, peerLegacyObjects: 0 });
      expect(progress.links[0]!.peerBlobBytes).toBeGreaterThan(4 * 1024 * 1024);
      expect(progress.links[0]!.localBlobBytes).toBe(progress.links[0]!.peerBlobBytes);
      expect(progress.links[0]!.pullBlobScannedBytes).toBe(progress.links[0]!.peerBlobBytes);
      expect(progress.links[0]!.pushBlobScannedBytes).toBe(progress.links[0]!.localBlobBytes);
      expect(progress.links[0]!.pullBlobTransferredBytes).toBeGreaterThan(0);
      expect(progress.links[0]!.pushBlobTransferredBytes).toBeGreaterThan(0);
      expect(progress.links[0]!.pullBlobTransferredBytes).toBeLessThan(progress.links[0]!.pullBlobScannedBytes);
      expect(progress.links[0]!.pushBlobTransferredBytes).toBeLessThan(progress.links[0]!.pushBlobScannedBytes);
      expect(progress.links[0]?.pullBlobSweepAt).toBeTruthy();
      expect(progress.links[0]?.pushBlobSweepAt).toBeTruthy();
      const physicalDatabase = new NodeSqliteDriver(join(peer.dataDir, 'server.sqlite'));
      try {
        const firstScan = await (await fetch(`${peerUrl}/api/v4/replication/links`, { headers: peerAuth })).json() as {
          links: { inventoryBlobHash?: string; physicalBlobHash?: string; physicalVerifiedAt?: string; physicalIssue?: string }[];
        };
        expect(firstScan.links[0]?.physicalVerifiedAt).toBeTruthy();
        expect(firstScan.links[0]?.physicalBlobHash).toBe(firstScan.links[0]?.inventoryBlobHash);
        const peerPhysical = await (await fetch(`${peerUrl}/api/v3/replica`, { headers: peerAuth })).json() as {
          physical: { verifiedAt?: string };
        };
        expect(peerPhysical.physical.verifiedAt).toBeTruthy();
        const row = await physicalDatabase.get<{ namespace: string }>(
          'SELECT namespace FROM blob_objects WHERE blob_id = ?', [sourceBlob.blobId]);
        const chunkPath = join(peer.dataDir, 'blobs', 'objects', row!.namespace,
          sourceBlob.blobId.slice(0, 2), sourceBlob.blobId, '0.chunk');
        const original = readFileSync(chunkPath);
        const damaged = Buffer.from(original);
        damaged[0] ^= 1;
        writeFileSync(chunkPath, damaged);
        await physicalDatabase.run("UPDATE node_replication_links SET physical_verified_at = '2020-01-01T00:00:00.000Z' WHERE link_id = ?", [link.linkId]);
        await physicalDatabase.run("UPDATE replica_physical_status SET verified_at = '2020-01-01T00:00:00.000Z' WHERE username = 'owner'");
        await peer.flushNodeReplication();
        const damagedScan = await (await fetch(`${peerUrl}/api/v4/replication/links`, { headers: peerAuth })).json() as {
          links: { physicalIssue?: string; physicalVerifiedAt?: string }[];
        };
        expect(damagedScan.links[0]?.physicalIssue).toMatch(/校验失败/);
        expect(damagedScan.links[0]?.physicalVerifiedAt).toBeUndefined();
        expect(existsSync(chunkPath)).toBe(false);
        const quarantineDir = join(peer.dataDir, 'blobs', 'quarantine', row!.namespace, sourceBlob.blobId.slice(0, 2));
        const quarantined = readdirSync(quarantineDir).filter((name) => name.startsWith(sourceBlob.blobId));
        expect(quarantined).toHaveLength(1);
        expect(readFileSync(join(quarantineDir, quarantined[0]!, '0.chunk'))).toEqual(damaged);
        await peer.flushNodeReplication();
        expect(readFileSync(chunkPath)).toEqual(original);
        const repairedScan = await (await fetch(`${peerUrl}/api/v4/replication/links`, { headers: peerAuth })).json() as {
          links: { physicalIssue?: string; physicalVerifiedAt?: string }[];
        };
        expect(repairedScan.links[0]?.physicalIssue).toBeUndefined();
        expect(repairedScan.links[0]?.physicalVerifiedAt).toBeTruthy();
      } finally { await physicalDatabase.close(); }
      await source.flushNodeReplication();
      const sourcePhysicalBefore = await (await fetch(`${sourceUrl}/api/v3/replica`, { headers: sourceAuth })).json() as {
        physical: { verifiedAt?: string; issue?: string };
      };
      expect(sourcePhysicalBefore.physical.verifiedAt).toBeTruthy();
      const sourcePhysicalDb = new NodeSqliteDriver(join(source.dataDir, 'server.sqlite'));
      try {
        const sourceObject = await sourcePhysicalDb.get<{ namespace: string }>(
          'SELECT namespace FROM blob_objects WHERE blob_id = ?', [peerBlob.blobId]);
        const sourceChunkPath = join(source.dataDir, 'blobs', 'objects', sourceObject!.namespace,
          peerBlob.blobId.slice(0, 2), peerBlob.blobId, '0.chunk');
        const clean = readFileSync(sourceChunkPath);
        const damaged = Buffer.from(clean);
        damaged[0] ^= 1;
        writeFileSync(sourceChunkPath, damaged);
        await sourcePhysicalDb.run("UPDATE replica_physical_status SET verified_at = '2020-01-01T00:00:00.000Z' WHERE username = 'owner'");
        await source.flushNodeReplication();
        const sourceDamaged = await (await fetch(`${sourceUrl}/api/v3/replica`, { headers: sourceAuth })).json() as {
          physical: { verifiedAt?: string; issue?: string };
        };
        expect(sourceDamaged.physical.issue).toMatch(/已隔离 1 个/);
        expect(existsSync(sourceChunkPath)).toBe(false);
        const state = await sourcePhysicalDb.get<{ state: string }>(
          'SELECT state FROM blob_replica_states WHERE blob_id = ?', [peerBlob.blobId]);
        expect(state?.state).not.toBe('trash');
        await peer.flushNodeReplication();
        expect(readFileSync(sourceChunkPath)).toEqual(clean);
        await source.flushNodeReplication();
        const sourceRepaired = await (await fetch(`${sourceUrl}/api/v3/replica`, { headers: sourceAuth })).json() as {
          physical: { verifiedAt?: string; issue?: string };
        };
        expect(sourceRepaired.physical.issue).toBeUndefined();
        expect(sourceRepaired.physical.verifiedAt).toBeTruthy();
      } finally { await sourcePhysicalDb.close(); }
      const bulkIds: string[] = [];
      for (let index = 0; index < 22; index += 1) {
        bulkIds.push((await uploadBlob(sourceUrl, sourceAuth, `bulk portable attachment ${index}`)).blobId);
      }
      await peer.flushNodeReplication();
      expect((await fetch(`${peerUrl}/api/v3/blobs/${bulkIds.at(-1)}/manifest`, { headers: peerAuth })).status).toBe(200);
      const sourceRates = new NodeSqliteDriver(join(source.dataDir, 'server.sqlite'));
      try {
        const nodeRate = await sourceRates.get<{ hits: number }>(
          "SELECT MAX(hits) AS hits FROM server_rate_limits WHERE scope = 'node'",
        );
        expect(nodeRate?.hits ?? 0).toBeLessThan(600);
      } finally { await sourceRates.close(); }
      expect((await fetch(`${sourceUrl}/api/v3/blobs/${sourceBlob.blobId}`, { method: 'DELETE', headers: sourceAuth })).status).toBe(200);
      await peer.flushNodeReplication();
      await third.flushNodeReplication();
      expect((await fetch(`${peerUrl}/api/v3/blobs/${sourceBlob.blobId}/manifest`, { headers: peerAuth })).status).toBe(404);
      expect((await fetch(`${thirdUrl}/api/v3/blobs/${sourceBlob.blobId}/manifest`, { headers: thirdAuth })).status).toBe(404);
      expect((await fetch(`${peerUrl}/api/v3/blobs/${sourceBlob.blobId}/restore`, { method: 'POST', headers: peerAuth })).status).toBe(200);
      await peer.flushNodeReplication();
      await third.flushNodeReplication();
      expect((await fetch(`${sourceUrl}/api/v3/blobs/${sourceBlob.blobId}/manifest`, { headers: sourceAuth })).status).toBe(200);
      expect((await fetch(`${thirdUrl}/api/v3/blobs/${sourceBlob.blobId}/manifest`, { headers: thirdAuth })).status).toBe(200);
      expect((await fetch(`${sourceUrl}/api/v3/blobs/${sourceBlob.blobId}`, { method: 'DELETE', headers: sourceAuth })).status).toBe(200);
      await peer.flushNodeReplication();
      await third.flushNodeReplication();
      expect((await fetch(`${sourceUrl}/api/v3/blobs/${sourceBlob.blobId}/manifest`, { headers: sourceAuth })).status).toBe(404);
      const peerDeletedManifest = await fetch(`${peerUrl}/api/v3/blobs/${sourceBlob.blobId}/manifest`, { headers: peerAuth });
      if (peerDeletedManifest.status !== 404) {
        const database = new NodeSqliteDriver(join(peer.dataDir, 'server.sqlite'));
        const sourceDatabase = new NodeSqliteDriver(join(source.dataDir, 'server.sqlite'));
        try {
          const state = await database.get('SELECT state, counter, writer_node_id FROM blob_replica_states WHERE blob_id = ?', [sourceBlob.blobId]);
          const links = await (await fetch(`${peerUrl}/api/v4/replication/links`, { headers: peerAuth })).json();
          const rates = await sourceDatabase.all('SELECT scope, hits, blocked_until FROM server_rate_limits ORDER BY hits DESC LIMIT 5');
          throw new Error(`peer deletion did not converge: ${JSON.stringify({ status: peerDeletedManifest.status, state, links, rates })}`);
        } finally { await Promise.all([database.close(), sourceDatabase.close()]); }
      }
      expect((await fetch(`${thirdUrl}/api/v3/blobs/${sourceBlob.blobId}/manifest`, { headers: thirdAuth })).status).toBe(404);

      await peer.close();
      peer = createTestSyncServer({ dataDir: join(root, 'peer') });
      await peer.ready;
      await new Promise<void>((resolve) => peer.server.listen(0, '127.0.0.1', resolve));
      peerUrl = `http://127.0.0.1:${(peer.server.address() as AddressInfo).port}`;
      const renewedGrant = await (await fetch(`${sourceUrl}/api/v4/replication/grants`, { method: 'POST', headers: sourceAuth,
        body: JSON.stringify({ peerNodeId: peer.serverId, peerPublicKey: identity.publicKey,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString() }) })).json() as { grantId: string };
      expect((await fetch(`${peerUrl}/api/v4/replication/links/${link.linkId}/grant`, { method: 'PUT', headers: peerAuth,
        body: JSON.stringify({ grantId: renewedGrant.grantId }) })).status).toBe(200);
      expect((await fetch(`${sourceUrl}/api/v4/replication/grants/${grantId}`, { method: 'DELETE', headers: sourceAuth })).status).toBe(404);
      await publish(sourceUrl, sourceAuth, 'source-commit-0000000000002');
      await peer.flushNodeReplication();
      const afterRestartStatus = await (await fetch(`${peerUrl}/api/v4/replication/links`, { headers: peerAuth })).json() as { links: { lastError?: string }[] };
      expect(afterRestartStatus.links[0]?.lastError).toBeUndefined();
      expect(await readIds(peerUrl, peerAuth)).toEqual([...expected, 'source-commit-0000000000002'].sort());
      await publish(thirdUrl, thirdAuth, 'third-commit-0000000000001');
      await third.flushNodeReplication();
      await peer.flushNodeReplication();
      expect(await readIds(peerUrl, peerAuth)).toEqual([...expected, 'source-commit-0000000000002', 'third-commit-0000000000001'].sort());
      await source.close();
      sourceClosed = true;
      const offlineRefresh = await fetch(`${peerUrl}/api/auth/refresh`, { method: 'POST',
        headers: { Origin: peerUrl, 'X-Zichan-Session': 'cookie', Cookie: rotatedTargetCookie!,
          'Content-Type': 'application/json' }, body: '{}' });
      expect(offlineRefresh.status).toBe(200);
      expect((await offlineRefresh.json() as { accountId: string }).accountId).toBe(peerMe.accountId);
      const offlineDb = new NodeSqliteDriver(join(peer.dataDir, 'server.sqlite'));
      try {
        const object = await offlineDb.get<{ namespace: string }>(
          'SELECT namespace FROM blob_objects WHERE blob_id = ?', [peerBlob.blobId]);
        const chunkPath = join(peer.dataDir, 'blobs', 'objects', object!.namespace,
          peerBlob.blobId.slice(0, 2), peerBlob.blobId, '0.chunk');
        const damaged = Buffer.from(readFileSync(chunkPath));
        damaged[0] ^= 1;
        writeFileSync(chunkPath, damaged);
        await offlineDb.run("UPDATE replica_physical_status SET verified_at = '2020-01-01T00:00:00.000Z' WHERE username = 'owner'");
        await peer.flushNodeReplication();
        const offlinePhysical = await (await fetch(`${peerUrl}/api/v3/replica`, { headers: peerAuth })).json() as {
          physical: { issue?: string; verifiedAt?: string };
        };
        expect(offlinePhysical.physical.issue).toMatch(/已隔离 1 个/);
        expect(offlinePhysical.physical.verifiedAt).toBeUndefined();
        const offlineLink = await (await fetch(`${peerUrl}/api/v4/replication/links`, { headers: peerAuth })).json() as {
          links: { physicalIssue?: string }[];
        };
        expect(offlineLink.links[0]?.physicalIssue).toMatch(/已隔离 1 个/);
        expect(existsSync(chunkPath)).toBe(false);
      } finally { await offlineDb.close(); }
    } finally {
      await Promise.all([sourceClosed ? Promise.resolve() : source.close(), peer.close(), third.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
