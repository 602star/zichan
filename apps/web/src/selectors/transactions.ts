import {
  D, addDays as shiftDays, addMonths as shiftMonths, computeBalances, dateRangeForPreset,
  isDateInRange, isTransactionActive, listScheduleOccurrences, nextUnhandledScheduleOccurrence,
  postingsFromTransaction, sum, localToday,
  type DateRange, type DateRangePreset,
  type Transaction, type TransactionCategory, type TransactionStatus, type TransactionType,
  type ScheduledTransaction,
} from '@zichan/core';
import type { TransactionReportAggregateRow } from '@zichan/db';
import type { Snapshot } from '../db/snapshot.js';
import { financialPostings } from '../db/derive.js';
import { createReportCurrency, type ReportCurrency } from '../reportCurrency.js';
import { ledgerAsOfDate } from '../as-of.js';
import {
  categoryLabel,
  categoryOptions,
  categoryType as metaCategoryType,
  TYPE_LABEL,
} from '../transactionMeta.js';
import { reportingEffect } from './transaction-effect.js';

export type TransactionRange = DateRangePreset;

export type AdvancedQueryField =
  | 'date'
  | 'time'
  | 'type'
  | 'category'
  | 'parentCategory'
  | 'amount'
  | 'assetId'
  | 'accountId'
  | 'payeeId'
  | 'merchant'
  | 'description'
  | 'note'
  | 'tagId'
  | 'locationId'
  | 'status'
  | 'hasAttachment';

export type AdvancedQueryOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'gte'
  | 'lte'
  | 'between'
  | 'in'
  | 'empty'
  | 'not_empty';

export interface AdvancedQueryCondition {
  id: string;
  field: AdvancedQueryField;
  op: AdvancedQueryOperator;
  value?: string;
  value2?: string;
}

export interface AdvancedQueryGroup {
  id: string;
  op: 'and';
  conditions: AdvancedQueryCondition[];
}

export interface AdvancedTransactionQuery {
  op: 'or';
  groups: AdvancedQueryGroup[];
}

export interface TransactionFilters {
  range: TransactionRange;
  dateFrom?: string;
  dateTo?: string;
  type: 'all' | TransactionType;
  category: 'all' | TransactionCategory;
  accountId: 'all' | string;
  payeeId?: 'all' | string;
  tagId?: 'all' | string;
  status?: 'all' | TransactionStatus | 'partially_reconciled' | 'reconciled';
  amountMin?: string;
  amountMax?: string;
  search: string;
  advanced?: AdvancedTransactionQuery;
}

export interface TransactionItemVM {
  tx: Transaction;
  assetCode: string;
  accountName: string;
  payeeName: string;
  categoryLabel: string;
  splitSummary: string;
  typeLabel: string;
  statusLabel: string;
  signedAmount: string;
  amountBase: string;
  incomeBase: string;
  expenseBase: string;
}

export interface TransactionGroupVM {
  key: string;
  label: string;
  items: TransactionItemVM[];
}

export interface TransactionCategoryVM {
  category: TransactionCategory;
  label: string;
  amount: string;
  count: number;
  weight: number;
}

/**
 * 本月支出构成：喂给饼图/环图的已算好数据。
 *
 * `weight` 的分母是**所有正向分类金额之和**（`total`），所以各段的 `weight`
 * 相加为 1；若某分类内退款多于消费（净额为负），它不会出现在 `slices` 里，
 * 因此 `total` 可能小于同月的「本月支出」总额——这是退款冲减的真实差额，
 * 不是舍入。
 */
export interface TransactionCompositionVM {
  /** 金额最大的几个分类，降序；超过的部分全部折进 `others`。 */
  slices: TransactionCategoryVM[];
  /** 剩余分类之和；`count` 是它盖住了几个分类（0 则调用方不产出「其他」）。 */
  others: { amount: string; count: number; weight: number };
  /** 100% 基准：所有正向分类金额之和。 */
  total: string;
}

export interface TransactionTrendVM {
  month: string;
  income: string;
  expense: string;
  net: string;
}

export interface TransactionCalendarDayVM {
  date: string;
  day: number;
  weekday: number;
  income: string;
  expense: string;
  net: string;
  count: number;
  items: TransactionItemVM[];
}

export interface BudgetRowVM {
  id?: string;
  category: string;
  label: string;
  planned: string;
  plannedNative: string;
  carryIn: string;
  available: string;
  actual: string;
  remaining: string;
  carryOut: string;
  usedRatio: number;
  over: boolean;
  conversionKnown: boolean;
}

export interface ScheduleRowVM {
  id: string;
  name: string;
  typeLabel: string;
  categoryLabel: string;
  amount: string;
  nextDate: string;
  status: 'overdue' | 'due' | 'future' | 'paused';
}

export interface ScheduleOccurrenceVM {
  id: string;
  schedule: ScheduledTransaction;
  date: string;
  name: string;
  typeLabel: string;
  categoryLabel: string;
  amount: string;
}

export interface AccountBalanceVM {
  accountId: string;
  accountName: string;
  assetId: string;
  assetCode: string;
  amount: string;
}

export interface AccountLedgerRowVM {
  tx: Transaction;
  title: string;
  categoryLabel: string;
  date: string;
  statusLabel: string;
  amount: string;
  balance: string;
  assetCode: string;
}

export interface TransactionsVM {
  month: string;
  income: string;
  expense: string;
  net: string;
  filteredIncome: string;
  filteredExpense: string;
  filteredNet: string;
  count: number;
  items: TransactionItemVM[];
  groups: TransactionGroupVM[];
  topExpenseCategories: TransactionCategoryVM[];
  expenseComposition: TransactionCompositionVM;
  filteredTopExpenseCategories: TransactionCategoryVM[];
  trend: TransactionTrendVM[];
  calendarMonth: string;
  calendarDays: TransactionCalendarDayVM[];
  budgets: BudgetRowVM[];
  schedules: ScheduleRowVM[];
  accountBalances: AccountBalanceVM[];
  reportCurrencyCode: string;
  missingRateAssetCodes: string[];
}

function dateMs(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y || 1970, (m || 1) - 1, day || 1);
}

function fmtMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y || 1970, (m || 1) - 1 + delta, 1));
  return fmtMonth(d);
}

function localDateIso(date = new Date()): string {
  return localToday(date);
}

export function transactionDateRange(asOf: string, filters: Pick<TransactionFilters, 'range' | 'dateFrom' | 'dateTo'>): DateRange {
  if (filters.range === 'custom' || filters.dateFrom || filters.dateTo) return { from: filters.dateFrom, to: filters.dateTo };
  return dateRangeForPreset(filters.range, asOf);
}

function groupLabel(date: string, today: string, asOf: string): { key: string; label: string } {
  const diff = Math.round((dateMs(today) - dateMs(date)) / 86_400_000);
  if (diff === 0) return { key: 'today', label: '今天' };
  if (diff === 1) return { key: 'yesterday', label: '昨天' };
  if (diff >= 0 && diff < 7) return { key: 'week', label: '本周' };
  if (date === asOf && asOf !== today) return { key: `ledger-day-${date}`, label: `账本日 ${date}` };
  return { key: date.slice(0, 7), label: date.slice(0, 7) };
}

function amountBase(report: ReportCurrency, assetId: string, amount: string, date?: string): string {
  return ((date ? report.toReportAt(D(amount).abs(), assetId, date) : report.toReport(D(amount).abs(), assetId)) ?? D(0)).toString();
}

function transactionEffectDate(snap: Snapshot, transaction: Transaction): string {
  return reportingEffect(snap, transaction).reportDate;
}

function transactionEffectAssetId(snap: Snapshot, transaction: Transaction): string {
  return reportingEffect(snap, transaction).reportAssetId;
}

function transactionEffectAmount(snap: Snapshot, transaction: Transaction): string {
  const effect = reportingEffect(snap, transaction);
  return D(effect.incomeDelta).abs().plus(D(effect.expenseDelta).abs()).toString();
}

function transactionReportValues(snap: Snapshot, report: ReportCurrency, transaction: Transaction) {
  const effect = reportingEffect(snap, transaction);
  return {
    effect,
    income: report.toReportAt(effect.incomeDelta, effect.reportAssetId, effect.reportDate) ?? D(0),
    expense: report.toReportAt(effect.expenseDelta, effect.reportAssetId, effect.reportDate) ?? D(0),
  };
}

function groupedExpenseCategoriesFromTransactions(snap: Snapshot, rows: Transaction[], report: ReportCurrency): TransactionCategoryVM[] {
  const byExpense = new Map<TransactionCategory, { amount: string[]; count: number }>();
  for (const transaction of rows) {
    const effect = reportingEffect(snap, transaction);
    if (D(effect.expenseDelta).isZero()) continue;
    const direction = D(effect.expenseDelta).isNegative() ? -1 : 1;
    for (const categoryRow of effect.categoryRows) {
      const row = byExpense.get(categoryRow.categoryId) ?? { amount: [], count: 0 };
      const converted = amountBase(report, effect.reportAssetId, categoryRow.amount, effect.reportDate);
      row.amount.push(D(converted).mul(direction).toString());
      row.count += 1;
      byExpense.set(categoryRow.categoryId, row);
    }
  }
  const positive = [...byExpense.entries()]
    .map(([category, row]) => {
      const amount = sum(row.amount);
      return {
        category,
        label: categoryLabel(category, snap.categories),
        amount: amount.toString(),
        count: row.count,
        weight: 0,
      };
    })
    .filter((row) => D(row.amount).gt(0));
  const totalExpense = sum(positive.map((row) => row.amount));
  return positive
    .map((row) => ({ ...row, weight: totalExpense.isZero() ? 0 : D(row.amount).div(totalExpense).toNumber() }))
    .sort((a, b) => D(b.amount).minus(a.amount).toNumber());
}

function expenseCategories(snap: Snapshot, rows: Transaction[], report: ReportCurrency, topN = 3): TransactionCategoryVM[] {
  return groupedExpenseCategoriesFromTransactions(snap, rows, report).slice(0, topN);
}

function expenseCompositionFromTransactions(snap: Snapshot, rows: Transaction[], report: ReportCurrency): TransactionCompositionVM {
  return composeExpenseCategories(groupedExpenseCategoriesFromTransactions(snap, rows, report));
}

function splitRows(snap: Snapshot, t: Transaction): { category: string; amount: string }[] {
  return reportingEffect(snap, t).categoryRows.map((row) => ({
    category: row.categoryId,
    amount: row.amount,
  }));
}

/**
 * 读路径（流水筛选、高级查询）的分类选项：在普通选项集基础上，额外把“已停用”的
 * 分类也带进来。
 *
 * 停用扩展包会把成员分类写成 isActive:false + isHidden:true，而 `allCategories`
 * 默认就把停用行整个丢掉，于是那些分类下的旧流水变成“看得见、筛不着”：
 * 列表里照常显示分类名，筛选和高级查询里却根本没这一项，只能把扩展包重新启用才查得了。
 *
 * 页面上的快照不持有全部流水（大账本按页从 SQL 取），所以没法在这里判断
 * “哪些停用分类真有流水”。交给 CategoryPicker 后它们跟“隐藏”同一套行为：
 * 不搜索时不占地方，搜索或开“显示隐藏”就能找到，并用「已停用」徒标区分。
 *
 * 写路径（记账弹窗、批量修改）不用它：不给已停用的分类制造新引用。
 */
export function historicalCategoryValueOptions(snap: Snapshot) {
  return categoryOptions(snap.categories, undefined, {
    leafOnly: true,
    includeHidden: true,
    includeCatalog: false,
    includeInactive: true,
  });
}

function payeeName(snap: Snapshot, t: Transaction): string {
  return t.payeeId ? snap.payees.find((p) => p.id === t.payeeId)?.name ?? t.merchant ?? '—' : t.merchant ?? '—';
}

function tagLabels(snap: Snapshot, ids: string[] = []): string[] {
  return ids.map((id) => {
    const t = snap.transactionTags.find((x) => x.id === id);
    return t ? `${t.groupName ?? ''} ${t.name}`.trim() : id;
  });
}

