import type { Attachment, LedgerKind, Setting } from '@zichan/core';
import {
  exportLedger,
  importLedger,
  preflightImport,
  restoreLedger,
  type BackupPreflight,
  type AttachmentFileOpRow,
  type DeviceRecoveryState,
  type LedgerBackup,
  type SqlLedgerStore,
} from '@zichan/db';
import {
  abortPreparedAttachments,
  commitPreparedStorageState,
  finalizePreparedAttachments,
  hashAttachmentBlob,
  prepareAttachmentDraft,
  readAttachmentBlob,
  reconcileAttachmentStorage,
  type PreparedAttachment,
} from './attachment-storage.js';
import { ensureAttachmentBlobAvailable } from '../attachment-sync.js';

export type PortableLedgerBackup = LedgerBackup;

export interface PortableImportResult {
  entities: number;
  removed?: number;
}

export type PortableAttachmentSource = (
  sha256: string,
  mimeType: string,
  expectedSizeBytes: number,
) => Promise<Blob>;

const attachmentSources = new WeakMap<object, PortableAttachmentSource>();

export function setPortableAttachmentSource(
  backup: PortableLedgerBackup,
  source: PortableAttachmentSource,
): PortableLedgerBackup {
  attachmentSources.set(backup, source);
  return backup;
}

export function portableAttachmentSource(backup: PortableLedgerBackup): PortableAttachmentSource | undefined {
  return attachmentSources.get(backup);
}

export function activeAttachmentBlobs(backup: PortableLedgerBackup): {
  sha256: string;
  sizeBytes: number;
  mimeType: string;
}[] {
  const refs = new Map<string, { sha256: string; sizeBytes: number; mimeType: string }>();
  for (const row of backup.attachments as Attachment[]) {
    if (row.isDeleted) continue;
    refs.set(row.sha256, {
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      mimeType: row.mimeType || 'application/octet-stream',
    });
    if (row.thumbnailSha256 && row.thumbnailSizeBytes != null) {
      refs.set(row.thumbnailSha256, {
        sha256: row.thumbnailSha256,
        sizeBytes: row.thumbnailSizeBytes,
        mimeType: row.thumbnailMimeType || 'image/jpeg',
      });
    }
  }
  return [...refs.values()];
}

export async function exportPortableLedger(store: SqlLedgerStore): Promise<PortableLedgerBackup> {
  const backup = await exportLedger(store);
  return setPortableAttachmentSource(backup, async (sha256, mimeType, expectedSizeBytes) => {
    await ensureAttachmentBlobAvailable(store, { sha256, sizeBytes: expectedSizeBytes, mimeType });
    return readAttachmentBlob(sha256, mimeType);
  });
}

export async function preflightPortableBackup(data: unknown): Promise<BackupPreflight> {
  const preflight = preflightImport(data);
  if (!preflight.ok || !data || typeof data !== 'object') return preflight;
  const backup = data as PortableLedgerBackup;
  const refs = activeAttachmentBlobs(backup);
  const source = portableAttachmentSource(backup);
  if (refs.length && !source) {
    preflight.issues.push({
      level: 'error',
      code: 'attachment_content_source_missing',
      message: '备份包含附件元数据，但归档没有可读取的附件正文',
      entityType: 'attachment',
    });
  } else if (source) {
    for (const ref of refs) {
      try {
        const blob = await source(ref.sha256, ref.mimeType, ref.sizeBytes);
        const check = await hashAttachmentBlob(blob);
        if (check.sizeBytes !== ref.sizeBytes || check.sha256 !== ref.sha256) {
          preflight.issues.push({
            level: 'error',
            code: 'attachment_checksum_mismatch',
            message: `附件内容 ${ref.sha256.slice(0, 12)}… 的大小或 SHA-256 不一致`,
            entityType: 'attachment',
          });
        }
      } catch (error) {
        preflight.issues.push({
          level: 'error',
          code: 'attachment_content_invalid',
          message: `附件内容 ${ref.sha256.slice(0, 12)}… 无法读取或校验：${error instanceof Error ? error.message : String(error)}`,
          entityType: 'attachment',
        });
      }
    }
  }
  preflight.ok = !preflight.issues.some((issue) => issue.level === 'error');
  return preflight;
}

