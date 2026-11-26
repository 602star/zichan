import { AttachmentReviewField } from './AttachmentReviewField.js';
import { copyTextToClipboard } from './diagnostics.js';
import { timeMinutes } from '../category-defaults.js';
import { useEffect, useRef, useState } from 'react';
import { D, isValidDay } from '@zichan/core';
import { LocalOcrSession } from '../order-capture/ocr-client.js';
import { parseOrder } from '../order-capture/parser.js';
import { captureFields, changedCaptureFields, suggestedCaptureFields } from '../order-capture/attachment-review.js';
import type { OcrResult, ParsedOrder } from '../order-capture/types.js';
import type { OcrProgress } from '../order-capture/resources.js';
import type { ReviewedRedactedImage } from '../order-capture/redaction.js';
import { OrderPrivacyEditor } from './OrderPrivacyEditor.js';
import { DialogShell } from './DialogShell.js';
import { useCompactView } from './useCompactView.js';

export type AttachmentRetention = 'redacted' | 'original' | 'none';
export interface AttachmentApplication {
  fields: Record<string, string>; baseline: Record<string, string>; baselineVersions: Record<string, number>; retention: AttachmentRetention; attachment?: ReviewedRedactedImage;
}
export function AttachmentProcessing({ file, pdfPages, values, versions, manual, assets, onApply, onClose }: {
  file: File; pdfPages?: number; values: Record<string, string>; versions: Record<string, number>; manual: ReadonlySet<string>; assets: { value: string; label: string }[];
  onApply: (application: AttachmentApplication) => Promise<void>; onClose: () => void;
}) {
  const compact = useCompactView();
  const baseline = useRef({ ...values }), live = useRef(values); live.current = values;
  const baselineVersions = useRef({ ...versions }), liveVersions = useRef(versions); liveVersions.current = versions;
  const session = useRef<LocalOcrSession>();
  const task = useRef<AbortController>();
  const epoch = useRef(0);
  const [result, setResult] = useState<OcrResult>();
  const [order, setOrder] = useState<ParsedOrder>();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const editsLive = useRef(edits); editsLive.current = edits;
  const [view, setView] = useState<'info' | 'privacy'>('info');
  const [evidence, setEvidence] = useState<{ label: string; lineIds: string[]; reason?: string }>();
  const evidenceCanvas = useRef<HTMLCanvasElement>(null);
  const [notice, setNotice] = useState('');
  const [retention, setRetention] = useState<AttachmentRetention>('redacted');
  const [reviewed, setReviewed] = useState<ReviewedRedactedImage>();
  const [busy, setBusy] = useState(false), [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<OcrProgress>();
  const [error, setError] = useState(''), [discard, setDiscard] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [previewTarget, setPreviewTarget] = useState<HTMLDivElement | null>(null);
  const cancel = () => { epoch.current++; task.current?.abort(); session.current?.dispose(); session.current = undefined; setBusy(false); };
  const run = async () => {
    cancel(); const current = ++epoch.current;
    baseline.current = { ...live.current }; baselineVersions.current = { ...liveVersions.current }; task.current = new AbortController(); session.current = new LocalOcrSession();
    setBusy(true); setError(''); setResult(undefined); setOrder(undefined); setReviewed(undefined);
    try {
      const data = await session.current.recognize(file, task.current.signal, (next) => { if (epoch.current === current) setProgress(next); });
      if (epoch.current !== current) return;
      const parsed = parseOrder(data.lines);
      setResult(data); setOrder(parsed);
      const currency = parsed.fields.currency.value;
      const asset = currency ? assets.find((row) => row.label.split(/\s|[·／/]/)[0]?.toUpperCase() === currency.toUpperCase()) : undefined;
      setSelected((current) => {
        const next = suggestedCaptureFields(parsed, live.current, manual, asset?.value);
        for (const key of Object.keys(editsLive.current)) { if (Object.hasOwn(current, key)) next[key] = editsLive.current[key]!; else delete next[key]; }
        return next;
      });
      if (!data.lines.length) setError('未找到有效交易信息。可重新提取，或只处理图片隐私。');
    } catch (cause) {
      if (epoch.current === current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : '本机识别失败，可重试或手动处理图片。');
    } finally { if (epoch.current === current) { setBusy(false); session.current?.dispose(); session.current = undefined; } }
  };
  useEffect(() => { const url = URL.createObjectURL(file); setSourceUrl(url); void run(); return () => { epoch.current++; task.current?.abort(); session.current?.dispose(); URL.revokeObjectURL(url); }; }, [file]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { cancel(); if (result || reviewed || Object.keys(edits).length || retention !== 'redacted') setDiscard(true); else onClose(); };
  const apply = async () => {
    if (busy || applying) return;
    setApplying(true); setError('');
    try {
      const conflicts = changedCaptureFields(baseline.current, live.current, selected, baselineVersions.current, liveVersions.current);
      if (conflicts.length) {
        setSelected((rows) => Object.fromEntries(Object.entries(rows).filter(([key]) => !conflicts.includes(key))));
        baseline.current = { ...live.current };
        baselineVersions.current = { ...liveVersions.current };
        throw new Error('表单在识别期间已修改，已取消冲突字段的回填。请重新核对后应用。');
      }
      const fields = Object.fromEntries(Object.entries(selected).map(([key, value]) => [key, value.trim()]));
      if (Object.keys(fields).length && order && !['paid', 'unknown'].includes(order.paymentState)) throw new Error('截图包含未付款、关闭或退款等状态，请按实际业务手工记账。');
      if (fields.amount !== undefined) {
        let valid = false;
        try { valid = !!fields.amount && D(fields.amount).isFinite() && D(fields.amount).gt(0); } catch { /* Show a field-specific error below. */ }
        if (!valid) throw new Error('请填写大于零的金额，或取消回填金额。');
      }
      if (fields.date !== undefined && !isValidDay(fields.date)) throw new Error('请核对有效日期，或取消回填日期。');
      if (fields.invoiceDate && !isValidDay(fields.invoiceDate)) throw new Error('请核对有效开票日期，或取消回填。');
      if (fields.invoiceNumber && !/^(?:\d{8}|\d{20})$/.test(fields.invoiceNumber)) throw new Error('请核对发票号码：通常为 8 位或 20 位数字。');
      if (fields.invoiceCode && !/^(?:\d{10}|\d{12})$/.test(fields.invoiceCode)) throw new Error('请核对发票代码：通常为 10 位或 12 位数字，数电发票可留空。');
      if (fields.time && timeMinutes(fields.time) === null) throw new Error('请核对有效交易时间。');
      for (const key of ['orderNumber', 'trackingNumber']) if (fields[key] && !/^[A-Za-z0-9_-]{4,80}$/.test(fields[key]!)) throw new Error('订单号或物流单号格式不明确，请直接修改该字段，或取消回填。');
      if (fields.date && !fields.time && !manual.has('time')) fields.time = '';
      if (retention === 'redacted' && !reviewed) throw new Error('请检查整张图片并确认隐私遮盖。');
      await onApply({ fields, baseline: baseline.current, baselineVersions: baselineVersions.current, retention, ...(retention === 'redacted' ? { attachment: reviewed } : {}) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '应用失败，请重试。'); }
    finally { setApplying(false); }
  };
  useEffect(() => {
    if (!evidence || !result) return;
    let active = true;
    void createImageBitmap(file).then((image) => {
      try {
        if (!active || !evidenceCanvas.current) return;
        const lines = result.lines.filter((line) => evidence.lineIds.includes(line.id));
        const points = lines.flatMap((line) => line.poly);
        if (!points.length) return;
        const x = Math.max(0, Math.floor(Math.min(...points.map(([x]) => x)) - 20));
        const y = Math.max(0, Math.floor(Math.min(...points.map(([, y]) => y)) - 20));
        const width = Math.min(image.width - x, Math.ceil(Math.max(...points.map(([x]) => x)) - x + 20));
        const height = Math.min(image.height - y, Math.ceil(Math.max(...points.map(([, y]) => y)) - y + 20));
        const canvas = evidenceCanvas.current; canvas.width = width; canvas.height = height;
        canvas.getContext('2d')?.drawImage(image, x, y, width, height, 0, 0, width, height);
      } finally { image.close(); }
    }).catch(() => { if (active) setNotice('无法显示局部依据，可查看当前原图。'); });
    return () => { active = false; };
  }, [evidence, result, file]);
  const choicesFor = (source: typeof captureFields[number][0]) => source === 'currency' ? assets : (order?.fields[source].candidates ?? []).map((row) => ({ value: row.value, label: row.value }));
  const recognized = (source: typeof captureFields[number][0]) => source === 'currency' ? assets.find((row) => row.label.split(/\s|[·／/]/)[0]?.toUpperCase() === order?.fields.currency.value?.toUpperCase())?.value : order?.fields[source].value ?? order?.fields[source].candidates[0]?.value;
  const field = ([source, target, originalLabel]: typeof captureFields[number]) => {
    const label = target === 'amount' && order?.documentKind === 'invoice' ? '价税合计' : originalLabel;
    const value = edits[target] ?? selected[target] ?? recognized(source) ?? '';
    const candidates = order?.fields[source].candidates ?? [];
    const candidate = candidates.find((row) => row.value === value);
    return <AttachmentReviewField key={target} label={label} target={target} value={value} included={Object.hasOwn(selected, target)} current={values[target]} protectedValue={manual.has(target)} edited={Object.hasOwn(edits, target)} busy={applying}
      choices={choicesFor(source)} onToggle={(checked) => setSelected((rows) => { const next = { ...rows }; if (checked) next[target] = value; else delete next[target]; return next; })}
      onChange={(value) => { setEdits((rows) => ({ ...rows, [target]: value })); setSelected((rows) => { const next = { ...rows, [target]: value }; if (target === 'assetId' && !value) delete next[target]; return next; }); }}
      onEvidence={candidates.some((row) => row.lineIds.length) ? () => setEvidence({ label, lineIds: candidate?.lineIds ?? candidates.flatMap((row) => row.lineIds), reason: candidate?.reason ?? (Object.hasOwn(edits, target) ? '已手动修改，下方展示截图中的识别依据。' : candidates[0]?.reason) }) : undefined}
      onCopy={['orderNumber', 'trackingNumber', 'invoiceNumber', 'invoiceCode'].includes(target) ? () => void copyTextToClipboard(value).then(() => setNotice(`${label}已复制`)).catch(() => setNotice('复制未成功，请在号码输入框中长按复制。')) : undefined} />;
  };
  const groupedTargets: string[] = ['orderNumber', 'trackingNumber', 'invoiceNumber', 'invoiceCode', 'invoiceDate'];
  const isPrimary = ([source, target]: typeof captureFields[number]) => target === 'amount' || (order?.documentKind !== 'invoice' && ['date', 'time'].includes(target)) || (!!recognized(source) && (target !== 'assetId' || recognized(source) !== values.assetId));
  const primaryFields = captureFields.filter((row) => !groupedTargets.includes(row[1]) && isPrimary(row));
  const additionalFields = captureFields.filter((row) => !groupedTargets.includes(row[1]) && !isPrimary(row));
  const orderFields = captureFields.filter(([, target]) => ['orderNumber', 'trackingNumber'].includes(target));
  const invoiceFields = captureFields.filter(([, target]) => ['invoiceNumber', 'invoiceCode', 'invoiceDate'].includes(target));
  const openPrivacy = compact && view === 'info' && retention === 'redacted' && !reviewed;
  const buttons = <div className="zc-attachment-actions"><button type="button" className="zc-btn" disabled={applying} onClick={close}>暂不处理</button><button type="button" className="zc-btn zc-btn--primary" disabled={busy || applying || (!openPrivacy && retention === 'redacted' && !reviewed)} onClick={() => { if (openPrivacy) setView('privacy'); else void apply(); }}>{applying ? '正在应用…' : openPrivacy ? '下一步：核对图片' : '确认并应用'}</button></div>;
  const content = <div className="zc-attachment-processing">
    {compact && <div className="zc-attachment-tabs" role="tablist" aria-label="附件处理内容"><button type="button" role="tab" aria-selected={view === 'info'} aria-controls="attachment-info-panel" onClick={() => setView('info')}>核对信息</button><button type="button" role="tab" aria-selected={view === 'privacy'} aria-controls="attachment-privacy-panel" onClick={() => setView('privacy')}>图片与隐私</button></div>}
    <details className="zc-attachment-file-tools"><summary>{busy ? '正在识别图片' : '图片信息与重新提取'}</summary><div className="zc-attachment-actions"><span className="zc-meta">{file.name}</span><button type="button" className="zc-btn" disabled={applying || busy} onClick={() => void run()}>重新提取</button>{busy && <button type="button" className="zc-btn" onClick={cancel}>取消识别</button>}<p className="zc-meta">{progress?.storage === 'session' ? '本页临时资源，刷新后可能需重新准备。' : '识别在本机运行。'}</p></div></details>
    {busy && <p role="status">{progress?.phase === 'resources' ? `准备识别资源 ${(progress.current / 1024 ** 2).toFixed(1)} / ${(progress.total / 1024 ** 2).toFixed(1)} MiB` : progress?.phase === 'recognizing' ? '正在识别图片…' : '正在启动本机识别…'}</p>}
    {error && <p role="alert" className="zc-entry-field-error">{error}</p>}
    {pdfPages && <p className="zc-meta">已在本机转换全部 {pdfPages} 页 PDF。保留脱敏图片将替换为包含全部页面的 PNG；保留原始 PDF 则保存原文件。</p>}
    <section id="attachment-info-panel" aria-label="信息核对" hidden={compact && view !== 'info'}>
      <div className="zc-attachment-source-strip"><img src={sourceUrl} alt="当前附件缩略图" /><button type="button" className="zc-entry-text-action" onClick={() => setEvidence({ label: '原图', lineIds: [] })}>查看原图</button></div>
      {order?.documentKind === 'invoice' && <p className="zc-caption" role="note">发票仅作为票面信息提取，不证明已经付款；开票日期独立保存。请确认未重复记账。</p>}
      <div className="zc-attachment-fields-compact">{primaryFields.map(field)}</div>
      {(order?.documentKind !== 'invoice' || orderFields.some(([source]) => recognized(source))) && <details><summary>订单信息{orderFields.some(([source]) => recognized(source)) ? ' · 已识别' : ''}</summary>{orderFields.map(field)}</details>}
      {(order?.documentKind === 'invoice' || invoiceFields.some(([source]) => recognized(source))) && <details><summary>发票信息{invoiceFields.some(([source]) => recognized(source)) ? ' · 已识别' : ''}</summary>{invoiceFields.map(field)}</details>}
      {additionalFields.length > 0 && <details><summary>补充字段（{additionalFields.length}）</summary>{additionalFields.map(field)}</details>}
      {order?.warnings.length ? <details><summary>需核对的提示（{order.warnings.length}）</summary>{order.warnings.map((warning) => <p className="zc-caption" key={warning}>{warning}</p>)}</details> : null}
      {notice && <p role="status" className="zc-meta">{notice}</p>}
      {evidence && <div className="zc-attachment-evidence" role="region" aria-label={`${evidence.label}识别依据`}><div className="zc-attachment-actions"><span>{evidence.label} · 本次原图依据</span><button type="button" className="zc-btn" onClick={() => setEvidence(undefined)}>收起依据</button></div>{evidence.reason && <p className="zc-meta">{evidence.reason}</p>}{evidence.lineIds.length ? <canvas ref={evidenceCanvas} role="img" aria-label={`${evidence.label}原图局部`} /> : <img src={sourceUrl} alt="本次处理原图，仅供核对" />}<p className="zc-meta">此预览不改变保存图片的打码。</p></div>}
    </section>
    <section id="attachment-privacy-panel" hidden={compact && view !== 'privacy'} aria-label="图片与隐私">
    {compact && <div className="zc-attachment-mobile-preview"><div ref={setPreviewTarget} />{retention !== 'redacted' && <img src={sourceUrl} alt="当前附件原图，仅供核对" style={{ width: '100%', maxHeight: 240, objectFit: 'contain' }} />}</div>}
    <label className="zc-label">附件保留与隐私<select className="zc-select" aria-label="附件保留与隐私" value={retention} disabled={busy || applying} onChange={(event) => setRetention(event.target.value as AttachmentRetention)}><option value="redacted">保留脱敏图片（推荐）</option><option value="original">{pdfPages ? '保留原始 PDF' : '保留原始图片'}</option><option value="none">不保留{pdfPages ? '附件' : '图片'}</option></select></label>
    <div hidden={retention !== 'redacted'}><OrderPrivacyEditor file={file} result={result} onReady={setReviewed} previewTarget={compact ? previewTarget : undefined} showPreview={retention === 'redacted'} /></div>
    {retention !== 'redacted' && <><p className="zc-caption">{retention === 'original' ? pdfPages ? '保留原始 PDF，不打码；原文件按普通附件参与同步与备份。' : '保留原始截图，不进行隐私打码；原图将按普通附件参与同步与备份。' : '回填信息后移除当前附件。'}</p>{!compact && <img src={sourceUrl} alt="当前附件原图，仅供核对" style={{ maxWidth: '100%', maxHeight: compact ? 240 : 400, objectFit: 'contain' }} />}</>}
    </section>
    {discard && <div role="alert"><p>尚未应用本次处理。放弃后，表单与附件保持原样。</p><div className="zc-attachment-actions"><button type="button" className="zc-btn" onClick={() => setDiscard(false)}>继续编辑</button><button type="button" className="zc-btn" onClick={onClose}>放弃本次处理</button></div></div>}
    {!compact && <div className="zc-attachment-panel-footer"><span className="zc-meta">{retention === 'redacted' ? `打码 ${reviewed?.privacyReview.maskCount ?? 0} 处` : retention === 'original' ? '保留原图' : '不保留图片'} · 确认后更新草稿，尚未保存流水</span>{buttons}</div>}
  </div>;
  return compact ? <DialogShell labelledBy="attachment-processing-title" onDismiss={close} dismissDisabled={applying} panelClassName="zc-attachment-mobile-page" panelStyle={{ width: '100%', height: '100dvh', maxHeight: '100dvh', borderRadius: 0 }} header={<h2 id="attachment-processing-title">附件处理</h2>} footer={buttons}>{content}</DialogShell> : content;
}
