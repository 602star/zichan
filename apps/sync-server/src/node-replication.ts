import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { NodeIdentity } from './node-identity.js';
import { signNodeRequest, verifyNodeResponse } from './node-request-auth.js';
import { assessReplicaReadiness } from './replica-readiness.js';
import { parseNodeReplicaGroupSnapshot } from './replica-group-health.js';
import { parseFederatedCredential, verifyFederatedCredential } from './federated-credential.js';
import type { BlobManifest, BlobReplicaState, EncryptedBlobStore } from './blob-store.js';
import { decodeBlobPack, encodeBlobPack, MAX_BLOB_PACK_CHUNK_BYTES, MAX_BLOB_PACK_OBJECTS } from './blob-pack.js';
import { type AttachmentPromiseCatalog, type AttachmentPromiseUpload,
  type JsonRecord, type NodeReplicaInventory, type NodeReplicationLink,
  type StoredCommit, type SyncServerStore } from './store.js';

const COMMIT_PATH = '/api/v4/replication/commits';
const PAGE_SIZE = 50;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = 15 * 1024 * 1024;

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class NodeReplicaRetiredError extends Error {
  constructor(readonly notice: JsonRecord) {
    super('中继已签名确认本节点移出副本组');
  }
}

/** Node credentials may leave the machine only over TLS or literal loopback. */
export function normalizeNodePeerUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && isIP(url.hostname) === 4 && url.hostname.startsWith('127.')))) {
    throw new Error('节点复制地址须使用 HTTPS；仅 127.0.0.1 可使用 HTTP');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('对端没有返回正文');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('对端响应超出大小上限');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

async function signedBytes(identity: NodeIdentity, link: Pick<NodeReplicationLink, 'peerUrl' | 'peerPublicKey' | 'grantId'>,
  method: 'GET' | 'POST' | 'PUT', path: string, body?: string | Uint8Array,
  timeoutMs = 30_000): Promise<Uint8Array> {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body ?? new Uint8Array();
  const proof = signNodeRequest(identity, link.grantId, method, path, bytes);
  const response = await fetch(`${link.peerUrl}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'X-Zichan-Node-Proof': JSON.stringify(proof), ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: Buffer.from(bytes) } : {}),
  });
  const raw = await boundedBody(response);
  const signature = response.headers.get('x-zichan-node-response');
  if (!response.ok) {
    if (response.status === 410 && signature
      && verifyNodeResponse(link.peerPublicKey, proof.nonce, raw, signature)) {
      let notice: unknown;
      try { notice = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { /* Fall through. */ }
      if (record(notice) && notice.code === 'REPLICA_MEMBER_RETIRED') {
        throw new NodeReplicaRetiredError(notice);
      }
    }
    throw new Error(`对端 ${path} 返回 HTTP ${response.status}: ${Buffer.from(raw).toString('utf8').slice(0, 300)}`);
  }
  if (!signature || !verifyNodeResponse(link.peerPublicKey, proof.nonce, raw, signature)) {
    throw new Error('对端响应签名无效或节点身份已改变');
  }
  return raw;
}

export async function signedCall(identity: NodeIdentity, link: Pick<NodeReplicationLink, 'peerUrl' | 'peerPublicKey' | 'grantId'>,
  method: 'GET' | 'POST' | 'PUT', path: string, body?: string | Uint8Array,
  timeoutMs = 30_000): Promise<JsonRecord> {
  const raw = await signedBytes(identity, link, method, path, body, timeoutMs);
  const parsed: unknown = JSON.parse(Buffer.from(raw).toString('utf8'));
  if (!record(parsed)) throw new Error('对端响应格式无效');
  return parsed;
}

function checkPeer(page: JsonRecord, link: Pick<NodeReplicationLink, 'peerNodeId' | 'peerReplicaId' | 'peerStreamEpoch'> & { ledgerId: string }): void {
  if (page.serverId !== link.peerNodeId || page.replicaId !== link.peerReplicaId
    || page.streamEpoch !== link.peerStreamEpoch || (page.ledgerId !== undefined && page.ledgerId !== link.ledgerId)) {
    throw new Error('对端账本、副本或流世代已改变；复制已停止');
  }
}

export async function probeNodePeer(identity: NodeIdentity, input: {
  peerUrl: string; peerNodeId: string; peerPublicKey: string; grantId: string; ledgerId: string;
}): Promise<{ peerReplicaId: string; peerStreamEpoch: string }> {
  const healthResponse = await fetch(`${input.peerUrl}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const healthRaw = await boundedBody(healthResponse);
  if (!healthResponse.ok) throw new Error(`对端健康检查返回 HTTP ${healthResponse.status}`);
  const health: unknown = JSON.parse(Buffer.from(healthRaw).toString('utf8'));
  if (!record(health) || health.serverId !== input.peerNodeId || health.nodePublicKey !== input.peerPublicKey) {
    throw new Error('对端节点 ID 或签名公钥不匹配');
  }
  const page = await signedCall(identity, input, 'GET', `${COMMIT_PATH}?after=0&limit=1`);
  if (page.serverId !== input.peerNodeId || page.ledgerId !== input.ledgerId
    || typeof page.replicaId !== 'string' || typeof page.streamEpoch !== 'string') {
    throw new Error('对端账本或副本身份不匹配');
  }
  return { peerReplicaId: page.replicaId, peerStreamEpoch: page.streamEpoch };
}

export async function confirmPeerGrantRevocation(identity: NodeIdentity, link: NodeReplicationLink): Promise<void> {
  const result = await signedCall(identity, link, 'POST', '/api/v4/replication/revoke', '{}');
  checkPeer(result, link);
  if (result.grantId !== link.grantId || result.revoked !== true) {
    throw new Error('对端未确认复制授权撤销');
  }
}

/** Stop requests survive browser closure and can be acknowledged after an uncertain first response. */
export async function revokeNodeLinkGrant(store: SyncServerStore, identity: NodeIdentity,
  link: NodeReplicationLink): Promise<void> {
  if (link.enabled || !link.revocationPending) return;
  await confirmPeerGrantRevocation(identity, link);
  await store.recordNodeRevocationResult(link.linkId);
}

function incomingCommits(value: unknown, ledgerId: string, after: number): { commits: Omit<StoredCommit, 'seq' | 'cipherBytes' | 'createdAt'>[]; nextSeq: number } {
  if (!Array.isArray(value) || value.length > PAGE_SIZE) throw new Error('对端提交页格式无效');
  let nextSeq = after;
  const commits: Omit<StoredCommit, 'seq' | 'cipherBytes' | 'createdAt'>[] = [];
  for (const item of value) {
    if (!record(item) || !Number.isSafeInteger(item.seq) || Number(item.seq) !== nextSeq + 1
      || item.ledgerId !== ledgerId || typeof item.commitId !== 'string' || !/^[A-Za-z0-9_-]{16,160}$/.test(item.commitId)
      || typeof item.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.contentHash)) {
      throw new Error('对端提交页包含无效提交');
    }
    nextSeq = Number(item.seq);
    if (!record(item.encCommit)
      || item.encCommit.v !== 3 || typeof item.encCommit.keyId !== 'string'
      || !/^[A-Za-z0-9_-]{16,160}$/.test(item.encCommit.keyId)
      || typeof item.encCommit.iv !== 'string' || item.encCommit.iv.length > 256
      || typeof item.encCommit.ct !== 'string' || item.encCommit.ct.length > MAX_REQUEST_BYTES) {
      throw new Error('对端提交页包含无效提交');
    }
    commits.push({ commitId: item.commitId as string, ledgerId, contentHash: item.contentHash as string,
      encCommit: item.encCommit });
  }
  return { commits, nextSeq };
}

async function linkedReplica(store: SyncServerStore, link: NodeReplicationLink) {
  const replica = await store.getReplicaForLedger(link.username, link.ledgerId);
  if (!replica || replica.streamEpoch !== link.localStreamEpoch) {
    throw new Error('本地账本副本已改变；复制已停止');
  }
  return replica;
}

export async function replicateNodeLink(store: SyncServerStore, identity: NodeIdentity, link: NodeReplicationLink): Promise<void> {
  const local = await linkedReplica(store, link);
  const page = await signedCall(identity, link, 'GET', `${COMMIT_PATH}?after=${link.pullSeq}&limit=${PAGE_SIZE}`);
  checkPeer(page, link);
  const pulled = incomingCommits(page.commits, link.ledgerId, link.pullSeq);
  if (page.nextSeq !== pulled.nextSeq || !Number.isSafeInteger(page.headSeq) || Number(page.headSeq) < pulled.nextSeq) {
    throw new Error('对端提交游标无效');
  }
  await store.updateNodeReplicationLink(link.linkId, { peerHeadSeq: Number(page.headSeq) });
  if (!Array.isArray(page.requiredCapabilities) || page.requiredCapabilities.some((value) => value !== 'asset-cost-v2')) {
    throw new Error('对端账本需要本节点不支持的能力');
  }
  const remoteRequirements = page.requiredCapabilities as string[];
  if (pulled.nextSeq > link.pullSeq) {
    if (pulled.commits.length || remoteRequirements.length) {
      await store.pushCommits(link.username, pulled.commits, ['asset-cost-v2'], remoteRequirements, 'node', local.replicaId);
    }
    await store.updateNodeReplicationLink(link.linkId, { pullSeq: pulled.nextSeq, error: null });
  } else if (remoteRequirements.length) {
    // Capability metadata may arrive without a new commit after a partial retry.
    await store.pushCommits(link.username, [], ['asset-cost-v2'], remoteRequirements, 'node', local.replicaId);
  }
  const localPage = await store.listCommits(link.username, link.pushSeq, PAGE_SIZE, 'node', local.replicaId);
  await store.updateNodeReplicationLink(link.linkId, { localHeadSeq: localPage.headSeq });
  const localRequirements = await store.listLedgerRequirements(link.username, link.ledgerId, local.replicaId);
  if (localPage.commits.length) {
    const batch: StoredCommit[] = [];
    let processedSeq = link.pushSeq;
    for (const item of localPage.commits) {
      const next = [...batch, item];
      if (Buffer.byteLength(JSON.stringify({ commits: next, requiredCapabilities: localRequirements })) > MAX_REQUEST_BYTES) break;
      batch.push(item);
      processedSeq = item.seq;
    }
    if (!batch.length && processedSeq === link.pushSeq) throw new Error('单条密文提交超出节点复制请求上限');
    if (batch.length) {
      const body = JSON.stringify({ commits: batch.map(({ commitId, ledgerId, contentHash, encCommit }) =>
        ({ commitId, ledgerId, contentHash, encCommit })), requiredCapabilities: localRequirements });
      const result = await signedCall(identity, link, 'POST', COMMIT_PATH, body);
      checkPeer(result, link);
      if (!Array.isArray(result.assigned) || result.assigned.length !== batch.length
        || result.assigned.some((item, index) => !record(item) || item.commitId !== batch[index]!.commitId || item.contentHash !== batch[index]!.contentHash)) {
        throw new Error('对端未确认全部提交');
      }
      if (!Number.isSafeInteger(result.headSeq) || Number(result.headSeq) < batch.length) throw new Error('对端提交进度无效');
      await store.updateNodeReplicationLink(link.linkId, { pushSeq: processedSeq,
        peerHeadSeq: Number(result.headSeq), error: null });
    } else {
      if (localRequirements.some((capability) => !remoteRequirements.includes(capability))) {
        const result = await signedCall(identity, link, 'POST', COMMIT_PATH,
          JSON.stringify({ commits: [], requiredCapabilities: localRequirements }));
        checkPeer(result, link);
      }
      await store.updateNodeReplicationLink(link.linkId, { pushSeq: processedSeq, error: null });
    }
  } else if (localRequirements.some((capability) => !remoteRequirements.includes(capability))) {
    const result = await signedCall(identity, link, 'POST', COMMIT_PATH,
      JSON.stringify({ commits: [], requiredCapabilities: localRequirements }));
    checkPeer(result, link);
  }
  if (!pulled.commits.length && !localPage.commits.length) await store.updateNodeReplicationLink(link.linkId, { error: null });
}

export async function replicateNodeEnvelope(store: SyncServerStore, identity: NodeIdentity, link: NodeReplicationLink): Promise<void> {
  const replica = await linkedReplica(store, link);
  const remote = await signedCall(identity, link, 'GET', '/api/v4/replication/key-envelope');
  checkPeer(remote, link);
  if (remote.ledgerId !== link.ledgerId || !record(remote.envelope)
    || remote.envelope.ledgerId !== link.ledgerId || !Number.isSafeInteger(remote.envelope.generation)
    || typeof remote.envelope.keyringId !== 'string') throw new Error('对端账本密钥包无效');
  const local = await store.getKeyEnvelope(link.username, link.ledgerId, 'node', replica.replicaId);
  if (!local || typeof local.generation !== 'number' || typeof local.keyringId !== 'string') {
    throw new Error('本地账本密钥包缺失');
  }
  if (local.keyringId !== remote.envelope.keyringId) throw new Error('两台节点的账本密钥包身份不同');
  if (Number(remote.envelope.generation) > local.generation) {
    await store.putKeyEnvelope(link.username, link.ledgerId, local.keyringId, Number(remote.envelope.generation), remote.envelope, 'node', replica.replicaId);
  } else if (Number(remote.envelope.generation) < local.generation) {
    const result = await signedCall(identity, link, 'POST', '/api/v4/replication/key-envelope', JSON.stringify({ envelope: local }));
    checkPeer(result, link);
  } else if (JSON.stringify(remote.envelope) !== JSON.stringify(local)) {
    throw new Error('同代次账本密钥包不一致；复制已停止');
  }
}

export async function replicateNodeGroupPolicy(store: SyncServerStore, identity: NodeIdentity,
  link: NodeReplicationLink): Promise<void> {
  if (!await store.federatedAccount(link.username)) return;
  const remote = await signedCall(identity, link, 'GET', '/api/v4/replication/group-policy');
  checkPeer(remote, link);
  if (remote.ledgerId !== link.ledgerId || !['open', 'invite', 'closed'].includes(String(remote.registrationMode))
    || !Number.isSafeInteger(remote.revision) || Number(remote.revision) < 1) {
    throw new Error('主节点注册策略无效');
  }
  await store.applyJoinedRegistrationPolicy(link.peerNodeId,
    remote.registrationMode as 'open' | 'invite' | 'closed', Number(remote.revision));
}

async function replicateNodeProtection(identity: NodeIdentity, link: NodeReplicationLink,
  apply: (link: NodeReplicationLink, mode: 'managed', secret: string) => Promise<void>): Promise<void> {
  let remote: JsonRecord;
  try { remote = await signedCall(identity, link, 'GET', '/api/v4/replication/account-protection'); }
  catch (error) {
    if (String(error).includes('/api/v4/replication/account-protection 返回 HTTP 404')) return;
    throw error;
  }
  checkPeer(remote, link);
  if (remote.mode === null) return;
  if (remote.mode !== 'managed' || typeof remote.secret !== 'string' || !remote.secret) {
    throw new Error('对端账本保护资料无效');
  }
  await apply(link, 'managed', remote.secret);
}

export async function replicateNodeAccountIdentity(store: SyncServerStore, identity: NodeIdentity, link: NodeReplicationLink): Promise<void> {
  const account = await signedCall(identity, link, 'GET', '/api/v4/replication/account-identity');
  checkPeer(account, link);
  if (account.ledgerId !== link.ledgerId || typeof account.issuerNodeId !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(account.issuerNodeId)
    || typeof account.subjectAccountId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(account.subjectAccountId)) {
    throw new Error('对端统一账号身份无效');
  }
  if (account.issuerNodeId !== link.peerNodeId) {
    const group = await store.serverSyncGroup();
    const issuer = (await store.serverSyncGroupMembers()).find((member) => member.nodeId === account.issuerNodeId);
    if (group?.role !== 'member' || group.mainNodeId !== link.peerNodeId || !issuer) {
      throw new Error('中继账本的账号签发节点不在同步组中');
    }
  }
  await store.bindFederatedAccount(link.username, link.ledgerId, account.issuerNodeId, account.subjectAccountId);
  await replicateNodeAccountCredential(store, identity, link, account.issuerNodeId,
    account.subjectAccountId, link.username);

}

async function replicateNodeAccountCredential(store: SyncServerStore, identity: NodeIdentity,
  link: NodeReplicationLink, issuerNodeId: string, subjectAccountId: string,
  localUsername: string): Promise<void> {
  let remote: JsonRecord;
  try {
    remote = await signedCall(identity, link, 'GET',
      `/api/v4/replication/account-credential?issuerNodeId=${encodeURIComponent(issuerNodeId)}`
      + `&subjectAccountId=${encodeURIComponent(subjectAccountId)}`);
  } catch (error) {
    if (String(error).includes('/api/v4/replication/account-credential?')
      && String(error).includes('返回 HTTP 404')) return;
    throw error;
  }
  checkPeer(remote, link);
  if (remote.bundle) {
    const bundle = parseFederatedCredential(remote.bundle);
    if (bundle.ledgerId !== link.ledgerId || bundle.issuerNodeId !== issuerNodeId
      || bundle.subjectAccountId !== subjectAccountId
      || typeof remote.issuerSignature !== 'string') {
      throw new Error('对端账号密码凭据与统一身份不匹配');
    }
    let issuerPublicKey = link.peerPublicKey;
    if (issuerNodeId !== link.peerNodeId) {
      const stored = await store.nodeGroupSnapshot(link.linkId);
      let snapshot = stored && parseNodeReplicaGroupSnapshot(stored.snapshot,
        link.peerNodeId, link.peerPublicKey, link.peerReplicaId, link.peerStreamEpoch,
        link.ledgerId, identity.nodeId, identity.publicKey);
      if (!snapshot?.directory.members.some((item) => item.nodeId === issuerNodeId && !item.retiredAt)) {
        const remoteGroup = await signedCall(identity, link, 'GET', '/api/v4/replication/group-state');
        snapshot = parseNodeReplicaGroupSnapshot(remoteGroup,
          link.peerNodeId, link.peerPublicKey, link.peerReplicaId, link.peerStreamEpoch,
          link.ledgerId, identity.nodeId, identity.publicKey);
        if (snapshot) {
          await store.recordNodeGroupSnapshot(link.linkId, remoteGroup);
        }
      }
      const member = snapshot?.directory.members.find((item) => item.nodeId === issuerNodeId && !item.retiredAt);
      if (!member) throw new Error('尚未取得成员身份节点的已签名副本组目录');
      issuerPublicKey = member.publicKey;
    }
    if (!verifyFederatedCredential(bundle, remote.issuerSignature, issuerPublicKey)) {
      throw new Error('成员身份节点账号凭据签名无效');
    }
    await store.importFederatedPasswordCredential({ localUsername,
      sourceUsername: bundle.username, displayName: bundle.displayName,
      issuerNodeId, subjectAccountId, registrationRecord: bundle.registrationRecord,
      serverSetup: bundle.serverSetup, disabled: bundle.disabled,
      sourceRevision: bundle.revision });
    return;
  }
  if (issuerNodeId !== link.peerNodeId || remote.issuerNodeId !== issuerNodeId
    || remote.subjectAccountId !== subjectAccountId || typeof remote.username !== 'string'
    || typeof remote.registrationRecord !== 'string' || typeof remote.serverSetup !== 'string'
    || typeof remote.disabled !== 'boolean') throw new Error('对端账号密码凭据与统一身份不匹配');
  await store.importFederatedPasswordCredential({ localUsername, sourceUsername: remote.username,
    displayName: typeof remote.displayName === 'string' ? remote.displayName : remote.username,
    issuerNodeId, subjectAccountId,
    registrationRecord: remote.registrationRecord, serverSetup: remote.serverSetup,
    disabled: remote.disabled, sourceRevision: 0 });
}

/** Pull group login identities independently of ledger replication. */
export async function replicateNodeAccountDirectory(store: SyncServerStore, identity: NodeIdentity,
  link: NodeReplicationLink): Promise<boolean> {
  if (!await store.federatedAccount(link.username)) return true;
  const after = await store.nodeDirectoryCursor(link.linkId);
  const remote = await signedCall(identity, link, 'GET',
    `/api/v4/replication/account-directory?after=${after}&limit=50`);
  checkPeer(remote, link);
  if (remote.ledgerId !== link.ledgerId || !Number.isSafeInteger(remote.headSeq)
    || !Number.isSafeInteger(remote.nextSeq) || Number(remote.nextSeq) < after
    || !Array.isArray(remote.entries) || remote.entries.length > 50
    || typeof remote.hasMore !== 'boolean') throw new Error('对端账号目录页无效');
  const stored = await store.nodeGroupSnapshot(link.linkId);
  const snapshot = stored && parseNodeReplicaGroupSnapshot(stored.snapshot,
    link.peerNodeId, link.peerPublicKey, link.peerReplicaId, link.peerStreamEpoch,
    link.ledgerId, identity.nodeId, identity.publicKey);
  let nextSeq = after;
  for (const item of remote.entries) {
    if (!record(item) || !Number.isSafeInteger(item.seq) || Number(item.seq) <= nextSeq
      || typeof item.signature !== 'string') throw new Error('账号目录事件顺序无效');
    nextSeq = Number(item.seq);
    const bundle = parseFederatedCredential(item.bundle);
    if (bundle.ledgerId !== link.ledgerId) throw new Error('账号目录账本范围无效');
    if (bundle.issuerNodeId === identity.nodeId) continue;
    const issuer = snapshot?.directory.members.find((member) => member.nodeId === bundle.issuerNodeId);
    const publicKey = bundle.issuerNodeId === link.peerNodeId ? link.peerPublicKey : issuer?.publicKey;
    if (!publicKey || !verifyFederatedCredential(bundle, item.signature, publicKey)) {
      throw new Error('账号目录签名无效');
    }
    // Old directory events remain auditable, but a retired issuer cannot refresh login credentials.
    if (issuer?.retiredAt) continue;
    const localUsername = await store.provisionFederatedDirectoryAccount(link.ledgerId,
      bundle.issuerNodeId, bundle.subjectAccountId);
    await store.importFederatedPasswordCredential({ localUsername,
      sourceUsername: bundle.username, displayName: bundle.displayName,
      issuerNodeId: bundle.issuerNodeId, subjectAccountId: bundle.subjectAccountId,
      registrationRecord: bundle.registrationRecord, serverSetup: bundle.serverSetup,
      disabled: bundle.disabled, sourceRevision: bundle.revision });
  }
  if (remote.nextSeq !== nextSeq || Number(remote.headSeq) < nextSeq
    || remote.hasMore !== (nextSeq < Number(remote.headSeq))) throw new Error('账号目录游标不连续');
  if (nextSeq > after) await store.advanceNodeDirectoryCursor(link.linkId, nextSeq);
  return !remote.hasMore;
}

/** One bounded page per round; signed events are checked again before they enter SQLite. */
function portableManifests(value: unknown, after: string): BlobManifest[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('对端附件清单页无效');
  let previous = after;
  return value.map((item) => {
    if (!record(item) || item.v !== 2 || typeof item.blobId !== 'string'
      || !/^[a-f0-9]{64}$/.test(item.blobId) || item.blobId <= previous
      || !Number.isSafeInteger(item.cipherBytes) || Number(item.cipherBytes) < 0
      || !Array.isArray(item.chunks) || !Number.isSafeInteger(item.chunkCount)
      || item.chunks.length !== item.chunkCount) throw new Error('对端附件清单无效');
    previous = item.blobId;
    return item as unknown as BlobManifest;
  });
}

async function pullPortableBlob(blobStore: EncryptedBlobStore, identity: NodeIdentity,
  link: NodeReplicationLink, manifest: BlobManifest, onChunk: (bytes: number) => Promise<void>): Promise<{ completed: boolean; transferredBytes: number }> {
  const state = (await blobStore.status(link.username, link.ledgerId, [manifest.blobId]))[manifest.blobId];
  // Trash is a deliberate local deletion. A peer still holding ciphertext must not revive it.
  if (state === 'available' || state === 'trash') return { completed: false, transferredBytes: 0 };
  const plan = await blobStore.beginUpload(link.username, link.ledgerId, manifest);
  if (plan.status === 'available') return { completed: false, transferredBytes: 0 };
  if (!plan.uploadId) throw new Error('本地附件上传会话无效');
  let transferredBytes = 0;
  for (const index of plan.missingChunks) {
    const path = `/api/v4/replication/blobs/${manifest.blobId}/chunks/${index}`;
    const chunk = await signedBytes(identity, link, 'GET', path);
    await blobStore.putChunk(link.username, plan.uploadId, index, chunk);
    await onChunk(chunk.byteLength);
    transferredBytes += chunk.byteLength;
  }
  await blobStore.completeUpload(link.username, plan.uploadId);
  return { completed: true, transferredBytes };
}

async function pullPortableBlobPack(blobStore: EncryptedBlobStore, identity: NodeIdentity,
  link: NodeReplicationLink, manifests: readonly BlobManifest[]): Promise<{ completed: number; transferredBytes: number }> {
  const ids = manifests.map((manifest) => manifest.blobId).join(',');
  const raw = await signedBytes(identity, link, 'GET', `/api/v4/replication/blobs/pack/read?ids=${ids}`);
  const entries = decodeBlobPack(raw);
  if (entries.length !== manifests.length || entries.some((entry, index) =>
    JSON.stringify(entry.manifest) !== JSON.stringify(manifests[index]))) {
    throw new Error('对端附件包与签名目录不匹配');
  }
  let completed = 0;
  for (const entry of entries) {
    const plan = await blobStore.beginUpload(link.username, link.ledgerId, entry.manifest);
    if (plan.status === 'available') continue;
    if (!plan.uploadId) throw new Error('本地附件包上传会话无效');
    if (plan.missingChunks.includes(0)) await blobStore.putChunk(link.username, plan.uploadId, 0, entry.chunk);
    await blobStore.completeUpload(link.username, plan.uploadId);
    completed += 1;
  }
  return { completed, transferredBytes: entries.reduce((sum, entry) => sum + entry.chunk.byteLength, 0) };
}

async function pushPortableBlob(blobStore: EncryptedBlobStore, identity: NodeIdentity, link: NodeReplicationLink,
  manifest: BlobManifest, onChunk: (bytes: number) => Promise<void>): Promise<number> {
  const response = await signedCall(identity, link, 'POST', '/api/v4/replication/blobs/uploads', JSON.stringify({ manifest }));
  checkPeer(response, link);
  if (!record(response.plan) || (response.plan.status !== 'available' && response.plan.status !== 'upload')) throw new Error('对端附件上传计划无效');
  if (response.plan.status === 'available') return 0;
  const uploadId = response.plan.uploadId;
  const missing = response.plan.missingChunks;
  if (typeof uploadId !== 'string' || !/^[a-f0-9]{32}$/.test(uploadId) || !Array.isArray(missing)
    || missing.some((index) => !Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= manifest.chunkCount)) {
    throw new Error('对端附件上传会话无效');
  }
  let transferredBytes = 0;
  for (const index of missing as number[]) {
    const chunk = await blobStore.chunk(link.username, link.ledgerId, manifest.blobId, index);
    if (!chunk) throw new Error('本地附件分块缺失');
    const result = await signedCall(identity, link, 'PUT', `/api/v4/replication/blobs/uploads/${uploadId}/chunks/${index}`, chunk);
    checkPeer(result, link);
    await onChunk(chunk.byteLength);
    transferredBytes += chunk.byteLength;
  }
  const complete = await signedCall(identity, link, 'POST', `/api/v4/replication/blobs/uploads/${uploadId}/complete`, '{}');
  checkPeer(complete, link);
  if (complete.blobId !== manifest.blobId) throw new Error('对端附件完成确认不匹配');
  return transferredBytes;
}

/** One signed request carries several small ciphertext objects without changing their manifest or hash checks. */
async function pushPortableBlobPack(blobStore: EncryptedBlobStore, identity: NodeIdentity,
  link: NodeReplicationLink, manifests: readonly BlobManifest[]): Promise<number> {
  const entries = await Promise.all(manifests.map(async (manifest) => {
    const chunk = await blobStore.chunk(link.username, link.ledgerId, manifest.blobId, 0);
    if (!chunk) throw new Error('本地附件分块缺失');
    return { manifest, chunk };
  }));
  const result = await signedCall(identity, link, 'POST', '/api/v4/replication/blobs/pack', encodeBlobPack(entries));
  checkPeer(result, link);
  if (!Array.isArray(result.accepted) || result.accepted.length !== manifests.length
    || result.accepted.some((id, index) => id !== manifests[index]!.blobId)) {
    throw new Error('对端附件包确认不匹配');
  }
  return entries.reduce((sum, entry) => sum + entry.chunk.byteLength, 0);
}

/** Independent blobs can transfer together; an unfinished page keeps its cursor for retry. */
async function transferBlobPage<T, R>(items: readonly T[], transfer: (item: T) => Promise<R>): Promise<{
  completed: R[]; error?: unknown;
}> {
  const completed: R[] = [];
  let next = 0;
  let failed = false;
  let firstError: unknown;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { completed.push(await transfer(items[index]!)); }
      catch (error) {
        if (!failed) { failed = true; firstError = error; }
      }
    }
  }));
  return { completed, ...(failed ? { error: firstError } : {}) };
}

