import { describe, expect, it } from 'vitest';
import { trendGeometry, trendSummary } from '../src/admin/trend.js';

/**
 * The chart is drawn from these two functions only, so the properties that matter
 * (a missing bucket stays missing, an all-zero range still draws a baseline, every
 * bar stays inside the view box) can be asserted without a DOM.
 */
describe('admin trend geometry', () => {
  it('keeps every bar inside the view box and on a baseline of zero', () => {
    const { bars } = trendGeometry([
      { at: '2026-09-17T10:00:00.000Z', value: 4 },
      { at: '2026-09-17T11:00:00.000Z', value: 12 },
      { at: '2026-09-17T12:00:00.000Z', value: 6 },
    ], { width: 600, height: 120 });
    for (const bar of bars) {
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.width).toBeLessThanOrEqual(600);
      expect(bar.y).toBeGreaterThanOrEqual(0);
      expect(bar.y + bar.height).toBeCloseTo(120, 6);
    }
    // The tallest bar is the scale maximum, so it fills the height.
    expect(bars[1]?.height).toBeCloseTo(120, 6);
    expect(bars[0]?.height).toBeCloseTo(40, 6);
  });

  it('does not invent data for buckets that were never sampled', () => {
    const { bars, maximum, hasData } = trendGeometry([
      { at: '2026-09-17T10:00:00.000Z', value: 0 },
      { at: '2026-09-17T11:00:00.000Z', value: 0 },
    ], { width: 600, height: 120 });
    expect(maximum).toBe(0);
    expect(hasData).toBe(false);
    for (const bar of bars) expect(bar.height).toBe(0);
  });

  it('handles an empty range without dividing by zero', () => {
    const { bars, maximum, hasData } = trendGeometry([], { width: 600, height: 120 });
    expect(bars).toEqual([]);
    expect(maximum).toBe(0);
    expect(hasData).toBe(false);
    expect(trendSummary([])).toEqual({ total: 0, peak: 0, peakAt: null, average: null });
  });

  it('reports the total, the peak and when the peak happened', () => {
    const summary = trendSummary([
      { at: '2026-09-17T10:00:00.000Z', value: 4 },
      { at: '2026-09-17T11:00:00.000Z', value: 12 },
      { at: '2026-09-17T12:00:00.000Z', value: 6 },
    ]);
    expect(summary.total).toBe(22);
    expect(summary.peak).toBe(12);
    expect(summary.peakAt).toBe('2026-09-17T11:00:00.000Z');
    expect(summary.average).toBe(7.3);
  });
});
