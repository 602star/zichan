import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { loadNodeIdentity } from '../src/node-identity.js';
import { signedCall } from '../src/node-replication.js';
import { CURRENT_SERVER_SCHEMA, SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('durable node grant revocation', () => {
  it('upgrades a v21 stopped link without claiming its old grant was revoked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-node-revoke-upgrade-'));
    const file = join(root, 'server.sqlite');
    const initial = new SyncServerStore(file, 'open', 'node-revoke-upgrade');
    let upgraded: SyncServerStore | undefined;
    try {
      await initial.register('owner', 'opaque-owner', undefined, true);
      const ledgerId = 'ledger-revoke-upgrade-0001';
      const replica = await initial.bindReplica('owner', ledgerId);
      const link = await initial.createNodeReplicationLink({ username: 'owner', ledgerId,
        localStreamEpoch: replica.streamEpoch, peerUrl: 'http://127.0.0.1:30303',
        peerNodeId: 'node-upgrade-peer', peerPublicKey: 'legacy-peer-key',
        peerReplicaId: 'replica-upgrade-peer', peerStreamEpoch: 'epoch-upgrade-peer',
        grantId: 'grant-upgrade-peer-0001' });
      await initial.disableNodeReplicationLink('owner', link.linkId);
      await initial.close();
      const sql = new NodeSqliteDriver(file);
      try {
        await sql.exec('ALTER TABLE node_replication_links DROP COLUMN revocation_pending');
        await sql.exec('ALTER TABLE node_replication_links DROP COLUMN remote_revoked_at');
        await sql.exec('ALTER TABLE node_replication_links DROP COLUMN revocation_error');
        await sql.run('UPDATE server_schema_migrations SET version = 21, name = ?',
          ['signed_rejected_commit_resolution_v21']);
      } finally { await sql.close(); }
      upgraded = new SyncServerStore(file, 'open', 'node-revoke-upgrade');
      expect((await upgraded.verify()).schemaVersion).toBe(CURRENT_SERVER_SCHEMA);
      expect((await upgraded.listNodeReplicationLinks('owner'))[0]).toMatchObject({
        linkId: link.linkId, enabled: false, revocationPending: false,
        lifecycleState: 'STOPPED',
      });
    } finally {
      await (upgraded ?? initial).close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops locally while the source is offline and confirms revocation after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-node-revoke-'));
    const source = createTestSyncServer({ dataDir: join(root, 'source') });
    let target = createTestSyncServer({ dataDir: join(root, 'target') });
    let sourceStore: SyncServerStore | undefined;
    let targetStore: SyncServerStore | undefined;
    try {
      await Promise.all([source.ready, target.ready]);
      await new Promise<void>((resolve) => source.server.listen(0, '127.0.0.1', resolve));
      const sourceUrl = `http://127.0.0.1:${(source.server.address() as AddressInfo).port}`;
      sourceStore = new SyncServerStore(join(source.dataDir, 'server.sqlite'), 'open', source.serverId);
      targetStore = new SyncServerStore(join(target.dataDir, 'server.sqlite'), 'open', target.serverId);
      await sourceStore.register('owner', 'opaque-source', undefined, true);
      await targetStore.register('owner', 'opaque-target', undefined, true);
      const ledgerId = 'ledger-node-revoke-retry-0001';
      const sourceReplica = await sourceStore.bindReplica('owner', ledgerId);
      const targetReplica = await targetStore.bindReplica('owner', ledgerId);
      const envelope = { ledgerId, keyringId: 'keyring-node-revoke-retry', generation: 1 };
      await sourceStore.putKeyEnvelope('owner', ledgerId, envelope.keyringId, 1, envelope);
      await targetStore.putKeyEnvelope('owner', ledgerId, envelope.keyringId, 1, envelope);
      const identity = loadNodeIdentity(target.dataDir, target.serverId);
      const grant = await sourceStore.createNodeReplicationGrant('owner', target.serverId,
        identity.publicKey, new Date(Date.now() + 86_400_000).toISOString());
      const link = await targetStore.createNodeReplicationLink({ username: 'owner', ledgerId,
        localStreamEpoch: targetReplica.streamEpoch, peerUrl: sourceUrl,
        peerNodeId: source.serverId, peerPublicKey: loadNodeIdentity(source.dataDir, source.serverId).publicKey,
        peerReplicaId: sourceReplica.replicaId, peerStreamEpoch: sourceReplica.streamEpoch,
        grantId: grant.grantId });
      expect(link.lifecycleState).toBe('JOINING');
      await target.flushNodeReplication();
      await new Promise<void>((resolve, reject) => source.server.close((error) => error ? reject(error) : resolve()));
      expect(await targetStore.disableNodeReplicationLink('owner', link.linkId)).toBe(true);
      await target.flushNodeReplication();
      const stopped = (await targetStore.listNodeReplicationLinks('owner'))[0]!;
      expect(stopped).toMatchObject({ enabled: false, revocationPending: true,
        lifecycleState: 'REVOKING' });
      expect(stopped.revocationError).toBeTruthy();
      expect((await sourceStore.getNodeReplicationGrant(grant.grantId))?.revokedAt).toBeUndefined();
      await targetStore.close();
      targetStore = undefined;
      await target.close();
      target = createTestSyncServer({ dataDir: join(root, 'target') });
      await target.ready;
      targetStore = new SyncServerStore(join(target.dataDir, 'server.sqlite'), 'open', target.serverId);
      expect(await targetStore.pendingNodeRevocations()).toMatchObject([{ linkId: link.linkId }]);
      expect((await targetStore.listNodeReplicationLinks('owner'))[0]?.lifecycleState).toBe('REVOKING');
      // Simulate a successful revoke whose response was lost while the network was down.
      await sourceStore.revokeNodeReplicationGrant('owner', grant.grantId);
      await new Promise<void>((resolve) => source.server.listen(new URL(sourceUrl).port, '127.0.0.1', resolve));
      await target.flushNodeReplication();
      const confirmed = (await targetStore.listNodeReplicationLinks('owner'))[0]!;
      expect(confirmed).toMatchObject({ enabled: false, revocationPending: false,
        lifecycleState: 'REVOKED' });
      expect(confirmed.remoteRevokedAt).toBeTruthy();
      expect(confirmed.revocationError).toBeUndefined();
      expect(await targetStore.pendingNodeRevocations()).toEqual([]);
      await expect(signedCall(identity, link, 'GET', '/api/v4/replication/inventory'))
        .rejects.toThrow(/HTTP 403/);
      const nextGrant = await sourceStore.createNodeReplicationGrant('owner', target.serverId,
        identity.publicKey, new Date(Date.now() + 86_400_000).toISOString());
      await targetStore.renewNodeReplicationLink('owner', link.linkId, nextGrant.grantId,
        link.peerNodeId, link.peerPublicKey, link.peerReplicaId, link.peerStreamEpoch);
      expect((await targetStore.listNodeReplicationLinks('owner'))[0]?.lifecycleState).toBe('JOINING');
      await targetStore.disableNodeReplicationLink('owner', link.linkId);
      await target.flushNodeReplication();
      expect((await sourceStore.getNodeReplicationGrant(nextGrant.grantId))?.revokedAt).toBeTruthy();
      expect((await targetStore.listNodeReplicationLinks('owner'))[0])
        .toMatchObject({ enabled: false, revocationPending: false });
      await expect(targetStore.renewNodeReplicationLink('owner', link.linkId, nextGrant.grantId,
        link.peerNodeId, link.peerPublicKey, link.peerReplicaId, link.peerStreamEpoch))
        .rejects.toMatchObject({ code: 'NEW_GRANT_REQUIRED' });
      await expect(signedCall(identity, link, 'GET', '/api/v4/replication/inventory'))
        .rejects.toThrow(/HTTP 403/);
    } finally {
      await Promise.all([sourceStore?.close(), targetStore?.close()]);
      await Promise.all([source.close(), target.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
