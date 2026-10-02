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
  'buy_equipment',
  'buy_material',
  'topup',
  'account_cost',
  'boosting_cost',
  'fee',
  'other_expense',
]);
// Selling equipment/material for game currency adds to the reference balance;
// selling that currency for cash later subtracts it.
const REF_ADD = new Set<GameRecordType>(['buy_currency', 'produce', 'sell_equipment', 'sell_material', 'other_income']);
const REF_SUB = new Set<GameRecordType>([
  'sell_currency',
  'consume',
  'buy_equipment',
  'buy_material',
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
  /** Present only when the records contain at most one currency. */
  referenceBalance: string | null;
  referenceBalances: { currencyName: string; balance: string }[];
}

export interface SeasonSummaryOptions {
  /** Asset to sum over; omission is allowed only for a single financial asset. */
  baseAssetId?: string;
  /** Override "today" for day counting (defaults to now). */
  asOf?: string;
}

/** Historical trade and net currency per quote unit; valuation never creates cash P&L. */
export function gameRecordExchangeRate(record: GameRecord): { rate: string; netRate?: string; netRateLabel?: string; quoteAssetId: string; valuation: string } | undefined {
  const quantity = D(record.gameCurrencyAmount ?? 0).abs();
  if (quantity.isZero()) return undefined;
  const cashTrade = record.recordType === 'buy_currency' || record.recordType === 'sell_currency';
  const hasCash = cashTrade && record.settlementAssetId && D(record.settlementAmount ?? 0).gt(0);
  const quoteAssetId = hasCash ? record.settlementAssetId : record.rateAssetId;
  if (!quoteAssetId) return undefined;
  const rate = hasCash
    ? quantity.div(D(record.settlementAmount!).abs())
    : D(record.manualRate ?? 0);
  if (!rate.gt(0)) return undefined;
  const fee = D(record.gameCurrencyFeeAmount ?? 0).abs();
  let netQuantity = quantity;
  let netRateLabel: string | undefined;
  if (cashTrade && fee.gt(0)) {
    if (record.recordType === 'buy_currency') {
      netQuantity = quantity.minus(fee);
      netRateLabel = '到账汇率';
    } else if (record.sellCurrencyFeeMode === 'included') {
      netQuantity = quantity.minus(fee);
      netRateLabel = '扣费后兑换汇率';
    } else {
      netQuantity = quantity.plus(fee);
      netRateLabel = '实际扣币汇率';
    }
  }
  return {
    rate: rate.toString(),
    netRate: hasCash && netRateLabel && netQuantity.gt(0)
      ? netQuantity.div(D(record.settlementAmount!).abs()).toString() : undefined,
    netRateLabel,
    quoteAssetId,
    valuation: hasCash ? D(record.settlementAmount!).abs().toString() : quantity.div(rate).toString(),
  };
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
    referenceBalances: activity.referenceBalances,
  };
}

/** Non-financial activity, independent of settlement/fee currency selection. */
export function seasonActivitySummary(
  records: GameRecord[], season: GameSeason | undefined, asOf?: string,
): Pick<SeasonSummary, 'days' | 'hours' | 'referenceBalance' | 'referenceBalances'> {
  const balances = new Map<string, { currencyName: string; amount: ReturnType<typeof D> }>();
  for (const record of records) {
    if (record.isDeleted) continue;
    const quantity = D(record.gameCurrencyAmount ?? 0).abs();
    const fee = D(record.gameCurrencyFeeAmount ?? 0).abs();
    if (quantity.isZero() && fee.isZero()) continue;
    const currencyName = record.gameCurrencyName?.trim().normalize('NFKC') || '未命名游戏币';
    const key = currencyName.toLocaleLowerCase();
    const current = balances.get(key) ?? { currencyName, amount: D(0) };
    let delta = D(0);
    if (REF_ADD.has(record.recordType)) delta = delta.plus(quantity);
    else if (REF_SUB.has(record.recordType)) delta = delta.minus(quantity);
    if (!(record.recordType === 'sell_currency' && record.sellCurrencyFeeMode === 'included')) delta = delta.minus(fee);
    balances.set(key, { ...current, amount: current.amount.plus(delta) });
  }
  const referenceBalances = [...balances.values()]
    .map(({ currencyName, amount }) => ({ currencyName, balance: amount.toString() }))
    .sort((a, b) => a.currencyName.localeCompare(b.currencyName, 'zh-CN'));
  return {
    days: seasonDays(season, asOf),
    hours: D(season?.hours ?? 0).toString(),
    referenceBalance: referenceBalances.length <= 1 ? referenceBalances[0]?.balance ?? '0' : null,
    referenceBalances,
  };
}

/** Season length in days (inclusive of the start day, min 1). */
export function seasonDays(season: GameSeason | undefined, asOf?: string): number {
  if (!season?.startDate) return 0;
  const end = season.endDate ?? asOf ?? localToday();
  return Math.max(1, daysBetween(season.startDate, end) + 1);
}
