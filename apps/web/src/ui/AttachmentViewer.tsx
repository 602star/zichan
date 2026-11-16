import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Download, Minus, Plus, X } from 'lucide-react';
import { attachmentPreviewKind, loadAttachmentContent } from '../attachment-content.js';
import type { AttachmentDraftData } from '../db/attachment-storage.js';
import { useStore } from '../db/store.js';
import { DialogShell } from './DialogShell.js';
import './attachment-viewer.css';

const PdfAttachment = lazy(() => import('./PdfAttachment.js'));

export function AttachmentOpenButton({ attachment, children, className = 'zc-btn', style }: {
  attachment: AttachmentDraftData;
  children?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  if (!attachmentPreviewKind(attachment)) return null;
  return <>
    <button type="button" className={className} style={style} aria-label={`预览 ${attachment.fileName}`}
      aria-haspopup="dialog" onClick={() => setOpen(true)}>{children ?? '预览'}</button>
    {open && <AttachmentViewer attachment={attachment} onClose={() => setOpen(false)} />}
  </>;
}

export function AttachmentViewer({ attachment, onClose }: { attachment: AttachmentDraftData; onClose: () => void }) {
  const { store, downloadPreviewAttachment } = useStore();
  const titleId = useId();
  const [source, setSource] = useState<{ blob: Blob; url: string }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(1);
  const kind = attachmentPreviewKind(attachment);

  useEffect(() => {
    let active = true;
    let url = '';
    setSource(undefined);
    setError('');
    void loadAttachmentContent(store, attachment, downloadPreviewAttachment).then((blob) => {
      if (!active) return;
      url = URL.createObjectURL(blob);
      setSource({ blob, url });
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [attachment, store, downloadPreviewAttachment, attempt]);

  return <DialogShell labelledBy={titleId} onDismiss={onClose} panelClassName="zc-attachment-viewer"
    backdropClassName="zc-backdrop zc-attachment-backdrop" panelStyle={{ width: 1120, height: '92dvh' }}
    header={<div className="zc-attachment-heading">
      <h2 id={titleId}>附件预览 · {attachment.fileName}</h2>
      {source && <a className="zc-btn" href={source.url} download={attachment.fileName}><Download size={18} aria-hidden="true" />保存</a>}
      <button type="button" className="zc-btn" data-dialog-initial-focus aria-label="关闭附件预览" onClick={onClose}><X size={20} aria-hidden="true" /></button>
    </div>}>
    <div className="zc-attachment-toolbar" role="group" aria-label="预览缩放">
      <button type="button" className="zc-btn" aria-label="缩小" disabled={!source || zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.5))}><Minus size={18} aria-hidden="true" /></button>
      <output aria-live="polite">{Math.round(zoom * 100)}%</output>
      <button type="button" className="zc-btn" aria-label="放大" disabled={!source || zoom >= 4} onClick={() => setZoom((value) => Math.min(4, value + 0.5))}><Plus size={18} aria-hidden="true" /></button>
      <button type="button" className="zc-btn" disabled={!source} onClick={() => setZoom(1)}>适应窗口</button>
    </div>
    {error ? <div className="zc-attachment-status" role="alert"><p>无法预览：{error}</p><button type="button" className="zc-btn" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>
      : !source ? <div className="zc-attachment-status" role="status">正在读取附件，必要时从服务器取回…</div>
        : kind === 'pdf' ? <Suspense fallback={<div className="zc-attachment-status" role="status">正在加载 PDF 预览…</div>}><PdfAttachment blob={source.blob} zoom={zoom} /></Suspense>
          : kind === 'image' ? <ImageAttachment key={source.url} src={source.url} name={attachment.fileName} zoom={zoom} />
            : <p className="zc-attachment-status">此文件暂不支持预览，请保存后打开。</p>}
  </DialogShell>;
}

function ImageAttachment({ src, name, zoom }: { src: string; name: string; zoom: number }) {
  const stage = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setBounds({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit = natural.width && bounds.width ? Math.min(1, (bounds.width - 24) / natural.width, (bounds.height - 24) / natural.height) : 1;
  return <div ref={stage} className="zc-attachment-stage" tabIndex={0} aria-label="图片，可滚动查看放大后的内容">
    {failed ? <div className="zc-attachment-status" role="alert">图片无法显示，请保存原文件后查看。</div>
      : <div className="zc-attachment-media"><img src={src} alt={name}
        style={natural.width ? { width: natural.width * Math.max(0.01, fit) * zoom, height: natural.height * Math.max(0.01, fit) * zoom } : { maxWidth: '100%' }}
        onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setFailed(true)} /></div>}
  </div>;
}
