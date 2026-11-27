import { Camera, Paperclip } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AttachmentDraftData } from '../db/attachment-storage.js';
import { AttachmentPreview } from './AttachmentPreview.js';
import { attachmentPreviewKind } from '../attachment-content.js';
import { AttachmentProcessing, type AttachmentApplication } from './AttachmentProcessing.js';

export function LedgerAttachmentField({ id, rows, disabled, readFiles, load, remove, apply, download, values, versions, manual, assets, onProcessing }: {
  id: string; rows: AttachmentDraftData[]; disabled: boolean; values: Record<string, string>; manual: ReadonlySet<string>;
  versions: Record<string, number>;
  assets: { value: string; label: string }[];
  readFiles: (files: FileList | null) => Promise<void>; load: (row: AttachmentDraftData) => Promise<Blob>;
  remove: (id: string) => void; apply: (id: string, application: AttachmentApplication) => Promise<void>;
  download: (row: AttachmentDraftData) => ReactNode; onProcessing: (active: boolean) => void;
}) {
  const [active, setActive] = useState<string>(), [file, setFile] = useState<File>();
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [pdfPages, setPdfPages] = useState<number>();
  const reader = useRef<AbortController>();
  const epoch = useRef(0), current = useRef(rows); current.current = rows;
  const processing = useRef(onProcessing); processing.current = onProcessing;
  useEffect(() => { processing.current(!!active); return () => processing.current(false); }, [active]);
  useEffect(() => () => { epoch.current++; reader.current?.abort(); }, []);
  const close = () => { epoch.current++; reader.current?.abort(); setActive(undefined); setFile(undefined); setPdfPages(undefined); setLoading(false); };
  useEffect(() => { if (active && !rows.some((row) => row.id === active)) close(); }, [active, rows]);
  const open = async (row: AttachmentDraftData) => {
    if (!row.id || active) return;
    const at = ++epoch.current; setActive(row.id); setLoading(true); setError(''); setPdfPages(undefined);
    const controller = new AbortController(); reader.current = controller;
    try {
      let blob = await load(row);
      if (controller.signal.aborted) return;
      if (attachmentPreviewKind(row) === 'pdf') {
        const { rasterizePdfForCapture } = await import('./PdfAttachment.js');
        const rendered = await rasterizePdfForCapture(blob, controller.signal);
        blob = rendered.blob;
        if (epoch.current === at) setPdfPages(rendered.pages);
      }
      if (epoch.current !== at || !current.current.some((item) => item.id === row.id)) return;
      setFile(new File([blob], attachmentPreviewKind(row) === 'pdf' ? `${row.fileName}.png` : row.fileName, { type: attachmentPreviewKind(row) === 'pdf' ? 'image/png' : row.mimeType || blob.type }));
    } catch (cause) { if (epoch.current === at) { setError(cause instanceof Error ? cause.message : '无法读取这张附件，请重试或先下载附件。'); setActive(undefined); } }
    finally { if (epoch.current === at) setLoading(false); }
  };
  const isDisabled = disabled || !!active;
  return <div
    className="zc-ledger-attachments"
    onDragOver={(event) => { event.preventDefault(); if (!isDisabled) setDragOver(true); }}
    onDragLeave={() => setDragOver(false)}
    onDrop={(event) => {
      setDragOver(false);
      if (!isDisabled && event.dataTransfer.files.length) {
        event.preventDefault();
        void readFiles(event.dataTransfer.files);
      }
    }}
    onPaste={(event) => {
      if (!isDisabled && event.clipboardData.files.length) {
        event.preventDefault();
        void readFiles(event.clipboardData.files);
      }
    }}
  >
    <div className="zc-attachment-dropzone-row">
      <label className={`zc-attachment-dropzone${dragOver ? ' is-dragover' : ''}${isDisabled ? ' is-disabled' : ''}`} htmlFor={id}>
        <input
          id={id}
          aria-label="附件 / 图片"
          className="zc-sr-only"
          type="file"
          multiple
          disabled={isDisabled}
          onChange={(event) => { const input = event.currentTarget; void readFiles(input.files).finally(() => { input.value = ''; }); }}
        />
        <Paperclip size={16} aria-hidden="true" />
        <span className="zc-attachment-dropzone-main">选择文件、拖入或粘贴截图</span>
        <span className="zc-attachment-dropzone-note">图片 / PDF 支持本机识别</span>
      </label>
      <label className={`zc-btn zc-touch-only zc-attachment-camera-btn${isDisabled ? ' is-disabled' : ''}`} htmlFor={`${id}-camera`}>
        <Camera size={16} aria-hidden="true" />
        <span>拍照</span>
        <input
          id={`${id}-camera`}
          className="zc-sr-only"
          type="file"
          accept="image/*"
          capture="environment"
          disabled={isDisabled}
          onChange={(event) => { const input = event.currentTarget; void readFiles(input.files).finally(() => { input.value = ''; }); }}
        />
      </label>
    </div>
    {error && <p role="alert" className="zc-entry-field-error">{error}</p>}
    {rows.map((row) => <div key={row.id} className="zc-attachment-item">
      <div className="zc-attachment-item-header"><AttachmentPreview attachment={row} interactive alt={row.fileName} style={{ width: 80, height: 64, objectFit: 'cover', borderRadius: 'var(--r-sm)' }} /><div className="zc-attachment-item-info"><span>{row.fileName}</span><span className="zc-meta">{Math.ceil((row.sizeBytes ?? 0) / 1024)} KB · {active === row.id ? loading ? '正在读取图片' : '正在处理，尚未应用' : row.privacyReview ? (row.privacyReview.maskCount === 0 ? '已处理，图片未打码' : `已打码 ${row.privacyReview.maskCount ?? ''} 处`) : row.note?.startsWith('附件处理：') ? row.note.slice(5) : '尚未提取信息'}</span></div><div className="zc-attachment-actions">{download(row)}<button type="button" className="zc-btn" disabled={isDisabled} onClick={() => row.id && remove(row.id)}>移除</button>{['image', 'pdf'].includes(attachmentPreviewKind(row) ?? '') && <button type="button" className="zc-btn" disabled={isDisabled} onClick={() => void open(row)}>提取信息</button>}</div></div>
      {active === row.id && file && <AttachmentProcessing file={file} pdfPages={pdfPages} values={values} versions={versions} manual={manual} assets={assets} onClose={close} onApply={async (application) => { if (!current.current.some((item) => item.id === row.id)) throw new Error('附件已移除，请重新选择。'); await apply(row.id!, application); close(); }} />}
      {active === row.id && loading && <button type="button" className="zc-btn" onClick={close}>取消读取</button>}
    </div>)}
  </div>;
}
