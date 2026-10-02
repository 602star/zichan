import { describe, it, expect } from 'vitest';
import { seasonSummary, seasonActivitySummary, seasonDays, round, gameRecordExchangeRate, type GameRecord, type GameSeason } from '../src/index.js';

// Prototype season S2 · 灰烬余烬 (see 资产记账系统.dc.html SEASONS.s2).
const s2: GameSeason = {
  id: 's2', gameId: 'g1', name: 'S2 · 灰烬余烬', status: 'active',
  startDate: '2025-12-20', hours: '42',
  createdAt: '', updatedAt: '', version: 1, isDeleted: false,
};

function rec(
  recordType: GameRecord['recordType'], settlementAmount: string, currency?: string, qty?: string,
): GameRecord {
  return {
    id: Math.random().toString(36), date: '2026-01-01', gameId: 'g1', seasonId: 's2',
    recordType, settlementAssetId: 'GBP', settlementAmount,
    gameCurrencyName: currency, gameCurrencyAmount: qty,
    createdAt: '', updatedAt: '', version: 1, isDeleted: false,
  };
}

const s2Records: GameRecord[] = [
  rec('buy_currency', '16.0', '初火', '4000'),
  rec('produce', '0', '初火', '6200'),
  rec('sell_equipment', '24.0'),
  rec('sell_material', '9.5'),
  rec('topup', '8.0'),
  rec('sell_currency', '31.6', '初火', '8000'),
  rec('fee', '2.1'),
];

