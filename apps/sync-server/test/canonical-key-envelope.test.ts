import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { SyncServerStore } from '../src/store.js';

describe('canonical replica key envelope', () => {
  it('refuses a replica envelope whose ledger differs from its slot after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-cross-ledger-envelope-'));
    const file = join(dir, 'server.sqlite');
    let store = new SyncServerStore(file, 'open', 'server-cross-ledger-envelope');
    try {
      await store.register('alice', 'opaque-alice', undefined, true);
      const ledgerId = 'ledger-cross-ledger-original';
      await store.bindReplica('alice', ledgerId);
      await store.putKeyEnvelope('alice', ledgerId, 'keyring-cross-ledger', 1,
        { ledgerId, keyringId: 'keyring-cross-ledger', generation: 1 });
      await store.close();
      const db = new NodeSqliteDriver(file);
      try {
        await db.run('UPDATE ledger_replica_key_envelopes SET ledger_id = ?', ['ledger-cross-ledger-wrong']);
      } finally { await db.close(); }
      store = new SyncServerStore(file, 'closed', 'server-cross-ledger-envelope');
      await expect(store.ready).rejects.toThrow('账本副本密钥包与副本槽位账本不一致');
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves current keys and required capabilities when legacy shadow rows are removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-shadow-retirement-'));
    const file = join(dir, 'server.sqlite');
    const store = new SyncServerStore(file, 'open', 'server-shadow-retirement');
    try {
      await store.register('alice', 'opaque-alice', undefined, true);
      const ledgerId = 'ledger-shadow-retirement';
      const first = { ledgerId, keyringId: 'keyring-shadow-retirement', generation: 1 };
      const current = { ...first, generation: 2 };
      await store.bindReplica('alice', ledgerId);
      await store.putKeyEnvelope('alice', ledgerId, first.keyringId, 1, first);
      await store.pushCommits('alice', [{ commitId: 'commit-shadow-retirement-0001', ledgerId,
        contentHash: 'c'.repeat(64), encCommit: { v: 3, keyId: first.keyringId, iv: 'iv', ct: 'ct' } }],
      ['asset-cost-v2'], ['asset-cost-v2']);
      const db = new NodeSqliteDriver(file);
      try {
        await db.run(`INSERT INTO sync_key_envelopes
          (username, ledger_id, keyring_id, generation, envelope_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        ['alice', ledgerId, first.keyringId, 1, JSON.stringify(first), new Date().toISOString()]);
        await db.run(`INSERT INTO sync_ledger_requirements (username, ledger_id, capability)
          VALUES (?, ?, ?)`, ['alice', ledgerId, 'asset-cost-v2']);
        await store.putKeyEnvelope('alice', ledgerId, current.keyringId, 2, current);
        await db.run('DELETE FROM sync_key_envelopes WHERE username = ?', ['alice']);
        await db.run('DELETE FROM sync_ledger_requirements WHERE username = ?', ['alice']);
        expect(await store.getKeyEnvelope('alice', ledgerId)).toEqual(current);
        expect(await store.listLedgerRequirements('alice', ledgerId)).toEqual(['asset-cost-v2']);
      } finally { await db.close(); }
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts an older legacy envelope after a canonical rotation and checkpoints the current generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-stale-envelope-'));
    const file = join(dir, 'server.sqlite');
    let store = new SyncServerStore(file, 'open', 'server-stale-envelope');
    try {
      await store.register('alice', 'opaque-alice', undefined, true);
      const ledgerId = 'ledger-stale-envelope-old';
      const first = { ledgerId, keyringId: 'keyring-stale-envelope', generation: 1 };
      const current = { ...first, generation: 2 };
      await store.bindReplica('alice', ledgerId);
      await store.putKeyEnvelope('alice', ledgerId, first.keyringId, 1, first);
      const db = new NodeSqliteDriver(file);
      try {
        await db.run(`INSERT INTO sync_key_envelopes
          (username, ledger_id, keyring_id, generation, envelope_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        ['alice', ledgerId, first.keyringId, 1, JSON.stringify(first), new Date().toISOString()]);
      } finally { await db.close(); }
      await store.putKeyEnvelope('alice', ledgerId, current.keyringId, 2, current);
      await store.createSession({ id: 'session-stale-envelope', username: 'alice',
        deviceId: 'device-stale-envelope', deviceName: 'test', refreshHash: 'hash',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      await store.close();
      store = new SyncServerStore(file, 'closed', 'server-stale-envelope');
      expect(await store.getKeyEnvelope('alice', ledgerId)).toEqual(current);
      const before = (await store.getReplica('alice'))!;
      await store.recordReplicaPhysicalStatus('alice', ledgerId, 'a'.repeat(64));
      await store.replaceReplica('alice', 'session-stale-envelope',
        { ledgerId, streamEpoch: before.streamEpoch },
        { ledgerId: 'ledger-stale-envelope-new', keyringId: 'keyring-new', generation: 1 }, []);
      const checkpoint = (await store.listReplacementCheckpoints('alice'))[0]!;
      const checked = new NodeSqliteDriver(file);
      try {
        const row = await checked.get<{ envelope_json: string }>(
          'SELECT envelope_json FROM ledger_replacement_checkpoints WHERE checkpoint_id = ?',
          [checkpoint.checkpointId]);
        expect(JSON.parse(row!.envelope_json)).toEqual(current);
      } finally { await checked.close(); }
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a personal ledger replaceable and recoverable after its legacy envelope is retired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-canonical-envelope-'));
    const file = join(dir, 'server.sqlite');
    let store = new SyncServerStore(file, 'open', 'server-canonical-envelope');
    try {
      await store.register('alice', 'opaque-alice', undefined, true);
      const ledgerId = 'ledger-canonical-envelope-old';
      const oldEnvelope = { ledgerId, keyringId: 'keyring-canonical-old', generation: 1 };
      await store.bindReplica('alice', ledgerId);
      await store.putKeyEnvelope('alice', ledgerId, oldEnvelope.keyringId, 1, oldEnvelope);
      await store.pushCommits('alice', [{ commitId: 'commit-canonical-old-0001', ledgerId,
        contentHash: 'a'.repeat(64), encCommit: { v: 3, keyId: 'keyring-canonical-old', iv: 'iv', ct: 'ct' } }],
      ['asset-cost-v2'], ['asset-cost-v2']);
      await store.createSession({ id: 'session-canonical-envelope', username: 'alice',
        deviceId: 'device-canonical-envelope', deviceName: 'test', refreshHash: 'hash',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const db = new NodeSqliteDriver(file);
      try {
        expect((await db.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM sync_key_envelopes WHERE username = ?', ['alice']))?.count).toBe(0);
      } finally { await db.close(); }
      await store.close();
      store = new SyncServerStore(file, 'closed', 'server-canonical-envelope');
      expect(await store.getKeyEnvelope('alice', ledgerId)).toEqual(oldEnvelope);
      await expect(store.putKeyEnvelope('alice', ledgerId, oldEnvelope.keyringId, 1,
        { ...oldEnvelope, changed: true })).rejects.toMatchObject({ code: 'KEY_ENVELOPE_COLLISION' });
      const before = (await store.getReplica('alice'))!;
      const newEnvelope = { ledgerId: 'ledger-canonical-envelope-new',
        keyringId: 'keyring-canonical-new', generation: 1 };
      const after = await store.replaceReplica('alice', 'session-canonical-envelope',
        { ledgerId, streamEpoch: before.streamEpoch }, newEnvelope, []);
      expect((await store.replicaPhysicalStatus('alice', ledgerId)).verifiedAt).toBeUndefined();
      await store.close();
      store = new SyncServerStore(file, 'closed', 'server-canonical-envelope');
      expect(await store.getKeyEnvelope('alice', newEnvelope.ledgerId)).toEqual(newEnvelope);
      await store.recordReplicaPhysicalStatus('alice', newEnvelope.ledgerId, 'b'.repeat(64));
      expect(await store.listLedgerRequirements('alice', newEnvelope.ledgerId)).toEqual([]);
      await store.pushCommits('alice', [{ commitId: 'commit-canonical-new-0001',
        ledgerId: newEnvelope.ledgerId, contentHash: 'b'.repeat(64),
        encCommit: { v: 3, keyId: 'keyring-canonical-new', iv: 'iv', ct: 'ct' } }]);
      const checkpoint = (await store.listReplacementCheckpoints('alice'))[0]!;
      expect(checkpoint.ledgerId).toBe(ledgerId);
      await store.restoreReplacementCheckpoint('alice', 'session-canonical-envelope',
        { ledgerId: after.ledgerId, streamEpoch: after.streamEpoch }, checkpoint.checkpointId);
      expect((await store.replicaPhysicalStatus('alice', newEnvelope.ledgerId)).verifiedAt).toBeUndefined();
      expect((await store.replicaPhysicalStatus('alice', ledgerId)).verifiedAt).toBeUndefined();
      expect(await store.getKeyEnvelope('alice', ledgerId)).toEqual(oldEnvelope);
      expect(await store.listLedgerRequirements('alice', ledgerId)).toEqual(['asset-cost-v2']);
      expect((await store.listCommits('alice', 0, 10)).commits.map((commit) => commit.commitId))
        .toEqual(['commit-canonical-old-0001']);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
