import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import { describe, expect, it } from 'vitest';
import { accountSigningPublicKey, changeLedgerPassphrase, createAccountEncryptionKey, createLedgerCryptoSession,
  signLedgerControlEvent, wrapLedgerCryptoSessionForMember } from '@zichan/core';
import { httpCommitTransport, loginAccount, registerAccount, selectAccountLedger } from '@zichan/db';
import { loadNodeIdentity } from '../src/node-identity.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

async function cookieLogin(url: string, username: string, password: string, serverId: string): Promise<string> {
  await opaque.ready;
  const started = opaque.client.startLogin({ password });
  const challengeResponse = await fetch(`${url}/api/auth/login/start`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, startLoginRequest: started.startLoginRequest }) });
  expect(challengeResponse.status).toBe(200);
  const challenge = await challengeResponse.json() as { loginId: string; loginResponse: string };
  const finished = opaque.client.finishLogin({ clientLoginState: started.clientLoginState,
    loginResponse: challenge.loginResponse, password,
    identifiers: { client: username, server: serverId }, keyStretching: 'memory-constrained' });
  const response = await fetch(`${url}/api/auth/login/finish`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url, 'X-Zichan-Session': 'cookie' },
    body: JSON.stringify({ loginId: challenge.loginId, finishLoginRequest: finished!.finishLoginRequest,
      deviceId: `device-${username}-three-node`, deviceName: 'Three-node member test' }) });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

async function federatedLogin(targetUrl: string, issuerNodeId: string, issuerCookie: string,
  linkId: string): Promise<{
  cookie: string; accessToken: string;
}> {
  const start = await fetch(`${targetUrl}/api/auth/federation/start?issuer=${issuerNodeId}&link=${linkId}`,
    { redirect: 'manual' });
  expect(start.status).toBe(302);
  const stateCookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual',
    headers: { Cookie: issuerCookie } });
  expect(authorize.status).toBe(302);
  const callback = await fetch(authorize.headers.get('location')!, { redirect: 'manual',
    headers: { Cookie: stateCookie } });
  expect(callback.status).toBe(303);
  const cookie = callback.headers.get('set-cookie')!.match(/zichan_session=[^;]+/)?.[0];
  expect(cookie).toBeTruthy();
  const refreshed = await fetch(`${targetUrl}/api/auth/refresh`, { method: 'POST',
    headers: { Origin: targetUrl, 'X-Zichan-Session': 'cookie', Cookie: cookie!,
      'Content-Type': 'application/json' }, body: '{}' });
  expect(refreshed.status).toBe(200);
  const session = await refreshed.json() as { accessToken: string };
  const rotatedCookie = refreshed.headers.get('set-cookie')!.match(/zichan_session=[^;]+/)?.[0];
  expect(rotatedCookie).toBeTruthy();
  return { cookie: rotatedCookie!, accessToken: session.accessToken };
}

