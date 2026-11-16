import type { SqlLedgerStore } from '@zichan/db';
import { ensureAttachmentBlobAvailable } from './attachment-sync.js';
import { readAttachmentBlob, type AttachmentDraftData } from './db/attachment-storage.js';

export function attachmentPreviewKind(attachment: AttachmentDraftData): 'image' | 'pdf' | undefined {
  const mime = (attachment.mimeType || attachment.contentBlob?.type || '').split(';')[0]!.toLowerCase().trim();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (!mime || mime === 'application/octet-stream') {
    if (/\.pdf$/i.test(attachment.fileName)) return 'pdf';
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(attachment.fileName)) return 'image';
  }
  return undefined;
}

/** Full-resolution bytes only: a thumbnail is never a substitute for the original. */
export async function loadAttachmentContent(
  store: SqlLedgerStore,
  attachment: AttachmentDraftData,
  downloadPreviewAttachment?: (sha256: string) => Promise<{ blob: Blob }>,
): Promise<Blob> {
  if (attachment.contentBlob) return attachment.contentBlob;
  if (!attachment.sha256) throw new Error('附件缺少正文引用');
  // A read-only account preview must use its authorized server route, never this device's store.
  if (downloadPreviewAttachment) return (await downloadPreviewAttachment(attachment.sha256)).blob;
  if (attachment.sizeBytes == null) throw new Error('附件缺少大小信息');
  await ensureAttachmentBlobAvailable(store, {
    sha256: attachment.sha256,
    sizeBytes: attachment.sizeBytes,
    mimeType: attachment.mimeType || 'application/octet-stream',
  });
  return readAttachmentBlob(attachment.sha256, attachment.mimeType);
}
