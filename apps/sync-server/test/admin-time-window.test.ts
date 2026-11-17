import { describe, expect, it } from 'vitest';
import { adminTimeWindow } from '../src/admin-time-window.js';

const options = { presets: ['15m', '1h', '24h', '7d'], maxDays: 7, buckets: 'minute' as const };
describe('bounded administrative history windows', () => {
  it('normalizes explicit offsets and covers full minute buckets with one denominator', () => {
    const window = adminTimeWindow(new URLSearchParams({ range: 'custom', from: '2026-11-10T09:15:30+08:00', until: '2026-11-10T10:30:15+08:00' }), options);
    expect(window.from.toISOString()).toBe('2026-11-10T01:15:00.000Z');
    expect(window.until.toISOString()).toBe('2026-11-10T02:31:00.000Z');
    expect(window.spanMs).toBe(76 * 60_000);
  });
  it('rejects incomplete, malformed, reverse and excessive windows', () => {
    for (const params of [
      { from: '2026-11-10T00:00:00Z' },
      { from: '2026-11-10T00:00:00', until: '2026-11-11T00:00:00Z' },
      { from: '2026-11-10T24:00:00Z', until: '2026-11-11T01:00:00Z' },
      { from: '2026-02-30T00:00:00Z', until: '2026-03-01T00:00:00Z' },
      { from: '2026-11-12T00:00:00Z', until: '2026-11-11T00:00:00Z' },
      { from: '2026-11-01T00:00:00Z', until: '2026-11-10T00:00:00Z' },
    ]) expect(() => adminTimeWindow(new URLSearchParams(params), options)).toThrow();
  });
  it('keeps preset spans rolling and provides bounded daily telemetry windows', () => {
    const window = adminTimeWindow(new URLSearchParams('range=24h'), { ...options, now: new Date('2026-11-17T00:10:20Z') });
    expect(window.until.toISOString()).toBe('2026-11-17T00:11:00.000Z');
    expect(window.spanMs).toBe(86_400_000);
    const daily = adminTimeWindow(new URLSearchParams('from=2026-11-10T09:15:00Z&until=2026-11-11T10:30:00Z'), { presets: ['7d'], maxDays: 90, buckets: 'day' });
    expect(daily.from.toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(daily.until.toISOString()).toBe('2026-11-12T00:00:00.000Z');
  });
});
