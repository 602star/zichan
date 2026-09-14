/**
 * Game season P&L and reference balance (§4.6, §4.7, §29). Game currency is a
 * record flow — no stock check; the reference balance may go negative and is
 * informational only.
 */
import { D, safeDiv } from './decimal.js';
import { daysBetween, localToday } from './dates.js';
import type { GameRecord, GameRecordType, GameSeason } from './types.js';

const INCOME_TYPES = new Set<GameRecordType>([
  'sell_currency',
  'sell_equipment',
  'sell_material',
  'withdraw',
  'other_income',
]);
const EXPENSE_TYPES = new Set<GameRecordType>([
  'buy_currency',
  'topup',
  'account_cost',
  'boosting_cost',
  'fee',
  'other_expense',
]);
// Types that add to the reference currency balance (produce/buy add stock).
const REF_ADD = new Set<GameRecordType>(['buy_currency', 'produce', 'other_income']);
const REF_SUB = new Set<GameRecordType>([
  'sell_currency',
  'consume',
  'sell_equipment',
  'sell_material',
]);

export interface SeasonSummary {
  incomeBase: string; // settlement income (sells + other income)
  expenseBase: string; // buys + topups + costs + fees + other
  feeBase: string;
  netBase: string; // income - expense
  days: number;
  hours: string;
  perHour: string; // net / hours
  perDay: string; // net / days
  /** Reference game-currency balance (buy + produce − sell − consume). May be negative. */
  referenceBalance: string;
}

export interface SeasonSummaryOptions {
  /** Asset to sum over; omission is allowed only for a single financial asset. */
  baseAssetId?: string;
  /** Override "today" for day counting (defaults to now). */
  asOf?: string;
}

export function seasonSummary(
  records: GameRecord[],
  season: GameSeason | undefined,
  opts: SeasonSummaryOptions = {},
): SeasonSummary {
  const active = records.filter((r) => !r.isDeleted);
  const assets = new Set<string>();
  for (const record of active) {
    if ((INCOME_TYPES.has(record.recordType) || EXPENSE_TYPES.has(record.recordType))
      && !D(record.settlementAmount ?? 0).isZero()) {
      if (!record.settlementAssetId) throw new Error('结算金额缺少资产币种');
      assets.add(record.settlementAssetId);
    }
    if (record.recordType !== 'fee' && !D(record.feeAmount ?? 0).isZero()) {
      if (!record.feeAssetId) throw new Error('手续费金额缺少资产币种');
      assets.add(record.feeAssetId);
    }
  }
  if (opts.baseAssetId === undefined && assets.size > 1) {
    throw new Error('赛季金额包含多个币种，必须指定币种分别汇总');
  }
  const baseAssetId = opts.baseAssetId ?? [...assets][0];

  let income = D(0);
  let expense = D(0);
  let fee = D(0);

  for (const r of active) {
    const settle = r.settlementAssetId === baseAssetId ? D(r.settlementAmount ?? 0).abs() : D(0);
    if (INCOME_TYPES.has(r.recordType)) income = income.plus(settle);
    else if (EXPENSE_TYPES.has(r.recordType)) expense = expense.plus(settle);

    // Fees can be recorded either as their own record (type 'fee') or attached to
    // a record via feeAmount. Count both; the standalone-fee settle is already in
    // `expense` above, so only add the attached fee here. A standalone 'fee'
    // record must not also carry feeAmount — that would double-count the fee.
    if (r.recordType === 'fee') fee = fee.plus(settle);
    else if (r.feeAssetId === baseAssetId && r.feeAmount && !D(r.feeAmount).isZero()) {
      const f = D(r.feeAmount).abs();
      fee = fee.plus(f);
      expense = expense.plus(f);
    }

  }

  const net = income.minus(expense);
  const activity = seasonActivitySummary(active, season, opts.asOf);
  const { days } = activity;
  const hours = D(activity.hours);

  return {
    incomeBase: income.toString(),
    expenseBase: expense.toString(),
    feeBase: fee.toString(),
    netBase: net.toString(),
    days,
    hours: hours.toString(),
    perHour: safeDiv(net, hours).toString(),
    perDay: safeDiv(net, D(days)).toString(),
    referenceBalance: activity.referenceBalance,
  };
}

/** Non-financial activity, independent of settlement/fee currency selection. */
export function seasonActivitySummary(
  records: GameRecord[], season: GameSeason | undefined, asOf?: string,
): Pick<SeasonSummary, 'days' | 'hours' | 'referenceBalance'> {
  let balance = D(0);
  for (const record of records) {
    if (record.isDeleted) continue;
    const quantity = D(record.gameCurrencyAmount ?? 0).abs();
    if (REF_ADD.has(record.recordType)) balance = balance.plus(quantity);
    else if (REF_SUB.has(record.recordType)) balance = balance.minus(quantity);
  }
  return { days: seasonDays(season, asOf), hours: D(season?.hours ?? 0).toString(), referenceBalance: balance.toString() };
}

/** Season length in days (inclusive of the start day, min 1). */
export function seasonDays(season: GameSeason | undefined, asOf?: string): number {
  if (!season?.startDate) return 0;
  const end = season.endDate ?? asOf ?? localToday();
  return Math.max(1, daysBetween(season.startDate, end) + 1);
}