function replicaStates(value: unknown, after: string): BlobReplicaState[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('对端附件状态页无效');
  let previous = after;
  return value.map((entry) => {
    if (!record(entry) || typeof entry.blobId !== 'string' || !/^[a-f0-9]{64}$/.test(entry.blobId)
      || entry.blobId <= previous || (entry.state !== 'available' && entry.state !== 'trash')
      || !Number.isSafeInteger(entry.counter) || Number(entry.counter) < 1
      || typeof entry.writerNodeId !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(entry.writerNodeId)
      || typeof entry.changedAt !== 'string' || !Number.isFinite(Date.parse(entry.changedAt))) {
      throw new Error('对端附件状态页无效');
    }
    previous = entry.blobId;
    return entry as unknown as BlobReplicaState;
  });
}

export async function replicateNodeBlobStates(store: SyncServerStore, blobStore: EncryptedBlobStore,
  identity: NodeIdentity, link: NodeReplicationLink, directions: { pull?: boolean; push?: boolean } = {}): Promise<void> {
  if (directions.pull !== false) {
    const remote = await signedCall(identity, link, 'GET',
      `/api/v4/replication/blobs/states?after=${link.pullStateCursor}&limit=20`);
    checkPeer(remote, link);
    const incoming = replicaStates(remote.states, link.pullStateCursor);
    if (remote.nextId !== (incoming.at(-1)?.blobId ?? link.pullStateCursor) || typeof remote.hasMore !== 'boolean'
      || !Number.isSafeInteger(remote.totalTombstones) || Number(remote.totalTombstones) < 0) {
      throw new Error('对端附件状态游标无效');
    }
    let changed = false;
    try {
      for (const state of incoming) {
        if (await blobStore.applyReplicaState(link.username, link.ledgerId, state)) changed = true;
      }
    } finally {
      if (changed) await store.invalidateReplicaPhysicalStatus(link.username, link.ledgerId);
    }
    await store.updateNodeReplicationLink(link.linkId, {
      pullStateCursor: remote.hasMore ? String(remote.nextId) : '', pullStateSwept: !remote.hasMore,
      peerTombstones: Number(remote.totalTombstones), error: null,
    });
  }

  if (directions.push !== false) {
    const local = await blobStore.listReplicaStates(link.username, link.ledgerId, link.pushStateCursor, 20);
    if (local.states.length) {
      const accepted = await signedCall(identity, link, 'POST', '/api/v4/replication/blobs/states',
        JSON.stringify({ states: local.states }));
      checkPeer(accepted, link);
      if (accepted.accepted !== local.states.length) throw new Error('对端附件状态确认无效');
    }
    await store.updateNodeReplicationLink(link.linkId, {
      pushStateCursor: local.hasMore ? local.nextId : '', pushStateSwept: !local.hasMore,
      localTombstones: local.totalTombstones, error: null,
    });
  }
}

