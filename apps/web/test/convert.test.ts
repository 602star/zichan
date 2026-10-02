import { describe, it, expect } from 'vitest';
import { round, type AssetCostState } from '@zichan/core';
import { buildConvert, conversionRateText } from '../src/selectors/convert.js';
import { makeSnapshot, makeTransaction } from './fixtures.js';

describe('buildConvert (grouped by asset)', () => {
  const vm = buildConvert(makeSnapshot());

  it('groups chains by asset: BTC group + GBP group', () => {
    expect(vm.groups.length).toBe(2); // buy → BTC, deposit → GBP
    expect(vm.groups.map((g) => g.assetCode).sort()).toEqual(['BTC', 'GBP']);
  });

  it('crypto group carries holdings/value/pnl from lots', () => {
    const btc = vm.groups.find((g) => g.assetCode === 'BTC')!;
    expect(btc.hasPosition).toBe(true);
    expect(btc.holdings).toBe('0.01');
    expect(round(btc.value!, 2)).toBe('700.00'); // 0.01 * 70000
    expect(round(String(btc.pnl), 2)).toBe('100.00'); // 700 − 600
  });

  it('chain view-models keep chips + result + cost tracing', () => {
    const btc = vm.groups.find((g) => g.assetCode === 'BTC')!;
    const buy = btc.chains.find((c) => c.chain.type === 'dca')!;
    expect(buy.result).toBe('获得 0.01 BTC');
    expect(buy.chips).toEqual(['GBP', 'BTC']);
    expect(buy.calc.find((r) => r.l === '实际总成本')?.v).toBe('£600.00');
  });
});

