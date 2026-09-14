import { describe, expect, it } from 'vitest';
import { asOfState, normalizeAsOfMode, resolveAsOfDate } from '../src/as-of.js';

const TODAY = '2026-09-14';

describe('ledger cut-off resolution', () => {
  it('keeps the stored day in manual mode instead of following the clock', () => {
    expect(resolveAsOfDate({ asOfDate: '2026-07-11' }, TODAY)).toBe('2026-07-11');
    expect(resolveAsOfDate({ asOfDate: '2026-07-11', asOfMode: 'manual' }, TODAY)).toBe('2026-07-11');
  });

  it('falls back to today when nothing valid is stored', () => {
    expect(resolveAsOfDate({}, TODAY)).toBe(TODAY);
    expect(resolveAsOfDate({ asOfDate: '2026-02-30' }, TODAY)).toBe(TODAY);
  });

  it('treats an unknown mode as manual so older ledgers keep their day', () => {
    expect(normalizeAsOfMode(undefined)).toBe('manual');
    expect(normalizeAsOfMode('whatever')).toBe('manual');
    expect(resolveAsOfDate({ asOfDate: '2026-07-11', asOfMode: 'whatever' }, TODAY)).toBe('2026-07-11');
  });

  it('always reports today in auto_today mode', () => {
    expect(resolveAsOfDate({ asOfDate: '2026-07-11', asOfMode: 'auto_today' }, TODAY)).toBe(TODAY);
  });

  it('follows the newest record without opening future days in auto_on_record mode', () => {
    expect(resolveAsOfDate({
      asOfDate: '2026-07-11', asOfMode: 'auto_on_record', latestRecordDate: '2026-09-02',
    }, TODAY)).toBe('2026-09-02');
    // A pre-recorded future entry must not push the window onto future days.
    expect(resolveAsOfDate({
      asOfDate: '2026-07-11', asOfMode: 'auto_on_record', latestRecordDate: '2026-12-01',
    }, TODAY)).toBe(TODAY);
    // With nothing recorded yet it keeps the stored day.
    expect(resolveAsOfDate({
      asOfDate: '2026-07-11', asOfMode: 'auto_on_record',
    }, TODAY)).toBe('2026-07-11');
  });

  it('describes how far the cut-off sits from today', () => {
    expect(asOfState({ asOfDate: '2026-07-11' }, TODAY)).toMatchObject({
      asOf: '2026-07-11', today: TODAY, daysBehind: 65, stale: true, future: false, mode: 'manual',
    });
    expect(asOfState({ asOfDate: TODAY }, TODAY)).toMatchObject({
      daysBehind: 0, stale: false, future: false,
    });
    expect(asOfState({ asOfDate: '2026-10-01' }, TODAY)).toMatchObject({
      daysBehind: -17, stale: false, future: true,
    });
  });
});