export async function replicateNodeBlobs(store: SyncServerStore, blobStore: EncryptedBlobStore, identity: NodeIdentity,
  link: NodeReplicationLink, directions: { pull?: boolean; push?: boolean } = {}): Promise<void> {
  if (directions.pull !== false) {
    const pullPath = `/api/v4/replication/blobs?after=${link.pullBlobCursor}&limit=20`;
    const remote = await signedCall(identity, link, 'GET', pullPath);
    checkPeer(remote, link);
    const incoming = portableManifests(remote.manifests, link.pullBlobCursor);
    if (remote.nextId !== (incoming.at(-1)?.blobId ?? link.pullBlobCursor) || typeof remote.hasMore !== 'boolean') {
      throw new Error('对端附件游标无效');
    }
    if (!Number.isSafeInteger(remote.totalObjects) || Number(remote.totalObjects) < incoming.length
      || !Number.isSafeInteger(remote.totalBytes) || Number(remote.totalBytes) < 0
      || !Number.isSafeInteger(remote.legacyObjects) || Number(remote.legacyObjects) < 0) {
      throw new Error('对端附件统计无效');
    }
    let packedCompleted = 0;
    const packedIds = new Set<string>();
    if (remote.packV1 === true && incoming.length) {
      const states = await blobStore.status(link.username, link.ledgerId,
        incoming.map((manifest) => manifest.blobId));
      const packable = incoming.filter((manifest) => manifest.chunkCount === 1
        && manifest.cipherBytes <= MAX_BLOB_PACK_CHUNK_BYTES
        && states[manifest.blobId] === 'missing');
      for (const manifest of packable) packedIds.add(manifest.blobId);
      for (let offset = 0; offset < packable.length; offset += MAX_BLOB_PACK_OBJECTS) {
        const page = packable.slice(offset, offset + MAX_BLOB_PACK_OBJECTS);
        const result = await pullPortableBlobPack(blobStore, identity, link, page);
        packedCompleted += result.completed;
        await store.recordNodeBlobTransfer(link.linkId, 'pull', result.transferredBytes);
      }
    }
    let smallBlobBytes = 0;
    const transferred = await transferBlobPage(incoming.filter((manifest) => !packedIds.has(manifest.blobId)),
      (manifest) => pullPortableBlob(blobStore, identity, link, manifest, async (bytes) => {
        if (manifest.chunkCount === 1) smallBlobBytes += bytes;
        else await store.recordNodeBlobTransfer(link.linkId, 'pull', bytes);
      }));
    if (smallBlobBytes) await store.recordNodeBlobTransfer(link.linkId, 'pull', smallBlobBytes);
    const completedObjects = packedCompleted + transferred.completed.filter((item) => item.completed).length;
    if (completedObjects || 'error' in transferred) await store.invalidateNodePhysicalVerification(link.linkId);
    if ('error' in transferred) {
      throw transferred.error;
    }
    const pullScannedBytes = incoming.reduce((sum, manifest) => sum + manifest.cipherBytes, 0);
    await store.updateNodeReplicationLink(link.linkId, { pullBlobCursor: remote.hasMore ? String(remote.nextId) : '',
      peerBlobObjects: Number(remote.totalObjects), peerBlobBytes: Number(remote.totalBytes),
      pullBlobScannedBytes: (link.pullBlobCursor ? link.pullBlobScannedBytes : 0) + pullScannedBytes,
      peerLegacyObjects: Number(remote.legacyObjects),
      pullBlobSwept: !remote.hasMore, error: null });
  }

  if (directions.push !== false) {
    const local = await blobStore.listPortableManifests(link.username, link.ledgerId, link.pushBlobCursor, 20);
    if (local.manifests.length) {
      const status = await signedCall(identity, link, 'POST', '/api/v4/replication/blobs/status',
        JSON.stringify({ blobIds: local.manifests.map((manifest) => manifest.blobId) }));
      checkPeer(status, link);
      if (!record(status.objects)) throw new Error('对端附件状态无效');
      const missing: BlobManifest[] = [];
      for (const manifest of local.manifests) {
        const state = status.objects[manifest.blobId];
        if (state === 'available' || state === 'trash') continue;
        if (state !== 'missing') throw new Error('对端附件状态无效');
        missing.push(manifest);
      }
      const packable = status.packV1 === true
        ? missing.filter((manifest) => manifest.chunkCount === 1
          && manifest.cipherBytes <= MAX_BLOB_PACK_CHUNK_BYTES)
        : [];
      const packedIds = new Set(packable.map((manifest) => manifest.blobId));
      for (let offset = 0; offset < packable.length; offset += MAX_BLOB_PACK_OBJECTS) {
        const page = packable.slice(offset, offset + MAX_BLOB_PACK_OBJECTS);
        const bytes = await pushPortableBlobPack(blobStore, identity, link, page);
        await store.recordNodeBlobTransfer(link.linkId, 'push', bytes);
      }
      let smallBlobBytes = 0;
      const transferred = await transferBlobPage(missing.filter((manifest) => !packedIds.has(manifest.blobId)),
        (manifest) => pushPortableBlob(blobStore, identity, link, manifest, async (bytes) => {
          if (manifest.chunkCount === 1) smallBlobBytes += bytes;
          else await store.recordNodeBlobTransfer(link.linkId, 'push', bytes);
        }));
      if (smallBlobBytes) await store.recordNodeBlobTransfer(link.linkId, 'push', smallBlobBytes);
      if ('error' in transferred) {
        throw transferred.error;
      }
    }
    const pushScannedBytes = local.manifests.reduce((sum, manifest) => sum + manifest.cipherBytes, 0);
    await store.updateNodeReplicationLink(link.linkId, { pushBlobCursor: local.hasMore ? local.nextId : '',
      localBlobObjects: local.totalObjects, localBlobBytes: local.totalBytes,
      pushBlobScannedBytes: (link.pushBlobCursor ? link.pushBlobScannedBytes : 0) + pushScannedBytes,
      localLegacyObjects: local.legacyObjects,
      pushBlobSwept: !local.hasMore, error: null });
  }
}

