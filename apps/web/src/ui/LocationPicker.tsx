import { LocateFixed, MapPin, X } from 'lucide-react';
import { useState } from 'react';

/** Free text and saved locations share one input; new names are remembered on save. */
export function LocationPicker({ id, options, locationId, name, onChange, deviceBusy, onLocate }: {
  id: string;
  options: { value: string; label: string; name?: string }[];
  locationId: string;
  name: string;
  onChange: (id: string, name: string) => void;
  deviceBusy: boolean;
  onLocate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === locationId);
  const value = selected?.name ?? selected?.label ?? name;
  const query = locationId ? '' : name.trim().toLocaleLowerCase();
  const matches = options.filter((option) => option.label.toLocaleLowerCase().includes(query));
  const choose = (id: string, name: string) => { onChange(id, name); setOpen(false); };
  return <div className="zc-location-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <div className="zc-location-input-row">
      <input id={id} className="zc-input" role="combobox" aria-expanded={open} aria-controls={`${id}-suggestions`} aria-autocomplete="list"
        autoComplete="off" placeholder="搜索或输入地点" value={value}
        onFocus={() => setOpen(true)} onChange={(event) => { onChange('', event.target.value); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
          if (event.key === 'Enter') { event.preventDefault(); setOpen(false); }
          if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); document.getElementById(`${id}-option-0`)?.focus(); }
        }} />
      {value && <button type="button" className="zc-btn zc-location-action" aria-label="清除地点" onClick={() => choose('', '')}><X size={18} aria-hidden="true" /></button>}
      <button type="button" className="zc-btn zc-location-action" aria-label={deviceBusy ? '正在获取位置' : '获取当前位置'} disabled={deviceBusy} onClick={() => { setOpen(false); onLocate(); }}><LocateFixed size={18} aria-hidden="true" /></button>
    </div>
    {open && <div className="zc-location-suggestions">
      <div id={`${id}-suggestions`} role="listbox" aria-label="已有地点">
        {matches.slice(0, 20).map((option, index) => <button id={`${id}-option-${index}`} key={option.value} type="button" role="option" aria-selected={locationId === option.value}
          onClick={() => choose(option.value, option.name ?? option.label)} onKeyDown={(event) => {
            if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); document.getElementById(id)?.focus(); setOpen(false); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); document.getElementById(index === 0 && event.key === 'ArrowUp' ? id : `${id}-option-${index + (event.key === 'ArrowDown' ? 1 : -1)}`)?.focus();
            }
          }}><MapPin size={18} aria-hidden="true" /><span>{option.label}</span></button>)}
      </div>
      <p className="zc-meta">{query && !matches.some((option) => (option.name ?? option.label).trim().toLocaleLowerCase() === query) ? '直接填写新地点，保存后下次可选。' : !matches.length ? '还没有常用地点，可以直接输入。' : '选择已有地点，也可以直接输入新名称。'}</p>
    </div>}
  </div>;
}
