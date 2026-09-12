import { newId, sha256Bytes, type Attachment } from '@zichan/core';
import type {
  AttachmentBlobRow,
  AttachmentFileOpKind,
  AttachmentFileOpRow,
  SqlLedgerStore,
} from '@zichan/db';
import { deleteKv, hasKv, loadKv, moveKv, saveKv } from './idb.js';
import { isTauriRuntime, tauriInvoke } from '../tauri.js';
import {
  decryptDeviceAttachmentBlob,
  encryptDeviceAttachmentBlob,
  requireDeviceStorageSession,
} from '../device-storage-key.js';

const STAGING_PREFIX = 'attachment.stage.v2.';
const OBJECT_PREFIX = 'attachment.object.v2.';
const TRASH_PREFIX = 'attachment.trash.v2.';
const QUARANTINE_PREFIX = 'attachment.quarantine.v2.';
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NATIVE_TRANSFER_BYTES = 512 * 1024;
const STORAGE_RESERVE_BYTES = 8 * 1024 * 1024;

export interface AttachmentDraftData {
  id?: string;
  fileName: string;
  mimeType?: string;
  note?: string;
  sizeBytes?: number;
  sha256?: string;
  thumbnailSha256?: string;
  thumbnailSizeBytes?: number;
  thumbnailMimeType?: string;
  contentBlob?: Blob;
  thumbnailBlob?: Blob;
}

export interface PreparedAttachment {
  operationId?: string;
  attachmentId: string;
  metadata: Pick<Attachment,
    'fileName' | 'mimeType' | 'note' | 'sizeBytes' | 'sha256'
    | 'thumbnailSha256' | 'thumbnailSizeBytes' | 'thumbnailMimeType'>;
  tempContentKey?: string;
  tempThumbnailKey?: string;
}

export interface AttachmentBlobDescriptor {
  sha256: string;
  sizeBytes: number;
  mimeType: string;
}

interface NativeAttachmentStatus {
  path: string;
  sizeBytes: number;
}

interface NativeAttachmentStorageStatus {
  directory: string;
  availableBytes: number;
}

export interface AttachmentIoOptions {
  signal?: AbortSignal;
  onProgress?: (progress: {
    phase: 'encrypting' | 'writing' | 'reading' | 'verifying';
    transferredBytes: number;
    totalBytes: number;
  }) => void;
}

function assertSha256(sha256: string): void {
  if (!SHA256_PATTERN.test(sha256)) throw new Error('附件 SHA-256 无效');
}

function assertTempKey(tempKey: string): void {
  if (!tempKey || tempKey.length > 160 || !/^[a-zA-Z0-9_-]+$/.test(tempKey)) throw new Error('附件暂存键无效');
}

function objectKey(sha256: string): string {
  assertSha256(sha256);
  return `${OBJECT_PREFIX}${sha256}`;
}

function areaKey(area: 'objects' | 'trash' | 'quarantine', sha256: string): string {
  assertSha256(sha256);
  if (area === 'objects') return `${OBJECT_PREFIX}${sha256}`;
  if (area === 'trash') return `${TRASH_PREFIX}${sha256}`;
  return `${QUARANTINE_PREFIX}${sha256}`;
}

function stagingKey(tempKey: string): string {
  assertTempKey(tempKey);
  return `${STAGING_PREFIX}${tempKey}`;
}

function requiredInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const request = tauriInvoke<T>(command, args);
  if (!request) throw new Error(`原生附件命令不可用：${command}`);
  return request;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('附件操作已取消', 'AbortError');
}

function report(
  options: AttachmentIoOptions | undefined,
  phase: Parameters<NonNullable<AttachmentIoOptions['onProgress']>>[0]['phase'],
  transferredBytes: number,
  totalBytes: number,
): void {
  options?.onProgress?.({ phase, transferredBytes, totalBytes });
}