describe('three-node member login and offline writes', () => {
  it('keeps personal and shared ledger sessions usable while the issuer hub is down, then converges both', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-three-node-member-'));
    const hub = createTestSyncServer({ dataDir: join(root, 'hub') });
    const home = createTestSyncServer({ dataDir: join(root, 'home') });
    const office = createTestSyncServer({ dataDir: join(root, 'office') });
    const nodes = [hub, home, office];
    const stores: SyncServerStore[] = [];
    try {
      await Promise.all(nodes.map((node) => node.ready));
      await Promise.all(nodes.map((node) => new Promise<void>((resolve) =>
        node.server.listen(0, '127.0.0.1', resolve))));
      const urls = nodes.map((node) => `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`);
      await registerAccount(urls[0]!, 'owner', 'owner-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(urls[0]!, 'alice', 'alice-password');
      for (const node of nodes) stores.push(new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId));
      await Promise.all(stores.map((store) => store.ready));
      const owner = (await stores[0]!.getUser('owner'))!;
      const alice = (await stores[0]!.getUser('alice'))!;
      const ledgerId = 'ledger-three-node-member-0001';
      const personalLedgerId = 'ledger-three-node-personal-0001';
      const ledger = createLedgerCryptoSession(ledgerId);
      const personalLedger = createLedgerCryptoSession(personalLedgerId);
      await stores[0]!.bindReplica('owner', ledgerId);
      const personalReplica = await stores[0]!.bindReplica('alice', personalLedgerId);
      const envelope = { ledgerId, keyringId: ledger.keyringId, generation: 1 };
      const personalEnvelope = { ledgerId: personalLedgerId, keyringId: personalLedger.keyringId, generation: 1 };
      await stores[0]!.putKeyEnvelope('owner', ledgerId, ledger.keyringId, 1, envelope);
      await stores[0]!.putKeyEnvelope('alice', personalLedgerId, personalLedger.keyringId, 1,
        personalEnvelope);
      const ownerKey = await createAccountEncryptionKey(hub.serverId, owner.accountId, 'owner-key-password');
      const aliceKey = await createAccountEncryptionKey(hub.serverId, alice.accountId, 'alice-key-password');
      for (const [account, key] of [
        [owner, ownerKey], [alice, aliceKey],
      ] as const) {
        await stores[0]!.putAccountEncryptionKey(hub.serverId, account.accountId, key.envelope.publicKey,
          key.envelope as unknown as Record<string, unknown>, 0);
      }
      const actor = { issuerNodeId: hub.serverId, accountId: owner.accountId };
      const member = { issuerNodeId: hub.serverId, accountId: alice.accountId };
      const genesis = await stores[0]!.initializeLedgerControl('owner', signLedgerControlEvent(ownerKey.privateKey, {
        v: 1, ledgerId, seq: 1, previousHash: null, keyEpoch: 1, kind: 'MemberGenesis',
        actor, target: actor, role: 'OWNER', signingPublicKey: accountSigningPublicKey(ownerKey.privateKey),
        encryptionPublicKey: ownerKey.envelope.publicKey,
      }));
      await stores[0]!.putLedgerMemberKeyEnvelope('owner', await wrapLedgerCryptoSessionForMember(ledger,
        { ...actor, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 1 }));
      await stores[0]!.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey, {
        v: 1, ledgerId, seq: 2, previousHash: genesis.headHash, keyEpoch: 1, kind: 'MemberAdded',
        actor, target: member, role: 'EDITOR', signingPublicKey: accountSigningPublicKey(aliceKey.privateKey),
        encryptionPublicKey: aliceKey.envelope.publicKey,
      }), [await wrapLedgerCryptoSessionForMember(ledger,
        { ...member, recipientPublicKey: aliceKey.envelope.publicKey, keyEpoch: 1 })]);

      for (const index of [1, 2]) {
        const peer = nodes[index]!;
        const peerPublicKey = loadNodeIdentity(peer.dataDir, peer.serverId).publicKey;
        const hubPublicKey = loadNodeIdentity(hub.dataDir, hub.serverId).publicKey;
        const grant = await stores[0]!.createNodeReplicationGrant('owner', peer.serverId,
          peerPublicKey,
          new Date(Date.now() + 86_400_000).toISOString());
        await stores[index]!.provisionFederatedReplica({
          issuerNodeId: hub.serverId, subjectAccountId: owner.accountId, ledgerId, envelope,
          peerUrl: urls[0]!, peerNodeId: hub.serverId,
          peerPublicKey: hubPublicKey,
          peerReplicaId: (await stores[0]!.getReplica('owner'))!.replicaId,
          peerStreamEpoch: (await stores[0]!.getReplica('owner'))!.streamEpoch,
          grantId: grant.grantId,
        });
        const personalGrant = await stores[0]!.createNodeReplicationGrant('alice', peer.serverId,
          peerPublicKey, new Date(Date.now() + 86_400_000).toISOString());
        await stores[index]!.provisionFederatedReplica({
          issuerNodeId: hub.serverId, subjectAccountId: alice.accountId,
          ledgerId: personalLedgerId, envelope: personalEnvelope,
          peerUrl: urls[0]!, peerNodeId: hub.serverId, peerPublicKey: hubPublicKey,
          peerReplicaId: personalReplica.replicaId,
          peerStreamEpoch: personalReplica.streamEpoch,
          grantId: personalGrant.grantId,
        });
      }
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      for (const store of stores.slice(1)) {
        const links = await store.listNodeReplicationLinks();
        const sharedLink = links.find((link) => link.ledgerId === ledgerId)!;
        const personalLink = links.find((link) => link.ledgerId === personalLedgerId)!;
        expect(await store.replicaInventory(sharedLink.username, ledgerId))
          .toMatchObject({ memberAccountCount: 2, missingMemberAccountCount: 0,
            memberAccountKeyCount: 2, missingMemberAccountKeyCount: 0 });
        expect((await store.getReplica(personalLink.username))?.ledgerId).toBe(personalLedgerId);
      }
      expect((await stores[0]!.getReplica('alice'))?.replicaId).toBe(personalReplica.replicaId);

      const issuerCookie = await cookieLogin(urls[0]!, 'alice', 'alice-password', hub.serverId);
      const sessions = await Promise.all([1, 2].map(async (index) => {
        const links = await stores[index]!.listNodeReplicationLinks();
        const sharedLink = links.find((link) => link.ledgerId === ledgerId)!;
        const personalLink = links.find((link) => link.ledgerId === personalLedgerId)!;
        return {
          shared: await federatedLogin(urls[index]!, hub.serverId, issuerCookie, sharedLink.linkId),
          personal: await federatedLogin(urls[index]!, hub.serverId, issuerCookie, personalLink.linkId),
        };
      }));
      for (const [position, index] of [1, 2].entries()) {
        const me = await (await fetch(`${urls[index]}/api/auth/me`,
          { headers: { Authorization: `Bearer ${sessions[position]!.shared.accessToken}` } })).json() as {
          ledgerId: string; role: string; accountId: string;
        };
        expect(me).toMatchObject({ ledgerId, role: 'member', accountId: alice.accountId });
        const personalMe = await (await fetch(`${urls[index]}/api/auth/me`,
          { headers: { Authorization: `Bearer ${sessions[position]!.personal.accessToken}` } })).json() as {
          ledgerId: string; accountId: string;
        };
        expect(personalMe).toMatchObject({ ledgerId: personalLedgerId, accountId: alice.accountId });
      }

      await new Promise<void>((resolve, reject) => hub.server.close((error) => error ? reject(error) : resolve()));
      const localMemberKey = await changeLedgerPassphrase(ledger, 'alice-ledger-password');
      const localPersonalKey = await changeLedgerPassphrase(personalLedger, 'alice-personal-password');
      const localTokens: { shared: string; personal: string }[] = [];
      for (const [position, index] of [1, 2].entries()) {
        const refresh = async (cookie: string): Promise<string> => {
          const response = await fetch(`${urls[index]}/api/auth/refresh`, { method: 'POST',
            headers: { Origin: urls[index]!, 'X-Zichan-Session': 'cookie', Cookie: cookie,
              'Content-Type': 'application/json' }, body: '{}' });
          expect(response.status).toBe(200);
          return ((await response.json()) as { accessToken: string }).accessToken;
        };
        const sharedToken = await refresh(sessions[position]!.shared.cookie);
        const transport = httpCommitTransport({ baseUrl: urls[index]!, token: sharedToken,
          cryptoSession: localMemberKey.session, keyEnvelope: localMemberKey.envelope,
          memberKeyEnvelope: true });
        const replica = await transport.connect(ledgerId);
        const sharedTransactionId = `shared-transaction-${index}-0001`;
        await transport.pushCommits(replica, [{ protocol: 2, ledgerId,
          commitId: `member-offline-${index}-0001`, originDeviceId: `device-${index}-0001`,
          createdAt: new Date().toISOString(), parentCommitIds: [], revisions: [{
            revisionId: `shared-revision-${index}-0001`, aggregateType: 'transaction',
            aggregateId: sharedTransactionId, parentRevisionIds: [], op: 'put',
            payload: { id: sharedTransactionId },
          }] }]);
        const personalToken = await refresh(sessions[position]!.personal.cookie);
        localTokens[position] = { shared: sharedToken, personal: personalToken };
        const personalTransport = httpCommitTransport({ baseUrl: urls[index]!, token: personalToken,
          cryptoSession: localPersonalKey.session, keyEnvelope: localPersonalKey.envelope });
        const personalConnection = await personalTransport.connect(personalLedgerId);
        const personalTransactionId = `personal-transaction-${index}-0001`;
        await personalTransport.pushCommits(personalConnection, [{ protocol: 2, ledgerId: personalLedgerId,
          commitId: `personal-offline-${index}-0001`, originDeviceId: `device-${index}-personal`,
          createdAt: new Date().toISOString(), parentCommitIds: [], revisions: [{
            revisionId: `personal-revision-${index}-0001`, aggregateType: 'transaction',
            aggregateId: personalTransactionId, parentRevisionIds: [], op: 'put',
            payload: { id: personalTransactionId },
          }] }]);
      }
      expect((await stores[0]!.replicaInventory('owner', ledgerId)).commitCount).toBe(0);
      expect((await stores[0]!.replicaInventory('alice', personalLedgerId)).commitCount).toBe(0);
      await new Promise<void>((resolve) => hub.server.listen(new URL(urls[0]!).port, '127.0.0.1', resolve));
      let sharedCounts = [0, 0, 0];
      let personalCounts = [0, 0, 0];
      for (let round = 0; round < 8; round += 1) {
        await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
        sharedCounts = await Promise.all(stores.map(async (store, index) =>
          (await store.replicaInventory(index === 0 ? 'owner'
            : (await store.listNodeReplicationLinks()).find((link) => link.ledgerId === ledgerId)!.username,
          ledgerId)).commitCount));
        personalCounts = await Promise.all(stores.map(async (store, index) =>
          (await store.replicaInventory(index === 0 ? 'alice'
            : (await store.listNodeReplicationLinks()).find((link) => link.ledgerId === personalLedgerId)!.username,
          personalLedgerId)).commitCount));
        if (sharedCounts.every((count) => count === 2)
          && personalCounts.every((count) => count === 2)) break;
      }
      expect(sharedCounts).toEqual([2, 2, 2]);
      expect(personalCounts).toEqual([2, 2, 2]);
      expect((await stores[0]!.getReplica('alice'))?.replicaId).toBe(personalReplica.replicaId);
      const hubPersonal = await loginAccount(urls[0]!, 'alice', 'alice-password',
        { deviceId: 'device-alice-personal-hub', deviceName: 'Personal ledger' });
      const hubSharedBase = await loginAccount(urls[0]!, 'alice', 'alice-password',
        { deviceId: 'device-alice-shared-hub', deviceName: 'Shared ledger' });
      const hubShared = await selectAccountLedger(urls[0]!, hubSharedBase.accessToken,
        (await stores[0]!.getReplica('owner'))!.replicaId);
      const tokens = [{ shared: hubShared.accessToken, personal: hubPersonal.accessToken }, ...localTokens];
      for (const [index, nodeTokens] of tokens.entries()) {
        const sharedTransport = httpCommitTransport({ baseUrl: urls[index]!, token: nodeTokens!.shared,
          cryptoSession: localMemberKey.session, keyEnvelope: localMemberKey.envelope,
          memberKeyEnvelope: true });
        const sharedReplica = await sharedTransport.connect(ledgerId);
        const sharedPage = await sharedTransport.pullCommits(sharedReplica, 0);
        expect(sharedPage.commits.flatMap((row) => 'commit' in row ? row.commit.revisions.map(
          (revision) => revision.aggregateId) : []).sort())
          .toEqual(['shared-transaction-1-0001', 'shared-transaction-2-0001']);
        const personalTransport = httpCommitTransport({ baseUrl: urls[index]!, token: nodeTokens!.personal,
          cryptoSession: localPersonalKey.session, keyEnvelope: localPersonalKey.envelope });
        const personalReplica = await personalTransport.connect(personalLedgerId);
        const personalPage = await personalTransport.pullCommits(personalReplica, 0);
        expect(personalPage.commits.flatMap((row) => 'commit' in row ? row.commit.revisions.map(
          (revision) => revision.aggregateId) : []).sort())
          .toEqual(['personal-transaction-1-0001', 'personal-transaction-2-0001']);
      }
    } finally {
      await Promise.all(stores.map((store) => store.close()));
      await Promise.all(nodes.map((node) => node.close()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
