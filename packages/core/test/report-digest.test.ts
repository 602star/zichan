import { describe, expect, it } from 'vitest';
import {
  buildLedgerReportDigest,
  dailyReportPeriods,
  detectSalaryPaydayDates,
  evaluateBillDueReminders,
  evaluateBudgetAlerts,
  evaluateCalendarReminders,
  evaluateDcaReminders,
  evaluateFixedAssetReminders,
  evaluateInactivityReminder,
  isMonthlyReportDueDay,
  monthlyReportPeriods,
  paydayAnchorForMonth,
  smartPaydayReportPeriods,
  weeklyReportPeriods,
  type Account,
  type Asset,
  type BudgetCategory,
  type CalendarEntry,
  type Category,
  type DcaExecution,
  type DcaPlan,
  type FixedAsset,
  type FixedAssetConsumable,
  type FixedAssetUsageLog,
  type FixedAssetUsageMetric,
  type Transaction,
} from '../src/index.js';

const baseMeta = {
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 1,
  isDeleted: false,
};

const cny: Asset = { ...baseMeta, id: 'asset-cny', code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, symbol: '¥', isActive: true };
const usd: Asset = { ...baseMeta, id: 'asset-usd', code: 'USD', name: '美元', type: 'fiat', decimals: 2, symbol: '$', isActive: true };
const categories: Category[] = [
  { ...baseMeta, id: 'cat-food', name: '餐饮', kind: 'expense' },
  { ...baseMeta, id: 'cat-rent', name: '房租', kind: 'expense' },
  { ...baseMeta, id: 'cat-salary', name: '工资', kind: 'income' },
];

function makeTx(partial: Partial<Transaction> & { id: string; date: string; type: Transaction['type']; amount: string }): Transaction {
  return {
    ...baseMeta,
    assetId: 'asset-cny',
    category: partial.type === 'income' ? 'cat-salary' : 'cat-food',
    ...partial,
  };
}

describe('report period calculations (daily / weekly / calendar & payday monthly)', () => {
  it('computes daily and weekly periods cleanly', () => {
    const daily = dailyReportPeriods('2026-11-27');
    expect(daily.period).toMatchObject({ from: '2026-11-27', to: '2026-11-27', periodKey: 'daily:2026-11-27' });
    expect(daily.previousPeriod).toMatchObject({ from: '2026-11-26', to: '2026-11-26' });

    const weekly = weeklyReportPeriods('2026-11-27', 'completed');
    expect(weekly.period).toMatchObject({ from: '2026-11-16', to: '2026-11-22', periodKey: 'weekly:2026-11-16' });
    expect(weekly.previousPeriod).toMatchObject({ from: '2026-11-09', to: '2026-11-15' });
  });

  it('computes calendar month periods', () => {
    const completed = monthlyReportPeriods('2026-11-01', { mode: 'calendar', target: 'completed' });
    expect(completed.period).toMatchObject({ from: '2026-10-01', to: '2026-10-31', periodKey: 'monthly:calendar:2026-10' });
    expect(completed.previousPeriod).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(isMonthlyReportDueDay('2026-11-01', 'calendar')).toBe(true);
    expect(isMonthlyReportDueDay('2026-11-02', 'calendar')).toBe(false);
  });

  it('computes payday month periods without overlap or gap (e.g. 10th to next 9th)', () => {
    const onPayday = monthlyReportPeriods('2026-11-10', { mode: 'payday', paydayDay: 10, target: 'completed' });
    expect(onPayday.period).toMatchObject({
      from: '2026-10-10',
      to: '2026-11-09',
      periodKey: 'monthly:payday:10:2026-10-10',
    });
    expect(onPayday.previousPeriod).toMatchObject({
      from: '2026-09-10',
      to: '2026-10-09',
    });

    const current = monthlyReportPeriods('2026-11-10', { mode: 'payday', paydayDay: 10, target: 'current' });
    expect(current.period).toMatchObject({ from: '2026-11-10', to: '2026-12-09' });

    expect(isMonthlyReportDueDay('2026-11-10', 'payday', 10)).toBe(true);
    expect(isMonthlyReportDueDay('2026-11-09', 'payday', 10)).toBe(false);
  });

  it('clamps payday anchor on short months (31st in February and year rollover)', () => {
    expect(paydayAnchorForMonth(2026, 2, 31)).toBe('2026-02-28');
    expect(paydayAnchorForMonth(2024, 2, 31)).toBe('2024-02-29');
    expect(isMonthlyReportDueDay('2026-02-28', 'payday', 31)).toBe(true);

    const febCycle = monthlyReportPeriods('2026-02-28', { mode: 'payday', paydayDay: 31, target: 'completed' });
    expect(febCycle.period).toMatchObject({ from: '2026-01-31', to: '2026-02-27' });
    expect(febCycle.previousPeriod).toMatchObject({ from: '2025-12-31', to: '2026-01-30' });
  });

  it('auto-detects smart payday cycles from salary income entries and clusters split payrolls within 15 days', () => {
    const txs: Transaction[] = [
      makeTx({ id: 's1', date: '2026-09-10', type: 'income', amount: '12000', category: 'salary' }),
      // Oct 10 fell on Saturday -> paid early on Oct 9, plus performance salary on Oct 12 (same cycle!)
      makeTx({ id: 's2', date: '2026-10-09', type: 'income', amount: '12000', category: 'salary' }),
      makeTx({ id: 's2b', date: '2026-10-12', type: 'income', amount: '2000', category: 'performance_salary' }),
      // Nov salary recorded on Nov 10 under custom category named "工资"
      makeTx({ id: 's3', date: '2026-11-10', type: 'income', amount: '12000', category: 'cat-salary' }),
      // Ordinary non-salary expense ignored
      makeTx({ id: 'e1', date: '2026-10-20', type: 'expense', amount: '100', category: 'cat-food' }),
    ];

    expect(detectSalaryPaydayDates(txs, categories, { upToDay: '2026-11-10' })).toEqual([
      '2026-09-10',
      '2026-10-09',
      '2026-11-10',
    ]);

    const completed = smartPaydayReportPeriods('2026-11-10', txs, categories, { target: 'completed' });
    expect(completed?.period).toMatchObject({
      mode: 'payday_auto',
      from: '2026-10-09',
      to: '2026-11-09',
      periodKey: 'monthly:payday_auto:2026-10-09:2026-11-10',
    });
    expect(completed?.previousPeriod).toMatchObject({
      from: '2026-09-10',
      to: '2026-10-08',
    });

    // Only one salary entry so far -> no completed cycle yet
    expect(smartPaydayReportPeriods('2026-09-20', txs, categories, { target: 'completed' })).toBeNull();
  });
});