describe('conversion balances and readable history', () => {
  it('includes fiat opening balances and daily expenses even without conversion history', () => {
    const snap = makeSnapshot();
    snap.chains = [];
    snap.accounts[1] = { ...snap.accounts[1]!, openingBalance: '1000', openingAssetId: snap.ids.gbp, balanceStartAt: '2026-01-01T00:00:00Z', balanceStartDate: '2026-01-01' };
    snap.transactions.push(makeTransaction({ assetId: snap.ids.gbp!, accountId: snap.ids.bank, amount: '25' }));
    const group = buildConvert(snap).groups.find((g) => g.assetCode === 'GBP')!;
    expect(group.holdings).toBe('975');
    expect(group.chains).toEqual([]);
    expect(group.costStatus).toBe('成本未记录');
    expect(group.pnl).toBeNull();
  });

  it('keeps active financial assets selectable before their first balance or conversion', () => {
    const snap = makeSnapshot();
    snap.chains = [];
    snap.accounts = snap.accounts.map((account) => ({ ...account, openingBalance: undefined }));
    snap.assets.push({ ...snap.assets[1]!, id: 'usdt', code: 'USDT', type: 'stablecoin' });
    expect(buildConvert(snap).groups.map((group) => group.assetCode).sort()).toEqual(['BTC', 'GBP', 'USDT']);
    expect(buildConvert(snap).groups.find((group) => group.assetCode === 'USDT')).toMatchObject({ holdings: '0', hasPosition: false, chains: [] });
  });

  it('shows USDT left after a later conversion and filters out voided movements', () => {
    const snap = makeSnapshot();
    snap.assets.push({ ...snap.assets[1]!, id: 'usdt', code: 'USDT', type: 'stablecoin', decimals: 6 });
    const first = snap.chains[0]!;
    snap.chains = [
      { chain: { ...first.chain, id: 'exchange', type: 'exchange' }, steps: [{ ...first.steps[0]!, chainId: 'exchange', fromAmount: '100', toAssetId: 'usdt', toAmount: '125' }] },
      { chain: { ...first.chain, id: 'buy' }, steps: [{ ...first.steps[0]!, chainId: 'buy', fromAssetId: 'usdt', fromAmount: '100', toAmount: '0.001' }] },
      { chain: { ...first.chain, id: 'void', recordState: 'voided' }, steps: [{ ...first.steps[0]!, chainId: 'void', toAssetId: 'usdt', toAmount: '999' }] },
    ];
    const groups = buildConvert(snap).groups;
    const usdt = groups.find((g) => g.assetCode === 'USDT')!;
    expect(usdt.holdings).toBe('25');
    expect(usdt.hasPosition).toBe(true);
    expect(usdt.value).toBeNull();
    expect(usdt.pnl).toBeNull();
    expect(groups.flatMap((g) => g.chains).filter((c) => c.assetIds.includes('usdt'))).toHaveLength(2);
    expect(groups.find((g) => g.assetCode === 'BTC')?.costStatus).toBe('成本批次与余额不一致');
  });

  it('does not turn missing prices into a total loss', () => {
    const snap = makeSnapshot();
    snap.priceMarks = [];
    const btc = buildConvert(snap).groups.find((g) => g.assetCode === 'BTC')!;
    expect(btc.value).toBeNull();
    expect(btc.pnl).toBeNull();
    expect(btc.avgCost).toBe('60000');
  });

  it('shows frozen holding cost in its accounting currency when the report FX rate is missing', () => {
    const snap = makeSnapshot();
    const cny = { ...snap.assets[0]!, id: 'cny', code: 'CNY', symbol: '¥' };
    snap.assets.push(cny);
    snap.setting = { ...snap.setting!, baseCurrencyAssetId: cny.id };
    snap.priceMarks = [{ ...snap.priceMarks[0]!, quoteAssetId: cny.id, price: '700000' }];
    snap.costState = {
      openingId: 'opening', occurredAtUtc: '2026-03-01T00:00:00Z', baseCurrencyAssetId: snap.ids.gbp,
      timezone: 'UTC', invalidAssetIds: [], issues: [], lots: [], consumptions: [], gaps: [], events: [],
      positions: [{ assetId: snap.ids.btc, quantity: '0.01', costStatus: 'known', costInBase: '600',
        knownCostInBase: '600', unknownQuantity: '0', deficitQuantity: '0' }],
    } as AssetCostState;
    const btc = buildConvert(snap).groups.find((group) => group.assetCode === 'BTC')!;
    expect(btc.costBasisKnown).toBe(true);
    expect(btc.avgCost).toBe('60000');
    expect(btc.costTotal).toBe('600');
    expect(btc.costCurrencyAssetId).toBe(snap.ids.gbp);
    expect(btc.missingCostRateAssetId).toBe(snap.ids.gbp);
    expect(btc.pnl).toBeNull();
    expect(btc.costStatus).toContain('GBP → CNY');
  });

  it('preserves tiny quantities and negative cash balances, treating invalid zero quotes as unavailable', () => {
    const snap = makeSnapshot();
    snap.chains = [snap.chains[0]!];
    snap.chains[0]!.steps[0]!.toAmount = '0.00000001';
    snap.priceMarks[0]!.price = '0';
    const groups = buildConvert(snap).groups;
    expect(groups.find((g) => g.assetCode === 'BTC')).toMatchObject({ holdings: '1e-8', decimals: 8, value: null });
    expect(groups.find((g) => g.assetCode === 'GBP')?.holdings).toBe('-600');
  });

  it('shows the saved title, account names and full occurrence; sorts by time', () => {
    const snap = makeSnapshot();
    const first = snap.chains[0]!;
    first.chain = { ...first.chain, title: '我的买入', time: '09:00', timezone: 'Asia/Shanghai' };
    first.steps[0]!.accountFromId = snap.ids.bank;
    first.steps[0]!.accountToId = snap.ids.cash;
    snap.chains.push({ chain: { ...first.chain, id: 'late', time: '16:00', title: '  ' }, steps: first.steps });
    const chains = buildConvert(snap).groups.find((g) => g.assetCode === 'BTC')!.chains;
    expect(chains[0]!.title).toBe('GBP → BTC');
    expect(chains[1]!.title).toBe('我的买入');
    expect(chains[1]!.occurred).toContain('09:00 · Asia/Shanghai');
    expect(chains[1]!.steps[0]!.accounts).toBe('银行 → 现金');
  });

  it('keeps foreign deposit receipts in the received currency and avoids investment labels', () => {
    const snap = makeSnapshot();
    const dep = snap.chains[1]!;
    dep.steps[0]!.toAssetId = snap.ids.btc!;
    dep.steps[0]!.toAmount = '0.01';
    const row = buildConvert(snap).groups.flatMap((g) => g.chains).find((c) => c.chain.id === dep.chain.id)!;
    expect(row.result).toBe('到账 0.01 BTC');
    expect(row.delta).toBe('£1,000.00');
    expect(row.calc.map((r) => r.l)).not.toContain('实际总成本');
  });

  it('formats rates with direction, collapses identical rates and discloses third fees', () => {
    const step = { ...makeSnapshot().chains[0]!.steps[0]!, fromAmount: '1222', toAmount: '111' };
    expect(conversionRateText(step, 'CNY', 'BTC')).toBe('1 CNY ≈ 0.090834697 BTC');
    expect(conversionRateText(step, 'CNY', 'BTC', true)).toContain('0.090834697217675');
    step.fees = [{ id: 'f', assetId: step.fromAssetId, amount: '1', treatment: 'source_extra' }];
    expect(conversionRateText(step, 'CNY', 'BTC')).toContain('净到账 1 CNY');
    step.fees = [{ id: 'f', assetId: 'third', amount: '1', treatment: 'third_asset_extra', valueInBase: '1' }];
    expect(conversionRateText(step, 'CNY', 'BTC')).toContain('未含第三资产另付费用');
  });

  it('shows actual sell receipts separately from book proceeds and traces fee accounts and lots', () => {
    const snap = makeSnapshot();
    const first = snap.chains[0]!;
    snap.assets.push({ ...snap.assets[1]!, id: 'usdt', code: 'USDT', type: 'stablecoin', decimals: 6 });
    snap.chains.push({ chain: { ...first.chain, id: 'sell', type: 'sell', bookValueInBase: '800', realizedGainLoss: '200', lotMethod: 'manual' }, steps: [{ ...first.steps[0]!, chainId: 'sell', fromAssetId: snap.ids.btc!, fromAmount: '0.01', toAssetId: 'usdt', toAmount: '1000', fees: [{ id: 'f', assetId: 'usdt', amount: '1', treatment: 'target_deducted', valueInBase: '0.8', accountId: snap.ids.cash, note: '平台扣费' }] }] });
    snap.lotConsumptions = [{ ...snap.lots[0]!, lotId: snap.lots[0]!.id, sellChainId: 'sell', consumedAmount: '0.01', allocatedCostBase: '600', proceedsBase: '800', realizedPnlBase: '200' }];
    const sell = buildConvert(snap).groups.flatMap((g) => g.chains).find((c) => c.chain.id === 'sell')!;
    expect(sell.result).toBe('到账 999 USDT');
    expect(sell.calc).toContainEqual({ l: '账面收入', v: '£800.00' });
    expect(sell.calc).toContainEqual({ l: '成本匹配', v: '手动选择批次' });
    expect(sell.calc.find((row) => row.l.startsWith('批次'))?.v).toContain('成本 £600.00');
    expect(sell.steps[0]!.fee).toContain('目标扣除 1 USDT · 折算 £0.80 · 现金 · 平台扣费');
  });
});
