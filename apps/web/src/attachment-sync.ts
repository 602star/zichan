import {
  attachmentRemoteBlobId,
  attachmentPromiseDigest,
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
import { authenticateSyncProfile, hasAccountSession } from './sync-auth.js';
import { accountLocalStorage } from './account-storage.js';
import { withSyncLock } from './sync-lock.js';

const CHUNK_BYTES = 4 * 1024 * 1024;
const STATUS_BATCH_SIZE = 500;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const ATTACHMENT_BATCH_BYTES = 64 * 1024 * 1024;
const ATTACHMENT_BATCH_OBJECTS = 8;

export const ATTACHMENT_SYNC_STATE_EVENT = 'zichan:attachment-sync-state';

export type RemoteAttachmentState = 'available' | 'trash' | 'missing';

export interface AttachmentBlobReference extends AttachmentBlobDescriptor {
  kind: 'content' | 'thumbnail';
  attachmentIds: string[];
}

export interface AttachmentServerUsage {
  quotaBytes: number | null;
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

export interface LegacyAttachmentMigrationProgress {
  phase: 'checking' | 'copying' | 'complete';
  objectsTotal: number;
  objectsMigrated: number;
  objectsFailed: number;
  bytesTotal: number;
  bytesMigrated: number;
  currentAlias?: string;
}

export interface AttachmentBatchResult {
  profileId: string;
  references: number;
  scannedThrough: number;
  scanned: number;
  uploaded: number;
  downloaded: number;
  migrated: number;
  failed: number;
  bytesUploaded: number;
  bytesDownloaded: number;
  sweepComplete: boolean;
  error?: string;
}

export const ATTACHMENT_BATCH_EVENT = 'zichan:attachment-batch';

export interface AttachmentSyncTarget {
  profile: SyncConnection;
  identity: SyncReplicaIdentity;
  /** Required only when publishing a catalog after a complete commit sync. */
  headSeq?: number;
}

interface AttachmentPromiseCatalog {
  commitCount: number;
  commitHash: string;
  blobCount: number;
  blobHash: string;
}

interface AttachmentPromiseUpload {
  uploadId: string;
  commitCount: number;
  commitHash: string;
  expectedCount: number;
  receivedCount: number;
  lastBlobId: string;
}

interface BlobManifestChunk {
  index: number;
  sizeBytes: number;
  ciphertextSha256: string;
  iv: string;
}

interface BlobManifest {
  v: 1 | 2;
  blobId: string;
  cipherBytes: number;
  chunkCount: number;
  chunks: BlobManifestChunk[];
}

interface UploadPlan {
  status: 'available' | 'upload';
  uploadId?: string;
  missingChunks: number[];
  quotaBytes: number | null;
  usedBytes: number;
}

interface TargetRuntime {
  historical?: Map<string, { context: AttachmentCryptoContext; remoteBlobId: string }>;
  legacyUsernames: string[];
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

  async legacyRoutes(): Promise<string[]> {
    return (await this.json<{ usernames: string[] }>('/api/v3/blobs/legacy-routes')).usernames;
  }

  async markLegacyMigrated(legacyBlobId: string, portableBlobId: string): Promise<void> {
    await this.json('/api/v3/blobs/legacy-migrations', { method: 'POST',
      body: JSON.stringify({ legacyBlobId, portableBlobId }) });
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

  async attachmentPromise(): Promise<AttachmentPromiseCatalog | null> {
    return (await this.json<{ catalog: AttachmentPromiseCatalog | null }>(
      '/api/v4/ledger/attachment-promise?limit=1')).catalog;
  }

  async beginAttachmentPromise(expectedCount: number): Promise<AttachmentPromiseUpload> {
    return this.json<AttachmentPromiseUpload>('/api/v4/ledger/attachment-promise/uploads', {
      method: 'POST', body: JSON.stringify({ expectedCount }),
    });
  }

  async attachmentPromiseUpload(uploadId: string): Promise<AttachmentPromiseUpload> {
    return this.json<AttachmentPromiseUpload>(`/api/v4/ledger/attachment-promise/uploads/${uploadId}`);
  }

  async appendAttachmentPromisePage(uploadId: string, blobIds: string[]): Promise<AttachmentPromiseUpload> {
    return this.json<AttachmentPromiseUpload>(`/api/v4/ledger/attachment-promise/uploads/${uploadId}/pages`, {
      method: 'POST', body: JSON.stringify({ blobIds }),
    });
  }

  async completeAttachmentPromise(uploadId: string): Promise<AttachmentPromiseCatalog> {
    return (await this.json<{ catalog: AttachmentPromiseCatalog }>(
      `/api/v4/ledger/attachment-promise/uploads/${uploadId}/complete`,
      { method: 'POST', body: '{}' })).catalog;
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
    keyVersion: 2,
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
    v: 'serverId' in context.routing ? 1 : 2,
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
    const failure = runtime.historical?.has(ref.sha256) && errorMessage(error).includes('QUOTA_EXCEEDED')
      ? new Error('旧附件迁移需要临时配额空余；请让节点管理员提高附件配额，并确认磁盘可容纳旧版与新版密文后重试')
      : error;
    runtime.result.failed += 1;
    await store.attachmentState.putReplicaBlob(replicaRow(profileId, ref, remoteBlobId, {
      state: 'error',
      retryAt: retryAt(),
      error: errorMessage(failure),
    }));
    throw failure;
  }
}

function validateManifest(manifest: BlobManifest, remoteBlobId: string): void {
  if ((manifest.v !== 1 && manifest.v !== 2) || manifest.blobId !== remoteBlobId || !Number.isSafeInteger(manifest.chunkCount)
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
  const historical = runtime.historical?.get(ref.sha256);
  if (historical) runtime = { ...runtime, context: historical.context, remoteIds: new Map(runtime.remoteIds).set(ref.sha256, historical.remoteBlobId) };
  const profileId = runtime.target.profile.id;
  const remoteBlobId = runtime.remoteIds.get(ref.sha256)!;
  await store.attachmentState.putReplicaBlob(replicaRow(profileId, ref, remoteBlobId, { state: 'downloading', error: undefined }));
  try {
    const manifest = await runtime.client.manifest(remoteBlobId);
    validateManifest(manifest, remoteBlobId);
    if (manifest.v !== ('serverId' in runtime.context.routing ? 1 : 2)) throw new Error('服务器附件加密格式与密钥范围不一致');
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
  if (!hasAccountSession(credential)) throw new Error('认证失败：请先登录服务器账号');
  if (target.identity.ledgerId !== target.profile.ledgerId && target.profile.ledgerId) throw new Error('服务器账本身份与本机配置不一致');
  const healthResponse = await fetch(`${buildSyncBaseUrl(target.profile)}/api/health`, { redirect: 'error' });
  if (!healthResponse.ok) throw new Error('附件同步无法检查服务器能力');
  const health = await healthResponse.json() as { serverId?: string; capabilities?: string[] };
  if (health.serverId !== target.identity.serverId) throw new Error('附件同步服务器身份已改变');
  const session = requireLedgerCryptoSession(target.identity.ledgerId);
  const context = await deriveAttachmentCryptoContext(session, health.capabilities?.includes('portable-blobs-v2')
    ? { v: 2, ledgerId: target.identity.ledgerId }
    : { serverId: target.identity.serverId, ledgerId: target.identity.ledgerId, username: target.profile.username.trim() });
  const remoteIds = new Map<string, string>();
  for (const ref of refs) remoteIds.set(ref.sha256, await attachmentRemoteBlobId(context, ref.sha256));
  const client = new AttachmentBlobClient(target.profile);
  return {
    target,
    client,
    context,
    legacyUsernames: health.capabilities?.includes('legacy-blob-routes-v1')
      ? await client.legacyRoutes() : [],
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

async function loadRemoteStates(runtime: TargetRuntime, refs: AttachmentBlobReference[], scanHistorical = true): Promise<void> {
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
  if (!scanHistorical) return;
  // A protection change uses fresh attachment keys. Old objects remain readable;
  // new content is always uploaded with the current secret and object IDs.
  const session = requireLedgerCryptoSession(runtime.target.identity.ledgerId);
  const legacyRoutings = [...new Set([runtime.target.profile.username.trim(), ...runtime.legacyUsernames])]
    .map((username) => ({ serverId: runtime.target.identity.serverId,
      ledgerId: runtime.target.identity.ledgerId, username }));
  for (const { secret, routing } of [
    ...legacyRoutings.map((routing) => ({ secret: session.attachmentSecret, routing })),
    ...(session.retiredAttachmentSecrets ?? []).flatMap((secret) => [
      { secret, routing: runtime.context.routing },
      ...legacyRoutings.map((routing) => ({ secret, routing })),
    ]),
  ]) {
    const auditV1 = 'serverId' in routing && runtime.legacyUsernames.includes(routing.username);
    const missing = refs.filter((ref) => !runtime.historical?.has(ref.sha256)
      && (runtime.states.get(ref.sha256) !== 'available' || auditV1));
    if (!missing.length) continue;
    const context = await deriveAttachmentCryptoContext({ ...session, attachmentSecret: secret }, routing);
    const ids = await Promise.all(missing.map((ref) => attachmentRemoteBlobId(context, ref.sha256)));
    const old = await runtime.client.status(ids);
    for (const [index, ref] of missing.entries()) {
      const id = ids[index]!;
      if (old.objects[id] !== 'available' && old.objects[id] !== 'trash') continue;
      if (old.objects[id] === 'trash') await runtime.client.restore(id);
      runtime.historical ??= new Map();
      runtime.historical.set(ref.sha256, { context, remoteBlobId: id });
      runtime.states.set(ref.sha256, 'available');
    }
  }
}

async function markLegacyMigration(runtime: TargetRuntime, ref: AttachmentBlobReference): Promise<void> {
  const historical = runtime.historical?.get(ref.sha256);
  if (!historical || !('serverId' in historical.context.routing)
    || 'serverId' in runtime.context.routing) return;
  await runtime.client.markLegacyMigrated(historical.remoteBlobId, runtime.remoteIds.get(ref.sha256)!);
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

async function publishAttachmentPromise(runtime: TargetRuntime, refs: AttachmentBlobReference[]): Promise<void> {
  const headSeq = runtime.target.headSeq;
  if (typeof headSeq !== 'number' || !Number.isSafeInteger(headSeq) || headSeq < 0) {
    throw new Error('附件承诺缺少已同步的提交前沿');
  }
  const blobIds = refs.map((ref) => runtime.remoteIds.get(ref.sha256)!).sort();
  const blobHash = attachmentPromiseDigest(blobIds);
  const checkpointKey = `zichan:attachment-promise:${runtime.target.profile.id}:${runtime.target.identity.serverId}:${runtime.target.identity.replicaId}`;
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(checkpointKey) ?? 'null') as Record<string, unknown> | null; }
    catch { return null; }
  })();
  const clearCheckpoint = () => { try { localStorage.removeItem(checkpointKey); } catch { /* Storage may be disabled. */ } };
  const current = await runtime.client.attachmentPromise();
  if (current && current.commitCount === headSeq
    && current.blobCount === blobIds.length && current.blobHash === blobHash) {
    clearCheckpoint();
    return;
  }
  let upload: AttachmentPromiseUpload | undefined;
  if (saved && typeof saved['uploadId'] === 'string' && /^[a-f0-9]{32}$/.test(saved['uploadId'])
    && saved['blobHash'] === blobHash && saved['headSeq'] === headSeq) {
    try {
      const resumed = await runtime.client.attachmentPromiseUpload(saved['uploadId']);
      if (resumed.expectedCount === blobIds.length
        && Number.isSafeInteger(resumed.receivedCount) && resumed.receivedCount >= 0
        && resumed.receivedCount <= blobIds.length
        && resumed.lastBlobId === (blobIds[resumed.receivedCount - 1] ?? '')) upload = resumed;
    } catch { /* Expired uploads are restarted below. */ }
  }
  if (!upload) {
    clearCheckpoint();
    upload = await runtime.client.beginAttachmentPromise(blobIds.length);
    try { localStorage.setItem(checkpointKey, JSON.stringify({
      uploadId: upload.uploadId, blobHash, headSeq,
    })); } catch { /* A live upload still works without persistent storage. */ }
  }
  for (let offset = upload.receivedCount; offset < blobIds.length; offset += 2000) {
    upload = await runtime.client.appendAttachmentPromisePage(upload.uploadId,
      blobIds.slice(offset, offset + 2000));
  }
  const published = await runtime.client.completeAttachmentPromise(upload.uploadId);
  if (published.blobCount !== blobIds.length || published.blobHash !== blobHash) {
    throw new Error('服务器确认的附件承诺目录与本地引用不一致');
  }
  clearCheckpoint();
}

export async function syncAttachmentReplicas(
  store: SqlLedgerStore,
  targets: AttachmentSyncTarget[],
  publishPromises = false,
  onLegacyMigrationProgress?: (progress: LegacyAttachmentMigrationProgress) => void,
  deferAttachmentTransfers = false,
): Promise<AttachmentSyncResult> {
  onLegacyMigrationProgress?.({ phase: 'checking', objectsTotal: 0, objectsMigrated: 0,
    objectsFailed: 0, bytesTotal: 0, bytesMigrated: 0 });
  if (!deferAttachmentTransfers) await reconcileAttachmentStorage(store);
  const refs = await listAttachmentBlobReferences(store);
  const refByHash = new Map(refs.map((ref) => [ref.sha256, ref]));
  const activeHashes = new Set(refs.map((ref) => ref.sha256));
  const localReady = new Set<string>();
  if (deferAttachmentTransfers) {
    const active = new Set(refs.map((ref) => ref.sha256));
    for (const row of await store.attachmentState.listBlobs()) {
      if (row.state === 'ready' && active.has(row.sha256)) localReady.add(row.sha256);
    }
  } else {
    for (const ref of refs) if (await attachmentStorageStatus(ref.sha256) === 'ready') localReady.add(ref.sha256);
  }

  const runtimes: TargetRuntime[] = [];
  for (const target of targets) {
    let runtime: TargetRuntime | undefined;
    try {
      runtime = await createRuntime(target, refs);
      await loadRemoteStates(runtime, refs, !deferAttachmentTransfers);
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
        legacyUsernames: [],
        remoteIds: new Map(),
        states: new Map(),
        result,
      });
    }
  }

  const healthy = runtimes.filter((runtime) => !runtime.result.error && runtime.remoteIds.size === refs.length);
  const legacyTasks = new Map<string, { sizeBytes: number; state: 'pending' | 'migrated' | 'failed' }>();
  const legacyKey = (runtime: TargetRuntime, ref: AttachmentBlobReference) =>
    `${runtime.target.profile.id}:${ref.sha256}`;
  for (const runtime of healthy) for (const hash of runtime.historical?.keys() ?? []) {
    const ref = refByHash.get(hash);
    if (ref) legacyTasks.set(legacyKey(runtime, ref), { sizeBytes: ref.sizeBytes, state: 'pending' });
  }
  const legacyBytesTotal = [...legacyTasks.values()].reduce((sum, task) => sum + task.sizeBytes, 0);
  let legacyMigrated = 0;
  let legacyFailed = 0;
  let legacyBytesMigrated = 0;
  const reportMigration = (phase: LegacyAttachmentMigrationProgress['phase'], currentAlias?: string) => {
    if (!onLegacyMigrationProgress) return;
    onLegacyMigrationProgress({ phase, objectsTotal: legacyTasks.size,
      objectsMigrated: legacyMigrated, objectsFailed: legacyFailed,
      bytesTotal: legacyBytesTotal, bytesMigrated: legacyBytesMigrated,
      ...(currentAlias ? { currentAlias } : {}),
    });
  };
  reportMigration(legacyTasks.size ? 'copying' : 'complete');
  const markMigration = (runtime: TargetRuntime, ref: AttachmentBlobReference, state: 'migrated' | 'failed') => {
    const task = legacyTasks.get(legacyKey(runtime, ref));
    if (!task) return;
    if (task.state === 'migrated') { legacyMigrated -= 1; legacyBytesMigrated -= task.sizeBytes; }
    if (task.state === 'failed') legacyFailed -= 1;
    task.state = state;
    if (state === 'migrated') { legacyMigrated += 1; legacyBytesMigrated += task.sizeBytes; }
    else legacyFailed += 1;
    reportMigration('copying', runtime.target.profile.alias);
  };
  // A legacy object can still restore a missing local file, but new uploads use the portable ID.
  for (const runtime of healthy) for (const ref of refs) {
    if (localReady.has(ref.sha256) && runtime.historical?.has(ref.sha256)) runtime.states.set(ref.sha256, 'missing');
  }
  if (!deferAttachmentTransfers) for (const runtime of healthy) {
    for (const ref of refs) {
      if (!localReady.has(ref.sha256) || runtime.states.get(ref.sha256) === 'available') continue;
      try {
        if (runtime.historical?.has(ref.sha256)) reportMigration('copying', runtime.target.profile.alias);
        await uploadReference(store, runtime, ref);
        await markLegacyMigration(runtime, ref);
        markMigration(runtime, ref, 'migrated');
      } catch (error) {
        markMigration(runtime, ref, 'failed');
        rememberError(runtime, error);
      }
    }
  }

  if (!deferAttachmentTransfers) for (const ref of refs) {
    if (localReady.has(ref.sha256)) continue;
    const available = healthy
      .filter((runtime) => runtime.states.get(ref.sha256) === 'available')
      .sort((left, right) => (left.target.profile.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (right.target.profile.lastLatencyMs ?? Number.MAX_SAFE_INTEGER));
    const needsRelay = available.length > 0 && healthy.some((runtime) => runtime.states.get(ref.sha256) !== 'available'
      || runtime.historical?.has(ref.sha256));
    // Remote copies already satisfy replica durability. Fetch both content and thumbnails
    // only when another endpoint needs this browser to relay; previews fetch on demand.
    if (!available.length || !needsRelay) continue;
    try {
      if (available[0]!.historical?.has(ref.sha256)) reportMigration('copying', available[0]!.target.profile.alias);
      await downloadReference(store, available[0]!, ref);
      localReady.add(ref.sha256);
      for (const runtime of healthy) if (runtime.historical?.has(ref.sha256)) runtime.states.set(ref.sha256, 'missing');
    } catch (error) {
      rememberError(available[0]!, error);
    }
  }

  for (const runtime of healthy) {
    if (!deferAttachmentTransfers) for (const ref of refs) {
      if (!localReady.has(ref.sha256) || runtime.states.get(ref.sha256) === 'available') continue;
      try {
        if (runtime.historical?.has(ref.sha256)) reportMigration('copying', runtime.target.profile.alias);
        await uploadReference(store, runtime, ref);
        await markLegacyMigration(runtime, ref);
        markMigration(runtime, ref, 'migrated');
      } catch (error) {
        markMigration(runtime, ref, 'failed');
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

  reportMigration('complete');
  if (publishPromises) for (const runtime of healthy) {
    if ('serverId' in runtime.context.routing) continue;
    if (deferAttachmentTransfers && refs.some((ref) => runtime.states.get(ref.sha256) !== 'available')) continue;
    try { await publishAttachmentPromise(runtime, refs); }
    catch (error) { rememberError(runtime, error); }
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

function attachmentBatchCursorKey(target: AttachmentSyncTarget): string {
  const { serverId, replicaId, streamEpoch, ledgerId } = target.identity;
  return `zichan:attachment-batch-cursor:v1:${serverId}:${replicaId}:${streamEpoch}:${ledgerId}`;
}

const volatileBatchCursors = new Map<string, string>();

/** Scan a small, stable slice of references so attachment transfers cannot hold up commit sync. */
export function syncAttachmentBatch(
  store: SqlLedgerStore,
  target: AttachmentSyncTarget,
): Promise<AttachmentBatchResult> {
  return withSyncLock(() => syncAttachmentBatchNow(store, target));
}

async function syncAttachmentBatchNow(
  store: SqlLedgerStore,
  target: AttachmentSyncTarget,
): Promise<AttachmentBatchResult> {
  if (await store.getLedgerId() !== target.identity.ledgerId
    || target.profile.serverId !== target.identity.serverId
    || target.profile.replicaId !== target.identity.replicaId
    || target.profile.streamEpoch !== target.identity.streamEpoch) {
    throw new Error('附件批次的账本或副本身份与本机配置不一致');
  }
  const result: AttachmentBatchResult = {
    profileId: target.profile.id, references: 0, scannedThrough: 0,
    scanned: 0, uploaded: 0, downloaded: 0, migrated: 0, failed: 0,
    bytesUploaded: 0, bytesDownloaded: 0, sweepComplete: false,
  };
  const refs = (await listAttachmentBlobReferences(store))
    .sort((left, right) => left.sha256.localeCompare(right.sha256));
  result.references = refs.length;
  if (!refs.length) {
    result.sweepComplete = true;
    globalThis.dispatchEvent?.(new CustomEvent(ATTACHMENT_BATCH_EVENT, { detail: result }));
    return result;
  }
  const key = attachmentBatchCursorKey(target);
  let cursor = volatileBatchCursors.get(key) ?? '';
  try { cursor = accountLocalStorage.getItem(key) ?? ''; } catch { /* Continue in this session. */ }
  let start = refs.findIndex((ref) => ref.sha256 > cursor);
  if (start < 0) start = 0;
  const selected: AttachmentBlobReference[] = [];
  let bytes = 0;
  for (let index = start; index < refs.length && selected.length < ATTACHMENT_BATCH_OBJECTS; index += 1) {
    const ref = refs[index]!;
    if (selected.length && bytes + ref.sizeBytes > ATTACHMENT_BATCH_BYTES) break;
    selected.push(ref);
    bytes += ref.sizeBytes;
  }
  const runtime = await createRuntime(target, selected);
  await loadRemoteStates(runtime, selected);
  for (const ref of selected) {
    try {
      if (runtime.states.get(ref.sha256) !== 'available' || runtime.historical?.has(ref.sha256)) {
        const previous = await store.attachmentState.getReplicaBlob(target.profile.id, ref.sha256);
        if (!(previous?.state === 'error' && previous.retryAt && Date.parse(previous.retryAt) > Date.now())) {
          let local = await attachmentStorageStatus(ref.sha256);
          if (local === 'trash' && await restoreAttachmentBlobFromTrash(store, ref)) local = 'ready';
          if (local !== 'ready' && runtime.historical?.has(ref.sha256)) {
            await downloadReference(store, runtime, ref);
            local = 'ready';
            result.downloaded += 1;
            result.bytesDownloaded += ref.sizeBytes;
          }
          if (local === 'ready') {
            const uploadedBefore = runtime.result.uploaded;
            await uploadReference(store, runtime, ref);
            await markLegacyMigration(runtime, ref);
            const uploaded = runtime.result.uploaded - uploadedBefore;
            result.uploaded += uploaded;
            if (runtime.historical?.has(ref.sha256) && !('serverId' in runtime.context.routing)) result.migrated += 1;
            result.bytesUploaded += uploaded ? ref.sizeBytes : 0;
          }
        }
      }
    } catch (error) {
      result.failed += 1;
      result.error ??= errorMessage(error);
    } finally {
      result.scanned += 1;
      volatileBatchCursors.set(key, ref.sha256);
      try { accountLocalStorage.setItem(key, ref.sha256); } catch { /* A later sweep can retry. */ }
    }
  }
  result.sweepComplete = start + selected.length === refs.length;
  result.scannedThrough = start + selected.length;
  globalThis.dispatchEvent?.(new CustomEvent(ATTACHMENT_BATCH_EVENT, { detail: result }));
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
      .filter((profile) => profile.enabled && profile.serverId && profile.ledgerId === ledgerId && profile.username.trim() && hasAccountSession(runtimeCredential(profile.id)))
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
