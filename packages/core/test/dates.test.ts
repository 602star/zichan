import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  dateRangeForPreset,
  isDateInRange,
  isDateRangeValid,
  localToday,
  parseDay,
} from '../src/dates.js';

describe('calendar date ranges', () => {
  it('uses inclusive boundaries', () => {
    const range = { from: '2026-01-01', to: '2026-01-31' };
    expect(isDateInRange('2026-01-01', range)).toBe(true);
    expect(isDateInRange('2026-01-31', range)).toBe(true);
    expect(isDateInRange('2025-12-31', range)).toBe(false);
    expect(isDateInRange('2026-02-01', range)).toBe(false);
  });

  it('handles leap days and month-end clamping', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('builds cross-year presets from a local anchor', () => {
    expect(dateRangeForPreset('last_3_months', '2026-01-15')).toEqual({ from: '2025-11-01', to: '2026-01-31' });
    expect(dateRangeForPreset('this_week', '2026-07-11')).toEqual({ from: '2026-07-06', to: '2026-07-12' });
  });

  it('rejects malformed days and reversed ranges', () => {
    expect(() => parseDay('2026-02-30')).toThrow('invalid date');
    expect(isDateRangeValid({ from: '2026-07-12', to: '2026-07-11' })).toBe(false);
    expect(isDateRangeValid({ from: '2026-07-01', to: '2026-07-11' })).toBe(true);
  });

  it('formats today from local date parts', () => {
    expect(localToday(new Date(2026, 6, 11, 0, 30))).toBe('2026-07-11');
  });
});
