import { describe, expect, it } from 'vitest';
import {
  earliestRecordedDay,
  latestRecordedDay,
  ledgerAsOf,
  ledgerAsOfDate,
  needsAsOfAttention,
} from '../src/as-of.js';
import { makeSnapshot, makeTransaction } from './fixtures.js';

const TODAY = '2026-09-14';

describe('ledger cut-off selector', () => {
  it('leaves the stored day alone in the default manual mode', () => {
    const snap = makeSnapshot();
    expect(snap.setting?.asOfDate).toBe('2026-03-04');
    expect(snap.setting?.asOfMode).toBeUndefined();
    expect(ledgerAsOfDate(snap, TODAY)).toBe('2026-03-04');
    expect(ledgerAsOf(snap, TODAY)).toMatchObject({ asOf: '2026-03-04', stale: true, mode: 'manual' });
  });

  it('ignores voided and deleted transactions when finding the newest day', () => {
    const snap = makeSnapshot();
    snap.transactions = [
      makeTransaction({ date: '2026-04-01' }),
      makeTransaction({ date: '2026-08-20', recordState: 'voided' }),
      makeTransaction({ date: '2026-09-01', isDeleted: true }),
    ];
    expect(latestRecordedDay(snap)).toBe('2026-04-01');
    expect(earliestRecordedDay(snap)).toBe('2026-04-01');
  });

  it('tracks the newest recorded day in auto_on_record mode', () => {
    const snap = makeSnapshot();
    snap.setting!.asOfMode = 'auto_on_record';
    snap.transactions = [makeTransaction({ date: '2026-04-01' }), makeTransaction({ date: '2026-06-15' })];
    expect(ledgerAsOfDate(snap, TODAY)).toBe('2026-06-15');
  });

  it('reports today in auto_today mode so the cut-off can never go stale', () => {
    const snap = makeSnapshot();
    snap.setting!.asOfMode = 'auto_today';
    expect(ledgerAsOfDate(snap, TODAY)).toBe(TODAY);
    expect(ledgerAsOf(snap, TODAY).stale).toBe(false);
    expect(needsAsOfAttention(ledgerAsOf(snap, TODAY))).toBe(false);
  });

  it('falls back to today when the ledger carries no cut-off at all', () => {
    const snap = makeSnapshot();
    snap.setting = { ...snap.setting!, asOfDate: undefined };
    expect(ledgerAsOfDate(snap, TODAY)).toBe(TODAY);
    expect(needsAsOfAttention(ledgerAsOf(snap, TODAY))).toBe(false);
  });

  it('asks for attention when a manual cut-off is behind or set in the future', () => {
    const snap = makeSnapshot();
    // Manual + behind: the case the report banners exist for.
    expect(needsAsOfAttention(ledgerAsOf(snap, TODAY))).toBe(true);
    // Future-dated cut-offs warn regardless of mode.
    snap.setting = { ...snap.setting!, asOfDate: '2026-10-01', asOfMode: 'auto_on_record' };
    expect(needsAsOfAttention(ledgerAsOf(snap, TODAY))).toBe(true);
  });
});
