import { mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerCryptoSession,
  signLedgerControlEvent, wrapLedgerCryptoSessionForMember } from '@zichan/core';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('federated account with two ledgers', () => {
  it('offers a separate login entry when two ledgers use the same identity node', async () => {
    const server = createTestSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    const store = new SyncServerStore(join(server.dataDir, 'server.sqlite'), 'open', server.serverId);
    try {
      const issuerNodeId = 'node-shared-issuer-0001';
      const links = [];
      for (const [username, ledgerId] of [
        ['first', 'ledger-federated-first-0001'],
        ['second', 'ledger-federated-second-0001'],
      ] as const) {
        await store.register(username, `opaque-${username}`, undefined, username === 'first');
        const replica = await store.bindReplica(username, ledgerId);
        links.push(await store.createNodeReplicationLink({ username, ledgerId,
          localStreamEpoch: replica.streamEpoch, peerUrl: 'https://issuer.example',
          peerNodeId: issuerNodeId, peerPublicKey: 'peer-public-key',
          peerReplicaId: `rep-peer-${username}-0001`, peerStreamEpoch: `epoch-peer-${username}-0001`,
          grantId: `grant-${username}-0001` }));
      }
      const providers = await (await fetch(`${url}/api/auth/federation/providers`)).json() as {
        providers: { issuerNodeId: string; ledgerId: string; linkId: string }[];
      };
      expect(providers.providers).toHaveLength(2);
      expect(providers.providers.map((provider) => provider.ledgerId).sort())
        .toEqual(links.map((link) => link.ledgerId).sort());
      expect((await fetch(`${url}/api/auth/federation/start?issuer=${issuerNodeId}`,
        { redirect: 'manual' })).status).toBe(409);
      for (const link of links) {
        const response = await fetch(`${url}/api/auth/federation/start?issuer=${issuerNodeId}&link=${link.linkId}`,
          { redirect: 'manual' });
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toContain('https://issuer.example/api/auth/federation/authorize');
      }
    } finally {
      await store.close();
      await server.close();
    }
  });

  it('keeps its personal route and enters an invited ledger in a separate session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'zichan-federated-multi-ledger-'));
    const nodeId = 'node-target-ledgers-0001';
    const issuerNodeId = 'node-public-issuer-0001';
    const store = new SyncServerStore(join(directory, 'server.sqlite'), 'open', nodeId);
    try {
      await store.register('host', 'opaque-host', undefined, true);
      const host = (await store.getUser('host'))!;
      const sharedLedgerId = 'ledger-shared-invite-0001';
      const personalLedgerId = 'ledger-personal-federated-0001';
      const memberAccountId = 'account-federated-member-0001';
      const shared = await store.bindReplica('host', sharedLedgerId);
      const sharedLink = await store.createNodeReplicationLink({ username: 'host',
        ledgerId: sharedLedgerId, localStreamEpoch: shared.streamEpoch,
        peerUrl: 'https://public.example', peerNodeId: issuerNodeId,
        peerPublicKey: 'peer-public-key', peerReplicaId: 'rep-peer-shared-0001',
        peerStreamEpoch: 'epoch-peer-shared-0001', grantId: 'grant-shared-0001' });
      const personalLink = await store.provisionFederatedReplica({
        issuerNodeId, subjectAccountId: memberAccountId, ledgerId: personalLedgerId,
        envelope: { ledgerId: personalLedgerId, keyringId: 'keyring-personal-0001', generation: 1 },
        peerUrl: 'https://public.example', peerNodeId: issuerNodeId,
        peerPublicKey: 'peer-public-key', peerReplicaId: 'rep-peer-personal-0001',
        peerStreamEpoch: 'epoch-peer-personal-0001', grantId: 'grant-personal-0001',
      });
      const personal = await store.getReplica(personalLink.username);
      expect(personal?.ledgerId).toBe(personalLedgerId);
      const ledger = createLedgerCryptoSession(sharedLedgerId);
      await store.putKeyEnvelope('host', sharedLedgerId, ledger.keyringId, 1,
        { ledgerId: sharedLedgerId, keyringId: ledger.keyringId, generation: 1 });
      const hostKey = await createAccountEncryptionKey(nodeId, host.accountId, 'host account password');
      const memberKey = await createAccountEncryptionKey(issuerNodeId, memberAccountId, 'member account password');
      await store.putAccountEncryptionKey(nodeId, host.accountId, hostKey.envelope.publicKey,
        hostKey.envelope as unknown as Record<string, unknown>, 0);
      await store.importAccountEncryptionKey({ issuerNodeId, subjectAccountId: memberAccountId,
        publicKey: memberKey.envelope.publicKey,
        envelope: memberKey.envelope as unknown as Record<string, unknown>,
        revision: 1, updatedAt: new Date().toISOString() });
      const actor = { issuerNodeId: nodeId, accountId: host.accountId };
      const target = { issuerNodeId, accountId: memberAccountId };
      const genesis = await store.initializeLedgerControl('host', signLedgerControlEvent(hostKey.privateKey, {
        v: 1, ledgerId: sharedLedgerId, seq: 1, previousHash: null, keyEpoch: 1,
        kind: 'MemberGenesis', actor, target: actor, role: 'OWNER',
        signingPublicKey: accountSigningPublicKey(hostKey.privateKey),
        encryptionPublicKey: hostKey.envelope.publicKey,
      }));
      const memberEnvelope = await wrapLedgerCryptoSessionForMember(ledger, {
        ...target, recipientPublicKey: memberKey.envelope.publicKey, keyEpoch: 1,
      });
      await store.appendLedgerControlEvent('host', signLedgerControlEvent(hostKey.privateKey, {
        v: 1, ledgerId: sharedLedgerId, seq: 2, previousHash: genesis.headHash, keyEpoch: 1,
        kind: 'MemberAdded', actor, target, role: 'EDITOR',
        signingPublicKey: accountSigningPublicKey(memberKey.privateKey),
        encryptionPublicKey: memberKey.envelope.publicKey,
      }), [memberEnvelope]);
      expect(await store.provisionFederatedMember(sharedLink, issuerNodeId, memberAccountId))
        .toBe(personalLink.username);
      const peerPublicKey = generateKeyPairSync('ed25519').publicKey
        .export({ format: 'der', type: 'spki' }).toString('base64url');
      const grant = await store.createNodeReplicationGrant('host', 'node-downstream-0001',
        peerPublicKey, new Date(Date.now() + 60_000).toISOString());
      await expect(store.issueFederatedLoginCode(grant.grantId, personalLink.username,
        memberAccountId, 'a'.repeat(43))).rejects.toMatchObject({ code: 'ISSUER_REQUIRED' });
      const session = await store.createSession({ id: 'session-federated-shared-0001',
        username: personalLink.username, deviceId: 'device-shared-0001', deviceName: 'Shared ledger',
        refreshHash: 'hash', expiresAt: new Date(Date.now() + 60_000).toISOString(),
        replicaId: shared.replicaId });
      expect(session.replicaId).toBe(shared.replicaId);
      expect((await store.getReplica(personalLink.username, session.replicaId))?.ledgerId).toBe(sharedLedgerId);
      expect((await store.getReplica(personalLink.username))?.ledgerId).toBe(personalLedgerId);
      await expect(store.createSession({ id: 'session-federated-invalid-0001',
        username: personalLink.username, deviceId: 'device-invalid-0001', deviceName: 'Unknown ledger',
        refreshHash: 'hash', expiresAt: new Date(Date.now() + 60_000).toISOString(),
        replicaId: 'rep-unknown-ledger-0001' })).rejects.toMatchObject({ code: 'LEDGER_ACCESS_DENIED' });
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
import type { AddressInfo } from 'node:net';
