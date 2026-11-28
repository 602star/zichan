import { useState } from 'react';
import { DateTimeInput } from './DateTimeInput.js';

export function AttachmentReviewField({ label, target, value, included, current, protectedValue, choices, busy, edited, onToggle, onChange, onEvidence, onCopy }: {
  label: string; target: string; value: string; included: boolean; current?: string; protectedValue: boolean; edited: boolean; busy: boolean;
  choices: { value: string; label: string }[]; onToggle: (enabled: boolean) => void; onChange: (value: string) => void;
  onEvidence?: () => void; onCopy?: () => void;
}) {
  const [alternatives, setAlternatives] = useState(false);
  const type = target === 'date' || target === 'invoiceDate' ? 'date' : target === 'time' ? 'time' : 'text';
  const statusNote = protectedValue
    ? `${current ? `已有手填：${current}` : '保留已清空值'}${included ? '（将替换）' : ''}`
    : current && value === current
      ? '与表单一致'
      : edited
        ? '已手改'
        : '';
  const hasSecondaryRow = Boolean(statusNote || (choices.length > 1 && target !== 'assetId') || onEvidence || (onCopy && value));
  return <div className={`zc-attachment-review-field is-editable${target === 'date' || target === 'time' ? ' is-datetime' : ''}${included ? ' is-included' : ''}`}>
    <label className="zc-label zc-attachment-review-check"><input type="checkbox" checked={included} disabled={busy} onChange={(event) => onToggle(event.target.checked)} /><span>{label}</span></label>
    {target === 'assetId'
      ? <select className="zc-select" aria-label={`${label}候选`} disabled={busy} value={value} onChange={(event) => onChange(event.target.value)}><option value="">不回填币种</option>{choices.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}</select>
      : type === 'date' || type === 'time'
        ? <DateTimeInput className="zc-input" aria-label={`${label}候选`} type={type} step={target === 'time' ? 1 : undefined} value={value} disabled={busy} onChange={onChange} />
        : <input className="zc-input" aria-label={`${label}候选`} type="text" inputMode={target === 'amount' ? 'decimal' : undefined} value={value} placeholder="可手动填写" disabled={busy} autoComplete="off" onChange={(event) => onChange(event.target.value)} />}
    {hasSecondaryRow && (
      <div className="zc-attachment-field-actions">
        {statusNote && <span className="zc-meta">{statusNote}</span>}
        {choices.length > 1 && target !== 'assetId' && <button type="button" className="zc-entry-text-action" disabled={busy} onClick={() => setAlternatives((v) => !v)}>候选（{choices.length}）</button>}
        {onEvidence && <button type="button" className="zc-entry-text-action" onClick={onEvidence}>依据</button>}
        {onCopy && value && <button type="button" className="zc-entry-text-action" onClick={onCopy}>复制</button>}
      </div>
    )}
    {alternatives && <div className="zc-attachment-field-alternatives">{choices.map((row) => <button type="button" className="zc-btn zc-btn--sm" key={row.value} onClick={() => { onChange(row.value); setAlternatives(false); }}>{row.label}</button>)}</div>}
  </div>;
}
