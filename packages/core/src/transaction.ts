/**
 * Daily transaction calculations: category aggregation, monthly cash flow, trends.
 */
import { D, sum, safeDiv, type Numeric } from './decimal.js';
import type {
  RefundAllocation,
  Transaction,
  TransactionCategory,
  TransactionSplit,
} from './types.js';

const TRANSACTION_TYPES = new Set(['income', 'expense', 'transfer', 'refund', 'adjustment']);
const TRANSACTION_STATUSES = new Set(['pending', 'cleared']);
const TRANSACTION_RECORD_STATES = new Set(['active', 'voided']);
const ADJUSTMENT_DIRECTIONS = new Set(['increase', 'decrease']);
const REFUND_ATTRIBUTION_MODES = new Set(['original_date', 'refund_date']);
const REFUND_ALLOCATION_MODES = new Set(['proportional', 'specified']);
const TIME_PRECISIONS = new Set(['day', 'minute', 'second']);
const TIME_DISAMBIGUATIONS = new Set(['earlier', 'later']);
const REPORTING_TREATMENTS = new Set(['ordinary', 'balance_only']);

/**
 * Validate persisted transaction enum values at every write boundary. Reference,
 * amount and category checks remain in the database service layer.
 */
export function assertTransactionShape(transaction: Transaction): void {
  if (!TRANSACTION_TYPES.has(transaction.type)) throw new Error(`流水类型无效：${String(transaction.type)}`);
  if (transaction.status !== undefined && !TRANSACTION_STATUSES.has(transaction.status)) {
    throw new Error(`流水状态无效：${String(transaction.status)}`);
  }
  if (transaction.recordState !== undefined && !TRANSACTION_RECORD_STATES.has(transaction.recordState)) {
    throw new Error(`流水记录状态无效：${String(transaction.recordState)}`);
  }
  if (transaction.adjustmentDirection !== undefined && !ADJUSTMENT_DIRECTIONS.has(transaction.adjustmentDirection)) {
    throw new Error(`余额调整方向无效：${String(transaction.adjustmentDirection)}`);
  }
  if (transaction.refundAttributionMode !== undefined && !REFUND_ATTRIBUTION_MODES.has(transaction.refundAttributionMode)) {
    throw new Error(`退款归属模式无效：${String(transaction.refundAttributionMode)}`);
  }
  if (transaction.refundAllocationMode !== undefined && !REFUND_ALLOCATION_MODES.has(transaction.refundAllocationMode)) {
    throw new Error(`退款分配模式无效：${String(transaction.refundAllocationMode)}`);
  }
  if (transaction.timePrecision !== undefined && !TIME_PRECISIONS.has(transaction.timePrecision)) {
    throw new Error(`流水时间精度无效：${String(transaction.timePrecision)}`);
  }
  if (transaction.timeDisambiguation !== undefined && !TIME_DISAMBIGUATIONS.has(transaction.timeDisambiguation)) {
    throw new Error(`流水时间消歧模式无效：${String(transaction.timeDisambiguation)}`);
  }
  if (transaction.reportingTreatment !== undefined && !REPORTING_TREATMENTS.has(transaction.reportingTreatment)) {
    throw new Error(`流水报表口径无效：${String(transaction.reportingTreatment)}`);
  }
}

export function isTransactionActive(transaction: Transaction): boolean {
  return !transaction.isDeleted && transaction.recordState !== 'voided';
}

export function refundAppliedAmount(transaction: Transaction): string {
  return D(transaction.refundAppliedAmount ?? transaction.amount).abs().toString();
}

/** Signed cash/account movement; transfers are represented by two postings. */
export function transactionCashAmount(transaction: Transaction): string {
  if (transaction.type === 'transfer') return '0';
  if (transaction.type === 'adjustment') {
    return transaction.adjustmentDirection === 'decrease'
      ? D(transaction.amount).abs().negated().toString()
      : D(transaction.amount).abs().toString();
  }
  return transaction.type === 'expense'
    ? D(transaction.amount).abs().negated().toString()
    : D(transaction.amount).abs().toString();
}

/** Income contribution. Refunds never inflate income. */
export function transactionIncomeAmount(transaction: Transaction): string {
  return transaction.type === 'income' ? D(transaction.amount).abs().toString() : '0';
}

/** Net spending contribution: expense positive, refund negative. */
export function transactionExpenseAmount(transaction: Transaction): string {
  if (transaction.type === 'expense') return D(transaction.amount).abs().toString();
  if (transaction.type === 'refund') return D(refundAppliedAmount(transaction)).negated().toString();
  return '0';
}

