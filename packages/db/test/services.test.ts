import { describe, it, expect } from 'vitest';
import { openLedger } from '../src/node.js';
import {
  recordConversion, recordSell, updateConversion, voidConversion, restoreConversion,
  exportLedger, importLedger, restoreLedger, preflightImport,
} from '../src/index.js';
import { D, newId, round, type ConversionChain, type ConversionStep, type Asset } from '@zichan/core';

function base() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}
function chain(type: ConversionChain['type'], date = '2026-03-02'): ConversionChain {
  return { ...base(), date, type, baseCurrencyAssetId: 'GBP' } as ConversionChain;
}
function step(
  chainId: string, order: number, fromAssetId: string, fromAmount: string,
  toAssetId: string, toAmount: string, fee?: { assetId: string; amount: string; base?: string },
): ConversionStep {
  const targetFee = fee?.assetId === toAssetId;
  return {
    id: newId(), chainId, order, fromAssetId, fromAmount, toAssetId,
    toAmount: targetFee ? D(toAmount).plus(fee!.amount).toString() : toAmount,
    fees: fee ? [{ id: newId(), assetId: fee.assetId, amount: fee.amount, treatment: fee.assetId === fromAssetId ? 'source_extra' : targetFee ? 'target_deducted' : 'third_asset_extra', valueInBase: fee.base }] : [],
  };
}

async function buyBtc(store: Awaited<ReturnType<typeof openLedger>>, date: string, btc: string) {
  for (const [id, type, decimals] of [['GBP', 'fiat', 2], ['USDT', 'stablecoin', 6], ['BTC', 'crypto', 8]] as const) {
    if (!(await store.assets.get(id))) await store.assets.put({ ...base(), id, code: id, name: id, type, decimals, isActive: true } as Asset);
  }
  const c = chain('dca', date);
  return recordConversion(store, {
    chain: c,
    steps: [
      step(c.id, 1, 'GBP', '250', 'USDT', '312', { assetId: 'GBP', amount: '1.50' }),
      step(c.id, 2, 'USDT', '311.50', 'BTC', btc, { assetId: 'USDT', amount: '0.50', base: '0.40' }),
    ],
  });
}

describe('services: recordConversion', () => {
  it('creates a lot for a dca/buy chain and back-fills derived caches', async () => {
    const store = await openLedger();
    const { chain: saved, lot } = await buyBtc(store, '2026-01-01', '0.003317');
    expect(lot).toBeDefined();
    expect(lot!.assetId).toBe('BTC');
    expect(round(lot!.originalAmount, 6)).toBe('0.003317');
    expect(round(lot!.baseCost, 2)).toBe('251.50'); // 250 + 1.50 GBP fee
    expect(round(saved.totalBaseCost!, 2)).toBe('251.50');
    expect(saved.finalAssetId).toBe('BTC');
    // persisted
    expect((await store.lots.list()).length).toBe(1);
    await store.close();
  });
});

describe('services: recordSell', () => {
  it('matches FIFO against open lots, writes consumptions, updates lots, back-fills P&L', async () => {
    const store = await openLedger();
    await buyBtc(store, '2026-01-01', '0.003'); // lot1
    await buyBtc(store, '2026-02-01', '0.004'); // lot2

    const c = chain('sell', '2026-03-01');
    const { chain: saved, match } = await recordSell(store, {
      chain: c,
      steps: [
        step(c.id, 1, 'BTC', '0.005', 'USDT', '489.40', { assetId: 'USDT', amount: '0.80', base: '0.64' }),
        step(c.id, 2, 'USDT', '488.60', 'GBP', '387.90', { assetId: 'GBP', amount: '1.30' }),
      ],
      method: 'fifo',
    });

    // The entered 387.90 is the account receipt; storage keeps 389.20 gross.
    expect(round(saved.totalBaseProceeds!, 2)).toBe('387.90');
    expect(round(saved.realizedGainLoss!, 2)).toBe(round(match.realizedPnlBase, 2));
    expect(match.consumptions.length).toBe(2); // lot1 fully + lot2 partially
    expect(match.unmatchedAmount).toBe('0');

    // lot1 closed, lot2 partially consumed → 0.002 remaining
    const lots = await store.lots.list();
    const remaining = lots.reduce((n, l) => n + Number(l.remainingAmount), 0);
    expect(round(String(remaining), 3)).toBe('0.002'); // 0.007 held - 0.005 sold

    // consumptions persisted
    expect((await store.lotConsumptions.list()).length).toBe(2);
    await store.close();
  });
});