describe('buildLedgerReportDigest', () => {
  it('aggregates income, net expense after refunds, delta, top categories, and separates secondary currencies', () => {
    const { period, previousPeriod } = monthlyReportPeriods('2026-11-10', { mode: 'payday', paydayDay: 10, target: 'completed' });
    const transactions: Transaction[] = [
      makeTx({ id: 't1', date: '2026-10-10', type: 'income', amount: '10000.00', category: 'cat-salary' }),
      makeTx({ id: 't2', date: '2026-10-12', type: 'expense', amount: '3200.50', category: 'cat-rent', note: '10月房租' }),
      makeTx({ id: 't3', date: '2026-10-15', type: 'expense', amount: '120.25', category: 'cat-food', note: '聚餐' }),
      makeTx({ id: 't4', date: '2026-10-16', type: 'refund', amount: '20.25', category: 'cat-food', refundEffectDate: '2026-10-15' }),
      makeTx({ id: 't5', date: '2026-10-20', type: 'expense', amount: '50.00', assetId: 'asset-usd', category: 'cat-food' }),
      // Previous payday period (2026-09-10 .. 2026-10-09)
      makeTx({ id: 't6', date: '2026-09-15', type: 'expense', amount: '2000.00', category: 'cat-rent' }),
      // Voided / deleted should be ignored
      makeTx({ id: 't7', date: '2026-10-18', type: 'expense', amount: '9999.00', recordState: 'voided' }),
    ];

    const digest = buildLedgerReportDigest({
      kind: 'monthly',
      period,
      previousPeriod,
      transactions,
      categories,
      assets: [cny, usd],
      baseCurrencyAssetId: 'asset-cny',
    });

    expect(digest.isEmpty).toBe(false);
    expect(digest.totalTransactionCount).toBe(5);
    expect(digest.primaryCurrency.income).toBe('10000.00');
    expect(digest.primaryCurrency.expense).toBe('3300.50');
    expect(digest.primaryCurrency.net).toBe('6699.50');
    expect(digest.primaryCurrency.savingsRatePercent).toBe('67.0');
    expect(digest.primaryCurrency.previousExpense).toBe('2000.00');
    expect(digest.primaryCurrency.expenseDelta).toBe('1300.50');
    expect(digest.primaryCurrency.expenseDeltaPercent).toBe('65.0');
    expect(digest.primaryCurrency.topCategories[0]).toMatchObject({ categoryName: '房租', amount: '3200.50' });
    expect(digest.primaryCurrency.topCategories[1]).toMatchObject({ categoryName: '餐饮', amount: '100.00' });
    expect(digest.otherCurrencies).toHaveLength(1);
    expect(digest.otherCurrencies[0]).toMatchObject({ assetCode: 'USD', expense: '50.00' });
  });
});

