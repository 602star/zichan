import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import * as opaque from '@serenity-kit/opaque';
import { httpCommitTransport, loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { accountSigningPublicKey, changeLedgerPassphrase, createAccountEncryptionKey, encryptJson, rotateLedgerProtection,
  sha256Json, signLedgerControlEvent, unlockAccountEncryptionKey, unlockLedgerKeyEnvelope, unlockLedgerMemberKeyEnvelope,
  wrapAccountEncryptionKey,
  wrapLedgerCryptoSessionForMember,
  type LedgerKeyEnvelope } from '@zichan/core';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { loadNodeIdentity } from '../src/node-identity.js';
import { verifyNodeReplicaInventory } from '../src/node-replication.js';
import { SyncServerStore } from '../src/store.js';

describe('federated replica join', () => {
  it('creates a separate ledger account on a node with another ledger and logs in through the issuer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-federated-join-'));
    const source = createTestSyncServer({ dataDir: join(root, 'source') });
    const target = createTestSyncServer({ dataDir: join(root, 'target') });
    try {
      await Promise.all([source.ready, target.ready]);
      await Promise.all([source, target].map((instance) => new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve))));
      const sourceUrl = `http://127.0.0.1:${(source.server.address() as AddressInfo).port}`;
      const targetUrl = `http://127.0.0.1:${(target.server.address() as AddressInfo).port}`;
      await registerAccount(sourceUrl, 'owner', 'source-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(targetUrl, 'operator', 'target-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      const sourceSession = await loginAccount(sourceUrl, 'owner', 'source-password');
      const targetSession = await loginAccount(targetUrl, 'operator', 'target-password');
      const sourceAuth = { Authorization: `Bearer ${sourceSession.accessToken}`, 'Content-Type': 'application/json' };
      const targetAuth = { Authorization: `Bearer ${targetSession.accessToken}`, 'Content-Type': 'application/json' };
      const initialized = await fetch(`${sourceUrl}/api/v3/protection/initialize`, { method: 'POST', headers: sourceAuth,
        body: JSON.stringify({ mode: 'managed' }) });
      expect(initialized.status).toBe(200);
      const protection = await initialized.json() as { replica: { ledgerId: string }; envelope: LedgerKeyEnvelope; secret: string };
      const targetInitialized = await fetch(`${targetUrl}/api/v3/protection/initialize`, { method: 'POST', headers: targetAuth,
        body: JSON.stringify({ mode: 'managed' }) });
      expect(targetInitialized.status).toBe(200);
      const targetProtection = await targetInitialized.json() as { replica: { ledgerId: string }; envelope: LedgerKeyEnvelope };
      expect(targetProtection.replica.ledgerId).not.toBe(protection.replica.ledgerId);
      const sourceMe = await (await fetch(`${sourceUrl}/api/auth/me`, { headers: sourceAuth })).json() as { accountId: string };
      const targetIdentity = loadNodeIdentity(target.dataDir, target.serverId);
      const grantResponse = await fetch(`${sourceUrl}/api/v4/replication/grants`, { method: 'POST', headers: sourceAuth,
        body: JSON.stringify({ peerNodeId: target.serverId, peerPublicKey: targetIdentity.publicKey,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString() }) });
      expect(grantResponse.status).toBe(201);
      const grant = await grantResponse.json() as { grantId: string };
      const joinBody = { peerUrl: sourceUrl, peerNodeId: source.serverId,
        peerPublicKey: loadNodeIdentity(source.dataDir, source.serverId).publicKey,
        grantId: grant.grantId, ledgerId: protection.replica.ledgerId };
      const joinReplica = (headers: Record<string, string>, body = joinBody) => fetch(`${targetUrl}/api/v4/replication/join`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      await registerAccount(targetUrl, 'member', 'member-password');
      const memberSession = await loginAccount(targetUrl, 'member', 'member-password');
      expect((await joinReplica({ Authorization: `Bearer ${memberSession.accessToken}`, 'Content-Type': 'application/json' })).status).toBe(403);
      const joined = await joinReplica(targetAuth);
      expect(joined.status).toBe(201);
      const { link, replicaUsername } = await joined.json() as { link: { username: string; ledgerId: string }; replicaUsername: string };
      expect(link).toMatchObject({ username: replicaUsername, ledgerId: protection.replica.ledgerId });
      expect(replicaUsername).not.toBe('operator');
      expect((await joinReplica(targetAuth)).status).toBe(409);
      expect(await (await fetch(`${targetUrl}/api/v3/replica`, { headers: targetAuth })).json()).toMatchObject({
        bound: true, ledgerId: targetProtection.replica.ledgerId,
      });
      expect((await (await fetch(`${targetUrl}/api/v3/key-envelope`, { headers: targetAuth }))
        .json() as { envelope: unknown }).envelope).toEqual(targetProtection.envelope);
      expect((await (await fetch(`${targetUrl}/api/v4/replication/links`, { headers: targetAuth })).json() as { links: unknown[] }).links).toHaveLength(1);
      await expect(loginAccount(targetUrl, replicaUsername, 'source-password')).rejects.toThrow();

      await opaque.ready;
      const started = opaque.client.startLogin({ password: 'source-password' });
      const loginStart = await fetch(`${sourceUrl}/api/auth/login/start`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', startLoginRequest: started.startLoginRequest }) });
      const challenge = await loginStart.json() as { loginId: string; loginResponse: string };
      const finished = opaque.client.finishLogin({ clientLoginState: started.clientLoginState,
        loginResponse: challenge.loginResponse, password: 'source-password',
        identifiers: { client: 'owner', server: source.serverId }, keyStretching: 'memory-constrained' });
      const cookieResponse = await fetch(`${sourceUrl}/api/auth/login/finish`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: sourceUrl, 'X-Zichan-Session': 'cookie' },
        body: JSON.stringify({ loginId: challenge.loginId, finishLoginRequest: finished!.finishLoginRequest,
          deviceId: 'join-browser', deviceName: 'Join browser' }) });
      expect(cookieResponse.status).toBe(200);
      const sourceCookie = cookieResponse.headers.get('set-cookie')!.split(';')[0]!;
      const startFederation = await fetch(`${targetUrl}/api/auth/federation/start?issuer=${source.serverId}`, { redirect: 'manual' });
      expect(startFederation.status).toBe(302);
      const stateCookie = startFederation.headers.get('set-cookie')!.split(';')[0]!;
      const authorize = await fetch(startFederation.headers.get('location')!, { redirect: 'manual', headers: { Cookie: sourceCookie } });
      expect(authorize.status).toBe(302);
      const callback = await fetch(authorize.headers.get('location')!, { redirect: 'manual', headers: { Cookie: stateCookie } });
      expect(callback.status).toBe(303);
      const localCookie = callback.headers.get('set-cookie')!.match(/zichan_session=[^;]+/)?.[0];
      expect(localCookie).toBeTruthy();
      const refresh = await fetch(`${targetUrl}/api/auth/refresh`, { method: 'POST',
        headers: { Origin: targetUrl, 'X-Zichan-Session': 'cookie', Cookie: localCookie!,
          'Content-Type': 'application/json' }, body: '{}' });
      expect(refresh.status).toBe(200);
      const federationSession = await refresh.json() as { accountId: string; accessToken: string };
      expect(federationSession.accountId).toBe(sourceMe.accountId);
      const federatedAuth = { Authorization: `Bearer ${federationSession.accessToken}` };
      const federatedMe = await (await fetch(`${targetUrl}/api/auth/me`, { headers: federatedAuth })).json() as {
        username: string; accountId: string; role: string; ledgerId: string;
      };
      expect(federatedMe).toMatchObject({ username: replicaUsername, accountId: sourceMe.accountId,
        role: 'member', ledgerId: protection.replica.ledgerId });
      expect((await (await fetch(`${targetUrl}/api/v3/key-envelope`, { headers: federatedAuth }))
        .json() as { envelope: unknown }).envelope).toEqual(protection.envelope);
      const key = await unlockLedgerKeyEnvelope(protection.secret, protection.envelope);
      const publish = async (url: string, auth: Record<string, string>, commitId: string) => {
        const commit = { protocol: 2, ledgerId: protection.replica.ledgerId, commitId,
          originDeviceId: 'federated-join-test', createdAt: new Date().toISOString(),
          parentCommitIds: [], revisions: [] };
        const contentHash = await sha256Json(commit);
        const encCommit = await encryptJson(key, commit, { protocol: 2, ledgerId: commit.ledgerId, commitId, contentHash });
        const response = await fetch(`${url}/api/v3/commits`, { method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ commits: [{ commitId, ledgerId: commit.ledgerId, contentHash, encCommit }] }) });
        expect(response.status).toBe(200);
      };
      await publish(sourceUrl, sourceAuth, 'issuer-commit-00000000001');
      await target.flushNodeReplication();
      const readIds = async (url: string, auth: Record<string, string>) => {
        const page = await (await fetch(`${url}/api/v3/commits?after=0`, { headers: auth }))
          .json() as { commits: { commitId: string }[] };
        return page.commits.map((item) => item.commitId).sort();
      };
      expect(await readIds(targetUrl, federatedAuth)).toEqual(['issuer-commit-00000000001']);
      await publish(targetUrl, federatedAuth, 'target-commit-00000000001');
      await target.flushNodeReplication();
      expect(await readIds(sourceUrl, sourceAuth)).toEqual(['issuer-commit-00000000001', 'target-commit-00000000001']);
      const joinedStatus = await (await fetch(`${targetUrl}/api/v4/replication/links`, { headers: targetAuth }))
        .json() as { links: { inventoryMatchedAt?: string; inventoryIssue?: string }[] };
      expect(joinedStatus.links[0]?.inventoryMatchedAt).toBeTruthy();
      expect(joinedStatus.links[0]?.inventoryIssue).toBeUndefined();
      const diagnosticStore = new SyncServerStore(join(target.dataDir, 'server.sqlite'), 'open', target.serverId);
      const database = new NodeSqliteDriver(join(target.dataDir, 'server.sqlite'));
      try {
        await diagnosticStore.ready;
        const linkRecord = (await diagnosticStore.listNodeReplicationLinks())[0]!;
        const replicaId = (await diagnosticStore.getReplica(replicaUsername))!.replicaId;
        const original = await database.get<{ content_hash: string }>(
          'SELECT content_hash FROM ledger_replica_commits WHERE replica_id = ? AND commit_id = ?',
          [replicaId, 'target-commit-00000000001']);
        expect(original).toBeTruthy();
        await database.run('UPDATE ledger_replica_commits SET content_hash = ? WHERE replica_id = ? AND commit_id = ?',
          ['f'.repeat(64), replicaId, 'target-commit-00000000001']);
        await verifyNodeReplicaInventory(diagnosticStore, loadNodeIdentity(target.dataDir, target.serverId), linkRecord);
        expect((await diagnosticStore.listNodeReplicationLinks())[0]?.inventoryIssue).toContain('提交');
        await database.run('UPDATE ledger_replica_commits SET content_hash = ? WHERE replica_id = ? AND commit_id = ?',
          [original!.content_hash, replicaId, 'target-commit-00000000001']);
        await verifyNodeReplicaInventory(diagnosticStore, loadNodeIdentity(target.dataDir, target.serverId), linkRecord);
        expect((await diagnosticStore.listNodeReplicationLinks())[0]?.inventoryIssue).toBeUndefined();
      } finally { await Promise.all([diagnosticStore.close(), database.close()]); }

      await registerAccount(sourceUrl, 'alice', 'alice-password');
      const aliceSession = await loginAccount(sourceUrl, 'alice', 'alice-password');
      const aliceAuth = { Authorization: `Bearer ${aliceSession.accessToken}`, 'Content-Type': 'application/json' };
      const aliceMe = await (await fetch(`${sourceUrl}/api/auth/me`, { headers: aliceAuth }))
        .json() as { accountId: string };
      const ownerKey = await createAccountEncryptionKey(source.serverId, sourceMe.accountId, 'owner key password');
      const aliceKey = await createAccountEncryptionKey(source.serverId, aliceMe.accountId, 'alice key password');
      for (const [headers, envelope] of [[sourceAuth, ownerKey.envelope], [aliceAuth, aliceKey.envelope]] as const) {
        const saved = await fetch(`${sourceUrl}/api/v4/account/encryption-key`, { method: 'PUT', headers,
          body: JSON.stringify({ envelope, expectedRevision: 0 }) });
        expect(saved.status).toBe(200);
      }
      const actor = { issuerNodeId: source.serverId, accountId: sourceMe.accountId };
      const member = { issuerNodeId: source.serverId, accountId: aliceMe.accountId };
      const ledgerId = protection.replica.ledgerId;
      const genesis = signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 1, previousHash: null, keyEpoch: 1,
          kind: 'MemberGenesis', actor, target: actor, role: 'OWNER',
          signingPublicKey: accountSigningPublicKey(ownerKey.privateKey),
          encryptionPublicKey: ownerKey.envelope.publicKey });
      const genesisResponse = await fetch(`${sourceUrl}/api/v4/ledger/control`, { method: 'POST',
        headers: sourceAuth, body: JSON.stringify({ event: genesis }) });
      expect(genesisResponse.status).toBe(201);
      const head = (await genesisResponse.json() as { state: { headHash: string } }).state.headHash;
      const ownerEnvelope = await wrapLedgerCryptoSessionForMember(key,
        { ...actor, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 1 });
      expect((await fetch(`${sourceUrl}/api/v4/ledger/member-envelope`, { method: 'PUT',
        headers: sourceAuth, body: JSON.stringify({ envelope: ownerEnvelope }) })).status).toBe(200);
      const added = signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 2, previousHash: head, keyEpoch: 1,
          kind: 'MemberAdded', actor, target: member, role: 'EDITOR',
          signingPublicKey: accountSigningPublicKey(aliceKey.privateKey),
          encryptionPublicKey: aliceKey.envelope.publicKey });
      const aliceEnvelope = await wrapLedgerCryptoSessionForMember(key,
        { ...member, recipientPublicKey: aliceKey.envelope.publicKey, keyEpoch: 1 });
      expect((await fetch(`${sourceUrl}/api/v4/ledger/control/events`, { method: 'POST',
        headers: sourceAuth, body: JSON.stringify({ event: added, envelopes: [aliceEnvelope] }) })).status).toBe(201);
      expect(await readIds(sourceUrl, aliceAuth)).toEqual(['issuer-commit-00000000001', 'target-commit-00000000001']);
      await target.flushNodeReplication();
      await target.flushNodeReplication();
      const provisioned = new SyncServerStore(join(target.dataDir, 'server.sqlite'), 'open', target.serverId);
      try {
        expect(await provisioned.replicaInventory(replicaUsername, ledgerId)).toMatchObject({
          memberAccountKeyCount: 2, missingMemberAccountKeyCount: 0,
          memberAccountCount: 2, missingMemberAccountCount: 0,
        });
      } finally { await provisioned.close(); }

      const aliceStarted = opaque.client.startLogin({ password: 'alice-password' });
      const aliceLoginStart = await fetch(`${sourceUrl}/api/auth/login/start`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', startLoginRequest: aliceStarted.startLoginRequest }) });
      const aliceChallenge = await aliceLoginStart.json() as { loginId: string; loginResponse: string };
      const aliceFinished = opaque.client.finishLogin({ clientLoginState: aliceStarted.clientLoginState,
        loginResponse: aliceChallenge.loginResponse, password: 'alice-password',
        identifiers: { client: 'alice', server: source.serverId }, keyStretching: 'memory-constrained' });
      const aliceCookieResponse = await fetch(`${sourceUrl}/api/auth/login/finish`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: sourceUrl, 'X-Zichan-Session': 'cookie' },
        body: JSON.stringify({ loginId: aliceChallenge.loginId, finishLoginRequest: aliceFinished!.finishLoginRequest,
          deviceId: 'alice-browser', deviceName: 'Alice browser' }) });
      expect(aliceCookieResponse.status).toBe(200);
      const aliceCookie = aliceCookieResponse.headers.get('set-cookie')!.split(';')[0]!;
      const aliceFederation = await fetch(`${targetUrl}/api/auth/federation/start?issuer=${source.serverId}`, { redirect: 'manual' });
      expect(aliceFederation.status).toBe(302);
      const aliceStateCookie = aliceFederation.headers.get('set-cookie')!.split(';')[0]!;
      const aliceAuthorize = await fetch(aliceFederation.headers.get('location')!,
        { redirect: 'manual', headers: { Cookie: aliceCookie } });
      expect(aliceAuthorize.status).toBe(302);
      const aliceCallback = await fetch(aliceAuthorize.headers.get('location')!,
        { redirect: 'manual', headers: { Cookie: aliceStateCookie } });
      expect(aliceCallback.status).toBe(303);
      const aliceLocalCookie = aliceCallback.headers.get('set-cookie')!.match(/zichan_session=[^;]+/)?.[0];
      const aliceRefresh = await fetch(`${targetUrl}/api/auth/refresh`, { method: 'POST',
        headers: { Origin: targetUrl, 'X-Zichan-Session': 'cookie', Cookie: aliceLocalCookie!,
          'Content-Type': 'application/json' }, body: '{}' });
      expect(aliceRefresh.status).toBe(200);
      const aliceFederated = await aliceRefresh.json() as { accountId: string; accessToken: string };
      expect(aliceFederated.accountId).toBe(aliceMe.accountId);
      const aliceTargetAuth = { Authorization: `Bearer ${aliceFederated.accessToken}` };
      expect((await (await fetch(`${targetUrl}/api/v4/account/encryption-key`, { headers: aliceTargetAuth }))
        .json() as { record: { envelope: unknown } }).record.envelope).toEqual(aliceKey.envelope);
      const aliceRewrapped = await wrapAccountEncryptionKey(aliceKey.privateKey, source.serverId,
        aliceMe.accountId, 'alice updated key password');
      expect((await fetch(`${sourceUrl}/api/v4/account/encryption-key`, { method: 'PUT',
        headers: aliceAuth, body: JSON.stringify({ envelope: aliceRewrapped, expectedRevision: 1 }) })).status).toBe(200);
      await target.flushNodeReplication();
      const updatedKey = (await (await fetch(`${targetUrl}/api/v4/account/encryption-key`,
        { headers: aliceTargetAuth })).json() as { record: { envelope: typeof aliceRewrapped; revision: number } }).record;
      expect(updatedKey).toMatchObject({ envelope: aliceRewrapped, revision: 2 });
      expect(await unlockAccountEncryptionKey('alice updated key password', updatedKey.envelope))
        .toEqual(aliceKey.privateKey);
      expect((await (await fetch(`${targetUrl}/api/v4/ledger/member-envelope`, { headers: aliceTargetAuth }))
        .json() as { envelope: unknown }).envelope).toEqual(aliceEnvelope);
      expect((await fetch(`${targetUrl}/api/v3/key-envelope`, { headers: aliceTargetAuth })).status).toBe(403);
      expect((await fetch(`${targetUrl}/api/v3/protection`, { headers: aliceTargetAuth })).status).toBe(403);
      expect(await readIds(targetUrl, aliceTargetAuth)).toEqual(['issuer-commit-00000000001', 'target-commit-00000000001']);
      const aliceLedger = await unlockLedgerMemberKeyEnvelope(aliceKey.privateKey, aliceEnvelope);
      const localMemberKey = await changeLedgerPassphrase(aliceLedger, 'alice local ledger password');
      const memberTransport = httpCommitTransport({ baseUrl: targetUrl,
        token: aliceFederated.accessToken, cryptoSession: localMemberKey.session,
        keyEnvelope: localMemberKey.envelope, memberKeyEnvelope: true });
      const memberReplica = await memberTransport.connect(ledgerId);
      await memberTransport.pushCommits(memberReplica, [{
        protocol: 2, ledgerId, commitId: 'federated-member-commit-0001',
        originDeviceId: 'alice-device-0001', createdAt: new Date().toISOString(),
        parentCommitIds: [], revisions: [{ revisionId: 'alice-revision-0001',
          aggregateType: 'transaction', aggregateId: 'alice-transaction-0001',
          parentRevisionIds: [], op: 'put', payload: { id: 'alice-transaction-0001' } }],
      }]);
      await target.flushNodeReplication();
      expect(await readIds(sourceUrl, sourceAuth)).toContain('federated-member-commit-0001');
      const removed = signLedgerControlEvent(ownerKey.privateKey,
        { v: 1, ledgerId, seq: 3, previousHash: (await (await fetch(`${sourceUrl}/api/v4/ledger/control`,
          { headers: sourceAuth })).json() as { state: { headHash: string } }).state.headHash,
          keyEpoch: 2, kind: 'MemberRemoved', actor, target: member });
      const rotated = await rotateLedgerProtection(key, protection.secret);
      expect(rotated.session.activeKeyId).not.toBe(key.activeKeyId);
      const nextOwnerEnvelope = await wrapLedgerCryptoSessionForMember(rotated.session,
        { ...actor, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 2 });
      expect((await fetch(`${sourceUrl}/api/v4/ledger/control/events`, { method: 'POST',
        headers: sourceAuth, body: JSON.stringify({ event: removed,
          envelopes: [nextOwnerEnvelope] }) })).status).toBe(201);
      await target.flushNodeReplication();
      await target.flushNodeReplication();
      expect((await fetch(`${targetUrl}/api/v3/commits`, { headers: aliceTargetAuth })).status).toBe(403);
      expect((await fetch(`${targetUrl}/api/v4/ledger/member-envelope`, { headers: aliceTargetAuth })).status).toBe(403);
      const removedFederation = await fetch(`${targetUrl}/api/auth/federation/start?issuer=${source.serverId}`,
        { redirect: 'manual' });
      const removedAuthorize = await fetch(removedFederation.headers.get('location')!,
        { redirect: 'manual', headers: { Cookie: aliceCookie } });
      expect(removedAuthorize.status).toBe(403);
    } finally {
      await Promise.all([source.close(), target.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
