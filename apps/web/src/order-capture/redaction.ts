import { newId, sha256Bytes } from '@zichan/core';
import type { AttachmentDraftData } from '../db/attachment-storage.js';
import { imageDimensions } from './image.js';
import { REDACTION_RULE_VERSION, type MaskRegion } from './privacy.js';

export interface PrivacyReview {
  version: 1; rulesVersion: string; sourceRevision: string; outputRevision: string;
  reviewedSha256: string; width: number; height: number;
  maskCount?: number;
}
export interface ReviewedRedactedImage extends AttachmentDraftData { privacyReview: PrivacyReview; contentBlob: Blob }
/** Original images are never accepted here; this type is produced only from newly encoded pixels. */
export async function redactOrderImage(image: ImageBitmap, regions: readonly MaskRegion[], sourceRevision: string): Promise<ReviewedRedactedImage> {
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d'); if (!context) throw new Error('本机无法生成脱敏图片，请稍后重试。');
  try {
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
    context.fillStyle = '#000000';
    for (const row of regions) {
      if (![row.x, row.y, row.width, row.height].every(Number.isFinite) || row.width < 0 || row.height < 0) throw new Error('遮盖范围无效，请重新核对。');
      const x = Math.max(0, Math.floor(row.x)), y = Math.max(0, Math.floor(row.y));
      context.fillRect(x, y, Math.ceil(row.x + row.width) - x, Math.ceil(row.y + row.height) - y);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob || blob.size > 20 * 1024 * 1024) throw new Error('脱敏图片生成失败或超过 20 MiB，请裁剪图片后重试。');
    const sha256 = await sha256Bytes(new Uint8Array(await blob.arrayBuffer()));
    // Thumbnails are derived exclusively from the flattened, redacted image.
    const scale = Math.min(1, 480 / Math.max(image.width, image.height));
    const thumb = document.createElement('canvas'); thumb.width = Math.max(1, Math.round(image.width * scale)); thumb.height = Math.max(1, Math.round(image.height * scale));
    thumb.getContext('2d')!.drawImage(canvas, 0, 0, thumb.width, thumb.height);
    const thumbnail = await new Promise<Blob | null>((resolve) => thumb.toBlob(resolve, 'image/png')); thumb.width = 1; thumb.height = 1;
    return { fileName: '订单凭证.png', mimeType: 'image/png', contentBlob: blob, thumbnailBlob: thumbnail ?? undefined, sizeBytes: blob.size, sha256,
      privacyReview: { version: 1, rulesVersion: REDACTION_RULE_VERSION, sourceRevision, outputRevision: newId(), reviewedSha256: sha256, width: image.width, height: image.height, maskCount: regions.length } };
  } finally { canvas.width = 1; canvas.height = 1; }
}
export async function assertReviewedRedactedImage(draft: AttachmentDraftData): Promise<void> {
  const review = draft.privacyReview;
  if (!draft.contentBlob || draft.mimeType !== 'image/png' || !review || review.version !== 1 || review.rulesVersion !== REDACTION_RULE_VERSION
    || !review.sourceRevision || !review.outputRevision || draft.fileName !== '订单凭证.png') throw new Error('新增收支附件必须先核对隐私并生成脱敏图片；PDF 请转为图片处理。');
  const bytes = new Uint8Array(await draft.contentBlob.arrayBuffer());
  const dimensions = imageDimensions(bytes.buffer);
  if (!dimensions || dimensions.width !== review.width || dimensions.height !== review.height || await sha256Bytes(bytes) !== review.reviewedSha256) throw new Error('脱敏图片与核对版本不一致，请重新核对。');
  // A reviewed PNG must not carry source EXIF or hidden textual chunks.
  const view = new DataView(bytes.buffer); let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (!['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'iCCP'].includes(type) || offset + length + 12 > bytes.length) throw new Error('脱敏图片含不允许的元数据，请重新生成。');
    offset += length + 12;
    if (type === 'IEND') break;
  }
  if (offset !== bytes.length) throw new Error('脱敏图片内容无效，请重新生成。');
  {
    // Never trust a caller-supplied thumbnail: regenerate at the attachment gate below.
    const thumbnail = await createImageBitmap(draft.contentBlob);
    try {
      const canvas = document.createElement('canvas'), scale = Math.min(1, 480 / Math.max(thumbnail.width, thumbnail.height));
      canvas.width = Math.max(1, Math.round(thumbnail.width * scale)); canvas.height = Math.max(1, Math.round(thumbnail.height * scale));
      canvas.getContext('2d')!.drawImage(thumbnail, 0, 0, canvas.width, canvas.height);
      const safe = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!safe) throw new Error('无法生成脱敏缩略图。');
      draft.thumbnailBlob = safe; delete draft.thumbnailSha256; delete draft.thumbnailSizeBytes; delete draft.thumbnailMimeType;
      canvas.width = 1; canvas.height = 1;
    } finally { thumbnail.close(); }
  }
}
