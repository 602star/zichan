import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type PointerEvent } from 'react';
import { newId } from '@zichan/core';
import { detectPrivacyRegions, type MaskRegion } from '../order-capture/privacy.js';
import { redactOrderImage, type ReviewedRedactedImage } from '../order-capture/redaction.js';
import type { OcrResult } from '../order-capture/types.js';
import { createPortal } from 'react-dom';
import { useCompactView } from './useCompactView.js';

export interface PrivacyEditorStatus {
  ready: boolean;
  busy: boolean;
  maskCount: number;
}

export function OrderPrivacyEditor({
  file,
  result,
  onReady,
  previewTarget,
  showPreview = true,
  hideConfirmCheckbox = false,
  prepareRedactedRef,
  onStatusChange,
}: {
  file: File;
  result?: OcrResult;
  onReady: (image: ReviewedRedactedImage | undefined) => void;
  previewTarget?: HTMLElement | null;
  showPreview?: boolean;
  hideConfirmCheckbox?: boolean;
  prepareRedactedRef?: MutableRefObject<(() => Promise<ReviewedRedactedImage>) | null>;
  onStatusChange?: (status: PrivacyEditorStatus) => void;
}) {
  const compact = useCompactView();
  const [expanded, setExpanded] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null), bitmap = useRef<ImageBitmap | null>(null), revision = useRef(0), source = useRef(newId());
  const ready = useRef(onReady); ready.current = onReady;
  const statusCallback = useRef(onStatusChange); statusCallback.current = onStatusChange;
  const cachedOutput = useRef<{ rev: number; output: ReviewedRedactedImage } | null>(null);
  const id = useId();
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [manual, setManual] = useState<MaskRegion[]>([]), [drag, setDrag] = useState<MaskRegion>();
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const [editing, setEditing] = useState(false), [zoom, setZoom] = useState(1), [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [coordinates, setCoordinates] = useState({ x: 0, y: 0, width: 100, height: 100 });
  const automatic = useMemo(() => result ? detectPrivacyRegions(result) : [], [result]);
  const [excluded, setExcluded] = useState<number[]>([]);
  const [original, setOriginal] = useState(false);
  const [adjust, setAdjust] = useState<number>();
  const selected = useMemo(() => automatic.filter((_, index) => !excluded.includes(index)), [automatic, excluded]);
  const maskCount = selected.length + manual.length;
  const isReady = !!size && !busy && !drag;

  useEffect(() => {
    statusCallback.current?.({ ready: isReady, busy, maskCount });
  }, [isReady, busy, maskCount]);

  const invalidate = () => { revision.current++; cachedOutput.current = null; ready.current(undefined); setChecked(false); setBusy(false); setError(''); };
  useEffect(() => {
    let alive = true;
    const retire = () => { revision.current++; cachedOutput.current = null; };
    revision.current++; cachedOutput.current = null; ready.current(undefined); source.current = newId(); setSize(undefined); setManual([]); setChecked(false); setBusy(false); setError('');
    void createImageBitmap(file, { imageOrientation: 'from-image' }).then((image) => {
      if (!alive) { image.close(); return; }
      bitmap.current = image; setSize({ width: image.width, height: image.height });
    }).catch(() => { if (alive) setError('无法解码这张图片，请换图或先转换为 PNG。'); });
    return () => { alive = false; retire(); bitmap.current?.close(); bitmap.current = null; };
  }, [file]);
  useEffect(() => { revision.current++; cachedOutput.current = null; ready.current(undefined); setChecked(false); setBusy(false); setExcluded([]); }, [automatic]);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context || !bitmap.current || !size) return;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, size.width, size.height); context.drawImage(bitmap.current, 0, 0);
    context.fillStyle = '#000000';
    if (!original) for (const row of [...selected, ...manual, ...(drag ? [drag] : [])]) context.fillRect(row.x, row.y, row.width, row.height);
  }, [selected, original, manual, drag, size, previewTarget, showPreview, editing, expanded]);

  const generateRedacted = async (): Promise<ReviewedRedactedImage> => {
    if (!bitmap.current || !size) throw new Error('图片尚未加载完成，请稍候重试。');
    if (drag) throw new Error('请先松开完成当前框选遮盖。');
    if (cachedOutput.current && cachedOutput.current.rev === revision.current) return cachedOutput.current.output;
    const current = revision.current;
    setBusy(true); setError('');
    try {
      const output = await redactOrderImage(bitmap.current, [...selected, ...manual], source.current);
      if (current === revision.current) {
        cachedOutput.current = { rev: current, output };
        setChecked(true);
        ready.current(output);
      }
      return output;
    } catch (cause) {
      if (current === revision.current) {
        setChecked(false);
        setError('生成脱敏图片失败，请重试或裁剪图片。');
      }
      throw cause instanceof Error ? cause : new Error('生成脱敏图片失败，请重试或裁剪图片。');
    } finally {
      if (current === revision.current) setBusy(false);
    }
  };

  if (prepareRedactedRef) prepareRedactedRef.current = generateRedacted;
  useEffect(() => () => { if (prepareRedactedRef) prepareRedactedRef.current = null; }, [prepareRedactedRef]);

  const add = (row: MaskRegion) => { if (row.width < 1 || row.height < 1 || manual.length >= 128) return; invalidate(); setManual((rows) => [...rows, row]); };
  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(size!.width, (event.clientX - rect.left) / rect.width * size!.width)), y: Math.max(0, Math.min(size!.height, (event.clientY - rect.top) / rect.height * size!.height)) };
  };
  const moved = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!start.current || !size) return;
    const next = point(event), first = start.current;
    setDrag({ x: Math.floor(Math.min(first.x, next.x)), y: Math.floor(Math.min(first.y, next.y)), width: Math.ceil(Math.abs(first.x - next.x)), height: Math.ceil(Math.abs(first.y - next.y)), reason: '手工补充', required: false });
  };
  const confirm = async (confirmed: boolean) => {
    invalidate(); if (!confirmed || !bitmap.current) return;
    await generateRedacted().catch(() => undefined);
  };
  const preview = (
    <div className="zc-order-privacy-canvas-wrap">
      <canvas onClick={() => { if (compact && !editing) setExpanded(true); }} ref={canvas} width={size?.width ?? 1} height={size?.height ?? 1} role="img" aria-label="脱敏附件预览，黑色区域为实际遮盖" style={{ display: 'block', width: `${zoom * 100}%`, maxWidth: 'none', height: 'auto', touchAction: editing ? 'none' : 'pan-x pan-y', cursor: editing ? 'crosshair' : 'default' }}
        onPointerDown={(event) => { if (!editing || !size || busy) return; event.preventDefault(); invalidate(); start.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={moved} onPointerCancel={() => { start.current = undefined; setDrag(undefined); }}
        onPointerUp={(event) => { if (!start.current || !size) return; const first = start.current, next = point(event); start.current = undefined; setDrag(undefined); add({ x: Math.floor(Math.min(first.x, next.x)), y: Math.floor(Math.min(first.y, next.y)), width: Math.ceil(Math.abs(first.x - next.x)), height: Math.ceil(Math.abs(first.y - next.y)), reason: '手工补充', required: false }); }} />
    </div>
  );
  return <section aria-label="附件隐私核对" className={`zc-order-privacy-editor${compact && (editing || expanded) ? ' zc-order-privacy-fullscreen' : ''}`}>
    {compact && (editing || expanded) && <button type="button" className="zc-btn" onClick={() => { setEditing(false); setExpanded(false); }}>返回附件处理</button>}
    <div className="zc-privacy-toolbar">
      <div className="zc-attachment-actions">
        <button type="button" className="zc-btn zc-btn--sm" aria-pressed={editing} disabled={!size || busy} onClick={() => { setOriginal(false); setEditing((value) => !value); }}>{editing ? '结束框选' : '框选补充'}</button>
        {manual.length > 0 && <button type="button" className="zc-btn zc-btn--sm" disabled={busy} onClick={() => { invalidate(); setManual((rows) => rows.slice(0, -1)); }}>撤销框选</button>}
        <button type="button" className="zc-btn zc-btn--sm" aria-pressed={original} onClick={() => setOriginal((v) => !v)}>{original ? '返回脱敏图' : '对比原图'}</button>
      </div>
      <label className="zc-privacy-zoom" htmlFor={`${id}-zoom`}>
        <span>缩放</span>
        <select id={`${id}-zoom`} className="zc-select zc-select--compact" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>{[1, 2, 4].map((value) => <option key={value} value={value}>{value * 100}%</option>)}</select>
      </label>
    </div>
    {editing && <p className="zc-meta">在图片上按住拖出黑框补充遮盖；手机框选时图片暂停滚动。</p>}
    <div className="zc-order-privacy-preview">
      {showPreview && (previewTarget && !editing && !expanded ? createPortal(preview, previewTarget) : preview)}
    </div>
    <p role="status" className="zc-meta">
      {result
        ? `已遮盖 ${maskCount} 处（黑色区域将写入像素，原图不保存）${result.barcodeScan === 'complete' ? '' : ' · 码图请人工留意'}`
        : `手工遮盖 ${manual.length} 处 · 请检查头像、地址与码图`}
    </p>
    {(excluded.length > 0 || maskCount === 0) && (
      <p className="zc-caption">{maskCount === 0 ? '当前图片未遮盖任何区域，请确认无隐私信息。' : '已取消部分自动检测区域，请确认未遗漏敏感信息。'}</p>
    )}
    <details className="zc-privacy-details">
      <summary>遮盖区域明细与微调（自动 {selected.length}/{automatic.length}{manual.length ? ` · 手工 ${manual.length}` : ''}）</summary>
      <div className="zc-privacy-details-body">
        <div className="zc-attachment-actions">
          <button type="button" className="zc-btn zc-btn--sm" disabled={busy || !excluded.length} onClick={() => { invalidate(); setExcluded([]); }}>全选自动遮盖</button>
          <button type="button" className="zc-btn zc-btn--sm" disabled={busy || !selected.length} onClick={() => { invalidate(); setExcluded(automatic.map((_, i) => i)); }}>取消自动遮盖</button>
          <button type="button" className="zc-btn zc-btn--sm" disabled={!size || busy} onClick={() => add({ x: 0, y: 0, ...size!, reason: '整张遮盖', required: false })}>遮盖整张图</button>
        </div>
        {automatic.length > 0 && (
          <div className="zc-privacy-region-list">
            {automatic.map((row, index) => <label key={index}><input type="checkbox" checked={!excluded.includes(index)} disabled={busy} onChange={(event) => { invalidate(); setExcluded((rows) => event.target.checked ? rows.filter((i) => i !== index) : [...rows, index]); }} /><span>{row.reason} · 区域 {index + 1}</span></label>)}
          </div>
        )}
        <details className="zc-privacy-coords">
          <summary>按像素坐标精确微调</summary>
          <div className="zc-privacy-details-body">
            <p className="zc-meta">原图尺寸：{size ? `${size.width} × ${size.height}` : '正在读取'}</p>
            <label className="zc-label">调整目标<select className="zc-select" value={adjust === undefined ? '' : String(adjust)} onChange={(event) => {
              const value = event.target.value;
              if (value.startsWith('auto:')) {
                const index = Number(value.slice(5)), row = automatic[index];
                if (row) { invalidate(); setExcluded((rows) => [...new Set([...rows, index])]); setManual((rows) => [...rows, { ...row, required: false }]); setAdjust(manual.length); setCoordinates(row); }
              } else { const index = value === '' ? undefined : Number(value); setAdjust(index); if (index !== undefined && manual[index]) setCoordinates(manual[index]!); }
            }}><option value="">新增区域</option>{automatic.map((_, i) => <option key={`auto:${i}`} value={`auto:${i}`}>调整自动区域 {i + 1}</option>)}{manual.map((_, i) => <option key={i} value={i}>手工区域 {i + 1}</option>)}</select></label>
            <div className="zc-order-mask-coordinate-grid">{(['x', 'y', 'width', 'height'] as const).map((key) => <label className="zc-label" key={key}>{({ x: '左侧位置', y: '顶部位置', width: '遮盖宽度', height: '遮盖高度' })[key]}<input type="number" className="zc-input" min={0} value={coordinates[key]} onChange={(event) => setCoordinates((value) => ({ ...value, [key]: Number(event.target.value) }))} /></label>)}</div>
            <div className="zc-attachment-actions">
              <button type="button" className="zc-btn zc-btn--sm" disabled={!size || busy} onClick={() => { if (size) add({ x: Math.max(0, Math.min(size.width, coordinates.x)), y: Math.max(0, Math.min(size.height, coordinates.y)), width: Math.max(0, Math.min(size.width - coordinates.x, coordinates.width)), height: Math.max(0, Math.min(size.height - coordinates.y, coordinates.height)), reason: '手工坐标', required: false }); }}>添加遮盖框</button>
              {adjust !== undefined && <><button type="button" className="zc-btn zc-btn--sm" disabled={busy} onClick={() => { invalidate(); setManual((rows) => rows.map((row, i) => i === adjust ? { ...row, ...coordinates } : row)); }}>更新坐标</button><button type="button" className="zc-btn zc-btn--sm" disabled={busy} onClick={() => { invalidate(); setManual((rows) => rows.filter((_, i) => i !== adjust)); setAdjust(undefined); }}>删除该框</button></>}
            </div>
          </div>
        </details>
      </div>
    </details>
    {!hideConfirmCheckbox && (
      <label className="zc-privacy-confirm-check"><input type="checkbox" checked={checked} disabled={!size || busy || !!drag} onChange={(event) => void confirm(event.target.checked)} />已检查整张图片并确认隐私遮盖</label>
    )}
    {busy && <p role="status" className="zc-meta">正在生成脱敏图片及缩略图…</p>}
    {!hideConfirmCheckbox && checked && !busy && !error && <p role="status" className="zc-meta">脱敏副本已准备，将按普通附件参与同步与备份；原图不保存。</p>}
    {error && <p role="alert" className="zc-entry-field-error">{error}</p>}
  </section>;
}