export interface TransactionReportingCategoryRow {
  categoryId: string;
  amount: string;
  sourceSplitId?: string;
  categoryPathSnapshot?: string;
}

export interface TransactionReportingEffect {
  transactionId: string;
  cashDate: string;
  cashAssetId: string;
  cashAmount: string;
  reportDate: string;
  reportAssetId: string;
  incomeDelta: string;
  expenseDelta: string;
  categoryRows: TransactionReportingCategoryRow[];
}

/**
 * The single reporting interpretation for a transaction.
 *
 * Cash always occurs on the transaction's actual date and asset. A refund's
 * expense attribution uses the immutable snapshots captured when it was saved.
 */
export function transactionReportingEffect(
  transaction: Transaction,
  options: {
    splits?: TransactionSplit[];
    refundAllocations?: RefundAllocation[];
  } = {},
): TransactionReportingEffect {
  assertTransactionShape(transaction);
  const reportDate = transaction.type === 'refund'
    ? transaction.refundEffectDate ?? transaction.date
    : transaction.date;
  const reportAssetId = transaction.type === 'refund'
    ? transaction.refundAppliedAssetId ?? transaction.assetId
    : transaction.assetId;
  const reportAmount = transaction.type === 'refund'
    ? D(refundAppliedAmount(transaction)).abs()
    : D(transaction.amount).abs();
  const balanceOnly = transaction.reportingTreatment === 'balance_only';

  let categoryRows: TransactionReportingCategoryRow[] = [];
  if (balanceOnly) {
    categoryRows = [];
  } else if (transaction.type === 'refund') {
    const allocations = (options.refundAllocations ?? [])
      .filter((row) => !row.isDeleted && row.refundTransactionId === transaction.id);
    categoryRows = allocations.length
      ? allocations.map((row) => ({
        categoryId: row.categoryId,
        amount: D(row.amount).abs().toString(),
        sourceSplitId: row.sourceSplitId,
        categoryPathSnapshot: row.categoryPathSnapshot,
      }))
      : [{ categoryId: transaction.category, amount: reportAmount.toString() }];
  } else if (transaction.type === 'income' || transaction.type === 'expense') {
    const splits = (options.splits ?? [])
      .filter((row) => !row.isDeleted && row.transactionId === transaction.id);
    categoryRows = splits.length
      ? splits.map((row) => ({
        categoryId: row.category,
        amount: D(row.amount).abs().toString(),
        sourceSplitId: row.id,
      }))
      : [{ categoryId: transaction.category, amount: reportAmount.toString() }];
  }

  return {
    transactionId: transaction.id,
    cashDate: transaction.date,
    cashAssetId: transaction.assetId,
    cashAmount: transactionCashAmount(transaction),
    reportDate,
    reportAssetId,
    incomeDelta: !balanceOnly && transaction.type === 'income' ? reportAmount.toString() : '0',
    expenseDelta: !balanceOnly && transaction.type === 'expense'
      ? reportAmount.toString()
      : !balanceOnly && transaction.type === 'refund' ? reportAmount.negated().toString() : '0',
    categoryRows,
  };
}

// ───────────────── 按分类聚合 ─────────────────

export interface CategorySummary {
  category: TransactionCategory;
  totalAmount: string;
  count: number;
  avgAmount: string;
}

export interface TransactionAggregationOptions {
  baseAssetId?: string;
  splits?: TransactionSplit[];
  refundAllocations?: RefundAllocation[];
}

/**
 * 按分类聚合收支。
 * @param transactions - 待聚合的交易列表
 * @param opts - 可选: baseAssetId 用于筛选币种
 */
export function summarizeByCategory(
  transactions: Transaction[],
  opts: TransactionAggregationOptions = {},
): CategorySummary[] {
  const groups = new Map<TransactionCategory, { sum: Numeric[]; count: number }>();

  const active = transactions.filter(isTransactionActive);
  const effects = active.map((transaction) => transactionReportingEffect(transaction, opts));
  if (!opts.baseAssetId) {
    const assetIds = new Set(effects
      .filter((effect) => !D(effect.incomeDelta).isZero() || !D(effect.expenseDelta).isZero())
      .map((effect) => effect.reportAssetId));
    if (assetIds.size > 1) throw new Error(`禁止跨币种直接汇总：${[...assetIds].sort().join('、')}`);
  }
  for (const effect of effects) {
    if (opts.baseAssetId && effect.reportAssetId !== opts.baseAssetId) continue;
    const direction = D(effect.expenseDelta).isNegative() ? -1 : 1;
    for (const row of effect.categoryRows) {
      const key = row.categoryId;
      if (!groups.has(key)) groups.set(key, { sum: [], count: 0 });
      const g = groups.get(key)!;
      g.sum.push(D(row.amount).mul(direction));
      g.count += 1;
    }
  }

  return [...groups.entries()].map(([category, g]) => {
    const total = sum(g.sum);
    return {
      category,
      totalAmount: total.toString(),
      count: g.count,
      avgAmount: safeDiv(total, D(g.count)).toString(),
    };
  });
}

