import type { CSSProperties, MouseEvent } from 'react';

/*
 * Chart vocabulary for 报表 and 日常支出.
 *
 * Three questions are drawn on those two screens - what is the trend, what makes
 * up this month, and which categories rank highest - and each question has one
 * shape that answers it. There is deliberately no generic "chart type" switch:
 * a pie of a time series is the wrong reading, and ranking eight categories by
 * angle is unreadable, so the caller picks the question and this module owns the
 * shape.
 *
 * Every chart renders its numbers as text (axis label, legend row, detail line),
 * so a test asserts on what a reader sees rather than on pixels. No dependency,
 * no canvas: a donut is one `conic-gradient`, the bars are boxes.
 *
 * Amounts arrive pre-formatted by the caller (`reportCurrency`), and shares
 * arrive as `weight`, already divided with decimal.js in the selector. Charts
 * only turn those into degrees and pixels, so no money is ever computed here.
 */

/** One segment of a composition chart together with its legend row. */
export interface ChartSlice {
  key: string;
  label: string;
  /** Formatted by the caller in the report currency, e.g. `¥320.00`. */
  amountText: string;
  /** Share of the whole, 0..1, from decimal.js. Used for the arc and the label. */
  weight: number;
  color: string;
  /** Absent for the aggregated 「其他」 bucket: it is not a category to drill into. */
  onSelect?: () => void;
}