function locationLabel(snap: Snapshot, t: Transaction): string | undefined {
  return t.locationId ? snap.transactionLocations.find((l) => l.id === t.locationId)?.name ?? t.locationName : t.locationName;
}

function locationValues(snap: Snapshot, t: Transaction): string[] {
  const loc = t.locationId ? snap.transactionLocations.find((l) => l.id === t.locationId) : undefined;
  return [t.locationId, t.locationName, loc?.name, loc?.address].filter(Boolean) as string[];
}

function categoryParents(snap: Snapshot, categories: string[]): string[] {
  const rows = new Set<string>();
  for (const category of categories) {
    const seen = new Set<string>();
    let current = snap.categories.find((c) => c.id === category);
    // 防御:parentId 链出现循环(脏数据)时停止,避免无限循环。
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      rows.add(current.parentId);
      current = snap.categories.find((c) => c.id === current?.parentId);
    }
  }
  return [...rows];
}

function attachmentCount(snap: Snapshot, txId: string): number {
  return snap.attachments.filter((a) => !a.isDeleted && a.entityType === 'transaction' && a.entityId === txId).length;
}

function accountName(snap: Snapshot, id?: string): string {
  return id ? snap.accounts.find((a) => a.id === id)?.name ?? id : '未指定';
}

function assetCode(snap: Snapshot, id?: string): string {
  return id ? snap.assets.find((a) => a.id === id)?.code ?? id : '—';
}

export type TransactionReconciliationCoverage = 'none' | 'partial' | 'full';

export function transactionReconciliationCoverage(snap: Snapshot, transaction: Transaction): TransactionReconciliationCoverage {
  const closed = new Set(snap.reconciliationSessions.filter((row) => !row.isDeleted && row.status === 'closed').map((row) => row.id));
  const items = snap.reconciliationItems.filter((row) =>
    !row.isDeleted
    && row.transactionId === transaction.id
    && closed.has(row.reconciliationId),
  );
  if (!items.length) return 'none';
  const postingKeys = new Set(postingsFromTransaction(transaction)
    .filter((posting) => posting.accountId)
    .map((posting) => `${posting.accountId}\0${posting.assetId}`));
  if (!postingKeys.size) return 'full';
  const reconciledKeys = new Set(items.map((row) => `${row.accountId}\0${row.assetId}`));
  return [...postingKeys].every((key) => reconciledKeys.has(key)) ? 'full' : 'partial';
}

export function transactionIsReconciled(snap: Snapshot, transactionId: string): boolean {
  const transaction = snap.transactions.find((row) => row.id === transactionId);
  return transaction ? transactionReconciliationCoverage(snap, transaction) !== 'none' : false;
}

function statusLabel(snap: Snapshot, t: Transaction): string {
  const coverage = transactionReconciliationCoverage(snap, t);
  if (coverage === 'full') return '已对账';
  if (coverage === 'partial') return '部分对账';
  if (t.status === 'pending') return '待确认';
  return '已清算';
}

function hasAdvancedQuery(query?: AdvancedTransactionQuery): boolean {
  return !!query?.groups.some((g) => g.conditions.some((c) => c.field && c.op));
}

