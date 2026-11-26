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
  const epoch = useRef(0), current = useRef(rows); current.current = rows;
  const processing = useRef(onProcessing); processing.current = onProcessing;
  useEffect(() => { processing.current(!!active); return () => processing.current(false); }, [active]);
  useEffect(() => () => { epoch.current++; }, []);
  const close = () => { epoch.current++; setActive(undefined); setFile(undefined); setLoading(false); };
  useEffect(() => { if (active && !rows.some((row) => row.id === active)) close(); }, [active, rows]);
  const open = async (row: AttachmentDraftData) => {
    if (!row.id || active) return;
    const at = ++epoch.current; setActive(row.id); setLoading(true); setError('');
    try {
      const blob = await load(row);
      if (epoch.current !== at || !current.current.some((item) => item.id === row.id)) return;
      setFile(new File([blob], row.fileName, { type: row.mimeType || blob.type }));
    } catch { if (epoch.current === at) { setError('无法读取这张附件，请重试或先下载附件。'); setActive(undefined); } }
    finally { if (epoch.current === at) setLoading(false); }
  };
  return <div className="zc-ledger-attachments" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { if (!disabled && !active && event.dataTransfer.files.length) { event.preventDefault(); void readFiles(event.dataTransfer.files); } }} onPaste={(event) => { if (!disabled && !active && event.clipboardData.files.length) { event.preventDefault(); void readFiles(event.clipboardData.files); } }}>
    <div className="zc-attachment-actions"><input id={id} aria-label="附件 / 图片" type="file" multiple disabled={disabled || !!active} onChange={(event) => { const input = event.currentTarget; void readFiles(input.files).finally(() => { input.value = ''; }); }} /><label className="zc-btn" htmlFor={`${id}-camera`}>拍照<input id={`${id}-camera`} hidden type="file" accept="image/*" capture="environment" disabled={disabled || !!active} onChange={(event) => { const input = event.currentTarget; void readFiles(input.files).finally(() => { input.value = ''; }); }} /></label></div>
    <p className="zc-meta">可拖入文件，或在此粘贴截图。点击图片旁的“提取信息”处理当前附件。</p>
    {error && <p role="alert" className="zc-entry-field-error">{error}</p>}
    {rows.map((row) => <div key={row.id} className="zc-attachment-item">
      <div className="zc-attachment-item-header"><AttachmentPreview attachment={row} interactive alt={row.fileName} style={{ width: 80, height: 64, objectFit: 'cover', borderRadius: 'var(--r-sm)' }} /><div className="zc-attachment-item-info"><span>{row.fileName}</span><span className="zc-meta">{Math.ceil((row.sizeBytes ?? 0) / 1024)} KB · {active === row.id ? loading ? '正在读取图片' : '正在处理，尚未应用' : row.privacyReview ? (row.privacyReview.maskCount === 0 ? '已处理，图片未打码' : `已打码 ${row.privacyReview.maskCount ?? ''} 处`) : row.note?.startsWith('附件处理：') ? row.note.slice(5) : '尚未提取信息'}</span></div><div className="zc-attachment-actions">{download(row)}<button type="button" className="zc-btn" disabled={disabled || !!active} onClick={() => row.id && remove(row.id)}>移除</button>{attachmentPreviewKind(row) === 'image' && <button type="button" className="zc-btn" disabled={disabled || !!active} onClick={() => void open(row)}>提取信息</button>}</div></div>
      {active === row.id && file && <AttachmentProcessing file={file} values={values} versions={versions} manual={manual} assets={assets} onClose={close} onApply={async (application) => { if (!current.current.some((item) => item.id === row.id)) throw new Error('附件已移除，请重新选择。'); await apply(row.id!, application); close(); }} />}
      {active === row.id && loading && <button type="button" className="zc-btn" onClick={close}>取消读取</button>}
    </div>)}
  </div>;
}