describe('services: voidConversion', () => {
  it('voiding a buy removes its lot impact and retains a restorable chain', async () => {
    const store = await openLedger();
    const { chain, lot } = await buyBtc(store, '2026-01-01', '0.003317');
    expect((await store.lots.list()).length).toBe(1);

    await voidConversion(store, chain.id);
    expect((await store.lots.list()).length).toBe(0); // soft-deleted
    expect(await store.conversionChains.get(chain.id).then((c) => c?.recordState)).toBe('voided');
    expect(await store.conversionChains.get(chain.id).then((c) => c?.isDeleted)).toBe(false);
    await store.close();
  });

  it('voiding a sell restores consumed lot amounts', async () => {
    const store = await openLedger();
    await buyBtc(store, '2026-01-01', '0.003');
    await buyBtc(store, '2026-02-01', '0.004');
    const c = chain('sell', '2026-03-01');
    await recordSell(store, {
      chain: c,
      steps: [
        step(c.id, 1, 'BTC', '0.005', 'USDT', '489', { assetId: 'USDT', amount: '0.8', base: '0.64' }),
        step(c.id, 2, 'USDT', '488', 'GBP', '387.90', { assetId: 'GBP', amount: '1.30' }),
      ],
      method: 'fifo',
    });
    // 0.007 held − 0.005 sold = 0.002 remaining
    const before = (await store.lots.list()).reduce((n, l) => n + Number(l.remainingAmount), 0);
    expect(round(String(before), 3)).toBe('0.002');

    await voidConversion(store, c.id);
    const after = (await store.lots.list()).reduce((n, l) => n + Number(l.remainingAmount), 0);
    expect(round(String(after), 3)).toBe('0.007'); // fully restored
    expect((await store.lotConsumptions.list()).length).toBe(0);
    await restoreConversion(store, c.id);
    const restored = (await store.lots.list()).reduce((n, l) => n + Number(l.remainingAmount), 0);
    expect(round(String(restored), 3)).toBe('0.002');
    await store.close();
  });

  it('rejects voiding or shrinking a buy when a later sell would exceed historical holdings', async () => {
    const store = await openLedger();
    const bought = await buyBtc(store, '2026-01-01', '0.006');
    const sell = chain('sell', '2026-02-01');
    await recordSell(store, {
      chain: sell,
      steps: [
        step(sell.id, 1, 'BTC', '0.005', 'USDT', '489', { assetId: 'USDT', amount: '0.8', base: '0.64' }),
        step(sell.id, 2, 'USDT', '488', 'GBP', '387.90', { assetId: 'GBP', amount: '1.30' }),
      ],
      method: 'fifo',
    });

    await expect(voidConversion(store, bought.chain.id)).rejects.toThrow('超出当时可用持仓');
    expect((await store.conversionChains.get(bought.chain.id))?.recordState).not.toBe('voided');
    const aggregate = await store.getChainWithSteps(bought.chain.id);
    expect(aggregate).not.toBeNull();
    const smallerSteps = aggregate!.steps.map((row, index) => index === aggregate!.steps.length - 1 ? { ...row, toAmount: '0.004' } : row);
    await expect(updateConversion(store, {
      chain: aggregate!.chain,
      steps: smallerSteps,
      expectedVersion: aggregate!.chain.version,
    })).rejects.toThrow('超出当时可用持仓');
    expect((await store.lots.list()).reduce((total, lot) => total + Number(lot.remainingAmount), 0)).toBeCloseTo(0.001, 8);
    await store.close();
  });
});

