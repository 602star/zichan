import { describe, expect, it } from 'vitest';
import {
  assertTransactionShape,
  categoryTrend,
  monthlyCashFlow,
  postingsFromTransaction,
  round,
  summarizeByCategory,
  transactionReportingEffect,
  type RefundAllocation,
  type Transaction,
} from '../src/index.js';

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: overrides.id ?? `tx-${Math.random()}`,
    createdAt: '',
    updatedAt: '',
    version: 1,
    isDeleted: false,
    date: '2026-03-01',
    type: 'expense',
    category: 'food',
    amount: '0',
    assetId: 'GBP',
    ...overrides,
  } as Transaction;
}

describe('daily transactions', () => {
  it('generates signed postings from income and expense', () => {
    const income = postingsFromTransaction(tx({ id: 'salary', type: 'income', category: 'salary', amount: '3200' }));
    const expense = postingsFromTransaction(tx({ id: 'food', type: 'expense', category: 'food', amount: '28.50', accountId: 'cash' }));

    expect(income).toMatchObject([{ amount: '3200', assetId: 'GBP', source: { kind: 'transaction', id: 'salary' } }]);
    expect(expense).toMatchObject([{ amount: '-28.5', assetId: 'GBP', accountId: 'cash', source: { kind: 'transaction', id: 'food' } }]);
  });

  it('moves money between accounts for transfers without cashflow impact', () => {
    const transfer = tx({
      id: 'cash-out',
      type: 'transfer',
      amount: '120',
      accountId: 'bank',
      transferAccountId: 'cash',
      transferAssetId: 'GBP',
      transferAmount: '120',
    });
    expect(postingsFromTransaction(transfer)).toMatchObject([
      { amount: '-120', assetId: 'GBP', accountId: 'bank' },
      { amount: '120', assetId: 'GBP', accountId: 'cash' },
    ]);
    const flow = monthlyCashFlow([transfer]);
    expect(flow).toEqual([]);
  });

  it('summarizes by category and ignores deleted rows', () => {
    const summary = summarizeByCategory([
      tx({ category: 'food', amount: '12' }),
      tx({ category: 'food', amount: '18' }),
      tx({ category: 'salary', type: 'income', amount: '3000' }),
      tx({ category: 'food', amount: '99', isDeleted: true }),
    ]);

    const food = summary.find((s) => s.category === 'food')!;
    expect(food.count).toBe(2);
    expect(round(food.totalAmount, 2)).toBe('30.00');
    expect(round(food.avgAmount, 2)).toBe('15.00');
  });

  it('uses split rows for category summaries', () => {
    const parent = tx({ id: 'market', category: 'shopping', amount: '50' });
    const summary = summarizeByCategory([parent], {
      splits: [
        { id: 's1', transactionId: parent.id, category: 'food', amount: '30', createdAt: '', updatedAt: '', version: 1, isDeleted: false },
        { id: 's2', transactionId: parent.id, category: 'shopping', amount: '20', createdAt: '', updatedAt: '', version: 1, isDeleted: false },
      ],
    });
    expect(summary.find((s) => s.category === 'food')?.totalAmount).toBe('30');
    expect(summary.find((s) => s.category === 'shopping')?.totalAmount).toBe('20');
  });

  it('computes monthly cash flow', () => {
    const rows = monthlyCashFlow([
      tx({ date: '2026-02-20', type: 'expense', category: 'shopping', amount: '80' }),
      tx({ date: '2026-03-01', type: 'income', category: 'salary', amount: '3000' }),
      tx({ date: '2026-03-02', type: 'expense', category: 'food', amount: '35.25' }),
      tx({ date: '2026-03-03', type: 'expense', category: 'transport', amount: '12.75' }),
    ]);

    expect(rows.map((r) => r.month)).toEqual(['2026-02', '2026-03']);
    const march = rows[1]!;
    expect(round(march.income, 2)).toBe('3000.00');
    expect(round(march.expense, 2)).toBe('48.00');
    expect(round(march.net, 2)).toBe('2952.00');
  });

  it('builds recent category trend in chronological order', () => {
    const trend = categoryTrend([
      tx({ date: '2026-01-05', category: 'food', amount: '10' }),
      tx({ date: '2026-02-05', category: 'food', amount: '20' }),
      tx({ date: '2026-03-05', category: 'food', amount: '30' }),
      tx({ date: '2026-03-06', category: 'transport', amount: '99' }),
    ], 'food', { months: 2 });

    expect(trend).toEqual([
      { month: '2026-02', amount: '20', count: 1 },
      { month: '2026-03', amount: '30', count: 1 },
    ]);
  });

  it('checks currencies only for rows in the requested category', () => {
    const rows = [
      tx({ id: 'food-gbp', category: 'food', amount: '10', assetId: 'GBP' }),
      tx({ id: 'travel-usd', category: 'travel', amount: '20', assetId: 'USD' }),
      tx({ id: 'balance-usd', category: 'food', amount: '30', assetId: 'USD', reportingTreatment: 'balance_only' }),
    ];
    expect(categoryTrend(rows, 'food')).toEqual([{ month: '2026-03', amount: '10', count: 1 }]);
    expect(() => categoryTrend([...rows, tx({ id: 'food-usd', category: 'food', amount: '5', assetId: 'USD' })], 'food'))
      .toThrow('禁止跨币种直接汇总');
  });

  it('rejects persisted transaction enum values outside the current model', () => {
    expect(() => assertTransactionShape(tx({ status: 'reconciled' as never }))).toThrow('流水状态无效');
    expect(() => assertTransactionShape(tx({ type: 'chargeback' as never }))).toThrow('流水类型无效');
    expect(() => assertTransactionShape(tx({ reportingTreatment: 'hidden' as never }))).toThrow('流水报表口径无效');
  });

  it('keeps balance-only cash postings out of income and expense reports', () => {
    const sale = tx({ type: 'income', amount: '300', reportingTreatment: 'balance_only' });
    expect(transactionReportingEffect(sale)).toMatchObject({
      cashAmount: '300',
      incomeDelta: '0',
      expenseDelta: '0',
      categoryRows: [],
    });
    expect(postingsFromTransaction(sale)).toMatchObject([{ amount: '300' }]);
  });

  it('uses the refund snapshots for every reporting aggregation', () => {
    const refund = tx({
      id: 'refund',
      date: '2026-04-02',
      type: 'refund',
      category: 'current-category',
      amount: '30',
      assetId: 'USD',
      refundAppliedAmount: '25',
      refundAppliedAssetId: 'GBP',
      refundEffectDate: '2026-03-05',
      refundAttributionMode: 'original_date',
      refundAllocationMode: 'proportional',
    });
    const allocations: RefundAllocation[] = [{
      id: 'allocation',
      createdAt: '',
      updatedAt: '',
      version: 1,
      isDeleted: false,
      refundTransactionId: refund.id,
      sourceTransactionId: 'original',
      categoryId: 'frozen-category',
      categoryPathSnapshot: '餐饮 / 正餐',
      amount: '25',
      assetId: 'GBP',
    }];

    const effect = transactionReportingEffect(refund, { refundAllocations: allocations });
    expect(effect).toMatchObject({
      cashDate: '2026-04-02',
      cashAssetId: 'USD',
      cashAmount: '30',
      reportDate: '2026-03-05',
      reportAssetId: 'GBP',
      incomeDelta: '0',
      expenseDelta: '-25',
    });
    expect(effect.categoryRows).toEqual([expect.objectContaining({ categoryId: 'frozen-category', amount: '25' })]);
    expect(monthlyCashFlow([refund], { baseAssetId: 'GBP', refundAllocations: allocations }))
      .toEqual([{ month: '2026-03', income: '0', expense: '-25', net: '25', transactionCount: 1 }]);
    expect(categoryTrend([refund], 'frozen-category', { baseAssetId: 'GBP', refundAllocations: allocations }))
      .toEqual([{ month: '2026-03', amount: '-25', count: 1 }]);
  });
});
