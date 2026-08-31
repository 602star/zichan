import {
  attachmentRemoteBlobId,
  decryptAttachmentChunk,
  deriveAttachmentCryptoContext,
  encryptAttachmentChunk,
  sha256Bytes,
  type Attachment,
  type AttachmentCryptoContext,
} from '@zichan/core';
import {
  type AttachmentReplicaBlobRow,
  type SqlLedgerStore,
  type SyncReplicaIdentity,
} from '@zichan/db';
import {
  attachmentStorageStatus,
  hashAttachmentBlob,
  installDownloadedAttachmentBlob,
  readAttachmentBlob,
  reconcileAttachmentStorage,
  restoreAttachmentBlobFromTrash,
  type AttachmentBlobDescriptor,
} from './db/attachment-storage.js';
import {
  buildSyncBaseUrl,
  isUnauthorizedSyncError,
  loadSyncConnections,
  type SyncConnection,
} from './sync-config.js';
import { runtimeCredential } from './credential-vault.js';
import { requireLedgerCryptoSession } from './ledger-key-vault.js';
import { authenticateSyncProfile } from './sync-auth.js';

const CHUNK_BYTES = 4 * 1024 * 1024;
const STATUS_BATCH_SIZE = 500;
const RETRY_DELAY_MS = 5 * 60 * 1000;

export const ATTACHMENT_SYNC_STATE_EVENT = 'zichan:attachment-sync-state';

export type RemoteAttachmentState = 'available' | 'trash' | 'missing';

export interface AttachmentBlobReference extends AttachmentBlobDescriptor {
  kind: 'content' | 'thumbnail';
  attachmentIds: string[];
}

export interface AttachmentServerUsage {
  quotaBytes: number;
  usedBytes: number;
  objectCount: number;
  trashBytes: number;
  trashCount: number;
  stagingBytes: number;
  stagingCount: number;
}

export interface AttachmentReplicaSyncResult {
  profileId: string;
  alias: string;
  uploaded: number;
  downloaded: number;
  restored: number;
  deleted: number;
  available: number;
  pending: number;
  failed: number;
  usage?: AttachmentServerUsage;
  error?: string;
}

export interface AttachmentSyncResult {
  endpoints: AttachmentReplicaSyncResult[];
  references: number;
  localReady: number;
  localMissing: number;
}

export interface AttachmentSyncTarget {
  profile: SyncConnection;
  identity: SyncReplicaIdentity;
}

interface BlobManifestChunk {
  index: number;
  sizeBytes: number;
  ciphertextSha256: string;
  iv: string;
}

interface BlobManifest {
  v: 1;
  blobId: string;
  cipherBytes: number;
  chunkCount: number;
  chunks: BlobManifestChunk[];
}

interface UploadPlan {
  status: 'available' | 'upload';
  uploadId?: string;
  missingChunks: number[];
  quotaBytes: number;
  usedBytes: number;
}

