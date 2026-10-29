import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { loadNodeIdentity } from '../src/node-identity.js';
import { signNodeRequest, verifyNodeResponse } from '../src/node-request-auth.js';
import { SyncServerStore } from '../src/store.js';

describe('retired replica write fence', () => {
  it('checks a stopped link using its historical grant and fences the replica after removal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-retired-stopped-link-'));
    const hub = createTestSyncServer({ dataDir: join(root, 'hub') });
    const oldNode = createTestSyncServer({ dataDir: join(root, 'old-node') });
    let hubStore: SyncServerStore | undefined;
    let oldStore: SyncServerStore | undefined;
    try {
      await Promise.all([hub.ready, oldNode.ready]);
      hubStore = new SyncServerStore(join(hub.dataDir, 'server.sqlite'), 'open', hub.serverId);
      oldStore = new SyncServerStore(join(oldNode.dataDir, 'server.sqlite'), 'open', oldNode.serverId);
      await new Promise<void>((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
      const hubUrl = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
      const ledgerId = 'ledger-stopped-retirement-0001';
      await hubStore.register('source', 'opaque-source', undefined, true);
      await oldStore.register('owner', 'opaque-owner', undefined, true);
      const remote = await hubStore.bindReplica('source', ledgerId);
      const local = await oldStore.bindReplica('owner', ledgerId);
      const oldIdentity = loadNodeIdentity(oldNode.dataDir, oldNode.serverId);
      const hubIdentity = loadNodeIdentity(hub.dataDir, hub.serverId);
      const grant = await hubStore.createNodeReplicationGrant('source', oldNode.serverId,
        oldIdentity.publicKey, new Date(Date.now() + 86_400_000).toISOString());
      const link = await oldStore.createNodeReplicationLink({ username: 'owner', ledgerId,
        localStreamEpoch: local.streamEpoch, peerUrl: hubUrl,
        peerNodeId: hub.serverId, peerPublicKey: hubIdentity.publicKey,
        peerReplicaId: remote.replicaId, peerStreamEpoch: remote.streamEpoch,
        grantId: grant.grantId });
      expect(await oldStore.disableNodeReplicationLink('owner', link.linkId)).toBe(true);
      await oldNode.flushNodeReplication();
      expect(await oldStore.replicaRetirement(local.replicaId)).toBeUndefined();
      expect(await hubStore.retireReplicaGroupMember('source', remote.replicaId,
        oldNode.serverId)).toBe(true);
      const statusPath = '/api/v4/replication/member-status';
      const proof = signNodeRequest(oldIdentity, grant.grantId, 'GET', statusPath);
      const historicalStatus = await fetch(`${hubUrl}${statusPath}`, { headers: {
        'X-Zichan-Node-Proof': JSON.stringify(proof),
      } });
      expect(historicalStatus.status).toBe(200);
      const rawStatus = Buffer.from(await historicalStatus.arrayBuffer());
      expect(verifyNodeResponse(hubIdentity.publicKey, proof.nonce, rawStatus,
        historicalStatus.headers.get('x-zichan-node-response') ?? '')).toBe(true);
      expect(JSON.parse(rawStatus.toString('utf8'))).toMatchObject({
        retiredNodeId: oldNode.serverId, retiredAt: expect.any(String),
      });
      expect((await fetch(`${hubUrl}${statusPath}`, { headers: {
        'X-Zichan-Node-Proof': JSON.stringify(proof),
      } })).status).toBe(403);
      await oldNode.flushNodeReplication();
      expect(await oldStore.replicaRetirement(local.replicaId)).toMatchObject({
        sourceNodeId: hub.serverId,
      });
      expect((await oldStore.listNodeReplicationLinks('owner'))[0]).toMatchObject({
        lifecycleState: 'REVOKED', revocationPending: false,
      });
      await expect(oldStore.assertLedgerAccess('owner', 'write', local.replicaId))
        .rejects.toMatchObject({ code: 'REPLICA_RETIRED' });
    } finally {
      await Promise.all([hubStore?.close(), oldStore?.close(), hub.close(), oldNode.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts only a signed retirement proof, then blocks old-node writes while preserving another ledger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-retired-node-fence-'));
    const hub = createTestSyncServer({ dataDir: join(root, 'hub') });
    const oldNode = createTestSyncServer({ dataDir: join(root, 'old-node') });
    let hubStore: SyncServerStore | undefined;
    let oldStore: SyncServerStore | undefined;
    try {
      await Promise.all([hub.ready, oldNode.ready]);
      await Promise.all([hub, oldNode].map((service) => new Promise<void>((resolve) =>
        service.server.listen(0, '127.0.0.1', resolve))));
      const hubUrl = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
      const oldUrl = `http://127.0.0.1:${(oldNode.server.address() as AddressInfo).port}`;
      await registerAccount(oldUrl, 'owner', 'retired-node-owner-password',
        { ownerSetupToken: OWNER_SETUP_TOKEN });
      const session = await loginAccount(oldUrl, 'owner', 'retired-node-owner-password');
      const authorization = { Authorization: `Bearer ${session.accessToken}` };
      const initialized = await fetch(`${oldUrl}/api/v3/protection/initialize`, {
        method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'managed' }),
      });
      expect(initialized.status).toBe(200);
      const { replica: local } = await initialized.json() as {
        replica: { ledgerId: string; replicaId: string; streamEpoch: string };
      };
      hubStore = new SyncServerStore(join(hub.dataDir, 'server.sqlite'), 'open', hub.serverId);
      oldStore = new SyncServerStore(join(oldNode.dataDir, 'server.sqlite'), 'open', oldNode.serverId);
      await hubStore.register('source', 'opaque-source', undefined, true);
      const remote = await hubStore.bindReplica('source', local.ledgerId);
      await oldStore.register('other', 'opaque-other');
      const other = await oldStore.bindReplica('other', 'ledger-other-on-retired-node-0001');
      const oldIdentity = loadNodeIdentity(oldNode.dataDir, oldNode.serverId);
      const hubIdentity = loadNodeIdentity(hub.dataDir, hub.serverId);
      const grant = await hubStore.createNodeReplicationGrant('source', oldNode.serverId,
        oldIdentity.publicKey, new Date(Date.now() + 86_400_000).toISOString());
      const link = await oldStore.createNodeReplicationLink({ username: 'owner',
        ledgerId: local.ledgerId, localStreamEpoch: local.streamEpoch,
        peerUrl: hubUrl, peerNodeId: hub.serverId, peerPublicKey: hubIdentity.publicKey,
        peerReplicaId: remote.replicaId, peerStreamEpoch: remote.streamEpoch,
        grantId: grant.grantId });
      const ordinaryRevocation = await hubStore.createNodeReplicationGrant('source', oldNode.serverId,
        oldIdentity.publicKey, new Date(Date.now() + 86_400_000).toISOString());
      await hubStore.revokeNodeReplicationGrant('source', ordinaryRevocation.grantId);
      const path = '/api/v4/replication/commits?after=0&limit=1';
      const revokedResponse = await fetch(`${hubUrl}${path}`, { headers: {
        'X-Zichan-Node-Proof': JSON.stringify(signNodeRequest(oldIdentity,
          ordinaryRevocation.grantId, 'GET', path)),
      } });
      expect(revokedResponse.status).toBe(403);
      expect(revokedResponse.headers.get('x-zichan-node-response')).toBeNull();
      expect(await oldStore.replicaRetirement(local.replicaId)).toBeUndefined();
      expect(await hubStore.retireReplicaGroupMember('source', remote.replicaId,
        oldNode.serverId)).toBe(true);
      const forged = signNodeRequest(oldIdentity, grant.grantId, 'GET', path);
      const forgedResponse = await fetch(`${hubUrl}${path}`, { headers: {
        'X-Zichan-Node-Proof': JSON.stringify({ ...forged, nonce: 'x'.repeat(22) }),
      } });
      expect(forgedResponse.status).toBe(403);
      expect(forgedResponse.headers.get('x-zichan-node-response')).toBeNull();
      await oldNode.flushNodeReplication();
      expect(await oldStore.replicaRetirement(local.replicaId)).toMatchObject({
        sourceNodeId: hub.serverId,
      });
      expect((await oldStore.listNodeReplicationLinks('owner')).find((item) =>
        item.linkId === link.linkId)?.enabled).toBe(false);
      const write = await fetch(`${oldUrl}/api/v3/commits`, { method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' }, body: '{}' });
      expect(write.status).toBe(409);
      expect(await write.json()).toMatchObject({ code: 'REPLICA_RETIRED' });
      expect((await fetch(`${oldUrl}/api/v3/commits`, { headers: authorization })).status).toBe(200);
      const readiness = await fetch(`${oldUrl}/api/v4/ledger/readiness`, { headers: authorization });
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toMatchObject({ state: 'VERIFYING',
        issues: expect.arrayContaining([expect.stringMatching(/已移出副本组/)]) });
      await expect(oldStore.assertLedgerAccess('owner', 'write', local.replicaId))
        .rejects.toMatchObject({ code: 'REPLICA_RETIRED' });
      await expect(oldStore.assertLedgerAccess('other', 'write', other.replicaId)).resolves.toBeUndefined();
      await oldStore.close();
      oldStore = undefined;
      const reopened = new SyncServerStore(join(oldNode.dataDir, 'server.sqlite'), 'open', oldNode.serverId);
      try {
        expect(await reopened.replicaRetirement(local.replicaId)).toBeDefined();
        await expect(reopened.assertLedgerAccess('owner', 'write', local.replicaId))
          .rejects.toMatchObject({ code: 'REPLICA_RETIRED' });
      } finally { await reopened.close(); }
    } finally {
      await Promise.all([hubStore?.close(), oldStore?.close(), hub.close(), oldNode.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
