import type { NodeReplicaInventory, NodeReplicationLink, ReplicaPhysicalStatus } from './store.js';

export type ReplicaReadinessState = 'BOOTSTRAPPING' | 'CATCHING_UP' | 'VERIFYING' | 'READY';

export interface ReplicaReadiness {
  state: ReplicaReadinessState;
  checkedAt: string;
  issues: string[];
  commitCount: number;
  blobCount: number;
  promisedBlobCount: number;
  missingPromisedBlobCount: number;
  legacyBlobCount: number;
  linkedPeers: number;
  verifiedPeers: number;
  physicalVerifiedAt?: string;
}

/** READY is a point-in-time claim about the local replica and every enabled outbound link. */
export function assessReplicaReadiness(input: {
  inventory: NodeReplicaInventory;
  physical: ReplicaPhysicalStatus;
  links: NodeReplicationLink[];
  verifiedLinkIds: ReadonlySet<string>;
  peerErrors?: ReadonlyMap<string, string>;
  snapshotStable: boolean;
  now?: number;
}): ReplicaReadiness {
  const { inventory, physical, links, verifiedLinkIds, peerErrors, snapshotStable } = input;
  const now = input.now ?? Date.now();
  const issues: string[] = [];
  let bootstrap = false;
  let catchingUp = false;
  if (inventory.legacyBlobCount) {
    bootstrap = true;
    issues.push(`${inventory.legacyBlobCount} 个旧版附件待迁移`);
  }
  if (inventory.missingPromisedBlobCount) {
    catchingUp = true;
    issues.push(`${inventory.missingPromisedBlobCount} 个承诺附件尚未保存到本节点`);
  }
  if (!inventory.commitStreamComplete) issues.push('本地加密提交序号或账本归属不完整');
  if (!inventory.attachmentPromisePresent || !inventory.attachmentPromiseCurrent) {
    issues.push(inventory.attachmentPromisePresent ? '附件承诺目录落后于当前提交'
      : '尚未发布当前账本的附件承诺目录');
  }
  if (physical.issue) issues.push(physical.issue);
  else if (!physical.verifiedAt || physical.blobHash !== inventory.blobHash) {
    issues.push('本地新版附件尚未完成与当前目录对应的逐块校验');
  }
  if (!snapshotStable) issues.push('核对期间副本目录发生变化，请重试');
  for (const link of links.filter((item) => item.enabled)) {
    const peer = link.peerNodeId;
    const peerError = peerErrors?.get(link.linkId);
    if (peerError) issues.push(`${peer}：${peerError}`);
    else if (!verifiedLinkIds.has(link.linkId)) issues.push(`${peer}：节点目录尚未一致`);
    const recentSuccess = link.lastSuccessAt && Number.isFinite(Date.parse(link.lastSuccessAt))
      && now - Date.parse(link.lastSuccessAt) <= 60_000 && Date.parse(link.lastSuccessAt) <= now + 30_000;
    if (!recentSuccess || link.pushSeq < link.localHeadSeq || link.pullSeq < link.peerHeadSeq
      || link.pullBlobCursor || link.pushBlobCursor || link.pullStateCursor || link.pushStateCursor
      || !link.pullBlobSweepAt || !link.pushBlobSweepAt || !link.pullStateSweepAt || !link.pushStateSweepAt) {
      catchingUp = true;
      issues.push(`${peer}：后台复制游标或最近成功时间尚未就绪`);
    }
  }
  return {
    state: issues.length ? bootstrap ? 'BOOTSTRAPPING' : catchingUp ? 'CATCHING_UP' : 'VERIFYING' : 'READY',
    checkedAt: new Date(now).toISOString(), issues,
    commitCount: inventory.commitCount, blobCount: inventory.blobCount,
    promisedBlobCount: inventory.promisedBlobCount,
    missingPromisedBlobCount: inventory.missingPromisedBlobCount,
    legacyBlobCount: inventory.legacyBlobCount,
    linkedPeers: links.filter((item) => item.enabled).length,
    verifiedPeers: links.filter((item) => item.enabled && verifiedLinkIds.has(item.linkId)).length,
    ...(physical.verifiedAt ? { physicalVerifiedAt: physical.verifiedAt } : {}),
  };
}
