import { useState } from 'react';
import { btnOutline } from './styles.js';
import { draftTagName, draftTagValue } from '../transaction-tags.js';
import type { FieldOption } from './EntityFormModal.js';

export function TagPicker({ id, options, value, onChange }: {
  id: string;
  options: FieldOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const selected = value.split(',').filter(Boolean);
  const text = query.trim();
  const label = (key: string) => draftTagName(key) ?? options.find((option) => option.value === key)?.label ?? '历史标签';
  const matches = options.filter((option) => !option.inactive && !selected.includes(option.value) && option.label.toLocaleLowerCase().includes(text.toLocaleLowerCase()));
  const exact = options.find((option) => (option.name ?? option.label).trim().toLocaleLowerCase() === text.toLocaleLowerCase());
  const alreadySelected = selected.some((key) => label(key).toLocaleLowerCase() === text.toLocaleLowerCase()) || (exact && selected.includes(exact.value));
  function add(key: string) {
    onChange([...new Set([...selected, key])].join(','));
    setQuery('');
  }
  return <div>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
      {selected.map((key) => <button key={key} type="button" style={{ ...btnOutline, minHeight: 32, padding: '4px 10px' }} aria-label={`移除标签 ${label(key)}`} onClick={() => onChange(selected.filter((item) => item !== key).join(','))}>
        {label(key)} ×
      </button>)}
    </div>
    <input id={id} className="zc-input" value={query} placeholder="输入以搜索或创建标签" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (text && !alreadySelected) add(exact && !exact.inactive ? exact.value : draftTagValue(text));
      } else if (event.key === 'Backspace' && !query && selected.length) {
        onChange(selected.slice(0, -1).join(','));
      }
    }} />
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
      {matches.slice(0, 20).map((option) => <button type="button" style={{ ...btnOutline, minHeight: 32, padding: '4px 10px' }} key={option.value} onClick={() => add(option.value)}>{option.label}</button>)}
      {text && !alreadySelected && !exact && <button type="button" style={{ ...btnOutline, minHeight: 32, padding: '4px 10px' }} onClick={() => add(draftTagValue(text))}>创建标签“{text}”</button>}
      {text && !alreadySelected && exact?.inactive && <button type="button" style={{ ...btnOutline, minHeight: 32, padding: '4px 10px' }} onClick={() => add(draftTagValue(text))}>恢复并选择标签“{text}”</button>}
    </div>
  </div>;
}