const PROMISE_PATH = '/api/v4/replication/attachment-promise';

function promisedCatalog(value: unknown): AttachmentPromiseCatalog | null {
  if (value === null) return null;
  if (!record(value) || !Number.isSafeInteger(value.commitCount) || Number(value.commitCount) < 0
    || !Number.isSafeInteger(value.blobCount) || Number(value.blobCount) < 0
    || Number(value.blobCount) > 10_000_000
    || typeof value.commitHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.commitHash)
    || typeof value.blobHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.blobHash)
    || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))) {
    throw new Error('对端附件承诺目录无效');
  }
  return value as unknown as AttachmentPromiseCatalog;
}

function samePromise(left: AttachmentPromiseCatalog, right: AttachmentPromiseCatalog): boolean {
  return left.commitCount === right.commitCount && left.commitHash === right.commitHash
    && left.blobCount === right.blobCount && left.blobHash === right.blobHash;
}

function promisedPage(value: JsonRecord, link: NodeReplicationLink, after: string,
  catalog: AttachmentPromiseCatalog): { blobIds: string[]; nextId: string; hasMore: boolean } {
  checkPeer(value, link);
  const header = promisedCatalog(value.catalog);
  if (!header || !samePromise(header, catalog) || !Array.isArray(value.blobIds)
    || value.blobIds.length > 2000 || typeof value.hasMore !== 'boolean'
    || typeof value.nextId !== 'string') throw new Error('对端附件承诺页面无效或目录已改变');
  const blobIds: string[] = [];
  let last = after;
  for (const item of value.blobIds) {
    if (typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item) || item <= last) {
      throw new Error('对端附件承诺对象 ID 无序');
    }
    blobIds.push(item);
    last = item;
  }
  if (value.nextId !== last || value.hasMore && !blobIds.length) {
    throw new Error('对端附件承诺游标无效');
  }
  return { blobIds, nextId: last, hasMore: value.hasMore };
}

