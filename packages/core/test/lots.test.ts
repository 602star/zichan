import { describe, it, expect } from 'vitest';
import { matchSell, remainingCostBasis, round, type Lot } from '../src/index.js';

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
      sellChainId: 'sell1', assetId: 'BTC', amount: '0.005', proceedsBase: '386.60', method: 'fifo',
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
      sellChainId: 'sell1', assetId: 'BTC', amount: '0.004', proceedsBase: '300', method: 'lifo',
    });
    // all 0.004 from L2, cost 260
    expect(round(r.totalCostBase, 2)).toBe('260.00');
    expect(round(r.realizedPnlBase, 2)).toBe('40.00');
    expect(r.updatedLots.find((l) => l.id === 'L2')?.status).toBe('closed');
  });

  it('manual selection honors the given lot order', () => {
    const r = matchSell(lots, {
      sellChainId: 'sell1', assetId: 'BTC', amount: '0.003', proceedsBase: '210',
      method: 'manual', selectedLotIds: ['L2', 'L1'],
    });
    expect(round(r.totalCostBase, 2)).toBe('195.00'); // 0.003 of L2 = 260*0.003/0.004
    expect(r.updatedLots.find((l) => l.id === 'L1')?.status).toBe('open');
  });

  it('average cost pools all open lots', () => {
    const r = matchSell(lots, {
      sellChainId: 'sell1', assetId: 'BTC', amount: '0.007', proceedsBase: '500', method: 'average',
    });
    // pool = 0.007 for 440 total => whole pool consumed, cost 440
    expect(round(r.totalCostBase, 2)).toBe('440.00');
    expect(round(r.realizedPnlBase, 2)).toBe('60.00');
  });

  it('flags oversell (sold more than held) as unmatched, no stock forced', () => {
    const r = matchSell(lots, {
      sellChainId: 'sell1', assetId: 'BTC', amount: '0.010', proceedsBase: '700', method: 'fifo',
    });
    expect(round(r.unmatchedAmount, 3)).toBe('0.003'); // 0.007 held, 0.010 sold
  });

  it('remainingCostBasis reflects open lots', () => {
    expect(round(remainingCostBasis(lots, 'BTC'), 2)).toBe('440.00');
  });
});
