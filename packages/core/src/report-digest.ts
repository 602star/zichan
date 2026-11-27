/**
 * Pure report digest and inactivity reminder calculations.
 *
 * Designed to run identically on the sync server (from an in-memory decrypted
 * ledger replay) and on clients. All money arithmetic uses `decimal.js`.
 */
import { calendarOccurrences, type CalendarEntry, type CalendarOccurrenceState } from './calendar.js';
import {
  addDays,
  addMonths,
  daysBetween,
  endOfMonth,
  isValidDay,
  parseDay,
  startOfMonth,
  startOfWeek,
} from './dates.js';
import { D, roundD, safeDiv, sum } from './decimal.js';
import { fixedConsumableRemaining, fixedUsageUnitLabel } from './fixed.js';
import { nextUnhandledDcaOccurrence } from './schedule.js';
import { isTransactionActive, transactionReportingEffect } from './transaction.js';
import type {
  Account,
  Asset,
  BudgetCategory,
  Category,
  DcaExecution,
  DcaPlan,
  FixedAsset,
  FixedAssetConsumable,
  FixedAssetUsageLog,
  FixedAssetUsageMetric,
  RefundAllocation,
  Transaction,
  TransactionSplit,
} from './types.js';

export type ReportDigestKind = 'daily' | 'weekly' | 'monthly';
export type MonthlyPeriodMode = 'calendar' | 'payday' | 'payday_auto';

const BUILTIN_SALARY_CATEGORY_IDS = new Set([
  'salary',
  'intern_salary',
  'performance_salary',
]);

const SALARY_NAME_PATTERN = /(?:工资|薪资|薪水|薪酬|月薪|发薪|salary|payroll)/i;
const SALARY_EXCLUDE_PATTERN = /(?:年终奖|十三薪)/;

/**
 * Returns true when a category represents regular salary/payroll income.
 * Matches built-in salary categories as well as user-created income categories
 * whose name clearly indicates salary.
 */
export function isSalaryCategory(
  categoryId: string,
  categories: Category[] = [],
  explicitIds?: readonly string[],
): boolean {
  if (explicitIds && explicitIds.length > 0) return explicitIds.includes(categoryId);
  if (BUILTIN_SALARY_CATEGORY_IDS.has(categoryId)) return true;
  const cat = categories.find((row) => !row.isDeleted && row.id === categoryId);
  if (!cat) return false;
  if (cat.type !== undefined && cat.type !== 'income') return false;
  return SALARY_NAME_PATTERN.test(cat.name) && !SALARY_EXCLUDE_PATTERN.test(cat.name);
}

/**
 * Detects ordered salary payday dates from active income transactions.
 *
 * Multiple salary entries within `minGapDays` (default 15 days, e.g. base salary +
 * performance pay a couple of days later) are clustered into a single payday cycle
 * anchored at the earliest date in the cluster so they never split a monthly cycle.
 */
export function detectSalaryPaydayDates(
  transactions: Transaction[],
  categories: Category[] = [],
  options: {
    upToDay?: string;
    minGapDays?: number;
    salaryCategoryIds?: readonly string[];
  } = {},
): string[] {
  const minGapDays = Math.max(1, options.minGapDays ?? 15);
  const rawDates = new Set<string>();
  for (const tx of transactions) {
    if (!isTransactionActive(tx)) continue;
    if (tx.type !== 'income') continue;
    if (!isValidDay(tx.date)) continue;
    if (options.upToDay && tx.date > options.upToDay) continue;
    if (!isSalaryCategory(tx.category, categories, options.salaryCategoryIds)) continue;
    rawDates.add(tx.date);
  }
  const sorted = [...rawDates].sort();
  const clustered: string[] = [];
  for (const day of sorted) {
    const prev = clustered.at(-1);
    if (!prev || daysBetween(prev, day) >= minGapDays) {
      clustered.push(day);
    }
  }
  return clustered;
}

/**
 * Computes a smart payday report cycle from actual recorded salary income dates.
 *
 * - `completed`: `[previousSalaryDate, dayBeforeLatestSalaryDate]` (returns `null`
 *   when fewer than 2 salary cycles exist yet).
 * - `current`: `[latestSalaryDate, referenceDay]` (falls back to current calendar
 *   month when no salary entry has been recorded yet).
 */
