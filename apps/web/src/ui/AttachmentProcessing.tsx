import { X } from 'lucide-react';
import { AttachmentReviewField } from './AttachmentReviewField.js';
import { copyTextToClipboard } from './diagnostics.js';
import { timeMinutes } from '../category-defaults.js';
import { useEffect, useRef, useState } from 'react';
import { D, isValidDay } from '@zichan/core';
import { LocalOcrSession } from '../order-capture/ocr-client.js';
import { parseOrder } from '../order-capture/parser.js';
import { captureFields, changedCaptureFields, partitionCaptureFields, suggestedCaptureFields } from '../order-capture/attachment-review.js';
import type { OcrResult, ParsedOrder } from '../order-capture/types.js';
import type { OcrProgress } from '../order-capture/resources.js';
import type { ReviewedRedactedImage } from '../order-capture/redaction.js';
import { OrderPrivacyEditor, type PrivacyEditorStatus } from './OrderPrivacyEditor.js';
import { ConfirmDialog } from './ConfirmDialog.js';
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
  const prepareRedactedRef = useRef<(() => Promise<ReviewedRedactedImage>) | null>(null);
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
  const [privacyStatus, setPrivacyStatus] = useState<PrivacyEditorStatus>({ ready: false, busy: false, maskCount: 0 });
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
      if (!data.lines.length) setError('未找到有效交易文字。可重新识别，或只处理左侧图片隐私。');
    } catch (cause) {
      if (epoch.current === current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : '本机识别失败，可重试或手动处理图片。');
    } finally { if (epoch.current === current) { setBusy(false); session.current?.dispose(); session.current = undefined; } }
  };
  useEffect(() => { const url = URL.createObjectURL(file); setSourceUrl(url); void run(); return () => { epoch.current++; task.current?.abort(); session.current?.dispose(); URL.revokeObjectURL(url); }; }, [file]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { cancel(); if (Object.keys(edits).length || retention !== 'redacted') setDiscard(true); else onClose(); };
  const apply = async (overrideRetention?: AttachmentRetention) => {
    if (busy || applying) return;
    const effectiveRetention = overrideRetention ?? retention;
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
      if (effectiveRetention === 'none' && Object.keys(fields).length === 0) throw new Error('请至少勾选一项要填入的信息，或直接在附件列表移除该文件。');
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
      let attachment = reviewed;
      if (effectiveRetention === 'redacted') {
        if (!prepareRedactedRef.current) throw new Error('图片隐私预览尚未就绪，请稍候重试。');
        attachment = await prepareRedactedRef.current();
      }
      await onApply({ fields, baseline: baseline.current, baselineVersions: baselineVersions.current, retention: effectiveRetention, ...(effectiveRetention === 'redacted' ? { attachment } : {}) });
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

  const recognizedCurrencyId = assets.find((row) => row.label.split(/\s|[·／/]/)[0]?.toUpperCase() === order?.fields.currency.value?.toUpperCase())?.value;
  const { recognized: recognizedFields, unrecognized: unrecognizedFields, recognizedValue } = partitionCaptureFields(
    order,
    values,
    selected,
    edits,
    recognizedCurrencyId,
  );
  const choicesFor = (source: typeof captureFields[number][0]) => source === 'currency' ? assets : (order?.fields[source].candidates ?? []).map((row) => ({ value: row.value, label: row.value }));
  const renderField = ([source, target, originalLabel]: typeof captureFields[number]) => {
    const label = target === 'amount' && order?.documentKind === 'invoice' ? '价税合计' : originalLabel;
    const value = edits[target] ?? selected[target] ?? recognizedValue(source) ?? '';
    const candidates = order?.fields[source].candidates ?? [];
    const candidate = candidates.find((row) => row.value === value);
    return <AttachmentReviewField key={target} label={label} target={target} value={value} included={Object.hasOwn(selected, target)} current={values[target]} protectedValue={manual.has(target)} edited={Object.hasOwn(edits, target)} busy={applying}
      choices={choicesFor(source)} onToggle={(checked) => setSelected((rows) => { const next = { ...rows }; if (checked) next[target] = value; else delete next[target]; return next; })}
      onChange={(nextValue) => { setEdits((rows) => ({ ...rows, [target]: nextValue })); setSelected((rows) => { const next = { ...rows, [target]: nextValue }; if (target === 'assetId' && !nextValue) delete next[target]; return next; }); }}
      onEvidence={candidates.some((row) => row.lineIds.length) ? () => setEvidence({ label, lineIds: candidate?.lineIds ?? candidates.flatMap((row) => row.lineIds), reason: candidate?.reason ?? (Object.hasOwn(edits, target) ? '已手动修改，下方展示截图中的识别依据。' : candidates[0]?.reason) }) : undefined}
      onCopy={['orderNumber', 'trackingNumber', 'invoiceNumber', 'invoiceCode'].includes(target) ? () => void copyTextToClipboard(value).then(() => setNotice(`${label}已复制`)).catch(() => setNotice('复制未成功，请在号码输入框中长按复制。')) : undefined} />;
  };

  const selectedCount = Object.keys(selected).length;
  const openPrivacy = compact && view === 'info' && retention === 'redacted';
  const primaryDisabled = busy || applying || (!openPrivacy && retention === 'redacted' && !privacyStatus.ready) || (retention === 'none' && selectedCount === 0);
  const primaryLabel = applying
    ? '正在应用…'
    : openPrivacy
      ? '下一步：核对打码'
      : retention === 'redacted'
        ? '已核对打码并应用'
        : retention === 'original'
          ? (pdfPages ? '保留原 PDF 并应用' : '保留原图并应用')
          : '填入信息并移除图片';

  const footer = (
    <>
      {error && <div role="alert" className="zc-modal-footer-error">{error}</div>}
      <div className="zc-modal-footer">
        {!compact && (
          <div className="zc-modal-footer-left">
            <span className="zc-meta">
              已勾选 {selectedCount} 项回填
              {retention === 'redacted' ? ` · 遮盖 ${privacyStatus.maskCount} 处` : retention === 'original' ? ' · 保留原文件' : ' · 不保留图片'}
            </span>
          </div>
        )}
        <div className="zc-modal-footer-actions">
          <button type="button" className="zc-btn" disabled={applying} onClick={close}>暂不处理</button>
          {retention !== 'none' && (
            <button
              type="button"
              className="zc-btn"
              disabled={busy || applying || selectedCount === 0}
              title={selectedCount === 0 ? '请先勾选至少一项要回填的识别字段' : '仅将勾选字段填入记账表单，并移除这张截图'}
              onClick={() => void apply('none')}
            >
              仅填入信息（不留图）
            </button>
          )}
          <button
            type="button"
            className="zc-btn zc-btn--primary"
            disabled={primaryDisabled}
            onClick={() => { if (openPrivacy) setView('privacy'); else void apply(); }}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      <DialogShell
        labelledBy="attachment-processing-title"
        onDismiss={close}
        dismissDisabled={applying}
        onSaveShortcut={() => { if (!primaryDisabled && !openPrivacy) void apply(); }}
        panelClassName={compact ? 'zc-attachment-dialog zc-attachment-mobile-page' : 'zc-attachment-dialog'}
        panelStyle={compact
          ? { width: '100%', height: '100dvh', maxHeight: '100dvh', borderRadius: 0 }
          : { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', width: 'min(960px, calc(100vw - 32px))', maxHeight: 'min(860px, calc(100dvh - 32px))' }}
        header={
          <div className="zc-modal-header">
            <div className="zc-attachment-dialog-heading">
              <h2 id="attachment-processing-title" className="zc-modal-title">提取附件信息</h2>
              <span className="zc-meta">{file.name}{pdfPages ? ` · 共 ${pdfPages} 页 PDF` : ''} · 本机识别</span>
            </div>
            <div className="zc-modal-header-tools">
              {busy ? (
                <button type="button" className="zc-btn zc-btn--sm" onClick={cancel}>取消识别</button>
              ) : (
                <button type="button" className="zc-btn zc-btn--sm" disabled={applying} onClick={() => void run()}>重新识别</button>
              )}
              <button type="button" className="zc-dialog-close" aria-label="关闭附件处理" title="关闭 (Esc)" disabled={applying} onClick={close}>
                <X size={20} aria-hidden="true" />
              </button>
            </div>
          </div>
        }
        footer={footer}
      >
        {compact && (
          <div className="zc-attachment-tabs" role="tablist" aria-label="附件处理内容">
            <button type="button" role="tab" aria-selected={view === 'info'} aria-controls="attachment-info-panel" onClick={() => setView('info')}>核对信息{selectedCount ? `（${selectedCount}）` : ''}</button>
            <button type="button" role="tab" aria-selected={view === 'privacy'} aria-controls="attachment-privacy-panel" onClick={() => setView('privacy')}>图片与隐私</button>
          </div>
        )}
        <div className={compact ? 'zc-attachment-processing' : 'zc-attachment-workspace'}>
          <section id="attachment-privacy-panel" className="zc-attachment-pane zc-attachment-pane--media" hidden={compact && view !== 'privacy'} aria-label="图片与隐私">
            {compact && (
              <div className="zc-attachment-mobile-preview">
                <div ref={setPreviewTarget} />
                {retention !== 'redacted' && <img src={sourceUrl} alt="当前附件原图，仅供核对" className="zc-attachment-raw-preview" />}
              </div>
            )}
            <label className="zc-label zc-attachment-retention-field">
              <span>附件保留与隐私</span>
              <select className="zc-select" aria-label="附件保留与隐私" value={retention} disabled={busy || applying} onChange={(event) => setRetention(event.target.value as AttachmentRetention)}>
                <option value="redacted">保留脱敏图片（推荐）</option>
                <option value="original">{pdfPages ? '保留原始 PDF' : '保留原始图片'}</option>
                <option value="none">不保留{pdfPages ? '附件' : '图片'}（仅填表）</option>
              </select>
            </label>
            {pdfPages && <p className="zc-meta">已转换全部 {pdfPages} 页 PDF。保留脱敏图片将替换为合并 PNG；保留原始 PDF 则保存原文件。</p>}
            <div hidden={retention !== 'redacted'}>
              <OrderPrivacyEditor
                file={file}
                result={result}
                onReady={setReviewed}
                previewTarget={compact ? previewTarget : undefined}
                showPreview={retention === 'redacted'}
                hideConfirmCheckbox
                prepareRedactedRef={prepareRedactedRef}
                onStatusChange={setPrivacyStatus}
              />
            </div>
            {retention !== 'redacted' && (
              <div className="zc-attachment-nonredacted">
                {!compact && <img src={sourceUrl} alt="当前附件原图，仅供核对" className={`zc-attachment-raw-preview${retention === 'none' ? ' is-discarded' : ''}`} />}
                <p className="zc-caption">
                  {retention === 'original'
                    ? (pdfPages ? '保留原始 PDF，不进行打码；原文件按普通附件参与同步与备份。' : '保留原始截图，不进行打码；原图按普通附件参与同步与备份。')
                    : '仅把右侧勾选的交易字段填入表单，完成后自动移除这张附件。'}
                </p>
              </div>
            )}
          </section>

          <section id="attachment-info-panel" className="zc-attachment-pane zc-attachment-pane--fields" hidden={compact && view !== 'info'} aria-label="信息核对">
            {compact && (
              <div className="zc-attachment-source-strip">
                <img src={sourceUrl} alt="当前附件缩略图" />
                <button type="button" className="zc-entry-text-action" onClick={() => setEvidence({ label: '原图', lineIds: [] })}>查看原图</button>
              </div>
            )}
            {order?.documentKind === 'invoice' && (
              <p className="zc-caption" role="note">发票仅提取票面信息，开票日期独立保存，请确认未与支付账单重复记账。</p>
            )}
            {busy && (
              <div className="zc-attachment-recognizing" role="status">
                <span>
                  {progress?.phase === 'resources'
                    ? `正在准备本机识别资源 ${(progress.current / 1024 ** 2).toFixed(1)} / ${(progress.total / 1024 ** 2).toFixed(1)} MiB…`
                    : progress?.phase === 'recognizing'
                      ? '正在识别截图文字…'
                      : '正在启动本机识别…'}
                </span>
                {progress?.storage === 'session' && <span className="zc-meta">使用本页临时资源，原图不上传。</span>}
              </div>
            )}
            {!busy && recognizedFields.length === 0 && (
              <p className="zc-caption">未自动识别出明确字段。可展开下方手动补填，或仅在左侧处理图片隐私后应用。</p>
            )}
            {recognizedFields.length > 0 && (
              <div className="zc-attachment-fields-compact">
                {recognizedFields.map(renderField)}
              </div>
            )}
            {!busy && unrecognizedFields.length > 0 && (
              <details className="zc-attachment-more-fields">
                <summary>手动补填其他字段（{unrecognizedFields.length}）</summary>
                <div className="zc-attachment-fields-compact">{unrecognizedFields.map(renderField)}</div>
              </details>
            )}
            {order?.warnings.length ? (
              <details className="zc-attachment-more-fields" open>
                <summary>需核对的提示（{order.warnings.length}）</summary>
                {order.warnings.map((warning) => <p className="zc-caption" key={warning}>{warning}</p>)}
              </details>
            ) : null}
            {notice && <p role="status" className="zc-meta">{notice}</p>}
            {evidence && (
              <div className="zc-attachment-evidence" role="region" aria-label={`${evidence.label}识别依据`}>
                <div className="zc-attachment-actions">
                  <span className="zc-meta">{evidence.label} · 截图局部依据（不改变打码）</span>
                  <button type="button" className="zc-btn zc-btn--sm" onClick={() => setEvidence(undefined)}>收起</button>
                </div>
                {evidence.reason && <p className="zc-meta">{evidence.reason}</p>}
                {evidence.lineIds.length ? <canvas ref={evidenceCanvas} role="img" aria-label={`${evidence.label}原图局部`} /> : <img src={sourceUrl} alt="本次处理原图，仅供核对" />}
              </div>
            )}
          </section>
        </div>
      </DialogShell>
      {discard && (
        <ConfirmDialog
          title="放弃本次附件处理？"
          confirmLabel="放弃处理"
          cancelLabel="继续核对"
          tone="danger"
          onCancel={() => setDiscard(false)}
          onConfirm={onClose}
        >
          尚未应用本次修改或保留方式设置。放弃后，记账表单与原附件保持不变。
        </ConfirmDialog>
      )}
    </>
  );
}
