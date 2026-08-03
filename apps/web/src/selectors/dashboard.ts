/** Dashboard view-model — pure selector over a Snapshot (unit-tested). */
import {
  D, Decimal, isDateInRange, sum, traceChain, fixedAssetCost, remainingHoldings, gameRecordReportingPostings,
  nextUnhandledDcaOccurrence,
  isTransactionActive,
  isLotTrackedAssetType,
  type DateRange,
} from '@zichan/core';
import type { Snapshot } from '../db/snapshot.js';
import { balanceOfAsset, isZeroish } from '../db/derive.js';
import { categoryLabel } from '../transactionMeta.js';
import { createReportCurrency } from '../reportCurrency.js';
import { reportingEffect } from './transaction-effect.js';

export interface Alloc { name: string; note: string; value: string; weight: number }
export interface DashActivity { date: string; desc: string; type: string; detail: string; amt?: number }
export interface DcaReminderVM {
  id: string;
  name: string;
  target: string;
  amount: string;
  nextDate: string;
  daysLeft: number;
  state: 'overdue' | 'due' | 'ok' | 'manual';
  path: string;
}
export interface DashboardVM {
  alloc: Alloc[];
  netWorth: string;
  investedFiat: Decimal;
  unrealized: Decimal;
  realizedCrypto: Decimal;
  seasonNet: Decimal;
  fixedPerDay: Decimal;
  txIncome: Decimal;
  txExpense: Decimal;
  txNet: Decimal;
  asOf: string;
  reportCurrencyCode: string;
  missingRateAssetCodes: string[];
  incompleteMetrics: string[];
  dcaReminders: DcaReminderVM[];
  activity: DashActivity[];
}

const TYPE_LABEL: Record<string, string> = {
  dca: '定投执行', buy: '买入', sell: '卖出', exchange: '换汇', deposit: '入金', withdraw: '提现',
};

const defaultAsOf = () => new Date().toLocaleDateString('en-CA');

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000);
}