export function smartPaydayReportPeriods(
  referenceDay: string,
  transactions: Transaction[],
  categories: Category[] = [],
  options: {
    target?: 'completed' | 'current';
    minGapDays?: number;
    salaryCategoryIds?: readonly string[];
  } = {},
): { period: ReportPeriod; previousPeriod: ReportPeriod } | null {
  parseDay(referenceDay);
  const target = options.target ?? 'completed';
  const paydays = detectSalaryPaydayDates(transactions, categories, {
    upToDay: referenceDay,
    minGapDays: options.minGapDays,
    salaryCategoryIds: options.salaryCategoryIds,
  });

  if (target === 'completed') {
    if (paydays.length < 2) return null;
    const latest = paydays[paydays.length - 1]!;
    const prev = paydays[paydays.length - 2]!;
    const prevPrev = paydays.length >= 3 ? paydays[paydays.length - 3]! : addMonths(prev, -1);
    const to = addDays(latest, -1);
    const prevTo = addDays(prev, -1);
    return {
      period: {
        kind: 'monthly',
        mode: 'payday_auto',
        from: prev,
        to,
        label: `${prev} 至 ${to} 发薪月报`,
        periodKey: `monthly:payday_auto:${prev}:${latest}`,
      },
      previousPeriod: {
        kind: 'monthly',
        mode: 'payday_auto',
        from: prevPrev,
        to: prevTo,
        label: `${prevPrev} 至 ${prevTo} 发薪月报`,
        periodKey: `monthly:payday_auto:${prevPrev}:${prev}`,
      },
    };
  }

  if (paydays.length === 0) {
    return monthlyReportPeriods(referenceDay, { mode: 'calendar', target: 'current' });
  }
  const latest = paydays[paydays.length - 1]!;
  const prev = paydays.length >= 2 ? paydays[paydays.length - 2]! : addMonths(latest, -1);
  const prevTo = addDays(latest, -1);
  return {
    period: {
      kind: 'monthly',
      mode: 'payday_auto',
      from: latest,
      to: referenceDay,
      label: `${latest} 至 ${referenceDay} 发薪月报（本期）`,
      periodKey: `monthly:payday_auto:current:${latest}`,
    },
    previousPeriod: {
      kind: 'monthly',
      mode: 'payday_auto',
      from: prev,
      to: prevTo,
      label: `${prev} 至 ${prevTo} 发薪月报`,
      periodKey: `monthly:payday_auto:${prev}:${latest}`,
    },
  };
}

export interface ReportPeriod {
  kind: ReportDigestKind;
  from: string;
  to: string;
  label: string;
  periodKey: string;
  mode?: MonthlyPeriodMode;
  paydayDay?: number;
}

export interface ReportCategoryRank {
  categoryId: string;
  categoryName: string;
  amount: string;
  sharePercent: string;
}

export interface ReportTopExpense {
  transactionId: string;
  date: string;
  categoryName: string;
  title: string;
  amount: string;
}

export interface ReportCurrencySummary {
  assetId: string;
  assetCode: string;
  symbol: string;
  decimals: number;
  income: string;
  expense: string;
  net: string;
  savingsRatePercent: string | null;
  transactionCount: number;
  activeDays: number;
  previousIncome: string;
  previousExpense: string;
  expenseDelta: string;
  expenseDeltaPercent: string | null;
  topCategories: ReportCategoryRank[];
  topExpenses: ReportTopExpense[];
}

export interface LedgerReportDigest {
  kind: ReportDigestKind;
  period: ReportPeriod;
  previousPeriod: ReportPeriod;
  privacyMode: boolean;
  isEmpty: boolean;
  totalTransactionCount: number;
  primaryCurrency: ReportCurrencySummary;
  otherCurrencies: ReportCurrencySummary[];
}

export interface InactivityReminderStatus {
  today: string;
  thresholdDays: number;
  lastTransactionDate?: string;
  daysSinceLastTransaction: number | null;
  shouldRemind: boolean;
}

function clampPaydayDay(day: number): number {
  if (!Number.isSafeInteger(day) || day < 1 || day > 31) {
    throw new Error('发薪日必须是 1 到 31 之间的整数');
  }
  return day;
}

/**
 * Resolves the civil day for a given year, 1-based month, and target day-of-month,
 * clamping to the last valid day of that month (e.g. 31 -> 28/29 in February).
 */
