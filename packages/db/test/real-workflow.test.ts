import { describe, it, expect } from 'vitest';
import { openLedger } from '../src/node.js';
import {
  checkConsistency,
  exportLedger,
  memoryCommitTransport,
  recordConversion,
  recordSell,
  restoreLedger,
  saveFixedAssetAcquisition,
  saveFixedAssetEvent,
  saveTransaction,
  syncReplica,
} from '../src/index.js';
import {
  D,
  newId,
  type Account,
  type Attachment,
  type Asset,
  type Category,
  type ConversionChain,
  type ConversionStep,
  type DcaExecution,
  type DcaPlan,
  type FixedAsset,
  type FixedAssetCategory,
  type FixedAssetEvent,
  type Game,
  type GameAccount,
  type GameRecord,
  type GameSeason,
  type PriceMark,
  type Setting,
  type Transaction,
} from '@zichan/core';

const base = () => ({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false });

function asset(code: string, type: Asset['type'], decimals: number, symbol?: string): Asset {
  return { ...base(), code, name: code, type, decimals, symbol, isActive: true } as Asset;
}

function chain(type: ConversionChain['type'], date: string, baseCurrencyAssetId: string, title: string): ConversionChain {
  return { ...base(), type, date, title, baseCurrencyAssetId } as ConversionChain;
}

function step(chainId: string, order: number, fromAssetId: string, fromAmount: string, toAssetId: string, toAmount: string, feeAssetId?: string, feeAmount?: string, feeValueInBase?: string): ConversionStep {
  const targetFee = feeAssetId === toAssetId && !!feeAmount;
  return { id: newId(), chainId, order, fromAssetId, fromAmount, toAssetId, toAmount: targetFee ? D(toAmount).plus(feeAmount!).toString() : toAmount, fees: feeAssetId && feeAmount ? [{ id: newId(), assetId: feeAssetId, amount: feeAmount, treatment: feeAssetId === fromAssetId ? 'source_extra' : targetFee ? 'target_deducted' : 'third_asset_extra', valueInBase: feeValueInBase }] : [] } as ConversionStep;
}

