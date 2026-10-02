import { conversionRateText } from './convert.js';
/** Reports view-models — pure selectors over a Snapshot (unit-tested). */
import {
  traceChain, conversionStepAmounts, fixedAssetCost, isDateInRange, gameRecordReportingPostings, D, safeDiv, sum,
  isTransactionActive, usesAssetCostState, assetCostSourceSummary,
  type Category,
  type DateRange,
  type GameRecord, type GameRecordType, type Transaction,
} from '@zichan/core';
import type { TransactionReportAggregateRow } from '@zichan/db';
import type { Snapshot } from '../db/snapshot.js';
import { assetById } from '../db/derive.js';
import { amount as fmtAmount, num } from '../format.js';
import { categoryLabel, categoryLevelIndex, TYPE_LABEL } from '../transactionMeta.js';
import { createReportCurrency, type ReportCurrency } from '../reportCurrency.js';
import { ledgerAsOfDate } from '../as-of.js';
import { reportingEffect } from './transaction-effect.js';

export type TabId = 'transactions' | 'dca' | 'chain' | 'season' | 'fixed';
export interface ReportOptions {
  dateRange?: DateRange;
  /** 只留这个二级分类。 */
  transactionCategory?: string;
  /**
   * 只留这个一级分类下的全部二级。与 `transactionCategory` 同时给就是
   * 「板块 + 细分」两级下钻；两个都是精确匹配，所以不会互相覆盖。
   */
  transactionParentCategory?: string;
}
export type TransactionReportOptions = ReportOptions;
export interface TransactionDetailRow {
  id: string;
  reportDate: string;
  cashDate: string;
  type: string;
  category: string;
  description: string;
  payee: string;
  amount: string;
  baseAmount: string;
}
export interface Cell { v: string; color?: string; bold?: boolean; data?: Record<string, string> }
export interface Table {
  headers: string[];
  rows: Cell[][];
  reportCurrencyCode?: string;
  missingRateAssetCodes?: string[];
  valuationComplete?: boolean;
}

export function buildReport(snap: Snapshot, tab: TabId, options: ReportOptions = {}): Table {
  if (tab === 'transactions') return transactionTable(snap, options);
  if (tab === 'dca') return dcaTable(snap, options);
  if (tab === 'chain') return chainTable(snap, options);
  if (tab === 'season') return seasonTable(snap, options);
  return fixedTable(snap, options);
}

function reportTable(report: ReportCurrency, headers: string[], rows: Cell[][]): Table {
  const missingRateAssetCodes = report.missingCodes();
  return {
    headers,
    rows,
    reportCurrencyCode: report.code,
    missingRateAssetCodes,
    valuationComplete: missingRateAssetCodes.length === 0,
  };
}

function txBase(snap: Snapshot, report: ReportCurrency, transaction: Transaction) {
  const effect = reportingEffect(snap, transaction);
  const amount = D(effect.incomeDelta).abs().plus(D(effect.expenseDelta).abs());
  return report.toReportAt(amount, effect.reportAssetId, effect.reportDate);
}

function txCategoryRows(snap: Snapshot, transaction: Transaction): { category: string; amount: string }[] {
  return reportingEffect(snap, transaction).categoryRows.map((row) => ({
    category: row.categoryId,
    amount: row.amount,
  }));
}

export function reportDateRange(options: ReportOptions = {}): DateRange & { label: string } {
  const { from, to } = options.dateRange ?? {};
  return { from, to, label: from || to ? `${from ?? '最早'} 至 ${to ?? '至今'}` : '全部' };
}

function filteredTransactions(snap: Snapshot, options: TransactionReportOptions = {}): Transaction[] {
  const range = reportDateRange(options);
  const { rootOf } = categoryLevelIndex(snap.categories);
  const inParent = (category: string) => !options.transactionParentCategory || rootOf(category) === options.transactionParentCategory;
  return snap.transactions.filter((t) => {
    if (!isTransactionActive(t) || t.type === 'transfer' || t.type === 'adjustment') return false;
    if (!isDateInRange(reportingEffect(snap, t).reportDate, range)) return false;
    const rows = txCategoryRows(snap, t);
    if (options.transactionCategory && !rows.some((row) => row.category === options.transactionCategory)) return false;
    if (!rows.some((row) => inParent(row.category))) return false;
    return true;
  });
}

