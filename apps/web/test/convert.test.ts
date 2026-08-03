import { describe, it, expect } from 'vitest';
import { round } from '@zichan/core';
import { buildConvert } from '../src/selectors/convert.js';
import { makeSnapshot } from './fixtures.js';

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
    expect(round(btc.value, 2)).toBe('700.00'); // 0.01 * 70000
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