export function paydayAnchorForMonth(year: number, month: number, paydayDay: number): string {
  const clampedDay = clampPaydayDay(paydayDay);
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const targetYear = firstOfMonth.getUTCFullYear();
  const targetMonth = firstOfMonth.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const day = Math.min(clampedDay, lastDay);
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function dailyReportPeriods(referenceDay: string): {
  period: ReportPeriod;
  previousPeriod: ReportPeriod;
} {
  parseDay(referenceDay);
  const prevDay = addDays(referenceDay, -1);
  return {
    period: {
      kind: 'daily',
      from: referenceDay,
      to: referenceDay,
      label: `${referenceDay} 日报`,
      periodKey: `daily:${referenceDay}`,
    },
    previousPeriod: {
      kind: 'daily',
      from: prevDay,
      to: prevDay,
      label: `${prevDay} 日报`,
      periodKey: `daily:${prevDay}`,
    },
  };
}

export function weeklyReportPeriods(
  referenceDay: string,
  target: 'completed' | 'current' = 'completed',
): {
  period: ReportPeriod;
  previousPeriod: ReportPeriod;
} {
  parseDay(referenceDay);
  const currentWeekStart = startOfWeek(referenceDay);
  const from = target === 'completed' ? addDays(currentWeekStart, -7) : currentWeekStart;
  const to = addDays(from, 6);
  const prevFrom = addDays(from, -7);
  const prevTo = addDays(from, -1);
  return {
    period: {
      kind: 'weekly',
      from,
      to,
      label: `${from} 至 ${to} 周报`,
      periodKey: `weekly:${from}`,
    },
    previousPeriod: {
      kind: 'weekly',
      from: prevFrom,
      to: prevTo,
      label: `${prevFrom} 至 ${prevTo} 周报`,
      periodKey: `weekly:${prevFrom}`,
    },
  };
}

/**
 * Computes the monthly report period for either calendar months or payday cycles.
 *
 * For a payday cycle (e.g. `paydayDay = 10`):
 * - Each cycle runs inclusively from month M's anchor day to the day before month M+1's anchor day
 *   (e.g. `2026-10-10` through `2026-11-09`), so consecutive cycles never overlap or skip a day.
 * - On `2026-11-10` (payday itself), the `completed` cycle is `2026-10-10 ~ 2026-11-09` and the
 *   `current` cycle is `2026-11-10 ~ 2026-12-09`.
 */
export function monthlyReportPeriods(
  referenceDay: string,
  options: {
    mode: MonthlyPeriodMode;
    paydayDay?: number;
    target?: 'completed' | 'current';
  } = { mode: 'calendar' },
): {
  period: ReportPeriod;
  previousPeriod: ReportPeriod;
} {
  parseDay(referenceDay);
  const target = options.target ?? 'completed';
  const mode = options.mode;

  if (mode === 'calendar') {
    const baseMonthStart = target === 'completed'
      ? addMonths(startOfMonth(referenceDay), -1)
      : startOfMonth(referenceDay);
    const prevMonthStart = addMonths(baseMonthStart, -1);
    const from = startOfMonth(baseMonthStart);
    const to = endOfMonth(baseMonthStart);
    const prevFrom = startOfMonth(prevMonthStart);
    const prevTo = endOfMonth(prevMonthStart);
    return {
      period: {
        kind: 'monthly',
        mode: 'calendar',
        from,
        to,
        label: `${from.slice(0, 7)} 自然月报`,
        periodKey: `monthly:calendar:${from.slice(0, 7)}`,
      },
      previousPeriod: {
        kind: 'monthly',
        mode: 'calendar',
        from: prevFrom,
        to: prevTo,
        label: `${prevFrom.slice(0, 7)} 自然月报`,
        periodKey: `monthly:calendar:${prevFrom.slice(0, 7)}`,
      },
    };
  }

  const paydayDay = clampPaydayDay(options.paydayDay ?? 10);
  const year = Number(referenceDay.slice(0, 4));
  const month = Number(referenceDay.slice(5, 7));
  const thisMonthAnchor = paydayAnchorForMonth(year, month, paydayDay);

  // Determine the start month of the *current* payday cycle that contains `referenceDay`.
  let currentCycleYear = year;
  let currentCycleMonth = month;
  if (referenceDay < thisMonthAnchor) {
    currentCycleMonth -= 1;
    if (currentCycleMonth === 0) {
      currentCycleMonth = 12;
      currentCycleYear -= 1;
    }
  }

  const shiftMonth = (y: number, m: number, delta: number): { year: number; month: number } => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  };

  const targetStartYM = target === 'completed'
    ? shiftMonth(currentCycleYear, currentCycleMonth, -1)
    : { year: currentCycleYear, month: currentCycleMonth };
  const targetNextYM = shiftMonth(targetStartYM.year, targetStartYM.month, 1);
  const prevStartYM = shiftMonth(targetStartYM.year, targetStartYM.month, -1);

  const from = paydayAnchorForMonth(targetStartYM.year, targetStartYM.month, paydayDay);
  const to = addDays(paydayAnchorForMonth(targetNextYM.year, targetNextYM.month, paydayDay), -1);
  const prevFrom = paydayAnchorForMonth(prevStartYM.year, prevStartYM.month, paydayDay);
  const prevTo = addDays(from, -1);

  return {
    period: {
      kind: 'monthly',
      mode: 'payday',
      paydayDay,
      from,
      to,
      label: `${from} 至 ${to} 发薪月报`,
      periodKey: `monthly:payday:${paydayDay}:${from}`,
    },
    previousPeriod: {
      kind: 'monthly',
      mode: 'payday',
      paydayDay,
      from: prevFrom,
      to: prevTo,
      label: `${prevFrom} 至 ${prevTo} 发薪月报`,
      periodKey: `monthly:payday:${paydayDay}:${prevFrom}`,
    },
  };
}

/** True when `today` is the start day of a new payday cycle (or the 1st for calendar mode). */
export function isMonthlyReportDueDay(
  today: string,
  mode: MonthlyPeriodMode,
  paydayDay = 10,
): boolean {
  parseDay(today);
  if (mode === 'calendar') return today.endsWith('-01');
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return today === paydayAnchorForMonth(year, month, paydayDay);
}