function payeeLabel(snap: Snapshot, tx: Transaction): string {
  if (tx.payeeId) return snap.payees.find((p) => p.id === tx.payeeId)?.name ?? tx.merchant ?? '—';
  return tx.merchant ?? '—';
}

function assetCode(snap: Snapshot, assetId: string): string {
  return snap.assets.find((a) => a.id === assetId)?.code ?? assetId.slice(0, 6);
}

export function transactionDetails(snap: Snapshot, options: TransactionReportOptions = {}): TransactionDetailRow[] {
  const report = createReportCurrency(snap);
  return filteredTransactions(snap, options)
    .sort((a, b) => {
      const reportOrder = reportingEffect(snap, b).reportDate.localeCompare(reportingEffect(snap, a).reportDate);
      return reportOrder || b.date.localeCompare(a.date) || (b.time ?? '').localeCompare(a.time ?? '');
    })
    .map((tx) => {
      const effect = reportingEffect(snap, tx);
      const signed = tx.type === 'income' || tx.type === 'refund' ? '+' : '-';
      const converted = txBase(snap, report, tx);
      return {
        id: tx.id,
        reportDate: effect.reportDate,
        cashDate: tx.time ? `${tx.date} ${tx.time}` : tx.date,
        type: TYPE_LABEL[tx.type],
        category: [...new Set(txCategoryRows(snap, tx).map((row) => categoryLabel(row.category, snap.categories)))].join('、'),
        description: tx.description ?? tx.merchant ?? '',
        payee: payeeLabel(snap, tx),
        amount: `${signed}${tx.amount} ${assetCode(snap, tx.assetId)}`,
        baseAmount: tx.reportingTreatment === 'balance_only'
          ? '仅影响余额，不计收支'
          : converted
          ? D(effect.expenseDelta).isNegative() ? `冲减支出 ${report.formatReport(converted)}` : report.formatReport(converted)
          : `未折算（${report.formatNative(D(effect.incomeDelta).abs().plus(D(effect.expenseDelta).abs()), effect.reportAssetId)}）`,
      };
    });
}

function transactionTable(snap: Snapshot, options: TransactionReportOptions = {}): Table {
  const report = createReportCurrency(snap);
  const asOf = ledgerAsOfDate(snap);
  const range = reportDateRange(options);
  const rows = filteredTransactions(snap, options);
  const byCategory = new Map<string, { type: 'income' | 'expense'; amounts: string[]; count: number; missing: number }>();
  for (const tx of rows) {
    const effect = reportingEffect(snap, tx);
    if (D(effect.incomeDelta).isZero() && D(effect.expenseDelta).isZero()) continue;
    const summaryType = D(effect.incomeDelta).isZero() ? 'expense' : 'income';
    const direction = D(effect.expenseDelta).isNegative() ? -1 : 1;
    for (const part of txCategoryRows(snap, tx)) {
      const key = `${summaryType}:${part.category}`;
      const row = byCategory.get(key) ?? { type: summaryType, amounts: [], count: 0, missing: 0 };
      const converted = report.toReportAt(D(part.amount).abs(), effect.reportAssetId, effect.reportDate);
      if (converted) row.amounts.push(converted.mul(direction).toString());
      else row.missing += 1;
      row.count += 1;
      byCategory.set(key, row);
    }
  }
  const totalExpense = sum(rows
    .map((transaction) => {
      const effect = reportingEffect(snap, transaction);
      return report.toReportAt(effect.expenseDelta, effect.reportAssetId, effect.reportDate);
    })
    .filter((value): value is NonNullable<typeof value> => value !== undefined));
  const summaries = [...byCategory.entries()].map(([key, row]) => {
    const [, category] = key.split(':');
    const total = sum(row.amounts);
    const weight = row.type === 'expense' && total.gt(0) && totalExpense.gt(0) ? total.div(totalExpense).times(100) : null;
    const amountText = row.missing
      ? `${report.formatReport(total)} · ${row.missing} 笔未折算`
      : report.formatReport(total);
    const cells: Cell[] = [
      { v: TYPE_LABEL[row.type], color: row.type === 'income' ? 'var(--positive)' : 'var(--negative)', bold: true },
      { v: categoryLabel(category ?? 'other_expense', snap.categories), bold: true, data: { category: category ?? 'other_expense', type: row.type } },
      { v: amountText, color: row.type === 'income' ? 'var(--positive)' : 'var(--negative)', data: { reportAmount: total.toString() } },
      { v: String(row.count) },
      { v: weight ? `${num(weight, 1)}%` : '—', color: 'var(--text-secondary)' },
    ];
    return { total, cells };
  }).sort((a, b) => b.total.comparedTo(a.total));
  return reportTable(
    report,
    [`${range.label || asOf.slice(0, 7)} 类型`, '分类', `金额（${report.code}）`, '笔数', '支出占比'],
    summaries.map((row) => row.cells),
  );
}

