import { addDays, addMonths, localToday } from '@zichan/core';
import type { CSSProperties, ReactNode } from 'react';
import { card, iconBtn } from './styles.js';
import type { TimelineViewMode } from './DateRangeBar.js';

export function TimelineExplorer<T>(props: {
  items: T[];
  view: TimelineViewMode;
  focusDate: string;
  onFocusDate: (date: string) => void;
  onViewChange: (view: TimelineViewMode) => void;
  dateOf: (item: T) => string;
  timeOf?: (item: T) => string;
  keyOf: (item: T) => string;
  renderCompact: (item: T) => ReactNode;
  renderEntry: (item: T) => ReactNode;
  renderSummary?: (items: T[]) => ReactNode;
  onOpen?: (item: T) => void;
  emptyText?: string;
}) {
  const {
    items, view, focusDate, onFocusDate, onViewChange, dateOf, timeOf, keyOf,
    renderCompact, renderEntry, renderSummary, onOpen, emptyText = '该时间范围内没有记录。',
  } = props;
  const sorted = [...items].sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || (timeOf ? timeOf(b).localeCompare(timeOf(a)) : 0) || keyOf(a).localeCompare(keyOf(b)));

  if (view === 'year') {
    const year = focusDate.slice(0, 4);
    const years = [...new Set([year, localToday().slice(0, 4), ...items.map((item) => dateOf(item).slice(0, 4))])].sort().reverse();
    return (
      <div style={stack}>
        <Navigator
          label="年度"
          onPrevious={() => onFocusDate(addMonths(`${year}-01-01`, -12))}
          onNext={() => onFocusDate(addMonths(`${year}-01-01`, 12))}
        >
          <select aria-label="选择年度" className="zc-select" value={year} onChange={(event) => onFocusDate(`${event.target.value}-01-01`)} style={{ width: 140 }}>
            {years.map((value) => <option key={value} value={value}>{value} 年</option>)}
          </select>
        </Navigator>
        <div className="zc-timeline-year-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          {Array.from({ length: 12 }, (_, index) => {
            const month = `${year}-${String(index + 1).padStart(2, '0')}`;
            const rows = sorted.filter((item) => dateOf(item).startsWith(month));
            return (
              <button className="zc-timeline-period-card" key={month} type="button" onClick={() => { onFocusDate(`${month}-01`); onViewChange('month'); }} style={periodCard}>
                <span style={periodHead}><b>{index + 1} 月</b><span>{rows.length} 条</span></span>
                {renderSummary && <span style={summarySlot}>{renderSummary(rows)}</span>}
                <span style={compactList}>{rows.slice(0, 4).map((item) => <span key={keyOf(item)} style={compactRow}>{renderCompact(item)}</span>)}{rows.length === 0 && <span style={emptySmall}>无记录</span>}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (view === 'month') {
    const month = focusDate.slice(0, 7);
    const [year, monthNo] = month.split('-').map(Number);
    const days = new Date(year!, monthNo!, 0).getDate();
    const offset = (new Date(year!, monthNo! - 1, 1).getDay() + 6) % 7;
    return (
      <div style={stack}>
        <Navigator label="月份" onPrevious={() => onFocusDate(addMonths(`${month}-01`, -1))} onNext={() => onFocusDate(addMonths(`${month}-01`, 1))}>
          <input aria-label="选择月份" className="zc-input" type="month" value={month} onChange={(event) => onFocusDate(`${event.target.value}-01`)} style={{ width: 160 }} />
        </Navigator>
        <div className="zc-timeline-month-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', borderTop: '1px solid var(--border)', borderLeft: '1px solid var(--border)' }}>
          {['一', '二', '三', '四', '五', '六', '日'].map((label) => <div className="zc-timeline-weekday" key={label} style={weekday}>周{label}</div>)}
          {Array.from({ length: offset }, (_, index) => <div className="zc-timeline-calendar-cell" key={`blank-${index}`} style={calendarCell} />)}
          {Array.from({ length: days }, (_, index) => {
            const date = `${month}-${String(index + 1).padStart(2, '0')}`;
            const rows = sorted.filter((item) => dateOf(item) === date);
            return (
              <button className="zc-timeline-calendar-cell" key={date} type="button" onClick={() => { onFocusDate(date); onViewChange('day'); }} style={{ ...calendarCell, background: date === localToday() ? 'var(--accent-soft)' : 'var(--surface)', cursor: 'pointer', textAlign: 'left' }}>
                <span style={periodHead}><b>{index + 1}</b>{rows.length > 0 && <span>{rows.length} 条</span>}</span>
                {renderSummary && rows.length > 0 && <span style={summarySlot}>{renderSummary(rows)}</span>}
                <span style={compactList}>{rows.slice(0, 3).map((item) => <span key={keyOf(item)} style={compactRow}>{renderCompact(item)}</span>)}{rows.length > 3 && <span style={{ ...emptySmall, color: 'var(--accent)' }}>另 {rows.length - 3} 条</span>}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (view === 'day') {
    const rows = sorted.filter((item) => dateOf(item) === focusDate);
    return (
      <div style={stack}>
        <Navigator label="日期" onPrevious={() => onFocusDate(addDays(focusDate, -1))} onNext={() => onFocusDate(addDays(focusDate, 1))}>
          <input aria-label="选择日期" className="zc-input" type="date" value={focusDate} onChange={(event) => onFocusDate(event.target.value)} style={{ width: 160 }} />
          <span style={countText}>{rows.length} 条</span>
        </Navigator>
        <EntryList rows={rows} keyOf={keyOf} renderEntry={renderEntry} onOpen={onOpen} emptyText={emptyText} />
      </div>
    );
  }

  const groups = new Map<string, T[]>();
  for (const item of sorted) groups.set(dateOf(item), [...(groups.get(dateOf(item)) ?? []), item]);
  return (
    <div style={stack}>
      {[...groups.entries()].map(([date, rows]) => (
        <section key={date}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}><b style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>{date}</b>{renderSummary && <span>{renderSummary(rows)}</span>}</div>
          <EntryList rows={rows} keyOf={keyOf} renderEntry={renderEntry} onOpen={onOpen} emptyText={emptyText} />
        </section>
      ))}
      {groups.size === 0 && <div style={{ ...card, color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>{emptyText}</div>}
    </div>
  );
}

function Navigator(props: { label: string; onPrevious: () => void; onNext: () => void; children: ReactNode }) {
  return (
    <div className="zc-timeline-navigator" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)' }}>{props.label}</span>
      <button type="button" aria-label={`上一${props.label}`} title={`上一${props.label}`} onClick={props.onPrevious} style={iconButton}>‹</button>
      {props.children}
      <button type="button" aria-label={`下一${props.label}`} title={`下一${props.label}`} onClick={props.onNext} style={iconButton}>›</button>
    </div>
  );
}

function EntryList<T>(props: { rows: T[]; keyOf: (item: T) => string; renderEntry: (item: T) => ReactNode; onOpen?: (item: T) => void; emptyText: string }) {
  if (!props.rows.length) return <div style={{ ...card, color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>{props.emptyText}</div>;
  return (
    <div style={{ ...card, paddingTop: 4, paddingBottom: 4 }}>
      {props.rows.map((item) => (
        <div
          key={props.keyOf(item)}
          role={props.onOpen ? 'button' : undefined}
          tabIndex={props.onOpen ? 0 : undefined}
          onClick={() => props.onOpen?.(item)}
          onKeyDown={(event) => { if (props.onOpen && event.key === 'Enter') props.onOpen(item); }}
          style={{ borderBottom: '1px solid var(--border)', padding: '9px 0', cursor: props.onOpen ? 'pointer' : 'default' }}
        >
          {props.renderEntry(item)}
        </div>
      ))}
    </div>
  );
}

const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const iconButton = iconBtn;
const periodCard: CSSProperties = { ...card, minHeight: 156, textAlign: 'left', color: 'var(--text-primary)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 7 };
const periodHead: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)' };
const summarySlot: CSSProperties = { display: 'block', minHeight: 18 };
const compactList: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };
const compactRow: CSSProperties = { display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)' };
const emptySmall: CSSProperties = { fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' };
const weekday: CSSProperties = { padding: 8, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)', borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' };
const calendarCell: CSSProperties = { minHeight: 118, border: 'none', borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', padding: 8, background: 'var(--surface)' };
const countText: CSSProperties = { color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' };
