import { createHash } from 'node:crypto';
import { canonicalJson } from '@zichan/core';
import type { JsonRecord, NodeGroupMemberReport, NodeReplicaInventory,
  ReplicaGroupMember, ReplicaPhysicalStatus } from './store.js';
import type { ReplicaReadiness, ReplicaReadinessState } from './replica-readiness.js';

const NUMERIC_INVENTORY_FIELDS = new Set<keyof NodeReplicaInventory>([
  'keyGeneration', 'controlSeq', 'keyEpoch', 'memberEnvelopeCount', 'missingMemberEnvelopeCount',
  'memberAccountKeyCount', 'missingMemberAccountKeyCount', 'memberAccountCount', 'missingMemberAccountCount',
  'commitCount', 'commitStreamComplete', 'attachmentPromisePresent', 'attachmentPromiseCurrent',
  'promisedBlobCount', 'missingPromisedBlobCount', 'rejectedCommitCount', 'blobCount',
  'tombstoneCount', 'legacyBlobCount',
]);
const INVENTORY_FIELDS: (keyof NodeReplicaInventory)[] = [
  'serverId', 'replicaId', 'streamEpoch', 'ledgerId', 'issuerNodeId', 'subjectAccountId',
  'accountKeyHash', 'keyringId', 'keyGeneration', 'keyEnvelopeHash', 'controlSeq', 'controlHash',
  'keyEpoch', 'memberEnvelopeCount', 'memberEnvelopeHash', 'missingMemberEnvelopeCount',
  'memberAccountKeyCount', 'memberAccountKeyHash', 'missingMemberAccountKeyCount',
  'memberAccountCount', 'missingMemberAccountCount', 'requirementsHash', 'commitCount',
  'commitHash', 'commitStreamComplete', 'attachmentPromisePresent', 'attachmentPromiseCurrent',
  'promisedBlobCount', 'promisedBlobHash', 'missingPromisedBlobCount', 'rejectedCommitCount',
  'blobCount', 'blobHash', 'tombstoneCount', 'stateHash', 'legacyBlobCount',
];
const HASH_FIELDS = new Set<keyof NodeReplicaInventory>([
  'accountKeyHash', 'keyEnvelopeHash', 'controlHash', 'memberEnvelopeHash',
  'memberAccountKeyHash', 'requirementsHash', 'commitHash', 'promisedBlobHash',
  'blobHash', 'stateHash',
]);
const LIFECYCLE_STATES = new Set(['JOINING', 'BOOTSTRAPPING', 'CATCHING_UP', 'VERIFYING', 'READY']);

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

export interface NodeReplicaHealthReport extends JsonRecord {
  sourceReplicaId: string;
  sourceStreamEpoch: string;
  inventory: NodeReplicaInventory;
  physical: ReplicaPhysicalStatus;
  lifecycleState: string;
  lifecycleCheckedAt?: string;
}

/** Signed reports are evidence supplied by the peer, never proof of its ciphertext contents. */
export function parseNodeReplicaHealthReport(value: unknown, peerNodeId: string,
  ledgerId: string, sourceReplicaId: string, sourceStreamEpoch: string): NodeReplicaHealthReport | undefined {
  if (!record(value) || value.sourceReplicaId !== sourceReplicaId
    || value.sourceStreamEpoch !== sourceStreamEpoch || !record(value.inventory)
    || !record(value.physical) || !LIFECYCLE_STATES.has(String(value.lifecycleState))) return;
  const inventory = value.inventory;
  if (inventory.serverId !== peerNodeId || inventory.ledgerId !== ledgerId
    || typeof inventory.replicaId !== 'string' || !inventory.replicaId
    || typeof inventory.streamEpoch !== 'string' || !inventory.streamEpoch) return;
  for (const field of INVENTORY_FIELDS) {
    const item = inventory[field];
    if (NUMERIC_INVENTORY_FIELDS.has(field)) {
      if (!Number.isSafeInteger(item) || Number(item) < 0) return;
    } else if (typeof item !== 'string' || !item || item.length > 256
      || HASH_FIELDS.has(field) && !/^[a-f0-9]{64}$/.test(item)) return;
  }
  const physical = value.physical;
  if (physical.blobHash !== undefined && (typeof physical.blobHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(physical.blobHash))) return;
  if (physical.verifiedAt !== undefined && !validTime(physical.verifiedAt)) return;
  if (physical.scannedAt !== undefined && !validTime(physical.scannedAt)) return;
  if (physical.issue !== undefined && (typeof physical.issue !== 'string' || physical.issue.length > 400)) return;
  if (value.lifecycleCheckedAt !== undefined && !validTime(value.lifecycleCheckedAt)) return;
  return value as NodeReplicaHealthReport;
}

