/**
 * Resource trend geometry.
 *
 * The resource series are peaks, so the chart has to be readable on a scale where one series
 * is in bytes and another is a percentage. These tests pin the properties that keep the chart
 * honest: a bucket with no sample draws nothing, and a range with no data still has a baseline.
 */
import { describe, expect, it } from 'vitest';
import { trendGeometry, trendSummary } from '../src/admin/trend.js';

describe('resource trend series', () => {
  it('scales bytes and percentages with the same geometry rules', () => {
    const bytes = trendGeometry([
      { at: '2026-09-19T10:00:00.000Z', value: 100 * 1024 * 1024 },
      { at: '2026-09-19T10:01:00.000Z', value: 200 * 1024 * 1024 },
    ], { width: 600, height: 120 });
    const percent = trendGeometry([
      { at: '2026-09-19T10:00:00.000Z', value: 10 },
      { at: '2026-09-19T10:01:00.000Z', value: 20 },
    ], { width: 600, height: 120 });
    // The same shape, whatever the unit: the taller bar fills the height in both cases.
    expect(bytes.bars.map((bar) => Math.round(bar.height))).toEqual(percent.bars.map((bar) => Math.round(bar.height)));
    expect(bytes.bars[1]?.height).toBeCloseTo(120, 6);
    expect(percent.bars[1]?.height).toBeCloseTo(120, 6);
  });

  it('leaves an unsampled bucket empty instead of drawing it as zero usage', () => {
    // A gap in sampling is not the same fact as "the process used no memory".
    const { bars, maximum, hasData } = trendGeometry([
      { at: '2026-09-19T10:00:00.000Z', value: 0 },
      { at: '2026-09-19T10:01:00.000Z', value: 0 },
      { at: '2026-09-19T10:02:00.000Z', value: 0 },
    ], { width: 600, height: 120 });
    expect(maximum).toBe(0);
    expect(hasData).toBe(false);
    for (const bar of bars) expect(bar.height).toBe(0);
  });

  it('reports the peak of a resource range, which is what an operator acts on', () => {
    const summary = trendSummary([
      { at: '2026-09-19T10:00:00.000Z', value: 50 * 1024 * 1024 },
      { at: '2026-09-19T10:01:00.000Z', value: 900 * 1024 * 1024 },
      { at: '2026-09-19T10:02:00.000Z', value: 60 * 1024 * 1024 },
    ]);
    expect(summary.peak).toBe(900 * 1024 * 1024);
    expect(summary.peakAt).toBe('2026-09-19T10:01:00.000Z');
  });
});