export function transactionTableFromAggregates(
  snap: Snapshot,
  aggregates: TransactionReportAggregateRow[],
  options: TransactionReportOptions = {},
): Table {
  const report = createReportCurrency(snap);
  const asOf = ledgerAsOfDate(snap);
  const range = reportDateRange(options);
  const byCategory = new Map<string, {
    type: 'income' | 'expense';
    total: ReturnType<typeof D>;
    count: number;
    missing: number;
  }>();
  let totalExpense = D(0);
  const { rootOf } = categoryLevelIndex(snap.categories);
  for (const aggregate of aggregates) {
    if (!isDateInRange(aggregate.reportDate, range)) continue;
    if (options.transactionCategory && aggregate.category !== options.transactionCategory) continue;
    if (options.transactionParentCategory && rootOf(aggregate.category) !== options.transactionParentCategory) continue;
    const native = sum(aggregate.amounts);
    const converted = report.toReportAt(native, aggregate.reportAssetId, aggregate.reportDate);
    const key = `${aggregate.direction}:${aggregate.category}`;
    const row = byCategory.get(key) ?? {
      type: aggregate.direction,
      total: D(0),
      count: 0,
      missing: 0,
    };
    if (converted) {
      row.total = row.total.plus(converted);
      if (aggregate.direction === 'expense') totalExpense = totalExpense.plus(converted);
    } else {
      row.missing += aggregate.count;
    }
    row.count += aggregate.count;
    byCategory.set(key, row);
  }
  const summaries = [...byCategory.entries()].map(([key, row]) => {
    const [, category] = key.split(':');
    const weight = row.type === 'expense' && row.total.gt(0) && totalExpense.gt(0)
      ? row.total.div(totalExpense).times(100)
      : null;
    const amountText = row.missing
      ? `${report.formatReport(row.total)} · ${row.missing} 笔未折算`
      : report.formatReport(row.total);
    const cells: Cell[] = [
      { v: TYPE_LABEL[row.type], color: row.type === 'income' ? 'var(--positive)' : 'var(--negative)', bold: true },
      { v: categoryLabel(category ?? 'other_expense', snap.categories), bold: true, data: { category: category ?? 'other_expense', type: row.type } },
      { v: amountText, color: row.type === 'income' ? 'var(--positive)' : 'var(--negative)', data: { reportAmount: row.total.toString() } },
      { v: String(row.count) },
      { v: weight ? `${num(weight, 1)}%` : '—', color: 'var(--text-secondary)' },
    ];
    return { total: row.total, cells };
  }).sort((left, right) => right.total.comparedTo(left.total));
  return reportTable(
    report,
    [`${range.label || asOf.slice(0, 7)} 类型`, '分类', `金额（${report.code}）`, '笔数', '支出占比'],
    summaries.map((row) => row.cells),
  );
}

