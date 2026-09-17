/**
 * Trend geometry for the console charts.
 *
 * Kept as pure functions so the numbers can be asserted without a DOM, and so the SVG
 * component stays a thin renderer over them.
 */
export interface TrendPoint {
  /** Bucket start, as stored by the server (UTC ISO-8601). */
  at: string;
  value: number;
}

export interface TrendBar extends TrendPoint {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrendGeometry {
  bars: TrendBar[];
  /** Scale maximum: the largest value, or 1 so an all-zero range still draws a baseline. */
  maximum: number;
  /** True when at least one bucket carries a value above zero. */
  hasData: boolean;
}

export function trendGeometry(points: TrendPoint[], options: { width: number; height: number; maximum?: number }): TrendGeometry {
  const { width, height } = options;
  const bars: TrendBar[] = [];
  const maximum = options.maximum ?? Math.max(0, ...points.map((point) => point.value));
  const scale = maximum > 0 ? height / maximum : 0;
  const slot = points.length ? width / points.length : width;
  // A gap between bars keeps adjacent buckets readable, but never eats the whole slot.
  const barWidth = Math.max(1, slot * 0.8);
  points.forEach((point, index) => {
    const barHeight = point.value > 0 ? Math.max(1, point.value * scale) : 0;
    bars.push({
      ...point,
      x: index * slot + (slot - barWidth) / 2,
      y: height - barHeight,
      width: barWidth,
      height: barHeight,
    });
  });
  return { bars, maximum, hasData: points.some((point) => point.value > 0) };
}

export interface TrendSummary {
  total: number;
  peak: number;
  peakAt: string | null;
  average: number | null;
}

export function trendSummary(points: TrendPoint[]): TrendSummary {
  if (!points.length) return { total: 0, peak: 0, peakAt: null, average: null };
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const peak = Math.max(...points.map((point) => point.value));
  const peakPoint = points.find((point) => point.value === peak);
  return {
    total,
    peak,
    peakAt: peakPoint?.at ?? null,
    average: Number((total / points.length).toFixed(1)),
  };
}
