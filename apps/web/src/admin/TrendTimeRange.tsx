import { useMemo, useState } from 'react';
import { TimeRangeFilter } from './filters.js';
import { Notice } from './ui.js';

const spans: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000, '90d': 7_776_000_000 };
export const TREND_OPTIONS = [
  { value: '15m', label: '近 15 分钟' }, { value: '1h', label: '近 1 小时' },
  { value: '24h', label: '近 24 小时' }, { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' }, { value: '90d', label: '近 90 天' },
];

export function trendQuery(query: URLSearchParams, presets: string[]) {
  const explicit = query.has('from') || query.has('until') || query.get('range') === 'custom';
  const range = explicit ? 'custom' : presets.includes(query.get('range') ?? '') ? query.get('range')! : '24h';
  const result = new URLSearchParams({ range });
  if (explicit) for (const key of ['from', 'until']) if (query.has(key)) result.set(key, query.get(key)!);
  return result.toString();
}

export function TrendTimeRange({ query, presets, maxDays, label, onChange }: {
  query: URLSearchParams; presets: string[]; maxDays: number; label: string;
  onChange: (patch: Record<string, string>) => void;
}) {
  const key = trendQuery(query, presets);
  const applied = new URLSearchParams(key);
  const [draftKey, setDraftKey] = useState('');
  const [draftAnchor, setDraftAnchor] = useState<{ key: string; at: number } | null>(null);
  const [error, setError] = useState('');
  const custom = applied.get('range') === 'custom' || draftKey === key;
  const bounds = useMemo(() => {
    const params = new URLSearchParams(key); const until = new Date(draftAnchor?.key === key ? draftAnchor.at : Date.now());
    return { from: params.get('from') ?? new Date(until.getTime() - (spans[params.get('range')!] ?? spans['24h']!)).toISOString(), until: params.get('until') ?? until.toISOString() };
  }, [key, draftAnchor]);
  return <div className="zc-admin-trend-range">
    <TimeRangeFilter from={bounds.from} until={bounds.until} label="时间范围" showDraftStatus
      presetControl={{ label, value: custom ? 'custom' : applied.get('range')!, options: [...TREND_OPTIONS.filter(option => presets.includes(option.value)), { value: 'custom', label: '自定义' }], onChange: value => {
        setError(''); if (value === 'custom') { setDraftKey(key); return; }
        setDraftKey(''); setDraftAnchor({ key: `range=${value}`, at: Date.now() }); onChange({ range: value, from: '', until: '' });
      } }}
      help={`显示与保存按本地时间，查询转换为 UTC；最多 ${maxDays} 天。快捷窗口随刷新滚动，手改日期和时分后点应用固定区间；清除恢复近 24 小时。`}
      onApply={({ from, until }) => {
        if (!from && !until) { setDraftKey(''); setError(''); setDraftAnchor({ key: 'range=24h', at: Date.now() }); onChange({ range: '24h', from: '', until: '' }); return; }
        if (!from || !until) { setError('历史统计需要同时填写起始和结束时间。'); return; }
        if (Date.parse(until) <= Date.parse(from)) { setError('起始时间必须早于结束时间。'); return; }
        if (Date.parse(until) - Date.parse(from) > maxDays * 86_400_000) { setError(`时间区间最多 ${maxDays} 天。`); return; }
        setError(''); onChange({ range: 'custom', from, until });
      }} />
    {custom && applied.get('range') !== 'custom' && <span className="zc-admin-history-note" role="status">自定义区间尚未应用，当前结果仍按快捷范围显示。</span>}
    {error && <div role="alert"><Notice tone="bad">{error}</Notice></div>}
  </div>;
}