describe('real-use workflow smoke', () => {
  it('records assets, DCA, sell, fixed asset, game record, and a sync conflict', async () => {
    const store = await openLedger({ deviceId: 'real-A' });
    const gbp = asset('GBP', 'fiat', 2, '£');
    const usdt = asset('USDT', 'stablecoin', 6);
    const btc = asset('BTC', 'crypto', 8);
    for (const a of [gbp, usdt, btc]) await store.assets.put(a);
    await store.settings.put({ ...base(), baseCurrencyAssetId: gbp.id, ledgerMode: 'accounts', defaultLotMethod: 'fifo', asOfDate: '2026-03-04' } as Setting);
    const bank = await store.accounts.put({ ...base(), name: 'HSBC', kind: 'bank', isActive: true } as Account);

    const foodParent: Category = { ...base(), name: '食品餐饮', type: 'expense', isActive: true, budgetable: true, sortOrder: 10 } as Category;
    const lunchCategory: Category = { ...base(), name: '日常正餐', type: 'expense', parentId: foodParent.id, isActive: true, budgetable: true, sortOrder: 10 } as Category;
    await store.categories.put(foodParent);
    await store.categories.put(lunchCategory);
    const lunch = await saveTransaction(store, {
      ...base(), date: '2026-07-10', time: '12:30', timezone: 'Asia/Shanghai', type: 'expense',
      category: lunchCategory.id, amount: '28', assetId: gbp.id, accountId: bank.id, description: '午餐',
    } as Transaction);
    await store.attachments.put({
      ...base(), entityType: 'transaction', entityId: lunch.id, fileName: 'receipt.jpg', mimeType: 'image/jpeg',
      sizeBytes: 1, sha256: 'a'.repeat(64),
    } as Attachment);

    const plan: DcaPlan = {
      ...base(),
      name: 'BTC weekly',
      targetAssetId: btc.id,
      baseCurrencyAssetId: gbp.id,
      anchorDate: '2026-03-02',
      anchorMode: 'calendar_day',
      timezone: 'Europe/London',
      frequency: 'weekly',
      plannedAmount: '250',
      reminderDaysBefore: 3,
      status: 'active',
    } as DcaPlan;
    await store.dcaPlans.put(plan);
    const dca = chain('dca', '2026-03-02', gbp.id, 'GBP -> USDT -> BTC');
    const dcaResult = await recordConversion(store, {
      chain: dca,
      steps: [
        step(dca.id, 1, gbp.id, '250', usdt.id, '312.10', gbp.id, '1.50'),
        step(dca.id, 2, usdt.id, '311.50', btc.id, '0.003317', usdt.id, '0.60', '0.48'),
      ],
    });
    await store.dcaExecutions.put({
      ...base(),
      planId: plan.id,
      occurrenceIndex: 0,
      scheduledDate: dca.date,
      date: dca.date,
      plannedAmount: '250',
      actualBaseCost: dcaResult.chain.totalBaseCost!,
      baseCurrencyAssetId: gbp.id,
      finalAssetId: btc.id,
      finalAmount: '0.003317',
      totalFeeInBase: dcaResult.chain.totalFeesInBase!,
      chainId: dcaResult.chain.id,
    } as DcaExecution);

    const sell = chain('sell', '2026-03-05', gbp.id, 'BTC -> GBP sell');
    await recordSell(store, {
      chain: sell,
      steps: [
        step(sell.id, 1, btc.id, '0.001', usdt.id, '95.90', usdt.id, '0.10', '0.08'),
        step(sell.id, 2, usdt.id, '95.90', gbp.id, '76.00', gbp.id, '0.50'),
      ],
      method: 'fifo',
    });

    const fixedParent: FixedAssetCategory = { ...base(), name: '数码电子', isActive: true, sortOrder: 10 } as FixedAssetCategory;
    const fixedCategory: FixedAssetCategory = { ...base(), name: '电脑', parentId: fixedParent.id, isActive: true, sortOrder: 10 } as FixedAssetCategory;
    await store.fixedAssetCategories.put(fixedParent);
    await store.fixedAssetCategories.put(fixedCategory);
    const fixed: FixedAsset = { ...base(), name: 'Laptop', categoryId: fixedCategory.id, status: 'active', purchaseDate: '2026-01-01', baseCurrencyAssetId: gbp.id } as FixedAsset;
    await saveFixedAssetAcquisition(store, {
      asset: fixed,
      purchaseAmount: '1200',
      cashflow: { mode: 'record_only', sourceAmount: '0' },
    });
    await saveFixedAssetEvent(store, {
      event: { ...base(), fixedAssetId: fixed.id, type: 'sale', date: '2026-07-01', amountBase: '800', cashflowMode: 'record_only' } as FixedAssetEvent,
      cashflow: { mode: 'record_only', sourceAmount: '0' },
    });
    expect((await store.fixedAssets.get(fixed.id))?.status).toBe('sold');

    const game: Game = { ...base(), name: 'Abyss', enableSeason: true } as Game;
    await store.games.put(game);
    const account: GameAccount = { ...base(), gameId: game.id, accountName: 'Main', status: 'active' } as GameAccount;
    await store.gameAccounts.put(account);
    const season: GameSeason = { ...base(), gameId: game.id, name: 'S1', status: 'active', startDate: '2026-03-01', hours: '5' } as GameSeason;
    await store.gameSeasons.put(season);
    await store.gameRecords.put({ ...base(), date: '2026-03-04', gameId: game.id, seasonId: season.id, gameAccountId: account.id, recordType: 'sell_currency', settlementAssetId: gbp.id, settlementAmount: '20' } as GameRecord);

    const backup = await exportLedger(store);
    const temporary: Transaction = { ...lunch, id: newId(), description: '恢复后应消失' };
    await store.transactions.put(temporary);
    const restored = await restoreLedger(store, backup);
    expect(restored.removed).toBe(1);
    expect(await store.transactions.get(temporary.id).then((row) => row?.isDeleted)).toBe(true);

    expect(await checkConsistency(store)).toEqual([]);

    const b = await openLedger({ deviceId: 'real-B' });
    await b.adoptLedgerId(await store.getLedgerId());
    const transport = memoryCommitTransport();
    const markId = newId();
    await store.priceMarks.put({ ...base(), id: markId, assetId: btc.id, quoteAssetId: gbp.id, price: '76000', date: '2026-03-04', source: 'manual' } as PriceMark);
    await syncReplica(store, transport, 'real');
    await syncReplica(b, transport, 'real');
    await store.priceMarks.put({ ...(await store.priceMarks.get(markId))!, price: '77000' });
    await syncReplica(store, transport, 'real');
    await b.priceMarks.put({ ...(await b.priceMarks.get(markId))!, price: '78000' });
    await syncReplica(b, transport, 'real');
    expect((await b.listConflicts()).some((group) => group.branches.some((branch) => branch.aggregateType === 'price_mark'))).toBe(true);

    await store.close();
    await b.close();
  });
});
