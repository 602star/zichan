import { describe, expect, it } from 'vitest';
import type { BudgetCategory } from '@zichan/core';
import type { TransactionReportAggregateRow } from '@zichan/db';
import {
  buildBudgetVariance,
  buildTransactionComparison,
  reportComparisonRanges,
} from '../src/selectors/report-analysis.js';
import { makeSnapshot } from './fixtures.js';

function aggregate(
  reportAssetId: string,
  reportDate: string,
  direction: 'income' | 'expense',
  category: string,
  amount: string,
): TransactionReportAggregateRow {
  return { reportAssetId, reportDate, direction, category, amounts: [amount], count: 1 };
}

describe('report comparison analysis', () => {
  it('compares in-progress calendar periods with like-for-like prior windows', () => {
    expect(reportComparisonRanges({
      preset: 'this_month',
      from: '2026-08-01',
      to: '2026-08-31',
    }, '2026-08-13')).toEqual({
      current: { from: '2026-08-01', to: '2026-08-13' },
      previous: { from: '2026-07-01', to: '2026-07-13' },
      yearOverYear: { from: '2025-08-01', to: '2025-08-13' },
    });
    expect(reportComparisonRanges({
      preset: 'custom',
      from: '2026-03-01',
      to: '2026-03-10',
    }, '2026-08-13')?.previous).toEqual({ from: '2026-02-19', to: '2026-02-28' });
    expect(reportComparisonRanges({ preset: 'all' }, '2026-08-13')).toBeNull();
    expect(reportComparisonRanges({
      preset: 'last_month',
      from: '2026-02-01',
      to: '2026-02-28',
    }, '2026-08-13')?.previous).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('calculates income, expense, net comparisons and the top three net-change drivers', () => {
    const snap = makeSnapshot();
    const ranges = reportComparisonRanges({
      preset: 'this_month',
      from: '2026-03-01',
      to: '2026-03-31',
    }, '2026-03-31')!;
    const rows = [
      aggregate(snap.ids.gbp, '2026-03-05', 'income', 'salary', '1000'),
      aggregate(snap.ids.gbp, '2026-03-06', 'expense', 'food', '150'),
      aggregate(snap.ids.gbp, '2026-03-07', 'expense', 'shopping', '20'),
      aggregate(snap.ids.gbp, '2026-02-05', 'income', 'salary', '800'),
      aggregate(snap.ids.gbp, '2026-02-06', 'expense', 'food', '100'),
      aggregate(snap.ids.gbp, '2026-02-07', 'expense', 'shopping', '40'),
      aggregate(snap.ids.gbp, '2025-03-05', 'income', 'salary', '900'),
      aggregate(snap.ids.gbp, '2025-03-06', 'expense', 'food', '80'),
    ];

    const result = buildTransactionComparison(snap, rows, ranges);
    expect(result.current).toMatchObject({ income: '1000', expense: '170', net: '830', complete: true });
    expect(result.previous).toMatchObject({ income: '800', expense: '140', net: '660' });
    expect(result.income.previousDelta).toBe('200');
    expect(result.income.previousPercent).toBe('25');
    expect(result.net.yearOverYearDelta).toBe('10');
    expect(result.topDrivers.map((row) => [row.category, row.netImpactDelta])).toEqual([
      ['salary', '200'],
      ['food', '-50'],
      ['shopping', '20'],
    ]);
  });

  it('keeps monthly budget variance separate and marks overspending against available budget', () => {
    const snap = makeSnapshot();
    const base = { createdAt: '', updatedAt: '', version: 1, isDeleted: false };
    snap.budgetCategories = [
      { ...base, id: 'budget-food', month: '2026-03', category: 'food', plannedAmount: '100', assetId: snap.ids.gbp, rolloverMode: 'none' },
      { ...base, id: 'budget-shopping', month: '2026-03', category: 'shopping', plannedAmount: '50', assetId: snap.ids.gbp, rolloverMode: 'none' },
    ] satisfies BudgetCategory[];
    const rows = [
      aggregate(snap.ids.gbp, '2026-03-05', 'expense', 'food', '120'),
      aggregate(snap.ids.gbp, '2026-03-06', 'expense', 'shopping', '20'),
      aggregate(snap.ids.gbp, '2026-03-25', 'expense', 'food', '1000'),
    ];

    const result = buildBudgetVariance(snap, rows, { from: '2026-03-01', to: '2026-03-13' });
    expect(result).toMatchObject({ planned: '150', actual: '140', variance: '-10', overCount: 1, complete: true });
    expect(result.rows[0]).toMatchObject({
      category: 'food', planned: '100', available: '100', actual: '120', variance: '20', over: true,
      range: { from: '2026-03-01', to: '2026-03-13' },
    });
    expect(result.rows[1]).toMatchObject({ category: 'shopping', variance: '-30', over: false });
  });
});
