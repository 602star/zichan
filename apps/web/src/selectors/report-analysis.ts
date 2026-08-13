import {
  D,
  addDays,
  addMonths,
  daysBetween,
  endOfMonth,
  isDateInRange,
  sum,
  type DateRange,
  type DateRangePreset,
} from '@zichan/core';
import type { TransactionReportAggregateRow } from '@zichan/db';
import type { Snapshot } from '../db/snapshot.js';
import { categoryLabel, TYPE_LABEL } from '../transactionMeta.js';
import { createReportCurrency } from '../reportCurrency.js';
import { buildBudgetMonthFromAggregates } from './transactions.js';

export interface ComparableReportRange extends DateRange {
  preset?: DateRangePreset;
}

export interface ReportComparisonRanges {
  current: Required<DateRange>;
  previous: Required<DateRange>;
  yearOverYear: Required<DateRange>;
}

export interface CashflowTotals {
  income: string;
  expense: string;
  net: string;
  complete: boolean;
  missingRateAssetCodes: string[];
}

export interface ComparisonValue {
  current: string;
  previous: string;
  yearOverYear: string;
  previousDelta: string;
  yearOverYearDelta: string;
  previousPercent?: string;
  yearOverYearPercent?: string;
}

export interface TransactionChangeDriver {
  key: string;
  category: string;
  categoryLabel: string;
  direction: 'income' | 'expense';
  directionLabel: string;
  currentAmount: string;
  previousAmount: string;
  netImpactDelta: string;
}

export interface TransactionComparison {
  ranges: ReportComparisonRanges;
  current: CashflowTotals;
  previous: CashflowTotals;
  yearOverYear: CashflowTotals;
  income: ComparisonValue;
  expense: ComparisonValue;
  net: ComparisonValue;
  topDrivers: TransactionChangeDriver[];
  complete: boolean;
  missingRateAssetCodes: string[];
}

export interface BudgetVarianceRow {
  key: string;
  month: string;
  category: string;
  categoryLabel: string;
  planned: string;
  available: string;
  actual: string;
  variance: string;
  over: boolean;
  complete: boolean;
  range: Required<DateRange>;
}

export interface BudgetVarianceSummary {
  planned: string;
  actual: string;
  variance: string;
  overCount: number;
  complete: boolean;
  rows: BudgetVarianceRow[];
}

function percentChange(current: string, baseline: string): string | undefined {
  const base = D(baseline);
  if (base.isZero()) return undefined;
  return D(current).minus(base).div(base.abs()).times(100).toString();
}

function comparisonValue(current: string, previous: string, yearOverYear: string): ComparisonValue {
  return {
    current,
    previous,
    yearOverYear,
    previousDelta: D(current).minus(previous).toString(),
    yearOverYearDelta: D(current).minus(yearOverYear).toString(),
    previousPercent: percentChange(current, previous),
    yearOverYearPercent: percentChange(current, yearOverYear),
  };
}

function sameLengthPrevious(range: Required<DateRange>): Required<DateRange> {
  const length = daysBetween(range.from, range.to) + 1;
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(length - 1)), to };
}

/**
 * Build like-for-like comparison windows. An in-progress range is capped at the
 * ledger as-of date, so "this month" compares month-to-date with the same part
 * of last month/year instead of comparing a partial month with a full month.
 */
export function reportComparisonRanges(
  range: ComparableReportRange,
  asOf: string,
): ReportComparisonRanges | null {
  if (!range.from || !range.to) return null;
  const current = {
    from: range.from,
    to: range.to > asOf ? asOf : range.to,
  };
  if (current.from > current.to) return null;

  let previous: Required<DateRange>;
  if (range.preset === 'today' || range.preset === 'this_week') {
    previous = { from: addDays(current.from, -7), to: addDays(current.to, -7) };
    if (range.preset === 'today') previous = { from: addDays(current.from, -1), to: addDays(current.to, -1) };
  } else if (range.preset === 'this_month' || range.preset === 'last_month') {
    previous = {
      from: addMonths(current.from, -1),
      to: current.to === range.to && current.to === endOfMonth(current.to)
        ? addDays(current.from, -1)
        : addMonths(current.to, -1),
    };
  } else if (range.preset === 'last_3_months') {
    previous = {
      from: addMonths(current.from, -3),
      to: current.to === range.to && current.to === endOfMonth(current.to)
        ? addDays(current.from, -1)
        : addMonths(current.to, -3),
    };
  } else if (range.preset === 'this_year') {
    previous = { from: addMonths(current.from, -12), to: addMonths(current.to, -12) };
  } else {
    previous = sameLengthPrevious(current);
  }

  return {
    current,
    previous,
    yearOverYear: {
      from: addMonths(current.from, -12),
      to: addMonths(current.to, -12),
    },
  };
}

function aggregateTotals(
  snap: Snapshot,
  aggregates: TransactionReportAggregateRow[],
  range: DateRange,
): CashflowTotals {
  const report = createReportCurrency(snap, range.to);
  let income = D(0);
  let expense = D(0);
  for (const row of aggregates) {
    if (!isDateInRange(row.reportDate, range)) continue;
    const converted = report.toReportAt(sum(row.amounts), row.reportAssetId, row.reportDate);
    if (!converted) continue;
    if (row.direction === 'income') income = income.plus(converted);
    else expense = expense.plus(converted);
  }
  const missingRateAssetCodes = report.missingCodes();
  return {
    income: income.toString(),
    expense: expense.toString(),
    net: income.minus(expense).toString(),
    complete: missingRateAssetCodes.length === 0,
    missingRateAssetCodes,
  };
}

