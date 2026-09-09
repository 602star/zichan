import { describe, it, expect } from 'vitest';
import { D, matchSell, remainingCostBasis, round, type Lot } from '../src/index.js';

function lot(p: Partial<Lot> & Pick<Lot, 'id' | 'acquiredDate' | 'originalAmount' | 'baseCost'>): Lot {
  return {
    assetId: 'BTC', baseCurrencyAssetId: 'GBP',
    remainingAmount: p.originalAmount, status: 'open',
    createdAt: '', updatedAt: '', version: 1, isDeleted: false, ...p,
  } as Lot;
}

describe('matchSell — realized P&L', () => {
  const lots = [
    lot({ id: 'L1', acquiredDate: '2026-01-01', originalAmount: '0.003', baseCost: '180' }), // £60,000/BTC
    lot({ id: 'L2', acquiredDate: '2026-02-01', originalAmount: '0.004', baseCost: '260' }), // £65,000/BTC
  ];

  it('FIFO consumes oldest lot first', () => {
    const r = matchSell(lots, {
      sellChainId: 'sell1', assetId: 'BTC', baseCurrencyAssetId: 'GBP', amount: '0.005', proceedsBase: '386.60', method: 'fifo',
    });
    // 0.003 from L1 (cost 180) + 0.002 from L2 (cost 260*0.002/0.004=130) = 310 cost
    expect(round(r.totalCostBase, 2)).toBe('310.00');
    expect(round(r.realizedPnlBase, 2)).toBe('76.60'); // 386.60 - 310
    expect(r.unmatchedAmount).toBe('0');
    expect(r.consumptions).toHaveLength(2);
    // L1 fully consumed, L2 partially
    expect(r.updatedLots.find((l) => l.id === 'L1')?.status).toBe('closed');
    expect(round(r.updatedLots.find((l) => l.id === 'L2')!.remainingAmount, 3)).toBe('0.002');
  });

  it('LIFO consumes newest lot first', () => {
    const r = matchSell(lots, {
      sellChainId: 'sell1', assetId: 'BTC', baseCurrencyAssetId: 'GBP', amount: '0.004', proceedsBase: '300', method: 'lifo',
    });
    // all 0.004 from L2, cost 260
    expect(round(r.totalCostBase, 2)).toBe('260.00');
    expect(round(r.realizedPnlBase, 2)).toBe('40.00');
    expect(r.updatedLots.find((l) => l.id === 'L2')?.status).toBe('closed');
  });

  it('manual selection honors the given lot order', () => {
    const r = matchSell(lots, {
      sellChainId: 'sell1', assetId: 'BTC', baseCurrencyAssetId: 'GBP', amount: '0.003', proceedsBase: '210',
      method: 'manual', selectedLotIds: ['L2', 'L1'],
    });
    expect(round(r.totalCostBase, 2)).toBe('195.00'); // 0.003 of L2 = 260*0.003/0.004
    expect(r.updatedLots.find((l) => l.id === 'L1')?.status).toBe('open');
  });

  it('average cost pools all open lots', () => {
    const r = matchSell(lots, {
      sellChainId: 'sell1', assetId: 'BTC', baseCurrencyAssetId: 'GBP', amount: '0.007', proceedsBase: '500', method: 'average',
    });
    // pool = 0.007 for 440 total => whole pool consumed, cost 440
    expect(round(r.totalCostBase, 2)).toBe('440.00');
    expect(round(r.realizedPnlBase, 2)).toBe('60.00');
  });

  it('keeps the remaining pool basis exact after a partial average-cost sale', () => {
    const pool = [
      lot({ id: 'A1', acquiredDate: '2026-01-01', originalAmount: '1', baseCost: '10' }),
      lot({ id: 'A2', acquiredDate: '2026-02-01', originalAmount: '1', baseCost: '30' }),
    ];
    const r = matchSell(pool, {
      sellChainId: 'sell-average-partial', assetId: 'BTC', baseCurrencyAssetId: 'GBP', amount: '1', proceedsBase: '25', method: 'average',
    });
    expect(r.totalCostBase).toBe('20');
    expect(r.updatedLots.map((row) => row.remainingAmount)).toEqual(['0.5', '0.5']);
    expect(remainingCostBasis(r.updatedLots, 'BTC')).toBe('20');
  });

  it('flags oversell (sold more than held) as unmatched, no stock forced', () => {
    const r = matchSell(lots, {
      sellChainId: 'sell1', assetId: 'BTC', baseCurrencyAssetId: 'GBP', amount: '0.010', proceedsBase: '700', method: 'fifo',
    });
    expect(round(r.unmatchedAmount, 3)).toBe('0.003'); // 0.007 held, 0.010 sold
  });

  it('allocated proceeds always sum exactly to total proceeds (no rounding drift)', () => {
    // 3 equal slices: naive per-slice rounding sums to 99.999…9999 instead of 100.
    const equal = [lot({ id: 'E1', acquiredDate: '2026-01-01', originalAmount: '1', baseCost: '10' }),
      lot({ id: 'E2', acquiredDate: '2026-01-02', originalAmount: '1', baseCost: '10' }),
      lot({ id: 'E3', acquiredDate: '2026-01-03', originalAmount: '1', baseCost: '10' })];
    for (const method of ['fifo', 'average'] as const) {
      const r = matchSell(equal, {
        sellChainId: 'sell-eq', assetId: 'BTC', baseCurrencyAssetId: 'GBP', amount: '3', proceedsBase: '100', method,
      });
      const sumAlloc = r.consumptions.reduce((total, c) => total.plus(c.proceedsBase), D(0));
      expect(sumAlloc.toString()).toBe('100');
      expect(r.totalProceedsBase).toBe('100');
      const sumPnl = r.consumptions.reduce((total, c) => total.plus(c.realizedPnlBase), D(0));
      expect(sumPnl.toString()).toBe(r.realizedPnlBase);
    }
  });

  it('allocated proceeds stay exact for uneven non-divisible slices', () => {
    const uneven = [lot({ id: 'U1', acquiredDate: '2026-01-01', originalAmount: '1.01', baseCost: '11' }),
      lot({ id: 'U2', acquiredDate: '2026-01-02', originalAmount: '0.33', baseCost: '11' }),
      lot({ id: 'U3', acquiredDate: '2026-01-03', originalAmount: '0.66', baseCost: '11' })];
    const r = matchSell(uneven, {
      sellChainId: 'sell-uneven', assetId: 'BTC', baseCurrencyAssetId: 'GBP', amount: '2', proceedsBase: '100', method: 'fifo',
    });
    const sumAlloc = r.consumptions.reduce((total, c) => total.plus(c.proceedsBase), D(0));
    expect(sumAlloc.toString()).toBe('100');
    expect(r.consumptions.map((c) => c.proceedsBase)).toEqual(['50.5', '16.5', '33']);
  });

  it('remainingCostBasis reflects open lots', () => {
    expect(round(remainingCostBasis(lots, 'BTC'), 2)).toBe('440.00');
  });

  it('requires a currency selection for mixed remaining costs', () => {
    const mixed = [lots[0]!, { ...lots[1]!, baseCurrencyAssetId: 'USD' }];
    expect(() => remainingCostBasis(mixed, 'BTC')).toThrow('必须指定成本币种');
    expect(remainingCostBasis(mixed, 'BTC', 'GBP')).toBe('180');
    expect(remainingCostBasis(mixed, 'BTC', 'USD')).toBe('260');
    expect(remainingCostBasis(mixed, 'BTC', 'EUR')).toBe('0');
    expect(remainingCostBasis([mixed[0]!, { ...mixed[1]!, isDeleted: true }], 'BTC')).toBe('180');
    expect(remainingCostBasis([mixed[0]!, { ...mixed[1]!, remainingAmount: '0' }], 'BTC')).toBe('180');
  });

  it('rejects lots whose cost currency differs from the sale proceeds currency', () => {
    expect(() => matchSell([{ ...lots[0]!, baseCurrencyAssetId: 'USD' }], {
      sellChainId: 'sell-mixed', assetId: 'BTC', baseCurrencyAssetId: 'GBP', amount: '0.001', proceedsBase: '70', method: 'fifo',
    })).toThrow('禁止将 USD 计价的持仓成本与 GBP 卖出收入直接汇总');
  });

  it('does not reject an untouched later lot in another cost currency', () => {
    const result = matchSell([lots[0]!, { ...lots[1]!, baseCurrencyAssetId: 'USD' }], {
      sellChainId: 'sell-before-mixed', assetId: 'BTC', baseCurrencyAssetId: 'GBP', amount: '0.001', proceedsBase: '70', method: 'fifo',
    });
    expect(result.consumptions).toHaveLength(1);
    expect(result.consumptions[0]?.lotId).toBe('L1');
    expect(result.unmatchedAmount).toBe('0');
  });
});