export async function stagePortableAttachments(
  store: SqlLedgerStore,
  data: PortableLedgerBackup,
): Promise<{ backup: LedgerBackup; prepared: PreparedAttachment[] }> {
  const preflight = await preflightPortableBackup(data);
  if (!preflight.ok) {
    throw new Error(preflight.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message).join('；'));
  }
  const source = portableAttachmentSource(data);
  const prepared: PreparedAttachment[] = [];
  try {
    const attachments: Attachment[] = [];
    for (const attachment of data.attachments as Attachment[]) {
      if (attachment.isDeleted) {
        attachments.push(attachment);
        continue;
      }
      if (!source) throw new Error(`附件 ${attachment.fileName} 缺少正文来源`);
      const contentBlob = await source(
        attachment.sha256,
        attachment.mimeType || 'application/octet-stream',
        attachment.sizeBytes,
      );
      const thumbnailBlob = attachment.thumbnailSha256 && attachment.thumbnailSizeBytes != null
        ? await source(
          attachment.thumbnailSha256,
          attachment.thumbnailMimeType || 'image/jpeg',
          attachment.thumbnailSizeBytes,
        )
        : undefined;
      const next = await prepareAttachmentDraft(store, attachment.id, {
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        note: attachment.note,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
        thumbnailSha256: attachment.thumbnailSha256,
        thumbnailSizeBytes: attachment.thumbnailSizeBytes,
        thumbnailMimeType: attachment.thumbnailMimeType,
        contentBlob,
        thumbnailBlob,
      }, 'import');
      if (next.metadata.sha256 !== attachment.sha256 || next.metadata.sizeBytes !== attachment.sizeBytes) {
        throw new Error(`附件 ${attachment.fileName} 暂存校验结果与备份清单不一致`);
      }
      prepared.push(next);
      attachments.push({ ...attachment, ...next.metadata });
    }
    const backup = { ...data, attachments } as LedgerBackup;
    return { backup, prepared };
  } catch (error) {
    await abortPreparedAttachments(store, prepared);
    throw error;
  }
}

export async function importPortableLedger(
  store: SqlLedgerStore,
  data: PortableLedgerBackup,
  mode: 'merge' | 'replace' = 'merge',
  importOptions: {
    deviceState?: DeviceRecoveryState;
    /** Mark a first-run restore initialized inside the same database transaction. */
    initialize?: { initializedAt: string; fallbackLedgerKind?: LedgerKind };
    /** Runs once after SQLite commits, before recoverable attachment promotion begins. */
    onDatabaseCommitted?: (result: PortableImportResult) => void | Promise<void>;
  } = {},
): Promise<PortableImportResult> {
  const staged = await stagePortableAttachments(store, data);
  let committed = false;
  try {
    const currentSettings = mode === 'merge' ? await store.settings.list() : [];
    if (currentSettings.length > 1) throw new Error('当前账本包含多个活动设置，无法安全合并备份');
    const backup = currentSettings.length === 1 ? { ...staged.backup, settings: [] } : staged.backup;
    const ledgerOptions = {
      afterImport: async (transaction: SqlLedgerStore) => {
        if (importOptions.deviceState) {
          const stagedFileOps: AttachmentFileOpRow[] = [];
          for (const prepared of staged.prepared) {
            if (!prepared.operationId) continue;
            const operation = await transaction.attachmentState.getFileOp(prepared.operationId);
            if (!operation) throw new Error(`附件暂存操作不存在：${prepared.operationId}`);
            stagedFileOps.push(operation);
          }
          await transaction.restoreDeviceRecoveryState(importOptions.deviceState);
          for (const operation of stagedFileOps) await transaction.attachmentState.putFileOp(operation);
        }
        if (importOptions.initialize) {
          const settings = await transaction.settings.list();
          if (settings.length !== 1 || !settings[0]) {
            throw new Error('备份必须包含且只能包含一个活动账本设置');
          }
          const setting = settings[0] as Setting;
          await transaction.settings.put({
            ...setting,
            ledgerKind: setting.ledgerKind === 'demo'
              ? 'demo'
              : (importOptions.initialize.fallbackLedgerKind ?? 'personal'),
            initializedAt: setting.initializedAt || importOptions.initialize.initializedAt,
          });
        }
        for (const prepared of staged.prepared) await commitPreparedStorageState(transaction, prepared);
      },
      onCommitted: async (result: PortableImportResult) => {
        committed = true;
        await importOptions.onDatabaseCommitted?.(result);
      },
    };
    const result = mode === 'replace'
      ? await restoreLedger(store, backup, ledgerOptions)
      : await importLedger(store, backup, ledgerOptions);
    await finalizePreparedAttachments(store, staged.prepared);
    await reconcileAttachmentStorage(store);
    return result;
  } catch (error) {
    if (!committed) await abortPreparedAttachments(store, staged.prepared);
    throw error;
  }
}
