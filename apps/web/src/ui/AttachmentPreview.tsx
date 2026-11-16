import { useEffect, useRef, useState } from 'react';
import { ensureAttachmentBlobAvailable } from '../attachment-sync.js';
import { attachmentPreviewUrl, type AttachmentDraftData } from '../db/attachment-storage.js';
import { useStore } from '../db/store.js';
import { attachmentPreviewKind } from '../attachment-content.js';
import { AttachmentOpenButton } from './AttachmentViewer.js';

export function AttachmentPreview({ attachment, alt, className, style, interactive = false }: {
  attachment: AttachmentDraftData;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  interactive?: boolean;
}) {
  const { store, rev } = useStore();
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const resolved = useRef<{ key: string; local?: Blob; store: typeof store }>();
  const isImage = attachment.mimeType?.startsWith('image/') || !!attachment.thumbnailBlob || !!attachment.thumbnailSha256;

  useEffect(() => {
    let active = true;
    const key = JSON.stringify([attachment.sha256, attachment.thumbnailSha256, attachment.mimeType, attachment.thumbnailMimeType]);
    const local = attachment.thumbnailBlob ?? attachment.contentBlob;
    // Metadata can reach the UI before the local file promotion completes.
    // Retry unresolved previews after writes; keep successful object URLs cached.
    if (resolved.current?.key === key && resolved.current.local === local && resolved.current.store === store) return;
    resolved.current = undefined;
    setSrc('');
    const publish = (url: string) => {
      if (!active) { URL.revokeObjectURL(url); return; }
      resolved.current = { key, local, store };
      setSrc(url);
    };
    const previewReference = {
      sha256: attachment.sha256,
      thumbnailSha256: attachment.thumbnailSha256,
      mimeType: attachment.mimeType,
      thumbnailMimeType: attachment.thumbnailMimeType,
    };
    setError('');
    if (local) {
      publish(URL.createObjectURL(local));
    } else if (isImage && (attachment.thumbnailSha256 || attachment.sha256)) {
      const sha256 = attachment.thumbnailSha256 || attachment.sha256!;
      const sizeBytes = attachment.thumbnailSha256 ? attachment.thumbnailSizeBytes : attachment.sizeBytes;
      const mimeType = attachment.thumbnailSha256
        ? attachment.thumbnailMimeType || 'image/jpeg'
        : attachment.mimeType || 'application/octet-stream';
      void (async () => {
        try {
          return await attachmentPreviewUrl(previewReference);
        } catch {
          if (sizeBytes == null) throw new Error('附件缺少大小信息');
          await ensureAttachmentBlobAvailable(store, { sha256, sizeBytes, mimeType });
          return attachmentPreviewUrl(previewReference);
        }
      })().then(publish).catch((reason) => {
        if (active) {
          setSrc('');
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    } else {
      setSrc('');
    }
    return () => {
      active = false;
    };
  }, [attachment.contentBlob, attachment.mimeType, attachment.sha256, attachment.sizeBytes, attachment.thumbnailBlob, attachment.thumbnailMimeType, attachment.thumbnailSha256, attachment.thumbnailSizeBytes, isImage, store, rev]);

  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const kind = attachmentPreviewKind(attachment);
  const content = !src || !isImage
    ? <div className={className} title={error || undefined} style={{ ...style, display: 'grid', placeItems: 'center', background: 'var(--surface-2)', color: error ? 'var(--negative)' : 'var(--fg-subtle)', fontSize: 'var(--fs-meta)' }}>{error ? '不可用' : kind === 'pdf' ? 'PDF · 预览' : isImage ? '图片' : '文件'}</div>
    : <img className={className} src={src} alt={alt ?? attachment.fileName} style={style} />;
  return interactive && kind ? <AttachmentOpenButton attachment={attachment} className="zc-attachment-trigger">{content}</AttachmentOpenButton> : content;
}
