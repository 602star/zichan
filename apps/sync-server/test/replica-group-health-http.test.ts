import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { SyncServerStore } from '../src/store.js';
import { loadNodeIdentity } from '../src/node-identity.js';
import { signNodeRequest } from '../src/node-request-auth.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('three node replica group health', () => {
  it('requires a current signed and matching report from both LAN members', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-group-health-'));
    const [hub, home, office] = ['hub', 'home', 'office'].map((name) =>
      createTestSyncServer({ dataDir: join(root, name) })) as [
        ReturnType<typeof createTestSyncServer>, ReturnType<typeof createTestSyncServer>,
        ReturnType<typeof createTestSyncServer>];
    const stores: SyncServerStore[] = [];
    try {
      await Promise.all([hub, home, office].map((node) =>
        new Promise<void>((resolve) => node.server.listen(0, '127.0.0.1', resolve))));
      const url = (node: typeof hub) => `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
      const auth = async (node: typeof hub) => {
        await registerAccount(url(node), 'owner', 'group-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
        return { Authorization: `Bearer ${(await loginAccount(url(node), 'owner', 'group-password')).accessToken}`,
          'Content-Type': 'application/json' };
      };
      const [hubAuth, homeAuth, officeAuth] = await Promise.all([hub, home, office].map(auth));
      const initialized = await fetch(`${url(hub)}/api/v3/protection/initialize`, { method: 'POST',
        headers: hubAuth, body: JSON.stringify({ mode: 'managed' }) });
      expect(initialized.status).toBe(200);
      const { replica, envelope } = await initialized.json() as {
        replica: { ledgerId: string }; envelope: Record<string, unknown>;
      };
      for (const [node, headers] of [[home, homeAuth], [office, officeAuth]] as const) {
        expect((await fetch(`${url(node)}/api/v3/protection/initialize`, { method: 'POST', headers,
          body: JSON.stringify({ mode: 'private', envelope }) })).status).toBe(200);
      }
      const hubIdentity = loadNodeIdentity(hub.dataDir, hub.serverId);
      const grants: string[] = [];
      for (const [node, headers] of [[home, homeAuth], [office, officeAuth]] as const) {
        const grant = await fetch(`${url(hub)}/api/v4/replication/grants`, { method: 'POST',
          headers: hubAuth, body: JSON.stringify({ peerNodeId: node.serverId,
            peerPublicKey: loadNodeIdentity(node.dataDir, node.serverId).publicKey,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString() }) });
        expect(grant.status).toBe(201);
        const { grantId } = await grant.json() as { grantId: string };
        grants.push(grantId);
        expect((await fetch(`${url(node)}/api/v4/replication/links`, { method: 'POST', headers,
          body: JSON.stringify({ peerUrl: url(hub), peerNodeId: hub.serverId,
            peerPublicKey: hubIdentity.publicKey, grantId }) })).status).toBe(201);
      }
      const hubStore = new SyncServerStore(join(hub.dataDir, 'server.sqlite'), 'open', hub.serverId);
      stores.push(hubStore);
      const promise = await hubStore.beginAttachmentPromise('owner', 0);
      await hubStore.completeAttachmentPromise('owner', promise.uploadId);
      const hubInventory = await hubStore.replicaInventory('owner', replica.ledgerId);
      await hubStore.recordReplicaPhysicalStatus('owner', replica.ledgerId, hubInventory.blobHash);
      const group = async () => {
        const result = await fetch(`${url(hub)}/api/v4/ledger/group-health`, { headers: hubAuth });
        expect(result.status).toBe(200);
        return result.json() as Promise<{ state: string; memberCount: number; readyCount: number; issues: string[] }>;
      };
      expect(await group()).toMatchObject({ memberCount: 3, state: 'VERIFYING' });
      const readyMember = async (node: typeof hub) => {
        await node.flushNodeReplication();
        await node.flushNodeReplication();
        const store = new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId);
        stores.push(store);
        const inventory = await store.replicaInventory('owner', replica.ledgerId);
        await store.recordReplicaPhysicalStatus('owner', replica.ledgerId, inventory.blobHash);
        await node.flushNodeReplication();
      };
      await readyMember(home);
      expect(await group()).toMatchObject({ memberCount: 3, readyCount: 2, state: 'VERIFYING' });
      await readyMember(office);
      expect(await group()).toMatchObject({ memberCount: 3, readyCount: 3, state: 'READY', issues: [] });
      const staleSurvivor = new NodeSqliteDriver(join(hub.dataDir, 'server.sqlite'));
      try {
        await staleSurvivor.run('UPDATE node_replica_health_reports SET received_at = ? WHERE grant_id = ?',
          [new Date(Date.now() - 2 * 60_000).toISOString(), grants[1]!]);
        const premature = await fetch(`${url(hub)}/api/v4/ledger/group-members/${home.serverId}`,
          { method: 'DELETE', headers: hubAuth });
        expect(premature.status).toBe(409);
        expect(await premature.json()).toMatchObject({ code: 'GROUP_MEMBER_NOT_VERIFIED',
          memberState: 'READY', survivingMembers: expect.arrayContaining([
            expect.objectContaining({ nodeId: office.serverId, state: 'VERIFYING' }),
          ]) });
        await staleSurvivor.run('UPDATE node_replica_health_reports SET received_at = ? WHERE grant_id = ?',
          [new Date().toISOString(), grants[1]!]);
      } finally { await staleSurvivor.close(); }
      await home.flushNodeReplication();
      for (const [node, headers] of [[home, homeAuth], [office, officeAuth]] as const) {
        const localGroup = await fetch(`${url(node)}/api/v4/ledger/group-health`, { headers });
        expect(localGroup.status).toBe(200);
        expect(await localGroup.json()).toMatchObject({ state: 'READY', memberCount: 3,
          readyCount: 3, coordinatorNodeId: hub.serverId });
      }
      const officeLink = (await stores[2]!.listNodeReplicationLinks('owner'))[0]!;
      const reopenedOfficeStore = new SyncServerStore(join(office.dataDir, 'server.sqlite'), 'open', office.serverId);
      stores.push(reopenedOfficeStore);
      const persistedGroup = await reopenedOfficeStore.nodeGroupSnapshot(officeLink.linkId);
      expect(persistedGroup?.snapshot).toMatchObject({ serverId: hub.serverId,
        directory: { members: expect.arrayContaining([
          expect.objectContaining({ nodeId: home.serverId }),
          expect.objectContaining({ nodeId: office.serverId }),
        ]) } });
      const homeInventory = await stores[1]!.replicaInventory('owner', replica.ledgerId);
      const forged = JSON.stringify({ sourceReplicaId: hubInventory.replicaId,
        sourceStreamEpoch: hubInventory.streamEpoch,
        inventory: { ...homeInventory, serverId: office.serverId }, physical: {},
        lifecycleState: 'READY', lifecycleCheckedAt: new Date().toISOString() });
      const proof = signNodeRequest(loadNodeIdentity(home.dataDir, home.serverId), grants[0]!,
        'POST', '/api/v4/replication/health-report', Buffer.from(forged));
      expect((await fetch(`${url(hub)}/api/v4/replication/health-report`, { method: 'POST',
        headers: { 'X-Zichan-Node-Proof': JSON.stringify(proof), 'Content-Type': 'application/json' },
        body: forged })).status).toBe(400);
      expect(await group()).toMatchObject({ memberCount: 3, readyCount: 3, state: 'READY' });
      expect(await hubStore.revokeNodeReplicationGrant('owner', grants[0]!)).toBe(true);
      expect(await group()).toMatchObject({ memberCount: 3, readyCount: 2, state: 'VERIFYING',
        issues: expect.arrayContaining([expect.stringContaining('授权已撤销或过期')]) });
      await office.flushNodeReplication();
      const officeDegraded = await fetch(`${url(office)}/api/v4/ledger/group-health`, { headers: officeAuth });
      expect(await officeDegraded.json()).toMatchObject({ state: 'VERIFYING', memberCount: 3 });
      const reauthorized = await fetch(`${url(hub)}/api/v4/replication/grants`, { method: 'POST',
        headers: hubAuth, body: JSON.stringify({ peerNodeId: home.serverId,
          peerPublicKey: loadNodeIdentity(home.dataDir, home.serverId).publicKey,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString() }) });
      expect(reauthorized.status).toBe(201);
      expect(await group()).toMatchObject({ memberCount: 3, state: 'VERIFYING' });
      const members = await fetch(`${url(hub)}/api/v4/ledger/group-members`, { headers: hubAuth });
      expect(members.status).toBe(200);
      expect(await members.json()).toMatchObject({ members: expect.arrayContaining([
        expect.objectContaining({ nodeId: home.serverId }),
        expect.objectContaining({ nodeId: office.serverId }),
      ]) });
      const retirePath = `${url(hub)}/api/v4/ledger/group-members/${home.serverId}`;
      const unverifiedRetire = await fetch(retirePath, { method: 'DELETE', headers: hubAuth });
      expect(unverifiedRetire.status).toBe(409);
      expect(await unverifiedRetire.json()).toMatchObject({ code: 'GROUP_MEMBER_NOT_VERIFIED',
        memberState: 'MISSING' });
      expect(await group()).toMatchObject({ memberCount: 3, state: 'VERIFYING' });
      const wrongConfirmation = await fetch(retirePath, { method: 'DELETE', headers: hubAuth,
        body: JSON.stringify({ nodeId: office.serverId, confirmUnverifiedRemoval: true }) });
      expect(wrongConfirmation.status).toBe(409);
      const retire = await fetch(retirePath,
        { method: 'DELETE', headers: hubAuth,
          body: JSON.stringify({ nodeId: home.serverId, confirmUnverifiedRemoval: true }) });
      expect(retire.status).toBe(200);
      expect(await retire.json()).toMatchObject({ ok: true, unverified: true });
      expect(await group()).toMatchObject({ memberCount: 2, readyCount: 2, state: 'READY' });
      await office.flushNodeReplication();
      const officeReduced = await fetch(`${url(office)}/api/v4/ledger/group-health`, { headers: officeAuth });
      expect(await officeReduced.json()).toMatchObject({ state: 'READY', memberCount: 2,
        readyCount: 2, coordinatorNodeId: hub.serverId });
      const officeDatabase = new NodeSqliteDriver(join(office.dataDir, 'server.sqlite'));
      try {
        await officeDatabase.run('UPDATE node_replica_group_snapshots SET received_at = ?',
          [new Date(Date.now() - 2 * 60_000).toISOString()]);
      } finally { await officeDatabase.close(); }
      expect(await (await fetch(`${url(office)}/api/v4/ledger/group-health`, { headers: officeAuth })).json())
        .toMatchObject({ state: 'VERIFYING', readyCount: 0 });
      await office.flushNodeReplication();
      expect(await (await fetch(`${url(office)}/api/v4/ledger/group-health`, { headers: officeAuth })).json())
        .toMatchObject({ state: 'READY', readyCount: 2 });
      const retiredAt = (await hubStore.listReplicaGroupMembers(hubInventory.replicaId))
        .find((member) => member.nodeId === home.serverId)?.retiredAt;
      expect(retiredAt).toBeTruthy();
      const rollback = new NodeSqliteDriver(join(hub.dataDir, 'server.sqlite'));
      try {
        await rollback.run('UPDATE ledger_replica_group_members SET retired_at = NULL WHERE replica_id = ? AND node_id = ?',
          [hubInventory.replicaId, home.serverId]);
        await office.flushNodeReplication();
        expect(await (await fetch(`${url(office)}/api/v4/ledger/group-health`, { headers: officeAuth })).json())
          .toMatchObject({ state: 'VERIFYING', readyCount: 0 });
        await rollback.run('UPDATE ledger_replica_group_members SET retired_at = ? WHERE replica_id = ? AND node_id = ?',
          [retiredAt, hubInventory.replicaId, home.serverId]);
      } finally { await rollback.close(); }
      await office.flushNodeReplication();
      expect(await (await fetch(`${url(office)}/api/v4/ledger/group-health`, { headers: officeAuth })).json())
        .toMatchObject({ state: 'READY', readyCount: 2 });
      const homeStore = stores[1]!;
      const homeLink = (await homeStore.listNodeReplicationLinks('owner'))[0]!;
      expect(await homeStore.disableNodeReplicationLink('owner', homeLink.linkId)).toBe(true);
      await home.flushNodeReplication();
      expect((await homeStore.listNodeReplicationLinks('owner'))[0]).toMatchObject({
        lifecycleState: 'REVOKED', revocationPending: false,
      });
      const changedKey = await fetch(`${url(hub)}/api/v4/replication/grants`, { method: 'POST',
        headers: hubAuth, body: JSON.stringify({ peerNodeId: home.serverId,
          peerPublicKey: loadNodeIdentity(office.dataDir, office.serverId).publicKey,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString() }) });
      expect(changedKey.status).toBe(409);
      const retiredKey = await fetch(`${url(hub)}/api/v4/replication/grants`, { method: 'POST',
        headers: hubAuth, body: JSON.stringify({ peerNodeId: home.serverId,
          peerPublicKey: loadNodeIdentity(home.dataDir, home.serverId).publicKey,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString() }) });
      expect(retiredKey.status).toBe(409);
      const database = new NodeSqliteDriver(join(hub.dataDir, 'server.sqlite'));
      try {
        // Model a pre-directory database: the next store initialization must
        // enroll an existing active grant without changing that grant.
        await database.run('DELETE FROM ledger_replica_group_members WHERE node_id = ?', [office.serverId]);
      } finally { await database.close(); }
      expect(await hubStore.getNodeReplicationGrant(grants[1]!)).toBeUndefined();
      const upgraded = new SyncServerStore(join(hub.dataDir, 'server.sqlite'), 'open', hub.serverId);
      stores.push(upgraded);
      await upgraded.ready;
      expect((await upgraded.getNodeReplicationGrant(grants[1]!))?.peerNodeId).toBe(office.serverId);
      expect(await group()).toMatchObject({ memberCount: 2, state: 'READY' });
    } finally {
      await Promise.all(stores.map((store) => store.close()));
      await Promise.all([hub, home, office].map((node) => node.close()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
