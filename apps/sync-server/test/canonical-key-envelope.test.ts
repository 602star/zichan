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

  it('keeps a personal ledger replaceable and recoverable after restart', async () => {
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