function promisedUpload(value: unknown, catalog: AttachmentPromiseCatalog): AttachmentPromiseUpload {
  if (!record(value) || typeof value.uploadId !== 'string' || !/^[a-f0-9]{32}$/.test(value.uploadId)
    || value.commitCount !== catalog.commitCount || value.commitHash !== catalog.commitHash
    || value.expectedCount !== catalog.blobCount
    || !Number.isSafeInteger(value.receivedCount) || Number(value.receivedCount) < 0
    || Number(value.receivedCount) > catalog.blobCount
    || typeof value.lastBlobId !== 'string'
    || value.lastBlobId && !/^[a-f0-9]{64}$/.test(value.lastBlobId)) {
    throw new Error('对端附件承诺上传状态无效');
  }
  return value as unknown as AttachmentPromiseUpload;
}

/** Copy a complete reference claim in both directions, up to four pages per run. */
export async function replicateNodeAttachmentPromise(store: SyncServerStore, identity: NodeIdentity,
  link: NodeReplicationLink): Promise<boolean> {
  const replica = await linkedReplica(store, link);
  const remote = await signedCall(identity, link, 'GET', `${PROMISE_PATH}?after=&limit=1`);
  checkPeer(remote, link);
  if (typeof remote.current !== 'boolean') throw new Error('对端附件承诺状态无效');
  const remoteCatalog = promisedCatalog(remote.catalog);
  const localPage = await store.attachmentPromisePage(link.username, '', 1, replica.replicaId);
  const localCatalog = localPage.catalog;
  const remoteCurrent = remote.current && remoteCatalog !== null;
  const localCurrent = localCatalog !== null && await store.attachmentPromiseIsCurrent(link.username, replica.replicaId);
  if (remote.current && !remoteCatalog) throw new Error('对端声称存在附件目录但没有目录');
  if (remoteCurrent && localCurrent) {
    if (!samePromise(remoteCatalog, localCatalog)) throw new Error('同一账本前沿的附件承诺目录发生分叉');
    return true;
  }
  if (!remoteCurrent && !localCurrent) return true;

  if (remoteCurrent) {
    const upload = await store.beginReplicatedAttachmentPromise(link.username, link.peerNodeId, remoteCatalog, replica.replicaId);
    if (!upload) return true;
    let state = upload;
    for (let round = 0; round < 4 && state.receivedCount < remoteCatalog.blobCount; round += 1) {
      const response = await signedCall(identity, link, 'GET',
        `${PROMISE_PATH}?after=${state.lastBlobId}&limit=2000`);
      const page = promisedPage(response, link, state.lastBlobId, remoteCatalog);
      if (!page.blobIds.length) throw new Error('对端附件承诺提前结束');
      state = await store.appendAttachmentPromisePage(link.username, state.uploadId,
        page.blobIds, replica.replicaId, link.peerNodeId);
      if (!page.hasMore && state.receivedCount < remoteCatalog.blobCount) {
        throw new Error('对端附件承诺数量不匹配');
      }
    }
    if (state.receivedCount < remoteCatalog.blobCount) return false;
    const complete = await store.completeAttachmentPromise(link.username, state.uploadId,
      replica.replicaId, link.peerNodeId);
    if (!samePromise(complete, remoteCatalog)) throw new Error('节点附件承诺发布结果不一致');
    return true;
  }

  const response = await signedCall(identity, link, 'POST', `${PROMISE_PATH}/uploads`,
    JSON.stringify({ catalog: localCatalog }));
  checkPeer(response, link);
  if (response.upload === null) return true;
  let state = promisedUpload(response.upload, localCatalog!);
  for (let round = 0; round < 4 && state.receivedCount < localCatalog!.blobCount; round += 1) {
    const page = await store.attachmentPromisePage(link.username, state.lastBlobId, 2000, replica.replicaId);
    if (!page.catalog || !samePromise(page.catalog, localCatalog!) || !page.blobIds.length) {
      throw new Error('本地附件承诺目录在复制期间改变');
    }
    const accepted = await signedCall(identity, link, 'POST',
      `${PROMISE_PATH}/uploads/${state.uploadId}/pages`, JSON.stringify({ blobIds: page.blobIds }));
    checkPeer(accepted, link);
    state = promisedUpload(accepted.upload, localCatalog!);
    if (!page.hasMore && state.receivedCount < localCatalog!.blobCount) {
      throw new Error('本地附件承诺数量不匹配');
    }
  }
  if (state.receivedCount < localCatalog!.blobCount) return false;
  const completed = await signedCall(identity, link, 'POST',
    `${PROMISE_PATH}/uploads/${state.uploadId}/complete`, '{}');
  checkPeer(completed, link);
  const complete = promisedCatalog(completed.catalog);
  if (!complete || !samePromise(complete, localCatalog!)) throw new Error('对端附件承诺发布结果不一致');
  return true;
}

