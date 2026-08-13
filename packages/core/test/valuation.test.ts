import { describe, it, expect } from 'vitest';
import {
  valuePortfolio, latestPrices, resolveLatestPrices, round,
  type Balance, type PriceMark, type Lot,
} from '../src/index.js';

function mark(assetId: string, price: string, date: string): PriceMark {
  return {
    id: assetId + date, assetId, quoteAssetId: 'GBP', price, date, source: 'manual',
    createdAt: '', updatedAt: '', version: 1, isDeleted: false,
  };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) => permutations(items.filter((_, candidate) => candidate !== index))
    .map((rest) => [item, ...rest]));
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

  it('uses stable same-day mark tie-breaks regardless of input order', () => {
    const assertWinner = (candidates: PriceMark[], expectedId: string, expectedPrice: string) => {
      for (const ordered of permutations(candidates)) {
        const resolved = resolveLatestPrices(ordered, 'GBP').get('BTC');
        expect(resolved?.priceMarkIds).toEqual([expectedId]);
        expect(resolved?.priceInBase).toBe(expectedPrice);
      }
    };
    const common = { date: '2026-03-04', updatedAt: '2026-03-04T12:00:00.000Z', createdAt: '2026-03-04T10:00:00.000Z' };

    assertWinner([
      { ...mark('BTC', '1', common.date), ...common, id: 'updated-old', updatedAt: '2026-03-04T11:00:00.000Z' },
      { ...mark('BTC', '2', common.date), ...common, id: 'updated-new' },
    ], 'updated-new', '2');
    assertWinner([
      { ...mark('BTC', '3', common.date), ...common, id: 'created-old', createdAt: '2026-03-04T09:00:00.000Z' },
      { ...mark('BTC', '4', common.date), ...common, id: 'created-new' },
    ], 'created-new', '4');
    assertWinner([
      { ...mark('BTC', '5', common.date), ...common, id: 'mark-a' },
      { ...mark('BTC', '6', common.date), ...common, id: 'mark-z' },
    ], 'mark-z', '6');
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

  it('prefers a direct quote and terminates when inconsistent marks form an arbitrage cycle', () => {
    const graphMarks: PriceMark[] = [
      mark('GBP', '2', '2026-03-04'),
      mark('AAA', '2', '2026-03-04'),
      { ...mark('BBB', '2', '2026-03-04'), quoteAssetId: 'AAA' },
      mark('BBB', '1', '2026-03-04'),
    ];
    const prices = latestPrices(graphMarks, 'GBP');
    expect(prices.get('AAA')).toBe('2');
    expect(prices.get('BBB')).toBe('1');
  });

  it('selects equal-hop paths deterministically for every input permutation', () => {
    const graphMarks: PriceMark[] = [
      { ...mark('AAA', '2', '2026-03-04'), id: 'gbp-aaa' },
      { ...mark('TARGET', '5', '2026-03-04'), id: 'aaa-target', quoteAssetId: 'AAA' },
      { ...mark('BBB', '3', '2026-03-04'), id: 'gbp-bbb' },
      { ...mark('TARGET', '7', '2026-03-04'), id: 'bbb-target', quoteAssetId: 'BBB' },
    ];
    for (const ordered of permutations(graphMarks)) {
      const resolved = resolveLatestPrices(ordered, 'GBP').get('TARGET');
      expect(resolved?.priceInBase).toBe('10');
      expect(resolved?.pathAssetIds).toEqual(['GBP', 'AAA', 'TARGET']);
      expect(resolved?.priceMarkIds).toEqual(['gbp-aaa', 'aaa-target']);
    }
  });

  it('always prefers a one-hop direct quote over cross-currency paths', () => {
    const graphMarks: PriceMark[] = [
      { ...mark('AAA', '2', '2026-03-04'), id: 'gbp-aaa' },
      { ...mark('TARGET', '5', '2026-03-04'), id: 'aaa-target', quoteAssetId: 'AAA' },
      { ...mark('BBB', '3', '2026-03-04'), id: 'gbp-bbb' },
      { ...mark('TARGET', '7', '2026-03-04'), id: 'bbb-target', quoteAssetId: 'BBB' },
      { ...mark('TARGET', '99', '2026-01-01'), id: 'direct-target' },
    ];
    for (const ordered of permutations(graphMarks)) {
      const resolved = resolveLatestPrices(ordered, 'GBP').get('TARGET');
      expect(resolved?.priceInBase).toBe('99');
      expect(resolved?.pathAssetIds).toEqual(['GBP', 'TARGET']);
      expect(resolved?.priceMarkIds).toEqual(['direct-target']);
    }
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

  it('reports partial and stale valuation instead of silently treating missing prices as authoritative zero', () => {
    const result = valuePortfolio({
      baseCurrencyAssetId: 'GBP',
      balances: [
        { assetId: 'GBP', amount: '100' },
        { assetId: 'BTC', amount: '1' },
        { assetId: 'ETH', amount: '2' },
      ],
      priceMarks: [{ ...mark('BTC', '5', '2026-01-01'), id: 'old-btc' }],
      lots: [{
        id: 'eth-lot', assetId: 'ETH', baseCurrencyAssetId: 'GBP', acquiredDate: '2025-01-01',
        originalAmount: '2', baseCost: '20', remainingAmount: '2', status: 'open',
        createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      }],
      asOf: '2026-03-15',
      staleAfterDays: 30,
    });

    expect(result.totalValue).toBe('105');
    expect(result.completeness).toBe('partial');
    expect(result.unpricedAssetIds).toEqual(['ETH']);
    expect(result.stalePriceAssetIds).toEqual(['BTC']);
    expect(result.freshnessEvaluated).toBe(true);

    const btc = result.holdings.find((holding) => holding.assetId === 'BTC')!;
    expect(btc.pricingStatus).toBe('stale');
    expect(btc.includedInTotal).toBe(true);
    expect(btc.priceDate).toBe('2026-01-01');

    const eth = result.holdings.find((holding) => holding.assetId === 'ETH')!;
    expect(eth.pricingStatus).toBe('unpriced');
    expect(eth.includedInTotal).toBe(false);
    expect(eth.valueInBase).toBe('0');
    expect(eth.costBasis).toBe('20');
    expect(eth.unrealizedPnl).toBeUndefined();
  });

  it('uses the oldest leg to classify a cross-currency quote as stale', () => {
    const resolved = resolveLatestPrices([
      { ...mark('USD', '0.8', '2026-02-01'), id: 'gbp-usd' },
      { ...mark('BTC', '100000', '2026-03-10'), id: 'usd-btc', quoteAssetId: 'USD' },
    ], 'GBP', { asOf: '2026-03-15', staleAfterDays: 30 }).get('BTC');

    expect(resolved?.priceInBase).toBe('80000');
    expect(resolved?.oldestMarkDate).toBe('2026-02-01');
    expect(resolved?.ageDays).toBe(42);
    expect(resolved?.freshness).toBe('stale');
  });

  it('requires an explicit valuation date when evaluating staleness', () => {
    expect(() => resolveLatestPrices(marks, 'GBP', { staleAfterDays: 30 }))
      .toThrow('staleAfterDays requires asOf');
  });
});
