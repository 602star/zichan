import { describe, it, expect } from 'vitest';
import { openLedger } from '@zichan/db/node';
import { createGameWithDefaultSeason } from '../src/screens/Game.js';
import { ALL_GAME_RECORDS, UNASSIGNED_GAME_RECORDS, buildGameSeason } from '../src/selectors/game.js';
import { gameAccountForm, gameRecordForm, gameSeasonForm } from '../src/forms.js';
import { makeSnapshot } from './fixtures.js';

describe('game first use', () => {
  it('creates the game and default current season in one command', async () => {
    const store = await openLedger({ deviceId: 'game-first-use' });
    try {
      const created = await createGameWithDefaultSeason(store, '  最终幻想 XIV  ', '2026-08-31');

      expect(created.game).toMatchObject({ name: '最终幻想 XIV', enableSeason: true, isActive: true });
      expect(created.season).toMatchObject({
        gameId: created.game.id,
        name: '当前赛季',
        status: 'active',
        startDate: '2026-08-31',
      });
      expect(await store.games.count()).toBe(1);
      expect(await store.gameSeasons.count()).toBe(1);
      expect(await store.gameAccounts.count()).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('does not write a partial game when the name is blank', async () => {
    const store = await openLedger({ deviceId: 'game-first-use-blank' });
    try {
      await expect(createGameWithDefaultSeason(store, '   ', '2026-08-31')).rejects.toThrow('请输入游戏名称');
      expect(await store.games.count()).toBe(0);
      expect(await store.gameSeasons.count()).toBe(0);
    } finally {
      await store.close();
    }
  });
});

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

  it('keeps game records accessible when there are no seasons', () => {
    const s = makeSnapshot();
    s.seasons = [];
    expect(buildGameSeason(s, s.ids.game, null)?.activeId).toBe(ALL_GAME_RECORDS);
    expect(buildGameSeason(s, s.ids.game, null)?.records).toHaveLength(1);
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


describe('game record ownership', () => {
  it('shows unassigned records without mixing other games or assigning history automatically', () => {
    const snap = makeSnapshot();
    const record = snap.gameRecords[0]!;
    snap.gameRecords.push({ ...record, id: 'unassigned', seasonId: undefined });
    snap.gameRecords.push({ ...record, id: 'foreign', gameId: 'another-game', seasonId: undefined });
    expect(buildGameSeason(snap, snap.ids.game, null)?.records.map((r) => r.raw.id)).toEqual([record.id]);
    expect(buildGameSeason(snap, snap.ids.game, ALL_GAME_RECORDS)?.records).toHaveLength(2);
    const unassigned = buildGameSeason(snap, snap.ids.game, UNASSIGNED_GAME_RECORDS)!;
    expect(unassigned.records.map((r) => r.raw.id)).toEqual(['unassigned']);
    expect(unassigned.unassignedCount).toBe(1);
    expect(unassigned.season).toBeUndefined();
    expect(snap.gameRecords[1]!.seasonId).toBeUndefined();
    snap.gameRecords[1]!.seasonId = snap.seasons[0]!.id;
    expect(buildGameSeason(snap, snap.ids.game, null)?.records).toHaveLength(2);
    expect(buildGameSeason(snap, snap.ids.game, UNASSIGNED_GAME_RECORDS)?.records).toHaveLength(0);
  });

  it('shares season fields and applies context only to defaults, with explicit clearing', () => {
    const snap = makeSnapshot();
    snap.gameCashflowLinks = [];
    const seasonId = snap.seasons[0]!.id;
    const form = gameRecordForm(snap, { gameId: snap.ids.game, seasonId });
    expect(form.fields.find((f) => f.key === 'gameId')?.defaultValue).toBe(snap.ids.game);
    expect(form.fields.find((f) => f.key === 'seasonId')?.defaultValue).toBe(seasonId);
    expect(form.fields.find((f) => f.key === 'seasonId')?.resetWhen).toEqual(['gameId']);
    const record = snap.gameRecords[0]!;
    expect(form.fromValues({ ...form.toValues(record), seasonId: '' }, record).seasonId).toBe('');
    const managed = gameSeasonForm(snap);
    const contextual = gameSeasonForm(snap, snap.ids.game);
    expect(contextual.fields.map((f) => ({ ...f, defaultValue: undefined }))).toEqual(managed.fields.map((f) => ({ ...f, defaultValue: undefined })));
    expect(gameAccountForm(snap, snap.ids.game).fields.find((f) => f.key === 'gameId')?.defaultValue).toBe(snap.ids.game);
  });
});