describe('seasonSummary — matches prototype S2 numbers', () => {
  const sum = seasonSummary(s2Records, s2, { asOf: '2026-03-04' });

  it('income = sells + other income = £65.10', () => {
    expect(round(sum.incomeBase, 2)).toBe('65.10');
  });
  it('expense = buys + topup + fee = £26.10', () => {
    expect(round(sum.expenseBase, 2)).toBe('26.10');
  });
  it('net = £39.00', () => {
    expect(round(sum.netBase, 2)).toBe('39.00');
  });
  it('season length = 75 days as of 2026-03-04', () => {
    expect(sum.days).toBe(75);
    expect(seasonDays(s2, '2026-03-04')).toBe(75);
  });
  it('per-hour = £0.93, per-day = £0.52', () => {
    expect(round(sum.perHour, 2)).toBe('0.93'); // 39 / 42h
    expect(round(sum.perDay, 2)).toBe('0.52'); // 39 / 75d
  });

  it('does not double-count a fee when a standalone fee record also carries feeAmount', () => {
    const withFeeAmount: GameRecord = {
      ...rec('fee', '2.1'),
      feeAssetId: 'GBP', feeAmount: '2.1',
    };
    const result = seasonSummary([withFeeAmount], s2, { asOf: '2026-03-04' });
    // The attached feeAmount must not be added a second time on top of the record itself.
    expect(round(result.feeBase, 2)).toBe('2.10');
    expect(round(result.expenseBase, 2)).toBe('2.10');
  });
  it('reference balance = 2,200 初火 (buy + produce − sell), may go negative elsewhere', () => {
    expect(round(sum.referenceBalance, 0)).toBe('2200');
  });

  it('counts equipment and material sales as game currency before the currency is sold for cash', () => {
    const equipment = { ...rec('sell_equipment', '0', '初火', '300'), settlementAssetId: undefined, settlementAmount: undefined };
    const material = { ...rec('sell_material', '0', '初火', '200'), settlementAssetId: undefined, settlementAmount: undefined };
    const cashOut = rec('sell_currency', '10', '初火', '500');
    const result = seasonSummary([equipment, material, cashOut], s2, { asOf: '2026-03-04' });
    expect(result.referenceBalance).toBe('0');
    expect(result.incomeBase).toBe('10');
    expect(result.netBase).toBe('10');
  });

  it('spends game currency on equipment and material without a second cash expense', () => {
    const buyCurrency = rec('buy_currency', '20', '初火', '1000');
    const equipment = { ...rec('buy_equipment', '0', '初火', '600'), settlementAssetId: undefined, settlementAmount: undefined };
    const material = { ...rec('buy_material', '0', '初火', '150'), settlementAssetId: undefined, settlementAmount: undefined };
    const result = seasonSummary([buyCurrency, equipment, material], s2, { asOf: '2026-03-04' });
    expect(result.referenceBalance).toBe('250');
    expect(result.expenseBase).toBe('20');
    expect(result.netBase).toBe('-20');

    const directPurchase = rec('buy_equipment', '8');
    const direct = seasonSummary([directPurchase], s2, { asOf: '2026-03-04' });
    expect(direct.referenceBalance).toBe('0');
    expect(direct.expenseBase).toBe('8');
  });

  it('deducts an optional game-currency fee from received currency without another cash expense', () => {
    const purchase = { ...rec('buy_currency', '20', '通货', '1000'), gameCurrencyFeeAmount: '100' };
    const result = seasonSummary([purchase], s2, { asOf: '2026-03-04' });
    expect(result.referenceBalance).toBe('900');
    expect(result.expenseBase).toBe('20');
    expect(result.feeBase).toBe('0');
    expect(seasonActivitySummary([purchase], s2).referenceBalance).toBe('900');
  });

  it('rejects implicit mixed currencies and selects settlement and fees independently', () => {
    const mixed = [{ ...rec('sell_currency', '100', '初火', '10'), feeAssetId: 'USD', feeAmount: '2' }];
    expect(() => seasonSummary(mixed, s2)).toThrow('多个币种');
    const gbp = seasonSummary(mixed, s2, { baseAssetId: 'GBP' });
    const usd = seasonSummary(mixed, s2, { baseAssetId: 'USD' });
    expect(gbp.incomeBase).toBe('100');
    expect(gbp.expenseBase).toBe('0');
    expect(usd.incomeBase).toBe('0');
    expect(usd.expenseBase).toBe('2');
    expect(usd.feeBase).toBe('2');
    expect(gbp.referenceBalance).toBe('-10');
    expect(usd.referenceBalance).toBe('-10');
    expect(seasonActivitySummary(mixed, s2).referenceBalance).toBe('-10');
  });

  it('rejects financial amounts without a currency and ignores deleted records', () => {
    const invalid = { ...rec('sell_currency', '100'), settlementAssetId: undefined };
    expect(() => seasonSummary([invalid], s2)).toThrow('缺少资产币种');
    expect(seasonSummary([{ ...invalid, isDeleted: true }], s2).incomeBase).toBe('0');
    expect(() => seasonSummary([{ ...rec('produce', '0'), feeAmount: '1' }], s2)).toThrow('缺少资产币种');
  });
});

describe('historical game currency exchange rates', () => {
  it('uses the cash amount for currency trades and each item trade’s own saved rate', () => {
    const currencyBuy = { ...rec('buy_currency', '50', '通货', '100'), settlementAssetId: 'CNY' };
    const equipmentBuy = { ...rec('buy_equipment', '0', '通货', '100'), settlementAssetId: undefined, settlementAmount: undefined, manualRate: '2', rateAssetId: 'CNY' };
    const equipmentSell = { ...rec('sell_equipment', '0', '通货', '10'), settlementAssetId: undefined, settlementAmount: undefined, manualRate: '10', rateAssetId: 'CNY' };
    expect(gameRecordExchangeRate(currencyBuy)).toEqual({ rate: '2', quoteAssetId: 'CNY', valuation: '50' });
    expect(gameRecordExchangeRate(equipmentBuy)).toEqual({ rate: '2', quoteAssetId: 'CNY', valuation: '50' });
    expect(gameRecordExchangeRate(equipmentSell)).toEqual({ rate: '10', quoteAssetId: 'CNY', valuation: '1' });
    const summary = seasonSummary([currencyBuy, equipmentBuy, equipmentSell], s2, { baseAssetId: 'CNY' });
    expect(summary.expenseBase).toBe('50');
    expect(summary.incomeBase).toBe('0');
    expect(summary.referenceBalance).toBe('10');
  });
});
