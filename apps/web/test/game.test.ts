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
    expect(converted.currencyBalances).toEqual([]);
    expect(converted.missingRateAssetCodes).toEqual([]);

    s.priceMarks = s.priceMarks.filter((row) => row.assetId !== usd.id);
    const missing = buildGameSeason(s, s.ids.game, null)!;
    expect(missing.missingRateAssetCodes).toEqual(['USD']);
    expect(missing.net).toBe(-5);
  });
});


describe('game record ownership', () => {
  it('requires paired quantities and prices while allowing an explicit unknown-price backfill', () => {
    const snap = makeSnapshot();
    snap.gameRecords[0]!.gameCurrencyName = '通货';
    const form = gameRecordForm(snap, { gameId: snap.ids.game });
    const choice = form.fields.find((field) => field.key === 'gameCurrencyChoice')!;
    const options = typeof choice.options === 'function' ? choice.options({ gameId: snap.ids.game }) : choice.options;
    expect(options?.map((option) => option.value)).toContain('通货');
    const item = { recordType: 'buy_equipment', itemTradeMode: 'game_currency', gameId: snap.ids.game, gameCurrencyChoice: '通货', gameCurrencyAmount: '100', priceKnowledge: 'known', rateAssetId: snap.ids.gbp };
    expect(form.validate?.(item)).toEqual({ manualRate: expect.stringContaining('必须大于 0') });
    expect(form.validate?.({ ...item, priceKnowledge: 'unknown' })).toBeUndefined();
    expect(form.validate?.({ ...item, manualRate: '2' })).toBeUndefined();
    expect(form.validate?.({ ...item, gameCurrencyAmount: '' })).toEqual({ gameCurrencyAmount: '请输入游戏币数量' });
    expect(form.validate?.({ ...item, itemTradeMode: 'cash', settlementAssetId: '', settlementAmount: '' })).toEqual({ settlementAssetId: '请选择实际收支币种' });
    expect(form.validate?.({ ...item, itemTradeMode: 'cash', settlementAssetId: snap.ids.gbp, settlementAmount: '' })).toEqual({ settlementAmount: '请输入实际收支金额' });
    const currency = { recordType: 'buy_currency', gameId: snap.ids.game, gameCurrencyChoice: '通货', gameCurrencyAmount: '100', priceKnowledge: 'unknown' };
    expect(form.validate?.({ ...currency, settlementAssetId: snap.ids.gbp })).toEqual({ settlementAmount: '请输入实际收支金额' });
    expect(form.validate?.({ ...currency, settlementAmount: '20' })).toEqual({ settlementAssetId: '请选择实际收支币种' });
    expect(form.validate?.({ ...currency, feeAmount: '1' })).toEqual({ feeAssetId: '请选择现实手续费币种' });
    expect(form.validate?.({ ...currency, feeAssetId: snap.ids.gbp })).toEqual({ feeAmount: '请输入现实手续费金额' });
  });

  it('shows separate reference balances for different game currency names', () => {
    const s = makeSnapshot();
    const base = s.gameRecords[0]!;
    s.gameRecords = [
      { ...base, id: 'first', recordType: 'buy_currency', gameCurrencyName: '通货', gameCurrencyAmount: '100', settlementAmount: undefined, settlementAssetId: undefined },
      { ...base, id: 'second', recordType: 'buy_currency', gameCurrencyName: '金币', gameCurrencyAmount: '20', settlementAmount: undefined, settlementAssetId: undefined },
    ];
    expect(buildGameSeason(s, s.ids.game, null)?.currencyBalances).toEqual([
      { currencyName: '金币', balance: '20' },
      { currencyName: '通货', balance: '100' },
    ]);
  });

  it('shows fields that belong to the selected record type and clears incompatible draft values', () => {
    const snap = makeSnapshot();
    snap.gameCashflowLinks = [];
    const form = gameRecordForm(snap);
    const visible = (key: string, values: Record<string, string>) => form.fields.find((field) => field.key === key)?.visibleWhen?.(values);
    expect(visible('gameCurrencyAmount', { recordType: 'buy_currency' })).toBe(true);
    expect(visible('gameCurrencyAmount', { recordType: 'produce' })).toBe(true);
    expect(visible('gameCurrencyAmount', { recordType: 'sell_equipment', itemTradeMode: 'game_currency' })).toBe(true);
    expect(visible('settlementAmount', { recordType: 'sell_equipment', itemTradeMode: 'game_currency' })).toBe(false);
    expect(visible('settlementAmount', { recordType: 'sell_equipment', itemTradeMode: 'cash' })).toBe(true);
    expect(visible('gameCurrencyAmount', { recordType: 'sell_equipment', itemTradeMode: 'cash' })).toBe(false);
    expect(visible('gameCurrencyAmount', { recordType: 'buy_equipment', itemTradeMode: 'game_currency' })).toBe(true);
    expect(visible('settlementAmount', { recordType: 'buy_equipment', itemTradeMode: 'game_currency' })).toBe(false);
    expect(visible('settlementAmount', { recordType: 'buy_material', itemTradeMode: 'cash' })).toBe(true);
    expect(visible('gameCurrencyAmount', { recordType: 'boosting_cost' })).toBe(false);
    expect(visible('settlementAmount', { recordType: 'boosting_cost' })).toBe(true);
    expect(visible('settlementAmount', { recordType: 'produce' })).toBe(false);
    expect(visible('feeAmount', { recordType: 'fee' })).toBe(false);

    const cost = form.onFieldChange?.({
      recordType: 'boosting_cost', gameCurrencyName: '金币', gameCurrencyAmount: '100',
      settlementAmount: '20', feeAmount: '2',
    }, 'recordType', new Set(['recordType']));
    expect(cost).toMatchObject({ gameCurrencyName: '', gameCurrencyAmount: '', settlementAmount: '20', feeAmount: '2' });
    const production = form.onFieldChange?.({
      recordType: 'produce', settlementAssetId: 'gbp', settlementAmount: '20', settlementTransactionId: 'tx',
    }, 'recordType', new Set(['recordType']));
    expect(production).toMatchObject({ settlementAssetId: '', settlementAmount: '', settlementTransactionId: '' });
    const standaloneFee = form.onFieldChange?.({
      recordType: 'fee', feeAssetId: 'gbp', feeAmount: '2', feeTransactionId: 'tx',
    }, 'recordType', new Set(['recordType']));
    expect(standaloneFee).toMatchObject({ feeAssetId: '', feeAmount: '', feeTransactionId: '' });
    expect(visible('gameCurrencyAmount', { recordType: 'boosting_cost', gameCurrencyAmount: '100' })).toBe(false);
    const cashSale = form.onFieldChange?.({ recordType: 'sell_equipment', itemTradeMode: 'cash', gameCurrencyAmount: '500' }, 'itemTradeMode', new Set(['itemTradeMode']));
    expect(cashSale?.gameCurrencyAmount).toBe('');
    const currencySale = form.onFieldChange?.({ recordType: 'sell_equipment', itemTradeMode: 'game_currency', settlementAmount: '20' }, 'itemTradeMode', new Set(['itemTradeMode']));
    expect(currencySale?.settlementAmount).toBe('');
    const legacyCash = form.toValues({ ...snap.gameRecords[0]!, recordType: 'sell_material' });
    expect(legacyCash.itemTradeMode).toBe('cash');
    const directBuy = form.toValues({ ...snap.gameRecords[0]!, recordType: 'buy_equipment' });
    expect(directBuy.itemTradeMode).toBe('cash');
    const currencyFee = form.fromValues({ ...form.toValues(snap.gameRecords[0]!), gameCurrencyFeeAmount: '100' });
    expect(currencyFee.gameCurrencyFeeAmount).toBe('100');
    const pricedEquipment = form.fromValues({ ...form.toValues(snap.gameRecords[0]!), recordType: 'buy_equipment', itemTradeMode: 'game_currency', priceKnowledge: 'known', gameCurrencyAmount: '100', manualRate: '2', rateAssetId: snap.ids.gbp, settlementAmount: '', settlementAssetId: '' });
    expect(pricedEquipment).toMatchObject({ manualRate: '2', rateAssetId: snap.ids.gbp });
    expect(form.toValues(pricedEquipment)).toMatchObject({ manualRate: '2', rateAssetId: snap.ids.gbp });
    expect(visible('manualRate', { recordType: 'buy_equipment', itemTradeMode: 'game_currency' })).toBe(true);
    expect(visible('manualRate', { recordType: 'buy_currency', settlementAmount: '50', settlementAssetId: snap.ids.gbp })).toBe(false);
    const pricedCurrency = form.fromValues({ ...form.toValues(snap.gameRecords[0]!), recordType: 'buy_currency', gameCurrencyAmount: '100', settlementAmount: '50', settlementAssetId: snap.ids.gbp });
    expect(pricedCurrency).toMatchObject({ manualRate: '2', rateAssetId: snap.ids.gbp });
    expect(form.summary?.({ recordType: 'buy_currency', gameCurrencyName: '通货', gameCurrencyAmount: '100', settlementAmount: '50', settlementAssetId: snap.ids.gbp })).toContain('1 GBP ≈ 2 通货');
    expect(form.validate?.({ recordType: 'buy_currency', gameCurrencyChoice: '__new_game_currency__', gameCurrencyName: '通货', gameCurrencyAmount: '0', settlementAmount: '50', settlementAssetId: snap.ids.gbp })).toEqual({ gameCurrencyAmount: '游戏币数量必须大于 0' });
    expect(form.validate?.({ recordType: 'buy_equipment', itemTradeMode: 'game_currency', gameCurrencyChoice: '__new_game_currency__', gameCurrencyName: '通货', gameCurrencyAmount: '100', manualRate: '0', rateAssetId: snap.ids.gbp })).toEqual({ manualRate: expect.stringContaining('必须大于 0') });
    expect(form.refreshDefaults?.({ saleProceedsMode: 'cash', itemTradeMode: 'game_currency' }, new Set(['saleProceedsMode']))?.itemTradeMode).toBe('cash');
  });

  it('keeps separate historical valuations visible in the record stream', () => {
    const snap = makeSnapshot();
    const record = snap.gameRecords[0]!;
    snap.gameRecords = [
      { ...record, id: 'buy', recordType: 'buy_equipment', settlementAmount: undefined, settlementAssetId: undefined, gameCurrencyName: '通货', gameCurrencyAmount: '100', manualRate: '2', rateAssetId: snap.ids.gbp },
      { ...record, id: 'sell', recordType: 'sell_equipment', settlementAmount: undefined, settlementAssetId: undefined, gameCurrencyName: '通货', gameCurrencyAmount: '10', manualRate: '10', rateAssetId: snap.ids.gbp },
    ];
    const vm = buildGameSeason(snap, snap.ids.game, null)!;
    expect(vm.records.map((row) => row.nativeAmount)).toEqual([
      '100 通货 · 成交 1 GBP≈2 通货 · 估值 50 GBP',
      '10 通货 · 成交 1 GBP≈10 通货 · 估值 1 GBP',
    ]);
    expect(vm.net).toBe(0);
  });

  it('suggests game cashflow categories and keeps a valid manual choice', () => {
    const form = gameRecordForm(makeSnapshot());
    const settlement = form.fields.find((field) => field.key === 'settlementCategoryId')!;
    const fee = form.fields.find((field) => field.key === 'feeCategoryId')!;
    expect(settlement.defaultValue).toBe('games');
    expect(fee.defaultValue).toBe('bank_fee');

    const income = form.onFieldChange?.({ recordType: 'sell_currency', settlementCategoryId: 'games' }, 'recordType', new Set(['recordType']));
    expect(income?.settlementCategoryId).toBe('other_income');
    const expense = form.onFieldChange?.({ ...income, recordType: 'topup' }, 'recordType', new Set(['recordType']));
    expect(expense?.settlementCategoryId).toBe('games');
    const manual = form.onFieldChange?.({ recordType: 'topup', settlementCategoryId: 'shopping' }, 'recordType', new Set(['recordType', 'settlementCategoryId']));
    expect(manual?.settlementCategoryId).toBe('shopping');
    const switched = form.onFieldChange?.({ recordType: 'withdraw', settlementCategoryId: 'shopping' }, 'recordType', new Set(['recordType', 'settlementCategoryId']));
    expect(switched?.settlementCategoryId).toBe('other_income');
  });

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