interface TargetRuntime {
  target: AttachmentSyncTarget;
  client: AttachmentBlobClient;
  context: AttachmentCryptoContext;
  remoteIds: Map<string, string>;
  states: Map<string, RemoteAttachmentState>;
  result: AttachmentReplicaSyncResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryAt(): string {
  return new Date(Date.now() + RETRY_DELAY_MS).toISOString();
}

function uniquePush(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function addReference(
  refs: Map<string, AttachmentBlobReference>,
  attachmentId: string,
  descriptor: AttachmentBlobDescriptor,
  kind: AttachmentBlobReference['kind'],
): void {
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes < 0) return;
  const current = refs.get(descriptor.sha256);
  if (current) {
    if (current.sizeBytes !== descriptor.sizeBytes) throw new Error(`附件 ${descriptor.sha256.slice(0, 12)} 的大小元数据不一致`);
    uniquePush(current.attachmentIds, attachmentId);
    if (kind === 'thumbnail') current.kind = 'thumbnail';
    return;
  }
  refs.set(descriptor.sha256, { ...descriptor, kind, attachmentIds: [attachmentId] });
}

function addAttachmentReferences(refs: Map<string, AttachmentBlobReference>, attachment: Partial<Attachment>): void {
  if (attachment.id && attachment.sha256 && attachment.sizeBytes != null) {
    addReference(refs, attachment.id, {
      sha256: attachment.sha256,
      sizeBytes: attachment.sizeBytes,
      mimeType: attachment.mimeType || 'application/octet-stream',
    }, 'content');
  }
  if (attachment.id && attachment.thumbnailSha256 && attachment.thumbnailSizeBytes != null) {
    addReference(refs, attachment.id, {
      sha256: attachment.thumbnailSha256,
      sizeBytes: attachment.thumbnailSizeBytes,
      mimeType: attachment.thumbnailMimeType || 'image/jpeg',
    }, 'thumbnail');
  }
}

export async function listAttachmentBlobReferences(store: SqlLedgerStore): Promise<AttachmentBlobReference[]> {
  const [attachments, conflicts] = await Promise.all([
    store.attachments.list(),
    store.listConflicts(),
  ]);
  const refs = new Map<string, AttachmentBlobReference>();
  for (const attachment of attachments) addAttachmentReferences(refs, attachment);
  for (const conflict of conflicts) {
    for (const branch of conflict.branches) {
      if (branch.aggregateType === 'attachment' && branch.payload) addAttachmentReferences(refs, branch.payload as Partial<Attachment>);
    }
  }
  return [...refs.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.sha256.localeCompare(right.sha256));
}

class AttachmentBlobClient {
  private readonly profile: SyncConnection;

  constructor(profile: SyncConnection) {
    this.profile = profile;
  }

  private async accessToken(forceLogin = false): Promise<string> {
    return authenticateSyncProfile(this.profile, forceLogin);
  }

  private async request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.accessToken()}`);
    const response = await fetch(`${buildSyncBaseUrl(this.profile)}${path}`, { ...init, headers, redirect: 'error' });
    if ((response.status === 401 || response.status === 403) && retry) {
      await this.accessToken(true);
      return this.request(path, init, false);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
      throw new Error(`${body.code ? `${body.code}:` : ''}${body.error || `HTTP ${response.status}`}`);
    }
    return response;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    return (await this.request(path, { ...init, headers })).json() as Promise<T>;
  }

  async status(blobIds: string[]): Promise<{ objects: Record<string, RemoteAttachmentState>; usage: AttachmentServerUsage }> {
    const objects: Record<string, RemoteAttachmentState> = {};
    let usage: AttachmentServerUsage | undefined;
    for (let offset = 0; offset < blobIds.length; offset += STATUS_BATCH_SIZE) {
      const response = await this.json<{ objects: Record<string, RemoteAttachmentState>; usage: AttachmentServerUsage }>('/api/v3/blobs/status', {
        method: 'POST',
        body: JSON.stringify({ blobIds: blobIds.slice(offset, offset + STATUS_BATCH_SIZE) }),
      });
      Object.assign(objects, response.objects);
      usage = response.usage;
    }
    if (!usage) usage = await this.usage();
    return { objects, usage };
  }

  async usage(): Promise<AttachmentServerUsage> {
    return (await this.json<{ usage: AttachmentServerUsage }>('/api/v3/blobs/usage')).usage;
  }

  async beginUpload(manifest: BlobManifest): Promise<UploadPlan> {
    return this.json<UploadPlan>('/api/v3/blobs/uploads', { method: 'POST', body: JSON.stringify({ manifest }) });
  }

  async uploadChunk(uploadId: string, index: number, contents: Uint8Array): Promise<void> {
    await this.request(`/api/v3/blobs/uploads/${uploadId}/chunks/${index}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength) as ArrayBuffer,
    });
  }

  async completeUpload(uploadId: string): Promise<void> {
    await this.json(`/api/v3/blobs/uploads/${uploadId}/complete`, { method: 'POST', body: '{}' });
  }

  async manifest(blobId: string): Promise<BlobManifest> {
    return (await this.json<{ manifest: BlobManifest }>(`/api/v3/blobs/${blobId}/manifest`)).manifest;
  }

  async chunk(blobId: string, index: number): Promise<Uint8Array> {
    return new Uint8Array(await (await this.request(`/api/v3/blobs/${blobId}/chunks/${index}`)).arrayBuffer());
  }

  async remove(blobId: string): Promise<boolean> {
    return (await this.json<{ removed: boolean }>(`/api/v3/blobs/${blobId}`, { method: 'DELETE' })).removed;
  }

  async restore(blobId: string): Promise<void> {
    await this.json(`/api/v3/blobs/${blobId}/restore`, { method: 'POST', body: '{}' });
  }
}

