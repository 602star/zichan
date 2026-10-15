import { addMonths, localToday } from '@zichan/core';
import { useEffect, useRef, useState } from 'react';

type View = 'year' | 'month' | 'day';

const pad = (value: number) => String(value).padStart(2, '0');

/** Compact date picker using the same year → month → day navigation as the ledger timeline. */
export function CalendarDatePicker({ value, onChange, label }: {
  value: string;
  onChange: (date: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('day');
  const [cursor, setCursor] = useState(value || localToday());
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const year = Number(cursor.slice(0, 4));
  const month = Number(cursor.slice(5, 7));
  const select = (date: string) => { onChange(date); setCursor(date || localToday()); setOpen(false); };
  const move = (direction: -1 | 1) => {
    if (view === 'year') setCursor(`${year + direction * 12}-${pad(month)}-01`);
    else if (view === 'month') setCursor(`${year + direction}-${pad(month)}-01`);
    else setCursor(addMonths(`${cursor.slice(0, 7)}-01`, direction));
  };
  const monthStart = new Date(year, month - 1, 1);
  const offset = (monthStart.getDay() + 6) % 7;
  const days = new Date(year, month, 0).getDate();
  const firstYear = Math.floor(year / 12) * 12;

  return <div className="zc-calendar-picker" ref={root} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
    <button type="button" className="zc-calendar-trigger" aria-label={label} aria-expanded={open} onClick={() => {
      setCursor(value || localToday()); setView('day'); setOpen((current) => !current);
    }}>{value || '选择日期'} <span aria-hidden="true">▦</span></button>
    {open ? <div className="zc-calendar-popover" role="dialog" aria-label={label}>
      <div className="zc-calendar-nav">
        <button type="button" aria-label="上一页" onClick={() => move(-1)}>‹</button>
        <strong>{view === 'year' ? `${firstYear}—${firstYear + 11} 年` : view === 'month' ? `${year} 年` : `${year} 年 ${month} 月`}</strong>
        <button type="button" aria-label="下一页" onClick={() => move(1)}>›</button>
      </div>
      <div className="zc-calendar-tabs" role="tablist" aria-label="年月日视图">
        {(['year', 'month', 'day'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={view === item}
          onClick={() => setView(item)}>{item === 'year' ? '年' : item === 'month' ? '月' : '日'}</button>)}
      </div>
      {view === 'year' ? <div className="zc-calendar-grid zc-calendar-grid-period">
        {Array.from({ length: 12 }, (_, index) => firstYear + index).map((item) => <button key={item} type="button" aria-label={`${item} 年`}
          className={item === year ? 'selected' : ''} onClick={() => { setCursor(`${item}-${pad(month)}-01`); setView('month'); }}>{item}</button>)}
      </div> : null}
      {view === 'month' ? <div className="zc-calendar-grid zc-calendar-grid-period">
        {Array.from({ length: 12 }, (_, index) => index + 1).map((item) => <button key={item} type="button" aria-label={`${year} 年 ${item} 月`}
          className={item === month ? 'selected' : ''} onClick={() => { setCursor(`${year}-${pad(item)}-01`); setView('day'); }}>{item} 月</button>)}
      </div> : null}
      {view === 'day' ? <div className="zc-calendar-grid zc-calendar-grid-day">
        {['一', '二', '三', '四', '五', '六', '日'].map((item) => <span key={item} className="weekday">{item}</span>)}
        {Array.from({ length: offset }, (_, index) => <span key={`empty-${index}`} />)}
        {Array.from({ length: days }, (_, index) => {
          const date = `${year}-${pad(month)}-${pad(index + 1)}`;
          return <button key={date} type="button" aria-label={date} className={date === value ? 'selected' : date === localToday() ? 'today' : ''}
            onClick={() => select(date)}>{index + 1}</button>;
        })}
      </div> : null}
      <div className="zc-calendar-actions">
        <button type="button" onClick={() => select(localToday())}>今天</button>
        <button type="button" onClick={() => select('')}>清除日期</button>
      </div>
    </div> : null}
  </div>;
}