export async function verifyNodeReplicaInventory(store: SyncServerStore, identity: NodeIdentity,
  link: NodeReplicationLink, localInventory?: NodeReplicaInventory): Promise<NodeReplicaInventory | undefined> {
  const remote = await signedCall(identity, link, 'GET', '/api/v4/replication/inventory');
  checkPeer(remote, link);
  const fields = ['issuerNodeId', 'subjectAccountId', 'keyringId', 'keyGeneration', 'keyEnvelopeHash',
    'requirementsHash', 'commitCount', 'commitHash', 'commitStreamComplete',
    'attachmentPromisePresent', 'attachmentPromiseCurrent', 'promisedBlobCount', 'promisedBlobHash',
    'missingPromisedBlobCount', 'blobCount', 'blobHash', 'tombstoneCount', 'stateHash', 'legacyBlobCount'] as const;
  const numeric = new Set<string>(['keyGeneration', 'commitCount', 'commitStreamComplete',
    'attachmentPromisePresent', 'attachmentPromiseCurrent', 'promisedBlobCount',
    'missingPromisedBlobCount', 'blobCount', 'tombstoneCount', 'legacyBlobCount']);
  for (const field of fields) {
    const value = remote[field];
    if (numeric.has(field) ? !Number.isSafeInteger(value) || Number(value) < 0
      : typeof value !== 'string' || !value || value.length > 256) throw new Error('对端账本目录摘要格式无效');
  }
  for (const field of ['keyEnvelopeHash', 'requirementsHash', 'commitHash', 'promisedBlobHash',
    'blobHash', 'stateHash'] as const) {
    if (!/^[a-f0-9]{64}$/.test(String(remote[field]))) throw new Error('对端账本目录哈希无效');
  }
  const local: NodeReplicaInventory = localInventory ?? await store.replicaInventory(link.username, link.ledgerId,
    (await linkedReplica(store, link)).replicaId);
  const differences = fields.filter((field) => local[field] !== remote[field]);
  if (local.legacyBlobCount || Number(remote.legacyBlobCount)) differences.push('legacyBlobCount');
  if (local.missingPromisedBlobCount || Number(remote.missingPromisedBlobCount)) differences.push('missingPromisedBlobCount');
  if (!local.commitStreamComplete || !Number(remote.commitStreamComplete)) differences.push('commitStreamComplete');
  if (local.attachmentPromisePresent && !local.attachmentPromiseCurrent
    || Number(remote.attachmentPromisePresent) && !Number(remote.attachmentPromiseCurrent)) {
    differences.push('attachmentPromiseCurrent');
  }
  const labels = new Set(differences.map((field) =>
    field === 'issuerNodeId' || field === 'subjectAccountId' ? '账号身份'
      : field === 'keyringId' || field === 'keyGeneration' || field === 'keyEnvelopeHash' ? '密钥包'
        : field === 'requirementsHash' ? '账本能力'
        : field === 'commitCount' || field === 'commitHash' || field === 'commitStreamComplete' ? '提交'
          : field === 'attachmentPromisePresent' || field === 'attachmentPromiseCurrent'
            || field === 'promisedBlobCount' || field === 'promisedBlobHash'
            || field === 'missingPromisedBlobCount' ? '附件承诺目录'
            : field === 'blobCount' || field === 'blobHash' ? '新版附件'
              : field === 'legacyBlobCount' ? '旧版附件待迁移' : '删除与恢复状态'));
  await store.updateNodeReplicationLink(link.linkId, differences.length
    ? { inventoryIssue: `目录尚未一致：${[...labels].join('、')}`, inventoryBlobHash: local.blobHash }
    : { inventoryMatched: true, inventoryIssue: null, inventoryBlobHash: local.blobHash });
  return differences.length ? undefined : local;
}

