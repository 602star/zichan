import { describe, expect, it } from 'vitest';
import {
  dcaOccurrenceDate,
  nextUnhandledDcaOccurrence,
  zonedCalendarNow,
  type DcaExecution,
  type DcaPlan,
} from '../src/index.js';

function plan(overrides: Partial<DcaPlan> = {}): DcaPlan {
  return {
    id: 'plan',
    createdAt: '',
    updatedAt: '',
    version: 1,
    isDeleted: false,
    name: '月末定投',
    targetAssetId: 'BTC',
    baseCurrencyAssetId: 'GBP',
    anchorDate: '2026-01-31',
    anchorMode: 'calendar_day',
    timezone: 'Asia/Shanghai',
    frequency: 'monthly',
    plannedAmount: '100',
    status: 'active',
    ...overrides,
  };
}

describe('DCA calendar recurrence', () => {
  it('keeps the original day anchor instead of drifting after a short month', () => {
    const p = plan();
    expect([0, 1, 2, 3].map((index) => dcaOccurrenceDate(p, index)))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('handles leap-year month ends and skips handled occurrences by index', () => {
    const p = plan({ anchorDate: '2028-01-31', anchorMode: 'month_end' });
    expect([0, 1, 2].map((index) => dcaOccurrenceDate(p, index)))
      .toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
    const executions = [{
      id: 'execution',
      createdAt: '',
      updatedAt: '',
      version: 1,
      isDeleted: false,
      planId: p.id,
      occurrenceIndex: 0,
      scheduledDate: '2028-01-31',
      date: '2028-01-31',
      plannedAmount: '100',
      actualBaseCost: '100',
      baseCurrencyAssetId: 'GBP',
      finalAssetId: 'BTC',
      finalAmount: '0.001',
      totalFeeInBase: '0',
    } satisfies DcaExecution];
    expect(nextUnhandledDcaOccurrence(p, executions)).toEqual({ index: 1, date: '2028-02-29' });
  });

  it('reads the same instant in the configured calendar timezone', () => {
    const instant = new Date('2026-01-31T16:30:00.000Z');
    expect(zonedCalendarNow(instant, 'Asia/Shanghai').date).toBe('2026-02-01');
    expect(zonedCalendarNow(instant, 'America/New_York').date).toBe('2026-01-31');
  });
});