function normalize(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function valueList(value?: string): string[] {
  return (value ?? '').split(/[\n,，]+/).map((v) => v.trim()).filter(Boolean);
}

function isEmptyValues(values: unknown[]): boolean {
  return values.every((v) => v === undefined || v === null || String(v).trim() === '');
}

function conditionValues(snap: Snapshot, t: Transaction, field: AdvancedQueryField): unknown[] {
  const cats = splitRows(snap, t).map((s) => s.category);
  if (field === 'date') return [t.date];
  if (field === 'time') return [t.time];
  if (field === 'type') return [t.type, TYPE_LABEL[t.type]];
  if (field === 'category') return [t.category, ...cats, ...cats.map((c) => categoryLabel(c, snap.categories))];
  if (field === 'parentCategory') return categoryParents(snap, [t.category, ...cats]);
  if (field === 'amount') return [t.amount];
  if (field === 'assetId') return [t.assetId, assetCode(snap, t.assetId)];
  if (field === 'accountId') return [t.accountId, t.transferAccountId, accountName(snap, t.accountId), accountName(snap, t.transferAccountId)];
  if (field === 'payeeId') return [t.payeeId, payeeName(snap, t)];
  if (field === 'merchant') return [t.merchant, payeeName(snap, t)];
  if (field === 'description') return [t.description];
  if (field === 'note') return [t.note];
  if (field === 'tagId') return [...(t.tagIds ?? []), ...tagLabels(snap, t.tagIds)];
  if (field === 'locationId') return locationValues(snap, t);
  if (field === 'status') {
    const coverage = transactionReconciliationCoverage(snap, t);
    return [coverage === 'full' ? 'reconciled' : coverage === 'partial' ? 'partially_reconciled' : t.status ?? 'cleared', statusLabel(snap, t)];
  }
  if (field === 'hasAttachment') return [attachmentCount(snap, t.id) > 0 ? 'true' : 'false'];
  return [];
}

function compareValue(field: AdvancedQueryField, actual: unknown, expected: string): number | null {
  const a = String(actual ?? '').trim();
  const b = expected.trim();
  if (!a || !b) return null;
  if (field === 'date' || field === 'time') return a.localeCompare(b);
  if (field === 'amount') return finiteAmountFilterDecimal(a).cmp(finiteAmountFilterDecimal(b));
  try {
    const an = D(a);
    const bn = D(b);
    if (!an.isFinite() || !bn.isFinite()) return a.localeCompare(b);
    return an.cmp(bn);
  } catch {
    return a.localeCompare(b);
  }
}

function finiteAmountFilterDecimal(value: string): ReturnType<typeof D> {
  let decimal: ReturnType<typeof D>;
  try {
    decimal = D(value);
  } catch {
    throw new Error(`金额筛选值不是有效数字：${value}`);
  }
  if (!decimal.isFinite()) throw new Error(`金额筛选值不是有限数字：${value}`);
  return decimal;
}

function assertFiniteAmountFilters(filters: TransactionFilters): void {
  for (const value of [filters.amountMin, filters.amountMax]) {
    if (value?.trim()) finiteAmountFilterDecimal(value.trim());
  }
  for (const group of filters.advanced?.groups ?? []) {
    for (const condition of group.conditions) {
      if (condition.field !== 'amount') continue;
      if (condition.op === 'in') {
        for (const value of valueList(condition.value)) finiteAmountFilterDecimal(value);
      } else if (condition.op === 'between') {
        if (condition.value?.trim() && condition.value2?.trim()) {
          finiteAmountFilterDecimal(condition.value.trim());
          finiteAmountFilterDecimal(condition.value2.trim());
        }
      } else if (['eq', 'neq', 'gte', 'lte'].includes(condition.op) && condition.value?.trim()) {
        finiteAmountFilterDecimal(condition.value.trim());
      }
    }
  }
}

function matchesCondition(snap: Snapshot, t: Transaction, condition: AdvancedQueryCondition): boolean {
  const values = conditionValues(snap, t, condition.field);
  const needle = normalize(condition.value);
  if (condition.op === 'empty') return isEmptyValues(values);
  if (condition.op === 'not_empty') return !isEmptyValues(values);
  if (!needle && condition.op !== 'between') return true;
  if (condition.op === 'eq') return condition.field === 'amount'
    ? values.some((v) => compareValue('amount', v, condition.value ?? '') === 0)
    : values.some((v) => normalize(v) === needle);
  if (condition.op === 'neq') return condition.field === 'amount'
    ? !values.some((v) => compareValue('amount', v, condition.value ?? '') === 0)
    : !values.some((v) => normalize(v) === needle);
  if (condition.op === 'contains') return values.some((v) => normalize(v).includes(needle));
  if (condition.op === 'not_contains') return !values.some((v) => normalize(v).includes(needle));
  if (condition.op === 'in') {
    const allowed = valueList(condition.value);
    if (condition.field === 'amount') {
      return allowed.length === 0 || values.some((v) => allowed.some((item) => compareValue('amount', v, item) === 0));
    }
    const normalizedAllowed = allowed.map(normalize);
    return normalizedAllowed.length === 0 || values.some((v) => normalizedAllowed.includes(normalize(v)));
  }
  if (condition.op === 'gte') return values.some((v) => {
    const cmp = compareValue(condition.field, v, condition.value ?? '');
    return cmp !== null && cmp >= 0;
  });
  if (condition.op === 'lte') return values.some((v) => {
    const cmp = compareValue(condition.field, v, condition.value ?? '');
    return cmp !== null && cmp <= 0;
  });
  if (condition.op === 'between') {
    const a = condition.value ?? '';
    const b = condition.value2 ?? '';
    if (!a.trim() || !b.trim()) return true;
    return values.some((v) => {
      const min = compareValue(condition.field, v, a);
      const max = compareValue(condition.field, v, b);
      return min !== null && max !== null && min >= 0 && max <= 0;
    });
  }
  return true;
}

function matchesAdvanced(snap: Snapshot, t: Transaction, query?: AdvancedTransactionQuery): boolean {
  if (!hasAdvancedQuery(query)) return true;
  return query!.groups.some((group) => {
    const conditions = group.conditions.filter((c) => c.field && c.op);
    return conditions.length > 0 && conditions.every((c) => matchesCondition(snap, t, c));
  });
}

function matches(snap: Snapshot, t: Transaction, filters: TransactionFilters, range: DateRange, rangeDate = t.date): boolean {
  if (!isDateInRange(rangeDate, range)) return false;
  if (filters.type !== 'all' && t.type !== filters.type) return false;
  if (filters.status && filters.status !== 'all') {
    const coverage = transactionReconciliationCoverage(snap, t);
    const status = coverage === 'full' ? 'reconciled' : coverage === 'partial' ? 'partially_reconciled' : t.status ?? 'cleared';
    if (status !== filters.status) return false;
  }
  if (filters.payeeId && filters.payeeId !== 'all' && t.payeeId !== filters.payeeId) return false;
  if (filters.tagId && filters.tagId !== 'all' && !(t.tagIds ?? []).includes(filters.tagId)) return false;
  const amountMin = filters.amountMin?.trim();
  const amountMax = filters.amountMax?.trim();
  if (amountMin && D(t.amount || 0).lt(finiteAmountFilterDecimal(amountMin))) return false;
  if (amountMax && D(t.amount || 0).gt(finiteAmountFilterDecimal(amountMax))) return false;
  if (filters.category !== 'all') {
    const cats = splitRows(snap, t).map((s) => s.category);
    if (t.category !== filters.category && !cats.includes(filters.category)) return false;
  }
  if (filters.accountId !== 'all' && t.accountId !== filters.accountId && t.transferAccountId !== filters.accountId) return false;
  const q = filters.search.trim().toLowerCase();
  if (q) {
    const hay = [
      t.description, t.merchant, t.note, payeeName(snap, t), locationLabel(snap, t),
      ...tagLabels(snap, t.tagIds),
    ].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (!matchesAdvanced(snap, t, filters.advanced)) return false;
  return true;
}

function signedAmount(t: Transaction): string {
  if (t.type === 'income' || t.type === 'refund') return t.amount;
  if (t.type === 'transfer') return '0';
  if (t.type === 'adjustment') return t.adjustmentDirection === 'decrease' ? D(t.amount).negated().toString() : t.amount;
  return D(t.amount).negated().toString();
}

function buildBudgetRows(
  snap: Snapshot,
  month: string,
  report: ReportCurrency,
  aggregates?: TransactionReportAggregateRow[],
): BudgetRowVM[] {
  const expenseRows = aggregates
    ? []
    : snap.transactions.filter((t) =>
      isTransactionActive(t)
      && !D(reportingEffect(snap, t).expenseDelta).isZero()
    );
  const budgets = snap.budgetCategories.filter((b) => !b.isDeleted);
  const byMonthCategory = new Map(budgets.map((budget) => [`${budget.month}\0${budget.category}`, budget]));
  type NativeBudget = { carryIn: ReturnType<typeof D>; actual: ReturnType<typeof D>; remaining: ReturnType<typeof D>; carryOut: ReturnType<typeof D>; known: boolean };
  const nativeCache = new Map<string, NativeBudget>();
  const convert = (amount: string | ReturnType<typeof D>, source: string, target: string, date: string) => {
    if (source === target) return D(amount);
    const sourceReport = report.toReportAt(amount, source, date);
    const targetRate = report.toReportAt(1, target, date);
    return sourceReport && targetRate && !targetRate.isZero() ? sourceReport.div(targetRate) : undefined;
  };
  const calculate = (budget: (typeof budgets)[number]): NativeBudget => {
    const cached = nativeCache.get(budget.id);
    if (cached) return cached;
    const previousMonth = addMonths(budget.month, -1);
    const previous = byMonthCategory.get(`${previousMonth}\0${budget.category}`);
    let carryIn = D(0);
    let known = true;
    if (previous) {
      const prior = calculate(previous);
      const converted = convert(prior.carryOut, previous.assetId, budget.assetId, `${budget.month}-01`);
      if (converted) carryIn = converted;
      else known = false;
      known = known && prior.known;
    }
    const nativeActuals: ReturnType<typeof D>[] = [];
    if (aggregates) {
      for (const row of aggregates.filter((aggregate) =>
        aggregate.direction === 'expense'
        && aggregate.category === budget.category
        && aggregate.reportDate.slice(0, 7) === budget.month
      )) {
        const native = sum(row.amounts);
        const converted = convert(native, row.reportAssetId, budget.assetId, row.reportDate);
        if (!converted) known = false;
        else nativeActuals.push(converted);
      }
    } else {
      for (const transaction of expenseRows.filter((row) => transactionEffectDate(snap, row).slice(0, 7) === budget.month)) {
        const effect = reportingEffect(snap, transaction);
        const direction = D(effect.expenseDelta).isNegative() ? -1 : 1;
        for (const categoryRow of effect.categoryRows.filter((row) => row.categoryId === budget.category)) {
          const converted = convert(categoryRow.amount, effect.reportAssetId, budget.assetId, effect.reportDate);
          if (!converted) known = false;
          else nativeActuals.push(converted.mul(direction));
        }
      }
    }
    const actual = sum(nativeActuals);
    const remaining = D(budget.plannedAmount).plus(carryIn).minus(actual);
    const carryOut = budget.rolloverMode === 'signed'
      ? remaining
      : budget.rolloverMode === 'positive_only' && remaining.isPositive() ? remaining : D(0);
    const result = { carryIn, actual, remaining, carryOut, known };
    nativeCache.set(budget.id, result);
    return result;
  };
  return budgets.filter((budget) => budget.month === month).map((b) => {
    const native = calculate(b);
    const plannedConverted = report.toReport(b.plannedAmount || '0', b.assetId);
    const carryConverted = report.toReport(native.carryIn, b.assetId);
    const actualConverted = report.toReport(native.actual, b.assetId);
    const remainingConverted = report.toReport(native.remaining, b.assetId);
    const carryOutConverted = report.toReport(native.carryOut, b.assetId);
    const conversionKnown = native.known && plannedConverted !== undefined && carryConverted !== undefined
      && actualConverted !== undefined && remainingConverted !== undefined && carryOutConverted !== undefined;
    const planned = plannedConverted ?? D(0);
    const carryIn = carryConverted ?? D(0);
    const available = planned.plus(carryIn);
    const actual = actualConverted ?? D(0);
    const remaining = remainingConverted ?? D(0);
    return {
      id: b.id,
      category: b.category,
      label: categoryLabel(b.category, snap.categories),
      planned: planned.toString(),
      plannedNative: report.formatNative(b.plannedAmount, b.assetId),
      carryIn: carryIn.toString(),
      available: available.toString(),
      actual: actual.toString(),
      remaining: remaining.toString(),
      carryOut: (carryOutConverted ?? D(0)).toString(),
      usedRatio: !conversionKnown || available.isZero() ? 0 : actual.div(available).toNumber(),
      over: conversionKnown && remaining.isNegative(),
      conversionKnown,
    };
  }).sort((a, b) => D(b.actual).minus(a.actual).toNumber());
}

export function buildBudgetMonth(snap: Snapshot, month: string): BudgetRowVM[] {
  return buildBudgetRows(snap, month, createReportCurrency(snap));
}

export function buildBudgetMonthFromAggregates(
  snap: Snapshot,
  month: string,
  aggregates: TransactionReportAggregateRow[],
): BudgetRowVM[] {
  return buildBudgetRows(snap, month, createReportCurrency(snap), aggregates);
}

function buildSchedules(snap: Snapshot, asOf: string): ScheduleRowVM[] {
  return snap.scheduledTransactions
    .filter((s) => !s.isDeleted)
    .map((s): ScheduleRowVM => {
      const paused = s.status !== 'active';
      const occurrence = nextUnhandledScheduleOccurrence(s, snap.scheduledExecutions);
      const nextDate = occurrence?.date ?? s.endDate ?? s.anchorDate;
      const days = Math.round((dateMs(nextDate) - dateMs(asOf)) / 86_400_000);
      return {
        id: s.id,
        name: s.name,
        typeLabel: TYPE_LABEL[s.type],
        categoryLabel: categoryLabel(s.category, snap.categories),
        amount: `${s.amount} ${assetCode(snap, s.assetId)}`,
        nextDate,
        status: paused ? 'paused' : days < 0 ? 'overdue' : days <= 7 ? 'due' : 'future',
      };
    })
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

function buildAccountBalances(snap: Snapshot): AccountBalanceVM[] {
  const balances = computeBalances(financialPostings(snap), { perAccount: true });
  return balances
    .filter((b) => b.accountId && !D(b.amount).isZero())
    .map((b) => ({
      accountId: b.accountId!,
      accountName: accountName(snap, b.accountId),
      assetId: b.assetId,
      assetCode: assetCode(snap, b.assetId),
      amount: b.amount,
    }))
    .sort((a, b) => a.accountName.localeCompare(b.accountName) || a.assetCode.localeCompare(b.assetCode));
}

export function buildAccountLedger(snap: Snapshot, accountId: string, assetId?: string, range: DateRange = {}): AccountLedgerRowVM[] {
  const entries: { tx: Transaction; amount: string; assetId: string }[] = [];
  for (const tx of snap.transactions.filter(isTransactionActive)) {
    for (const p of postingsFromTransaction(tx)) {
      if (p.accountId !== accountId) continue;
      if (assetId && p.assetId !== assetId) continue;
      entries.push({ tx, amount: p.amount, assetId: p.assetId });
    }
  }
  entries.sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.tx.updatedAt.localeCompare(b.tx.updatedAt));
  let running = D(0);
  const rows: AccountLedgerRowVM[] = [];
  for (const e of entries) {
    running = running.plus(e.amount);
    if (!isDateInRange(e.tx.date, range)) continue;
    const title = e.tx.description ?? payeeName(snap, e.tx) ?? e.tx.merchant ?? categoryLabel(e.tx.category, snap.categories);
    rows.push({
      tx: e.tx,
      title,
      categoryLabel: e.tx.type === 'transfer' ? '转账' : e.tx.type === 'adjustment' ? '对账调整' : categoryLabel(e.tx.category, snap.categories),
      date: e.tx.date,
      statusLabel: statusLabel(snap, e.tx),
      amount: e.amount,
      balance: running.toString(),
      assetCode: assetCode(snap, e.assetId),
    });
  }
  return rows.reverse();
}

function itemForTransaction(snap: Snapshot, tx: Transaction, report: ReportCurrency): TransactionItemVM {
  const splits = splitRows(snap, tx);
  const reportValues = transactionReportValues(snap, report, tx);
  return {
    tx,
    assetCode: assetCode(snap, tx.assetId),
    accountName: tx.type === 'transfer'
      ? `${accountName(snap, tx.accountId)} → ${accountName(snap, tx.transferAccountId)}`
      : accountName(snap, tx.accountId),
    payeeName: payeeName(snap, tx),
    categoryLabel: tx.type === 'transfer'
      ? '转账'
      : tx.type === 'adjustment' ? '对账调整'
      : splits.length > 1 ? `拆分 ${splits.length} 项` : categoryLabel(tx.category, snap.categories),
    splitSummary: splits.length > 1
      ? splits.map((s) => `${categoryLabel(s.category, snap.categories)} ${s.amount}`).join(' / ')
      : '',
    typeLabel: TYPE_LABEL[tx.type],
    statusLabel: statusLabel(snap, tx),
    signedAmount: signedAmount(tx),
    amountBase: reportValues.income.abs().plus(reportValues.expense.abs()).toString(),
    incomeBase: reportValues.income.toString(),
    expenseBase: reportValues.expense.toString(),
  };
}

export function buildFilteredTransactions(snap: Snapshot, filters: TransactionFilters): Transaction[] {
  assertFiniteAmountFilters(filters);
  const asOf = ledgerAsOfDate(snap);
  const range = transactionDateRange(asOf, filters);
  return snap.transactions
    .filter((t) => isTransactionActive(t) && matches(snap, t, filters, range))
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
}

function calendarMonthForRange(asOf: string, range: TransactionRange): string {
  const month = asOf.slice(0, 7);
  if (range === 'last_month') return addMonths(month, -1);
  return month;
}

function buildCalendarDays(snap: Snapshot, filters: TransactionFilters, calendarMonth: string, report: ReportCurrency): TransactionCalendarDayVM[] {
  const [y, m] = calendarMonth.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y || 1970, m || 1, 0)).getUTCDate();
  const range = { from: `${calendarMonth}-01`, to: shiftDays(`${addMonths(calendarMonth, 1)}-01`, -1) };
  const rows = snap.transactions
    .filter((t) => isTransactionActive(t) && t.type !== 'transfer' && matches(snap, t, filters, range, transactionEffectDate(snap, t)))
    .sort((a, b) => transactionEffectDate(snap, b).localeCompare(transactionEffectDate(snap, a)) || b.updatedAt.localeCompare(a.updatedAt));
  const byDate = new Map<string, Transaction[]>();
  for (const tx of rows) {
    const reportDate = transactionEffectDate(snap, tx);
    const list = byDate.get(reportDate) ?? [];
    list.push(tx);
    byDate.set(reportDate, list);
  }
  const days: TransactionCalendarDayVM[] = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${calendarMonth}-${String(day).padStart(2, '0')}`;
    const txs = byDate.get(date) ?? [];
    const reportValues = txs.map((transaction) => transactionReportValues(snap, report, transaction));
    const income = sum(reportValues.map((value) => value.income));
    const expense = sum(reportValues.map((value) => value.expense));
    days.push({
      date,
      day,
      weekday: new Date(`${date}T00:00:00.000Z`).getUTCDay(),
      income: income.toString(),
      expense: expense.toString(),
      net: income.minus(expense).toString(),
      count: txs.length,
      items: txs.map((tx) => itemForTransaction(snap, tx, report)),
    });
  }
  return days;
}

export interface TransactionReadModelInput {
  /** Current SQL-filtered page with only its child rows attached. */
  page: Snapshot;
  /**
   * Unfiltered rows covering the trend window and the current month. The window
   * is chosen by the screen (3 / 6 / 12 months), so the caller must widen this
   * read to match `trendMonths`; this builder only buckets what it is given.
   */
  summaryAggregates: TransactionReportAggregateRow[];
  /** Length of the trend, in months, ending with the current one. */
  trendMonths?: number;
  /** Aggregate rows using the same filters as the current page. */
  filteredAggregates: TransactionReportAggregateRow[];
  filteredCount: number;
  budgets?: BudgetRowVM[];
  accountBalances?: AccountBalanceVM[];
}

function aggregateAmount(
  report: ReportCurrency,
  row: TransactionReportAggregateRow,
): ReturnType<typeof D> | undefined {
  return report.toReportAt(sum(row.amounts), row.reportAssetId, row.reportDate);
}

function aggregateTotals(
  report: ReportCurrency,
  rows: TransactionReportAggregateRow[],
): { income: ReturnType<typeof D>; expense: ReturnType<typeof D> } {
  let income = D(0);
  let expense = D(0);
  for (const row of rows) {
    const converted = aggregateAmount(report, row);
    if (!converted) continue;
    if (row.direction === 'income') income = income.plus(converted);
    else expense = expense.plus(converted);
  }
  return { income, expense };
}

/*
 * 所有正向分类的支出金额，降序。`weight` 的分母是正金额之和，各段相加为 1。
 *
 * 构成环只画最大的 `COMPOSITION_SLICES` 个分类，其余折进「其他」——
 * 切片多到看不出差别时，画出来也没人能读、能点。
 */
const COMPOSITION_SLICES = 5;

function groupedExpenseCategories(snap: Snapshot, report: ReportCurrency, rows: TransactionReportAggregateRow[]): TransactionCategoryVM[] {
  const grouped = new Map<string, { amount: ReturnType<typeof D>; count: number }>();
  for (const row of rows.filter((aggregate) => aggregate.direction === 'expense')) {
    const converted = aggregateAmount(report, row);
    if (!converted) continue;
    const current = grouped.get(row.category) ?? { amount: D(0), count: 0 };
    current.amount = current.amount.plus(converted);
    current.count += row.count;
    grouped.set(row.category, current);
  }
  const total = sum([...grouped.values()].map((row) => row.amount).filter((amount) => amount.isPositive()));
  return [...grouped.entries()]
    .filter(([, row]) => row.amount.isPositive())
    .map(([category, row]) => ({
      category,
      label: categoryLabel(category, snap.categories),
      amount: row.amount.toString(),
      count: row.count,
      weight: total.isZero() ? 0 : row.amount.div(total).toNumber(),
    }))
    .sort((left, right) => D(right.amount).minus(left.amount).toNumber());
}

function aggregateExpenseCategories(
  snap: Snapshot,
  report: ReportCurrency,
  rows: TransactionReportAggregateRow[],
  topN = 3,
): TransactionCategoryVM[] {
  return groupedExpenseCategories(snap, report, rows).slice(0, topN);
}

/**
 * 本月支出构成。与 `aggregateExpenseCategories` 共用同一趟分组，
 * 所以环图的数字与 KPI 卡里的 Top3 必然同源——多出来的只是「其他」那一档。
 */
function expenseComposition(snap: Snapshot, report: ReportCurrency, rows: TransactionReportAggregateRow[]): TransactionCompositionVM {
  return composeExpenseCategories(groupedExpenseCategories(snap, report, rows));
}

/** 把完整分类列表折成「前 N + 其他」两档，环图与条形图共用。 */
function composeExpenseCategories(all: TransactionCategoryVM[]): TransactionCompositionVM {
  const slices = all.slice(0, COMPOSITION_SLICES);
  const rest = all.slice(COMPOSITION_SLICES);
  return {
    slices,
    others: {
      amount: sum(rest.map((row) => row.amount)).toString(),
      count: rest.length,
      weight: sum(rest.map((row) => row.weight)).toNumber(),
    },
    total: sum(all.map((row) => row.amount)).toString(),
  };
}

function aggregateCalendarDays(
  snap: Snapshot,
  pageItems: TransactionItemVM[],
  calendarMonth: string,
  report: ReportCurrency,
  rows: TransactionReportAggregateRow[],
): TransactionCalendarDayVM[] {
  const [year, month] = calendarMonth.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year || 1970, month || 1, 0)).getUTCDate();
  const byDate = new Map<string, TransactionItemVM[]>();
  for (const item of pageItems) {
    const reportDate = transactionEffectDate(snap, item.tx);
    const current = byDate.get(reportDate) ?? [];
    current.push(item);
    byDate.set(reportDate, current);
  }
  const byDateAggregate = new Map<string, TransactionReportAggregateRow[]>();
  for (const row of rows.filter((aggregate) => aggregate.reportDate.slice(0, 7) === calendarMonth)) {
    const current = byDateAggregate.get(row.reportDate) ?? [];
    current.push(row);
    byDateAggregate.set(row.reportDate, current);
  }
  return Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const date = `${calendarMonth}-${String(day).padStart(2, '0')}`;
    const totals = aggregateTotals(report, byDateAggregate.get(date) ?? []);
    const items = byDate.get(date) ?? [];
    return {
      date,
      day,
      weekday: new Date(`${date}T00:00:00.000Z`).getUTCDay(),
      income: totals.income.toString(),
      expense: totals.expense.toString(),
      net: totals.income.minus(totals.expense).toString(),
      count: items.length,
      items,
    };
  });
}

export function buildTransactionsFromReadModel(
  baseSnap: Snapshot,
  filters: TransactionFilters,
  input: TransactionReadModelInput,
): TransactionsVM {
  const snap = input.page;
  const report = createReportCurrency(baseSnap);
  for (const row of [...input.summaryAggregates, ...input.filteredAggregates]) {
    aggregateAmount(report, row);
  }
  const asOf = ledgerAsOfDate(baseSnap);
  const today = localDateIso();
  const month = asOf.slice(0, 7);
  const filtered = [...snap.transactions]
    .filter(isTransactionActive)
    .sort((left, right) => right.date.localeCompare(left.date) || right.updatedAt.localeCompare(left.updatedAt));
  const items = filtered.map((transaction) => itemForTransaction(snap, transaction, report));
  const groups = new Map<string, TransactionGroupVM>();
  for (const item of items) {
    const label = groupLabel(item.tx.date, today, asOf);
    if (!groups.has(label.key)) groups.set(label.key, { key: label.key, label: label.label, items: [] });
    groups.get(label.key)!.items.push(item);
  }
  const monthAggregates = input.summaryAggregates.filter((row) => row.reportDate.slice(0, 7) === month);
  const monthTotals = aggregateTotals(report, monthAggregates);
  const filteredTotals = aggregateTotals(report, input.filteredAggregates);
  const trend: TransactionTrendVM[] = [];
  const trendMonths = input.trendMonths ?? 6;
  for (let index = trendMonths - 1; index >= 0; index -= 1) {
    const trendMonth = addMonths(month, -index);
    const totals = aggregateTotals(
      report,
      input.summaryAggregates.filter((row) => row.reportDate.slice(0, 7) === trendMonth),
    );
    trend.push({
      month: trendMonth,
      income: totals.income.toString(),
      expense: totals.expense.toString(),
      net: totals.income.minus(totals.expense).toString(),
    });
  }
  const calendarMonth = calendarMonthForRange(asOf, filters.range);
  /*
   * 构成与 KPI 卡的 Top3 共用同一趟分组：先取前 5 分类，KPI 卡再从里面切 3。
   * 分开算两次会让同一屏出现两个「同一月份、同一口径」却可能微差的分类数字。
   */
  const composition = expenseComposition(baseSnap, report, monthAggregates);
  return {
    month,
    income: monthTotals.income.toString(),
    expense: monthTotals.expense.toString(),
    net: monthTotals.income.minus(monthTotals.expense).toString(),
    filteredIncome: filteredTotals.income.toString(),
    filteredExpense: filteredTotals.expense.toString(),
    filteredNet: filteredTotals.income.minus(filteredTotals.expense).toString(),
    count: input.filteredCount,
    items,
    groups: [...groups.values()],
    topExpenseCategories: composition.slices.slice(0, 3),
    expenseComposition: composition,
    filteredTopExpenseCategories: aggregateExpenseCategories(baseSnap, report, input.filteredAggregates),
    trend,
    calendarMonth,
    calendarDays: aggregateCalendarDays(snap, items, calendarMonth, report, input.filteredAggregates),
    budgets: input.budgets ?? [],
    schedules: buildSchedules(baseSnap, asOf),
    accountBalances: input.accountBalances ?? [],
    reportCurrencyCode: report.code,
    missingRateAssetCodes: report.missingCodes(),
  };
}

export function buildScheduleOccurrences(snap: Snapshot, range: DateRange, maxRows = 500): ScheduleOccurrenceVM[] {
  const from = range.from ?? localDateIso();
  const to = range.to ?? shiftMonths(from, 12);
  const rows: ScheduleOccurrenceVM[] = [];
  for (const schedule of snap.scheduledTransactions.filter((row) => !row.isDeleted && row.status === 'active')) {
    for (const occurrence of listScheduleOccurrences(schedule, { throughDate: to, max: maxRows })) {
      const date = occurrence.date;
      if (date >= from && (!schedule.endDate || date <= schedule.endDate)) {
        rows.push({
          id: `${schedule.id}:${date}`,
          schedule,
          date,
          name: schedule.name,
          typeLabel: TYPE_LABEL[schedule.type],
          categoryLabel: categoryLabel(schedule.category, snap.categories),
          amount: `${schedule.amount} ${assetCode(snap, schedule.assetId)}`,
        });
      }
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

export function buildTransactions(snap: Snapshot, filters: TransactionFilters, trendMonths = 6): TransactionsVM {
  const report = createReportCurrency(snap);
  for (const transaction of snap.transactions.filter((row) => isTransactionActive(row) && row.type !== 'transfer')) {
    report.toReportAt(
      transactionEffectAmount(snap, transaction),
      transactionEffectAssetId(snap, transaction),
      transactionEffectDate(snap, transaction),
    );
  }
  const asOf = ledgerAsOfDate(snap);
  const today = localDateIso();
  const month = asOf.slice(0, 7);
  const filtered = buildFilteredTransactions(snap, filters);
  const items = filtered.map((tx) => itemForTransaction(snap, tx, report));

  const groups = new Map<string, TransactionGroupVM>();
  for (const item of items) {
    const tx = item.tx;
    const label = groupLabel(tx.date, today, asOf);
    if (!groups.has(label.key)) groups.set(label.key, { key: label.key, label: label.label, items: [] });
    groups.get(label.key)!.items.push(item);
  }

  const monthRows = snap.transactions.filter((t) => isTransactionActive(t) && t.type !== 'transfer' && transactionEffectDate(snap, t).slice(0, 7) === month);
  const monthValues = monthRows.map((transaction) => transactionReportValues(snap, report, transaction));
  const income = sum(monthValues.map((value) => value.income));
  const expense = sum(monthValues.map((value) => value.expense));
  const filteredRows = filtered.filter((t) => t.type !== 'transfer');
  const filteredValues = filteredRows.map((transaction) => transactionReportValues(snap, report, transaction));
  const filteredIncome = sum(filteredValues.map((value) => value.income));
  const filteredExpense = sum(filteredValues.map((value) => value.expense));

  const topExpenseCategories = expenseCategories(snap, monthRows, report);
  const filteredTopExpenseCategories = expenseCategories(snap, filteredRows, report);
  const expenseComposition = expenseCompositionFromTransactions(snap, monthRows, report);

  const trend: TransactionTrendVM[] = [];
  for (let i = trendMonths - 1; i >= 0; i--) {
    const m = addMonths(month, -i);
    const rows = snap.transactions.filter((t) => isTransactionActive(t) && t.type !== 'transfer' && transactionEffectDate(snap, t).slice(0, 7) === m);
    const values = rows.map((transaction) => transactionReportValues(snap, report, transaction));
    const inc = sum(values.map((value) => value.income));
    const exp = sum(values.map((value) => value.expense));
    trend.push({ month: m, income: inc.toString(), expense: exp.toString(), net: inc.minus(exp).toString() });
  }
  const budgets = buildBudgetRows(snap, month, report);

  return {
    month,
    income: income.toString(),
    expense: expense.toString(),
    net: income.minus(expense).toString(),
    filteredIncome: filteredIncome.toString(),
    filteredExpense: filteredExpense.toString(),
    filteredNet: filteredIncome.minus(filteredExpense).toString(),
    count: filtered.length,
    items,
    groups: [...groups.values()],
    topExpenseCategories,
    expenseComposition,
    filteredTopExpenseCategories,
    trend,
    calendarMonth: calendarMonthForRange(asOf, filters.range),
    calendarDays: buildCalendarDays(snap, filters, calendarMonthForRange(asOf, filters.range), report),
    budgets,
    schedules: buildSchedules(snap, asOf),
    accountBalances: buildAccountBalances(snap),
    reportCurrencyCode: report.code,
    missingRateAssetCodes: report.missingCodes(),
  };
}

export function categoryType(category: TransactionCategory, snap?: Snapshot): TransactionType {
  return metaCategoryType(category, snap?.categories) ?? 'expense';
}
