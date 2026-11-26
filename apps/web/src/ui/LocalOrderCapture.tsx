import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { X } from 'lucide-react';
import { DialogShell } from './DialogShell.js';
import { useCompactView } from './useCompactView.js';
import { LocalOcrSession } from '../order-capture/ocr-client.js';
import { validateOrderImage } from '../order-capture/image.js';
import { parseOrder } from '../order-capture/parser.js';
import { reviewedOrderFields } from '../order-capture/review.js';
import { clearOcrResourceCache, type OcrProgress, type OcrResourceStorage } from '../order-capture/resources.js';
import type { OcrResult, OrderFieldKey, ParsedOrder, ReviewedOrderFields } from '../order-capture/types.js';
import { ACCOUNT_LOCK_REQUEST_EVENT } from '../browser-account-exit.js';
import { DEVICE_STORAGE_STATE_CHANGED_EVENT, requireDeviceStorageSession } from '../device-storage-key.js';
import { OrderPrivacyEditor } from './OrderPrivacyEditor.js';
import type { ReviewedRedactedImage } from '../order-capture/redaction.js';
import type { OrderCaptureApplication } from '../order-capture/application.js';
import { selectPrivateOrderFields } from '../db/local-order-private.js';

const LABELS: Partial<Record<OrderFieldKey, string>> = { amount: '实付款', paymentDate: '付款日期', paymentTime: '付款时间', orderNumber: '订单号', trackingNumber: '物流单号', merchant: '商家', product: '商品' };
export default function LocalOrderCapture({ values, manual, currency, onApply, onClose, initialFile, attachmentOnly = false }: {
  values: Record<string, string>; manual: ReadonlySet<string>; currency: string;
  onApply: (application: OrderCaptureApplication) => Promise<void> | void; onClose: () => void;
  initialFile?: File; attachmentOnly?: boolean;
}) {
  const titleId = useId(), inputId = useId();
  const compact = useCompactView();
  const session = useRef<LocalOcrSession | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [file, setFile] = useState<File>();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(false);
  const [progress, setProgress] = useState<OcrProgress>();
  const [resourceStorage, setResourceStorage] = useState<OcrResourceStorage>();
  const [result, setResult] = useState<OcrResult>();
  const [order, setOrder] = useState<ParsedOrder>();
  const [picked, setPicked] = useState<{ amount?: string; date?: string; time?: string }>({});
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [cacheStatus, setCacheStatus] = useState('');
  const [clearing, setClearing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [includeAttachment, setIncludeAttachment] = useState(attachmentOnly);
  const [reviewedImage, setReviewedImage] = useState<ReviewedRedactedImage>();
  const [applyFields, setApplyFields] = useState(!attachmentOnly);
  const [keepOrder, setKeepOrder] = useState(false), [keepTracking, setKeepTracking] = useState(false);
  const [privateOrder, setPrivateOrder] = useState(''), [privateTracking, setPrivateTracking] = useState('');
  const cancel = () => { generation.current++; controller.current?.abort(); session.current?.dispose(); session.current = null; setBusy(false); };
  const close = () => { cancel(); setResult(undefined); setOrder(undefined); setFile(undefined); onClose(); };
  useEffect(() => {
    if (!file) { setUrl(''); return; }
    const next = URL.createObjectURL(file); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); session.current?.dispose(); }, []);
  useEffect(() => { if (includeAttachment && result && !busy) { session.current?.dispose(); session.current = null; } }, [includeAttachment, result, busy]);
  useEffect(() => {
    if (!initialFile) return;
    let alive = true;
    setValidating(true);
    void validateOrderImage(initialFile).then(() => { if (alive) setFile(initialFile); }).catch(() => { if (alive) setError('请选择有效的 PNG、JPEG 或 WebP 图片；PDF 请先转为图片核对。'); }).finally(() => { if (alive) setValidating(false); });
    return () => { alive = false; };
  }, [initialFile]);
  useEffect(() => {
    const lock = () => { generation.current++; controller.current?.abort(); session.current?.dispose(); onClose(); };
    window.addEventListener(ACCOUNT_LOCK_REQUEST_EVENT, lock);
    const device = () => { try { requireDeviceStorageSession(); } catch { lock(); } };
    window.addEventListener(DEVICE_STORAGE_STATE_CHANGED_EVENT, device);
    return () => { window.removeEventListener(ACCOUNT_LOCK_REQUEST_EVENT, lock); window.removeEventListener(DEVICE_STORAGE_STATE_CHANGED_EVENT, device); };
  }, [onClose]);
  const choose = async (next?: File) => {
    if (!next) return;
    if (busy) cancel();
    const current = ++generation.current;
    setValidating(true); setFile(undefined); setOrder(undefined); setResult(undefined); setPicked({}); setConfirmed(false); setError('');
    setReviewedImage(undefined); setKeepOrder(false); setKeepTracking(false); setPrivateOrder(''); setPrivateTracking('');
    setResourceStorage(undefined);
    try { await validateOrderImage(next); if (generation.current === current) setFile(next); }
    catch (cause) { if (generation.current === current) setError(cause instanceof Error ? cause.message : '无法读取图片。'); }
    finally { if (generation.current === current) setValidating(false); }
  };
  const recognize = async () => {
    if (!file || busy || validating || clearing) return;
    const current = ++generation.current;
    controller.current = new AbortController(); session.current ??= new LocalOcrSession();
    setBusy(true); setError(''); setOrder(undefined); setResult(undefined); setPicked({}); setConfirmed(false);
    setReviewedImage(undefined);
    try {
      const data = await session.current.recognize(file, controller.current.signal, (next) => { if (generation.current === current) { setProgress(next); if (next.storage) setResourceStorage(next.storage); } });
      if (generation.current !== current) return;
      const parsed = parseOrder(data.lines); setResult(data); setOrder(parsed);
      setPrivateOrder((value) => value || parsed.fields.orderNumber.value || '');
      setPrivateTracking((value) => value || parsed.fields.trackingNumber.value || '');
      setPicked({ amount: !manual.has('amount') ? parsed.fields.amount.value : undefined,
        date: !manual.has('date') && !manual.has('time') ? parsed.fields.paymentDate.value : undefined,
        time: !manual.has('time') && !manual.has('date') && parsed.fields.paymentDate.value ? parsed.fields.paymentTime.value : undefined });
      if (!data.lines.length) setError('没有识别到文字，可换图或继续手工记账。');
    } catch (cause) {
      if (generation.current === current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof DOMException && cause.name === 'QuotaExceededError'
        ? '本机存储空间不足，请释放空间或清理识别缓存后重试。' : cause instanceof Error ? cause.message : '本机识别失败，请重试。');
    } finally { if (generation.current === current) setBusy(false); }
  };
  const apply = async () => {
    if (applying) return;
    const current = generation.current; setApplying(true); setError('');
    try {
      const fields: ReviewedOrderFields = applyFields && order ? reviewedOrderFields(order, { ...picked, confirmed }) : {};
      if (includeAttachment && !reviewedImage) throw new Error('请先检查整张图片并确认隐私遮盖。');
      const privateFields = selectPrivateOrderFields({ orderNumber: keepOrder ? privateOrder : undefined, trackingNumbers: keepTracking ? privateTracking.split(/[\s,，;；]+/).filter(Boolean) : [] });
      if ((keepOrder && !privateFields.orderNumber) || (keepTracking && !privateFields.trackingNumbers?.length)) throw new Error('请填写选择保留的号码，或取消对应勾选。');
      await onApply({ fields, ...(includeAttachment ? { attachment: reviewedImage } : {}), ...(keepOrder || keepTracking ? { privateFields } : {}) });
    } catch (cause) { if (generation.current === current) setError(cause instanceof Error ? cause.message : '应用失败，请重试。'); }
    finally { if (generation.current === current) setApplying(false); }
  };
  const clearCache = async () => {
    cancel(); const current = ++generation.current;
    setClearing(true); setCacheStatus(''); setError('');
    try { await clearOcrResourceCache(); if (generation.current === current) setCacheStatus('已清理识别缓存，可重新准备；账本数据不受影响。'); }
    catch { if (generation.current === current) setError('识别缓存清理失败，请稍后重试。'); }
    finally { if (generation.current === current) setClearing(false); }
  };
  const paste = (event: ClipboardEvent) => { const image = [...event.clipboardData.files].find((item) => item.type.startsWith('image/')); if (image) { event.preventDefault(); void choose(image); } };
  const drop = (event: DragEvent) => { event.preventDefault(); void choose(event.dataTransfer.files[0]); };
  const allowedState = order && ['paid', 'unknown'].includes(order.paymentState);
  const progressLabel = progress?.phase === 'resources' ? `准备本机资源：${(progress.current / 1024 ** 2).toFixed(1)} / ${(progress.total / 1024 ** 2).toFixed(1)} MiB`
    : progress?.phase === 'initializing' ? '正在启动本机文字识别…' : `正在识别第 ${(progress?.current ?? 0) + 1} / ${progress?.total ?? 1} 块图片…`;
  return <DialogShell labelledBy={titleId} onDismiss={close} panelStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', width: 'min(920px, calc(100vw - 24px))', maxHeight: 'calc(100dvh - 24px)' }}
    dismissDisabled={applying}
    header={<div className="zc-modal-header"><div><h2 id={titleId} style={{ margin: 0, fontSize: 'var(--fs-title)' }}>本机识别截图</h2><p className="zc-meta">原图和完整文字不保存、不上传；脱敏副本经核对后可作为普通附件。</p></div><button type="button" className="zc-btn" disabled={applying} aria-label="关闭截图识别" onClick={close}><X size={20} /></button></div>}
    footer={<div style={{ justifyContent: 'flex-end' }}><button type="button" className="zc-btn" disabled={applying} onClick={close}>取消</button><button type="button" className="zc-btn zc-btn--primary" onClick={() => void apply()}
      disabled={busy || applying || validating || clearing || (includeAttachment && !reviewedImage) || (applyFields && (!allowedState || !confirmed)) || (!includeAttachment && !keepOrder && !keepTracking && !(applyFields && Object.values(picked).some((value) => value !== undefined)))}>{applying ? '正在应用…' : attachmentOnly ? '应用脱敏附件' : includeAttachment || keepOrder || keepTracking ? '应用所选内容' : '应用所选字段'}</button></div>}>
    <div onPaste={paste} onDrop={drop} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}>
      <label className="zc-label" htmlFor={inputId}>选择截图，也可在此粘贴或拖入图片</label>
      <input id={inputId} type="file" className="zc-input" disabled={applying} accept="image/png,image/jpeg,image/webp" onChange={(event) => { void choose(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
      {file && <p role="status" className="zc-meta">已载入截图，可继续识别或选择另一张。</p>}
      <p className="zc-meta">PNG、JPEG、WebP，最大 20 MiB。首次准备公共识别资源需要联网；支持缓存的环境准备后可离线使用，其他环境仍可在本页识别。</p>
      {resourceStorage === 'session' && <p role="status" className="zc-meta">当前无法持久缓存，已使用本页临时资源，仍在本机识别。关闭或刷新页面后可能需要重新准备，无法保证离线重开。</p>}
      <button type="button" className="zc-btn" disabled={busy || clearing || validating} onClick={() => void clearCache()}>清理识别缓存</button>
      {cacheStatus && <p role="status" className="zc-meta">{cacheStatus}</p>}
      {validating && <p role="status">正在检查图片…</p>}
      {file && <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBlock: 16 }}>
        <button type="button" className="zc-btn" disabled={busy || validating || clearing} onClick={() => void recognize()}>准备并识别文字</button>
        {busy && <button type="button" className="zc-btn" onClick={cancel}>取消识别</button>}
        {busy && <span role="status" className="zc-meta">{progressLabel}</span>}
      </div>}
      {error && <p role="alert" className="zc-entry-field-error">{error}</p>}
      {file && <label className="zc-label" style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44 }}><input type="checkbox" checked={includeAttachment} disabled={attachmentOnly || applying || busy} onChange={(event) => { setIncludeAttachment(event.target.checked); setReviewedImage(undefined); }} />添加核对后的脱敏附件</label>}
      <div style={{ display: 'grid', gridTemplateColumns: compact || attachmentOnly || !order ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: 20 }}>
        {file && includeAttachment ? <OrderPrivacyEditor file={file} result={result} onReady={setReviewedImage} /> : url && <div><img src={url} alt="本机待识别截图，未上传" style={{ display: 'block', width: '100%', maxHeight: 560, objectFit: 'contain', border: '1px solid var(--border)' }} /></div>}
        {order && !attachmentOnly && <div>
          <label className="zc-label" style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44 }}><input type="checkbox" checked={applyFields} disabled={applying} onChange={(event) => setApplyFields(event.target.checked)} />填入核对后的金额与日期</label>
          <h3 className="zc-section-title">核对识别字段</h3>
          <p className="zc-caption">当前记账币种：{currency}。截图币种：{order.fields.currency.value ?? (order.fields.currency.state === 'ambiguous' ? '存在多个候选' : '未确认')}。已有手填字段默认不替换。</p>
          {(['amount', 'paymentDate', 'paymentTime'] as const).map((key) => {
            const target = key === 'paymentDate' ? 'date' : key === 'paymentTime' ? 'time' : 'amount';
            const field = order.fields[key];
            return <div key={key} style={{ paddingBlock: 10, borderBottom: '1px solid var(--border)' }}>
              <label className="zc-label" style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44 }}>
                <input type="checkbox" aria-label={`填入${LABELS[key]}`} checked={picked[target] !== undefined} disabled={!field.candidates.length || (target === 'time' && !picked.date)}
                  onChange={(event) => { setPicked((current) => ({ ...current, [target]: event.target.checked ? field.value ?? field.candidates[0]?.value : undefined, ...(target === 'date' && !event.target.checked ? { time: undefined } : {}) })); setConfirmed(false); }} />{LABELS[key]}
              </label>
              {field.candidates.length ? <select className="zc-select" aria-label={`${LABELS[key]}候选`} value={picked[target] ?? field.value ?? field.candidates[0]!.value}
                disabled={picked[target] === undefined} onChange={(event) => { setPicked((current) => ({ ...current, [target]: event.target.value })); setConfirmed(false); }}>
                {field.candidates.slice(0, 30).map((row) => <option key={row.value} value={row.value}>{row.value}</option>)}
              </select> : <p className="zc-meta">没有明确结果，保留表单原值。</p>}
              {field.state === 'ambiguous' && <p className="zc-meta">有多个候选，请勾选后核对。</p>}
              {values[target] && manual.has(target) && <p className="zc-meta">已有手填值：{values[target]}，勾选表示替换。</p>}
            </div>;
          })}
          {order.warnings.map((warning) => <p className="zc-caption" key={warning}>{warning}</p>)}
          {!allowedState && <p role="status" className="zc-caption">该截图包含待付款、关闭或退款等状态，请回到记账表单按实际情况处理。</p>}
          <label className="zc-label" style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44, marginTop: 16 }}>
            <input type="checkbox" checked={confirmed} disabled={!allowedState} onChange={(event) => setConfirmed(event.target.checked)} />金额、币种和已付款状态已核对
          </label>
          {picked.date && !picked.time && <p className="zc-meta">仅填日期时会清空原表单时间，避免把当前时刻记为付款时刻。</p>}
        </div>}
      </div>
      {file && <section style={{ marginTop: 20 }} aria-label="仅本机保留信息"><h3 className="zc-section-title">仅本机保留信息</h3>
        <p className="zc-caption">默认不保留。勾选后加密保存在此设备，与流水关联；不进入同步、审计或任何普通备份。清理本机数据后无法从备份找回。图片中的号码仍然遮盖。</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button type="button" className="zc-btn" disabled={applying} onClick={() => { setKeepOrder(false); setKeepTracking(false); }}>仅记账</button><button type="button" className="zc-btn" disabled={applying} onClick={() => { setKeepOrder(true); setKeepTracking(true); }}>保留售后信息</button></div>
        <label className="zc-label" style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44 }}><input type="checkbox" checked={keepOrder} disabled={applying} onChange={(event) => setKeepOrder(event.target.checked)} />订单号仅本机保留</label>
        {keepOrder && <label className="zc-label">核对订单号<input className="zc-input" value={privateOrder} disabled={applying} autoComplete="off" maxLength={64} onChange={(event) => setPrivateOrder(event.target.value)} /></label>}
        <label className="zc-label" style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44 }}><input type="checkbox" checked={keepTracking} disabled={applying} onChange={(event) => setKeepTracking(event.target.checked)} />物流单号仅本机保留</label>
        {keepTracking && <label className="zc-label">核对物流单号，多个号码换行分隔<textarea aria-label="核对物流单号，多个号码换行分隔" className="zc-input" value={privateTracking} disabled={applying} autoComplete="off" maxLength={520} onChange={(event) => setPrivateTracking(event.target.value)} /></label>}
      </section>}
      {result && <details style={{ marginTop: 16 }}><summary>识别文字与订单信息，仅本次查看</summary>
        {order && (['orderNumber', 'trackingNumber', 'merchant', 'product'] as const).map((key) => <p className="zc-meta" key={key}>{LABELS[key]}：{order.fields[key].value ?? (order.fields[key].state === 'ambiguous' ? '存在多个候选' : '未确认')}</p>)}
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-body)', fontSize: 'var(--fs-caption)' }}>{result.lines.slice(0, 1000).map((line) => line.text).join('\n')}</pre>
        <p className="zc-meta">以上文字不会填入备注、附件或自动草稿，关闭即清理。</p>
      </details>}
    </div>
  </DialogShell>;
}