describe('evaluateInactivityReminder', () => {
  it('triggers when latest active transaction is at least thresholdDays old', () => {
    const txs: Transaction[] = [
      makeTx({ id: 't1', date: '2026-11-24', type: 'expense', amount: '10' }),
      makeTx({ id: 't2', date: '2026-11-26', type: 'expense', amount: '10', isDeleted: true }),
      makeTx({ id: 't3', date: '2026-12-01', type: 'expense', amount: '10' }), // future transaction ignored
    ];

    const due = evaluateInactivityReminder({ today: '2026-11-27', thresholdDays: 3, transactions: txs });
    expect(due).toMatchObject({
      shouldRemind: true,
      lastTransactionDate: '2026-11-24',
      daysSinceLastTransaction: 3,
    });

    const notDue = evaluateInactivityReminder({ today: '2026-11-26', thresholdDays: 3, transactions: txs });
    expect(notDue.shouldRemind).toBe(false);

    const empty = evaluateInactivityReminder({ today: '2026-11-27', thresholdDays: 3, transactions: [] });
    expect(empty.shouldRemind).toBe(false);
    expect(empty.daysSinceLastTransaction).toBeNull();
  });
});

describe('bill due, DCA, and calendar reminders', () => {
  it('detects credit card / loan payment due dates within daysBefore (including month rollover)', () => {
    const accounts: Account[] = [
      { ...baseMeta, id: 'cc-1', name: '招行信用卡', kind: 'credit_card', statementDay: 10, paymentDueDay: 28, isActive: true },
      { ...baseMeta, id: 'cc-2', name: '工行房贷', kind: 'loan', paymentDueDay: 1, isActive: true },
      { ...baseMeta, id: 'cc-3', name: '建行信用卡', kind: 'credit_card', paymentDueDay: 15, isActive: true },
    ];
    const result = evaluateBillDueReminders({ today: '2026-11-27', daysBefore: 4, accounts });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ accountName: '招行信用卡', dueDate: '2026-11-28', daysUntil: 1 });
    expect(result.items[1]).toMatchObject({ accountName: '工行房贷', dueDate: '2026-12-01', daysUntil: 4 });
  });

  it('detects upcoming and overdue unhandled DCA plan occurrences', () => {
    const btc: Asset = { ...baseMeta, id: 'asset-btc', code: 'BTC', name: '比特币', type: 'crypto', decimals: 8, isActive: true };
    const plans: DcaPlan[] = [
      {
        ...baseMeta, id: 'dca-1', name: '每周定投 BTC', targetAssetId: 'asset-btc', baseCurrencyAssetId: 'asset-cny',
        anchorDate: '2026-11-14', anchorMode: 'calendar_day', timezone: 'Asia/Shanghai', frequency: 'weekly',
        plannedAmount: '500.00', status: 'active',
      },
    ];
    const executions: DcaExecution[] = [
      {
        ...baseMeta, id: 'exec-0', planId: 'dca-1', occurrenceIndex: 0, scheduledDate: '2026-11-14', date: '2026-11-14',
        plannedAmount: '500.00', actualBaseCost: '500.00', finalAmount: '0.001', totalFeeInBase: '0',
        baseCurrencyAssetId: 'asset-cny', finalAssetId: 'asset-btc',
      },
      {
        ...baseMeta, id: 'exec-1', planId: 'dca-1', occurrenceIndex: 1, scheduledDate: '2026-11-21', date: '2026-11-21',
        plannedAmount: '500.00', actualBaseCost: '500.00', finalAmount: '0.001', totalFeeInBase: '0',
        baseCurrencyAssetId: 'asset-cny', finalAssetId: 'asset-btc',
      },
    ];
    const result = evaluateDcaReminders({
      today: '2026-11-27', daysBefore: 2, dcaPlans: plans, dcaExecutions: executions, assets: [cny, btc],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      planName: '每周定投 BTC',
      scheduledDate: '2026-11-28',
      daysUntil: 1,
      plannedAmount: '500.00',
      targetAssetCode: 'BTC',
    });
  });

  it('detects upcoming solar and lunar birthdays/anniversaries within daysBefore', () => {
    const entries: CalendarEntry[] = [
      {
        ...baseMeta, id: 'cal-1', title: '妈妈生日', kind: 'birthday', startDate: '2020-11-29', endDate: '2020-11-29',
        allDay: true, timezone: 'Asia/Shanghai', calendar: 'solar', leapPolicy: 'regular', missingDayPolicy: 'last_day',
        repeat: 'yearly', interval: 1, birthYear: 1970,
      },
      {
        ...baseMeta, id: 'cal-2', title: '结婚纪念日', kind: 'anniversary', startDate: '2022-12-20', endDate: '2022-12-20',
        allDay: true, timezone: 'Asia/Shanghai', calendar: 'solar', leapPolicy: 'regular', missingDayPolicy: 'last_day',
        repeat: 'yearly', interval: 1,
      },
    ];
    const result = evaluateCalendarReminders({ today: '2026-11-27', daysBefore: 3, entries });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      title: '妈妈生日',
      kind: 'birthday',
      date: '2026-11-29',
      daysUntil: 2,
      age: 56,
    });
  });

  it('triggers budget alerts at 80% warning and 100% overrun (rolling up child categories)', () => {
    const parentFood: Category = { ...baseMeta, id: 'cat-food-root', name: '餐饮总类', type: 'expense' };
    const childLunch: Category = { ...baseMeta, id: 'cat-lunch', name: '午餐', type: 'expense', parentId: 'cat-food-root' };
    const budgets: BudgetCategory[] = [
      { ...baseMeta, id: 'b-food', month: '2026-11', category: 'cat-food-root', plannedAmount: '1000.00', assetId: 'asset-cny', rolloverMode: 'none' },
      { ...baseMeta, id: 'b-rent', month: '2026-11', category: 'cat-rent', plannedAmount: '3000.00', assetId: 'asset-cny', rolloverMode: 'none' },
    ];
    const txs: Transaction[] = [
      makeTx({ id: 't1', date: '2026-11-05', type: 'expense', amount: '850.00', category: 'cat-lunch' }),
      makeTx({ id: 't2', date: '2026-11-10', type: 'expense', amount: '3200.00', category: 'cat-rent' }),
    ];
    const status = evaluateBudgetAlerts({
      today: '2026-11-27',
      warnPercent: 80,
      budgetCategories: budgets,
      transactions: txs,
      categories: [...categories, parentFood, childLunch],
      assets: [cny],
    });
    expect(status.items).toHaveLength(2);
    expect(status.items[0]).toMatchObject({ categoryId: 'cat-rent', usagePercent: '106.7', level: 'over' });
    expect(status.items[1]).toMatchObject({ categoryId: 'cat-food-root', usagePercent: '85.0', level: 'warning' });
  });

  it('detects expiring warranties/maintenance and low-remaining consumables on active fixed assets', () => {
    const fixedAssets: FixedAsset[] = [
      {
        ...baseMeta, id: 'fa-1', name: '空气净化器', categoryId: 'appliance', status: 'in_use',
        purchaseDate: '2025-11-30', baseCurrencyAssetId: 'asset-cny', warrantyEndDate: '2026-11-30',
      } as FixedAsset,
      {
        ...baseMeta, id: 'fa-sold', name: '旧手机', categoryId: 'digital', status: 'sold',
        purchaseDate: '2024-01-01', baseCurrencyAssetId: 'asset-cny', warrantyEndDate: '2026-11-28',
      } as FixedAsset,
    ];
    const metrics: FixedAssetUsageMetric[] = [
      { ...baseMeta, id: 'm-hours', fixedAssetId: 'fa-1', name: '运行时长', unit: 'hours', initialValue: '0' } as FixedAssetUsageMetric,
    ];
    const logs: FixedAssetUsageLog[] = [
      { ...baseMeta, id: 'l-1', fixedAssetId: 'fa-1', metricId: 'm-hours', date: '2026-11-20', value: '920' } as FixedAssetUsageLog,
    ];
    const consumables: FixedAssetConsumable[] = [
      {
        ...baseMeta, id: 'con-1', fixedAssetId: 'fa-1', name: 'HEPA 滤芯', amountBase: '199', cashflowMode: 'none',
        purchaseDate: '2026-01-01', installedDate: '2026-01-01', usageMetricId: 'm-hours', installedAtUsage: '0',
        targetLife: '1000', reminderAtRemaining: '100', status: 'active',
      } as FixedAssetConsumable,
    ];
    const status = evaluateFixedAssetReminders({
      today: '2026-11-27', daysBefore: 7, fixedAssets, consumables, usageMetrics: metrics, usageLogs: logs,
    });
    expect(status.items).toHaveLength(2);
    expect(status.items.some((i) => i.kind === 'warranty' && i.daysUntil === 3)).toBe(true);
    expect(status.items.some((i) => i.kind === 'consumable' && i.remainingText?.includes('80'))).toBe(true);
  });
});
