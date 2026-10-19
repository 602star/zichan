import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { createServerBackup } from '../src/backup.js';
import { assertNoPendingLocalReplicaRetirement, inspectLocalReplicaRetirement,
  LOCAL_REPLICA_RETIREMENT_MARKER, retireLocalReplica } from '../src/retire-local-replica.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('one ledger replica retirement on a multi-ledger node', () => {
  it('keeps startup blocked while a verified retirement marker is pending, then resumes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-retire-resume-'));
    const dataDir = join(root, 'node');
    const server = createTestSyncServer({ dataDir });
    let serverClosed = false;
    try {
      await server.ready;
      await server.close();
      serverClosed = true;
      const store = new SyncServerStore(join(dataDir, 'server.sqlite'), 'open', server.serverId);
      let replicaId = '';
      const ledgerId = 'ledger-retire-resume';
      try {
        await store.register('owner', 'opaque-owner', undefined, true);
        replicaId = (await store.bindReplica('owner', ledgerId)).replicaId;
        await store.register('other', 'opaque-other');
        await store.bindReplica('other', 'ledger-retire-resume-other');
      } finally { await store.close(); }
      const foreignNamespace = 'd'.repeat(64);
      const catalog = new NodeSqliteDriver(join(dataDir, 'server.sqlite'));
      try {
        await catalog.run(`INSERT INTO blob_objects
          (username, ledger_id, replica_id, blob_id, namespace, state, cipher_bytes,
            chunk_count, manifest_json, created_at, updated_at)
          VALUES (?, ?, (SELECT replica_id FROM sync_replicas WHERE username = ?), ?, ?,
            'available', 32, 1, '{}', ?, ?)`,
        ['other', 'ledger-retire-resume-other', 'other', 'e'.repeat(64), foreignNamespace,
          new Date().toISOString(), new Date().toISOString()]);
      } finally { await catalog.close(); }
      const inspection = await inspectLocalReplicaRetirement(dataDir, replicaId);
      expect(inspection.issues).toEqual([]);
      const backup = join(root, 'retirement-backup');
      await createServerBackup(dataDir, backup);
      writeFileSync(join(dataDir, LOCAL_REPLICA_RETIREMENT_MARKER), JSON.stringify({ version: 1,
        serverId: server.serverId, replicaId, ledgerId, backupPath: backup,
        otherLedgerIds: inspection.otherLedgerIds, objectCount: inspection.objectCount,
        uploadCount: inspection.uploadCount,
        namespaces: [...inspection.namespaces, foreignNamespace] }));
      expect(() => assertNoPendingLocalReplicaRetirement(dataDir)).toThrow(/未完成的单副本清理/);
      expect(() => createTestSyncServer({ dataDir })).toThrow(/未完成的单副本清理/);
      await expect(retireLocalReplica(dataDir, replicaId, backup, server.serverId,
        'ledger-other')).rejects.toThrow(/已有不同/);
      await expect(retireLocalReplica(dataDir, replicaId, backup, server.serverId,
        ledgerId)).rejects.toThrow(/已被其他账本引用/);
      writeFileSync(join(dataDir, LOCAL_REPLICA_RETIREMENT_MARKER), JSON.stringify({ version: 1,
        serverId: server.serverId, replicaId, ledgerId, backupPath: backup,
        otherLedgerIds: inspection.otherLedgerIds, objectCount: inspection.objectCount,
        uploadCount: inspection.uploadCount,
        namespaces: inspection.namespaces }));
      const completed = await retireLocalReplica(dataDir, replicaId, backup, server.serverId, ledgerId);
      expect(completed.resumed).toBe(true);
      expect(completed.otherLedgerIds).toEqual(inspection.otherLedgerIds);
      expect(existsSync(join(dataDir, LOCAL_REPLICA_RETIREMENT_MARKER))).toBe(false);
      expect(() => assertNoPendingLocalReplicaRetirement(dataDir)).not.toThrow();
    } finally {
      if (!serverClosed) await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