async function hashStoredChunk(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function scanReplicaPhysical(store: SyncServerStore, blobStore: EncryptedBlobStore,
  username: string, ledgerId: string, shouldCancel: () => boolean,
  beforeInventory?: NodeReplicaInventory): Promise<{ blobHash: string; replicaId: string;
    streamEpoch: string; issue?: string } | undefined> {
  const before = beforeInventory ?? await store.replicaInventory(username, ledgerId);
  if (before.ledgerId !== ledgerId) throw new Error('物理校验目录属于另一个账本');
  const scanned = await blobStore.verify({ username, ledgerId,
    replicaObjectsOnly: true, batchSize: 25, hashChunk: hashStoredChunk, shouldCancel });
  if (scanned.cancelled || shouldCancel()) return;
  const after = await store.replicaInventory(username, ledgerId);
  if (before.replicaId !== after.replicaId || before.streamEpoch !== after.streamEpoch
    || before.blobHash !== after.blobHash || before.blobCount !== after.blobCount) {
    return { blobHash: before.blobHash, replicaId: before.replicaId,
      streamEpoch: before.streamEpoch, issue: '校验期间附件目录发生变化，将重新校验' };
  }
  if (scanned.issues.length || scanned.checkedObjects !== before.blobCount) {
    const first = scanned.issues[0];
    let quarantined = 0;
    for (const issue of scanned.issues) {
      if (shouldCancel()) return;
      if (await blobStore.quarantineCorruptReplicaObject(username, ledgerId, issue.blobId,
        hashStoredChunk)) quarantined += 1;
    }
    return { blobHash: before.blobHash, replicaId: before.replicaId, streamEpoch: before.streamEpoch,
      issue: `本地新版附件校验失败：${scanned.issues.length || before.blobCount - scanned.checkedObjects} 个对象，已隔离 ${quarantined} 个等待补传${first ? `；首个 ${first.blobId.slice(0, 12)}：${first.detail}` : ''}` };
  }
  return { blobHash: before.blobHash, replicaId: before.replicaId, streamEpoch: before.streamEpoch };
}

/** Check local V2 ciphertext on disk without blocking commit replication. */
export async function verifyReplicaPhysical(store: SyncServerStore, blobStore: EncryptedBlobStore,
  username: string, ledgerId: string, shouldCancel: () => boolean = () => false,
  beforeInventory?: NodeReplicaInventory): Promise<void> {
  const result = await scanReplicaPhysical(store, blobStore, username, ledgerId, shouldCancel, beforeInventory);
  if (result) await store.recordReplicaPhysicalStatus(username, ledgerId, result.blobHash, result.issue,
    { replicaId: result.replicaId, streamEpoch: result.streamEpoch });
}

export function createNodeReplicationWorker(store: SyncServerStore, blobStore: EncryptedBlobStore,
  identity: () => NodeIdentity,
  applyProtection?: (link: NodeReplicationLink, mode: 'managed', secret: string) => Promise<void>) {
  let flight: Promise<void> | undefined;
  let stopped = false;
  let pauseCount = 0;
  let disabledProbeCursor = 0;
  const physicalFlights = new Map<string, Promise<void>>();
  const schedulePhysical = (username: string, ledgerId: string): void => {
    const key = `${username}\0${ledgerId}`;
    if (stopped || pauseCount > 0 || physicalFlights.has(key)) return;
    const work = (async () => {
      const [inventory, status] = await Promise.all([
        store.replicaInventory(username, ledgerId), store.replicaPhysicalStatus(username, ledgerId),
      ]);
      const sameScan = status.blobHash === inventory.blobHash;
      if (sameScan && status.verifiedAt && Date.now() - Date.parse(status.verifiedAt) < 24 * 60 * 60_000) return;
      if (sameScan && status.issue && status.scannedAt
        && Date.now() - Date.parse(status.scannedAt) < 10 * 60_000) return;
      // Reuse the catalog snapshot that selected this scan. The second catalog
      // read after hashing still detects attachments changed during verification.
      await verifyReplicaPhysical(store, blobStore, username, ledgerId, () => stopped, inventory);
    })()
      .catch(async (error) => {
        await store.recordReplicaPhysicalFailure(username, ledgerId,
          `本地副本无法校验：${String(error).slice(0, 300)}`);
      }).finally(() => { physicalFlights.delete(key); });
    physicalFlights.set(key, work);
  };
  const run = (): Promise<void> => {
    if (stopped || pauseCount > 0) return Promise.resolve();
    if (flight) return flight;
    flight = (async () => {
      const pendingRevocations = await store.pendingNodeRevocations();
      let revocationIndex = 0;
      const revocationWork = Promise.all(Array.from({ length: Math.min(4, pendingRevocations.length) }, async () => {
        while (revocationIndex < pendingRevocations.length) {
          const link = pendingRevocations[revocationIndex++]!;
          try { await revokeNodeLinkGrant(store, identity(), link); }
          catch (error) { await store.recordNodeRevocationResult(link.linkId, String(error)); }
        }
      }));
      const failed = new Set<string>();
      const roundStarted = new Map<string, number>();
      const stages = new Map<string, { identityDone: boolean; credentialsDone: boolean; commitsDone: boolean;
        promiseDone: boolean; statePullDone: boolean; statePushDone: boolean; blobPullDone: boolean; blobPushDone: boolean }>();
      // Keep a large first copy moving without waiting for the ten-second scheduler
      // after every page. Each stream stops after its own full sweep; otherwise
      // a busy attachment stream repeatedly probes identity and completed streams.
      for (let round = 0; round < 32 && pauseCount === 0; round += 1) {
        const links = [];
        for (const link of await store.listNodeReplicationLinks()) {
          if (!failed.has(link.linkId) && !await store.passiveGroupSourceLink(link)) links.push(link);
        }
        if (!links.length) break;
        for (const link of links) {
          if (pauseCount > 0) break;
          if (!roundStarted.has(link.linkId)) roundStarted.set(link.linkId, Date.now());
          // A run stops after 32 pages. If one direction finished a sweep while
          // the other still has a cursor, keep the completed direction parked
          // across runs. Once both cursors are empty, start a fresh sweep so
          // newly added objects and states can still be discovered.
          const stage = stages.get(link.linkId) ?? { identityDone: false, credentialsDone: false, commitsDone: false, promiseDone: false,
            statePullDone: Boolean(link.pushStateCursor && !link.pullStateCursor && link.pullStateSweepAt),
            statePushDone: Boolean(link.pullStateCursor && !link.pushStateCursor && link.pushStateSweepAt),
            blobPullDone: Boolean(link.pushBlobCursor && !link.pullBlobCursor && link.pullBlobSweepAt),
            blobPushDone: Boolean(link.pullBlobCursor && !link.pushBlobCursor && link.pushBlobSweepAt) };
          stages.set(link.linkId, stage);
          try {
            if (!stage.identityDone) {
              const group = await store.serverSyncGroup();
              const nativeSource = group?.role === 'member' && group.mainNodeId === link.peerNodeId
                && !await store.federatedAccount(link.username);
              if (!nativeSource) await replicateNodeAccountIdentity(store, identity(), link);
              await replicateNodeEnvelope(store, identity(), link);
              if (!nativeSource) await replicateNodeGroupPolicy(store, identity(), link);
              if (!nativeSource && applyProtection) await replicateNodeProtection(identity(), link, applyProtection);
              stage.identityDone = true;
            }
            if (!stage.credentialsDone) stage.credentialsDone = await replicateNodeAccountDirectory(store, identity(), link);
            if (!stage.commitsDone) await replicateNodeLink(store, identity(), link);
            if (stage.commitsDone && !stage.promiseDone) {
              stage.promiseDone = await replicateNodeAttachmentPromise(store, identity(), link);
            }
            if (!stage.statePullDone || !stage.statePushDone) {
              await replicateNodeBlobStates(store, blobStore, identity(), link,
                { pull: !stage.statePullDone, push: !stage.statePushDone });
            }
            if (!stage.blobPullDone || !stage.blobPushDone) {
              await replicateNodeBlobs(store, blobStore, identity(), link,
                { pull: !stage.blobPullDone, push: !stage.blobPushDone });
            }
          } catch (error) {
            failed.add(link.linkId);
            if (error instanceof NodeReplicaRetiredError) {
              const notice = error.notice;
              if (notice.serverId === link.peerNodeId && notice.replicaId === link.peerReplicaId
                && notice.streamEpoch === link.peerStreamEpoch && notice.ledgerId === link.ledgerId
                && notice.grantId === link.grantId && notice.retiredNodeId === identity().nodeId
                && typeof notice.retiredAt === 'string') {
                await store.fenceRetiredReplica(link, link.peerNodeId, notice.retiredAt);
                continue;
              }
            }
            await store.updateNodeReplicationLink(link.linkId, { error: String(error).slice(0, 500) });
          }
        }
        const progress = (await store.listNodeReplicationLinks()).filter((link) => !failed.has(link.linkId));
        let pending = false;
        for (const link of progress) {
          const stage = stages.get(link.linkId)!;
          stage.commitsDone ||= link.pullSeq >= link.peerHeadSeq && link.pushSeq >= link.localHeadSeq;
          stage.statePullDone ||= !link.pullStateCursor;
          stage.statePushDone ||= !link.pushStateCursor;
          stage.blobPullDone ||= !link.pullBlobCursor;
          stage.blobPushDone ||= !link.pushBlobCursor;
          pending ||= !stage.identityDone || !stage.credentialsDone
            || !stage.commitsDone || !stage.promiseDone || !stage.statePullDone || !stage.statePushDone
            || !stage.blobPullDone || !stage.blobPushDone;
        }
        if (!pending) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      for (const link of (await store.listNodeReplicationLinks()).filter((item) => !failed.has(item.linkId))) {
        if (pauseCount > 0) break;
        const stage = stages.get(link.linkId);
        if (!stage?.identityDone || !stage.credentialsDone
          || !stage.commitsDone || !stage.promiseDone || !stage.statePullDone || !stage.statePushDone
          || !stage.blobPullDone || !stage.blobPushDone) {
          await store.recordNodeLinkLifecycle(link.linkId,
            stage?.identityDone ? 'CATCHING_UP' : 'BOOTSTRAPPING');
          continue;
        }
        try {
          const matched = await verifyNodeReplicaInventory(store, identity(), link);
          const [inventory, physical, current] = await Promise.all([
            store.replicaInventory(link.username, link.ledgerId),
            store.replicaPhysicalStatus(link.username, link.ledgerId),
            store.listNodeReplicationLinks(link.username),
          ]);
          const currentLink = current.find((item) => item.linkId === link.linkId);
          if (!currentLink?.enabled) continue;
          const assessment = assessReplicaReadiness({ inventory, physical, links: [currentLink],
            verifiedLinkIds: matched ? new Set([link.linkId]) : new Set(),
            snapshotStable: Boolean(matched && JSON.stringify(matched) === JSON.stringify(inventory)) });
          await store.recordNodeLinkLifecycle(link.linkId, matched || assessment.state === 'BOOTSTRAPPING'
            ? assessment.state : 'CATCHING_UP');
        }
        catch (error) { await store.updateNodeReplicationLink(link.linkId, { error: String(error).slice(0, 500) }); }
      }
      // Count one complete worker visit per link, including pages, inventory and failures.
      for (const link of await store.listNodeReplicationLinks(undefined, true)) {
        const started = roundStarted.get(link.linkId);
        if (started === undefined) continue;
        const outcome = failed.has(link.linkId) || Boolean(link.lastError) ? 'failed'
          : link.lifecycleState === 'READY' ? 'converged' : 'partial';
        await store.recordNodeReplicationRound(link.linkId, outcome, Date.now() - started);
      }
      // Every local slot is scanned, including one whose peer failed above.
      // Start after this copy round so bootstrap writes do not make the scan stale.
      for (const slot of await store.listReplicaSlots()) schedulePhysical(slot.username, slot.ledgerId);
      // The hub cannot infer a member's local disk and link state from inbound
      // replication traffic. Send a bounded, signed self-report every worker run.
      for (const link of await store.listNodeReplicationLinks()) {
        if (pauseCount > 0) break;
        try {
          const [inventory, physical] = await Promise.all([
            store.replicaInventory(link.username, link.ledgerId),
            store.replicaPhysicalStatus(link.username, link.ledgerId),
          ]);
          if (inventory.streamEpoch !== link.localStreamEpoch) throw new Error('本地副本流世代已改变');
          const response = await signedCall(identity(), link, 'POST', '/api/v4/replication/health-report',
            JSON.stringify({ sourceReplicaId: link.peerReplicaId, sourceStreamEpoch: link.peerStreamEpoch,
              inventory, physical, lifecycleState: link.lifecycleState,
              lifecycleCheckedAt: link.lifecycleCheckedAt }));
          checkPeer(response, link);
          const group = await signedCall(identity(), link, 'GET', '/api/v4/replication/group-state');
          checkPeer(group, link);
          const parsed = parseNodeReplicaGroupSnapshot(group, link.peerNodeId,
            link.peerPublicKey, link.peerReplicaId, link.peerStreamEpoch, link.ledgerId,
            identity().nodeId, identity().publicKey);
          if (!parsed) throw new Error('中继副本组目录格式或本节点身份不匹配');
          await store.recordNodeGroupSnapshot(link.linkId, group);
        } catch {
          // A peer on an older protocol may not accept health reports. The
          // coordinator will mark that member missing without stopping data copy.
          await store.invalidateNodeGroupSnapshot(link.linkId);
        }
      }
      // A deliberately stopped link does not copy data, but its old node still
      // needs to learn a later group removal when the coordinator is reachable.
      const disabled = (await store.listNodeReplicationLinks(undefined, true))
        .filter((link) => !link.enabled);
      const probeCount = Math.min(4, disabled.length);
      const selectedDisabled = Array.from({ length: probeCount }, (_, index) =>
        disabled[(disabledProbeCursor + index) % disabled.length]!);
      if (disabled.length) disabledProbeCursor = (disabledProbeCursor + probeCount) % disabled.length;
      await Promise.all(selectedDisabled.map(async (link) => {
        if (pauseCount > 0) return;
        try {
          const replica = await store.getReplicaForLedger(link.username, link.ledgerId);
          if (!replica || await store.replicaRetirement(replica.replicaId)) return;
          const status = await signedCall(identity(), link, 'GET',
            '/api/v4/replication/member-status', undefined, 5_000);
          checkPeer(status, link);
          if (status.grantId === link.grantId && status.retiredNodeId === identity().nodeId
            && typeof status.retiredAt === 'string') {
            await store.fenceRetiredReplica(link, link.peerNodeId, status.retiredAt);
          }
        } catch {
          // Older coordinators and unreachable peers cannot prove retirement.
        }
      }));
      await revocationWork;
    })().finally(() => { flight = undefined; });
    return flight;
  };
  const drain = async () => {
    await flight;
    await Promise.all(physicalFlights.values());
  };
  return { run, stop: () => { stopped = true; }, drain,
    pause: async () => {
      pauseCount += 1;
      try { await drain(); }
      catch (error) { pauseCount = Math.max(0, pauseCount - 1); throw error; }
    },
    resume: () => { pauseCount = Math.max(0, pauseCount - 1); } };
}
