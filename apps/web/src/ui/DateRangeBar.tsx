import {
  addDays,
  dateRangeForPreset,
  localToday,
  type DateRange,
  type DateRangePreset,
} from '@zichan/core';
import type { CSSProperties } from 'react';
import { linkDanger } from './styles.js';

export type TimelineViewMode = 'list' | 'year' | 'month' | 'day';

export interface DateRangeValue extends DateRange {
  preset: DateRangePreset;
}

export const DATE_PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: 'this_week', label: '本周' },
  { value: 'this_month', label: '本月' },
  { value: 'last_month', label: '上月' },
  { value: 'last_3_months', label: '近 3 月' },
  { value: 'this_year', label: '今年' },
  { value: 'all', label: '全部时间' },
  { value: 'custom', label: '自定义' },
];

export const TIMELINE_VIEWS: { value: TimelineViewMode; label: string }[] = [
  { value: 'list', label: '列表' },
  { value: 'year', label: '年度' },
  { value: 'month', label: '月历' },
  { value: 'day', label: '单日' },
];

export function dateRangeValue(preset: DateRangePreset, anchor = localToday()): DateRangeValue {
  return { preset, ...dateRangeForPreset(preset, anchor) };
}

export function localDateRangeToUtc(value: DateRange): { since?: string; until?: string } {
  return {
    since: value.from ? new Date(`${value.from}T00:00:00`).toISOString() : undefined,
    until: value.to ? new Date(`${addDays(value.to, 1)}T00:00:00`).toISOString() : undefined,
  };
}

export function localDateOfInstant(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function DateRangeBar(props: {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  anchor?: string;
  view?: TimelineViewMode;
  onViewChange?: (view: TimelineViewMode) => void;
  views?: { value: TimelineViewMode; label: string }[];
  compact?: boolean;
}) {
  const { value, onChange, anchor = localToday(), view, onViewChange, views = TIMELINE_VIEWS, compact = false } = props;
  const changePreset = (preset: DateRangePreset) => {
    onChange(preset === 'custom' ? { ...value, preset } : dateRangeValue(preset, anchor));
  };
  const changeFrom = (from: string) => {
    onChange({ preset: 'custom', from: from || undefined, to: from && value.to && from > value.to ? from : value.to });
  };
  const changeTo = (to: string) => {
    onChange({ preset: 'custom', from: to && value.from && to < value.from ? to : value.from, to: to || undefined });
  };

  return (
    <div className="zc-date-range-bar" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {view && onViewChange && (
        <div className="zc-date-view-tabs" role="tablist" aria-label="时间视图" style={{ display: 'flex', gap: 4, marginRight: compact ? 0 : 6 }}>
          {views.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={view === item.value}
              onClick={() => onViewChange(item.value)}
              style={viewButton(view === item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      <select aria-label="快捷时间范围" className="zc-select zc-date-preset" value={value.preset} onChange={(event) => changePreset(event.target.value as DateRangePreset)} style={{ width: 128 }}>
        {DATE_PRESETS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <label className="zc-date-boundary" style={dateLabel}>
        <span>从</span>
        <input aria-label="开始日期" className="zc-input" type="date" value={value.from ?? ''} onChange={(event) => changeFrom(event.target.value)} style={{ width: 146 }} />
      </label>
      <label className="zc-date-boundary" style={dateLabel}>
        <span>至</span>
        <input aria-label="结束日期" className="zc-input" type="date" value={value.to ?? ''} onChange={(event) => changeTo(event.target.value)} style={{ width: 146 }} />
      </label>
      {(value.from || value.to) && <button type="button" onClick={() => onChange(dateRangeValue('all', anchor))} style={clearButton}>清除</button>}
    </div>
  );
}

const dateLabel: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' };
const clearButton = linkDanger;

function viewButton(active: boolean): CSSProperties {
  return {
    height: 38,
    minWidth: 58,
    border: '1px solid var(--border)',
    background: active ? 'var(--accent)' : 'var(--surface)',
    color: active ? '#fff' : 'var(--fg-muted)',
    padding: '0 11px',
    fontSize: 'var(--fs-caption)',
    fontWeight: 'var(--fw-bold)',
    cursor: 'pointer',
  };
}
