import { describe, expect, it } from 'vitest';
import { assetConversionActions, conversionGap, suggestFeeValue } from '../src/conversion-entry.js';
import { makeSnapshot } from './fixtures.js';

describe('conversion entry guidance', () => {
  it('offers one trade pair and enables currency buy/sell with unified cost', () => {
    expect(assetConversionActions('stablecoin', false).map(({ type, label, requiresCostOpening }) => [type, label, !!requiresCostOpening])).toEqual([
      ['buy', '买入', true], ['sell', '卖出', true], ['deposit', '转入', false], ['withdraw', '转出', false],
    ]);
    expect(assetConversionActions('stablecoin', true).map(({ type, label }) => [type, label])).toEqual([
      ['buy', '买入'], ['sell', '卖出'], ['deposit', '转入'], ['withdraw', '转出'],
    ]);
    expect(assetConversionActions('fiat', true).map(({ type }) => type)).toEqual(['buy', 'sell', 'deposit', 'withdraw']);
    expect(assetConversionActions('crypto', false).some((action) => action.requiresCostOpening)).toBe(false);
    expect(assetConversionActions('crypto', true).map(({ type }) => type)).toEqual(['buy', 'sell', 'deposit', 'withdraw', 'swap']);
  });
  it('derives fees in both directions from the entered trade before using market prices', () => {
    const step = { ...makeSnapshot().chains[0]!.steps[0]!, fromAssetId: 'cny', toAssetId: 'usdt', fromAmount: '700', toAmount: '100' };
    expect(suggestFeeValue(step, 'usdt', '2', 'cny', [], '2026-03-01')?.value).toBe('14');
    expect(suggestFeeValue(step, 'cny', '7', 'usdt', [], '2026-03-01')?.value).toBe('1');
    expect(suggestFeeValue(null, 'third', '2', 'cny', [], '2026-03-01')).toBeNull();
  });
  it('never uses future quotes and explains historical quote suggestions', () => {
    const snap = makeSnapshot();
    expect(suggestFeeValue(null, snap.ids.btc!, '0.001', snap.ids.gbp!, snap.priceMarks, '2026-02-01')).toBeNull();
    const suggestion = suggestFeeValue(null, snap.ids.btc!, '0.001', snap.ids.gbp!, snap.priceMarks, '2026-03-01');
    expect(suggestion?.value).toBe('70');
    expect(suggestion?.basis).toContain('当日或此前');
  });
  it('explains leftovers and top-ups using net credits and actual debits', () => {
    const prev = { ...makeSnapshot().chains[0]!.steps[0]!, fromAssetId: 'cny', toAssetId: 'usdt', toAmount: '100' };
    const next = { ...prev, fromAssetId: 'usdt', toAssetId: 'btc', fromAmount: '80', toAmount: '0.01' };
    expect(conversionGap(prev, next, 'USDT')).toContain('剩余 20 USDT');
    expect(conversionGap(prev, { ...next, fromAmount: '110' }, 'USDT')).toContain('补入 10 USDT');
    expect(conversionGap(prev, { ...next, fromAmount: '99', fees: [{ id: 'f', assetId: 'usdt', amount: '1', treatment: 'source_extra' }] }, 'USDT')).toBeNull();
  });
});