// ───────────────── 月度现金流 ─────────────────

export interface MonthlyCashFlow {
  month: string; // YYYY-MM
  income: string;
  expense: string;
  net: string; // income - expense
  transactionCount: number;
}

/**
 * 计算月度现金流(收入/支出/结余)。
 * @param transactions - 交易列表
 * @param opts - 可选: baseAssetId 筛选币种
 */
export function monthlyCashFlow(
  transactions: Transaction[],
  opts: TransactionAggregationOptions = {},
): MonthlyCashFlow[] {
  const groups = new Map<string, { income: Numeric[]; expense: Numeric[]; count: number }>();

  const active = transactions.filter(isTransactionActive);
  const effects = active.map((transaction) => transactionReportingEffect(transaction, opts));
  if (!opts.baseAssetId) {
    const assetIds = new Set(effects
      .filter((effect) => !D(effect.incomeDelta).isZero() || !D(effect.expenseDelta).isZero())
      .map((effect) => effect.reportAssetId));
    if (assetIds.size > 1) throw new Error(`禁止跨币种直接汇总：${[...assetIds].sort().join('、')}`);
  }
  for (const effect of effects) {
    if (opts.baseAssetId && effect.reportAssetId !== opts.baseAssetId) continue;
    if (D(effect.incomeDelta).isZero() && D(effect.expenseDelta).isZero()) continue;
    const month = effect.reportDate.slice(0, 7);
    if (!groups.has(month)) groups.set(month, { income: [], expense: [], count: 0 });
    const g = groups.get(month)!;
    g.income.push(effect.incomeDelta);
    g.expense.push(effect.expenseDelta);
    g.count += 1;
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, g]) => {
      const inc = sum(g.income);
      const exp = sum(g.expense);
      return {
        month,
        income: inc.toString(),
        expense: exp.toString(),
        net: inc.minus(exp).toString(),
        transactionCount: g.count,
      };
    });
}

// ───────────────── 分类趋势 ─────────────────

export interface CategoryTrend {
  month: string; // YYYY-MM
  amount: string;
  count: number;
}

/**
 * 计算某分类最近 N 月的趋势(用于图表)。
 * @param transactions - 交易列表
 * @param category - 目标分类
 * @param months - 月份数(默认 6)
 */
export function categoryTrend(
  transactions: Transaction[],
  category: TransactionCategory,
  opts: TransactionAggregationOptions & { months?: number } = {},
): CategoryTrend[] {
  const groups = new Map<string, { sum: Numeric[]; count: number }>();
  const active = transactions.filter((row) => isTransactionActive(row) && row.type !== 'transfer' && row.type !== 'adjustment');
  const effects = active.map((transaction) => transactionReportingEffect(transaction, opts));
  const assetIds = new Set(effects
    .filter((effect) => effect.categoryRows.some((row) => row.categoryId === category && !D(row.amount).isZero()))
    .map((effect) => effect.reportAssetId));
  if (!opts.baseAssetId && assetIds.size > 1) throw new Error(`禁止跨币种直接汇总：${[...assetIds].sort().join('、')}`);
  for (const effect of effects) {
    if (opts.baseAssetId && effect.reportAssetId !== opts.baseAssetId) continue;
    const month = effect.reportDate.slice(0, 7);
    const rows = effect.categoryRows.filter((row) => row.categoryId === category);
    if (!rows.length) continue;
    if (!groups.has(month)) groups.set(month, { sum: [], count: 0 });
    const g = groups.get(month)!;
    const direction = D(effect.expenseDelta).isNegative() ? -1 : 1;
    g.sum.push(...rows.map((row) => D(row.amount).mul(direction)));
    g.count += rows.length;
  }

  // 取最近 N 月
  const sorted = [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));
  const recent = sorted.slice(0, opts.months ?? 6).reverse();

  return recent.map(([month, g]) => ({
    month,
    amount: sum(g.sum).toString(),
    count: g.count,
  }));
}