describe('services: export / import round-trip', () => {
  it('exports every entity and restores it into a fresh store', async () => {
    const store = await openLedger();
    const a: Asset = { ...base(), code: 'ETH', name: 'Ethereum', type: 'crypto', decimals: 8, isActive: true } as Asset;
    await store.assets.put(a);
    await buyBtc(store, '2026-01-01', '0.003317');

    const backup = await exportLedger(store);
    expect(backup.chains.length).toBe(1);
    expect(backup.chains[0]!.steps.length).toBe(2);
    expect(backup.lots.length).toBe(1);
    expect(backup.assets.length).toBe(4);
    await store.close();

    // restore into a brand-new empty store
    const fresh = await openLedger();
    const res = await importLedger(fresh, backup);
    expect(res.chains).toBe(1);
    expect((await fresh.assets.list()).length).toBe(4);
    expect((await fresh.lots.list()).length).toBe(1);
    const chains = await fresh.conversionChains.list();
    expect(chains.length).toBe(1);
    const cws = await fresh.getChainWithSteps(chains[0]!.id);
    expect(cws!.steps.length).toBe(2);
    await fresh.close();
  });

  it('exact restore removes active rows that are absent from the backup', async () => {
    const store = await openLedger();
    const kept: Asset = { ...base(), code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true } as Asset;
    await store.assets.put(kept);
    const backup = await exportLedger(store);
    const extra: Asset = { ...base(), code: 'USD', name: 'Dollar', type: 'fiat', decimals: 2, isActive: true } as Asset;
    await store.assets.put(extra);

    const result = await restoreLedger(store, backup);
    expect(result.removed).toBe(1);
    expect((await store.assets.list()).map((asset) => asset.code)).toEqual(['GBP']);
    expect((await store.assets.get(extra.id))?.isDeleted).toBe(true);
    await store.close();
  });

  it('backs up and restores the complete physical-item lifecycle', async () => {
    const store = await openLedger();
    const gbp: Asset = { ...base(), id: 'GBP', code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true } as Asset;
    await store.assets.put(gbp);
    const categoryParent = await store.fixedAssetCategories.put({ ...base(), name: 'Appliances', sortOrder: 1, isHidden: false, isActive: true } as never);
    const category = await store.fixedAssetCategories.put({ ...base(), name: 'Washer', parentId: categoryParent.id, sortOrder: 2, isHidden: false, isActive: true } as never);
    const item = await store.fixedAssets.put({ ...base(), name: 'Washer', categoryId: category.id, status: 'active', purchaseDate: '2026-01-01', baseCurrencyAssetId: gbp.id } as never);
    await store.fixedAssetEvents.put({ ...base(), fixedAssetId: item.id, date: '2026-01-01', type: 'purchase', amountBase: '500', cashflowMode: 'record_only' } as never);
    const metric = await store.fixedAssetUsageMetrics.put({ ...base(), fixedAssetId: item.id, name: 'Cycles', unit: 'count', entryMode: 'increment', startValue: '0', isPrimary: true, isActive: true } as never);
    await store.fixedAssetUsageLogs.put({ ...base(), fixedAssetId: item.id, metricId: metric.id, date: '2026-02-01', value: '20', entryMode: 'increment' } as never);
    await store.fixedAssetConsumables.put({ ...base(), fixedAssetId: item.id, name: 'Filter', amountBase: '20', cashflowMode: 'record_only', purchaseDate: '2026-01-01', usageMetricId: metric.id, targetLife: '100', status: 'active' } as never);
    await store.fixedAssetGoals.put({ ...base(), fixedAssetId: item.id, name: 'Two per cycle', metricId: metric.id, unit: 'count', mode: 'unit_cost', costBasisAmount: '500', targetUnitCost: '2', targetUsage: '250', startDate: '2026-01-01', status: 'active' } as never);
    await store.attachments.put({
      ...base(), entityType: 'fixed_asset', entityId: item.id, fileName: 'invoice.pdf', mimeType: 'application/pdf', role: 'invoice',
      sizeBytes: 128, sha256: 'a'.repeat(64),
    } as never);

    const backup = await exportLedger(store);
    expect(preflightImport(backup).ok).toBe(true);
    expect(backup.fixedAssetUsageLogs).toHaveLength(1);
    expect(backup.fixedAssetConsumables).toHaveLength(1);
    expect(backup.fixedAssetGoals).toHaveLength(1);
    await store.close();

    const fresh = await openLedger();
    await importLedger(fresh, backup);
    expect(await fresh.fixedAssets.get(item.id)).not.toBeNull();
    expect((await fresh.fixedAssetUsageLogs.list({ where: { fixedAssetId: item.id } }))).toHaveLength(1);
    expect((await fresh.fixedAssetConsumables.list({ where: { fixedAssetId: item.id } }))).toHaveLength(1);
    expect((await fresh.fixedAssetGoals.list({ where: { fixedAssetId: item.id } }))).toHaveLength(1);
    expect((await fresh.attachments.list({ where: { entityType: 'fixed_asset', entityId: item.id } }))[0]?.role).toBe('invoice');
    await fresh.close();
  });

  it('rejects a game record whose season belongs to another game', async () => {
    const store = await openLedger();
    const backup = await exportLedger(store);
    backup.games = [
      { ...base(), id: 'game-a', name: 'A', enableSeason: true },
      { ...base(), id: 'game-b', name: 'B', enableSeason: true },
    ];
    backup.gameSeasons = [{ ...base(), id: 'season-a', gameId: 'game-a', name: 'S1', status: 'active' }];
    backup.gameRecords = [{ ...base(), id: 'record-b', gameId: 'game-b', seasonId: 'season-a', date: '2026-07-10', recordType: 'produce' }];
    const preflight = preflightImport(backup);
    expect(preflight.ok).toBe(false);
    expect(preflight.issues.some((issue) => issue.code === 'season_game_mismatch')).toBe(true);
    await store.close();
  });

  it('rejects an unsupported backup version', async () => {
    const store = await openLedger();
    await expect(importLedger(store, { version: 1 } as never)).rejects.toThrow(/unsupported/);
    await store.close();
  });

  it('preflights healthy backups and summarizes their contents', async () => {
    const store = await openLedger();
    await store.assets.put({ ...base(), code: 'ETH', name: 'Ethereum', type: 'crypto', decimals: 8, isActive: true } as Asset);
    await buyBtc(store, '2026-01-01', '0.003317');
    const preflight = preflightImport(await exportLedger(store));
    expect(preflight.ok).toBe(true);
    expect(preflight.summary.chains).toBe(1);
    expect(preflight.summary.steps).toBe(2);
    await store.close();
  });

  it('rejects backups that omit any current entity collection', async () => {
    const store = await openLedger();
    const backup = await exportLedger(store);
    delete (backup as Partial<typeof backup>).transactionSavedViews;
    const preflight = preflightImport(backup);
    expect(preflight.ok).toBe(false);
    expect(preflight.issues).toContainEqual(expect.objectContaining({ code: 'missing_array', entityType: 'transaction_saved_view' }));
    await expect(importLedger(store, backup)).rejects.toThrow(/preflight failed/);
    await store.close();
  });

  it('blocks imports with duplicate entity ids', async () => {
    const store = await openLedger();
    const a: Asset = { ...base(), code: 'BTC', name: 'Bitcoin', type: 'crypto', decimals: 8, isActive: true } as Asset;
    const backup = await exportLedger(store);
    backup.assets = [a, { ...a, code: 'ETH' }];
    const preflight = preflightImport(backup);
    expect(preflight.ok).toBe(false);
    expect(preflight.issues.some((i) => i.code === 'duplicate_id')).toBe(true);
    await expect(importLedger(store, backup)).rejects.toThrow(/preflight failed/);
    await store.close();
  });

  it('blocks missing references before import', async () => {
    const store = await openLedger();
    const { lot } = await buyBtc(store, '2026-01-01', '0.003317');
    const backup = await exportLedger(store);
    backup.lots = [{ ...lot!, assetId: 'missing-asset' }];
    const preflight = preflightImport(backup);
    expect(preflight.ok).toBe(false);
    expect(preflight.issues.some((i) => i.code === 'missing_asset_ref')).toBe(true);
    await store.close();
  });
});