export interface ReplicaGroupMemberHealth {
  nodeId: string;
  state: 'READY' | 'VERIFYING' | 'CATCHING_UP' | 'BOOTSTRAPPING' | 'MISSING';
  receivedAt?: string;
  issue?: string;
}

export interface ReplicaGroupHealth {
  state: ReplicaReadinessState | 'NOT_CONFIGURED';
  checkedAt: string;
  ledgerId: string;
  coordinatorNodeId: string;
  memberCount: number;
  readyCount: number;
  issues: string[];
  members: ReplicaGroupMemberHealth[];
}

export interface ReplicaGroupDirectory {
  hash: string;
  members: ReplicaGroupMember[];
}

export interface NodeReplicaGroupSnapshot {
  serverId: string;
  replicaId: string;
  streamEpoch: string;
  ledgerId: string;
  directory: ReplicaGroupDirectory;
  health: ReplicaGroupHealth;
}

export function buildReplicaGroupDirectory(coordinator: ReplicaGroupMember,
  peers: ReplicaGroupMember[]): ReplicaGroupDirectory {
  const members = [coordinator, ...peers].sort((left, right) => left.nodeId < right.nodeId ? -1
    : left.nodeId > right.nodeId ? 1 : 0);
  return { members, hash: createHash('sha256').update(canonicalJson(members)).digest('hex') };
}

export function parseNodeReplicaGroupSnapshot(value: unknown, sourceNodeId: string,
  sourcePublicKey: string, sourceReplicaId: string, sourceStreamEpoch: string, ledgerId: string,
  localNodeId: string, localPublicKey: string): NodeReplicaGroupSnapshot | undefined {
  if (!record(value) || value.serverId !== sourceNodeId || value.replicaId !== sourceReplicaId
    || value.streamEpoch !== sourceStreamEpoch || value.ledgerId !== ledgerId
    || !record(value.directory) || !record(value.health)) return;
  const directory = value.directory;
  if (!Array.isArray(directory.members) || directory.members.length < 2 || directory.members.length > 256
    || typeof directory.hash !== 'string' || !/^[a-f0-9]{64}$/.test(directory.hash)) return;
  const seen = new Set<string>();
  const active = new Set<string>();
  let activeLocal = false;
  let activeSource = false;
  let previous = '';
  for (const raw of directory.members) {
    if (!record(raw) || typeof raw.nodeId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(raw.nodeId)
      || typeof raw.publicKey !== 'string' || raw.publicKey.length > 256 || !validTime(raw.joinedAt)
      || raw.retiredAt !== undefined && !validTime(raw.retiredAt)
      || seen.has(raw.nodeId) || raw.nodeId <= previous) return;
    previous = raw.nodeId;
    seen.add(raw.nodeId);
    if (!raw.retiredAt) active.add(raw.nodeId);
    if (raw.nodeId === localNodeId && raw.publicKey === localPublicKey && !raw.retiredAt) activeLocal = true;
    if (raw.nodeId === sourceNodeId && raw.publicKey === sourcePublicKey && !raw.retiredAt) activeSource = true;
  }
  if (!activeLocal || !activeSource
    || directory.hash !== createHash('sha256').update(canonicalJson(directory.members)).digest('hex')) return;
  const health = value.health;
  if (health.coordinatorNodeId !== sourceNodeId || health.ledgerId !== ledgerId
    || !validTime(health.checkedAt) || !['NOT_CONFIGURED', 'BOOTSTRAPPING', 'CATCHING_UP', 'VERIFYING', 'READY'].includes(String(health.state))
    || !Number.isSafeInteger(health.memberCount) || Number(health.memberCount) !== active.size
    || !Number.isSafeInteger(health.readyCount) || Number(health.readyCount) < 0
    || Number(health.readyCount) > Number(health.memberCount)
    || !Array.isArray(health.issues) || health.issues.length > 256
    || health.issues.some((issue: unknown) => typeof issue !== 'string' || issue.length > 500)
    || !Array.isArray(health.members) || health.members.length !== health.memberCount) return;
  const healthIds = new Set<string>();
  let readyMembers = 0;
  for (const member of health.members) {
    if (!record(member) || typeof member.nodeId !== 'string' || !active.has(member.nodeId)
      || healthIds.has(member.nodeId)
      || typeof member.state !== 'string' || !['READY', 'VERIFYING', 'CATCHING_UP', 'BOOTSTRAPPING', 'MISSING'].includes(member.state)
      || member.issue !== undefined && (typeof member.issue !== 'string' || member.issue.length > 1000)
      || member.receivedAt !== undefined && !validTime(member.receivedAt)) return;
    healthIds.add(member.nodeId);
    if (member.state === 'READY') readyMembers += 1;
  }
  if (readyMembers !== health.readyCount
    || health.state === 'READY' && (health.readyCount !== health.memberCount || health.issues.length)) return;
  return value as unknown as NodeReplicaGroupSnapshot;
}