async function ensureStorageCapacity(requiredBytes: number): Promise<void> {
  if (isTauriRuntime()) {
    const status = await requiredInvoke<NativeAttachmentStorageStatus>('native_attachment_storage_status', {});
    if (status.availableBytes < requiredBytes + STORAGE_RESERVE_BYTES) {
      throw new Error(`附件存储空间不足：需要约 ${requiredBytes} 字节，${status.directory} 仅剩 ${status.availableBytes} 字节`);
    }
    return;
  }
  const estimate = await globalThis.navigator?.storage?.estimate?.();
  if (estimate?.quota != null && estimate.usage != null
    && estimate.quota - estimate.usage < requiredBytes + STORAGE_RESERVE_BYTES) {
    throw new Error(`浏览器存储空间不足：需要约 ${requiredBytes} 字节，仅剩 ${estimate.quota - estimate.usage} 字节`);
  }
}

export async function hashAttachmentBlob(blob: Blob): Promise<{ sha256: string; sizeBytes: number }> {
  const sha256 = await sha256Bytes(new Uint8Array(await blob.arrayBuffer()));
  return { sha256, sizeBytes: blob.size };
}

async function stagePhysical(tempKey: string, blob: Blob, options?: AttachmentIoOptions): Promise<void> {
  assertTempKey(tempKey);
  throwIfAborted(options?.signal);
  if (isTauriRuntime()) {
    await requiredInvoke<NativeAttachmentStatus>('native_attachment_stage_begin', {
      tempKey, expectedSizeBytes: blob.size,
    });
    try {
      for (let offset = 0; offset < blob.size; offset += NATIVE_TRANSFER_BYTES) {
        throwIfAborted(options?.signal);
        const chunk = new Uint8Array(await blob.slice(
          offset,
          Math.min(blob.size, offset + NATIVE_TRANSFER_BYTES),
        ).arrayBuffer());
        await requiredInvoke<NativeAttachmentStatus>('native_attachment_stage_append', {
          tempKey, chunk: [...chunk],
        });
        report(options, 'writing', offset + chunk.byteLength, blob.size);
      }
      await requiredInvoke<NativeAttachmentStatus>('native_attachment_stage_commit', {
        tempKey, expectedSizeBytes: blob.size,
      });
    } catch (error) {
      await requiredInvoke('native_attachment_stage_discard', { tempKey }).catch(() => undefined);
      throw error;
    }
    return;
  }
  await ensureStorageCapacity(blob.size);
  await saveKv(stagingKey(tempKey), blob);
  report(options, 'writing', blob.size, blob.size);
}

async function readNativePhysical(
  statusCommand: string,
  rangeCommand: string,
  args: Record<string, unknown>,
  mimeType: string,
  options?: AttachmentIoOptions,
): Promise<Blob> {
  const status = await requiredInvoke<NativeAttachmentStatus>(statusCommand, args);
  const parts: ArrayBuffer[] = [];
  for (let offset = 0; offset < status.sizeBytes; offset += NATIVE_TRANSFER_BYTES) {
    throwIfAborted(options?.signal);
    const length = Math.min(NATIVE_TRANSFER_BYTES, status.sizeBytes - offset);
    const chunk = new Uint8Array(await requiredInvoke<number[]>(rangeCommand, {
      ...args, offset, length,
    }));
    if (chunk.byteLength !== length) throw new Error('原生附件分块读取长度不一致');
    parts.push(chunk.slice().buffer as ArrayBuffer);
    report(options, 'reading', offset + length, status.sizeBytes);
  }
  return new Blob(parts, { type: mimeType });
}

async function readStagedPhysical(tempKey: string, options?: AttachmentIoOptions): Promise<Blob> {
  assertTempKey(tempKey);
  if (isTauriRuntime()) {
    return readNativePhysical(
      'native_attachment_stage_status',
      'native_attachment_stage_read_range',
      { tempKey },
      'application/x-zichan-encrypted-attachment',
      options,
    );
  }
  const blob = await loadKv<Blob>(stagingKey(tempKey));
  if (!(blob instanceof Blob)) throw new Error(`附件暂存文件不存在：${tempKey}`);
  report(options, 'reading', blob.size, blob.size);
  return blob;
}

