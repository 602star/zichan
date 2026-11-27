import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { ActionSheet } from './ActionSheet.js';
import { useCompactView } from './useCompactView.js';

export interface ValueOption { value: string; label: string; group?: string; disabled?: boolean; }

/** Native keyboard selection on desktop; searchable paper choices on a phone. */
export function ValuePicker({ id, name, label, value, options, onChange, disabled, required, invalid, describedBy }: {
  id: string;
  name?: string;
  label: string;
  value: string;
  options: ValueOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const compact = useCompactView();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const keyboard = useRef(false);
  const selected = options.find((option) => option.value === value);
  const matches = options.filter((option) => `${option.label} ${option.group ?? ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (open && keyboard.current) list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);
  if (!compact) return <select id={id} name={name} aria-label={label} aria-invalid={invalid || undefined} aria-describedby={describedBy} className="zc-select" value={value} disabled={disabled} required={required} onChange={(event) => onChange(event.target.value)}>
    {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </select>;
  return <>
    <button ref={trigger} id={id} type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-controls={open ? listId : undefined} aria-expanded={open} aria-required={required} aria-invalid={invalid || undefined} aria-describedby={describedBy} data-value={value} className="zc-select zc-value-picker-trigger" disabled={disabled} onClick={(event) => { keyboard.current = event.detail === 0; setSearch(''); setOpen(true); }}>
      <span>{selected?.label ?? '请选择'}</span><ChevronDown size={18} aria-hidden="true" />
    </button>
    {open && <ActionSheet title={`选择${label}`} onClose={close} actions={[]}>
      {options.length > 8 && <input type="search" className="zc-input zc-value-picker-search" aria-label={`搜索${label}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入名称查找" />}
      <div ref={list} id={listId} role="listbox" aria-label={label} className="zc-value-picker-list" onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault(); buttons[next]?.focus();
      }}>
        {matches.map((option) => <button type="button" role="option" key={option.value} aria-selected={option.value === value} disabled={option.disabled} onClick={() => { onChange(option.value); close(); }}>
          <span>{option.group && <small>{option.group}</small>}{option.label}</span>{option.value === value && <Check size={18} aria-hidden="true" />}
        </button>)}
        {!matches.length && <p className="zc-caption">未找到匹配项，请更换名称查找。</p>}
      </div>
    </ActionSheet>}
  </>;
}
