/**
 * Game season P&L and reference balance (§4.6, §4.7, §29). Game currency is a
 * record flow — no stock check; the reference balance may go negative and is
 * informational only.
 */
import { D, safeDiv, sum } from './decimal.js';
import { daysBetween } from './dates.js';
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
  /** Settlement asset to sum over; when omitted, all settlement amounts are summed. */
  baseAssetId?: string;
  /** Override "today" for day counting (defaults to now). */
  asOf?: string;
}

export function seasonSummary(
  records: GameRecord[],
  season: GameSeason | undefined,
  opts: SeasonSummaryOptions = {},
): SeasonSummary {
  const active = records.filter(
    (r) =>
      !r.isDeleted &&
      (!opts.baseAssetId || !r.settlementAssetId || r.settlementAssetId === opts.baseAssetId),
  );

  let income = D(0);
  let expense = D(0);
  let fee = D(0);
  let refBalance = D(0);

  for (const r of active) {
    const settle = D(r.settlementAmount ?? 0).abs();
    if (INCOME_TYPES.has(r.recordType)) income = income.plus(settle);
    else if (EXPENSE_TYPES.has(r.recordType)) expense = expense.plus(settle);

    // Fees can be recorded either as their own record (type 'fee') or attached to
    // a record via feeAmount. Count both; the standalone-fee settle is already in
    // `expense` above, so only add the attached fee here.
    if (r.recordType === 'fee') fee = fee.plus(settle);
    if (r.feeAmount && !D(r.feeAmount).isZero()) {
      const f = D(r.feeAmount).abs();
      fee = fee.plus(f);
      expense = expense.plus(f);
    }

    const qty = D(r.gameCurrencyAmount ?? 0).abs();
    if (REF_ADD.has(r.recordType)) refBalance = refBalance.plus(qty);
    else if (REF_SUB.has(r.recordType)) refBalance = refBalance.minus(qty);
  }

  const net = income.minus(expense);
  const days = seasonDays(season, opts.asOf);
  const hours = D(season?.hours ?? 0);

  return {
    incomeBase: income.toString(),
    expenseBase: expense.toString(),
    feeBase: fee.toString(),
    netBase: net.toString(),
    days,
    hours: hours.toString(),
    perHour: safeDiv(net, hours).toString(),
    perDay: safeDiv(net, D(days)).toString(),
    referenceBalance: refBalance.toString(),
  };
}

/** Season length in days (inclusive of the start day, min 1). */
export function seasonDays(season: GameSeason | undefined, asOf?: string): number {
  if (!season?.startDate) return 0;
  const end = season.endDate ?? (asOf ?? new Date().toISOString().slice(0, 10));
  return Math.max(1, daysBetween(season.startDate, end) + 1);
}
