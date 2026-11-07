import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { SyncServerStore } from '../src/store.js';
import { loadNodeIdentity } from '../src/node-identity.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('ledger replica readiness HTTP', () => {
  it('reports READY for a linked node only after live peer agreement and local verification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-readiness-peer-'));
    const source = createTestSyncServer({ dataDir: join(root, 'source') });
    const peer = createTestSyncServer({ dataDir: join(root, 'peer') });
    let sourceStore: SyncServerStore | undefined;
    let peerStore: SyncServerStore | undefined;
    try {
      await Promise.all([source, peer].map((server) =>
        new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve))));
      const url = (server: typeof source) => `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
      const auth = async (server: typeof source) => {
        await registerAccount(url(server), 'owner', 'readiness-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
        return { Authorization: `Bearer ${(await loginAccount(url(server), 'owner', 'readiness-password')).accessToken}`,
          'Content-Type': 'application/json' };
      };
      const sourceAuth = await auth(source);
      const peerAuth = await auth(peer);
      const initialized = await fetch(`${url(source)}/api/v3/protection/initialize`, { method: 'POST',
        headers: sourceAuth, body: JSON.stringify({ mode: 'managed' }) });
      expect(initialized.status).toBe(200);
      const sourceReplica = await initialized.json() as {
        replica: { ledgerId: string }; envelope: Record<string, unknown>; secret: string;
      };
      expect((await fetch(`${url(peer)}/api/v3/protection/initialize`, { method: 'POST',
        headers: peerAuth, body: JSON.stringify({ mode: 'managed', envelope: sourceReplica.envelope,
          secret: sourceReplica.secret }) })).status).toBe(200);
      const peerIdentity = loadNodeIdentity(peer.dataDir, peer.serverId);
      const grant = await fetch(`${url(source)}/api/v4/replication/grants`, { method: 'POST',
        headers: sourceAuth, body: JSON.stringify({ peerNodeId: peer.serverId,
          peerPublicKey: peerIdentity.publicKey, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }) });
      expect(grant.status).toBe(201);
      const { grantId } = await grant.json() as { grantId: string };
      expect((await fetch(`${url(peer)}/api/v4/replication/links`, { method: 'POST',
        headers: peerAuth, body: JSON.stringify({ peerUrl: url(source), peerNodeId: source.serverId,
          peerPublicKey: loadNodeIdentity(source.dataDir, source.serverId).publicKey, grantId }) })).status).toBe(201);
      sourceStore = new SyncServerStore(join(source.dataDir, 'server.sqlite'), 'open', source.serverId);
      const promise = await sourceStore.beginAttachmentPromise('owner', 0);
      await sourceStore.completeAttachmentPromise('owner', promise.uploadId);
      const sourceInventory = await sourceStore.replicaInventory('owner', sourceReplica.replica.ledgerId);
      await sourceStore.recordReplicaPhysicalStatus('owner', sourceReplica.replica.ledgerId, sourceInventory.blobHash);
      const missingMember = await fetch(`${url(source)}/api/v4/ledger/group-health`, { headers: sourceAuth });
      expect(missingMember.status).toBe(200);
      expect(await missingMember.json()).toMatchObject({ memberCount: 2, state: 'VERIFYING',
        issues: expect.arrayContaining([expect.stringContaining('报告缺失')]) });
      await peer.flushNodeReplication();
      await peer.flushNodeReplication();
      peerStore = new SyncServerStore(join(peer.dataDir, 'server.sqlite'), 'open', peer.serverId);
      const inventory = await peerStore.replicaInventory('owner', sourceReplica.replica.ledgerId);
      await peerStore.recordReplicaPhysicalStatus('owner', sourceReplica.replica.ledgerId, inventory.blobHash);
      await peer.flushNodeReplication();
      const lifecycle = (await peerStore.listNodeReplicationLinks('owner'))[0]!;
      expect(lifecycle).toMatchObject({ lifecycleState: 'READY', enabled: true });
      const persisted = new NodeSqliteDriver(join(peer.dataDir, 'server.sqlite'));
      try {
        expect((await persisted.get<{ lifecycle_state: string }>(
          'SELECT lifecycle_state FROM node_replication_links WHERE link_id = ?',
          [lifecycle.linkId]))?.lifecycle_state).toBe('READY');
      } finally { await persisted.close(); }
      const ready = await fetch(`${url(peer)}/api/v4/ledger/readiness`, { headers: peerAuth });
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ state: 'READY', issues: [], linkedPeers: 1,
        verifiedPeers: 1 });
      const groupReady = await fetch(`${url(source)}/api/v4/ledger/group-health`, { headers: sourceAuth });
      expect(groupReady.status).toBe(200);
      expect(await groupReady.json()).toMatchObject({ state: 'READY', memberCount: 2,
        readyCount: 2, issues: [] });
      const rescanPath = `${url(peer)}/api/v4/replication/links/${lifecycle.linkId}/rescan`;
      expect((await fetch(rescanPath, { method: 'POST' })).status).toBe(401);
      const rescanResponse = await fetch(rescanPath, { method: 'POST', headers: peerAuth });
      expect(rescanResponse.status).toBe(202);
      expect(await rescanResponse.json()).toMatchObject({ link: {
        linkId: lifecycle.linkId, grantId, enabled: true,
        pullSeq: 0, pushSeq: 0, pullBlobCursor: '', pushBlobCursor: '',
        pullStateCursor: '', pushStateCursor: '', lifecycleState: 'BOOTSTRAPPING',
      } });
      await peer.flushNodeReplication();
      await peer.flushNodeReplication();
      expect((await peerStore.listNodeReplicationLinks('owner'))[0]?.lifecycleState).toBe('READY');
      expect(await (await fetch(`${url(source)}/api/v4/ledger/group-health`,
        { headers: sourceAuth })).json()).toMatchObject({ state: 'READY', readyCount: 2 });
      const staleReport = new NodeSqliteDriver(join(source.dataDir, 'server.sqlite'));
      try {
        await staleReport.run('UPDATE node_replica_health_reports SET received_at = ? WHERE grant_id = ?',
          [new Date(Date.now() - 2 * 60_000).toISOString(), grantId]);
      } finally { await staleReport.close(); }
      const staleGroup = await fetch(`${url(source)}/api/v4/ledger/group-health`, { headers: sourceAuth });
      expect(await staleGroup.json()).toMatchObject({ state: 'VERIFYING', memberCount: 2,
        issues: expect.arrayContaining([expect.stringContaining('超过 60 秒')]) });
      const aged = new NodeSqliteDriver(join(peer.dataDir, 'server.sqlite'));
      try {
        await aged.run('UPDATE node_replication_links SET lifecycle_checked_at = ? WHERE link_id = ?',
          [new Date(Date.now() - 2 * 60_000).toISOString(), lifecycle.linkId]);
      } finally { await aged.close(); }
      expect((await peerStore.listNodeReplicationLinks('owner'))[0]?.lifecycleState).toBe('VERIFYING');
      expect(await sourceStore.revokeNodeReplicationGrant('owner', grantId)).toBe(true);
      const revokedGroup = await fetch(`${url(source)}/api/v4/ledger/group-health`, { headers: sourceAuth });
      expect(await revokedGroup.json()).toMatchObject({ state: 'VERIFYING', memberCount: 2,
        issues: expect.arrayContaining([expect.stringContaining('授权已撤销或过期')]) });
      const revoked = await fetch(`${url(peer)}/api/v4/ledger/readiness`, { headers: peerAuth });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ state: 'VERIFYING', linkedPeers: 1,
        verifiedPeers: 0 });
    } finally {
      await peerStore?.close();
      await sourceStore?.close();
      await peer.close();
      await source.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);

  it('holds READY until a current attachment claim and matching physical scan exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-readiness-http-'));
    const server = createTestSyncServer({ dataDir: root });
    let store: SyncServerStore | undefined;
    try {
      await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
      await registerAccount(url, 'owner', 'readiness-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      const session = await loginAccount(url, 'owner', 'readiness-password');
      const headers = { Authorization: `Bearer ${session.accessToken}` };
      expect((await fetch(`${url}/api/v4/ledger/readiness`)).status).toBe(401);
      const initialized = await fetch(`${url}/api/v3/protection/initialize`, { method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'managed' }) });
      expect(initialized.status).toBe(200);
      const ledgerId = (await initialized.json() as { replica: { ledgerId: string } }).replica.ledgerId;
      const before = await fetch(`${url}/api/v4/ledger/readiness`, { headers });
      expect(before.status).toBe(200);
      expect(await before.json()).toMatchObject({ state: 'VERIFYING', linkedPeers: 0 });

      store = new SyncServerStore(join(root, 'server.sqlite'), 'open', server.serverId);
      const upload = await store.beginAttachmentPromise('owner', 0);
      await store.completeAttachmentPromise('owner', upload.uploadId);
      const inventory = await store.replicaInventory('owner', ledgerId);
      await store.recordReplicaPhysicalStatus('owner', ledgerId, inventory.blobHash);
      const ready = await fetch(`${url}/api/v4/ledger/readiness`, { headers });
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ state: 'READY', issues: [], linkedPeers: 0,
        verifiedPeers: 0, commitCount: 0, promisedBlobCount: 0 });
      const db = new NodeSqliteDriver(join(root, 'server.sqlite'));
      try {
        await db.run('UPDATE sync_replicas SET head_seq = 1 WHERE username = ?', ['owner']);
      } finally { await db.close(); }
      const incomplete = await fetch(`${url}/api/v4/ledger/readiness`, { headers });
      expect(incomplete.status).toBe(200);
      expect(await incomplete.json()).toMatchObject({ state: 'VERIFYING',
        issues: expect.arrayContaining(['本地加密提交序号或账本归属不完整']) });
    } finally {
      await store?.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
