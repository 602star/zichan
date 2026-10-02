import { describe, expect, it } from 'vitest';
import { checkConsistency, exportLedger, preflightImport } from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import { seedIfEmpty } from '../src/db/seed.js';
import { loadSnapshot } from '../src/db/snapshot.js';
import { buildFixed } from '../src/selectors/fixed.js';

describe('real demo ledger workflow', () => {
  it('seeds, calculates, backs up, and keeps module defaults non-retroactive', async () => {
    const store = await openLedger({ deviceId: 'web-real-flow' });
    await Promise.all([seedIfEmpty(store), seedIfEmpty(store)]);
    expect(await checkConsistency(store)).toEqual([]);
    expect(await store.settings.count()).toBe(1);

    const snapshot = await loadSnapshot(store);
    const convertSnapshot = await loadSnapshot(store, 'convert');
    expect(convertSnapshot.transactions.length).toBeGreaterThan(0);
    expect(convertSnapshot.transactions).toEqual(snapshot.transactions);
    expect(snapshot.setting?.ledgerKind).toBe('demo');
    expect(snapshot.setting?.initializedAt).toBeTruthy();
    expect(snapshot.setting?.transactionDefaultAssetId).toBe(snapshot.setting?.baseCurrencyAssetId);
    expect(snapshot.fixedAssetCategories.length).toBeGreaterThan(40);
    expect(snapshot.fixedUsageMetrics.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.fixedConsumables.length).toBeGreaterThanOrEqual(6);
    expect(snapshot.fixedGoals.length).toBeGreaterThanOrEqual(2);
    const items = buildFixed(snapshot, '2026-07-10');
    expect(items.find((item) => item.name === 'Corolla Hybrid')?.metrics[0]?.unitLabel).toBe('公里');
    expect(items.find((item) => item.name === '客厅空调')?.goals.length).toBe(1);

    const backup = await exportLedger(store);
    const preflight = preflightImport(backup);
    expect(preflight.issues.filter((issue) => issue.level === 'error'), JSON.stringify(preflight.issues, null, 2)).toEqual([]);
    expect(backup.fixedAssetConsumables?.length).toBe(snapshot.fixedConsumables.length);

    const transaction = snapshot.transactions[0]!;
    const fixed = snapshot.fixedAssets[0]!;
    const setting = snapshot.setting!;
    const otherAsset = snapshot.assets.find((asset) => asset.id !== setting.baseCurrencyAssetId)!;
    await store.settings.put({ ...setting, transactionDefaultAssetId: otherAsset.id, fixedAssetDefaultCurrencyAssetId: otherAsset.id });
    expect((await store.transactions.get(transaction.id))?.assetId).toBe(transaction.assetId);
    expect((await store.fixedAssets.get(fixed.id))?.baseCurrencyAssetId).toBe(fixed.baseCurrencyAssetId);
    await store.close();
  });
});
