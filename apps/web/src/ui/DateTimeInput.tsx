import { addDays, addMonths, isValidDay, localToday } from '@zichan/core';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type InputHTMLAttributes } from 'react';
import { DialogShell } from './DialogShell.js';

const touchQuery = '(pointer: coarse)';
const subscribe = (changed: () => void) => {
  const media = window.matchMedia(touchQuery);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
};
const pad = (value: number) => String(value).padStart(2, '0');

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  type: 'date' | 'time';
  value: string;
  onChange: (value: string) => void;
};

/** Touch opens a button-only picker; a fine pointer keeps native keyboard editing. */
export function DateTimeInput({ type, value, onChange, ...props }: Props) {
  const touch = useSyncExternalStore(subscribe, () => window.matchMedia(touchQuery).matches, () => false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const label = props['aria-label'] ?? (type === 'date' ? '日期' : '时间');
  const Icon = type === 'date' ? CalendarDays : Clock3;
  if (!touch && !open) return <input {...props} type={type} value={value} onChange={(event) => onChange(event.target.value)} />;
  const choose = (next: string) => { onChange(next); setOpen(false); };
  return <>
    <button ref={trigger} id={props.id} name={props.name} type="button" className={`${props.className ?? 'zc-input'} zc-datetime-trigger`}
      style={props.style} aria-label={label} aria-describedby={props['aria-describedby']} aria-invalid={props['aria-invalid']}
      aria-haspopup="dialog" aria-expanded={open} disabled={props.disabled}
      onClick={() => {
        // Explicitly end text entry before mounting a picker. Focus returns only to this button.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        trigger.current?.focus({ preventScroll: true });
        setOpen(true);
      }}>
      <span>{value || (type === 'date' ? '选择日期' : '选择时间')}</span><Icon size={18} aria-hidden="true" />
    </button>
    {open && <DialogShell labelledBy={titleId} onDismiss={() => setOpen(false)} panelClassName="zc-datetime-panel" backdropClassName="zc-backdrop zc-datetime-backdrop"
      header={<> <div className="zc-datetime-heading"><h2 id={titleId}>选择{label}</h2><button type="button" className="zc-btn" data-dialog-initial-focus onClick={() => setOpen(false)}>取消</button></div> </>}
    >

      {type === 'date'
        ? <DateSelection value={value} onChoose={choose} required={props.required} min={props.min} max={props.max} />
        : <TimeSelection value={value} onChoose={choose} required={props.required} seconds={String(props.step) === '1'} />}
    </DialogShell>}
  </>;
}

function DateSelection({ value, onChoose, required, min, max }: {
  value: string; onChoose: (value: string) => void; required?: boolean; min?: string | number; max?: string | number;
}) {
  const today = localToday();
  const [draft, setDraft] = useState(isValidDay(value) ? value : today);
  const [cursor, setCursor] = useState(isValidDay(value) ? value : today);
  const [view, setView] = useState<'day' | 'month' | 'year'>('day');
  const year = Number(cursor.slice(0, 4));
  const month = Number(cursor.slice(5, 7));
  const firstYear = Math.max(1, Math.floor(year / 12) * 12);
  const offset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const days = new Date(year, month, 0).getDate();
  const allowed = (date: string) => (!min || date >= String(min)) && (!max || date <= String(max));
  const shortcut = (date: string) => { setDraft(date); setCursor(date); setView('day'); };
  const move = (delta: number) => {
    const next = addMonths(`${cursor.slice(0, 7)}-01`, delta * (view === 'year' ? 144 : view === 'month' ? 12 : 1));
    if (next >= '0001-01-01' && next <= '9999-12-31') setCursor(next);
  };
  return <>
    <div className="zc-datetime-nav">
      <button type="button" aria-label="上一页" onClick={() => move(-1)}><ChevronLeft size={20} /></button>
      <button type="button" onClick={() => setView(view === 'day' ? 'month' : 'year')}>{view === 'year' ? `${firstYear}—${firstYear + 11} 年` : view === 'month' ? `${year} 年` : `${year} 年 ${month} 月`}</button>
      <button type="button" aria-label="下一页" onClick={() => move(1)}><ChevronRight size={20} /></button>
    </div>
    <div className="zc-datetime-tabs" role="group" aria-label="年月日视图">
      {(['year', 'month', 'day'] as const).map((item) => <button key={item} type="button" aria-pressed={view === item} onClick={() => setView(item)}>{item === 'year' ? '年' : item === 'month' ? '月' : '日'}</button>)}
    </div>
    {view === 'day' ? <div className="zc-datetime-days">
      {['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}
      {Array.from({ length: offset }, (_, index) => <span key={`empty-${index}`} />)}
      {Array.from({ length: days }, (_, index) => {
        const date = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(index + 1)}`;
        return <button type="button" key={date} aria-label={date} aria-pressed={draft === date} aria-current={date === today ? 'date' : undefined}
          disabled={!allowed(date)} onClick={() => setDraft(date)}>{index + 1}</button>;
      })}
    </div> : <div className="zc-datetime-periods">
      {Array.from({ length: 12 }, (_, index) => view === 'year' ? firstYear + index : index + 1).map((item) => <button type="button" key={item}
        aria-pressed={view === 'year' ? year === item : month === item} onClick={() => {
          setCursor(view === 'year' ? `${String(item).padStart(4, '0')}-${pad(month)}-01` : `${String(year).padStart(4, '0')}-${pad(item)}-01`);
          setView(view === 'year' ? 'month' : 'day');
        }}>{item}{view === 'year' ? ' 年' : ' 月'}</button>)}
    </div>}
    <div className="zc-datetime-shortcuts"><button type="button" disabled={!allowed(today)} onClick={() => shortcut(today)}>今天</button><button type="button" disabled={!allowed(addDays(today, -1))} onClick={() => shortcut(addDays(today, -1))}>昨天</button></div>
    <div className="zc-datetime-footer">
      {!required && <button type="button" className="zc-btn" onClick={() => onChoose('')}>清除日期</button>}
      <button type="button" className="zc-btn zc-btn--primary" disabled={!allowed(draft)} onClick={() => onChoose(draft)}>确定日期 · {draft.slice(5)}</button>
    </div>
  </>;
}

function TimeSelection({ value, onChoose, required, seconds }: { value: string; onChoose: (value: string) => void; required?: boolean; seconds: boolean }) {
  const [parts, setParts] = useState(() => (value || new Date().toTimeString().slice(0, seconds ? 8 : 5)).split(':'));
  const draft = Array.from({ length: seconds ? 3 : 2 }, (_, index) => parts[index] || '00').join(':');
  return <>
    <output className="zc-datetime-preview" aria-live="polite">{draft}</output>
    <div className="zc-time-columns">
      {(seconds ? ['时', '分', '秒'] : ['时', '分']).map((label, column) => <TimeColumn key={label} label={label} count={column === 0 ? 24 : 60}
        value={parts[column] || '00'} onChange={(next) => setParts((current) => { const updated = [...current]; updated[column] = next; return updated; })} />)}
    </div>
    <div className="zc-datetime-shortcuts"><button type="button" onClick={() => setParts(new Date().toTimeString().slice(0, seconds ? 8 : 5).split(':'))}>现在</button></div>
    <div className="zc-datetime-footer">
      {!required && <button type="button" className="zc-btn" onClick={() => onChoose('')}>清除时间</button>}
      <button type="button" className="zc-btn zc-btn--primary" onClick={() => onChoose(draft)}>确定时间</button>
    </div>
  </>;
}

function TimeColumn({ label, count, value, onChange }: { label: string; count: number; value: string; onChange: (value: string) => void }) {
  const selected = useRef<HTMLButtonElement>(null);
  const options = useRef<HTMLDivElement>(null);
  // Scroll only the column; scrollIntoView would also move the parent recording form.
  useLayoutEffect(() => {
    if (options.current && selected.current) options.current.scrollTop = selected.current.offsetTop - (options.current.clientHeight - selected.current.clientHeight) / 2;
  }, []);
  return <div><div className="zc-time-label">{label}</div><div className="zc-time-options" ref={options} role="group" aria-label={`选择${label}`}>
    {Array.from({ length: count }, (_, index) => pad(index)).map((item) => <button key={item} ref={item === value ? selected : undefined} type="button"
      aria-label={`${item}${label}`} aria-pressed={item === value} onClick={() => onChange(item)}>{item}</button>)}
  </div></div>;
}
