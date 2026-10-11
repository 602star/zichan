import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { CURRENT_SERVER_SCHEMA, SyncServerStore } from '../src/store.js';

describe('rejected commit ciphertext migration', () => {
  it('upgrades a v19 database while preserving rejected metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'zichan-rejected-payload-upgrade-'));
    const file = join(directory, 'server.sqlite');
    const initial = new SyncServerStore(file, 'open', 'server-rejected-upgrade');
    let upgraded: SyncServerStore | undefined;
    try {
      await initial.register('owner', 'opaque-owner', undefined, true);
      await initial.bindReplica('owner', 'ledger-rejected-upgrade-0001');
      await initial.recordRejectedNodeCommit('owner', 'peer-rejected-upgrade', {
        commitId: 'commit-rejected-upgrade-0001', ledgerId: 'ledger-rejected-upgrade-0001',
        contentHash: 'a'.repeat(64), keyEpoch: 1,
        encCommit: { v: 3, keyId: 'key-rejected-upgrade', iv: 'iv', ct: 'cipher' },
      }, 'STALE_COMMIT_EPOCH');
      await initial.close();
      const sql = new NodeSqliteDriver(file);
      try {
        await sql.exec('DROP TABLE ledger_replica_rejected_payloads');
        await sql.run('UPDATE server_schema_migrations SET version = 19, name = ?',
          ['attachment_promise_catalog_v19']);
      } finally { await sql.close(); }
      upgraded = new SyncServerStore(file, 'open', 'server-rejected-upgrade');
      expect((await upgraded.verify()).schemaVersion).toBe(CURRENT_SERVER_SCHEMA);
      expect(await upgraded.listRejectedNodeCommits('owner')).toMatchObject([{
        commitId: 'commit-rejected-upgrade-0001', archived: false,
      }]);
      expect(await upgraded.rejectedNodeCommitCiphertext('owner', 'peer-rejected-upgrade',
        'commit-rejected-upgrade-0001')).toBeUndefined();
    } finally {
      await (upgraded ?? initial).close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('upgrades a v20 database without losing archived rejected ciphertext', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'zichan-rejected-resolution-upgrade-'));
    const file = join(directory, 'server.sqlite');
    const initial = new SyncServerStore(file, 'open', 'server-resolution-upgrade');
    let upgraded: SyncServerStore | undefined;
    try {
      await initial.register('owner', 'opaque-owner', undefined, true);
      await initial.bindReplica('owner', 'ledger-resolution-upgrade-0001');
      await initial.recordRejectedNodeCommit('owner', 'peer-resolution-upgrade', {
        commitId: 'commit-resolution-upgrade-0001', ledgerId: 'ledger-resolution-upgrade-0001',
        contentHash: 'b'.repeat(64), keyEpoch: 1,
        encCommit: { v: 3, keyId: 'key-resolution-upgrade', iv: 'iv', ct: 'cipher' },
      }, 'STALE_COMMIT_EPOCH');
      await initial.close();
      const sql = new NodeSqliteDriver(file);
      try {
        await sql.exec('DROP TABLE ledger_control_resolutions');
        await sql.run('UPDATE server_schema_migrations SET version = 20, name = ?',
          ['rejected_commit_ciphertext_v20']);
      } finally { await sql.close(); }
      upgraded = new SyncServerStore(file, 'open', 'server-resolution-upgrade');
      expect((await upgraded.verify()).schemaVersion).toBe(CURRENT_SERVER_SCHEMA);
      expect(await upgraded.listRejectedNodeCommits('owner')).toMatchObject([{
        commitId: 'commit-resolution-upgrade-0001', archived: true,
      }]);
      expect((await upgraded.rejectedNodeCommitCiphertext('owner', 'peer-resolution-upgrade',
        'commit-resolution-upgrade-0001'))?.encCommit).toMatchObject({ ct: 'cipher' });
    } finally {
      await (upgraded ?? initial).close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