interface CurrencyAccumulator {
  assetId: string;
  income: string[];
  expense: string[];
  prevIncome: string[];
  prevExpense: string[];
  count: number;
  days: Set<string>;
  categoryTotals: Map<string, string[]>;
  expenses: Array<{
    transactionId: string;
    date: string;
    categoryName: string;
    title: string;
    amount: string;
  }>;
}

function createAccumulator(assetId: string): CurrencyAccumulator {
  return {
    assetId,
    income: [],
    expense: [],
    prevIncome: [],
    prevExpense: [],
    count: 0,
    days: new Set<string>(),
    categoryTotals: new Map<string, string[]>(),
    expenses: [],
  };
}

function buildCategoryMap(categories: Category[]): Map<string, string> {
  const byId = new Map<string, Category>();
  for (const row of categories) {
    if (!row.isDeleted) byId.set(row.id, row);
  }
  const names = new Map<string, string>();
  for (const [id, row] of byId) {
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    names.set(id, parent ? `${parent.name} / ${row.name}` : row.name);
  }
  return names;
}

function finalizeCurrencySummary(
  acc: CurrencyAccumulator,
  assetById: Map<string, Asset>,
  categoryNames: Map<string, string>,
): ReportCurrencySummary {
  const asset = assetById.get(acc.assetId);
  const decimals = asset?.decimals ?? 2;
  const incomeD = sum(acc.income);
  const expenseD = sum(acc.expense);
  const netD = incomeD.minus(expenseD);
  const prevIncomeD = sum(acc.prevIncome);
  const prevExpenseD = sum(acc.prevExpense);
  const expenseDeltaD = expenseD.minus(prevExpenseD);

  const savingsRatePercent = incomeD.gt(0)
    ? roundD(safeDiv(netD.mul(100), incomeD), 1).toFixed(1)
    : null;
  const expenseDeltaPercent = prevExpenseD.gt(0)
    ? roundD(safeDiv(expenseDeltaD.mul(100), prevExpenseD), 1).toFixed(1)
    : null;

  const topCategories: ReportCategoryRank[] = [...acc.categoryTotals.entries()]
    .map(([categoryId, amounts]) => ({
      categoryId,
      categoryName: categoryNames.get(categoryId) ?? categoryId,
      total: sum(amounts),
    }))
    .filter((row) => row.total.gt(0))
    .sort((a, b) => b.total.comparedTo(a.total) || a.categoryName.localeCompare(b.categoryName, 'zh-CN'))
    .slice(0, 5)
    .map((row) => ({
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      amount: roundD(row.total, decimals).toFixed(decimals),
      sharePercent: expenseD.gt(0)
        ? roundD(safeDiv(row.total.mul(100), expenseD), 1).toFixed(1)
        : '0.0',
    }));

  const topExpenses: ReportTopExpense[] = acc.expenses
    .sort((a, b) => D(b.amount).comparedTo(D(a.amount)) || b.date.localeCompare(a.date))
    .slice(0, 3)
    .map((row) => ({
      ...row,
      amount: roundD(D(row.amount), decimals).toFixed(decimals),
    }));

  return {
    assetId: acc.assetId,
    assetCode: asset?.code ?? acc.assetId,
    symbol: asset?.symbol ?? '',
    decimals,
    income: roundD(incomeD, decimals).toFixed(decimals),
    expense: roundD(expenseD, decimals).toFixed(decimals),
    net: roundD(netD, decimals).toFixed(decimals),
    savingsRatePercent,
    transactionCount: acc.count,
    activeDays: acc.days.size,
    previousIncome: roundD(prevIncomeD, decimals).toFixed(decimals),
    previousExpense: roundD(prevExpenseD, decimals).toFixed(decimals),
    expenseDelta: roundD(expenseDeltaD, decimals).toFixed(decimals),
    expenseDeltaPercent,
    topCategories,
    topExpenses,
  };
}

export interface BuildReportDigestInput {
  kind: ReportDigestKind;
  period: ReportPeriod;
  previousPeriod: ReportPeriod;
  transactions: Transaction[];
  transactionSplits?: TransactionSplit[];
  refundAllocations?: RefundAllocation[];
  categories?: Category[];
  assets?: Asset[];
  baseCurrencyAssetId?: string;
  privacyMode?: boolean;
}