/** 构成图的一段：一个可下钻的分类。 */
export interface ReportCompositionSlice {
  category: string;
  label: string;
  /** 报表币种下的十进制字符串，与表格那一格同源。 */
  amount: string;
  /** 占 `total` 的比例，0..1。 */
  weight: number;
}

/** 「前 N 个分类 + 其他」；与支出页的 `expenseComposition` 同一个折法。 */
export interface ReportComposition {
  slices: ReportCompositionSlice[];
  others: { amount: string; count: number; weight: number };
  /** 100% 基准：所有正金额分类之和。 */
  total: string;
}

/** 构成图的粒度：一级分类（板块）还是二级分类（细分）。 */
export type CompositionLevel = 'parent' | 'leaf';

export interface CompositionOptions {
  /** 用来把叶子归到板块上；缺省时 `parent` 层退化为叶子自身。 */
  categories?: Category[];
  /** `parent`（缺省）按一级分类聚合，`leaf` 保留二级。 */
  level?: CompositionLevel;
  /**
   * 只看这个一级分类下的二级。画“选中那一段的构成”时用它：
   * 与左环同源、同口径（同一批行、同一分母规则），只是多一道归属过滤。
   */
  underParent?: string;
  topN?: number;
}

/**
 * 把「叶子分类金额」折成一张构成图的数据。两级共用这一个折法：
 * `level: 'parent'` 得到一级环，`level: 'leaf' + underParent` 得到它的二级环。
 *
 * 正金额分类才是可画、可点的一段；净额为负的分类（当月退款多于消费）
 * 不进分子也不进分母，所以各段 `weight` 相加恒为 1。
 *
 * 用 `gt(0)` 而不是 `isPositive()`：decimal.js 的 `isPositive()` 对 ±0 为真，
 * 会把一个净额归零的分类画成一段 0° 的切片并出现在图例里。
 *
 * 标签取分类自己的名字（不带「父级 / 子级」前缀）：环本身已经是嵌套读法。
 */
export function composeExpenseComposition(
  rows: { category: string; amount: string }[],
  options: CompositionOptions = {},
): ReportComposition {
  const { categories = [], level = 'parent', underParent, topN = 5 } = options;
  const { nameOf, rootOf } = categoryLevelIndex(categories);
  const grouped = new Map<string, ReturnType<typeof D>>();
  for (const row of rows) {
    if (underParent && rootOf(row.category) !== underParent) continue;
    const amount = D(row.amount);
    if (!amount.gt(0)) continue;
    const key = level === 'parent' ? rootOf(row.category) : row.category;
    grouped.set(key, (grouped.get(key) ?? D(0)).plus(amount));
  }
  const total = sum([...grouped.values()]);
  const weighted: ReportCompositionSlice[] = [...grouped.entries()]
    .map(([category, amount]) => ({
      category,
      label: nameOf(category),
      amount: amount.toString(),
      weight: total.isZero() ? 0 : amount.div(total).toNumber(),
    }))
    .sort((left, right) => D(right.amount).comparedTo(D(left.amount)));
  const slices = weighted.slice(0, topN);
  const rest = weighted.slice(topN);
  return {
    slices,
    others: {
      amount: sum(rest.map((row) => row.amount)).toString(),
      count: rest.length,
      weight: sum(rest.map((row) => row.weight)).toNumber(),
    },
    total: total.toString(),
  };
}

/**
 * 从已经算好的分类表里折出构成图的数据——不新增查询。
 *
 * 表里每行是一个**二级**分类（表格自己需要那个粒度），所以这里先把叶子行交给
 * `composeExpenseComposition` 再按层聚合：环与它旁边的表格必然是同一批行的
 * 两种读法，不会出现“环上多一笔、表里少一笔”。
 */
export function expenseCompositionFromTable(table: Table, options: CompositionOptions = {}): ReportComposition {
  return composeExpenseComposition(
    table.rows
      .filter((row) => row[0]?.v === '支出')
      .map((row) => ({
        category: String(row[1]?.data?.category ?? 'other_expense'),
        amount: String(row[2]?.data?.reportAmount ?? '0'),
      })),
    options,
  );
}

