import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { CURRENT_SERVER_SCHEMA, requiredReplicaMigrationBytes, SyncServerStore } from '../src/store.js';

describe('stable account identity', () => {
  it('budgets for duplicated encrypted commits before a ledger slot migration', () => {
    expect(requiredReplicaMigrationBytes(0, 0)).toBe(0n);
    expect(requiredReplicaMigrationBytes(1024, 2)).toBe(64n * 1024n * 1024n + 4096n);
    expect(() => requiredReplicaMigrationBytes(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow('无法安全估算');
  });

  it('preserves account IDs, ownership and ledger binding across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-account-id-'));
    const file = join(dir, 'server.sqlite');
    const store = new SyncServerStore(file, 'open', 'server-stable');
    let next: SyncServerStore | undefined;
    try {
      await store.register('owner', 'opaque-record', undefined, true);
      await store.register('member', 'opaque-member-record');
      const first = await store.getUser('owner');
      expect(first?.accountId).toMatch(/^account-[a-f0-9]{32}$/);
      expect((await store.getUser('member'))?.accountId).not.toBe(first?.accountId);
      const session = await store.createSession({ id: 'session-before-binding', username: 'owner',
        deviceId: 'device-before-binding', deviceName: 'First browser', refreshHash: 'hash',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect(session.replicaId).toBeUndefined();
      const replica = await store.bindReplica('owner', 'ledger-0000000001');
      expect((await store.getSession(session.id))?.replicaId).toBe(replica.replicaId);
      await store.close();
      next = new SyncServerStore(file, 'closed', 'server-stable');
      expect(await next.getUser('OWNER')).toMatchObject({ accountId: first!.accountId, opaqueRegistrationRecord: 'opaque-record' });
      expect(await next.roleForUser('owner')).toBe('owner');
      expect(await next.getReplica('owner')).toMatchObject({ ledgerId: 'ledger-0000000001' });
    } finally {
      await (next ?? store).close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades schema 15 with an account ledger index and session slot without changing ciphertext', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-account-ledger-upgrade-'));
    const file = join(dir, 'server.sqlite');
    const serverId = 'server-ledger-index';
    const ledgerId = 'ledger-index-upgrade-0001';
    const seed = new SyncServerStore(file, 'open', serverId);
    let next: SyncServerStore | undefined;
    try {
      await seed.register('owner', 'opaque-owner', undefined, true);
      const replica = await seed.bindReplica('owner', ledgerId);
      await seed.pushCommits('owner', [{ commitId: 'commit-index-upgrade-001', ledgerId,
        contentHash: 'd'.repeat(64), encCommit: { v: 3, keyId: 'key-index-upgrade-001', iv: 'iv', ct: 'cipher' } }]);
      const original = await seed.createSession({ id: 'session-index-upgrade', username: 'owner',
        deviceId: 'device-index-upgrade', deviceName: 'Existing browser', refreshHash: 'hash',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect(original.replicaId).toBe(replica.replicaId);
      await seed.close();
      const sql = new NodeSqliteDriver(file);
      try {
        await sql.exec('DROP TABLE account_ledger_index; ALTER TABLE sync_sessions DROP COLUMN replica_id;');
        await sql.run('UPDATE server_schema_migrations SET version = 15, name = ?', ['commit_epoch_v15']);
      } finally { await sql.close(); }
      next = new SyncServerStore(file, 'closed', serverId);
      expect((await next.verify()).schemaVersion).toBe(CURRENT_SERVER_SCHEMA);
      expect(await next.listAccountLedgers('owner')).toEqual([
        { ledgerId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch },
      ]);
      expect(await next.getReplica('owner', replica.replicaId)).toMatchObject({ ledgerId });
      expect(await next.getReplica('owner', 'rep-wrong-ledger')).toBeUndefined();
      expect(await next.getReplicaForLedger('owner', ledgerId)).toMatchObject({ replicaId: replica.replicaId });
      expect(await next.getReplicaForLedger('owner', 'ledger-other-0001')).toBeUndefined();
      expect((await next.getSession(original.id))?.replicaId).toBe(replica.replicaId);
      expect((await next.listCommits('owner', 0, 10)).commits.map((item) => item.commitId))
        .toEqual(['commit-index-upgrade-001']);
      expect((await next.listCommits('owner', 0, 10, 'account', replica.replicaId)).commits.map((item) => item.commitId))
        .toEqual(['commit-index-upgrade-001']);
      await expect(next.listCommits('owner', 0, 10, 'account', 'rep-wrong-ledger'))
        .rejects.toMatchObject({ code: 'REPLICA_UNBOUND' });
      expect(await next.commitUsage('owner', replica.replicaId)).toMatchObject({ commitCount: 1 });
      await expect(next.commitUsage('owner', 'rep-wrong-ledger'))
        .rejects.toMatchObject({ code: 'REPLICA_UNBOUND' });
      await expect(next.listBackupArchives('owner', ledgerId, 10, 'rep-wrong-ledger'))
        .rejects.toMatchObject({ code: 'LEDGER_MISMATCH' });
    } finally {
      await (next ?? seed).close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backfills independent replica slots from schema 12 without merging accounts that share a ledger ID', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-slot-upgrade-'));
    const file = join(dir, 'server.sqlite');
    const seed = new SyncServerStore(file, 'open', 'server-slot-upgrade');
    let seedClosed = false;
    let next: SyncServerStore | undefined;
    try {
      await seed.register('alice', 'opaque-alice', undefined, true);
      await seed.register('bob', 'opaque-bob');
      const ledgerId = 'ledger-shared-legacy-0001';
      const alice = await seed.bindReplica('alice', ledgerId);
      const bob = await seed.bindReplica('bob', ledgerId);
      expect(alice.replicaId).not.toBe(bob.replicaId);
      const commit = (commitId: string) => ({ commitId, ledgerId, contentHash: 'a'.repeat(64),
        encCommit: { v: 3, keyId: 'test-key-id-0000001', iv: 'test-iv', ct: 'test-ciphertext' } });
      await seed.pushCommits('alice', [commit('alice-commit-0000001')]);
      await seed.pushCommits('bob', [commit('bob-commit-00000001')]);
      await seed.pushCommits('alice', [], ['asset-cost-v2'], ['asset-cost-v2']);
      await seed.putKeyEnvelope('alice', ledgerId, 'keyring-legacy', 1,
        { ledgerId, keyringId: 'keyring-legacy', generation: 1, marker: 'alice' });
      await seed.putKeyEnvelope('bob', ledgerId, 'keyring-legacy', 1,
        { ledgerId, keyringId: 'keyring-legacy', generation: 1, marker: 'bob' });
      await seed.close();
      seedClosed = true;

      const legacy = new NodeSqliteDriver(file);
      try {
        // Reconstruct a schema 12 fixture: that version kept commits only in
        // the account partition, while current writes use the replica slot.
        await legacy.exec(`DROP TRIGGER IF EXISTS sync_server_commits_slot_insert;
          DROP TRIGGER IF EXISTS sync_server_commits_slot_update;
          DROP TRIGGER IF EXISTS sync_server_commits_slot_delete;`);
        await legacy.run(`INSERT INTO sync_server_commits
          (username, seq, commit_id, ledger_id, content_hash, enc_commit_json,
            key_epoch, writer_issuer_node_id, writer_account_id, cipher_bytes, created_at)
          SELECT owner.username, commit_row.seq, commit_row.commit_id, commit_row.ledger_id,
            commit_row.content_hash, commit_row.enc_commit_json, commit_row.key_epoch,
            commit_row.writer_issuer_node_id, commit_row.writer_account_id,
            commit_row.cipher_bytes, commit_row.created_at
          FROM ledger_replica_commits commit_row JOIN sync_replicas owner
            ON owner.replica_id = commit_row.replica_id`);
        await legacy.exec(`DROP TRIGGER IF EXISTS sync_ledger_requirements_slot_insert;
          DROP TRIGGER IF EXISTS sync_ledger_requirements_slot_update;
          DROP TRIGGER IF EXISTS sync_ledger_requirements_slot_delete;`);
        await legacy.run(`INSERT INTO sync_ledger_requirements (username, ledger_id, capability)
          SELECT owner.username, owner.ledger_id, requirement.capability
          FROM ledger_replica_requirements requirement JOIN sync_replicas owner
            ON owner.replica_id = requirement.replica_id`);
        await legacy.exec(`DROP TRIGGER IF EXISTS sync_key_envelopes_slot_insert;
          DROP TRIGGER IF EXISTS sync_key_envelopes_slot_update;
          DROP TRIGGER IF EXISTS sync_key_envelopes_slot_delete;`);
        await legacy.run(`INSERT INTO sync_key_envelopes
          (username, ledger_id, keyring_id, generation, envelope_json, updated_at)
          SELECT owner.username, envelope.ledger_id, envelope.keyring_id,
            envelope.generation, envelope.envelope_json, envelope.updated_at
          FROM ledger_replica_key_envelopes envelope JOIN sync_replicas owner
            ON owner.replica_id = envelope.replica_id`);
        await legacy.exec(`DROP TRIGGER sync_replicas_slot_insert;
          DROP TRIGGER sync_replicas_slot_update;
          DROP TRIGGER sync_replicas_slot_delete;
          DROP TABLE ledger_replica_commits;
          DROP TABLE ledger_replica_key_envelopes;
          DROP TABLE ledger_replica_requirements;
          DROP TABLE ledger_account_routes;
          DROP TABLE ledger_replica_slots;`);
        await legacy.run('UPDATE server_schema_migrations SET version = 12, name = ?', ['server_asset_cost_capabilities_v12']);
      } finally { await legacy.close(); }

      next = new SyncServerStore(file, 'closed', 'server-slot-upgrade');
      await next.ready;
      expect((await next.verify()).schemaVersion).toBe(CURRENT_SERVER_SCHEMA);
      expect(await next.getReplica('alice')).toMatchObject({ replicaId: alice.replicaId, ledgerId, headSeq: 1 });
      expect(await next.getReplica('bob')).toMatchObject({ replicaId: bob.replicaId, ledgerId, headSeq: 1 });
      expect((await next.listCommits('alice', 0, 10)).commits.map((row) => row.commitId)).toEqual(['alice-commit-0000001']);
      expect((await next.listCommits('bob', 0, 10)).commits.map((row) => row.commitId)).toEqual(['bob-commit-00000001']);
      expect(await next.getKeyEnvelope('alice', ledgerId)).toMatchObject({ marker: 'alice' });
      expect(await next.getKeyEnvelope('bob', ledgerId)).toMatchObject({ marker: 'bob' });
      expect(await next.listLedgerRequirements('alice', ledgerId)).toEqual(['asset-cost-v2']);
      expect(await next.listLedgerRequirements('bob', ledgerId)).toEqual([]);
      await next.pushCommits('alice', [commit('alice-commit-0000002')], ['asset-cost-v2']);
      const reader = new NodeSqliteDriver(file);
      try {
        const slots = await reader.all<{ replica_id: string; ledger_id: string; head_seq: number }>(
          'SELECT replica_id, ledger_id, head_seq FROM ledger_replica_slots ORDER BY replica_id');
        expect(slots).toHaveLength(2);
        expect(slots).toEqual(expect.arrayContaining([
          { replica_id: alice.replicaId, ledger_id: ledgerId, head_seq: 2 },
          { replica_id: bob.replicaId, ledger_id: ledgerId, head_seq: 1 },
        ]));
        const commits = await reader.all<{ replica_id: string; commit_id: string }>(
          'SELECT replica_id, commit_id FROM ledger_replica_commits ORDER BY replica_id, seq');
        expect(commits).toEqual(expect.arrayContaining([
          { replica_id: alice.replicaId, commit_id: 'alice-commit-0000001' },
          { replica_id: alice.replicaId, commit_id: 'alice-commit-0000002' },
          { replica_id: bob.replicaId, commit_id: 'bob-commit-00000001' },
        ]));
        expect((await reader.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM sync_server_commits WHERE username = ?', ['alice']))?.count).toBe(1);
        const envelopes = await reader.all<{ replica_id: string; envelope_json: string }>(
          'SELECT replica_id, envelope_json FROM ledger_replica_key_envelopes ORDER BY replica_id');
        expect(envelopes).toHaveLength(2);
        expect(envelopes.map((row) => ({ replicaId: row.replica_id, marker: JSON.parse(row.envelope_json).marker })))
          .toEqual(expect.arrayContaining([
            { replicaId: alice.replicaId, marker: 'alice' },
            { replicaId: bob.replicaId, marker: 'bob' },
          ]));
        expect(await reader.all<{ replica_id: string; capability: string }>(
          'SELECT replica_id, capability FROM ledger_replica_requirements')).toEqual([
          { replica_id: alice.replicaId, capability: 'asset-cost-v2' },
        ]);
      } finally { await reader.close(); }
    } finally {
      await next?.close();
      if (!seedClosed) await seed.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([6, 7, 8, 9, 10, 11])('upgrades schema %i without resetting credentials, identity, policy or records', async (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-account-upgrade-'));
    const file = join(dir, 'server.sqlite');
    const previous = new NodeSqliteDriver(file);
    let next: SyncServerStore | undefined;
    try {
      await previous.exec(`
        CREATE TABLE server_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
        INSERT INTO server_schema_migrations VALUES (${version}, '${version === 6 ? 'server_account_owner_v6' : version === 7 ? 'server_account_identity_v7' : version === 8 ? 'server_management_v8' : version === 9 ? 'server_password_recovery_v9' : version === 10 ? 'server_key_custody_v10' : 'server_management_ops_v11'}', '2026-01-01');
        CREATE TABLE sync_users (username TEXT PRIMARY KEY COLLATE NOCASE, opaque_registration_record TEXT NOT NULL,
          disabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT);
        INSERT INTO sync_users VALUES ('existing', 'preserved-opaque-record', 0, '2026-01-01', '2026-01-01', NULL);
        CREATE TABLE server_ownership (singleton INTEGER PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO server_ownership VALUES (1, 'existing', '2026-01-01');
        CREATE TABLE server_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO server_meta VALUES ('registration_mode', 'open', '2026-01-01');
        ${version >= 7 ? `CREATE TABLE sync_account_identities (username TEXT PRIMARY KEY COLLATE NOCASE, account_id TEXT NOT NULL UNIQUE);
        INSERT INTO sync_account_identities VALUES ('existing', 'account-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');` : ''}
        CREATE TABLE protected_fixture (ciphertext TEXT);
        INSERT INTO protected_fixture VALUES ('original-encrypted-ledger');
      `);
      await previous.close();
      next = new SyncServerStore(file, 'closed', 'server-upgrade');
      const user = await next.getUser('existing');
      expect(user?.accountId).toMatch(/^account-[a-f0-9]{32}$/);
      if (version >= 7) expect(user?.accountId).toBe('account-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(user?.opaqueRegistrationRecord).toBe('preserved-opaque-record');
      expect(user?.displayName).toBe('existing');
      expect(await next.ownerUsername()).toBe('existing');
      expect(await next.roleForUser('existing')).toBe('owner');
      expect(await next.registrationMode()).toBe('open');
      expect((await next.verify()).schemaVersion).toBe(CURRENT_SERVER_SCHEMA);
      const reader = new NodeSqliteDriver(file);
      try {
        expect(await reader.get('SELECT ciphertext FROM protected_fixture')).toEqual({ ciphertext: 'original-encrypted-ledger' });
      } finally {
        await reader.close();
      }
    } finally {
      await (next ?? previous).close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
