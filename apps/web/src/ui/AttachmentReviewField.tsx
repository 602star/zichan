import { useState } from 'react';

export function AttachmentReviewField({ label, target, value, included, current, protectedValue, choices, busy, edited, onToggle, onChange, onEvidence, onCopy }: {
  label: string; target: string; value: string; included: boolean; current?: string; protectedValue: boolean; edited: boolean; busy: boolean;
  choices: { value: string; label: string }[]; onToggle: (enabled: boolean) => void; onChange: (value: string) => void;
  onEvidence?: () => void; onCopy?: () => void;
}) {
  const [alternatives, setAlternatives] = useState(false);
  const type = target === 'date' ? 'date' : target === 'time' ? 'time' : 'text';
  return <div className={`zc-attachment-review-field is-editable${target === 'date' || target === 'time' ? ' is-datetime' : ''}`}>
    <label className="zc-label"><input type="checkbox" checked={included} disabled={busy} onChange={(event) => onToggle(event.target.checked)} />{label}</label>
    {target === 'assetId' ? <select className="zc-select" aria-label={`${label}候选`} disabled={busy} value={value} onChange={(event) => onChange(event.target.value)}><option value="">不回填币种</option>{choices.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}</select>
      : <input className="zc-input" aria-label={`${label}候选`} type={type} step={target === 'time' ? 1 : undefined} inputMode={target === 'amount' ? 'decimal' : undefined} value={value} placeholder="可手动填写" disabled={busy} autoComplete="off" onChange={(event) => onChange(event.target.value)} />}
    <div className="zc-attachment-field-actions">
      {edited && <span className="zc-meta">已手动修改</span>}
      {choices.length > 1 && target !== 'assetId' && <button type="button" className="zc-entry-text-action" disabled={busy} onClick={() => setAlternatives((v) => !v)}>其他识别结果（{choices.length}）</button>}
      {onEvidence && <button type="button" className="zc-entry-text-action" onClick={onEvidence}>查看依据</button>}
      {onCopy && value && <button type="button" className="zc-entry-text-action" onClick={onCopy}>复制{label}</button>}
    </div>
    {alternatives && <div className="zc-attachment-field-alternatives">{choices.map((row) => <button type="button" className="zc-btn" key={row.value} onClick={() => { onChange(row.value); setAlternatives(false); }}>{row.label}</button>)}</div>}
    {protectedValue && <p className="zc-meta">{current ? `保留已有：${current}` : '保留你主动清空的值'}{included ? '；已选择替换' : ''}</p>}
    {!protectedValue && current && value === current && <p className="zc-meta">与表单一致</p>}
  </div>;
}
