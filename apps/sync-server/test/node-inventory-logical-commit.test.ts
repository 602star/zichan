import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedgerCryptoSession, encryptJson, sha256Json } from '@zichan/core';
import { describe, expect, it } from 'vitest';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('node replica commit inventory', () => {
  it('compares logical commits when clients independently encrypt the same commit for two nodes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-inventory-commit-'));
    const nodes = [createTestSyncServer({ dataDir: join(root, 'first') }),
      createTestSyncServer({ dataDir: join(root, 'second') }),
      createTestSyncServer({ dataDir: join(root, 'different') })];
    let stores: SyncServerStore[] = [];
    try {
      await Promise.all(nodes.map((node) => node.ready));
      stores = nodes.map((node) => new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId));
      const ledgerId = 'ledger-inventory-logical-0001';
      const session = createLedgerCryptoSession(ledgerId);
      for (const store of stores) {
        await store.register('owner', 'opaque-owner', undefined, true);
        await store.bindReplica('owner', ledgerId);
        await store.putKeyEnvelope('owner', ledgerId, session.keyringId, 1,
          { ledgerId, keyringId: session.keyringId, generation: 1 });
      }
      const commitId = 'logical-inventory-commit-0001';
      const commit = { protocol: 2, ledgerId, commitId, originDeviceId: 'device-inventory-01',
        createdAt: '2026-01-01T00:00:00.000Z', parentCommitIds: [], revisions: [] };
      const contentHash = await sha256Json(commit);
      const aad = { protocol: 2, ledgerId, commitId, contentHash };
      const firstCiphertext = await encryptJson(session, commit, aad);
      const secondCiphertext = await encryptJson(session, commit, aad);
      expect(firstCiphertext).not.toEqual(secondCiphertext);
      await stores[0]!.pushCommits('owner', [{ commitId, ledgerId, contentHash,
        encCommit: firstCiphertext }]);
      await stores[1]!.pushCommits('owner', [{ commitId, ledgerId, contentHash,
        encCommit: secondCiphertext }]);

      const first = await stores[0]!.replicaInventory('owner', ledgerId);
      const second = await stores[1]!.replicaInventory('owner', ledgerId);
      expect(first.commitCount).toBe(1);
      expect(second.commitCount).toBe(1);
      expect(first.commitHash).toBe(second.commitHash);

      const changedCommit = { ...commit, originDeviceId: 'different-device-01' };
      const changedHash = await sha256Json(changedCommit);
      await stores[2]!.pushCommits('owner', [{ commitId, ledgerId, contentHash: changedHash,
        encCommit: await encryptJson(session, changedCommit, { ...aad, contentHash: changedHash }) }]);
      const different = await stores[2]!.replicaInventory('owner', ledgerId);
      expect(different.commitCount).toBe(first.commitCount);
      expect(different.commitHash).not.toBe(first.commitHash);
    } finally {
      await Promise.all(stores.map((store) => store.close()));
      await Promise.all(nodes.map((node) => node.close()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