function replicaRow(
  profileId: string,
  ref: AttachmentBlobReference,
  remoteBlobId: string,
  patch: Partial<AttachmentReplicaBlobRow>,
): AttachmentReplicaBlobRow {
  return {
    profileId,
    sha256: ref.sha256,
    remoteBlobId,
    state: 'queued',
    keyVersion: 1,
    updatedAt: new Date().toISOString(),
    ...patch,
  };
}

async function encryptedChunk(
  context: AttachmentCryptoContext,
  ref: AttachmentBlobReference,
  blob: Blob,
  index: number,
  chunkCount: number,
) {
  const start = index * CHUNK_BYTES;
  const plaintext = new Uint8Array(await blob.slice(start, Math.min(start + CHUNK_BYTES, blob.size)).arrayBuffer());
  return encryptAttachmentChunk(context, ref.sha256, plaintext, index, chunkCount, ref.sizeBytes);
}

async function buildManifest(
  context: AttachmentCryptoContext,
  ref: AttachmentBlobReference,
  remoteBlobId: string,
  blob: Blob,
): Promise<BlobManifest> {
  const chunkCount = Math.max(1, Math.ceil(ref.sizeBytes / CHUNK_BYTES));
  const chunks: BlobManifestChunk[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const encrypted = await encryptedChunk(context, ref, blob, index, chunkCount);
    chunks.push({
      index,
      sizeBytes: encrypted.ciphertext.byteLength,
      ciphertextSha256: encrypted.ciphertextSha256,
      iv: encrypted.iv,
    });
  }
  return {
    v: 1,
    blobId: remoteBlobId,
    cipherBytes: chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0),
    chunkCount,
    chunks,
  };
}

async function uploadReference(store: SqlLedgerStore, runtime: TargetRuntime, ref: AttachmentBlobReference): Promise<void> {
  const profileId = runtime.target.profile.id;
  const remoteBlobId = runtime.remoteIds.get(ref.sha256)!;
  const blob = await readAttachmentBlob(ref.sha256, ref.mimeType);
  if (blob.size !== ref.sizeBytes) throw new Error(`附件 ${ref.sha256.slice(0, 12)} 的本机大小不一致`);
  const local = await store.attachmentState.getBlob(ref.sha256);
  if (!local?.verifiedAt) {
    const check = await hashAttachmentBlob(blob);
    if (check.sha256 !== ref.sha256 || check.sizeBytes !== ref.sizeBytes) throw new Error(`附件 ${ref.sha256.slice(0, 12)} 的本机校验失败`);
  }
  await store.attachmentState.putReplicaBlob(replicaRow(profileId, ref, remoteBlobId, { state: 'uploading', error: undefined }));
  try {
    const manifest = await buildManifest(runtime.context, ref, remoteBlobId, blob);
    const plan = await runtime.client.beginUpload(manifest);
    if (plan.status === 'available') {
      runtime.states.set(ref.sha256, 'available');
      await store.attachmentState.putReplicaBlob(replicaRow(profileId, ref, remoteBlobId, {
        state: 'available',
        verifiedAt: new Date().toISOString(),
        error: undefined,
      }));
      return;
    }
    if (!plan.uploadId) throw new Error('服务器未返回附件上传会话');
    const uploaded = new Set<number>(manifest.chunks.map((chunk) => chunk.index).filter((index) => !plan.missingChunks.includes(index)));
    await store.attachmentState.putReplicaBlob(replicaRow(profileId, ref, remoteBlobId, {
      state: 'uploading',
      uploadId: plan.uploadId,
      uploadedChunks: [...uploaded].sort((a, b) => a - b),
      error: undefined,
    }));
    for (const index of plan.missingChunks) {
      const encrypted = await encryptedChunk(runtime.context, ref, blob, index, manifest.chunkCount);
      const expected = manifest.chunks[index]!;
      if (encrypted.iv !== expected.iv || encrypted.ciphertextSha256 !== expected.ciphertextSha256) {
        throw new Error(`附件分块 ${index} 无法稳定恢复`);
      }
      await runtime.client.uploadChunk(plan.uploadId, index, encrypted.ciphertext);
      uploaded.add(index);
      await store.attachmentState.putReplicaBlob(replicaRow(profileId, ref, remoteBlobId, {
        state: 'uploading',
        uploadId: plan.uploadId,
        uploadedChunks: [...uploaded].sort((a, b) => a - b),
        error: undefined,
      }));
    }
    await runtime.client.completeUpload(plan.uploadId);
    runtime.states.set(ref.sha256, 'available');
    runtime.result.uploaded += 1;
    await store.attachmentState.putReplicaBlob(replicaRow(profileId, ref, remoteBlobId, {
      state: 'available',
      verifiedAt: new Date().toISOString(),
      error: undefined,
    }));
  } catch (error) {
    runtime.result.failed += 1;
    await store.attachmentState.putReplicaBlob(replicaRow(profileId, ref, remoteBlobId, {
      state: 'error',
      retryAt: retryAt(),
      error: errorMessage(error),
    }));
    throw error;
  }
}