async function discardStagePhysical(tempKey?: string): Promise<void> {
  if (!tempKey) return;
  assertTempKey(tempKey);
  if (isTauriRuntime()) {
    await requiredInvoke('native_attachment_stage_discard', { tempKey });
    return;
  }
  await deleteKv(stagingKey(tempKey));
}

async function physicalExists(sha256: string, area: 'objects' | 'trash' | 'quarantine' = 'objects'): Promise<boolean> {
  assertSha256(sha256);
  if (isTauriRuntime()) return requiredInvoke<boolean>('native_attachment_exists', { sha256, area });
  return hasKv(areaKey(area, sha256));
}

async function promotePhysical(tempKey: string, sha256: string): Promise<void> {
  assertTempKey(tempKey);
  assertSha256(sha256);
  if (await physicalExists(sha256)) {
    const existing = await readAttachmentBlob(sha256);
    if ((await hashAttachmentBlob(existing)).sha256 === sha256) {
      await discardStagePhysical(tempKey);
      return;
    }
    if (isTauriRuntime()) await requiredInvoke('native_attachment_quarantine', { sha256 });
    else await moveKv(areaKey('objects', sha256), areaKey('quarantine', sha256));
  }
  if (isTauriRuntime()) {
    await requiredInvoke<NativeAttachmentStatus>('native_attachment_promote', { tempKey, sha256 });
    return;
  }
  const moved = await moveKv(stagingKey(tempKey), objectKey(sha256));
  if (!moved && !(await hasKv(objectKey(sha256)))) throw new Error(`附件暂存文件不存在：${tempKey}`);
}

async function movePhysical(sha256: string, from: 'objects' | 'trash', to: 'objects' | 'trash'): Promise<void> {
  assertSha256(sha256);
  if (isTauriRuntime()) {
    await requiredInvoke(from === 'objects' ? 'native_attachment_trash' : 'native_attachment_restore', { sha256 });
    return;
  }
  await moveKv(areaKey(from, sha256), areaKey(to, sha256));
}

async function purgePhysical(sha256: string): Promise<void> {
  assertSha256(sha256);
  if (isTauriRuntime()) {
    await requiredInvoke('native_attachment_purge', { sha256 });
    return;
  }
  await Promise.all([
    deleteKv(areaKey('objects', sha256)),
    deleteKv(areaKey('trash', sha256)),
    deleteKv(areaKey('quarantine', sha256)),
  ]);
}

export async function readAttachmentBlob(
  sha256: string,
  mimeType = 'application/octet-stream',
  area: 'objects' | 'trash' | 'quarantine' = 'objects',
  options?: AttachmentIoOptions,
): Promise<Blob> {
  assertSha256(sha256);
  throwIfAborted(options?.signal);
  let encrypted: Blob;
  if (isTauriRuntime()) {
    encrypted = await readNativePhysical(
      'native_attachment_status',
      'native_attachment_read_range',
      { sha256, area },
      'application/x-zichan-encrypted-attachment',
      options,
    );
  } else {
    const stored = await loadKv<Blob>(areaKey(area, sha256));
    if (!(stored instanceof Blob)) throw new Error(`附件文件不存在：${sha256}`);
    encrypted = stored;
    report(options, 'reading', encrypted.size, encrypted.size);
  }
  const result = await decryptDeviceAttachmentBlob(
    requireDeviceStorageSession().cryptoSession,
    sha256,
    encrypted,
    mimeType,
  );
  report(options, 'verifying', result.size, result.size);
  return result;
}