export function buildLedgerReportDigest(input: BuildReportDigestInput): LedgerReportDigest {
  const {
    kind,
    period,
    previousPeriod,
    transactions,
    transactionSplits = [],
    refundAllocations = [],
    categories = [],
    assets = [],
    baseCurrencyAssetId,
    privacyMode = false,
  } = input;

  const assetById = new Map<string, Asset>(assets.filter((row) => !row.isDeleted).map((row) => [row.id, row]));
  const categoryNames = buildCategoryMap(categories);
  const byCurrency = new Map<string, CurrencyAccumulator>();
  const ensure = (assetId: string): CurrencyAccumulator => {
    let acc = byCurrency.get(assetId);
    if (!acc) {
      acc = createAccumulator(assetId);
      byCurrency.set(assetId, acc);
    }
    return acc;
  };

  let totalTransactionCount = 0;

  for (const tx of transactions) {
    if (!isTransactionActive(tx)) continue;
    if (tx.reportingTreatment === 'balance_only') continue;
    if (tx.type !== 'income' && tx.type !== 'expense' && tx.type !== 'refund') continue;

    const effect = transactionReportingEffect(tx, {
      splits: transactionSplits,
      refundAllocations,
    });
    const inCurrent = effect.reportDate >= period.from && effect.reportDate <= period.to;
    const inPrevious = effect.reportDate >= previousPeriod.from && effect.reportDate <= previousPeriod.to;
    if (!inCurrent && !inPrevious) continue;

    const acc = ensure(effect.reportAssetId);
    if (inCurrent) {
      totalTransactionCount += 1;
      acc.count += 1;
      acc.days.add(effect.reportDate);
      if (!D(effect.incomeDelta).isZero()) acc.income.push(effect.incomeDelta);
      if (!D(effect.expenseDelta).isZero()) acc.expense.push(effect.expenseDelta);

      if (tx.type === 'expense') {
        for (const row of effect.categoryRows) {
          const list = acc.categoryTotals.get(row.categoryId) ?? [];
          list.push(row.amount);
          acc.categoryTotals.set(row.categoryId, list);
        }
        const categoryName = categoryNames.get(tx.category) ?? tx.category;
        const title = tx.note?.trim() || categoryName;
        acc.expenses.push({
          transactionId: tx.id,
          date: effect.reportDate,
          categoryName,
          title,
          amount: D(tx.amount).abs().toString(),
        });
      } else if (tx.type === 'refund') {
        for (const row of effect.categoryRows) {
          const list = acc.categoryTotals.get(row.categoryId) ?? [];
          list.push(D(row.amount).abs().negated().toString());
          acc.categoryTotals.set(row.categoryId, list);
        }
      }
    } else if (inPrevious) {
      if (!D(effect.incomeDelta).isZero()) acc.prevIncome.push(effect.incomeDelta);
      if (!D(effect.expenseDelta).isZero()) acc.prevExpense.push(effect.expenseDelta);
    }
  }

  const fallbackAssetId = baseCurrencyAssetId
    ?? [...byCurrency.values()].sort((a, b) => b.count - a.count)[0]?.assetId
    ?? assets.find((row) => !row.isDeleted && row.type === 'fiat')?.id
    ?? 'CNY';

  const primaryAcc = byCurrency.get(fallbackAssetId) ?? createAccumulator(fallbackAssetId);
  const primaryCurrency = finalizeCurrencySummary(primaryAcc, assetById, categoryNames);
  const otherCurrencies = [...byCurrency.values()]
    .filter((acc) => acc.assetId !== fallbackAssetId && acc.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((acc) => finalizeCurrencySummary(acc, assetById, categoryNames));

  return {
    kind,
    period,
    previousPeriod,
    privacyMode,
    isEmpty: totalTransactionCount === 0,
    totalTransactionCount,
    primaryCurrency,
    otherCurrencies,
  };
}

/**
 * Checks whether the user has gone at least `thresholdDays` without recording
 * any active transaction on or before `today`.
 *
 * Empty ledgers with zero transactions return `shouldRemind: false` so new
 * accounts are not nagged before their first entry.
 */
export function evaluateInactivityReminder(input: {
  today: string;
  thresholdDays: number;
  transactions: Transaction[];
}): InactivityReminderStatus {
  parseDay(input.today);
  const thresholdDays = Math.max(1, Math.min(60, Math.floor(input.thresholdDays)));
  let latestDay: string | undefined;

  for (const tx of input.transactions) {
    if (!isTransactionActive(tx)) continue;
    if (!isValidDay(tx.date) || tx.date > input.today) continue;
    if (!latestDay || tx.date > latestDay) latestDay = tx.date;
  }

  if (!latestDay) {
    return {
      today: input.today,
      thresholdDays,
      daysSinceLastTransaction: null,
      shouldRemind: false,
    };
  }

  const gap = daysBetween(latestDay, input.today);
  return {
    today: input.today,
    thresholdDays,
    lastTransactionDate: latestDay,
    daysSinceLastTransaction: gap,
    shouldRemind: gap >= thresholdDays,
  };
}

// ─────────────────────────── Bill Due / DCA / Calendar Reminders ───────────────────────────

export interface BillDueReminderItem {
  accountId: string;
  accountName: string;
  kind: 'credit_card' | 'loan';
  dueDate: string;
  daysUntil: number;
  statementDay?: number;
  creditLimit?: string;
}

export interface BillDueReminderStatus {
  today: string;
  daysBefore: number;
  items: BillDueReminderItem[];
}

/**
 * Finds credit-card or loan accounts whose next `paymentDueDay` falls within
 * `daysBefore` days from `today` (inclusive).
 */
export function evaluateBillDueReminders(input: {
  today: string;
  daysBefore: number;
  accounts: Account[];
}): BillDueReminderStatus {
  parseDay(input.today);
  const daysBefore = Math.max(0, Math.min(30, Math.floor(input.daysBefore)));
  const year = Number(input.today.slice(0, 4));
  const month = Number(input.today.slice(5, 7));
  const items: BillDueReminderItem[] = [];

  for (const acc of input.accounts) {
    if (acc.isDeleted || !acc.isActive) continue;
    if (acc.kind !== 'credit_card' && acc.kind !== 'loan') continue;
    if (!acc.paymentDueDay || !Number.isSafeInteger(acc.paymentDueDay) || acc.paymentDueDay < 1 || acc.paymentDueDay > 31) continue;

    let dueDate = paydayAnchorForMonth(year, month, acc.paymentDueDay);
    if (dueDate < input.today) {
      const next = new Date(Date.UTC(year, month, 1));
      dueDate = paydayAnchorForMonth(next.getUTCFullYear(), next.getUTCMonth() + 1, acc.paymentDueDay);
    }
    const daysUntil = daysBetween(input.today, dueDate);
    if (daysUntil >= 0 && daysUntil <= daysBefore) {
      items.push({
        accountId: acc.id,
        accountName: acc.name,
        kind: acc.kind,
        dueDate,
        daysUntil,
        ...(acc.statementDay ? { statementDay: acc.statementDay } : {}),
        ...(acc.creditLimit ? { creditLimit: acc.creditLimit } : {}),
      });
    }
  }

  items.sort((a, b) => a.daysUntil - b.daysUntil || a.accountName.localeCompare(b.accountName, 'zh-CN'));
  return { today: input.today, daysBefore, items };
}

export interface DcaReminderItem {
  planId: string;
  planName: string;
  scheduledDate: string;
  daysUntil: number;
  plannedAmount: string;
  baseCurrencyCode: string;
  baseCurrencySymbol: string;
  targetAssetCode: string;
}

export interface DcaReminderStatus {
  today: string;
  daysBefore: number;
  items: DcaReminderItem[];
}

/**
 * Finds active automatic DCA plans that have an unhandled occurrence due
 * (overdue or within `daysBefore` days of `today`).
 */
export function evaluateDcaReminders(input: {
  today: string;
  daysBefore: number;
  dcaPlans: DcaPlan[];
  dcaExecutions: DcaExecution[];
  assets?: Asset[];
}): DcaReminderStatus {
  parseDay(input.today);
  const daysBefore = Math.max(0, Math.min(30, Math.floor(input.daysBefore)));
  const assetById = new Map((input.assets ?? []).filter((a) => !a.isDeleted).map((a) => [a.id, a]));
  const items: DcaReminderItem[] = [];

  for (const plan of input.dcaPlans) {
    if (plan.isDeleted || plan.status !== 'active' || plan.frequency === 'manual') continue;
    let next;
    try {
      next = nextUnhandledDcaOccurrence(plan, input.dcaExecutions);
    } catch {
      continue;
    }
    if (!next) continue;
    const daysUntil = daysBetween(input.today, next.date);
    const windowDays = Math.max(daysBefore, plan.reminderDaysBefore ?? 0);
    if (daysUntil <= windowDays) {
      const base = assetById.get(plan.baseCurrencyAssetId);
      const target = assetById.get(plan.targetAssetId);
      items.push({
        planId: plan.id,
        planName: plan.name,
        scheduledDate: next.date,
        daysUntil,
        plannedAmount: plan.plannedAmount,
        baseCurrencyCode: base?.code ?? plan.baseCurrencyAssetId,
        baseCurrencySymbol: base?.symbol ?? '',
        targetAssetCode: target?.code ?? plan.targetAssetId,
      });
    }
  }

  items.sort((a, b) => a.daysUntil - b.daysUntil || a.planName.localeCompare(b.planName, 'zh-CN'));
  return { today: input.today, daysBefore, items };
}

export interface CalendarReminderItem {
  entryId: string;
  title: string;
  kind: 'birthday' | 'anniversary';
  date: string;
  daysUntil: number;
  calendar: 'solar' | 'lunar';
  age?: number;
}

export interface CalendarReminderStatus {
  today: string;
  daysBefore: number;
  items: CalendarReminderItem[];
}

/**
 * Finds upcoming solar or lunar birthdays and anniversaries within `daysBefore`
 * days of `today` (inclusive), skipping completed/skipped occurrences.
 */
export function evaluateCalendarReminders(input: {
  today: string;
  daysBefore: number;
  entries: CalendarEntry[];
  states?: CalendarOccurrenceState[];
}): CalendarReminderStatus {
  parseDay(input.today);
  const daysBefore = Math.max(0, Math.min(30, Math.floor(input.daysBefore)));
  const to = addDays(input.today, daysBefore);
  const items: CalendarReminderItem[] = [];

  for (const entry of input.entries) {
    if (entry.isDeleted) continue;
    if (entry.kind !== 'birthday' && entry.kind !== 'anniversary') continue;
    let occurrences;
    try {
      occurrences = calendarOccurrences(entry, input.today, to, input.states ?? []);
    } catch {
      continue;
    }
    for (const occ of occurrences) {
      if (occ.completed) continue;
      const daysUntil = daysBetween(input.today, occ.date);
      if (daysUntil < 0 || daysUntil > daysBefore) continue;
      const occYear = Number(occ.date.slice(0, 4));
      const age = entry.kind === 'birthday' && entry.birthYear && occYear >= entry.birthYear
        ? occYear - entry.birthYear
        : undefined;
      items.push({
        entryId: entry.id,
        title: entry.title,
        kind: entry.kind,
        date: occ.date,
        daysUntil,
        calendar: entry.calendar,
        ...(age !== undefined ? { age } : {}),
      });
    }
  }

  items.sort((a, b) => a.daysUntil - b.daysUntil || a.title.localeCompare(b.title, 'zh-CN'));
  return { today: input.today, daysBefore, items };
}

// ─────────────────────────── Budget Overrun & Fixed Asset Reminders ───────────────────────────

export type BudgetAlertLevel = 'warning' | 'over';

export interface BudgetAlertItem {
  budgetId: string;
  month: string;
  categoryId: string;
  categoryName: string;
  assetId: string;
  assetCode: string;
  symbol: string;
  plannedAmount: string;
  spentAmount: string;
  usagePercent: string;
  level: BudgetAlertLevel;
}

export interface BudgetAlertStatus {
  month: string;
  warnPercent: number;
  items: BudgetAlertItem[];
}

/**
 * Evaluates current-month category budgets against net spending (expenses minus
 * refunds). Supports budgets set on either a parent category (rolls up its child
 * categories) or a leaf category.
 */
export function evaluateBudgetAlerts(input: {
  today: string;
  warnPercent?: number;
  budgetCategories: BudgetCategory[];
  transactions: Transaction[];
  transactionSplits?: TransactionSplit[];
  refundAllocations?: RefundAllocation[];
  categories?: Category[];
  assets?: Asset[];
}): BudgetAlertStatus {
  parseDay(input.today);
  const month = input.today.slice(0, 7);
  const warnPercent = Math.max(50, Math.min(99, Math.floor(input.warnPercent ?? 80)));
  const monthBudgets = input.budgetCategories.filter((b) => !b.isDeleted && b.month === month && D(b.plannedAmount).gt(0));
  if (monthBudgets.length === 0) return { month, warnPercent, items: [] };

  const categories = (input.categories ?? []).filter((c) => !c.isDeleted);
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const categoryNames = buildCategoryMap(categories);
  const assetById = new Map((input.assets ?? []).filter((a) => !a.isDeleted).map((a) => [a.id, a]));

  const from = startOfMonth(input.today);
  const to = endOfMonth(input.today);

  // Sum net expense per (assetId, categoryId) for this month
  const spentMap = new Map<string, string[]>();
  const addSpent = (assetId: string, categoryId: string, amount: string) => {
    const key = `${assetId}:${categoryId}`;
    const list = spentMap.get(key) ?? [];
    list.push(amount);
    spentMap.set(key, list);
  };

  for (const tx of input.transactions) {
    if (!isTransactionActive(tx)) continue;
    if (tx.reportingTreatment === 'balance_only') continue;
    if (tx.type !== 'expense' && tx.type !== 'refund') continue;
    const effect = transactionReportingEffect(tx, {
      splits: input.transactionSplits,
      refundAllocations: input.refundAllocations,
    });
    if (effect.reportDate < from || effect.reportDate > to) continue;
    const sign = tx.type === 'refund' ? -1 : 1;
    for (const row of effect.categoryRows) {
      const signed = sign < 0 ? D(row.amount).abs().negated().toString() : D(row.amount).abs().toString();
      addSpent(effect.reportAssetId, row.categoryId, signed);
      const parentId = categoryById.get(row.categoryId)?.parentId;
      if (parentId) addSpent(effect.reportAssetId, parentId, signed);
    }
  }

  const items: BudgetAlertItem[] = [];
  for (const budget of monthBudgets) {
    const plannedD = D(budget.plannedAmount);
    const spentD = sum(spentMap.get(`${budget.assetId}:${budget.category}`) ?? []);
    if (spentD.lte(0)) continue;
    const ratioD = safeDiv(spentD.mul(100), plannedD);
    if (ratioD.lt(warnPercent)) continue;
    const asset = assetById.get(budget.assetId);
    const decimals = asset?.decimals ?? 2;
    items.push({
      budgetId: budget.id,
      month,
      categoryId: budget.category,
      categoryName: categoryNames.get(budget.category) ?? budget.category,
      assetId: budget.assetId,
      assetCode: asset?.code ?? budget.assetId,
      symbol: asset?.symbol ?? '',
      plannedAmount: roundD(plannedD, decimals).toFixed(decimals),
      spentAmount: roundD(spentD, decimals).toFixed(decimals),
      usagePercent: roundD(ratioD, 1).toFixed(1),
      level: ratioD.gte(100) ? 'over' : 'warning',
    });
  }

  items.sort((a, b) => D(b.usagePercent).comparedTo(D(a.usagePercent)) || a.categoryName.localeCompare(b.categoryName, 'zh-CN'));
  return { month, warnPercent, items };
}

export type FixedAssetReminderKind = 'warranty' | 'maintenance' | 'return_deadline' | 'price_protection' | 'consumable';

export interface FixedAssetReminderItem {
  assetId: string;
  assetName: string;
  kind: FixedAssetReminderKind;
  label: string;
  detail: string;
  dueDate?: string;
  daysUntil?: number;
  remainingText?: string;
}

export interface FixedAssetReminderStatus {
  today: string;
  daysBefore: number;
  items: FixedAssetReminderItem[];
}

const INACTIVE_FIXED_STATUSES = new Set(['sold', 'disposed', 'scrapped', 'lost', 'retired']);

/**
 * Evaluates upcoming warranty / maintenance / return / price-protection deadlines
 * and low/depleted consumables across active physical items.
 */
export function evaluateFixedAssetReminders(input: {
  today: string;
  daysBefore: number;
  fixedAssets: FixedAsset[];
  consumables?: FixedAssetConsumable[];
  usageMetrics?: FixedAssetUsageMetric[];
  usageLogs?: FixedAssetUsageLog[];
}): FixedAssetReminderStatus {
  parseDay(input.today);
  const daysBefore = Math.max(0, Math.min(60, Math.floor(input.daysBefore)));
  const activeAssets = input.fixedAssets.filter((a) => !a.isDeleted && !INACTIVE_FIXED_STATUSES.has(a.status));
  const assetById = new Map(activeAssets.map((a) => [a.id, a]));
  const items: FixedAssetReminderItem[] = [];

  const dateChecks: Array<{ field: keyof Pick<FixedAsset, 'warrantyEndDate' | 'maintenanceDueDate' | 'returnDeadline' | 'priceProtectionDeadline'>; kind: FixedAssetReminderKind; label: string }> = [
    { field: 'warrantyEndDate', kind: 'warranty', label: '质保到期' },
    { field: 'maintenanceDueDate', kind: 'maintenance', label: '维保到期' },
    { field: 'returnDeadline', kind: 'return_deadline', label: '退货截止' },
    { field: 'priceProtectionDeadline', kind: 'price_protection', label: '价保截止' },
  ];

  for (const asset of activeAssets) {
    for (const check of dateChecks) {
      const dueDate = asset[check.field];
      if (!dueDate || !isValidDay(dueDate)) continue;
      const daysUntil = daysBetween(input.today, dueDate);
      if (daysUntil >= 0 && daysUntil <= daysBefore) {
        items.push({
          assetId: asset.id,
          assetName: asset.name,
          kind: check.kind,
          label: `${asset.name} · ${check.label}`,
          detail: `${check.label}日期 ${dueDate}`,
          dueDate,
          daysUntil,
        });
      }
    }
  }

  const metrics = (input.usageMetrics ?? []).filter((m) => !m.isDeleted);
  const logs = (input.usageLogs ?? []).filter((l) => !l.isDeleted);
  for (const con of (input.consumables ?? [])) {
    if (con.isDeleted) continue;
    if (con.status !== 'active') continue;
    const asset = assetById.get(con.fixedAssetId);
    if (!asset) continue;
    const remaining = fixedConsumableRemaining(con, metrics, logs);
    if (remaining === undefined) continue;
    const remD = D(remaining);
    const thresholdD = con.reminderAtRemaining ? D(con.reminderAtRemaining) : D(0);
    if (remD.lte(thresholdD)) {
      const metric = metrics.find((m) => m.id === con.usageMetricId);
      const unitLabel = metric ? fixedUsageUnitLabel(metric) : '';
      const remainingText = remD.lte(0)
        ? '已耗尽'
        : `剩余 ${roundD(remD, 1).toString()}${unitLabel ? ` ${unitLabel}` : ''}`;
      items.push({
        assetId: asset.id,
        assetName: asset.name,
        kind: 'consumable',
        label: `${asset.name} · 耗材 ${con.name}`,
        detail: `耗材余量预警${con.targetLife ? `（设计寿命 ${con.targetLife}${unitLabel ? ` ${unitLabel}` : ''}）` : ''}`,
        remainingText,
      });
    }
  }

  items.sort((a, b) => (a.daysUntil ?? -1) - (b.daysUntil ?? -1) || a.label.localeCompare(b.label, 'zh-CN'));
  return { today: input.today, daysBefore, items };
}
