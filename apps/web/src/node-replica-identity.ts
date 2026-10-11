import type { SyncConnection } from './sync-config.js';

export interface NodeReplicaIdentity {
  serverId: string;
  nodePublicKey: string;
}

/** A stored signing identity is immutable through the replica join flow. */
export function assertNodeReplicaIdentity(profile: Pick<SyncConnection,
  'alias' | 'serverId' | 'nodePublicKey'>, observed: NodeReplicaIdentity): void {
  if (!observed.serverId || observed.serverId !== profile.serverId || !observed.nodePublicKey) {
    throw new Error(`${profile.alias} 节点身份不匹配`);
  }
  if (profile.nodePublicKey && profile.nodePublicKey !== observed.nodePublicKey) {
    throw new Error(`${profile.alias} 节点签名公钥与已信任记录不一致；已停止建立复制`);
  }
}
