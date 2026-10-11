import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLedgerCryptoSession, encryptJson, sha256Json } from '@zichan/core';
import { loadNodeIdentity } from '../src/node-identity.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('three-node replica fault recovery', () => {
  it('accepts writes on both LAN replicas while the hub is offline and converges after recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-three-node-'));
    const hub = createTestSyncServer({ dataDir: join(root, 'hub') });
    const home = createTestSyncServer({ dataDir: join(root, 'home') });
    const office = createTestSyncServer({ dataDir: join(root, 'office') });
    const nodes = [hub, home, office];
    let stores: SyncServerStore[] = [];
    try {
      await Promise.all(nodes.map((node) => node.ready));
      stores = nodes.map((node) => new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId));
      await Promise.all(stores.map((store) => store.ready));
      await Promise.all(nodes.map((node) => new Promise<void>((resolve) => node.server.listen(0, '127.0.0.1', resolve))));
      await Promise.all(stores.map((store) => store.register('owner', 'opaque-owner', undefined, true)));
      const ledgerId = 'ledger-three-node-fault-0001';
      const session = createLedgerCryptoSession(ledgerId);
      const replicas = await Promise.all(stores.map((store) => store.bindReplica('owner', ledgerId)));
      const envelope = { ledgerId, keyringId: session.keyringId, generation: 1 };
      await Promise.all(stores.map((store) => store.putKeyEnvelope('owner', ledgerId, session.keyringId, 1, envelope)));
      const hubUrl = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
      const hubKey = loadNodeIdentity(hub.dataDir, hub.serverId).publicKey;
      for (const [index, node] of [[1, home], [2, office]] as const) {
        const grant = await stores[0]!.createNodeReplicationGrant('owner', node.serverId,
          loadNodeIdentity(node.dataDir, node.serverId).publicKey,
          new Date(Date.now() + 86_400_000).toISOString());
        await stores[index]!.createNodeReplicationLink({ username: 'owner', ledgerId,
          localStreamEpoch: replicas[index]!.streamEpoch, peerUrl: hubUrl, peerNodeId: hub.serverId,
          peerPublicKey: hubKey, peerReplicaId: replicas[0]!.replicaId,
          peerStreamEpoch: replicas[0]!.streamEpoch, grantId: grant.grantId });
      }
      const write = async (store: SyncServerStore, commitId: string) => {
        const commit = { protocol: 2, ledgerId, commitId, originDeviceId: commitId,
          createdAt: new Date().toISOString(), parentCommitIds: [], revisions: [] };
        const contentHash = await sha256Json(commit);
        const encCommit = await encryptJson(session, commit, { protocol: 2, ledgerId, commitId, contentHash });
        await store.pushCommits('owner', [{ commitId, ledgerId, contentHash, encCommit, keyEpoch: 0 }]);
      };
      await write(stores[0]!, 'hub-before-outage-0000001');
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      expect((await stores[1]!.listCommits('owner', 0, 10)).commits).toHaveLength(1);
      expect((await stores[2]!.listCommits('owner', 0, 10)).commits).toHaveLength(1);

      await new Promise<void>((resolve, reject) => hub.server.close((error) => error ? reject(error) : resolve()));
      await Promise.all([
        write(stores[1]!, 'home-during-outage-00001'),
        write(stores[2]!, 'office-during-outage-001'),
      ]);
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      expect((await stores[0]!.listCommits('owner', 0, 10)).commits).toHaveLength(1);
      await new Promise<void>((resolve) => hub.server.listen((new URL(hubUrl)).port, '127.0.0.1', resolve));

      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      const expected = ['home-during-outage-00001', 'hub-before-outage-0000001', 'office-during-outage-001'];
      for (const store of stores) {
        const commits = (await store.listCommits('owner', 0, 10)).commits;
        expect(commits.map((item) => item.commitId).sort()).toEqual(expected);
      }
      await Promise.all([home.flushNodeReplication(), office.flushNodeReplication()]);
      for (const store of stores) expect((await store.listCommits('owner', 0, 10)).commits).toHaveLength(3);
      const homeLink = (await stores[1]!.listNodeReplicationLinks('owner'))[0]!;
      expect(homeLink.pullSeq).toBeGreaterThan(0);
      expect(homeLink.pushSeq).toBeGreaterThan(0);
      await stores[1]!.rescanNodeReplicationLink('owner', homeLink.linkId);
      await home.flushNodeReplication();
      await home.flushNodeReplication();
      for (const store of stores) {
        expect((await store.listCommits('owner', 0, 10)).commits.map((item) => item.commitId).sort())
          .toEqual(expected);
      }
      expect((await stores[1]!.listNodeReplicationLinks('owner'))[0])
        .toMatchObject({ pullSeq: 3, pushSeq: 3, enabled: true, grantId: homeLink.grantId });
    } finally {
      await Promise.all(stores.map((store) => store.close()));
      await Promise.all(nodes.map((node) => node.close()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
