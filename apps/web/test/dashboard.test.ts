import { describe, it, expect } from 'vitest';
import { round } from '@zichan/core';
import type { DashboardTransactionReadModel } from '@zichan/db';
import { buildDashboard } from '../src/selectors/dashboard.js';
import { makeSnapshot, makeTransaction } from './fixtures.js';

describe('buildDashboard', () => {
  const vm = buildDashboard(makeSnapshot());

  it('net worth = cash + crypto value + fixed valuation', () => {
    // 400 cash (1000 dep − 600 buy) + 700 BTC + 300 fixed = 1400.
    // The game reporting record needs a linked transaction before it affects balances.
    expect(round(vm.netWorth, 2)).toBe('1400.00');
  });

  it('unrealized P&L = crypto value − remaining cost basis', () => {
    // 700 value − 600 cost = 100
    expect(round(vm.unrealized, 2)).toBe('100.00');
  });

  it('invested fiat sums buy/dca chain costs', () => {
    expect(round(vm.investedFiat, 2)).toBe('600.00');
  });

  it('allocation has cash + BTC + fixed buckets, weights sum to 1', () => {
    expect(vm.alloc.map((a) => a.name).sort()).toEqual(['物品资产', '法币现金', 'BTC'].sort());
    const w = vm.alloc.reduce((n, a) => n + a.weight, 0);
    expect(w).toBeCloseTo(1, 6);
  });

  it('season net flows into the KPI', () => {
    expect(round(vm.seasonNet, 2)).toBe('50.00'); // one +£50 sell
  });

  it('activity feed is newest-first and capped at 6', () => {
    expect(vm.activity.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < vm.activity.length; i++) {
      expect(vm.activity[i - 1]!.date >= vm.activity[i]!.date).toBe(true);
    }
  });

  it('summarizes current-month daily cash flow', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ date: '2026-03-01', type: 'income', category: 'salary', amount: '3000', assetId: s.ids.gbp }),
      makeTransaction({ date: '2026-03-02', type: 'expense', category: 'food', amount: '40', assetId: s.ids.gbp }),
      makeTransaction({ date: '2026-02-25', type: 'expense', category: 'shopping', amount: '99', assetId: s.ids.gbp }),
    ];
    const v = buildDashboard(s);
    expect(round(v.txIncome, 2)).toBe('3000.00');
    expect(round(v.txExpense, 2)).toBe('40.00');
    expect(round(v.txNet, 2)).toBe('2960.00');
  });

  it('keeps selector results when transactions come from the bounded SQL read model', () => {
    const s = makeSnapshot();
    const income = makeTransaction({ id: 'income', date: '2026-03-01', type: 'income', category: 'salary', amount: '3000', assetId: s.ids.gbp });
    const expense = makeTransaction({ id: 'expense', date: '2026-03-02', type: 'expense', category: 'food', amount: '40', assetId: s.ids.gbp });
    const older = makeTransaction({ id: 'older', date: '2026-02-25', type: 'expense', category: 'shopping', amount: '99', assetId: s.ids.gbp });
    s.transactions = [expense, income, older];
    const range = { from: '2026-03-01', to: '2026-03-31' };
    const legacy = buildDashboard(s, range);
    const readModel: DashboardTransactionReadModel = {
      balanceAggregates: [{ assetId: s.ids.gbp, amounts: ['3000', '-40', '-99'] }],
      reportAggregates: [
        { reportDate: income.date, reportAssetId: s.ids.gbp, direction: 'income', category: 'salary', amounts: ['3000'], count: 1 },
        { reportDate: expense.date, reportAssetId: s.ids.gbp, direction: 'expense', category: 'food', amounts: ['40'], count: 1 },
      ],
      recentTransactions: [expense, income],
    };
    const bounded = buildDashboard({
      ...s,
      transactions: [],
      transactionSplits: [],
      refundAllocations: [],
    }, range, readModel);

    expect(bounded.netWorth).toBe(legacy.netWorth);
    expect(bounded.txIncome.toString()).toBe(legacy.txIncome.toString());
    expect(bounded.txExpense.toString()).toBe(legacy.txExpense.toString());
    expect(bounded.txNet.toString()).toBe(legacy.txNet.toString());
    expect(bounded.alloc).toEqual(legacy.alloc);
    expect(bounded.activity).toEqual(legacy.activity);
  });

  it('keeps large activity amounts as exact decimal text through the read model', () => {
    const s = makeSnapshot();
    const transaction = makeTransaction({
      id: 'large-activity', date: '2026-03-31', type: 'income', category: 'salary',
      amount: '9007199254740992.01', assetId: s.ids.gbp, description: '精确大额',
    });
    const readModel: DashboardTransactionReadModel = {
      balanceAggregates: [{ assetId: s.ids.gbp, amounts: [transaction.amount] }],
      reportAggregates: [{
        reportDate: transaction.date, reportAssetId: s.ids.gbp, direction: 'income',
        category: transaction.category, amounts: [transaction.amount], count: 1,
      }],
      recentTransactions: [transaction],
    };
    const vm = buildDashboard({
      ...s, transactions: [], transactionSplits: [], refundAllocations: [],
    }, { from: '2026-03-01', to: '2026-03-31' }, readModel);

    expect(vm.activity.find((row) => row.desc === '精确大额')?.amt).toBe('9007199254740992.01');
  });

  it('normalizes module-native amounts into the global report currency', () => {
    const s = makeSnapshot();
    const usd = { ...s.assets[0]!, id: 'asset-usd', code: 'USD', name: '美元', symbol: '$' };
    s.assets.push(usd);
    s.priceMarks.push({ ...s.priceMarks[0]!, id: 'mark-usd', assetId: usd.id, quoteAssetId: s.ids.gbp, price: '0.8', date: '2025-01-01' });
    const buy = s.chains.find((row) => row.chain.type === 'dca')!;
    buy.chain.baseCurrencyAssetId = usd.id;
    buy.chain.bookValueInBase = '100';
    s.lots[0]!.baseCurrencyAssetId = usd.id;
    s.lots[0]!.baseCost = '100';
    s.gameRecords[0]!.settlementAssetId = usd.id;
    s.fixedAssets[0]!.baseCurrencyAssetId = usd.id;

    const converted = buildDashboard(s);
    expect(round(converted.investedFiat, 2)).toBe('80.00');
    expect(round(converted.unrealized, 2)).toBe('620.00');
    expect(round(converted.seasonNet, 2)).toBe('40.00');
    expect(converted.alloc.find((row) => row.name === '物品资产')?.value).toBe('240');
    expect(converted.missingRateAssetCodes).toEqual([]);

    s.priceMarks = s.priceMarks.filter((row) => row.assetId !== usd.id);
    const missing = buildDashboard(s);
    expect(missing.missingRateAssetCodes).toContain('USD');
    expect(missing.incompleteMetrics).toEqual(expect.arrayContaining(['netWorth', 'investedFiat', 'unrealized', 'seasonNet']));
    expect(round(missing.investedFiat, 2)).toBe('0.00');
    expect(round(missing.unrealized, 2)).toBe('0.00');
    expect(missing.alloc.every((row) => row.name !== 'USD')).toBe(true);
    expect(missing.alloc.every((row) => row.weight === 0)).toBe(true);
  });
});
