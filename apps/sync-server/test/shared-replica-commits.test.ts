import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { SyncServerStore } from '../src/store.js';

describe('shared replica commit slot', () => {
  it('scopes node reads and writes to a secondary ledger instead of the account default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-secondary-node-scope-'));
    const file = join(dir, 'server.sqlite');
    const store = new SyncServerStore(file, 'open', 'server-secondary-scope');
    const blobStore = new EncryptedBlobStore({ dataDir: dir });
    try {
      await Promise.all([store.ready, blobStore.ready]);
      await store.register('alice', 'opaque-alice', undefined, true);
      await store.register('bob', 'opaque-bob');
      const personalId = 'ledger-personal-scope-0001';
      const sharedId = 'ledger-shared-scope-0001';
      const personal = await store.bindReplica('alice', personalId);
      const shared = await store.bindReplica('bob', sharedId);
      await store.putKeyEnvelope('alice', personalId, 'keyring-personal-scope', 1,
        { ledgerId: personalId, keyringId: 'keyring-personal-scope', generation: 1 });
      await store.putKeyEnvelope('bob', sharedId, 'keyring-shared-scope', 1,
        { ledgerId: sharedId, keyringId: 'keyring-shared-scope', generation: 1 });
      const sql = new NodeSqliteDriver(file);
      try {
        await sql.run('INSERT INTO account_ledger_index (username, replica_id, created_at) VALUES (?, ?, ?)',
          ['alice', shared.replicaId, new Date().toISOString()]);
      } finally { await sql.close(); }
      expect((await store.getReplica('alice'))?.replicaId).toBe(personal.replicaId);
      expect((await store.getReplicaForLedger('alice', sharedId))?.replicaId).toBe(shared.replicaId);
      const commit = { commitId: 'commit-secondary-scope-0001', ledgerId: sharedId, keyEpoch: 0,
        contentHash: 'b'.repeat(64), encCommit: { v: 3, keyId: 'keyring-shared-scope', iv: 'iv', ct: 'ciphertext' } };
      await store.pushCommits('alice', [commit], [], [], 'node', shared.replicaId);
      expect((await store.listCommits('alice', 0, 10, 'node', shared.replicaId)).commits)
        .toMatchObject([{ commitId: commit.commitId, ledgerId: sharedId }]);
      expect((await store.listCommits('alice', 0, 10)).commits).toEqual([]);
      expect(await store.replicaInventory('alice', sharedId)).toMatchObject({
        replicaId: shared.replicaId, commitCount: 1,
      });
      expect(await store.replicaInventory('alice', personalId)).toMatchObject({
        replicaId: personal.replicaId, commitCount: 0,
      });
    } finally {
      await store.close();
      await blobStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps canonical commits when a historical account shadow is changed or removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-commit-shadow-'));
    const file = join(dir, 'server.sqlite');
    let store = new SyncServerStore(file, 'open', 'server-commit-shadow');
    try {
      await store.register('alice', 'opaque-alice', undefined, true);
      const ledgerId = 'ledger-commit-shadow';
      await store.bindReplica('alice', ledgerId);
      const oldCiphertext = JSON.stringify({ v: 3, keyId: 'keyring-commit-shadow', iv: 'iv', ct: 'old' });
      const sql = new NodeSqliteDriver(file);
      try {
        await sql.run(`INSERT INTO sync_server_commits
          (username, seq, commit_id, ledger_id, content_hash, enc_commit_json, cipher_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['alice', 1, 'commit-shadow-old-0001', ledgerId, 'a'.repeat(64), oldCiphertext,
          Buffer.byteLength(oldCiphertext), new Date().toISOString()]);
        await sql.run('UPDATE sync_replicas SET head_seq = 1 WHERE username = ?', ['alice']);
        await sql.run('UPDATE sync_server_commits SET enc_commit_json = ? WHERE username = ?',
          [JSON.stringify({ v: 3, keyId: 'keyring-commit-shadow', iv: 'iv', ct: 'tampered' }), 'alice']);
        expect((await sql.get<{ enc_commit_json: string }>(`SELECT enc_commit_json FROM ledger_replica_commits
          WHERE seq = 1`))?.enc_commit_json).toBe(oldCiphertext);
        await sql.run('DELETE FROM sync_server_commits WHERE username = ?', ['alice']);
      } finally { await sql.close(); }
      expect((await store.listCommits('alice', 0, 10)).commits.map((row) => row.commitId))
        .toEqual(['commit-shadow-old-0001']);
      await store.pushCommits('alice', [{ commitId: 'commit-shadow-new-0002', ledgerId,
        contentHash: 'b'.repeat(64), encCommit: { v: 3, keyId: 'keyring-commit-shadow', iv: 'iv', ct: 'new' } }]);
      await store.close();
      store = new SyncServerStore(file, 'closed', 'server-commit-shadow');
      expect((await store.listCommits('alice', 0, 10)).commits.map((row) => row.commitId))
        .toEqual(['commit-shadow-old-0001', 'commit-shadow-new-0002']);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives routed members one sequence, deduplicates across accounts, and charges the slot owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-shared-commits-'));
    const file = join(dir, 'server.sqlite');
    const store = new SyncServerStore(file, 'open', 'server-shared-commits');
    let reopened: SyncServerStore | undefined;
    try {
      await store.register('nodeowner', 'opaque-owner', undefined, true);
      await store.register('alice', 'opaque-alice');
      await store.register('bob', 'opaque-bob');
      await store.register('charlie', 'opaque-charlie');
      const ledgerId = 'ledger-shared-commits-0001';
      const replica = await store.bindReplica('alice', ledgerId);
      await store.bindReplica('charlie', ledgerId);
      const sql = new NodeSqliteDriver(file);
      try {
        // A trusted membership flow will create this route. No public route API exists yet.
        await sql.run('INSERT INTO ledger_account_routes (username, replica_id, created_at) VALUES (?, ?, ?)',
          ['bob', replica.replicaId, new Date().toISOString()]);
      } finally { await sql.close(); }
      expect(await store.bindReplica('bob', ledgerId)).toMatchObject({ replicaId: replica.replicaId });
      expect(await store.listReplicaSlots()).toEqual([
        { username: 'alice', ledgerId }, { username: 'charlie', ledgerId },
      ]);
      await expect(store.bindReplica('bob', 'ledger-other-0001')).rejects.toMatchObject({ code: 'LEDGER_MISMATCH' });
      const commit = (commitId: string) => ({ commitId, ledgerId, contentHash: 'a'.repeat(64),
        encCommit: { v: 3, keyId: 'test-key-id-0000001', iv: 'test-iv', ct: 'test-ciphertext' } });
      await store.setCommitQuota('alice', 180);
      expect((await store.pushCommits('alice', [commit('alice-commit-0000001')])).assigned[0]?.seq).toBe(1);
      expect((await store.pushCommits('bob', [commit('bob-commit-00000001')])).assigned[0]?.seq).toBe(2);
      expect((await store.pushCommits('alice', [commit('bob-commit-00000001')])).assigned[0]?.seq).toBe(2);
      expect((await store.listCommits('alice', 0, 10)).commits.map((row) => row.commitId))
        .toEqual(['alice-commit-0000001', 'bob-commit-00000001']);
      expect((await store.listCommits('bob', 0, 10)).commits.map((row) => row.commitId))
        .toEqual(['alice-commit-0000001', 'bob-commit-00000001']);
      expect(await store.getReplica('alice')).toMatchObject({ headSeq: 2 });
      expect(await store.getReplica('bob')).toMatchObject({ headSeq: 2 });
      expect(await store.commitUsage('bob')).toMatchObject({ commitCount: 2, quotaBytes: 180 });
      expect((await store.status()).commitCount).toBe(2);
      const alice = (await store.getUser('alice'))!;
      expect((await store.accountDetail(alice.accountId))?.['capacity']).toMatchObject({
        commitCount: 2, headSeq: 2,
      });
      const accountRows = (await store.listUsers()).users;
      const aliceRow = accountRows.find((row) => row['username'] === 'alice');
      const bobRow = accountRows.find((row) => row['username'] === 'bob');
      expect(aliceRow?.['commitBytes']).toBe((await store.commitUsage('alice')).usedBytes);
      expect(bobRow?.['commitBytes']).toBe(0);
      expect(await store.capacityWarnings(0.5)).toEqual(expect.arrayContaining([
        expect.objectContaining({ username: 'alice', scope: 'commit' }),
      ]));
      await expect(store.pushCommits('bob', [commit('bob-commit-00000002')]))
        .rejects.toMatchObject({ code: 'COMMIT_QUOTA_EXCEEDED' });
      await store.setCommitQuota('alice', 300);
      expect((await store.pushCommits('alice', [commit('alice-commit-0000002')])).assigned[0]?.seq).toBe(3);
      await store.pushCommits('bob', [], ['asset-cost-v2'], ['asset-cost-v2']);
      expect(await store.listLedgerRequirements('alice', ledgerId)).toEqual(['asset-cost-v2']);
      await expect(store.pushCommits('alice', [])).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
      await store.close();
      reopened = new SyncServerStore(file, 'closed', 'server-shared-commits');
      expect((await reopened.listCommits('bob', 0, 10)).commits).toHaveLength(3);
      expect(await reopened.getReplica('alice')).toMatchObject({ headSeq: 3 });
    } finally {
      await (reopened ?? store).close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
