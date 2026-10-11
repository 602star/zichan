import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLedgerCryptoSession, encryptJson, sha256Json } from '@zichan/core';
import { NodeSqliteDriver } from '@zichan/db/node';
import { restoreServerBackup, verifyServerBackup } from '../src/backup.js';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { retireLegacyShadowPayload } from '../src/retire-legacy-shadow.js';
import { SyncServerStore } from '../src/store.js';

describe('verified legacy shadow retirement', () => {
  it('clears verified duplicate payloads, preserves canonical reads and restores the full backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-retire-shadow-'));
    const dataDir = join(root, 'data');
    const file = join(dataDir, 'server.sqlite');
    const backupPath = join(root, 'backup-before-retirement');
    const restoredDir = join(root, 'restored');
    mkdirSync(dataDir);
    const serverId = 'srv-retire-shadow';
    for (const [name, value] of [['server-id', serverId], ['server.secret', 'a'.repeat(64)],
      ['opaque.server-setup', 'b'.repeat(64)]]) writeFileSync(join(dataDir, name!), value!);
    const blob = new EncryptedBlobStore({ dataDir });
    let blobOpen = true;
    let store = new SyncServerStore(file, 'open', serverId, undefined, blob.ready);
    let storeOpen = true;
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      const ledgerId = 'ledger-retire-shadow';
      const replica = await store.bindReplica('owner', ledgerId);
      const session = createLedgerCryptoSession(ledgerId);
      const envelope = { ledgerId, keyringId: session.keyringId, generation: 1 };
      await store.putKeyEnvelope('owner', ledgerId, session.keyringId, 1, envelope);
      const commitId = 'commit-retire-shadow-0001';
      const commit = { protocol: 2, ledgerId, commitId, originDeviceId: 'device-retire-shadow',
        createdAt: new Date().toISOString(), parentCommitIds: [], revisions: [] };
      const contentHash = await sha256Json(commit);
      await store.pushCommits('owner', [{ commitId, ledgerId, contentHash,
        encCommit: await encryptJson(session, commit, { protocol: 2, ledgerId, commitId, contentHash }) }]);
      await store.createSession({ id: 'session-retire-shadow', username: 'owner',
        deviceId: 'device-retire-shadow', deviceName: 'test', refreshHash: 'hash',
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
      await store.close();
      storeOpen = false;
      await blob.close();
      blobOpen = false;
      const db = new NodeSqliteDriver(file);
      try {
        const row = await db.get<Record<string, unknown>>(
          'SELECT * FROM ledger_replica_commits WHERE replica_id = ?', [replica.replicaId]);
        expect(row).toBeDefined();
        await db.run(`INSERT INTO sync_server_commits
          (username, seq, commit_id, ledger_id, content_hash, enc_commit_json,
            key_epoch, writer_issuer_node_id, writer_account_id, cipher_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['owner', row!['seq'] as number, row!['commit_id'] as string, ledgerId,
          row!['content_hash'] as string, row!['enc_commit_json'] as string,
          row!['key_epoch'] as number, row!['writer_issuer_node_id'] as string | null,
          row!['writer_account_id'] as string | null, row!['cipher_bytes'] as number,
          row!['created_at'] as string]);
        await db.run(`INSERT INTO sync_key_envelopes
          (username, ledger_id, keyring_id, generation, envelope_json, updated_at)
          SELECT 'owner', ledger_id, keyring_id, generation, envelope_json, updated_at
          FROM ledger_replica_key_envelopes WHERE replica_id = ?`, [replica.replicaId]);
        await db.run(`INSERT INTO sync_ledger_requirements (username, ledger_id, capability)
          VALUES ('owner', ?, 'test-capability')`, [ledgerId]);
        const at = new Date().toISOString();
        await db.run(`INSERT INTO ledger_backup_archives
          (username, replica_id, ledger_id, archive_id, blob_id, created_at,
            reason, kind, label, size_bytes)
          VALUES ('owner', ?, ?, 'archive-retire-shadow', ?, ?,
            'manual', 'manual', 'encrypted copy', 42)`, [replica.replicaId, ledgerId, 'c'.repeat(64), at]);
        await db.run(`INSERT INTO sync_backup_archives
          (username, ledger_id, archive_id, blob_id, created_at,
            reason, kind, label, size_bytes)
          VALUES ('owner', ?, 'archive-retire-shadow', ?, ?,
            'manual', 'manual', 'encrypted copy', 42)`, [ledgerId, 'c'.repeat(64), at]);
      } finally { await db.close(); }
      const result = await retireLegacyShadowPayload(dataDir, backupPath, { vacuum: true });
      expect(result.removed).toEqual({ commits: 1, keyEnvelopes: 1, requirements: 1, archives: 1 });
      expect(result.commitCipherBytes).toBeGreaterThan(0);
      expect(result.vacuumed).toBe(true);
      expect((await verifyServerBackup(backupPath)).ok).toBe(true);
      store = new SyncServerStore(file, 'open', serverId);
      storeOpen = true;
      await store.ready;
      expect((await store.replicaInventory('owner', ledgerId)).commitCount).toBe(1);
      expect(await store.listLedgerRequirements('owner', ledgerId)).toContain('test-capability');
      expect(await store.getKeyEnvelope('owner', ledgerId)).toEqual(envelope);
      const before = (await store.getReplica('owner'))!;
      const nextEnvelope = { ledgerId: 'ledger-retire-shadow-next',
        keyringId: 'keyring-retire-shadow-next', generation: 1 };
      const next = await store.replaceReplica('owner', 'session-retire-shadow',
        { ledgerId, streamEpoch: before.streamEpoch }, nextEnvelope, []);
      const checkpoint = (await store.listReplacementCheckpoints('owner'))[0]!;
      await store.restoreReplacementCheckpoint('owner', 'session-retire-shadow',
        { ledgerId: next.ledgerId, streamEpoch: next.streamEpoch }, checkpoint.checkpointId);
      expect((await store.listCommits('owner', 0, 10)).commits.map((entry) => entry.commitId))
        .toEqual([commitId]);
      await store.close();
      storeOpen = false;
      const after = new NodeSqliteDriver(file);
      try {
        for (const table of ['sync_server_commits', 'sync_key_envelopes',
          'sync_ledger_requirements', 'sync_backup_archives']) {
          expect(await after.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]))
            .toBeUndefined();
        }
        expect((await after.get<{ version: number }>(
          'SELECT version FROM server_schema_migrations'))?.version).toBe(25);
        await after.exec(`CREATE TABLE sync_ledger_requirements (
          username TEXT NOT NULL, ledger_id TEXT NOT NULL, capability TEXT NOT NULL,
          PRIMARY KEY (username, ledger_id, capability));`);
        await after.run(`INSERT INTO sync_ledger_requirements (username, ledger_id, capability)
          VALUES (?, ?, ?)`, ['owner', ledgerId, 'unexpected-legacy-row']);
      } finally { await after.close(); }
      const guardedRestart = new SyncServerStore(file, 'open', serverId);
      await expect(guardedRestart.ready).rejects.toThrow('已退役的旧影子表 sync_ledger_requirements 含有数据');
      await guardedRestart.close();
      await restoreServerBackup(backupPath, restoredDir);
      const rollback = new NodeSqliteDriver(join(restoredDir, 'server.sqlite'));
      try {
        expect((await rollback.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM sync_server_commits'))?.count).toBe(1);
        await rollback.run('UPDATE sync_server_commits SET content_hash = ? WHERE username = ?',
          ['d'.repeat(64), 'owner']);
      } finally { await rollback.close(); }
      const rejectedBackup = join(root, 'backup-before-refusal');
      await expect(retireLegacyShadowPayload(restoredDir, rejectedBackup))
        .rejects.toThrow('旧影子数据与副本权威表不一致');
      expect((await verifyServerBackup(rejectedBackup)).ok).toBe(true);
      const stillPresent = new NodeSqliteDriver(join(restoredDir, 'server.sqlite'));
      try {
        expect((await stillPresent.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM sync_server_commits'))?.count).toBe(1);
      } finally { await stillPresent.close(); }
    } finally {
      if (storeOpen) await store.close();
      if (blobOpen) await blob.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