function validateManifest(manifest: BlobManifest, remoteBlobId: string): void {
  if (manifest.v !== 1 || manifest.blobId !== remoteBlobId || !Number.isSafeInteger(manifest.chunkCount)
    || manifest.chunkCount < 1 || manifest.chunks.length !== manifest.chunkCount) throw new Error('服务器附件清单无效');
  let cipherBytes = 0;
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    const chunk = manifest.chunks[index]!;
    if (chunk.index !== index || !Number.isSafeInteger(chunk.sizeBytes) || chunk.sizeBytes < 16
      || !/^[a-f0-9]{64}$/.test(chunk.ciphertextSha256) || !chunk.iv) throw new Error(`服务器附件分块清单 ${index} 无效`);
    cipherBytes += chunk.sizeBytes;
  }
  if (cipherBytes !== manifest.cipherBytes) throw new Error('服务器附件清单大小不一致');
}

async function downloadReference(store: SqlLedgerStore, runtime: TargetRuntime, ref: AttachmentBlobReference): Promise<void> {
  const profileId = runtime.target.profile.id;
  const remoteBlobId = runtime.remoteIds.get(ref.sha256)!;
  await store.attachmentState.putReplicaBlob(replicaRow(profileId, ref, remoteBlobId, { state: 'downloading', error: undefined }));
  try {
    const manifest = await runtime.client.manifest(remoteBlobId);
    validateManifest(manifest, remoteBlobId);
    const parts: BlobPart[] = [];
    for (const meta of manifest.chunks) {
      const ciphertext = await runtime.client.chunk(remoteBlobId, meta.index);
      if (ciphertext.byteLength !== meta.sizeBytes || await sha256Bytes(ciphertext) !== meta.ciphertextSha256) {
        throw new Error(`附件密文分块 ${meta.index} 校验失败`);
      }
      const plaintext = await decryptAttachmentChunk(runtime.context, ref.sha256, {
        index: meta.index,
        iv: meta.iv,
        ciphertext,
        ciphertextSha256: meta.ciphertextSha256,
      }, manifest.chunkCount, ref.sizeBytes);
      parts.push(plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer);
    }
    const blob = new Blob(parts, { type: ref.mimeType });
    const check = await hashAttachmentBlob(blob);
    if (check.sha256 !== ref.sha256 || check.sizeBytes !== ref.sizeBytes) throw new Error(`附件 ${ref.sha256.slice(0, 12)} 解密后校验失败`);
    await installDownloadedAttachmentBlob(store, ref, blob);
    runtime.result.downloaded += 1;
    await store.attachmentState.putReplicaBlob(replicaRow(profileId, ref, remoteBlobId, {
      state: 'available',
      verifiedAt: new Date().toISOString(),
      error: undefined,
    }));
  } catch (error) {
    runtime.result.failed += 1;
    await store.attachmentState.putReplicaBlob(replicaRow(profileId, ref, remoteBlobId, {
      state: 'error',
      retryAt: retryAt(),
      error: errorMessage(error),
    }));
    throw error;
  }
}

