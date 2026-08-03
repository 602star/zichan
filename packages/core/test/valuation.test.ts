import { describe, it, expect } from 'vitest';
import {
  valuePortfolio, latestPrices, round,
  type Balance, type PriceMark, type Lot,
} from '../src/index.js';

function mark(assetId: string, price: string, date: string): PriceMark {
  return {
    id: assetId + date, assetId, quoteAssetId: 'GBP', price, date, source: 'manual',
    createdAt: '', updatedAt: '', version: 1, isDeleted: false,
  };
}

describe('valuePortfolio — dashboard valuation', () => {
  const balances: Balance[] = [
    { assetId: 'GBP', amount: '3240.50' },
    { assetId: 'BTC', amount: '0.017501' },
  ];
  const marks: PriceMark[] = [
    mark('BTC', '70000', '2026-02-01'),
    mark('BTC', '73200', '2026-03-04'), // latest wins
  ];
  const lots: Lot[] = [{
    id: 'L1', assetId: 'BTC', baseCurrencyAssetId: 'GBP', acquiredDate: '2026-01-01',
    originalAmount: '0.017501', baseCost: '1215.36', remainingAmount: '0.017501', status: 'open',
    createdAt: '', updatedAt: '', version: 1, isDeleted: false,
  }];

  it('picks the latest price per asset', () => {
    const prices = latestPrices(marks, 'GBP');
    expect(prices.get('BTC')).toBe('73200');
    expect(prices.get('GBP')).toBe('1'); // base is worth 1 of itself
  });

  it('can cap prices at a historical business date', () => {
    const prices = latestPrices(marks, 'GBP', '2026-02-15');
    expect(prices.get('BTC')).toBe('70000');
  });

  it('resolves inverse and shortest cross-currency price paths', () => {
    const graphMarks: PriceMark[] = [
      { ...mark('GBP', '200', '2026-03-04'), quoteAssetId: 'JPY' },
      { ...mark('USD', '150', '2026-03-04'), quoteAssetId: 'JPY' },
    ];
    const prices = latestPrices(graphMarks, 'GBP');
    expect(round(prices.get('JPY')!, 6)).toBe('0.005000');
    expect(round(prices.get('USD')!, 6)).toBe('0.750000');
  });

  it('values holdings and computes unrealized P&L from open lots', () => {
    const v = valuePortfolio({ baseCurrencyAssetId: 'GBP', balances, priceMarks: marks, lots });
    const btc = v.holdings.find((h) => h.assetId === 'BTC')!;
    expect(round(btc.valueInBase, 2)).toBe('1281.07'); // 0.017501 * 73200
    expect(round(btc.unrealizedPnl!, 2)).toBe('65.71'); // 1281.07 - 1215.36
    expect(round(v.totalValue, 2)).toBe('4521.57'); // 3240.50 + 1281.07
  });

  it('allocation weights sum to 1', () => {
    const v = valuePortfolio({ baseCurrencyAssetId: 'GBP', balances, priceMarks: marks, lots });
    const total = v.holdings.reduce((a, h) => a + Number(h.weight), 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('holdings are sorted by value descending', () => {
    const v = valuePortfolio({ baseCurrencyAssetId: 'GBP', balances, priceMarks: marks, lots });
    expect(v.holdings[0]!.assetId).toBe('GBP'); // 3240.50 > 1281.07
  });

  it('converts each open lot cost from its own book currency', () => {
    const mixedLots: Lot[] = [{
      ...lots[0]!, baseCurrencyAssetId: 'USD', baseCost: '100', originalAmount: '0.001', remainingAmount: '0.001',
    }];
    const mixedBalances: Balance[] = [{ assetId: 'BTC', amount: '0.001' }];
    const mixedMarks: PriceMark[] = [
      mark('BTC', '100000', '2026-03-04'),
      mark('USD', '0.8', '2026-03-04'),
    ];
    const v = valuePortfolio({ baseCurrencyAssetId: 'GBP', balances: mixedBalances, priceMarks: mixedMarks, lots: mixedLots });
    expect(v.holdings[0]!.costBasis).toBe('80');
    expect(v.holdings[0]!.unrealizedPnl).toBe('20');

    const missing = valuePortfolio({ baseCurrencyAssetId: 'GBP', balances: mixedBalances, priceMarks: mixedMarks.slice(0, 1), lots: mixedLots });
    expect(missing.holdings[0]!.costBasis).toBeUndefined();
    expect(missing.holdings[0]!.unrealizedPnl).toBeUndefined();
  });
});
