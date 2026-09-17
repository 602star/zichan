/** Trend chart for the metrics buckets, drawn as plain SVG so the console needs no chart library. */
import { muted } from './ui.js';
import { trendGeometry, trendSummary, type TrendPoint } from './trend.js';

const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 120;

export function TrendChart({ points, label, formatValue, tone, granularityNote }: {
  points: TrendPoint[];
  /** Accessible description; also used as the chart title for screen readers. */
  label: string;
  formatValue: (value: number) => string;
  tone?: 'ok' | 'warn' | 'bad';
  granularityNote?: string;
}) {
  if (!points.length) return <p style={muted}>暂无数据：这个时间范围内还没有采集到分桶。</p>;
  const { bars, maximum } = trendGeometry(points, { width: VIEW_WIDTH, height: VIEW_HEIGHT });
  const summary = trendSummary(points);
  const fill = tone === 'bad' ? 'var(--danger, #b3261e)' : tone === 'warn' ? 'var(--warning, #8a5a00)' : 'var(--accent, #1a73e8)';
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
        每个分桶：{bars.length} 个{granularityNote ? `（${granularityNote}）` : ''}；合计 {formatValue(summary.total)}
        ，峰值 {formatValue(summary.peak)}{summary.peakAt ? `（${new Date(summary.peakAt).toLocaleString()}）` : ''}
        {maximum > 0 ? '' : '；该范围内没有非零数据'}
      </figcaption>
    </figure>
  );
}