async function createRuntime(target: AttachmentSyncTarget, refs: AttachmentBlobReference[]): Promise<TargetRuntime> {
  const credential = runtimeCredential(target.profile.id);
  if (!credential?.password) throw new Error('服务器账号密码尚未解锁');
  if (target.identity.ledgerId !== target.profile.ledgerId && target.profile.ledgerId) throw new Error('服务器账本身份与本机配置不一致');
  const context = await deriveAttachmentCryptoContext(requireLedgerCryptoSession(target.identity.ledgerId), {
    serverId: target.identity.serverId,
    ledgerId: target.identity.ledgerId,
    username: target.profile.username.trim(),
  });
  const remoteIds = new Map<string, string>();
  for (const ref of refs) remoteIds.set(ref.sha256, await attachmentRemoteBlobId(context, ref.sha256));
  return {
    target,
    client: new AttachmentBlobClient(target.profile),
    context,
    remoteIds,
    states: new Map(),
    result: {
      profileId: target.profile.id,
      alias: target.profile.alias,
      uploaded: 0,
      downloaded: 0,
      restored: 0,
      deleted: 0,
      available: 0,
      pending: 0,
      failed: 0,
    },
  };
}

function rememberError(runtime: TargetRuntime, error: unknown): void {
  const message = errorMessage(error);
  runtime.result.error = runtime.result.error ? `${runtime.result.error}；${message}` : message;
}

async function loadRemoteStates(runtime: TargetRuntime, refs: AttachmentBlobReference[]): Promise<void> {
  const response = await runtime.client.status([...runtime.remoteIds.values()]);
  runtime.result.usage = response.usage;
  for (const ref of refs) {
    const remoteBlobId = runtime.remoteIds.get(ref.sha256)!;
    let state = response.objects[remoteBlobId] ?? 'missing';
    if (state === 'trash') {
      await runtime.client.restore(remoteBlobId);
      state = 'available';
      runtime.result.restored += 1;
    }
    runtime.states.set(ref.sha256, state);
  }
}

async function cleanupRemoteTrash(store: SqlLedgerStore, runtime: TargetRuntime, activeHashes: Set<string>): Promise<void> {
  for (const replica of await store.attachmentState.listReplicaBlobs(runtime.target.profile.id)) {
    if (activeHashes.has(replica.sha256) || replica.state === 'trash') continue;
    try {
      if (await runtime.client.remove(replica.remoteBlobId)) runtime.result.deleted += 1;
      await store.attachmentState.putReplicaBlob({ ...replica, state: 'trash', updatedAt: new Date().toISOString(), error: undefined });
    } catch (error) {
      runtime.result.failed += 1;
      rememberError(runtime, error);
      await store.attachmentState.putReplicaBlob({ ...replica, state: 'error', retryAt: retryAt(), updatedAt: new Date().toISOString(), error: errorMessage(error) });
    }
  }
}

