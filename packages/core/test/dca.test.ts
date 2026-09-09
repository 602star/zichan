import { describe, it, expect } from 'vitest';
import { buildDcaReport, round, type DcaExecution } from '../src/index.js';

function exec(date: string, actualBaseCost: string, finalAmount: string, fee: string): DcaExecution {
  return {
    id: 'e' + date, planId: 'p1', date, occurrenceIndex: 0, scheduledDate: date, plannedAmount: '250', actualBaseCost,
    baseCurrencyAssetId: 'GBP', finalAssetId: 'BTC', finalAmount, totalFeeInBase: fee,
    createdAt: '', updatedAt: '', version: 1, isDeleted: false,
  };
}

describe('buildDcaReport — cumulative + average cost', () => {
  const execs = [
    exec('2025-12-08', '251.50', '0.004276', '2.42'),
    exec('2025-12-22', '251.50', '0.004033', '2.38'),
  ];
  const report = buildDcaReport(execs);

  it('per-row unit cost = invested / acquired', () => {
    expect(round(report.rows[0]!.unitCost, 0)).toBe('58817'); // 251.50 / 0.004276
  });

  it('accumulates amount and cost across executions', () => {
    const r2 = report.rows[1]!;
    expect(round(r2.cumulativeAmount, 6)).toBe('0.008309'); // 0.004276 + 0.004033
    expect(round(r2.cumulativeCost, 2)).toBe('503.00'); // 251.50 * 2
  });

  it('average cost = cumulative cost / cumulative amount', () => {
    const r2 = report.rows[1]!;
    expect(round(r2.averageCost, 0)).toBe('60537'); // 503.00 / 0.008309
    expect(round(report.averageCost, 0)).toBe('60537');
  });

  it('totals sum every execution', () => {
    expect(round(report.totalInvested, 2)).toBe('503.00');
    expect(round(report.totalFees, 2)).toBe('4.80');
  });

  it('rows are ordered by date regardless of input order', () => {
    const shuffled = buildDcaReport([execs[1]!, execs[0]!]);
    expect(shuffled.rows[0]!.date).toBe('2025-12-08');
  });

  it.each([
    { planId: 'p2' }, { baseCurrencyAssetId: 'USD' }, { finalAssetId: 'ETH' },
  ])('rejects mixed report dimensions: %j', (change) => {
    expect(() => buildDcaReport([execs[0]!, { ...execs[1]!, ...change }])).toThrow('分别汇总');
  });

  it('ignores deleted dimensions and handles empty input', () => {
    expect(buildDcaReport([execs[0]!, { ...execs[1]!, planId: 'p2', isDeleted: true }]).rows).toHaveLength(1);
    expect(buildDcaReport([]).totalInvested).toBe('0');
  });

  it('breaks same-day ties by execution ID', () => {
    const sameDay = [{ ...execs[0]!, id: 'b' }, { ...execs[0]!, id: 'a' }];
    expect(buildDcaReport(sameDay).rows.map((row) => row.executionId)).toEqual(['a', 'b']);
  });
});
