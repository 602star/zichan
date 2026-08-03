import { describe, it, expect } from 'vitest';
import {
  buildReport,
  tableToCsv,
  tableToMarkdown,
  tableToMermaid,
  transactionDetails,
  transactionTableFromAggregates,
} from '../src/selectors/reports.js';
import { makeSnapshot, makeTransaction } from './fixtures.js';

describe('buildReport', () => {
  const snap = makeSnapshot();

  it('transactions tab: summarizes daily spending categories', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ type: 'expense', category: 'food', amount: '20', assetId: s.ids.gbp }),
      makeTransaction({ type: 'income', category: 'salary', amount: '3000', assetId: s.ids.gbp }),
    ];
    const t = buildReport(s, 'transactions');
    expect(t.headers).toEqual(['全部 类型', '分类', '金额（GBP）', '笔数', '支出占比']);
    expect(t.rows.map((r) => r[1]?.v)).toContain('餐饮 / 餐饮/正餐');
  });

  it('exports report tables to CSV, Markdown and Mermaid', () => {
    const table = {
      headers: ['类型', '分类', '金额'],
      rows: [[{ v: '支出' }, { v: '餐饮' }, { v: '£20.00' }]],
    };
    expect(tableToCsv(table)).toContain('类型,分类,金额');
    expect(tableToMarkdown(table)).toContain('| 类型 | 分类 | 金额 |');
    expect(tableToMermaid(table, '分类支出')).toContain('pie title 分类支出');
  });

  it('filters transaction reports by range and category detail', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ date: '2026-03-02', type: 'expense', category: 'food', amount: '20', assetId: s.ids.gbp }),
      makeTransaction({ date: '2026-02-12', type: 'expense', category: 'shopping', amount: '80', assetId: s.ids.gbp }),
      makeTransaction({ date: '2026-02-15', type: 'income', category: 'salary', amount: '3000', assetId: s.ids.gbp }),
    ];
    const feb = buildReport(s, 'transactions', { dateRange: { from: '2026-02-01', to: '2026-02-28' } });
    expect(feb.headers[0]).toBe('2026-02-01 至 2026-02-28 类型');
    expect(feb.rows.map((r) => r[1]?.v)).toEqual(expect.arrayContaining(['购物', '工资']));
    const details = transactionDetails(s, { dateRange: { from: '2026-02-01', to: '2026-02-28' }, transactionCategory: 'shopping' });
    expect(details).toHaveLength(1);
    expect(details[0]?.category).toBe('购物');
  });

  it('reports refunds as negative spending without inflating income', () => {
    const s = makeSnapshot();
    const original = makeTransaction({ id: 'original', date: '2026-03-05', type: 'expense', category: 'food', amount: '100', assetId: s.ids.gbp });
    s.setting!.refundAttributionMode = 'original_date';
    s.transactions = [
      original,
      makeTransaction({
        id: 'refund', date: '2026-04-02', type: 'refund', category: 'food', amount: '30', assetId: s.ids.gbp,
        refundForId: original.id, refundAppliedAmount: '30', refundAppliedAssetId: s.ids.gbp,
        refundAttributionMode: 'original_date', refundEffectDate: original.date, refundAllocationMode: 'proportional',
        originalDateSnapshot: original.date, originalAmountSnapshot: original.amount,
      }),
    ];
    s.refundAllocations = [{
      id: 'refund-allocation', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      refundTransactionId: 'refund', sourceTransactionId: original.id, categoryId: 'food',
      categoryPathSnapshot: '餐饮 / 餐饮/正餐', amount: '30', assetId: s.ids.gbp,
    }];
    s.setting!.refundAttributionMode = 'refund_date';
    const range = { dateRange: { from: '2026-03-01', to: '2026-03-31' } };
    const table = buildReport(s, 'transactions', range);
    const aggregateTable = transactionTableFromAggregates(s, [{
      reportDate: '2026-03-05',
      reportAssetId: s.ids.gbp,
      direction: 'expense',
      category: 'food',
      amounts: ['100', '-30'],
      count: 2,
    }], range);
    expect(aggregateTable).toEqual(table);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.[0]?.v).toBe('支出');
    expect(table.rows[0]?.[2]?.data?.reportAmount).toBe('70');
    const details = transactionDetails(s, range);
    expect(details).toHaveLength(2);
    expect(details.find((row) => row.id === 'refund')).toMatchObject({
      reportDate: '2026-03-05',
      cashDate: '2026-04-02',
      type: '退款',
      amount: '+30 GBP',
      baseAmount: '冲减支出 £30.00',
    });
  });

  it('dca tab: exposes native and report-currency costs', () => {
    const t = buildReport(snap, 'dca');
    expect(t.headers.length).toBe(9);
    expect(t.rows.length).toBe(0);
  });

  it('chain tab: excludes deposits, shows the buy chain', () => {
    const t = buildReport(snap, 'chain');
    expect(t.rows.length).toBe(1); // deposit filtered out
    expect(t.rows[0]![1]!.v).toBe('£600.00'); // 起始 = cost
    expect(t.rows[0]![5]!.v).toBe('0.01 BTC'); // 最终
  });

  it('season tab: one row with signed net', () => {
    const t = buildReport(snap, 'season');
    expect(t.rows.length).toBe(1);
    expect(t.rows[0]![6]!.v).toBe('+£50.00'); // 净收益
  });

  it('fixed tab: one row with net cost', () => {
    const t = buildReport(snap, 'fixed');
    expect(t.rows.length).toBe(1);
    expect(t.rows[0]![6]!.v).toBe('£200.00'); // 原币净成本
    expect(t.rows[0]![7]!.v).toBe('£200.00'); // 报表币种净成本
  });

  it('applies inclusive custom ranges to every report tab', () => {
    const s = makeSnapshot();
    s.transactions = [makeTransaction({ date: '2026-03-02', assetId: s.ids.gbp })];
    s.dcaExecutions.push({
      id: 'execution-range', planId: 'plan-range', occurrenceIndex: 0, scheduledDate: '2026-03-02',
      date: '2026-03-02', plannedAmount: '10', actualBaseCost: '10',
      baseCurrencyAssetId: s.ids.gbp, finalAssetId: s.ids.btc, finalAmount: '0.0001', totalFeeInBase: '0',
      createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    });

    const exact = { dateRange: { from: '2026-03-02', to: '2026-03-02' } };
    expect(buildReport(s, 'transactions', exact).rows).toHaveLength(1);
    expect(buildReport(s, 'dca', exact).rows).toHaveLength(1);
    expect(buildReport(s, 'chain', exact).rows).toHaveLength(0);
    expect(buildReport(s, 'season', exact).rows).toHaveLength(0);
    expect(buildReport(s, 'fixed', exact).rows).toHaveLength(0);

    expect(buildReport(s, 'chain', { dateRange: { from: '2026-02-01', to: '2026-02-01' } }).rows).toHaveLength(1);
    expect(buildReport(s, 'season', { dateRange: { from: '2026-02-01', to: '2026-02-01' } }).rows).toHaveLength(1);
    expect(buildReport(s, 'fixed', { dateRange: { from: '2026-03-01', to: '2026-03-01' } }).rows).toHaveLength(1);
  });

  it('does not use a future price mark for an earlier report row', () => {
    const s = makeSnapshot();
    const usd = { ...s.assets[0]!, id: 'asset-usd-future', code: 'USD', name: '美元', symbol: '$' };
    s.assets.push(usd);
    s.priceMarks.push({ ...s.priceMarks[0]!, id: 'mark-usd-future', assetId: usd.id, quoteAssetId: s.ids.gbp, price: '0.8', date: '2026-03-03' });
    s.transactions = [makeTransaction({ date: '2026-03-02', amount: '100', assetId: usd.id })];

    const table = buildReport(s, 'transactions', { dateRange: { from: '2026-03-02', to: '2026-03-02' } });
    expect(table.rows[0]![2]!.v).toContain('未折算');
    expect(table.missingRateAssetCodes).toEqual(['USD']);
  });

  it('converts each module currency before aggregating and flags missing rates', () => {
    const s = makeSnapshot();
    const usd = { ...s.assets[0]!, id: 'asset-usd', code: 'USD', name: '美元', symbol: '$' };
    s.assets.push(usd);
    s.priceMarks.push({ ...s.priceMarks[0]!, id: 'mark-usd', assetId: usd.id, quoteAssetId: s.ids.gbp, price: '0.8', date: '2025-01-01' });
    s.transactions = [makeTransaction({ type: 'expense', category: 'food', amount: '100', assetId: usd.id })];
    const buy = s.chains.find((row) => row.chain.type === 'dca')!;
    buy.chain.baseCurrencyAssetId = usd.id;
    buy.chain.bookValueInBase = '100';
    s.gameRecords[0]!.settlementAssetId = usd.id;
    s.fixedAssets[0]!.baseCurrencyAssetId = usd.id;
    s.dcaExecutions.push({
      id: 'execution-usd', planId: 'plan-usd', occurrenceIndex: 0, scheduledDate: '2026-03-01',
      date: '2026-03-01', plannedAmount: '100', actualBaseCost: '100',
      baseCurrencyAssetId: usd.id, finalAssetId: s.ids.btc, finalAmount: '0.002', totalFeeInBase: '1',
      createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    });

    expect(buildReport(s, 'transactions').rows[0]![2]!.data?.reportAmount).toBe('80');
    expect(buildReport(s, 'dca').rows[0]![2]!.v).toBe('£80.00');
    expect(buildReport(s, 'chain').rows[0]![7]!.v).toBe('£80.00');
    expect(buildReport(s, 'season').rows[0]![6]!.v).toBe('+£40.00');
    expect(buildReport(s, 'fixed').rows[0]![6]!.v).toBe('$200.00');
    expect(buildReport(s, 'fixed').rows[0]![7]!.v).toBe('£160.00');

    s.priceMarks = s.priceMarks.filter((row) => row.assetId !== usd.id);
    const missing = buildReport(s, 'transactions');
    expect(missing.missingRateAssetCodes).toEqual(['USD']);
    expect(missing.valuationComplete).toBe(false);
    expect(missing.rows[0]![2]!.v).toContain('未折算');
    expect(tableToCsv(missing)).toContain('估值完整性,部分');
    expect(tableToMarkdown(missing)).toContain('> 估值不完整');
    expect(tableToMermaid(missing, '分类支出')).toContain('%% 估值不完整');
  });
});