export async function syncAttachmentReplicas(
  store: SqlLedgerStore,
  targets: AttachmentSyncTarget[],
): Promise<AttachmentSyncResult> {
  await reconcileAttachmentStorage(store);
  const refs = await listAttachmentBlobReferences(store);
  const activeHashes = new Set(refs.map((ref) => ref.sha256));
  const localReady = new Set<string>();
  for (const ref of refs) if (await attachmentStorageStatus(ref.sha256) === 'ready') localReady.add(ref.sha256);

  const runtimes: TargetRuntime[] = [];
  for (const target of targets) {
    let runtime: TargetRuntime | undefined;
    try {
      runtime = await createRuntime(target, refs);
      await loadRemoteStates(runtime, refs);
      runtimes.push(runtime);
    } catch (error) {
      const result: AttachmentReplicaSyncResult = {
        profileId: target.profile.id,
        alias: target.profile.alias,
        uploaded: 0,
        downloaded: 0,
        restored: 0,
        deleted: 0,
        available: 0,
        pending: refs.length,
        failed: 1,
        error: errorMessage(error),
      };
      if (runtime) runtime.result = result;
      runtimes.push(runtime ?? {
        target,
        client: new AttachmentBlobClient(target.profile),
        context: {} as AttachmentCryptoContext,
        remoteIds: new Map(),
        states: new Map(),
        result,
      });
    }
  }

  const healthy = runtimes.filter((runtime) => !runtime.result.error && runtime.remoteIds.size === refs.length);
  for (const runtime of healthy) {
    for (const ref of refs) {
      if (!localReady.has(ref.sha256) || runtime.states.get(ref.sha256) === 'available') continue;
      try {
        await uploadReference(store, runtime, ref);
      } catch (error) {
        rememberError(runtime, error);
      }
    }
  }

  for (const ref of refs) {
    if (localReady.has(ref.sha256)) continue;
    const available = healthy
      .filter((runtime) => runtime.states.get(ref.sha256) === 'available')
      .sort((left, right) => (left.target.profile.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (right.target.profile.lastLatencyMs ?? Number.MAX_SAFE_INTEGER));
    const needsRelay = available.length > 0 && healthy.some((runtime) => runtime.states.get(ref.sha256) !== 'available');
    if (!available.length || (ref.kind !== 'thumbnail' && !needsRelay)) continue;
    try {
      await downloadReference(store, available[0]!, ref);
      localReady.add(ref.sha256);
    } catch (error) {
      rememberError(available[0]!, error);
    }
  }

  for (const runtime of healthy) {
    for (const ref of refs) {
      if (!localReady.has(ref.sha256) || runtime.states.get(ref.sha256) === 'available') continue;
      try {
        await uploadReference(store, runtime, ref);
      } catch (error) {
        rememberError(runtime, error);
      }
    }
    await cleanupRemoteTrash(store, runtime, activeHashes);
    try {
      runtime.result.usage = await runtime.client.usage();
    } catch (error) {
      rememberError(runtime, error);
    }
    runtime.result.available = refs.filter((ref) => runtime.states.get(ref.sha256) === 'available').length;
    runtime.result.pending = refs.length - runtime.result.available;
  }

  const result = {
    endpoints: runtimes.map((runtime) => runtime.result),
    references: refs.length,
    localReady: localReady.size,
    localMissing: refs.length - localReady.size,
  };
  globalThis.dispatchEvent?.(new CustomEvent(ATTACHMENT_SYNC_STATE_EVENT, { detail: result }));
  return result;
}

const downloads = new Map<string, Promise<void>>();

export async function ensureAttachmentBlobAvailable(
  store: SqlLedgerStore,
  descriptor: AttachmentBlobDescriptor,
): Promise<void> {
  const ledgerId = await store.getLedgerId();
  const key = `${ledgerId}:${descriptor.sha256}`;
  const existing = downloads.get(key);
  if (existing) return existing;
  const task = (async () => {
    const status = await attachmentStorageStatus(descriptor.sha256);
    if (status === 'ready') return;
    if (status === 'trash' && await restoreAttachmentBlobFromTrash(store, descriptor)) return;
    const ref: AttachmentBlobReference = { ...descriptor, kind: 'content', attachmentIds: [] };
    const candidates = loadSyncConnections()
      .filter((profile) => profile.enabled && profile.serverId && profile.ledgerId === ledgerId && profile.username.trim() && runtimeCredential(profile.id)?.password)
      .sort((left, right) => (left.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (right.lastLatencyMs ?? Number.MAX_SAFE_INTEGER));
    const errors: string[] = [];
    for (const profile of candidates) {
      const identity: SyncReplicaIdentity = {
        serverId: profile.serverId!,
        ledgerId,
        replicaId: profile.replicaId ?? 'unknown-replica',
        streamEpoch: profile.streamEpoch ?? 'unknown-epoch',
      };
      try {
        const runtime = await createRuntime({ profile, identity }, [ref]);
        await loadRemoteStates(runtime, [ref]);
        if (runtime.states.get(ref.sha256) !== 'available') continue;
        await downloadReference(store, runtime, ref);
        return;
      } catch (error) {
        errors.push(`${profile.alias}：${errorMessage(error)}`);
      }
    }
    throw new Error(errors.length ? errors.join('；') : '所有已启用服务器都没有这份附件正文');
  })().finally(() => downloads.delete(key));
  downloads.set(key, task);
  return task;
}

export function isAttachmentAuthenticationError(error: unknown): boolean {
  return isUnauthorizedSyncError(error);
}
