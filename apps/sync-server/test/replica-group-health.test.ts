import { describe, expect, it } from 'vitest';
import { buildReplicaGroupDirectory, parseNodeReplicaGroupSnapshot } from '../src/replica-group-health.js';

describe('signed replica group snapshot validation', () => {
  it('rejects a changed pinned key or a fabricated READY count', () => {
    const at = new Date().toISOString();
    const sourceNodeId = 'node-source-0001';
    const localNodeId = 'node-local-0001';
    const sourcePublicKey = 'source-signing-key';
    const localPublicKey = 'local-signing-key';
    const ledgerId = 'ledger-group-0001';
    const directory = buildReplicaGroupDirectory({ nodeId: sourceNodeId,
      publicKey: sourcePublicKey, joinedAt: at }, [{ nodeId: localNodeId,
      publicKey: localPublicKey, joinedAt: at }]);
    const snapshot = { serverId: sourceNodeId, replicaId: 'rep-source-0001',
      streamEpoch: 'epoch-source-0001', ledgerId, directory,
      health: { state: 'READY', checkedAt: at, ledgerId, coordinatorNodeId: sourceNodeId,
        memberCount: 2, readyCount: 2, issues: [], members: [
          { nodeId: sourceNodeId, state: 'READY' }, { nodeId: localNodeId, state: 'READY' },
        ] } };
    const parse = (value: unknown, key = sourcePublicKey) => parseNodeReplicaGroupSnapshot(
      value, sourceNodeId, key, snapshot.replicaId, snapshot.streamEpoch,
      ledgerId, localNodeId, localPublicKey);
    expect(parse(snapshot)).toBeDefined();
    expect(parse(snapshot, 'different-source-key')).toBeUndefined();
    expect(parse({ ...snapshot, health: { ...snapshot.health, readyCount: 1 } })).toBeUndefined();
    const retired = buildReplicaGroupDirectory({ nodeId: sourceNodeId,
      publicKey: sourcePublicKey, joinedAt: at }, [{ nodeId: localNodeId,
      publicKey: localPublicKey, joinedAt: at, retiredAt: at }]);
    expect(parse({ ...snapshot, directory: retired,
      health: { ...snapshot.health, memberCount: 1, readyCount: 1,
        members: [{ nodeId: sourceNodeId, state: 'READY' }] } })).toBeUndefined();
  });
});
