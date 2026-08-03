import type { SyncCommitV2, SyncRevisionV2 } from '@zichan/core';

export type SyncCommitState = 'pending' | 'applied' | 'conflict' | 'invalid';

export interface StoredSyncCommit extends SyncCommitV2 {
  source: 'local' | 'remote';
  sealed: boolean;
  sourceReplicaKey?: string;
  state: SyncCommitState;
  contentHash?: string;
  receivedAt?: string;
  error?: string;
}

export interface SyncReplicaIdentity {
  serverId: string;
  replicaId: string;
  streamEpoch: string;
  ledgerId: string;
}

export interface SyncReplicaState extends SyncReplicaIdentity {
  replicaKey: string;
  cursor: number;
  headSeq: number;
  updatedAt?: string;
  retiredAt?: string;
}

export interface SyncConflictBranchRow {
  groupId: string;
  revisionId: string;
  commitId: string;
  aggregateType: string;
  aggregateId: string;
  role: 'local' | 'remote';
  originDeviceId: string;
  sourceReplicaKey?: string;
  parentRevisionIds: string[];
  payload: Record<string, unknown> | null;
}

export interface SyncConflictGroupRow {
  id: string;
  ledgerId: string;
  at: string;
  status: 'open' | 'resolved';
  localCommitIds: string[];
  remoteCommitIds: string[];
  changedPaths: string[];
  resolvedAt?: string;
  branches: SyncConflictBranchRow[];
}

export interface SyncGraph {
  commits: Map<string, StoredSyncCommit>;
  revisions: Map<string, SyncRevisionV2>;
  entityHeads: Map<string, string[]>;
  ledgerHeads: string[];
}

export function aggregateKey(type: string, id: string): string {
  return `${type}\u0000${id}`;
}

export function replicaKey(identity: SyncReplicaIdentity): string {
  return `${identity.serverId}\u0000${identity.replicaId}\u0000${identity.streamEpoch}\u0000${identity.ledgerId}`;
}