function plainCell(cell: Cell): string {
  return cell.v.replace(/\s+/g, ' ').trim();
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function tableToCsv(table: Table): string {
  const metadata = table.valuationComplete === false
    ? [`估值完整性,部分`, `缺少汇率,${csvEscape((table.missingRateAssetCodes ?? []).join('、'))}`]
    : ['估值完整性,完整'];
  return [...metadata, table.headers.map(csvEscape).join(','), ...table.rows.map((row) => row.map((c) => csvEscape(plainCell(c))).join(','))].join('\n');
}

export function tableToMarkdown(table: Table): string {
  const header = `| ${table.headers.join(' | ')} |`;
  const sep = `| ${table.headers.map(() => '---').join(' | ')} |`;
  const rows = table.rows.map((row) => `| ${row.map((c) => plainCell(c).replace(/\|/g, '\\|')).join(' | ')} |`);
  const metadata = table.valuationComplete === false
    ? `> 估值不完整：缺少 ${(table.missingRateAssetCodes ?? []).join('、')} → ${table.reportCurrencyCode ?? '报表币种'} 的价格标记。`
    : '> 估值完整。';
  return [metadata, '', header, sep, ...rows].join('\n');
}

function mermaidNumber(value: string): number {
  const n = Number(value.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function tableToMermaid(table: Table, title = '报表'): string {
  const rows = table.rows
    .map((row) => {
      const amountCell = row.find((cell) => cell.data?.reportAmount !== undefined);
      return {
        label: plainCell(row[1] ?? row[0] ?? { v: '未命名' }).slice(0, 24),
        value: mermaidNumber(amountCell?.data?.reportAmount ?? plainCell(row[2] ?? row[1] ?? { v: '0' })),
      };
    })
    .filter((row) => row.value > 0)
    .slice(0, 10);
  const metadata = table.valuationComplete === false
    ? `%% 估值不完整：缺少 ${(table.missingRateAssetCodes ?? []).join('、')}`
    : '%% 估值完整';
  if (!rows.length) return `${metadata}\npie title ${title}\n  "暂无数据" : 1`;
  return [metadata, `pie title ${title}`, ...rows.map((row) => `  "${row.label.replace(/"/g, "'")}" : ${row.value}`)].join('\n');
}

function dcaTable(snap: Snapshot, options: ReportOptions): Table {
  const report = createReportCurrency(snap);
  const range = reportDateRange(options);
  const byId = assetById(snap);
  const running = new Map<string, { amount: ReturnType<typeof D>; cost: ReturnType<typeof D>; known: boolean }>();
  const rows: Cell[][] = [];
  for (const execution of [...snap.dcaExecutions]
    .filter((row) => !row.isDeleted && isDateInRange(row.date, range))
    .sort((a, b) => a.date.localeCompare(b.date))) {
    const acquired = D(execution.finalAmount);
    const convertedCost = execution.actualBaseCost === null ? undefined : report.toReportAt(execution.actualBaseCost, execution.baseCurrencyAssetId, execution.date);
    const convertedFee = report.toReportAt(execution.totalFeeInBase, execution.baseCurrencyAssetId, execution.date);
    const state = running.get(execution.finalAssetId) ?? { amount: D(0), cost: D(0), known: true };
    state.amount = state.amount.plus(acquired);
    if (convertedCost) state.cost = state.cost.plus(convertedCost);
    else state.known = false;
    running.set(execution.finalAssetId, state);
    const target = byId.get(execution.finalAssetId);
    const targetCode = target?.code ?? execution.finalAssetId.slice(0, 8);
    const unitCost = convertedCost && !acquired.isZero() ? convertedCost.div(acquired) : undefined;
    const average = state.known && !state.amount.isZero() ? state.cost.div(state.amount) : undefined;
    rows.push([
      { v: execution.date, bold: true },
      { v: execution.actualBaseCost === null ? '成本未知' : report.formatNative(execution.actualBaseCost, execution.baseCurrencyAssetId) },
      { v: convertedCost ? report.formatReport(convertedCost) : '未折算', data: { reportAmount: convertedCost?.toString() ?? '' } },
      { v: `${fmtAmount(acquired, target?.decimals ?? 8)} ${targetCode}`, bold: true },
      { v: convertedFee ? report.formatReport(convertedFee) : '未折算', color: 'var(--negative)' },
      { v: unitCost ? `${report.formatReport(unitCost)} / ${targetCode}` : '未折算' },
      { v: `${fmtAmount(state.amount, target?.decimals ?? 8)} ${targetCode}` },
      { v: state.known ? report.formatReport(state.cost) : '未完整折算' },
      { v: average ? `${report.formatReport(average)} / ${targetCode}` : '未完整折算', bold: true },
    ]);
  }
  return reportTable(report, [
    '定投日期', '投入原币', `折算投入（${report.code}）`, '买入资产', `手续费（${report.code}）`,
    '单位成本', '累计数量', `累计成本（${report.code}）`, '持仓均价',
  ], rows);
}

function chainTable(snap: Snapshot, options: ReportOptions): Table {
  const report = createReportCurrency(snap);
  const range = reportDateRange(options);
  const byId = assetById(snap);
  const code = (id: string) => byId.get(id)?.code ?? '?';
  const chains = snap.chains.filter((c) => c.chain.recordState !== 'voided' && c.chain.type !== 'deposit' && c.steps.length && isDateInRange(c.chain.date, range));
  const rows = chains.map((c): Cell[] => {
      const t = traceChain(c);
      const isSell = c.chain.type === 'sell';
      const first = c.steps[0]!;
      const firstAmounts = conversionStepAmounts(first);
      const path = [code(first.fromAssetId), ...c.steps.map((s) => code(s.toAssetId))].join('→');
      const rates = c.steps.map((s) => {
        return conversionRateText(s, code(s.fromAssetId), code(s.toAssetId));
      }).join('；');
      if (usesAssetCostState(snap.costState, c.chain)) {
        const state = snap.costState;
        const summary = assetCostSourceSummary(state, c.chain.id);
        const acquired = state.events.find((event) => event.eventId === `${c.steps.at(-1)?.id}:2-target`);
        const realized = c.chain.type === 'sell' || c.chain.type === 'swap';
        const value = realized ? summary.realizedGainLoss : acquired?.costInBase ?? null;
        const costCurrency = c.chain.baseCurrencyAssetId;
        const converted = value === null ? undefined : report.toReportAt(value, costCurrency, c.chain.date);
        return [
          { v: c.chain.title?.trim() || path, bold: true },
          { v: report.formatNative(firstAmounts.sourceDebit, first.fromAssetId) },
          { v: path }, { v: rates },
          { v: c.chain.costQuotes?.some((quote) => quote.feeValues.some((fee) => fee.valueInBase === null)) ? '费用未估值' : report.formatNative(t.totalFeesInBase, costCurrency) },
          { v: report.formatNative(t.finalAmount, t.finalAssetId), bold: true },
          { v: value === null ? `未完整核算 · 已知收益 ${report.formatNative(summary.knownRealizedGainLoss, costCurrency)}` : report.formatNative(value, costCurrency) },
          { v: converted ? realized ? report.formatSignedReport(converted) : report.formatReport(converted) : value === null ? '未完整核算' : '未折算', data: { reportAmount: converted?.abs().toString() ?? '' } },
          { v: '—' },
        ];
      }
      if (isSell && c.chain.realizedGainLoss === undefined) return [
        { v: c.chain.title?.trim() || path }, { v: report.formatNative(firstAmounts.sourceDebit, first.fromAssetId) },
        { v: path }, { v: rates }, { v: report.formatNative(t.totalFeesInBase, c.chain.baseCurrencyAssetId) },
        { v: report.formatNative(t.finalAmount, t.finalAssetId) }, { v: '成本未知' }, { v: '未完整核算' }, { v: '—' },
      ];
      const proceeds = D(t.totalBaseProceeds);
      const pnl = isSell ? D(c.chain.realizedGainLoss!) : D(0);
      const cost = isSell ? proceeds.minus(pnl) : D(t.totalBaseCost);
      const ret = isSell && !cost.isZero() ? pnl.div(cost).times(100) : null;
      const converted = report.toReportAt(isSell ? pnl : cost, c.chain.baseCurrencyAssetId, c.chain.date);
      const bookSummary = isSell
        ? `成本 ${report.formatNative(cost, c.chain.baseCurrencyAssetId)} · 收益 ${pnl.isNegative() ? '−' : '+'}${report.formatNative(pnl.abs(), c.chain.baseCurrencyAssetId)}`
        : report.formatNative(cost, c.chain.baseCurrencyAssetId);
      return [
        { v: c.chain.title ?? c.chain.type, bold: true },
        { v: report.formatNative(firstAmounts.sourceDebit, first.fromAssetId) },
        { v: path, color: 'var(--text-secondary)' },
        { v: rates, color: 'var(--text-secondary)' },
        { v: report.formatNative(t.totalFeesInBase, c.chain.baseCurrencyAssetId), color: 'var(--negative)' },
        { v: isSell ? report.formatNative(t.totalBaseProceeds, c.chain.baseCurrencyAssetId) : report.formatNative(t.finalAmount, t.finalAssetId), bold: true },
        { v: bookSummary },
        { v: converted ? (isSell ? report.formatSignedReport(converted) : report.formatReport(converted)) : '未折算', data: { reportAmount: converted?.abs().toString() ?? '' } },
        { v: ret ? `${ret.isNegative() ? '−' : '+'}${num(ret.abs(), 1)}%` : '—', color: ret ? (ret.isNegative() ? 'var(--negative)' : 'var(--positive)') : 'var(--fg-muted)', bold: !!ret },
      ];
    });
  return reportTable(report, [
    '链路', '起始实扣', '路径', '成交 / 有效 / 参考汇率', '账面手续费', '最终结果',
    '账面成本 / 收益', `折算成本 / 收益（${report.code}）`, '实际收益率',
  ], rows);
}

const SELL_TYPES = new Set<GameRecordType>(['sell_currency', 'sell_equipment', 'sell_material']);
function sumSettlement(report: ReportCurrency, records: GameRecord[], types: Set<GameRecordType> | GameRecordType) {
  const set = types instanceof Set ? types : new Set([types]);
  return sum(records
    .filter((record) => set.has(record.recordType) && record.settlementAssetId)
    .map((record) => report.toReportAt(record.settlementAmount ?? '0', record.settlementAssetId!, record.date) ?? D(0)));
}

function gameFees(report: ReportCurrency, records: GameRecord[]) {
  const values: ReturnType<typeof D>[] = [];
  for (const record of records) {
    if (record.recordType === 'fee' && record.settlementAssetId) {
      values.push(report.toReportAt(record.settlementAmount ?? '0', record.settlementAssetId, record.date) ?? D(0));
    }
    if (record.feeAssetId) values.push(report.toReportAt(record.feeAmount ?? '0', record.feeAssetId, record.date) ?? D(0));
  }
  return sum(values);
}

export function gameNetInReport(report: ReportCurrency, records: GameRecord[]) {
  const values: ReturnType<typeof D>[] = [];
  for (const record of records.filter((row) => !row.isDeleted)) {
    for (const posting of gameRecordReportingPostings(record)) values.push(report.toReportAt(posting.amount, posting.assetId, record.date) ?? D(0));
  }
  return sum(values);
}

function seasonTable(snap: Snapshot, options: ReportOptions): Table {
  const report = createReportCurrency(snap);
  const range = reportDateRange(options);
  const rows: Cell[][] = [];
  for (const s of [...snap.seasons].sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))) {
    const recs = snap.gameRecords.filter((r) => r.seasonId === s.id && !r.isDeleted && isDateInRange(r.date, range));
    if ((range.from || range.to) && recs.length === 0) continue;
    const buy = sumSettlement(report, recs, 'buy_currency');
    const sell = sumSettlement(report, recs, SELL_TYPES);
    const topup = sumSettlement(report, recs, 'topup');
    const fees = gameFees(report, recs);
    const net = gameNetInReport(report, recs);
    const hours = D(s.hours ?? 0);
    const perHour = safeDiv(net, hours);
    const game = snap.games.find((row) => row.id === s.gameId);
    rows.push([
      { v: s.name, bold: true },
      { v: game?.name ?? '—', color: 'var(--text-secondary)' },
      { v: report.formatReport(buy) },
      { v: report.formatReport(sell) },
      { v: report.formatReport(topup) },
      { v: report.formatReport(fees), color: 'var(--negative)' },
      { v: report.formatSignedReport(net), color: net.isNegative() ? 'var(--negative)' : 'var(--positive)', bold: true, data: { reportAmount: net.abs().toString() } },
      { v: `${hours.toString()} h`, color: 'var(--text-secondary)' },
      { v: report.formatSignedReport(perHour) },
    ]);
  }
  return reportTable(report, ['赛季', '游戏', '买入', '卖出', '充值', '手续费', `净收益（${report.code}）`, '时长', '每小时'], rows);
}

function fixedTable(snap: Snapshot, options: ReportOptions): Table {
  const range = reportDateRange(options);
  const asOf = range.to ?? ledgerAsOfDate(snap);
  const report = createReportCurrency(snap, asOf);
  const statusLabel = { active: '使用中', stored: '收纳中', sold: '已售出', scrapped: '已报废', retired: '已清退', gifted: '已赠出' } as const;
  const rows = snap.fixedAssets.filter((f) => {
    if (!range.from && !range.to) return true;
    if (isDateInRange(f.purchaseDate, range)) return true;
    if (snap.fixedEvents.some((event) => event.fixedAssetId === f.id && isDateInRange(event.date, range))) return true;
    if (snap.fixedUsageLogs.some((log) => log.fixedAssetId === f.id && isDateInRange(log.date, range))) return true;
    return snap.fixedConsumables.some((item) => item.fixedAssetId === f.id && [item.purchaseDate, item.installedDate, item.replacedDate].some((date) => date && isDateInRange(date, range)));
  }).map((f): Cell[] => {
      const c = fixedAssetCost(f, snap.fixedEvents, { asOf, usageMetrics: snap.fixedUsageMetrics, usageLogs: snap.fixedUsageLogs, consumables: snap.fixedConsumables });
      const residual = c.basis === 'final' ? c.salePrice : c.currentValuation;
      const convertedNet = report.toReport(c.netCost, f.baseCurrencyAssetId);
      const primaryUsage = c.usageCosts.find((row) => row.metricId) ?? c.usageCosts[0]!;
      const convertedUnit = report.toReport(primaryUsage.perUnit, f.baseCurrencyAssetId);
      return [
        { v: f.name, bold: true },
        { v: snap.assets.find((asset) => asset.id === f.baseCurrencyAssetId)?.code ?? '—', color: 'var(--text-secondary)' },
        { v: report.formatNative(c.purchase, f.baseCurrencyAssetId) },
        { v: report.formatNative(c.repair, f.baseCurrencyAssetId), color: 'var(--text-secondary)' },
        { v: report.formatNative(c.consumable, f.baseCurrencyAssetId), color: 'var(--text-secondary)' },
        { v: report.formatNative(residual ?? '0', f.baseCurrencyAssetId) },
        { v: report.formatNative(c.netCost, f.baseCurrencyAssetId), bold: true },
        { v: convertedNet ? report.formatReport(convertedNet) : '未折算', data: { reportAmount: convertedNet?.toString() ?? '' } },
        { v: `${c.heldDays} 天`, color: 'var(--text-secondary)' },
        { v: convertedUnit ? `${report.formatReport(convertedUnit)} / ${primaryUsage.unitLabel}` : '未折算', color: 'var(--accent)', bold: true },
        { v: statusLabel[f.status], color: 'var(--text-secondary)' },
      ];
    });
  return reportTable(report, [
    '物品资产', '原币', '购买', '维修', '耗材', '现状残值 / 清退', '净使用成本',
    `折算净成本（${report.code}）`, '持有天数', '主要单位成本', '状态',
  ], rows);
}