export function assessForwardedReplicaGroupHealth(snapshot: NodeReplicaGroupSnapshot,
  receivedAt: string, localNodeId: string, local: ReplicaReadiness, now = Date.now()): ReplicaGroupHealth {
  const current = fresh(receivedAt, now) && fresh(snapshot.health.checkedAt, now);
  const issues = [...snapshot.health.issues, ...local.issues.map((issue) => `${localNodeId}：${issue}`)];
  if (!current) issues.push('中继副本组状态超过 60 秒或尚未更新');
  const state = !current ? 'VERIFYING' : local.state !== 'READY' ? local.state
    : snapshot.health.state;
  const members = snapshot.health.members.map((member) => member.nodeId !== localNodeId ? member
    : { ...member, state: local.state === 'READY' ? member.state : local.state,
      ...(local.issues.length ? { issue: local.issues.join('；') } : {}) });
  return { ...snapshot.health, state, checkedAt: new Date(now).toISOString(), issues, members,
    readyCount: current ? members.filter((member) => member.state === 'READY').length : 0 };
}

const fresh = (at: string | undefined, now: number): boolean => Boolean(at
  && Number.isFinite(Date.parse(at)) && now - Date.parse(at) <= 60_000
  && Date.parse(at) <= now + 30_000);

export function assessReplicaGroupMember(local: NodeReplicaInventory,
  member: NodeGroupMemberReport, now = Date.now()): ReplicaGroupMemberHealth {
  const report = member.report && parseNodeReplicaHealthReport(member.report, member.peerNodeId,
    local.ledgerId, local.replicaId, local.streamEpoch);
  let issue: string | undefined;
  if (member.identityConflict) issue = '同一节点存在不同签名公钥的有效授权';
  else if (!member.grantId) issue = '复制授权已撤销或过期，仍属于副本组';
  else if (!report || !fresh(member.receivedAt, now)) issue = '节点健康报告缺失或超过 60 秒';
  else if (report.lifecycleState !== 'READY' || !fresh(report.lifecycleCheckedAt, now)) {
    issue = '节点链路尚未完成近期核对';
  } else if (report.physical.issue || report.physical.blobHash !== report.inventory.blobHash
    || !report.physical.verifiedAt) issue = '节点附件物理校验尚未完成';
  else if (INVENTORY_FIELDS.some((field) => field !== 'serverId' && field !== 'replicaId'
    && field !== 'streamEpoch' && local[field] !== report.inventory[field])) {
    issue = '节点账本目录与当前节点不一致';
  }
  return { nodeId: member.peerNodeId,
    state: issue ? report?.lifecycleState === 'BOOTSTRAPPING' ? 'BOOTSTRAPPING'
      : report?.lifecycleState === 'CATCHING_UP' ? 'CATCHING_UP' : report ? 'VERIFYING' : 'MISSING'
      : 'READY',
    ...(member.receivedAt ? { receivedAt: member.receivedAt } : {}), ...(issue ? { issue } : {}) };
}

export function assessReplicaGroupHealth(input: {
  local: NodeReplicaInventory;
  localReadiness: ReplicaReadiness;
  members: NodeGroupMemberReport[];
  now?: number;
}): ReplicaGroupHealth {
  const now = input.now ?? Date.now();
  const issues = [...input.localReadiness.issues];
  const members: ReplicaGroupMemberHealth[] = [{ nodeId: input.local.serverId,
    state: input.localReadiness.state, ...(issues.length ? { issue: issues.join('；') } : {}) }];
  if (!input.members.length) issues.push('当前节点没有已登记的组成员');
  for (const member of input.members) {
    const assessed = assessReplicaGroupMember(input.local, member, now);
    if (assessed.issue) issues.push(`${member.peerNodeId}：${assessed.issue}`);
    members.push(assessed);
  }
  const state = !input.members.length ? 'NOT_CONFIGURED'
    : !issues.length ? 'READY'
      : input.localReadiness.state === 'BOOTSTRAPPING' || members.some((member) => member.state === 'BOOTSTRAPPING')
        ? 'BOOTSTRAPPING'
        : input.localReadiness.state === 'CATCHING_UP' || members.some((member) => member.state === 'CATCHING_UP')
          ? 'CATCHING_UP' : 'VERIFYING';
  return { state, checkedAt: new Date(now).toISOString(), ledgerId: input.local.ledgerId,
    coordinatorNodeId: input.local.serverId, memberCount: members.length,
    readyCount: members.filter((member) => member.state === 'READY').length, issues, members };
}