function categoryNetImpacts(
  snap: Snapshot,
  aggregates: TransactionReportAggregateRow[],
  range: DateRange,
): { values: Map<string, ReturnType<typeof D>>; complete: boolean } {
  const report = createReportCurrency(snap, range.to);
  const values = new Map<string, ReturnType<typeof D>>();
  for (const row of aggregates) {
    if (!isDateInRange(row.reportDate, range)) continue;
    const converted = report.toReportAt(sum(row.amounts), row.reportAssetId, row.reportDate);
    if (!converted) continue;
    const key = `${row.direction}\0${row.category}`;
    const impact = row.direction === 'income' ? converted : converted.negated();
    values.set(key, (values.get(key) ?? D(0)).plus(impact));
  }
  return { values, complete: report.missingCodes().length === 0 };
}

export function buildTransactionComparison(
  snap: Snapshot,
  aggregates: TransactionReportAggregateRow[],
  ranges: ReportComparisonRanges,
): TransactionComparison {
  const current = aggregateTotals(snap, aggregates, ranges.current);
  const previous = aggregateTotals(snap, aggregates, ranges.previous);
  const yearOverYear = aggregateTotals(snap, aggregates, ranges.yearOverYear);
  const currentDrivers = categoryNetImpacts(snap, aggregates, ranges.current);
  const previousDrivers = categoryNetImpacts(snap, aggregates, ranges.previous);
  const driverKeys = new Set([...currentDrivers.values.keys(), ...previousDrivers.values.keys()]);
  const topDrivers = [...driverKeys].map((key): TransactionChangeDriver => {
    const [directionRaw, category = 'other_expense'] = key.split('\0');
    const direction = directionRaw === 'income' ? 'income' : 'expense';
    const currentImpact = currentDrivers.values.get(key) ?? D(0);
    const previousImpact = previousDrivers.values.get(key) ?? D(0);
    return {
      key,
      category,
      categoryLabel: categoryLabel(category, snap.categories),
      direction,
      directionLabel: TYPE_LABEL[direction],
      currentAmount: currentImpact.abs().toString(),
      previousAmount: previousImpact.abs().toString(),
      netImpactDelta: currentImpact.minus(previousImpact).toString(),
    };
  }).filter((row) => !D(row.netImpactDelta).isZero())
    .sort((left, right) => D(right.netImpactDelta).abs().comparedTo(D(left.netImpactDelta).abs()))
    .slice(0, 3);
  const missingRateAssetCodes = [...new Set([
    ...current.missingRateAssetCodes,
    ...previous.missingRateAssetCodes,
    ...yearOverYear.missingRateAssetCodes,
  ])].sort((left, right) => left.localeCompare(right));
  return {
    ranges,
    current,
    previous,
    yearOverYear,
    income: comparisonValue(current.income, previous.income, yearOverYear.income),
    expense: comparisonValue(current.expense, previous.expense, yearOverYear.expense),
    net: comparisonValue(current.net, previous.net, yearOverYear.net),
    topDrivers,
    complete: current.complete && previous.complete && yearOverYear.complete
      && currentDrivers.complete && previousDrivers.complete,
    missingRateAssetCodes,
  };
}

function budgetMonthsInRange(snap: Snapshot, range: DateRange): string[] {
  return [...new Set(snap.budgetCategories
    .filter((budget) => !budget.isDeleted)
    .map((budget) => budget.month)
    .filter((month) => {
      const from = `${month}-01`;
      const to = endOfMonth(from);
      return (!range.from || to >= range.from) && (!range.to || from <= range.to);
    }))].sort((left, right) => left.localeCompare(right));
}

/** Monthly rows stay separate so rollover is never counted twice across months. */
export function buildBudgetVariance(
  snap: Snapshot,
  aggregates: TransactionReportAggregateRow[],
  range: DateRange,
): BudgetVarianceSummary {
  const eligibleAggregates = aggregates.filter((row) => !range.to || row.reportDate <= range.to);
  const rows = budgetMonthsInRange(snap, range).flatMap((month) => (
    buildBudgetMonthFromAggregates(snap, month, eligibleAggregates).map((budget): BudgetVarianceRow => {
      const variance = D(budget.actual).minus(budget.available);
      const monthRange = { from: `${month}-01`, to: endOfMonth(`${month}-01`) };
      const drillRange = {
        from: range.from && range.from > monthRange.from ? range.from : monthRange.from,
        to: range.to && range.to < monthRange.to ? range.to : monthRange.to,
      };
      return {
        key: `${month}\0${budget.category}`,
        month,
        category: budget.category,
        categoryLabel: budget.label,
        planned: budget.planned,
        available: budget.available,
        actual: budget.actual,
        variance: variance.toString(),
        over: budget.conversionKnown && variance.gt(0),
        complete: budget.conversionKnown,
        range: drillRange,
      };
    })
  ));
  const completeRows = rows.filter((row) => row.complete);
  const planned = sum(completeRows.map((row) => row.planned));
  const actual = sum(completeRows.map((row) => row.actual));
  return {
    planned: planned.toString(),
    actual: actual.toString(),
    variance: actual.minus(planned).toString(),
    overCount: rows.filter((row) => row.over).length,
    complete: completeRows.length === rows.length,
    rows: rows.sort((left, right) => {
      if (left.over !== right.over) return Number(right.over) - Number(left.over);
      return D(right.variance).abs().comparedTo(D(left.variance).abs())
        || right.month.localeCompare(left.month)
        || left.categoryLabel.localeCompare(right.categoryLabel);
    }),
  };
}
