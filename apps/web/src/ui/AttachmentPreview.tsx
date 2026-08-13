import { useEffect, useState } from 'react';
import { ensureAttachmentBlobAvailable } from '../attachment-sync.js';
import { attachmentPreviewUrl, type AttachmentDraftData } from '../db/attachment-storage.js';
import { useStore } from '../db/store.js';

export function AttachmentPreview({ attachment, alt, className, style }: {
  attachment: AttachmentDraftData;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { store } = useStore();
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const isImage = attachment.mimeType?.startsWith('image/') || !!attachment.thumbnailBlob || !!attachment.thumbnailSha256;

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    const previewReference = {
      sha256: attachment.sha256,
      thumbnailSha256: attachment.thumbnailSha256,
      mimeType: attachment.mimeType,
      thumbnailMimeType: attachment.thumbnailMimeType,
    };
    const local = attachment.thumbnailBlob ?? attachment.contentBlob;
    setError('');
    if (local) {
      objectUrl = URL.createObjectURL(local);
      setSrc(objectUrl);
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
      })().then((value) => {
        if (!active) {
          URL.revokeObjectURL(value);
          return;
        }
        objectUrl = value;
        setSrc(value);
      }).catch((reason) => {
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
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.contentBlob, attachment.mimeType, attachment.sha256, attachment.sizeBytes, attachment.thumbnailBlob, attachment.thumbnailMimeType, attachment.thumbnailSha256, attachment.thumbnailSizeBytes, isImage, store]);

  if (!src || !isImage) {
    return <div className={className} title={error || undefined} style={{ ...style, display: 'grid', placeItems: 'center', background: 'var(--surface-2)', color: error ? 'var(--negative)' : 'var(--fg-subtle)', fontSize: 11 }}>{error ? '不可用' : '文件'}</div>;
  }
  return <img className={className} src={src} alt={alt ?? attachment.fileName} style={style} />;
}
