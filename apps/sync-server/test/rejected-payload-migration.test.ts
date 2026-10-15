import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { SyncServerStore } from '../src/store.js';

describe('rejected commit ciphertext migration', () => {
  it('rejects a v19 database without changing rejected metadata', async () => {
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
      await expect(upgraded.ready).rejects.toThrow('数据库版本不匹配');
      const unchanged = new NodeSqliteDriver(file);
      try {
        expect((await unchanged.get<{ version: number }>('SELECT version FROM server_schema_migrations'))?.version).toBe(19);
        expect((await unchanged.get<{ commit_id: string }>('SELECT commit_id FROM ledger_replica_rejected_commits'))?.commit_id).toBe('commit-rejected-upgrade-0001');
      } finally { await unchanged.close(); }
    } finally {
      await (upgraded ?? initial).close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a v20 database without losing archived rejected ciphertext', async () => {
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
      await expect(upgraded.ready).rejects.toThrow('数据库版本不匹配');
      const unchanged = new NodeSqliteDriver(file);
      try {
        expect((await unchanged.get<{ version: number }>('SELECT version FROM server_schema_migrations'))?.version).toBe(20);
        expect((await unchanged.get<{ enc_commit_json: string }>('SELECT enc_commit_json FROM ledger_replica_rejected_payloads'))?.enc_commit_json).toContain('cipher');
      } finally { await unchanged.close(); }
    } finally {
      await (upgraded ?? initial).close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