export function buildDashboard(snap: Snapshot, selectedRange?: DateRange): DashboardVM {
  const asOf = snap.setting?.asOfDate ?? defaultAsOf();
  const codeOf = (id: string) => snap.assets.find((a) => a.id === id)?.code ?? id;
  const report = createReportCurrency(snap, asOf);
  const incompleteMetrics = new Set<string>();
  const converted = (metric: string, value: string | Decimal, assetId: string, date?: string): Decimal | undefined => {
    const result = date ? report.convertAt(value, assetId, date) : report.convert(value, assetId);
    if (result.status === 'missing_rate') {
      incompleteMetrics.add(metric);
      return undefined;
    }
    return result.amount;
  };
  const inSelectedRange = (date: string) => !selectedRange || isDateInRange(date, selectedRange);
  const activeChain = (row: Snapshot['chains'][number]) => row.chain.recordState !== 'voided';
  // Market positions come from lots (authoritative cost/holding ledger);
  // fiat/stablecoin come from posting balances.
  const holdingsOf = (assetType: string, assetId: string) =>
    isLotTrackedAssetType(assetType as Snapshot['assets'][number]['type'])
      ? remainingHoldings(snap.lots, assetId)
      : balanceOfAsset(snap, assetId);

  const financial: Alloc[] = [];
  for (const a of snap.assets) {
    if (a.type === 'game' || a.type === 'fixed') continue;
    const amt = D(holdingsOf(a.type, a.id));
    if (amt.abs().lt('0.0000001')) continue;
    const value = converted('netWorth', amt, a.id);
    if (!value) continue;
    financial.push({
      name: a.type === 'fiat' ? '法币现金' : a.code,
      note: a.type === 'fiat' ? '现金余额' : `${amt.toDecimalPlaces(a.decimals)} ${a.code}`,
      value: value.toString(),
      weight: 0,
    });
  }
  const fixedValues: Decimal[] = [];
  for (const fixed of snap.fixedAssets.filter((row) => row.status === 'active' || row.status === 'stored')) {
    const value = converted(
      'netWorth',
      fixedAssetCost(fixed, snap.fixedEvents, { asOf, usageMetrics: snap.fixedUsageMetrics, usageLogs: snap.fixedUsageLogs, consumables: snap.fixedConsumables }).currentResidual ?? '0',
      fixed.baseCurrencyAssetId,
    );
    if (value) fixedValues.push(value);
  }
  const fixedValue = sum(fixedValues);
  const alloc: Alloc[] = [...financial];
  if (fixedValue.isPositive()) {
    alloc.push({ name: '物品资产', note: '在用及收纳物品现状残值', value: fixedValue.toString(), weight: 0 });
  }
  const total = sum(alloc.map((a) => a.value));
  const netWorthComplete = !incompleteMetrics.has('netWorth');
  for (const a of alloc) a.weight = !netWorthComplete || total.isZero() ? 0 : D(a.value).div(total).toNumber();
  alloc.sort((a, b) => D(b.value).minus(D(a.value)).toNumber());

  const investedFiat = sum(snap.chains
    .filter((c) => activeChain(c) && (c.chain.type === 'dca' || c.chain.type === 'buy') && inSelectedRange(c.chain.date))
    .map((c) => converted('investedFiat', traceChain(c).totalBaseCost, c.chain.baseCurrencyAssetId, c.chain.date))
    .filter((value): value is Decimal => value !== undefined));
  let unrealized = D(0);
  for (const a of snap.assets.filter((x) => isLotTrackedAssetType(x.type))) {
    const amt = D(remainingHoldings(snap.lots, a.id));
    const value = converted('unrealized', amt, a.id);
    if (!value || amt.isZero()) continue;
    let cost = D(0);
    let costKnown = true;
    for (const lot of snap.lots.filter((row) => row.assetId === a.id && !row.isDeleted && D(row.remainingAmount).gt(0))) {
      if (D(lot.originalAmount).isZero()) continue;
      const openCost = D(lot.baseCost).times(D(lot.remainingAmount).div(lot.originalAmount));
      const convertedCost = converted('unrealized', openCost, lot.baseCurrencyAssetId);
      if (!convertedCost) costKnown = false;
      else cost = cost.plus(convertedCost);
    }
    if (costKnown) unrealized = unrealized.plus(value.minus(cost));
  }
  const realizedCrypto = sum(snap.chains
    .filter((c) => activeChain(c) && c.chain.type === 'sell' && inSelectedRange(c.chain.date))
    .map((c) => converted('realizedCrypto', c.chain.realizedGainLoss ?? '0', c.chain.baseCurrencyAssetId, c.chain.date))
    .filter((value): value is Decimal => value !== undefined));
  const seasonValues: Decimal[] = [];
  for (const record of snap.gameRecords.filter((row) => inSelectedRange(row.date))) {
    for (const posting of gameRecordReportingPostings(record)) {
      const value = converted('seasonNet', posting.amount, posting.assetId, record.date);
      if (value) seasonValues.push(value);
    }
  }
  const seasonNet = sum(seasonValues);
  const fixedPerDay = sum(snap.fixedAssets
    .filter((f) => f.status === 'active')
    .map((f) => converted(
      'fixedPerDay',
      fixedAssetCost(f, snap.fixedEvents, { asOf, usageMetrics: snap.fixedUsageMetrics, usageLogs: snap.fixedUsageLogs, consumables: snap.fixedConsumables }).perDay,
      f.baseCurrencyAssetId,
    ))
    .filter((value): value is Decimal => value !== undefined));
  const txRows = snap.transactions.filter((t) => {
    if (!isTransactionActive(t)) return false;
    const date = reportingEffect(snap, t).reportDate;
    return selectedRange ? isDateInRange(date, selectedRange) : date.slice(0, 7) === asOf.slice(0, 7);
  });
  const incomeValues: Decimal[] = [];
  const expenseValues: Decimal[] = [];
  for (const transaction of txRows) {
    const effect = reportingEffect(snap, transaction);
    if (!D(effect.incomeDelta).isZero()) {
      const value = converted('transactions', effect.incomeDelta, effect.reportAssetId, effect.reportDate);
      if (value) incomeValues.push(value);
    }
    if (!D(effect.expenseDelta).isZero()) {
      const value = converted('transactions', effect.expenseDelta, effect.reportAssetId, effect.reportDate);
      if (value) expenseValues.push(value);
    }
  }
  const txIncome = sum(incomeValues);
  const txExpense = sum(expenseValues);
  const txNet = txIncome.minus(txExpense);

  const dcaReminders = (snap.dcaPlans ?? [])
    .filter((p) => p.status === 'active')
    .map((p): DcaReminderVM => {
      if (p.frequency === 'manual') {
        return {
          id: p.id, name: p.name, target: codeOf(p.targetAssetId),
          amount: `${p.plannedAmount} ${codeOf(p.baseCurrencyAssetId)}`,
          nextDate: '手动', daysLeft: 0, state: 'manual', path: p.defaultPath ?? '',
        };
      }
      const occurrence = nextUnhandledDcaOccurrence(p, snap.dcaExecutions);
      const next = occurrence?.date ?? asOf;
      const daysLeft = daysBetween(asOf, next);
      const threshold = p.reminderDaysBefore ?? 3;
      return {
        id: p.id, name: p.name, target: codeOf(p.targetAssetId),
        amount: `${p.plannedAmount} ${codeOf(p.baseCurrencyAssetId)}`,
        nextDate: next, daysLeft,
        state: daysLeft < 0 ? 'overdue' : daysLeft <= threshold ? 'due' : 'ok',
        path: p.defaultPath ?? '',
      };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft);

  const evs: DashActivity[] = [];
  for (const c of snap.chains.filter(activeChain)) {
    if (!inSelectedRange(c.chain.date)) continue;
    const t = traceChain(c);
    const isSell = c.chain.type === 'sell';
    const nativeValue = isSell ? t.totalBaseProceeds : t.totalBaseCost;
    const reportValue = converted('activity', nativeValue, c.chain.baseCurrencyAssetId, c.chain.date);
    const amt = reportValue ? (isSell || c.chain.type === 'deposit' ? reportValue.toNumber() : reportValue.negated().toNumber()) : undefined;
    evs.push({
      date: c.chain.date, desc: c.chain.title ?? c.chain.type,
      type: TYPE_LABEL[c.chain.type] ?? c.chain.type,
      detail: isSell
        ? `到账 ${report.formatNative(t.totalBaseProceeds, c.chain.baseCurrencyAssetId)}`
        : `${c.chain.type === 'deposit' ? '入金' : '成本'} ${report.formatNative(t.totalBaseCost, c.chain.baseCurrencyAssetId)}`,
      amt,
    });
  }
  for (const r of snap.gameRecords) {
    if (!inSelectedRange(r.date)) continue;
    if (isZeroish(r.settlementAmount ?? '0')) continue;
    const postingValues = gameRecordReportingPostings(r).map((posting) => converted('activity', posting.amount, posting.assetId, r.date));
    const reportNet = postingValues.some((value) => value === undefined)
      ? undefined
      : sum(postingValues as Decimal[]);
    const game = snap.games.find((row) => row.id === r.gameId);
    const native = r.settlementAssetId && r.settlementAmount
      ? report.formatNative(r.settlementAmount, r.settlementAssetId)
      : '';
    evs.push({
      date: r.date, desc: r.note ?? r.recordType, type: '游戏',
      detail: [game?.name ?? '游戏记录', native].filter(Boolean).join(' · '),
      amt: reportNet?.toNumber(),
    });
  }
  for (const t of snap.transactions.filter(isTransactionActive)) {
    const effect = reportingEffect(snap, t);
    if (!inSelectedRange(effect.cashDate)) continue;
    const base = converted('activity', effect.cashAmount, effect.cashAssetId, effect.cashDate);
    const label = t.type === 'transfer' ? '转账' : t.type === 'adjustment' ? '对账余额调整' : categoryLabel(t.category, snap.categories);
    const activityType = t.type === 'transfer' ? '转账'
      : t.type === 'income' ? '日常收入'
        : t.type === 'refund' ? '日常退款'
          : t.type === 'adjustment' ? '余额调整' : '日常支出';
    evs.push({
      date: effect.cashDate,
      desc: t.description ?? t.merchant ?? label,
      type: activityType,
      detail: t.merchant ?? label,
      amt: base?.toNumber(),
    });
  }
  evs.sort((a, b) => b.date.localeCompare(a.date));

  return {
    alloc, netWorth: total.toString(),
    investedFiat, unrealized, realizedCrypto, seasonNet, fixedPerDay,
    txIncome, txExpense, txNet,
    asOf, reportCurrencyCode: report.code, missingRateAssetCodes: report.missingCodes(),
    incompleteMetrics: [...incompleteMetrics].sort(), dcaReminders,
    activity: evs.slice(0, 6),
  };
}
