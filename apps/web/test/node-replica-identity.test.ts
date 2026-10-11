import { describe, expect, it } from 'vitest';
import { assertNodeReplicaIdentity } from '../src/node-replica-identity.js';

describe('replica node identity pin', () => {
  const profile = { alias: '家庭节点', serverId: 'node-home', nodePublicKey: 'trusted-ed25519-key' };

  it('rejects a signing-key change even when the server ID is unchanged', () => {
    expect(() => assertNodeReplicaIdentity(profile,
      { serverId: 'node-home', nodePublicKey: 'attacker-ed25519-key' }))
      .toThrow('节点签名公钥与已信任记录不一致');
    expect(() => assertNodeReplicaIdentity(profile,
      { serverId: 'node-office', nodePublicKey: profile.nodePublicKey }))
      .toThrow('节点身份不匹配');
    expect(() => assertNodeReplicaIdentity(profile,
      { serverId: 'node-home', nodePublicKey: profile.nodePublicKey }))
      .not.toThrow();
  });
});