async function verifiedStagedBlob(
  tempKey: string,
  source: Blob,
  options?: AttachmentIoOptions,
): Promise<{ sha256: string; sizeBytes: number }> {
  throwIfAborted(options?.signal);
  await ensureStorageCapacity(source.size + Math.ceil(source.size / (1024 * 1024)) * 32 + 4096);
  report(options, 'encrypting', 0, source.size);
  const sourceCheck = await hashAttachmentBlob(source);
  const encrypted = await encryptDeviceAttachmentBlob(
    requireDeviceStorageSession().cryptoSession,
    sourceCheck.sha256,
    source,
  );
  report(options, 'encrypting', source.size, source.size);
  await stagePhysical(tempKey, encrypted, options);
  const staged = await decryptDeviceAttachmentBlob(
    requireDeviceStorageSession().cryptoSession,
    sourceCheck.sha256,
    await readStagedPhysical(tempKey, options),
    source.type || 'application/octet-stream',
  );
  const check = await hashAttachmentBlob(staged);
  if (check.sizeBytes !== source.size || check.sha256 !== sourceCheck.sha256) throw new Error('附件暂存后大小或校验和不一致');
  return check;
}

export async function prepareAttachmentDraft(
  store: SqlLedgerStore,
  attachmentId: string,
  draft: AttachmentDraftData,
  kind: AttachmentFileOpKind = 'create',
  options?: AttachmentIoOptions,
): Promise<PreparedAttachment> {
  if (!draft.contentBlob) {
    if (!draft.sha256 || draft.sizeBytes == null) throw new Error(`附件 ${draft.fileName} 缺少内容引用`);
    assertSha256(draft.sha256);
    if (draft.thumbnailSha256) assertSha256(draft.thumbnailSha256);
    return {
      attachmentId,
      metadata: {
        fileName: draft.fileName,
        mimeType: draft.mimeType,
        note: draft.note,
        sizeBytes: draft.sizeBytes,
        sha256: draft.sha256,
        thumbnailSha256: draft.thumbnailSha256,
        thumbnailSizeBytes: draft.thumbnailSizeBytes,
        thumbnailMimeType: draft.thumbnailMimeType,
      },
    };
  }

  const operationId = newId();
  const now = new Date().toISOString();
  const tempContentKey = `${operationId}-content`;
  const tempThumbnailKey = draft.thumbnailBlob ? `${operationId}-thumbnail` : undefined;
  const operation: AttachmentFileOpRow = {
    id: operationId,
    kind,
    attachmentId,
    phase: 'preparing',
    tempContentKey,
    tempThumbnailKey,
    createdAt: now,
    updatedAt: now,
  };
  await store.attachmentState.putFileOp(operation);
  try {
    const content = await verifiedStagedBlob(tempContentKey, draft.contentBlob, options);
    const thumbnailBlob = draft.thumbnailBlob;
    const thumbnail = thumbnailBlob && tempThumbnailKey
      ? await verifiedStagedBlob(tempThumbnailKey, thumbnailBlob, options)
      : undefined;
    await store.attachmentState.patchFileOp(operationId, {
      phase: 'prepared',
      contentSha256: content.sha256,
      thumbnailSha256: thumbnail?.sha256,
      error: undefined,
    });
    return {
      operationId,
      attachmentId,
      tempContentKey,
      tempThumbnailKey,
      metadata: {
        fileName: draft.fileName,
        mimeType: draft.mimeType || draft.contentBlob.type || 'application/octet-stream',
        note: draft.note,
        sizeBytes: content.sizeBytes,
        sha256: content.sha256,
        thumbnailSha256: thumbnail?.sha256,
        thumbnailSizeBytes: thumbnail?.sizeBytes,
        thumbnailMimeType: thumbnail ? (thumbnailBlob?.type || 'image/jpeg') : undefined,
      },
    };
  } catch (error) {
    await Promise.allSettled([discardStagePhysical(tempContentKey), discardStagePhysical(tempThumbnailKey)]);
    await store.attachmentState.patchFileOp(operationId, {
      phase: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function putPromotingBlob(store: SqlLedgerStore, row: AttachmentBlobRow): Promise<void> {
  const current = await store.attachmentState.getBlob(row.sha256);
  if (current?.state === 'ready') return;
  await store.attachmentState.putBlob(row);
}

export async function commitPreparedStorageState(store: SqlLedgerStore, prepared: PreparedAttachment): Promise<void> {
  if (!prepared.operationId) return;
  await putPromotingBlob(store, {
    sha256: prepared.metadata.sha256,
    sizeBytes: prepared.metadata.sizeBytes,
    mimeType: prepared.metadata.mimeType || 'application/octet-stream',
    state: 'promoting',
  });
  if (prepared.metadata.thumbnailSha256 && prepared.metadata.thumbnailSizeBytes != null) {
    await putPromotingBlob(store, {
      sha256: prepared.metadata.thumbnailSha256,
      sizeBytes: prepared.metadata.thumbnailSizeBytes,
      mimeType: prepared.metadata.thumbnailMimeType || 'image/jpeg',
      state: 'promoting',
    });
  }
  await store.attachmentState.patchFileOp(prepared.operationId, { phase: 'db_committed', error: undefined });
}

export async function commitPreparedAttachment(
  store: SqlLedgerStore,
  prepared: PreparedAttachment,
  entityType: string,
  entityId: string,
  role?: Attachment['role'],
): Promise<Attachment> {
  const existing = await store.attachments.get(prepared.attachmentId);
  const attachment: Attachment = {
    id: prepared.attachmentId,
    createdAt: existing?.createdAt ?? '',
    updatedAt: existing?.updatedAt ?? '',
    version: existing?.version ?? 1,
    isDeleted: false,
    entityType,
    entityId,
    role,
    ...prepared.metadata,
  };
  await commitPreparedStorageState(store, prepared);
  return store.attachments.put(attachment);
}

async function verifyPhysicalBlob(sha256: string, sizeBytes: number, mimeType?: string): Promise<void> {
  const blob = await readAttachmentBlob(sha256, mimeType);
  const check = await hashAttachmentBlob(blob);
  if (check.sha256 !== sha256 || check.sizeBytes !== sizeBytes) throw new Error(`附件 ${sha256.slice(0, 12)} 校验失败`);
}

export async function finalizePreparedAttachment(store: SqlLedgerStore, prepared: PreparedAttachment): Promise<void> {
  if (!prepared.operationId) return;
  try {
    await promotePhysical(prepared.tempContentKey!, prepared.metadata.sha256);
    if (prepared.tempThumbnailKey && prepared.metadata.thumbnailSha256) {
      await promotePhysical(prepared.tempThumbnailKey, prepared.metadata.thumbnailSha256);
    }
    await verifyPhysicalBlob(prepared.metadata.sha256, prepared.metadata.sizeBytes, prepared.metadata.mimeType);
    if (prepared.metadata.thumbnailSha256 && prepared.metadata.thumbnailSizeBytes != null) {
      await verifyPhysicalBlob(prepared.metadata.thumbnailSha256, prepared.metadata.thumbnailSizeBytes, prepared.metadata.thumbnailMimeType);
    }
    const now = new Date().toISOString();
    await store.transaction(async (transaction) => {
      await transaction.attachmentState.putBlob({
        sha256: prepared.metadata.sha256,
        sizeBytes: prepared.metadata.sizeBytes,
        mimeType: prepared.metadata.mimeType || 'application/octet-stream',
        state: 'ready',
        verifiedAt: now,
        lastAccessedAt: now,
      });
      if (prepared.metadata.thumbnailSha256 && prepared.metadata.thumbnailSizeBytes != null) {
        await transaction.attachmentState.putBlob({
          sha256: prepared.metadata.thumbnailSha256,
          sizeBytes: prepared.metadata.thumbnailSizeBytes,
          mimeType: prepared.metadata.thumbnailMimeType || 'image/jpeg',
          state: 'ready',
          verifiedAt: now,
          lastAccessedAt: now,
        });
      }
      await transaction.attachmentState.patchFileOp(prepared.operationId!, { phase: 'completed', error: undefined });
    });
  } catch (error) {
    await store.attachmentState.patchFileOp(prepared.operationId, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function finalizePreparedAttachments(store: SqlLedgerStore, prepared: PreparedAttachment[]): Promise<void> {
  for (const attachment of prepared) await finalizePreparedAttachment(store, attachment);
}

export async function abortPreparedAttachments(store: SqlLedgerStore, prepared: PreparedAttachment[]): Promise<void> {
  for (const attachment of prepared) {
    if (!attachment.operationId) continue;
    await Promise.allSettled([
      discardStagePhysical(attachment.tempContentKey),
      discardStagePhysical(attachment.tempThumbnailKey),
    ]);
    await store.attachmentState.patchFileOp(attachment.operationId, { phase: 'aborted', error: undefined });
  }
}

export async function restoreAttachmentBlobFromTrash(
  store: SqlLedgerStore,
  descriptor: AttachmentBlobDescriptor,
): Promise<boolean> {
  if (!(await physicalExists(descriptor.sha256, 'trash'))) return false;
  const operationId = newId();
  const now = new Date().toISOString();
  await store.transaction(async (transaction) => {
    await transaction.attachmentState.putFileOp({
      id: operationId,
      kind: 'restore',
      contentSha256: descriptor.sha256,
      phase: 'db_committed',
      createdAt: now,
      updatedAt: now,
    });
    await transaction.attachmentState.putBlob({ ...descriptor, state: 'promoting' });
  });
  try {
    await movePhysical(descriptor.sha256, 'trash', 'objects');
    await verifyPhysicalBlob(descriptor.sha256, descriptor.sizeBytes, descriptor.mimeType);
    await store.transaction(async (transaction) => {
      await transaction.attachmentState.putBlob({
        ...descriptor,
        state: 'ready',
        verifiedAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      await transaction.attachmentState.patchFileOp(operationId, { phase: 'completed', error: undefined });
    });
    return true;
  } catch (error) {
    await store.attachmentState.patchFileOp(operationId, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function installDownloadedAttachmentBlob(
  store: SqlLedgerStore,
  descriptor: AttachmentBlobDescriptor,
  contents: Blob,
): Promise<void> {
  assertSha256(descriptor.sha256);
  if (await physicalExists(descriptor.sha256)) {
    await verifyPhysicalBlob(descriptor.sha256, descriptor.sizeBytes, descriptor.mimeType);
    await store.attachmentState.putBlob({
      ...descriptor,
      state: 'ready',
      verifiedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    });
    return;
  }
  if (await restoreAttachmentBlobFromTrash(store, descriptor)) return;

  const prepared = await prepareAttachmentDraft(store, `blob-${descriptor.sha256}`, {
    fileName: `download-${descriptor.sha256.slice(0, 12)}`,
    mimeType: descriptor.mimeType,
    contentBlob: contents,
  }, 'download');
  if (prepared.metadata.sha256 !== descriptor.sha256 || prepared.metadata.sizeBytes !== descriptor.sizeBytes) {
    await abortPreparedAttachments(store, [prepared]);
    throw new Error(`下载附件 ${descriptor.sha256.slice(0, 12)} 的正文校验失败`);
  }
  let committed = false;
  try {
    await store.transaction(async (transaction) => commitPreparedStorageState(transaction, prepared));
    committed = true;
    await finalizePreparedAttachment(store, prepared);
  } catch (error) {
    if (!committed) await abortPreparedAttachments(store, [prepared]);
    throw error;
  }
}

function referencedHashes(attachments: Attachment[], conflicts: Awaited<ReturnType<SqlLedgerStore['listConflicts']>>): Map<string, { sizeBytes: number; mimeType: string }> {
  const refs = new Map<string, { sizeBytes: number; mimeType: string }>();
  const add = (attachment: Partial<Attachment>) => {
    if (attachment.sha256 && SHA256_PATTERN.test(attachment.sha256) && attachment.sizeBytes != null) {
      refs.set(attachment.sha256, { sizeBytes: attachment.sizeBytes, mimeType: attachment.mimeType || 'application/octet-stream' });
    }
    if (attachment.thumbnailSha256 && SHA256_PATTERN.test(attachment.thumbnailSha256) && attachment.thumbnailSizeBytes != null) {
      refs.set(attachment.thumbnailSha256, { sizeBytes: attachment.thumbnailSizeBytes, mimeType: attachment.thumbnailMimeType || 'image/jpeg' });
    }
  };
  for (const attachment of attachments.filter((row) => !row.isDeleted)) add(attachment);
  for (const conflict of conflicts) {
    for (const branch of conflict.branches.filter((row) => row.aggregateType === 'attachment' && row.payload)) add(branch.payload as Partial<Attachment>);
  }
  return refs;
}

export async function reconcileAttachmentStorage(store: SqlLedgerStore, now = new Date()): Promise<void> {
  const [attachments, conflicts, blobs] = await Promise.all([
    store.attachments.list({ includeDeleted: true }),
    store.listConflicts(),
    store.attachmentState.listBlobs(),
  ]);
  const refs = referencedHashes(attachments, conflicts);
  const known = new Map(blobs.map((row) => [row.sha256, row]));
  for (const [sha256, metadata] of refs) {
    const current = known.get(sha256);
    if (await physicalExists(sha256)) {
      if (current?.state !== 'ready') {
        await store.attachmentState.putBlob({ ...metadata, sha256, state: 'ready', verifiedAt: current?.verifiedAt, lastAccessedAt: now.toISOString() });
      }
      continue;
    }
    if (await physicalExists(sha256, 'trash')) {
      await movePhysical(sha256, 'trash', 'objects');
      await store.attachmentState.putBlob({ ...metadata, sha256, state: 'ready', verifiedAt: current?.verifiedAt, lastAccessedAt: now.toISOString() });
      continue;
    }
    await store.attachmentState.putBlob({ ...metadata, sha256, state: 'missing', error: '本机正文不存在' });
  }

  for (const blob of blobs) {
    if (refs.has(blob.sha256)) continue;
    if (blob.state === 'trash') {
      if (blob.trashAfter && blob.trashAfter <= now.toISOString()) {
        await purgePhysical(blob.sha256);
        await store.attachmentState.removeBlob(blob.sha256);
      }
      continue;
    }
    if (!(await physicalExists(blob.sha256))) {
      if (await physicalExists(blob.sha256, 'trash')) {
        await store.attachmentState.putBlob({ ...blob, state: 'trash', trashAfter: blob.trashAfter ?? new Date(now.getTime() + TRASH_RETENTION_MS).toISOString() });
      } else if (blob.state !== 'missing') {
        await store.attachmentState.putBlob({ ...blob, state: 'missing', error: '本机正文不存在' });
      }
      continue;
    }
    const opId = newId();
    const at = now.toISOString();
    await store.attachmentState.putFileOp({
      id: opId,
      kind: 'garbage_collect',
      contentSha256: blob.sha256,
      phase: 'db_committed',
      createdAt: at,
      updatedAt: at,
    });
    await movePhysical(blob.sha256, 'objects', 'trash');
    await store.transaction(async (transaction) => {
      await transaction.attachmentState.putBlob({
        ...blob,
        state: 'trash',
        trashAfter: new Date(now.getTime() + TRASH_RETENTION_MS).toISOString(),
        error: undefined,
      });
      await transaction.attachmentState.patchFileOp(opId, { phase: 'completed' });
    });
  }
}

async function recoverCommittedOperation(store: SqlLedgerStore, op: AttachmentFileOpRow): Promise<void> {
  const attachment = op.attachmentId ? await store.attachments.get(op.attachmentId) : undefined;
  const content = op.contentSha256 ? await store.attachmentState.getBlob(op.contentSha256) : undefined;
  const thumbnail = op.thumbnailSha256 ? await store.attachmentState.getBlob(op.thumbnailSha256) : undefined;
  if (op.kind === 'garbage_collect' && op.contentSha256 && content) {
    if (await physicalExists(op.contentSha256)) await movePhysical(op.contentSha256, 'objects', 'trash');
    await store.transaction(async (transaction) => {
      await transaction.attachmentState.putBlob({
        ...content,
        state: 'trash',
        trashAfter: content.trashAfter ?? new Date(Date.now() + TRASH_RETENTION_MS).toISOString(),
        error: undefined,
      });
      await transaction.attachmentState.patchFileOp(op.id, { phase: 'completed', error: undefined });
    });
    return;
  }
  if (op.kind === 'restore' && op.contentSha256 && !(await physicalExists(op.contentSha256)) && await physicalExists(op.contentSha256, 'trash')) {
    await movePhysical(op.contentSha256, 'trash', 'objects');
  }
  if (op.contentSha256 && op.tempContentKey && !(await physicalExists(op.contentSha256))) {
    await promotePhysical(op.tempContentKey, op.contentSha256);
  }
  if (op.thumbnailSha256 && op.tempThumbnailKey && !(await physicalExists(op.thumbnailSha256))) {
    await promotePhysical(op.tempThumbnailKey, op.thumbnailSha256);
  }
  if (op.contentSha256 && content) await verifyPhysicalBlob(op.contentSha256, content.sizeBytes, content.mimeType);
  else if (attachment) await verifyPhysicalBlob(attachment.sha256, attachment.sizeBytes, attachment.mimeType);
  if (op.thumbnailSha256 && thumbnail) await verifyPhysicalBlob(op.thumbnailSha256, thumbnail.sizeBytes, thumbnail.mimeType);
  const verifiedAt = new Date().toISOString();
  await store.transaction(async (transaction) => {
    if (content) await transaction.attachmentState.putBlob({ ...content, state: 'ready', verifiedAt, error: undefined });
    if (thumbnail) await transaction.attachmentState.putBlob({ ...thumbnail, state: 'ready', verifiedAt, error: undefined });
    await transaction.attachmentState.patchFileOp(op.id, { phase: 'completed', error: undefined });
  });
}

export async function recoverAttachmentStorage(store: SqlLedgerStore): Promise<void> {
  const operations = await store.attachmentState.listFileOps(['preparing', 'prepared', 'db_committed', 'promoted']);
  for (const operation of operations) {
    try {
      if (operation.phase === 'preparing' || operation.phase === 'prepared') {
        await Promise.allSettled([
          discardStagePhysical(operation.tempContentKey),
          discardStagePhysical(operation.tempThumbnailKey),
        ]);
        await store.attachmentState.patchFileOp(operation.id, { phase: 'aborted', error: '应用重启时清理未提交暂存文件' });
      } else {
        await recoverCommittedOperation(store, operation);
      }
    } catch (error) {
      await store.attachmentState.patchFileOp(operation.id, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  await reconcileAttachmentStorage(store);
}

export async function attachmentPreviewUrl(attachment: Pick<AttachmentDraftData, 'sha256' | 'thumbnailSha256' | 'mimeType' | 'thumbnailMimeType'>): Promise<string> {
  const sha256 = attachment.thumbnailSha256 || attachment.sha256;
  if (!sha256) throw new Error('附件缺少内容引用');
  const mimeType = attachment.thumbnailSha256
    ? attachment.thumbnailMimeType || 'image/jpeg'
    : attachment.mimeType || 'application/octet-stream';
  return URL.createObjectURL(await readAttachmentBlob(sha256, mimeType));
}

export async function verifyAttachmentContent(attachment: Pick<Attachment, 'sha256' | 'sizeBytes' | 'mimeType'>): Promise<boolean> {
  try {
    const blob = await readAttachmentBlob(attachment.sha256, attachment.mimeType);
    const check = await hashAttachmentBlob(blob);
    return check.sizeBytes === attachment.sizeBytes && check.sha256 === attachment.sha256;
  } catch {
    return false;
  }
}

export async function attachmentStorageStatus(sha256: string): Promise<'ready' | 'trash' | 'missing'> {
  if (await physicalExists(sha256)) return 'ready';
  if (await physicalExists(sha256, 'trash')) return 'trash';
  return 'missing';
}
