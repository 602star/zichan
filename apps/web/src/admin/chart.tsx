/** Trend chart for the metrics buckets, drawn as plain SVG so the console needs no chart library. */
import { muted } from './ui.js';
import { trendGeometry, trendSummary, type TrendPoint } from './trend.js';

const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 120;

export interface LineSeries {
  label: string;
  color: string;
  points: { at: string; value: number | null }[];
}

/** Time-series line chart with gaps for missing samples and a visible single-sample dot. */
export function MetricLineChart({ series, label, formatValue, bucketMs, maxValue }: {
  series: LineSeries[];
  label: string;
  formatValue: (value: number) => string;
  bucketMs: number;
  maxValue?: number;
}) {
  const width = 640; const height = 190;
  const left = 56; const right = 16; const top = 14; const bottom = 28;
  const timestamps = series.flatMap((entry) => entry.points.map((point) => Date.parse(point.at))).filter(Number.isFinite);
  const values = series.flatMap((entry) => entry.points.map((point) => point.value))
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
  const first = timestamps.length ? Math.min(...timestamps) : Date.now();
  const last = timestamps.length ? Math.max(...timestamps) : first;
  const ceiling = Math.max(1, maxValue ?? 0, Math.max(...values, 0) * 1.1);
  const x = (at: string) => first === last ? (left + width - right) / 2
    : left + (Date.parse(at) - first) / (last - first) * (width - left - right);
  const y = (value: number) => top + (1 - Math.min(ceiling, value) / ceiling) * (height - top - bottom);
  const lines = series.map((entry) => {
    const paths: string[] = [];
    let path = '';
    let previousAt = 0;
    for (const point of entry.points) {
      const at = Date.parse(point.at);
      if (point.value === null || !Number.isFinite(point.value) || !Number.isFinite(at)) {
        if (path) paths.push(path);
        path = ''; previousAt = 0; continue;
      }
      const command = !path || at - previousAt > bucketMs * 1.5 ? 'M' : 'L';
      if (command === 'M' && path) paths.push(path);
      path = `${command === 'M' ? '' : path + ' '}${command}${x(point.at).toFixed(1)} ${y(point.value).toFixed(1)}`;
      previousAt = at;
    }
    if (path) paths.push(path);
    return { ...entry, paths };
  });
  const time = (at: number) => new Date(at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <figure className="zc-admin-line-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {[0, 0.5, 1].map((fraction) => <g key={fraction}>
        <line x1={left} x2={width - right} y1={y(ceiling * fraction)} y2={y(ceiling * fraction)} stroke="var(--border)" strokeDasharray={fraction === 0 ? undefined : '3 4'} />
        <text x={left - 8} y={y(ceiling * fraction) + 4} textAnchor="end" fill="var(--text-secondary)" fontSize="11">{formatValue(ceiling * fraction)}</text>
      </g>)}
      {lines.map((entry) => <g key={entry.label}>
        {entry.paths.map((path, index) => <path key={index} d={path} fill="none" stroke={entry.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />)}
        {entry.points.filter((point) => point.value !== null && Number.isFinite(point.value)).map((point) => <circle key={point.at} cx={x(point.at)} cy={y(point.value!)} r="3" fill={entry.color}><title>{time(Date.parse(point.at))} · {entry.label} {formatValue(point.value!)}</title></circle>)}
      </g>)}
      <text x={left} y={height - 5} fill="var(--text-secondary)" fontSize="11">{time(first)}</text>
      {first !== last ? <text x={width - right} y={height - 5} textAnchor="end" fill="var(--text-secondary)" fontSize="11">{time(last)}</text> : null}
      {!values.length ? <text x={width / 2} y={height / 2} textAnchor="middle" fill="var(--text-secondary)" fontSize="13">暂无采样</text> : null}
    </svg>
    <figcaption className="zc-admin-line-legend">{series.map((entry) => {
      const latest = [...entry.points].reverse().find((point) => point.value !== null);
      return <span key={entry.label}><i style={{ background: entry.color }} />{entry.label}：{latest?.value == null ? '暂无读数' : formatValue(latest.value)}</span>;
    })}</figcaption>
  </figure>;
}

export function TrendChart({ points, label, formatValue, tone, granularityNote, summaryMode = 'total' }: {
  points: TrendPoint[];
  /** Accessible description; also used as the chart title for screen readers. */
  label: string;
  formatValue: (value: number) => string;
  tone?: 'ok' | 'warn' | 'bad';
  granularityNote?: string;
  /**
   * What a bucket's value means. Counters add up, so a range total is meaningful; a resource
   * reading is a peak, and printing a sum of peaks would be a number nobody can act on.
   */
  summaryMode?: 'total' | 'peak';
}) {
  if (!points.length) return <p style={muted}>暂无数据：这个时间范围内还没有采集到分桶。</p>;
  const { bars, maximum } = trendGeometry(points, { width: VIEW_WIDTH, height: VIEW_HEIGHT });
  const summary = trendSummary(points);
  const fill = tone === 'bad' ? 'var(--danger)' : tone === 'warn' ? 'var(--warning)' : 'var(--accent)';
  return (
    <figure style={{ margin: '10px 0 0' }}>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-label={label}
        style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 180 }}
      >
        {/* A missing bucket renders as nothing at all: zero traffic and "not sampled yet" differ. */}
        <line x1={0} y1={VIEW_HEIGHT - 0.5} x2={VIEW_WIDTH} y2={VIEW_HEIGHT - 0.5} stroke="var(--border, #dadce0)" strokeWidth={1} />
        {bars.map((bar) => (
          <rect key={bar.at} x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={1} fill={fill}>
            <title>{`${new Date(bar.at).toLocaleString()} · ${formatValue(bar.value)}`}</title>
          </rect>
        ))}
      </svg>
      <figcaption style={muted}>
        每个分桶：{bars.length} 个{granularityNote ? `（${granularityNote}）` : ''}；
        {summaryMode === 'peak' ? '最高' : '合计'} {formatValue(summaryMode === 'peak' ? summary.peak : summary.total)}
        {summaryMode === 'peak'
          ? (summary.peakAt ? `（${new Date(summary.peakAt).toLocaleString()}）` : '')
          : <>{`，峰值 ${formatValue(summary.peak)}`}{summary.peakAt ? `（${new Date(summary.peakAt).toLocaleString()}）` : ''}</>}
        {maximum > 0 ? '' : '；该范围内没有非零数据'}
      </figcaption>
    </figure>
  );
}
