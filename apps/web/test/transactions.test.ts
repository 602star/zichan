import { describe, expect, it } from 'vitest';
import { round, systemCategory, type Category } from '@zichan/core';
import { budgetCategoryForm, categoryForm, gameRecordForm, payeeForm, scheduledTransactionForm, transactionForm, transactionSplitForm, transactionTemplateForm } from '../src/forms.js';
import {
  buildAccountLedger,
  buildBudgetMonth,
  buildBudgetMonthFromAggregates,
  buildFilteredTransactions,
  buildScheduleOccurrences,
  buildTransactions,
  buildTransactionsFromReadModel,
  historicalCategoryValueOptions,
  transactionReconciliationCoverage,
  type TransactionFilters,
} from '../src/selectors/transactions.js';
import { categoryOptions } from '../src/transactionMeta.js';
import { COMMON_TRANSACTION_FORM_FIELDS, optionalTransactionFields } from '../src/transactionFormPrefs.js';
import { makeSnapshot, makeTransaction } from './fixtures.js';
import type { FieldDef } from '../src/ui/EntityFormModal.js';

function optionsOf(field: FieldDef, values: Record<string, string> = {}) {
  return typeof field.options === 'function' ? field.options(values) : field.options ?? [];
}

describe('buildTransactions', () => {
  it('builds monthly summary, groups, top categories and trend', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ date: '2026-03-04', type: 'income', category: 'salary', amount: '3000', assetId: s.ids.gbp, description: '工资' }),
      makeTransaction({ date: '2026-03-03', type: 'expense', category: 'food', amount: '20', assetId: s.ids.gbp, merchant: 'Cafe' }),
      makeTransaction({ date: '2026-03-02', type: 'expense', category: 'transport', amount: '8', assetId: s.ids.gbp, merchant: 'Metro' }),
      makeTransaction({ date: '2026-02-20', type: 'expense', category: 'shopping', amount: '90', assetId: s.ids.gbp }),
    ];

    const vm = buildTransactions(s, { range: 'this_month', type: 'all', category: 'all', accountId: 'all', search: '' });
    expect(round(vm.income, 2)).toBe('3000.00');
    expect(round(vm.expense, 2)).toBe('28.00');
    expect(round(vm.net, 2)).toBe('2972.00');
    expect(round(vm.filteredIncome, 2)).toBe('3000.00');
    expect(round(vm.filteredExpense, 2)).toBe('28.00');
    expect(round(vm.filteredNet, 2)).toBe('2972.00');
    expect(vm.groups[0]?.label).toBe('账本日 2026-03-04');
    expect(vm.topExpenseCategories.map((x) => x.category)).toEqual(['food_parent', 'transport']);
    expect(vm.trend.at(-1)?.month).toBe('2026-03');
    expect(vm.calendarDays.find((d) => d.date === '2026-03-03')).toMatchObject({ count: 1, expense: '20' });
  });

  it('keeps exact summaries when the visible transaction list is only one SQL page', () => {
    const s = makeSnapshot();
    const income = makeTransaction({ id: 'income', date: '2026-03-04', type: 'income', category: 'salary', amount: '3000', assetId: s.ids.gbp });
    const food = makeTransaction({ id: 'food', date: '2026-03-03', type: 'expense', category: 'food', amount: '20', assetId: s.ids.gbp });
    const transport = makeTransaction({ id: 'transport', date: '2026-03-02', type: 'expense', category: 'transport', amount: '8', assetId: s.ids.gbp });
    s.transactions = [income, food, transport];
    const aggregates = [
      { reportDate: income.date, reportAssetId: s.ids.gbp, direction: 'income' as const, category: 'salary', amounts: ['3000'], count: 1 },
      { reportDate: food.date, reportAssetId: s.ids.gbp, direction: 'expense' as const, category: 'food', amounts: ['20'], count: 1 },
      { reportDate: transport.date, reportAssetId: s.ids.gbp, direction: 'expense' as const, category: 'transport', amounts: ['8'], count: 1 },
    ];
    const page = { ...s, transactions: [income], transactionSplits: [], refundAllocations: [], attachments: [], reconciliationItems: [], reconciliationSessions: [] };
    const vm = buildTransactionsFromReadModel(s, {
      range: 'this_month', type: 'all', category: 'all', accountId: 'all', search: '',
    }, {
      page,
      summaryAggregates: aggregates,
      filteredAggregates: aggregates,
      filteredCount: 3,
    });
    expect(vm.items.map((row) => row.tx.id)).toEqual(['income']);
    expect(vm.count).toBe(3);
    expect(vm.income).toBe('3000');
    expect(vm.expense).toBe('28');
    expect(vm.filteredNet).toBe('2972');
    // 环与 KPI 都按一级聚合（`food` 归属 `food_parent`），所以两处都是板块名。
    expect(vm.topExpenseCategories.map((row) => row.category)).toEqual(['food_parent', 'transport']);
  });

  it('treats refunds as positive cash that reduces original spending and ignores voided rows', () => {
    const s = makeSnapshot();
    const original = makeTransaction({ id: 'expense-original', date: '2026-03-03', type: 'expense', category: 'food', amount: '100', assetId: s.ids.gbp, accountId: s.ids.bank });
    s.setting!.refundAttributionMode = 'original_date';
    s.transactions = [
      original,
      makeTransaction({
        id: 'refund', date: '2026-04-02', type: 'refund', category: 'food', amount: '30', assetId: s.ids.gbp,
        accountId: s.ids.bank, refundForId: original.id, refundAppliedAmount: '30', refundAppliedAssetId: s.ids.gbp,
        refundAttributionMode: 'original_date', refundEffectDate: original.date, refundAllocationMode: 'proportional',
        originalDateSnapshot: original.date, originalAmountSnapshot: original.amount,
      }),
      makeTransaction({ id: 'voided', date: '2026-03-03', type: 'expense', category: 'food', amount: '50', assetId: s.ids.gbp, recordState: 'voided' }),
    ];
    s.refundAllocations = [{
      id: 'refund-allocation', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      refundTransactionId: 'refund', sourceTransactionId: original.id, categoryId: 'food',
      categoryPathSnapshot: '餐饮 / 餐饮/正餐', amount: '30', assetId: s.ids.gbp,
    }];
    s.budgetCategories = [{ id: 'budget', month: '2026-03', category: 'food', plannedAmount: '120', assetId: s.ids.gbp, rolloverMode: 'none', createdAt: '', updatedAt: '', version: 1, isDeleted: false }];

    const vm = buildTransactions(s, { range: 'this_month', type: 'all', category: 'all', accountId: 'all', search: '' });
    expect(round(vm.expense, 2)).toBe('70.00');
    expect(vm.budgets[0]).toMatchObject({ actual: '70', remaining: '50' });
    expect(vm.topExpenseCategories[0]).toMatchObject({ category: 'food_parent', amount: '70' });
    expect(vm.calendarDays.find((day) => day.date === original.date)).toMatchObject({ count: 2, expense: '70' });
    const ledger = buildAccountLedger(s, s.ids.bank, s.ids.gbp);
    expect(ledger.map((row) => row.amount)).toEqual(['30', '-100']);
    expect(ledger[0]?.balance).toBe('-70');
  });

  it('calculates budget rollover from compact SQL aggregate rows', () => {
    const s = makeSnapshot();
    s.budgetCategories = [
      { id: 'jan', month: '2026-01', category: 'food', plannedAmount: '100', assetId: s.ids.gbp, rolloverMode: 'positive_only', createdAt: '', updatedAt: '', version: 1, isDeleted: false },
      { id: 'feb', month: '2026-02', category: 'food', plannedAmount: '100', assetId: s.ids.gbp, rolloverMode: 'signed', createdAt: '', updatedAt: '', version: 1, isDeleted: false },
    ];
    const aggregates = [
      { reportDate: '2026-01-15', reportAssetId: s.ids.gbp, direction: 'expense' as const, category: 'food', amounts: ['60'], count: 1 },
      { reportDate: '2026-02-15', reportAssetId: s.ids.gbp, direction: 'expense' as const, category: 'food', amounts: ['130', '-10'], count: 2 },
    ];
    expect(buildBudgetMonthFromAggregates(s, '2026-02', aggregates)[0]).toMatchObject({
      carryIn: '40',
      available: '140',
      actual: '120',
      remaining: '20',
      carryOut: '20',
    });
  });

  /*
   * 列表摘要列的兜底链：描述 → 商户 → 二级分类名。
   *
   * 旧写法在「没有商户」时返回的是一个**真的横杠字符**，而 `??` 只认 null/undefined，
   * 于是它在第二档就把后面的商户与分类一起短路了——不写描述的流水整行只剩一个横杠。
   * 兜底值只用于显示，不能写回 `description`，否则分类改名后那条描述就成了假数据。
   */
  it('falls back to the subcategory name instead of a dash when a row has no description', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ id: 'silent', date: '2026-03-04', category: 'food', amount: '20', assetId: s.ids.gbp, accountId: s.ids.bank }),
      makeTransaction({ id: 'with-payee', date: '2026-03-03', category: 'food', amount: '15', assetId: s.ids.gbp, payeeId: s.ids.cafe }),
      makeTransaction({ id: 'with-merchant', date: '2026-03-02', category: 'transport', amount: '8', assetId: s.ids.gbp, merchant: 'Metro' }),
      makeTransaction({ id: 'with-description', date: '2026-03-01', category: 'transport', amount: '6', assetId: s.ids.gbp, merchant: 'Metro', description: '通勤' }),
    ];

    const vm = buildTransactions(s, { range: 'this_month', type: 'all', category: 'all', accountId: 'all', search: '' });
    const itemOf = (id: string) => vm.items.find((item) => item.tx.id === id);

    // 二级名，不是「一级 / 二级」：完整的分类路径已经在旁边那一列写着了。
    expect(itemOf('silent')?.title).toBe('餐饮/正餐');
    expect(itemOf('with-payee')?.title).toBe('Cafe');
    expect(itemOf('with-merchant')?.title).toBe('Metro');
    expect(itemOf('with-description')?.title).toBe('通勤');
    expect(vm.items.map((item) => item.title)).not.toContain('—');
    expect(vm.items.every((item) => item.title.trim() !== '')).toBe(true);
    // 只兜底显示，不落库。
    expect(itemOf('silent')?.tx.description).toBeUndefined();

    const ledger = buildAccountLedger(s, s.ids.bank, s.ids.gbp);
    expect(ledger.find((row) => row.tx.id === 'silent')?.title).toBe('餐饮/正餐');
  });

  it('does not let a missing payee masquerade as text in search', () => {
    const s = makeSnapshot();
    s.transactions = [makeTransaction({ id: 'silent', date: '2026-03-04', category: 'food', amount: '20', assetId: s.ids.gbp })];
    // 没有商户时值集里过去落着那个占位横杠，于是搜「—」会命中每一笔没商户的流水。
    expect(buildTransactions(s, { range: 'this_month', type: 'all', category: 'all', accountId: 'all', search: '—' }).count).toBe(0);
  });

  it('filters by type, category, account and search', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ type: 'expense', category: 'food', amount: '20', assetId: s.ids.gbp, accountId: s.ids.bank, merchant: 'Cafe' }),
      makeTransaction({ type: 'expense', category: 'shopping', amount: '35', assetId: s.ids.gbp, accountId: s.ids.cash, merchant: 'Market' }),
      makeTransaction({ type: 'income', category: 'salary', amount: '3000', assetId: s.ids.gbp, accountId: s.ids.bank, description: 'Payroll' }),
    ];

    const vm = buildTransactions(s, { range: 'this_month', type: 'expense', category: 'food', accountId: s.ids.bank, search: 'caf' });
    expect(vm.count).toBe(1);
    expect(vm.groups[0]?.items[0]?.tx.category).toBe('food');
    expect(round(vm.expense, 2)).toBe('55.00');
    expect(round(vm.filteredExpense, 2)).toBe('20.00');
    expect(round(vm.filteredIncome, 2)).toBe('0.00');
  });

  it('filters Decimal amounts beyond the JavaScript number range without silently dropping bounds', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ id: 'below', amount: '9e8999999999999999', assetId: s.ids.gbp }),
      makeTransaction({ id: 'exact', amount: '1e9000000000000000', assetId: s.ids.gbp }),
    ];

    const exact = buildFilteredTransactions(s, {
      range: 'this_month', type: 'all', category: 'all', accountId: 'all', search: '',
      amountMin: '1e9000000000000000', amountMax: '1e9000000000000000',
    });
    expect(exact.map((row) => row.id)).toEqual(['exact']);
    s.transactions = [];
    expect(() => buildFilteredTransactions(s, {
      range: 'this_month', type: 'all', category: 'all', accountId: 'all', search: '',
      amountMin: 'Infinity',
    })).toThrow('金额筛选值不是有限数字');
  });

  it('filters with advanced AND groups joined by OR', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ id: 'big-lunch', type: 'expense', category: 'food', amount: '80', assetId: s.ids.gbp, merchant: 'Cafe' }),
      makeTransaction({ id: 'small-lunch', type: 'expense', category: 'food', amount: '12', assetId: s.ids.gbp, merchant: 'Cafe' }),
      makeTransaction({ id: 'reimburse', type: 'expense', category: 'shopping', amount: '20', assetId: s.ids.gbp, tagIds: ['tag-reimburse'] }),
      makeTransaction({ id: 'salary', type: 'income', category: 'salary', amount: '3000', assetId: s.ids.gbp }),
    ];

    const vm = buildTransactions(s, {
      range: 'this_month',
      type: 'all',
      category: 'all',
      accountId: 'all',
      search: '',
      advanced: {
        op: 'or',
        groups: [
          {
            id: 'g1',
            op: 'and',
            conditions: [
              { id: 'c1', field: 'parentCategory', op: 'eq', value: 'food_parent' },
              { id: 'c2', field: 'amount', op: 'gte', value: '50' },
            ],
          },
          { id: 'g2', op: 'and', conditions: [{ id: 'c3', field: 'tagId', op: 'eq', value: 'tag-reimburse' }] },
        ],
      },
    });

    expect(vm.items.map((x) => x.tx.id)).toEqual(['big-lunch', 'reimburse']);
  });

  it('handles transfers, split categories, budgets and account ledger', () => {
    const s = makeSnapshot();
    const grocery = makeTransaction({ id: 'market', type: 'expense', category: 'shopping', amount: '50', assetId: s.ids.gbp, accountId: s.ids.bank, merchant: 'Market' });
    s.transactions = [
      makeTransaction({ date: '2026-03-04', type: 'income', category: 'salary', amount: '3000', assetId: s.ids.gbp, accountId: s.ids.bank }),
      grocery,
      makeTransaction({ id: 'cash-out', date: '2026-03-04', type: 'transfer', category: 'shopping', amount: '100', assetId: s.ids.gbp, accountId: s.ids.bank, transferAssetId: s.ids.gbp, transferAccountId: s.ids.cash, transferAmount: '100' }),
    ];
    s.transactionSplits = [
      { id: 'sp-food', transactionId: grocery.id, category: 'food', amount: '30', createdAt: '', updatedAt: '', version: 1, isDeleted: false },
      { id: 'sp-shopping', transactionId: grocery.id, category: 'shopping', amount: '20', createdAt: '', updatedAt: '', version: 1, isDeleted: false },
    ];
    s.budgetCategories = [
      { id: 'b-food', month: '2026-03', category: 'food', plannedAmount: '100', assetId: s.ids.gbp, rolloverMode: 'none', createdAt: '', updatedAt: '', version: 1, isDeleted: false },
    ];

    const vm = buildTransactions(s, { range: 'this_month', type: 'all', category: 'all', accountId: 'all', search: '' });
    expect(round(vm.expense, 2)).toBe('50.00');
    expect(vm.topExpenseCategories.map((x) => x.category)).toEqual(['food_parent', 'shopping']);
    expect(vm.budgets[0]).toMatchObject({ category: 'food', actual: '30', remaining: '70' });

    const ledger = buildAccountLedger(s, s.ids.bank, s.ids.gbp);
    expect(ledger[0]?.amount).toBe('-100');
    expect(ledger.some((r) => r.categoryLabel === '转账')).toBe(true);
  });

  it('freezes the budget currency and reports missing conversion rates', () => {
    const s = makeSnapshot();
    const jpy = { ...s.assets[0]!, id: 'asset-jpy', code: 'JPY', name: '日元', symbol: '¥', decimals: 0 };
    s.assets.push(jpy);
    s.priceMarks.push({ ...s.priceMarks[0]!, id: 'mark-jpy', assetId: s.ids.gbp, quoteAssetId: jpy.id, price: '200' });
    s.budgetCategories = [{
      id: 'b-food-jpy', month: '2026-03', category: 'food', plannedAmount: '100000', assetId: jpy.id,
      rolloverMode: 'none', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    }];
    s.transactions = [makeTransaction({ type: 'expense', category: 'food', amount: '20000', assetId: jpy.id })];

    const converted = buildTransactions(s, { range: 'this_month', type: 'all', category: 'all', accountId: 'all', search: '' });
    expect(converted.budgets[0]).toMatchObject({ planned: '500', actual: '100', remaining: '400', plannedNative: '¥100,000', conversionKnown: true });
    expect(converted.missingRateAssetCodes).toEqual([]);

    s.priceMarks = s.priceMarks.filter((row) => row.id !== 'mark-jpy');
    const missing = buildTransactions(s, { range: 'this_month', type: 'all', category: 'all', accountId: 'all', search: '' });
    expect(missing.budgets[0]?.conversionKnown).toBe(false);
    expect(missing.missingRateAssetCodes).toEqual(['JPY']);
  });

  it('applies inclusive custom start and end dates', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ date: '2026-03-01' }),
      makeTransaction({ date: '2026-03-02' }),
      makeTransaction({ date: '2026-03-03' }),
      makeTransaction({ date: '2026-03-04' }),
    ];
    const rows = buildFilteredTransactions(s, { range: 'custom', dateFrom: '2026-03-02', dateTo: '2026-03-03', type: 'all', category: 'all', accountId: 'all', search: '' });
    expect(rows.map((row) => row.date)).toEqual(['2026-03-03', '2026-03-02']);
  });

  it('keeps the opening balance when an account ledger is date-filtered', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ date: '2026-01-01', type: 'income', category: 'salary', amount: '100', accountId: s.ids.bank, assetId: s.ids.gbp }),
      makeTransaction({ date: '2026-02-01', type: 'expense', category: 'food', amount: '20', accountId: s.ids.bank, assetId: s.ids.gbp }),
      makeTransaction({ date: '2026-03-01', type: 'expense', category: 'food', amount: '5', accountId: s.ids.bank, assetId: s.ids.gbp }),
    ];
    const rows = buildAccountLedger(s, s.ids.bank!, s.ids.gbp, { from: '2026-02-01', to: '2026-02-28' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.balance).toBe('80');
  });

  it('derives partial and full reconciliation for both sides of a transfer', () => {
    const s = makeSnapshot();
    const transfer = makeTransaction({
      id: 'transfer',
      type: 'transfer',
      category: 'shopping',
      amount: '100',
      assetId: s.ids.gbp,
      accountId: s.ids.bank,
      transferAmount: '100',
      transferAssetId: s.ids.gbp,
      transferAccountId: s.ids.cash,
    });
    s.transactions = [transfer];
    s.reconciliationSessions = [{
      id: 'bank-session',
      accountId: s.ids.bank,
      assetId: s.ids.gbp,
      statementDate: '2026-03-31',
      statementBalance: '-100',
      openingBalance: '0',
      selectedTotal: '-100',
      clearedBalance: '-100',
      difference: '0',
      status: 'closed',
      closedAt: '2026-04-01T00:00:00.000Z',
      createdAt: '',
      updatedAt: '',
      version: 1,
      isDeleted: false,
    }];
    s.reconciliationItems = [{
      id: 'bank-item',
      reconciliationId: 'bank-session',
      transactionId: transfer.id,
      accountId: s.ids.bank,
      assetId: s.ids.gbp,
      postingAmount: '-100',
      previousStatus: 'cleared',
      selectedAt: '2026-04-01T00:00:00.000Z',
      createdAt: '',
      updatedAt: '',
      version: 1,
      isDeleted: false,
    }];
    expect(transactionReconciliationCoverage(s, transfer)).toBe('partial');

    s.reconciliationSessions.push({
      ...s.reconciliationSessions[0]!,
      id: 'cash-session',
      accountId: s.ids.cash,
      statementBalance: '100',
      selectedTotal: '100',
      clearedBalance: '100',
    });
    s.reconciliationItems.push({
      ...s.reconciliationItems[0]!,
      id: 'cash-item',
      reconciliationId: 'cash-session',
      accountId: s.ids.cash,
      postingAmount: '100',
    });
    expect(transactionReconciliationCoverage(s, transfer)).toBe('full');
  });

  it('expands monthly bills from the original month-end anchor', () => {
    const s = makeSnapshot();
    s.scheduledTransactions = [{
      id: 'bill', name: '月末账单', type: 'expense', category: 'food', amount: '10', assetId: s.ids.gbp!,
      frequency: 'monthly', anchorDate: '2026-01-31', anchorMode: 'month_end', time: '09:00', timezone: 'Asia/Shanghai',
      catchUpPolicy: 'all', autoCreate: false, status: 'active',
      createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    }];
    const rows = buildScheduleOccurrences(s, { from: '2026-02-01', to: '2026-04-30' });
    expect(rows.map((row) => row.date)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('carries positive and signed budget balances across consecutive months', () => {
    const s = makeSnapshot();
    const budget = (id: string, month: string, rolloverMode: 'none' | 'positive_only' | 'signed') => ({
      id, month, category: 'food', plannedAmount: '100', assetId: s.ids.gbp, rolloverMode,
      createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    });
    s.budgetCategories = [
      budget('jan', '2026-01', 'positive_only'),
      budget('feb', '2026-02', 'positive_only'),
      budget('mar', '2026-03', 'signed'),
      budget('apr', '2026-04', 'signed'),
    ];
    s.transactions = [
      makeTransaction({ date: '2026-01-10', type: 'expense', category: 'food', amount: '60', assetId: s.ids.gbp }),
      makeTransaction({ date: '2026-02-10', type: 'expense', category: 'food', amount: '120', assetId: s.ids.gbp }),
      makeTransaction({ date: '2026-03-10', type: 'expense', category: 'food', amount: '150', assetId: s.ids.gbp }),
    ];

    expect(buildBudgetMonth(s, '2026-02')[0]).toMatchObject({ carryIn: '40', available: '140', actual: '120', remaining: '20', carryOut: '20' });
    expect(buildBudgetMonth(s, '2026-04')[0]).toMatchObject({ carryIn: '-30', available: '70', actual: '0', remaining: '70', carryOut: '70' });
  });
});

describe('ledger mode forms', () => {
  it('keeps spending mode focused on income and expenses', () => {
    const s = makeSnapshot();
    s.setting!.ledgerMode = 'spending';

    const tx = transactionForm(s);
    const txKeys = tx.fields.map((f) => f.key);
    const txTypes = optionsOf(tx.fields.find((f) => f.key === 'type')!).map((o) => o.value);
    expect(txKeys).not.toContain('accountId');
    expect(txKeys).not.toContain('transferAccountId');
    expect(txKeys).not.toContain('status');
    expect(txKeys).toContain('time');
    expect(txKeys).toContain('timezone');
    expect(txKeys).toContain('locationId');
    expect(txKeys).toContain('tagIds');
    expect(txKeys).toContain('attachmentDrafts');
    expect(txKeys).toContain('latitude');
    expect(txKeys).toContain('longitude');
    expect(tx.fields.find((f) => f.key === 'attachmentDrafts')).toMatchObject({ capture: 'environment' });
    expect(tx.fields.find((f) => f.key === 'locationName')).toMatchObject({ deviceAction: 'current-location' });
    expect(tx.fields.find((f) => f.key === 'latitude')).toMatchObject({ hidden: true });
    expect(txTypes).toEqual(['expense', 'income', 'refund']);

    const bill = scheduledTransactionForm(s);
    const billKeys = bill.fields.map((f) => f.key);
    const billTypes = optionsOf(bill.fields.find((f) => f.key === 'type')!).map((o) => o.value);
    expect(billKeys).not.toContain('accountId');
    expect(billKeys).not.toContain('transferAmount');
    expect(billTypes).toEqual(['expense', 'income']);

    expect(payeeForm(s).fields.map((f) => f.key)).not.toContain('defaultAccountId');
  });

  it('provides a full accountless expense form for the daily-expense entry', () => {
    const s = makeSnapshot();
    s.setting!.ledgerMode = 'spending';
    delete s.setting!.transactionFormOptionalFields;

    const tx = transactionForm(s, { usesAccounts: false, expenseOnly: true });
    const typeField = tx.fields.find((field) => field.key === 'type')!;
    const categoryField = tx.fields.find((field) => field.key === 'category')!;

    expect(tx.title).toBe('日常支出');
    expect(typeField).toMatchObject({ hidden: true, defaultValue: 'expense' });
    expect(optionsOf(typeField).map((option) => option.value)).toEqual(['expense']);
    expect(optionsOf(categoryField, { type: 'income' }).map((option) => option.value)).toContain('food');
    expect(optionsOf(categoryField, { type: 'income' }).map((option) => option.value)).not.toContain('salary');
    expect(tx.fields.map((field) => field.key)).toEqual(expect.arrayContaining([
      'date', 'time', 'category', 'amount', 'assetId', 'description', 'attachmentDrafts',
      'merchant', 'locationName', 'tagIds', 'note',
    ]));
    expect(optionalTransactionFields(s.setting, false)).toEqual(COMMON_TRANSACTION_FORM_FIELDS);
    expect(tx.fromValues({
      date: '2026-09-01',
      time: '12:30',
      timezone: 'Asia/Shanghai',
      type: 'income',
      category: 'food',
      amount: '18.80',
      assetId: s.ids.gbp,
      description: '午餐',
    }).type).toBe('expense');

    s.setting!.transactionFormOptionalFields = '';
    expect(optionalTransactionFields(s.setting, false)).toEqual([]);
  });

  it('asks for a refund offset only when the refund settles in another asset', () => {
    const s = makeSnapshot();
    s.setting!.ledgerMode = 'accounts';
    const original = makeTransaction({ id: 'orig', date: '2026-03-03', type: 'expense', category: 'food', amount: '100', assetId: s.ids.gbp });
    s.transactions = [original];
    const spec = transactionForm(s, { refundMode: true, refundRemaining: '100' });
    const field = spec.fields.find((f) => f.key === 'refundAppliedAmount')!;

    // 同币种：到账金额就是冲减金额，字段不出现，也不会把第二个数写进实体。
    expect(field.visibleWhen!({ refundForId: original.id, assetId: s.ids.gbp })).toBe(false);
    expect(spec.fromValues({
      date: '2026-03-04', type: 'refund', category: 'food', amount: '30',
      assetId: s.ids.gbp, refundForId: original.id, refundAppliedAmount: '100',
    }).refundAppliedAmount).toBeUndefined();

    // 换币种后必须显式给出按原支出币种计量的冲减额。
    expect(field.visibleWhen!({ refundForId: original.id, assetId: s.ids.btc })).toBe(true);
    expect(field.required).toBe(true);
    expect(spec.fromValues({
      date: '2026-03-04', type: 'refund', category: 'food', amount: '0.001',
      assetId: s.ids.btc, refundForId: original.id, refundAppliedAmount: '70',
    }).refundAppliedAmount).toBe('70');

    // 没关联原支出（例如普通流水）时同样不出现。
    expect(field.visibleWhen!({ assetId: s.ids.gbp })).toBe(false);
  });

  it('tells the refund form how much is still refundable', () => {
    const s = makeSnapshot();
    const withRemaining = transactionForm(s, { refundMode: true, refundRemaining: '42' });
    const withoutRemaining = transactionForm(s, { refundMode: true });
    expect(withRemaining.fields.find((f) => f.key === 'amount')!.hint).toContain('剩余可退 42');
    // 非退款表单不该拿到退款提示。
    expect(withoutRemaining.fields.find((f) => f.key === 'amount')!.hint).toBeUndefined();
  });

  it('uses leaf categories and exposes template tags and locations', () => {
    const s = makeSnapshot();
    s.categories.push({ id: 'daily', name: '日常消费', type: 'expense', createdAt: '', updatedAt: '', version: 1, isDeleted: false, isActive: true, sortOrder: 1 });
    s.categories = s.categories.map((c) => c.id === 'food' ? { ...c, parentId: 'daily' } : c);

    const categoryField = transactionForm(s).fields.find((f) => f.key === 'category')!;
    const expenseOptions = optionsOf(categoryField, { type: 'expense' });
    const incomeOptions = optionsOf(categoryField, { type: 'income' });
    expect(expenseOptions.map((o) => o.value)).not.toContain('daily');
    expect(expenseOptions.find((o) => o.value === 'food')?.label).toBe('日常消费 / 餐饮/正餐');
    expect(incomeOptions.map((o) => o.value)).toContain('salary');
    expect(incomeOptions.map((o) => o.value)).not.toContain('food');
    expect(categoryOptions(s.categories, 'expense', { leafOnly: true }).map((o) => o.value)).not.toContain('pet_medical');
    expect(expenseOptions.find((o) => o.value === 'pet_medical')).toMatchObject({
      label: '居家生活 / 宠物医疗',
      hidden: true,
    });
    s.categories.push({ id: 'pet_medical', name: '宠物医疗', type: 'expense', parentId: 'expense_home', createdAt: '', updatedAt: '', version: 1, isDeleted: false, isActive: true, isHidden: false, sortOrder: 149 });
    expect(categoryOptions(s.categories, 'expense', { leafOnly: true }).map((o) => o.value)).toContain('pet_medical');
    expect(categoryForm(s).fields.map((f) => f.key)).toContain('isHidden');

    const tplKeys = transactionTemplateForm(s).fields.map((f) => f.key);
    expect(tplKeys).toContain('tagIds');
    expect(tplKeys).toContain('locationId');
  });

  it('applies the synced default category scope to every bookkeeping form', () => {
    const s = makeSnapshot();
    const categoryScopes = () => [
      transactionForm(s),
      transactionTemplateForm(s),
      payeeForm(s),
      transactionSplitForm(s),
      budgetCategoryForm(s),
      scheduledTransactionForm(s),
    ].flatMap((spec) => spec.fields.filter((field) => field.type === 'category').map((field) => field.categoryShowHiddenDefault));

    s.setting!.categoryPickerDefaultScope = 'frequent';
    expect(categoryScopes()).toEqual([false, false, false, false, false, false]);

    s.setting!.categoryPickerDefaultScope = 'all';
    expect(categoryScopes()).toEqual([true, true, true, true, true, true]);
  });

  it('keeps categories a disabled extension pack left behind queryable', () => {
    const s = makeSnapshot();
    // 停用扩展包会同时写 isActive:false 与 isHidden:true；这里补一个目录里的扩展分类。
    const disabled = {
      ...systemCategory('pet_medical', false)!,
      isActive: false,
      isHidden: true,
      archivedAt: '2026-09-01T00:00:00.000Z',
      archiveReason: '系统分类包停用',
    } as Category;
    // 从未用过的停用成员：同样进读路径选项池（页面快照不持有全部流水，无法区分
    // 用没用过），但它们带 hidden，默认列表里不占位置。
    const unusedDisabled = {
      ...systemCategory('pet_supplies', false)!,
      isActive: false,
      isHidden: true,
      archivedAt: '2026-09-01T00:00:00.000Z',
      archiveReason: '系统分类包停用',
    } as Category;
    s.categories = [...s.categories, disabled, unusedDisabled];

    const pet = makeTransaction({ id: 'tx-pet', date: '2026-03-04', category: 'pet_medical', amount: '50', assetId: s.ids.gbp });
    const split = makeTransaction({ id: 'tx-split', date: '2026-03-05', category: 'food', amount: '40', assetId: s.ids.gbp });
    const deleted = makeTransaction({ id: 'tx-deleted', date: '2026-03-06', category: 'pet_medical', amount: '70', assetId: s.ids.gbp, isDeleted: true });
    s.transactions = [pet, split, deleted];
    s.transactionSplits = [
      { id: 'sp-pet', transactionId: split.id, category: 'pet_medical', amount: '40', createdAt: '', updatedAt: '', version: 1, isDeleted: false },
    ];

    // 读路径：停用的分类也要进选项池，否则旧流水就筛不着了。
    const values = historicalCategoryValueOptions(s).map((o) => o.value);
    expect(values).toContain('pet_medical');
    // 从未用过的停用分类同样进池（页面快照不持有全部流水，无法区分）；
    // 它们跟“隐藏”一样要先搜索或开“显示隐藏”才出现，不占默认列表。
    expect(values).toContain('pet_supplies');
    expect(historicalCategoryValueOptions(s).find((o) => o.value === 'pet_medical'))
      .toMatchObject({ inactive: true, hidden: true });

    // 目录里尚未写入账本的分类依旧不得出现（选了必然空结果）。
    expect(values).not.toContain('ktv');

    // 写路径（记账表单）仍然选不到停用分类。
    const entryOptions = optionsOf(transactionForm(s).fields.find((f) => f.key === 'category')!, { type: 'expense' });
    expect(entryOptions.some((o) => o.value === 'pet_medical')).toBe(false);

    // 选中的停用分类仍能筛出它自己的流水。
    s.transactionSplits = [];
    const filtered = buildFilteredTransactions(s, {
      range: 'all', type: 'all', category: 'pet_medical', accountId: 'all', search: '',
    });
    expect(filtered.map((t) => t.id)).toEqual([pet.id]);
  });

  it('keeps account ledger fields available in account mode', () => {
    const s = makeSnapshot();
    s.setting!.ledgerMode = 'accounts';

    const txKeys = transactionForm(s).fields.map((f) => f.key);
    expect(txKeys).toContain('accountId');
    expect(txKeys).toContain('transferAccountId');
    expect(txKeys).toContain('status');
    expect(optionsOf(transactionForm(s).fields.find((f) => f.key === 'type')!).map((o) => o.value)).toContain('transfer');
    expect(payeeForm(s).fields.map((f) => f.key)).toContain('defaultAccountId');
  });

  it('filters game record seasons and accounts by the selected game', () => {
    const s = makeSnapshot();
    s.games.push({ id: 'game-b', name: 'B', enableSeason: true, createdAt: '', updatedAt: '', version: 1, isDeleted: false });
    s.seasons.push({ id: 'season-b', gameId: 'game-b', name: 'B-S1', status: 'active', createdAt: '', updatedAt: '', version: 1, isDeleted: false });
    s.gameAccounts.push({ id: 'account-a', gameId: s.ids.game, accountName: 'A-main', status: 'active', createdAt: '', updatedAt: '', version: 1, isDeleted: false });
    s.gameAccounts.push({ id: 'account-b', gameId: 'game-b', accountName: 'B-main', status: 'active', createdAt: '', updatedAt: '', version: 1, isDeleted: false });
    const form = gameRecordForm(s);
    const seasons = optionsOf(form.fields.find((field) => field.key === 'seasonId')!, { gameId: 'game-b' });
    const accounts = optionsOf(form.fields.find((field) => field.key === 'gameAccountId')!, { gameId: 'game-b' });
    expect(seasons.map((option) => option.value)).toEqual(['season-b']);
    expect(accounts.map((option) => option.value)).toEqual(['account-b']);
  });

  it('keeps game cashflow accountless in spending mode and requires accounts in deeper modes', () => {
    const spending = makeSnapshot();
    spending.setting!.ledgerMode = 'spending';
    const spendingForm = gameRecordForm(spending);
    const spendingAccount = spendingForm.fields.find((field) => field.key === 'settlementAccountId')!;
    expect(spendingAccount.required).toBe(false);
    expect(spendingAccount.visibleWhen?.({ settlementCashflowMode: 'create_transaction' })).toBe(false);
    expect(spendingForm.validate?.({
      gameId: spending.ids.game,
      recordType: 'withdraw',
      settlementAssetId: spending.ids.gbp,
      settlementAmount: '10',
      settlementCashflowMode: 'create_transaction',
      settlementCategoryId: 'income-leaf',
    })).toBeUndefined();

    for (const ledgerMode of ['accounts', 'assets'] as const) {
      const deeper = makeSnapshot();
      deeper.setting!.ledgerMode = ledgerMode;
      const deeperForm = gameRecordForm(deeper);
      const account = deeperForm.fields.find((field) => field.key === 'settlementAccountId')!;
      expect(account.required).toBe(true);
      expect(account.visibleWhen?.({ settlementCashflowMode: 'create_transaction' })).toBe(true);
      expect(deeperForm.validate?.({
        gameId: deeper.ids.game,
        recordType: 'withdraw',
        settlementAssetId: deeper.ids.gbp,
        settlementAmount: '10',
        settlementCashflowMode: 'create_transaction',
        settlementCategoryId: 'income-leaf',
      })).toMatchObject({ settlementAccountId: '请选择结算账户' });
    }
  });
});

/*
 * 本月支出构成：环图的数据源。它必须与 KPI 卡的 Top3 同源、各段占比相加为 1，
 * 并且把长尾折进「其他」——否则环里会出现几个 2% 的切片，既点不中也没人读。
 */
describe('expense composition', () => {
  const monthFilters = (overrides: Partial<TransactionFilters> = {}): TransactionFilters => ({
    range: 'this_month', type: 'all', category: 'all', accountId: 'all', search: '', ...overrides,
  });

  /** Seven expense categories, biggest first: c1=70 … c7=10. */
  function sevenCategories() {
    const s = makeSnapshot();
    for (let index = 1; index <= 7; index += 1) {
      s.categories.push({ ...s.categories[0]!, id: `c${index}`, name: `分类 ${index}`, parentId: undefined, sortOrder: 100 + index });
    }
    s.transactions = Array.from({ length: 7 }, (_, index) => makeTransaction({
      id: `tx-${index + 1}`, date: '2026-03-03', type: 'expense', category: `c${index + 1}`,
      amount: String(70 - index * 10), assetId: s.ids.gbp,
    }));
    return s;
  }

  it('folds every category past the fifth into 其他', () => {
    const vm = buildTransactions(sevenCategories(), monthFilters());
    expect(vm.expenseComposition.slices.map((row) => row.category)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    // Removing the fold would leave this at 0 and the ring short of a full circle.
    expect(vm.expenseComposition.others).toMatchObject({ amount: '30', count: 2 });
    expect(vm.expenseComposition.total).toBe('280');
    expect(vm.expenseComposition.slices.length + vm.expenseComposition.others.count).toBe(7);
    const painted = vm.expenseComposition.slices.reduce((total, row) => total + row.weight, 0) + vm.expenseComposition.others.weight;
    expect(painted).toBeCloseTo(1, 10);
    // The KPI card slices the same list, so the two can never disagree.
    expect(vm.topExpenseCategories.map((row) => row.category)).toEqual(['c1', 'c2', 'c3']);
  });

  it('builds the same composition from the aggregate rows the KPI card reads', () => {
    const s = sevenCategories();
    s.transactions = [];
    const aggregates = Array.from({ length: 7 }, (_, index) => ({
      reportDate: '2026-03-03',
      reportAssetId: s.ids.gbp,
      direction: 'expense' as const,
      category: `c${index + 1}`,
      amounts: [String(70 - index * 10)],
      count: 1,
    }));
    const page = { ...s, transactions: [], transactionSplits: [], refundAllocations: [], attachments: [], reconciliationItems: [], reconciliationSessions: [] };
    const vm = buildTransactionsFromReadModel(s, monthFilters(), {
      page, summaryAggregates: aggregates, filteredAggregates: aggregates, filteredCount: 7,
    });
    expect(vm.expenseComposition.slices.map((row) => row.category)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(vm.expenseComposition.others).toMatchObject({ amount: '30', count: 2 });
    expect(vm.topExpenseCategories.map((row) => row.category)).toEqual(['c1', 'c2', 'c3']);
  });

  it('has no 其他 bucket when the month fits in the ring', () => {
    const s = makeSnapshot();
    s.transactions = [makeTransaction({ id: 'only', date: '2026-03-03', category: 'food', amount: '30', assetId: s.ids.gbp })];
    const vm = buildTransactions(s, monthFilters());
    expect(vm.expenseComposition.slices.map((row) => row.category)).toEqual(['food_parent']);
    expect(vm.expenseComposition.slices[0]?.weight).toBe(1);
    expect(vm.expenseComposition.others).toEqual({ amount: '0', count: 0, weight: 0 });
    expect(vm.expenseComposition.total).toBe('30');
    // 一个板块只画一段，且它自己的名字不带「父 / 子」前缀——环已经是嵌套读法。
    expect(vm.expenseComposition.slices[0]?.label).toBe('餐饮');
  });

  it('filters by 板块 with parentCategory, on top of any 二级 filter', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ id: 'lunch', date: '2026-03-03', category: 'food', amount: '20', assetId: s.ids.gbp }),
      makeTransaction({ id: 'metro', date: '2026-03-03', category: 'transport', amount: '8', assetId: s.ids.gbp }),
      makeTransaction({ id: 'shop', date: '2026-03-03', category: 'shopping', amount: '100', assetId: s.ids.gbp }),
    ];

    // 只按板块：板块下所有二级都进来（这里 `food` 是 `food_parent` 的子级）。
    const byParent = buildTransactions(s, monthFilters({ parentCategory: 'food_parent' }));
    expect(byParent.items.map((row) => row.tx.id)).toEqual(['lunch']);

    // 板块 + 细分：两个条件同时生效。
    const byBoth = buildTransactions(s, monthFilters({ parentCategory: 'food_parent', category: 'food' }));
    expect(byBoth.items.map((row) => row.tx.id)).toEqual(['lunch']);

    // 板块对、细分不属于它：空结果，而不是“忽略其中一个条件”。
    const mismatched = buildTransactions(s, monthFilters({ parentCategory: 'food_parent', category: 'transport' }));
    expect(mismatched.items).toEqual([]);
  });

  it('stays empty rather than inventing a slice for an empty month', () => {
    const vm = buildTransactions(makeSnapshot(), monthFilters());
    expect(vm.expenseComposition).toEqual({ slices: [], others: { amount: '0', count: 0, weight: 0 }, total: '0' });
    expect(vm.expenseChildren).toEqual({});
  });

  /*
   * 为什么要按一级聚合：把一个板块的钱拆成几段小钱后，每一段都输给别的板块里的
   * 单个大项，于是「当月最大的板块」可能一段都不在环上——环就答不了它该答的问题。
   */
  it('keeps the biggest 板块 in the ring even when its money sits in many small children', () => {
    const s = makeSnapshot();
    s.categories.push(
      { id: 'health_parent', name: '医疗', type: 'expense', isActive: true, sortOrder: 40, createdAt: '', updatedAt: '', version: 1, isDeleted: false } as never,
      { id: 'med', name: '就医', type: 'expense', parentId: 'health_parent', isActive: true, sortOrder: 41, createdAt: '', updatedAt: '', version: 1, isDeleted: false } as never,
    );
    s.transactions = [
      // 餐饮：六笔小额，归属同一板块，合计 300（当月最大）。
      ...['groceries', 'takeaway', 'coffee_drinks', 'snacks_fruit', 'dining_out', 'other_food'].map((id, index) =>
        makeTransaction({ id: `food-${index}`, date: '2026-03-03', category: 'food', amount: '50', assetId: s.ids.gbp })),
      makeTransaction({ id: 'med', date: '2026-03-03', category: 'med', amount: '200', assetId: s.ids.gbp }),
      makeTransaction({ id: 'shop', date: '2026-03-03', category: 'shopping', amount: '100', assetId: s.ids.gbp }),
    ];

    const vm = buildTransactions(s, monthFilters());
    expect(vm.expenseComposition.slices.map((row) => row.category)).toEqual(['food_parent', 'health_parent', 'shopping']);
    expect(vm.expenseComposition.slices[0]).toMatchObject({ amount: '300', label: '餐饮' });
    expect(vm.expenseComposition.slices[0]?.weight).toBeCloseTo(0.5, 10);
    // 按二级画的话，最大的一段只有 200，排在别的板块的小项后面——这就是要避免的。
    expect(vm.expenseComposition.total).toBe('600');
  });

  it('gives every 板块 its own children, summing back to its slice', () => {
    const s = makeSnapshot();
    s.categories.push(
      { id: 'health_parent', name: '医疗', type: 'expense', isActive: true, sortOrder: 40, createdAt: '', updatedAt: '', version: 1, isDeleted: false } as never,
      { id: 'med', name: '就医', type: 'expense', parentId: 'health_parent', isActive: true, sortOrder: 41, createdAt: '', updatedAt: '', version: 1, isDeleted: false } as never,
    );
    s.transactions = [
      makeTransaction({ id: 'lunch', date: '2026-03-03', category: 'food', amount: '70', assetId: s.ids.gbp }),
      makeTransaction({ id: 'med', date: '2026-03-03', category: 'med', amount: '200', assetId: s.ids.gbp }),
      makeTransaction({ id: 'shop', date: '2026-03-03', category: 'shopping', amount: '100', assetId: s.ids.gbp }),
    ];

    const vm = buildTransactions(s, monthFilters());
    const parent = vm.expenseChildren.health_parent!;
    expect(parent.slices.map((row) => row.category)).toEqual(['med']);
    expect(parent.total).toBe('200');
    // 右环的分母只是它自己那个板块，所以这一段占满整圈——不是全月的 200/370。
    expect(parent.slices[0]?.weight).toBe(1);
    expect(vm.expenseChildren.food_parent?.total).toBe('70');
    expect(vm.expenseChildren.shopping?.total).toBe('100');
    // 两个环必然对得上：各板块的二级构成之和 = 左环那一段的金额。
    for (const slice of vm.expenseComposition.slices) {
      expect(vm.expenseChildren[slice.category]?.total).toBe(slice.amount);
    }
  });

  it('filters by 板块 with parentCategory, on top of any 二级 filter', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ id: 'lunch', date: '2026-03-03', category: 'food', amount: '20', assetId: s.ids.gbp }),
      makeTransaction({ id: 'metro', date: '2026-03-03', category: 'transport', amount: '8', assetId: s.ids.gbp }),
      makeTransaction({ id: 'shop', date: '2026-03-03', category: 'shopping', amount: '100', assetId: s.ids.gbp }),
    ];

    // 只按板块：板块下所有二级都进来（这里 `food` 是 `food_parent` 的子级）。
    const byParent = buildTransactions(s, monthFilters({ parentCategory: 'food_parent' }));
    expect(byParent.items.map((row) => row.tx.id)).toEqual(['lunch']);

    // 板块 + 细分：两个条件同时生效。
    const byBoth = buildTransactions(s, monthFilters({ parentCategory: 'food_parent', category: 'food' }));
    expect(byBoth.items.map((row) => row.tx.id)).toEqual(['lunch']);

    // 板块对、细分不属于它：空结果，而不是“忽略其中一个条件”。
    const mismatched = buildTransactions(s, monthFilters({ parentCategory: 'food_parent', category: 'transport' }));
    expect(mismatched.items).toEqual([]);
  });

  it('leaves unconvertible spending out of both the slices and the total', () => {
    const s = makeSnapshot();
    const jpy = { ...s.assets[0]!, id: 'asset-jpy', code: 'JPY', name: '日元', symbol: '¥', decimals: 0 };
    s.assets.push(jpy);
    s.priceMarks.push({ ...s.priceMarks[0]!, id: 'mark-jpy', assetId: s.ids.gbp, quoteAssetId: jpy.id, price: '200' });
    s.transactions = [
      makeTransaction({ id: 'gbp-food', date: '2026-03-03', category: 'food', amount: '60', assetId: s.ids.gbp }),
      makeTransaction({ id: 'jpy-food', date: '2026-03-03', category: 'food', amount: '20000', assetId: jpy.id }),
    ];
    expect(buildTransactions(s, monthFilters()).expenseComposition.total).toBe('160');

    s.priceMarks = s.priceMarks.filter((row) => row.id !== 'mark-jpy');
    const missing = buildTransactions(s, monthFilters());
    expect(missing.missingRateAssetCodes).toEqual(['JPY']);
    // 60 is the whole of it: the rate-less row is neither counted as 0 nor painted.
    expect(missing.expenseComposition.total).toBe('60');
    expect(missing.expenseComposition.slices[0]?.weight).toBe(1);
  });

  it('widens the trend window without touching the month KPIs', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ id: 'old', date: '2025-06-10', category: 'food', amount: '5', assetId: s.ids.gbp }),
      makeTransaction({ id: 'recent', date: '2026-03-03', category: 'food', amount: '7', assetId: s.ids.gbp }),
    ];
    const six = buildTransactions(s, monthFilters());
    expect(six.trend).toHaveLength(6);
    expect(six.trend.some((row) => row.month === '2025-06')).toBe(false);

    const twelve = buildTransactions(s, monthFilters(), 12);
    expect(twelve.trend).toHaveLength(12);
    expect(twelve.trend[0]?.month).toBe('2025-04');
    expect(twelve.trend.at(-1)?.month).toBe('2026-03');
    expect(round(twelve.trend.find((row) => row.month === '2025-06')?.expense ?? '0', 2)).toBe('5.00');
    // The current-month figures come from the same read, so widening it is not a filter.
    expect(twelve.expense).toBe(six.expense);
    expect(twelve.income).toBe(six.income);
  });
});
