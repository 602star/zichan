import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { newId } from '@zichan/core';
import { detectPrivacyRegions, type MaskRegion } from '../order-capture/privacy.js';
import { redactOrderImage, type ReviewedRedactedImage } from '../order-capture/redaction.js';
import type { OcrResult } from '../order-capture/types.js';
import { createPortal } from 'react-dom';
import { useCompactView } from './useCompactView.js';

export function OrderPrivacyEditor({ file, result, onReady, previewTarget, showPreview = true }: { file: File; result?: OcrResult; onReady: (image: ReviewedRedactedImage | undefined) => void; previewTarget?: HTMLElement | null; showPreview?: boolean }) {
  const compact = useCompactView();
  const [expanded, setExpanded] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null), bitmap = useRef<ImageBitmap | null>(null), revision = useRef(0), source = useRef(newId());
  const ready = useRef(onReady); ready.current = onReady;
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
  const invalidate = () => { revision.current++; ready.current(undefined); setChecked(false); setBusy(false); setError(''); };
  useEffect(() => {
    let alive = true;
    const retire = () => { revision.current++; };
    revision.current++; ready.current(undefined); source.current = newId(); setSize(undefined); setManual([]); setChecked(false); setBusy(false); setError('');
    void createImageBitmap(file, { imageOrientation: 'from-image' }).then((image) => {
      if (!alive) { image.close(); return; }
      bitmap.current = image; setSize({ width: image.width, height: image.height });
    }).catch(() => { if (alive) setError('无法解码这张图片，请换图或先转换为 PNG。'); });
    return () => { alive = false; retire(); bitmap.current?.close(); bitmap.current = null; };
  }, [file]);
  useEffect(() => { revision.current++; ready.current(undefined); setChecked(false); setBusy(false); setExcluded([]); }, [automatic]);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context || !bitmap.current || !size) return;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, size.width, size.height); context.drawImage(bitmap.current, 0, 0);
    context.fillStyle = '#000000';
    if (!original) for (const row of [...selected, ...manual, ...(drag ? [drag] : [])]) context.fillRect(row.x, row.y, row.width, row.height);
  }, [selected, original, manual, drag, size, previewTarget, showPreview, editing, expanded]);
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
    const current = revision.current; setChecked(true); setBusy(true);
    try {
      const output = await redactOrderImage(bitmap.current, [...selected, ...manual], source.current);
      if (current === revision.current) ready.current(output);
    } catch { if (current === revision.current) { setChecked(false); setError('生成脱敏图片失败，请重试或裁剪图片。'); } }
    finally { if (current === revision.current) setBusy(false); }
  };
  const preview = (
    <div style={{ overflow: 'auto', maxHeight: 560, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
      <canvas onClick={() => { if (compact && !editing) setExpanded(true); }} ref={canvas} width={size?.width ?? 1} height={size?.height ?? 1} role="img" aria-label="脱敏附件预览，黑色区域为实际遮盖" style={{ display: 'block', width: `${zoom * 100}%`, maxWidth: 'none', height: 'auto', touchAction: editing ? 'none' : 'pan-x pan-y', cursor: editing ? 'crosshair' : 'default' }}
        onPointerDown={(event) => { if (!editing || !size || busy) return; event.preventDefault(); invalidate(); start.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={moved} onPointerCancel={() => { start.current = undefined; setDrag(undefined); }}
        onPointerUp={(event) => { if (!start.current || !size) return; const first = start.current, next = point(event); start.current = undefined; setDrag(undefined); add({ x: Math.floor(Math.min(first.x, next.x)), y: Math.floor(Math.min(first.y, next.y)), width: Math.ceil(Math.abs(first.x - next.x)), height: Math.ceil(Math.abs(first.y - next.y)), reason: '手工补充', required: false }); }} />
    </div>
  );
  return <section aria-label="附件隐私核对" className={compact && (editing || expanded) ? 'zc-order-privacy-fullscreen' : undefined} style={{ minWidth: 0 }}>
    {compact && (editing || expanded) && <button type="button" className="zc-btn" onClick={() => { setEditing(false); setExpanded(false); }}>返回附件处理</button>}
    <h3 className="zc-section-title">附件隐私核对</h3>
    <p className="zc-caption">预览中的黑色区域将写入图片。自动识别可能遗漏，请检查整张图，包括头像、地址、定位与码图。</p>
    <p role="status" className="zc-meta">{result ? `已打码 ${selected.length + manual.length} 处。${result.barcodeScan === 'complete' ? '已执行本地码图检测。' : '码图检测未完成，请手工检查。'}` : '尚未运行自动识别。可手工遮盖并检查整张图。'}</p>
    <div className={`zc-order-privacy-layout${previewTarget && !editing && !expanded ? ' has-external-preview' : ''}`}><div className="zc-order-privacy-preview">
    {showPreview && (previewTarget && !editing && !expanded ? createPortal(preview, previewTarget) : preview)}
    </div><div className="zc-order-privacy-settings">
    <div className="zc-attachment-actions"><button type="button" className="zc-btn" aria-pressed={original} onClick={() => setOriginal(true)}>原图</button><button type="button" className="zc-btn" aria-pressed={!original} onClick={() => setOriginal(false)}>脱敏预览</button><button type="button" className="zc-btn" disabled={busy} onClick={() => { invalidate(); setExcluded([]); }}>全选 / 恢复默认打码</button><button type="button" className="zc-btn" disabled={busy} onClick={() => { invalidate(); setExcluded(automatic.map((_, i) => i)); }}>取消全选</button></div>
    {automatic.map((row, index) => <label className="zc-label" key={index}><input type="checkbox" checked={!excluded.includes(index)} disabled={busy} onChange={(event) => { invalidate(); setExcluded((rows) => event.target.checked ? rows.filter((i) => i !== index) : [...rows, index]); }} />{row.reason} · 区域 {index + 1}</label>)}
    {(excluded.length > 0 || selected.length + manual.length === 0) && <p className="zc-caption">{selected.length + manual.length === 0 ? '当前图片未打码，不会标记为已脱敏。' : '部分已识别敏感区域未打码，请核对。'}</p>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBlock: 10 }}>
      <button type="button" className="zc-btn" aria-pressed={editing} disabled={!size || busy} onClick={() => setEditing((value) => !value)}>{editing ? '结束框选' : '框选补充遮盖'}</button>
      <button type="button" className="zc-btn" disabled={!manual.length || busy} onClick={() => { invalidate(); setManual((rows) => rows.slice(0, -1)); }}>撤销手工遮盖</button>
      <button type="button" className="zc-btn" disabled={!size || busy} onClick={() => add({ x: 0, y: 0, ...size!, reason: '整张遮盖', required: false })}>遮盖整张图片</button>
      <label className="zc-label" htmlFor={`${id}-zoom`}>缩放<select id={`${id}-zoom`} className="zc-select" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>{[1, 2, 4].map((value) => <option key={value} value={value}>{value * 100}%</option>)}</select></label>
    </div>
    {editing && <p className="zc-meta">按住图片拖出方框；手机框选时图片不滚动。结束框选后可滚动检查。</p>}
    <details style={{ marginTop: 10 }}><summary>手动调整打码区域</summary><p className="zc-meta">原图尺寸：{size ? `${size.width} × ${size.height}` : '正在读取'}。选中现有区域可移动或调整尺寸；也可添加新框。</p>
      <label className="zc-label">调整区域<select className="zc-select" value={adjust === undefined ? '' : String(adjust)} onChange={(event) => {
        const value = event.target.value;
        if (value.startsWith('auto:')) {
          const index = Number(value.slice(5)), row = automatic[index];
          if (row) { invalidate(); setExcluded((rows) => [...new Set([...rows, index])]); setManual((rows) => [...rows, { ...row, required: false }]); setAdjust(manual.length); setCoordinates(row); }
        } else { const index = value === '' ? undefined : Number(value); setAdjust(index); if (index !== undefined && manual[index]) setCoordinates(manual[index]!); }
      }}><option value="">新增区域</option>{automatic.map((_, i) => <option key={`auto:${i}`} value={`auto:${i}`}>调整自动区域 {i + 1}</option>)}{manual.map((_, i) => <option key={i} value={i}>手工区域 {i + 1}</option>)}</select></label>
      <div className="zc-order-mask-coordinate-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>{(['x', 'y', 'width', 'height'] as const).map((key) => <label className="zc-label" key={key}>{({ x: '左侧位置', y: '顶部位置', width: '遮盖宽度', height: '遮盖高度' })[key]}<input type="number" className="zc-input" min={0} value={coordinates[key]} onChange={(event) => setCoordinates((value) => ({ ...value, [key]: Number(event.target.value) }))} /></label>)}</div>
      <button type="button" className="zc-btn" disabled={!size || busy} onClick={() => { if (size) add({ x: Math.max(0, Math.min(size.width, coordinates.x)), y: Math.max(0, Math.min(size.height, coordinates.y)), width: Math.max(0, Math.min(size.width - coordinates.x, coordinates.width)), height: Math.max(0, Math.min(size.height - coordinates.y, coordinates.height)), reason: '手工坐标', required: false }); }}>添加遮盖区域</button>
      {adjust !== undefined && <><button type="button" className="zc-btn" disabled={busy} onClick={() => { invalidate(); setManual((rows) => rows.map((row, i) => i === adjust ? { ...row, ...coordinates } : row)); }}>更新区域位置与尺寸</button><button type="button" className="zc-btn" disabled={busy} onClick={() => { invalidate(); setManual((rows) => rows.filter((_, i) => i !== adjust)); setAdjust(undefined); }}>删除区域</button></>}
    </details>
    <label className="zc-label" style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44, marginTop: 12 }}><input type="checkbox" checked={checked} disabled={!size || busy || !!drag} onChange={(event) => void confirm(event.target.checked)} />已检查整张图片并确认隐私遮盖</label>
    {busy && <p role="status" className="zc-meta">正在生成脱敏图片及缩略图…</p>}
    {checked && !busy && !error && <p role="status" className="zc-meta">脱敏副本已准备，将按普通附件参与同步与备份；原图不保存。</p>}
    {error && <p role="alert" className="zc-entry-field-error">{error}</p>}
    </div></div>
  </section>;
}
