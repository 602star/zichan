import { describe, it, expect } from 'vitest';
import {
  buildReport,
  expenseCompositionFromTable,
  tableToCsv,
  tableToMarkdown,
  tableToMermaid,
  transactionDetails,
  transactionTableFromAggregates,
  type Table,
} from '../src/selectors/reports.js';
import { effectiveReportRange } from '../src/selectors/report-analysis.js';
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

  it('filters pre-aggregated transaction rows to the requested report range', () => {
    const s = makeSnapshot();
    const table = transactionTableFromAggregates(s, [
      { reportDate: '2026-03-02', reportAssetId: s.ids.gbp, direction: 'expense', category: 'food', amounts: ['20'], count: 1 },
      { reportDate: '2026-02-02', reportAssetId: s.ids.gbp, direction: 'expense', category: 'shopping', amounts: ['80'], count: 1 },
    ], { dateRange: { from: '2026-03-01', to: '2026-03-31' } });

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.[1]?.data?.category).toBe('food');
    expect(table.rows[0]?.[2]?.data?.reportAmount).toBe('20');
  });

  it('keeps future transactions out of the as-of main table and drill-down details', () => {
    const s = makeSnapshot();
    s.setting!.asOfDate = '2026-03-04';
    s.transactions = [
      makeTransaction({ id: 'visible', date: '2026-03-04', type: 'expense', category: 'food', amount: '20', assetId: s.ids.gbp }),
      makeTransaction({ id: 'future', date: '2026-03-05', type: 'expense', category: 'shopping', amount: '80', assetId: s.ids.gbp }),
    ];
    const selected = { preset: 'this_month' as const, from: '2026-03-01', to: '2026-03-31' };
    const effective = effectiveReportRange(selected, s.setting.asOfDate);
    const table = transactionTableFromAggregates(s, [
      { reportDate: '2026-03-04', reportAssetId: s.ids.gbp, direction: 'expense', category: 'food', amounts: ['20'], count: 1 },
      { reportDate: '2026-03-05', reportAssetId: s.ids.gbp, direction: 'expense', category: 'shopping', amounts: ['80'], count: 1 },
    ], { dateRange: effective });

    expect(effective.to).toBe('2026-03-04');
    expect(table.rows.map((row) => row[1]?.data?.category)).toEqual(['food']);
    expect(transactionDetails(s, { dateRange: effective }).map((row) => row.id)).toEqual(['visible']);
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

/*
 * 报表页构成图的数据：从已经算好的分类表里折出来，不再查一次。
 * 与支出页环图同一个折法（前 5 + 其他、按一级聚合），所以两页的环形图不会长得不一样。
 * 表里每行仍是二级（表格自己需要那个粒度）。
 */
describe('expenseCompositionFromTable', () => {
  function tableOf(entries: { label: string; category: string; amount: string }[]): Table {
    return {
      headers: ['类型', '分类', '金额', '笔数', '支出占比'],
      rows: entries.map((entry) => [
        { v: '支出' },
        { v: entry.label, data: { category: entry.category } },
        { v: `£${entry.amount}`, data: { reportAmount: entry.amount } },
        { v: '1' },
      ]),
    };
  }

  it('slices the five biggest categories and folds the tail into 其他', () => {
    const composition = expenseCompositionFromTable(tableOf(
      [70, 60, 50, 40, 30, 20, 10].map((amount, index) => ({ label: `分类 ${index + 1}`, category: `c${index + 1}`, amount: String(amount) })),
    ));
    expect(composition.slices.map((row) => row.category)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(composition.slices[0]?.weight).toBeCloseTo(0.25, 10);
    expect(composition.others).toMatchObject({ amount: '30', count: 2 });
    expect(composition.total).toBe('280');
    const painted = composition.slices.reduce((total, row) => total + row.weight, 0) + composition.others.weight;
    expect(painted).toBeCloseTo(1, 10);
  });

  it('ignores income rows and rows that net back to zero', () => {
    const table = tableOf([{ label: '餐饮', category: 'food', amount: '40' }]);
    table.rows.push(
      [{ v: '收入' }, { v: '工资', data: { category: 'salary' } }, { v: '£3,000.00', data: { reportAmount: '3000' } }],
      // A category whose month nets back to nothing is not a slice at all.
      [{ v: '支出' }, { v: '退款', data: { category: 'refunded' } }, { v: '£0.00', data: { reportAmount: '0' } }],
    );
    const composition = expenseCompositionFromTable(table);
    // 二级 `food` 归属目录里的一级 `expense_food`——环上画的是板块，不是叶子。
    expect(composition.slices.map((row) => row.category)).toEqual(['expense_food']);
    expect(composition.slices[0]?.label).toBe('食品餐饮');
    expect(composition.total).toBe('40');
    expect(composition.others.count).toBe(0);
  });

  it('folds several children of one 板块 into a single slice', () => {
    const composition = expenseCompositionFromTable(
      tableOf([
        { label: '食品餐饮 / 堂食餐饮', category: 'food', amount: '40' },
        { label: '食品餐饮 / 外卖', category: 'takeaway', amount: '60' },
        { label: '医疗健康 / 挂号诊疗', category: 'healthcare', amount: '90' },
      ]),
      { categories: [] },
    );
    expect(composition.slices.map((row) => row.category)).toEqual(['expense_food', 'expense_health']);
    expect(composition.slices[0]).toMatchObject({ label: '食品餐饮', amount: '100' });
    expect(composition.slices[0]?.weight).toBeCloseTo(100 / 190, 10);
  });

  it('keeps 二级 when asked, restricted to one 板块', () => {
    const table = tableOf([
      { label: '食品餐饮 / 堂食餐饮', category: 'food', amount: '40' },
      { label: '食品餐饮 / 外卖', category: 'takeaway', amount: '60' },
      { label: '医疗健康 / 牙科', category: 'dental', amount: '90' },
    ]);
    const children = expenseCompositionFromTable(table, { level: 'leaf', underParent: 'expense_food' });
    expect(children.slices.map((row) => row.category)).toEqual(['takeaway', 'food']);
    // 分母只是这个板块（100），不是整张表（190）——右环是左环那一段的放大。
    expect(children.total).toBe('100');
    expect(children.slices[0]).toMatchObject({ label: '外卖', weight: 0.6 });
    expect(children.slices.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(1, 10);
  });

  it('returns an empty composition instead of a zero-valued slice', () => {
    expect(expenseCompositionFromTable({ headers: [], rows: [] })).toEqual({
      slices: [], others: { amount: '0', count: 0, weight: 0 }, total: '0',
    });
  });
});
