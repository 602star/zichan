import { useState } from 'react';
import { normalizeIdentity } from '@zichan/db';
import { btnOutline } from './styles.js';
import { draftTagLabel, draftTagValue, restoredTagId, restoreTagValue } from '../transaction-tags.js';
import type { FieldOption } from './EntityFormModal.js';

export function TagPicker({ id, options, value, onChange }: {
  id: string; options: FieldOption[]; value: string; onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [groupName, setGroupName] = useState('');
  const selected = value.split(',').filter(Boolean);
  const text = query.trim();
  const label = (key: string) => {
    const option = options.find((row) => row.value === (restoredTagId(key) ?? key));
    return draftTagLabel(key) ?? (option ? option.label + (option.inactive && !restoredTagId(key) ? '（已停用）' : '') : '历史标签');
  };
  const matches = options.filter((option) => (!selected.includes(option.value) || option.inactive) && !selected.includes(restoreTagValue(option.value)) && normalizeIdentity(option.label).includes(normalizeIdentity(text)));
  const exact = options.filter((option) => normalizeIdentity(option.name ?? option.label) === normalizeIdentity(text));
  const groupedExact = exact.filter((option) => normalizeIdentity(option.groupName) === normalizeIdentity(groupName));
  const draft = draftTagValue(text, groupName);
  function add(key: string) {
    const restoreId = restoredTagId(key);
    onChange([...new Set([...selected.filter((item) => item !== restoreId), key])].join(','));
    setQuery('');
  }
  return <div>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
      {selected.map((key) => <button key={key} type="button" style={btnOutline} aria-label={`移除标签 ${label(key)}`} onClick={() => onChange(selected.filter((item) => item !== key).join(','))}>{label(key)} ×</button>)}
    </div>
    <input id={id} className="zc-input" value={query} placeholder="输入以搜索或创建标签" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!text) return;
        if (exact.length === 1 && !exact[0]!.inactive) add(exact[0]!.value);
        else if (!exact.length && !selected.includes(draft)) add(draft);
      } else if (event.key === 'Backspace' && !query && selected.length) onChange(selected.slice(0, -1).join(','));
    }} />
    {text && exact.length > 1 && <p role="status" className="zc-meta">有多个同名标签，请选择分组。</p>}
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
      {matches.slice(0, 20).map((option) => <button type="button" style={btnOutline} key={option.value} onClick={() => add(option.inactive ? restoreTagValue(option.value) : option.value)}>{option.inactive ? `恢复并选择标签“${option.label}”` : option.label}</button>)}
    </div>
    {selected.some((key) => options.some((o) => o.value === key && o.inactive)) && <p className="zc-meta">包含已停用标签，可移除或搜索后明确恢复。</p>}
    {text && <div style={{ marginTop: 8 }}>
      <label className="zc-meta">新标签分组（可选）<input className="zc-input" aria-label="新标签分组" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="不填则不分组" /></label>
      {!groupedExact.length && !selected.includes(draft) && <button type="button" style={btnOutline} onClick={() => add(draft)}>创建标签“{groupName ? `${groupName} / ` : ''}{text}”</button>}
    </div>}
  </div>;
}
