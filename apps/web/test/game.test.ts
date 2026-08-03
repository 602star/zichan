import { describe, it, expect } from 'vitest';
import { buildGameSeason } from '../src/selectors/game.js';
import { makeSnapshot } from './fixtures.js';

describe('buildGameSeason', () => {
  const snap = makeSnapshot();
  const vm = buildGameSeason(snap, snap.ids.game, null)!;

  it('summarizes the selected season', () => {
    expect(vm.season.name).toBe('S1');
    expect(vm.net).toBe(50); // one +£50 sell
    expect(vm.income).toBe('50');
    expect(vm.expense).toBe('0');
  });

  it('lists the season records', () => {
    expect(vm.records.length).toBe(1);
    expect(vm.records[0]!.amt).toBe(50);
    expect(vm.records[0]!.type).toBe('sell_currency');
  });

  it('returns null when there are no seasons', () => {
    const s = makeSnapshot();
    s.seasons = [];
    expect(buildGameSeason(s, s.ids.game, null)).toBeNull();
  });

  it('filters records by an inclusive date range', () => {
    const s = makeSnapshot();
    s.gameRecords.push({ ...s.gameRecords[0]!, id: 'later', date: '2026-03-01', settlementAmount: '20' });
    const filtered = buildGameSeason(s, s.ids.game, null, { dateRange: { from: '2026-03-01', to: '2026-03-01' } })!;
    expect(filtered.records.map((record) => record.raw.id)).toEqual(['later']);
    expect(filtered.net).toBe(20);
    expect(filtered.filtered).toBe(true);
  });

  it('converts mixed settlement currencies and includes attached fees', () => {
    const s = makeSnapshot();
    const usd = { ...s.assets[0]!, id: 'asset-usd', code: 'USD', name: '美元', symbol: '$' };
    s.assets.push(usd);
    s.priceMarks.push({ ...s.priceMarks[0]!, id: 'mark-usd', assetId: usd.id, quoteAssetId: s.ids.gbp, price: '0.8', date: '2025-01-01' });
    s.gameRecords[0]!.settlementAssetId = usd.id;
    s.gameRecords[0]!.feeAssetId = s.ids.gbp;
    s.gameRecords[0]!.feeAmount = '5';
    s.gameRecords[0]!.gameCurrencyName = '金币';

    const converted = buildGameSeason(s, s.ids.game, null)!;
    expect(converted.income).toBe('40');
    expect(converted.expense).toBe('5');
    expect(converted.net).toBe(35);
    expect(converted.records[0]!.amt).toBe(35);
    expect(converted.records[0]!.nativeAmount).toBe('$50.00');
    expect(converted.refCurrencyLabel).toBe('金币');
    expect(converted.missingRateAssetCodes).toEqual([]);

    s.priceMarks = s.priceMarks.filter((row) => row.assetId !== usd.id);
    const missing = buildGameSeason(s, s.ids.game, null)!;
    expect(missing.missingRateAssetCodes).toEqual(['USD']);
    expect(missing.net).toBe(-5);
  });
});