/** A share is a display ratio, so it is rounded here rather than in the selector. */
function shareText(weight: number): string {
  if (!Number.isFinite(weight)) return '0%';
  const percent = Math.max(0, weight) * 100;
  if (percent > 0 && percent < 0.05) return '<0.1%';
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

/**
 * The ring is `conic-gradient` starting at 12 o'clock, so the hit test below
 * measures the same way. Both the hole geometry and this share the constant.
 */
const HOLE_INSET = 0.26;

export function CompositionDonut(props: {
  /** Human name of the whole, e.g. 「本月支出构成」. */
  ariaLabel: string;
  slices: ChartSlice[];
  /** The 100% figure, formatted by the caller: it equals the sum of the slices. */
  totalText: string;
  totalCaption: string;
  /** Marks the slice the rest of the screen is currently drilled into. */
  selectedKey?: string;
  /**
   * 空状态文案。报表页画的是「所选区间」而不是本月，支出页的二级环又是“这一段里
   * 没有可归类的支出”，所以不能写死成一句话。
   */
  emptyText?: string;
  /** 同一屏上有两个环时（板块环 + 选中板块的二级环）用它区分。 */
  testId?: string;
}) {
  const { ariaLabel, slices, totalText, totalCaption, selectedKey, emptyText = '本月还没有可归类的支出', testId } = props;
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.weight), 0);

  const arcs: string[] = [];
  let cursor = 0;
  for (const slice of slices) {
    const span = total > 0 ? Math.max(0, slice.weight) / total : 0;
    if (span <= 0) continue;
    const from = cursor * 360;
    cursor += span;
    arcs.push(`${slice.color} ${from.toFixed(3)}deg ${(cursor * 360).toFixed(3)}deg`);
  }

  const normalised = (weight: number) => (total > 0 ? Math.max(0, weight) / total : 0);
  const summary = `${ariaLabel}，合计 ${totalText}：${slices.map((slice) => `${slice.label} ${slice.amountText} ${shareText(normalised(slice.weight))}`).join('、')}`;

  /*
   * Clicking the ring picks the slice under the pointer, so the drawn shape is
   * itself the control. It is not focusable on purpose: the legend rows are the
   * keyboard path, and duplicating every slice as a tab stop would make the
   * chart a maze for keyboard users.
   */
  const selectSliceAt = (event: MouseEvent<HTMLDivElement>) => {
    if (!slices.some((slice) => slice.onSelect)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const radius = rect.width / 2;
    const dx = event.clientX - (rect.left + radius);
    const dy = event.clientY - (rect.top + radius);
    const distance = Math.hypot(dx, dy);
    // Inside the hole is the total, outside the ring is the card.
    if (distance > radius || distance < radius * (1 - HOLE_INSET * 2)) return;
    const angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    let start = 0;
    for (const slice of slices) {
      const span = normalised(slice.weight) * 360;
      if (angle >= start && angle < start + span) {
        slice.onSelect?.();
        return;
      }
      start += span;
    }
  };

  return (
    <div className="zc-donut" data-testid={testId}>
      <div className="zc-donut-visual">
        <div
          className="zc-donut-ring"
          role="img"
          aria-label={summary}
          onClick={selectSliceAt}
          style={{ background: arcs.length > 0 ? `conic-gradient(${arcs.join(', ')})` : 'var(--surface-2)' }}
        >
          <div className="zc-donut-hole">
            <span title={totalCaption} style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{totalCaption}</span>
          </div>
        </div>
        <span className="zc-donut-total">{totalText}</span>
      </div>
      <div className="zc-donut-legend">
        {slices.length === 0 && (
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>{emptyText}</div>
        )}
        {slices.map((slice) => {
          const share = shareText(normalised(slice.weight));
          const className = `zc-donut-legend-row${slice.onSelect ? ' is-drillable' : ''}${slice.key === selectedKey ? ' is-selected' : ''}`;
          const body = (
            <>
              <span className="zc-swatch" style={{ background: slice.color }} aria-hidden="true" />
              {/* 环的图例是它唯一的读法，所以标签宁可用省略号也不换行撑高行；
                  真被截断时，title 是鼠标下唯一能看到全名的地方（键盘与读屏走 aria-label）。 */}
              <span className="zc-donut-legend-label" title={slice.label}>{slice.label}</span>
              <span className="zc-donut-legend-amount">{slice.amountText}</span>
              <span className="zc-donut-legend-share">{share}</span>
            </>
          );
          return slice.onSelect ? (
            <button
              key={slice.key}
              type="button"
              className={className}
              aria-label={`${slice.label} · ${slice.amountText} · ${share}`}
              aria-current={slice.key === selectedKey ? 'true' : undefined}
              onClick={() => slice.onSelect?.()}
            >
              {body}
            </button>
          ) : (
            <div key={slice.key} className={className} aria-label={`${slice.label} · ${slice.amountText} · ${share}`}>
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A dot-and-label legend for charts whose colours are semantic (收入 / 支出). */
export function ChartLegend(props: { items: { label: string; color: string }[] }) {
  return (
    <div className="zc-chart-legend">
      {props.items.map((item) => (
        <span key={item.label} className="zc-chart-legend-item">
          <span className="zc-swatch" style={{ background: item.color }} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/** One month of a trend, with one bar per series (收入 / 支出). */
export interface TrendBucket {
  key: string;
  /** Short axis label: `9月` on a six-month axis, `26-09` when months are tight. */
  label: string;
  /** What the whole column says, read by hover, by focus and by the detail line. */
  detail: string;
  bars: { label: string; value: number; text: string; color: string }[];
}

export function TrendBars(props: {
  ariaLabel: string;
  buckets: TrendBucket[];
  /** Pitch per month. 44px is the touch target; wider is only for short windows. */
  minColumnWidth?: number;
  selectedKey?: string;
  onSelect?: (key: string) => void;
}) {
  const { ariaLabel, buckets, minColumnWidth = 44, selectedKey, onSelect } = props;
  const max = Math.max(1, ...buckets.flatMap((bucket) => bucket.bars.map((bar) => bar.value)));
  return (
    <div
      className="zc-trend-grid"
      role="group"
      aria-label={ariaLabel}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.max(buckets.length, 1)}, minmax(${minColumnWidth}px, 1fr))`,
        gap: 12,
        alignItems: 'end',
      }}
    >
      {buckets.map((bucket) => (
        <button
          key={bucket.key}
          type="button"
          className={`zc-trend-cell${bucket.key === selectedKey ? ' is-selected' : ''}`}
          aria-label={bucket.detail}
          title={bucket.detail}
          onClick={() => onSelect?.(bucket.key)}
        >
          <span className="zc-trend-bars">
            {bucket.bars.map((bar) => (
              <span
                key={bar.label}
                className="zc-trend-bar"
                style={{ height: `${Math.max(4, (bar.value / max) * 132)}px`, background: bar.color }}
                title={`${bar.label} ${bar.text}`}
              />
            ))}
          </span>
          <span className="zc-trend-cell-label">{bucket.label}</span>
        </button>
      ))}
      {buckets.length === 0 && (
        <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>该时间范围内暂无可绘制数据</div>
      )}
    </div>
  );
}

/** A ranked bar chart: one bar per category, with the value printed under it. */
export function RankBars(props: {
  ariaLabel: string;
  rows: {
    key: string;
    label: string;
    /** 0..1 of the tallest bar. */
    heightRatio: number;
    text: string;
    color: string;
    selected?: boolean;
    onSelect?: () => void;
  }[];
}) {
  const { ariaLabel, rows } = props;
  return (
    <div
      className="zc-report-chart-grid"
      role="group"
      aria-label={ariaLabel}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.max(rows.length, 1)}, minmax(42px, 1fr))`,
        gap: 10,
        alignItems: 'end',
      }}
    >
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          onClick={() => row.onSelect?.()}
          aria-label={`${row.label} · ${row.text}`}
          style={{
            ...rankCell,
            borderColor: row.selected ? 'var(--accent)' : 'transparent',
            cursor: row.onSelect ? 'pointer' : 'default',
          }}
        >
          <span className="zc-rank-track">
            <span className="zc-rank-fill" style={{ height: `${Math.max(6, row.heightRatio * 100)}%`, background: row.color }} />
          </span>
          <span className="zc-rank-label">{row.label}</span>
          <span className="zc-rank-value">{row.text}</span>
        </button>
      ))}
      {rows.length === 0 && (
        <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>暂无可绘制数据</div>
      )}
    </div>
  );
}

const rankCell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 7,
  minWidth: 0,
  border: '1px solid transparent',
  background: 'transparent',
  padding: 0,
  borderRadius: 'var(--r-sm)',
  color: 'inherit',
};
