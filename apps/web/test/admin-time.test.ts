import { describe, expect, it } from 'vitest';
import { describeRange, isoToLocalInput, localInputToIso, presetWindow } from '../src/admin/time.js';

/**
 * The console shows local time and the API keeps UTC. Both directions are pure functions, so
 * the round trip is asserted here instead of by eyeballing a datetime input.
 */
describe('admin time-range helpers', () => {
  it('round-trips a timestamp through the local datetime input', () => {
    const iso = '2026-09-17T10:30:00.000Z';
    const back = localInputToIso(isoToLocalInput(iso));
    expect(back).toBe(iso);
  });

  it('treats an empty input as no bound, not as the epoch', () => {
    expect(localInputToIso('')).toBeUndefined();
    expect(localInputToIso('   ')).toBeUndefined();
    expect(isoToLocalInput('')).toBe('');
  });

  it('rejects an unparseable value instead of sending it to the server', () => {
    expect(localInputToIso('not a date')).toBeUndefined();
    expect(isoToLocalInput('not a date')).toBe('');
  });

  it('formats a local input without a timezone suffix', () => {
    const value = isoToLocalInput('2026-09-17T10:30:00.000Z');
    // `datetime-local` accepts exactly `YYYY-MM-DDTHH:mm`; a trailing Z would be ignored or
    // read as UTC and shift the window by the offset.
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(value).not.toContain('Z');
  });

  it('preserves the final millisecond when a selected end date covers the full day', () => {
    const localEnd = '2026-09-17T23:59:59.999';
    expect(isoToLocalInput(localInputToIso(localEnd)!, true)).toBe(localEnd);
  });

  it('builds an open-ended preset window so later records still appear', () => {
    const now = new Date('2026-09-17T12:00:00.000Z');
    const window = presetWindow(24, now);
    expect(window.from).toBe('2026-09-16T12:00:00.000Z');
    expect(window.until).toBeUndefined();
  });

  it('tells the operator about an inverted range instead of returning nothing', () => {
    expect(describeRange('2026-09-17T00:00:00.000Z', '2026-09-16T00:00:00.000Z')).toBeDefined();
    expect(describeRange('2026-09-16T00:00:00.000Z', '2026-09-17T00:00:00.000Z')).toBeUndefined();
    // A single bound is always a valid open-ended range.
    expect(describeRange('2026-09-17T00:00:00.000Z', '')).toBeUndefined();
  });
});
