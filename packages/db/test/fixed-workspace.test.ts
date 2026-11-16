import { describe, expect, it } from 'vitest';
import { emptyFixedWorkspace, newId, parseFixedWorkspace, type FixedAsset } from '@zichan/core';
import { archiveFixedLocation, completeFixedMaintenance, exportLedger, organizeFixedAssets, restoreLedger, saveFixedAssetAcquisition, saveFixedAssetEvent, updateFixedWorkspace } from '../src/index.js';
import { openLedger } from '../src/node.js';

const base = () => ({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false });
async function setup() {
  const store = await openLedger();
  const currency = await store.assets.put({ ...base(), code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, symbol: '¥', isActive: true });
  await store.settings.put({ ...base(), baseCurrencyAssetId: currency.id, defaultLotMethod: 'fifo' });
  const parent = await store.fixedAssetCategories.put({ ...base(), name: '家电', isActive: true });
  const category = await store.fixedAssetCategories.put({ ...base(), name: '厨房电器', parentId: parent.id, isActive: true });
  await updateFixedWorkspace(store, () => ({ ...emptyFixedWorkspace(), locations: [{ id: 'home', name: '家' }, { id: 'kitchen', parentId: 'home', name: '厨房' }, { id: 'room', name: '卧室' }] }));
  const item = await store.fixedAssets.put({ ...base(), name: '咖啡机', categoryId: category.id, status: 'active', purchaseDate: '2026-01-01', baseCurrencyAssetId: currency.id, storageLocationId: 'kitchen' });
  return { store, item };
}

describe('物品整理事务与兼容', () => {
  it('keeps a detached component at the current physical location of its former host', async () => {
    const { store, item } = await setup();
    try {
      const host = await store.fixedAssets.put({ ...item, purchaseDate: '2024-01-01' });
      const part = await store.fixedAssets.put({ ...item, ...base(), name: '滤水配件', role: 'component', purchaseDate: '2024-01-01', storageLocationId: undefined });
      await saveFixedAssetEvent(store, { event: { ...base(), fixedAssetId: part.id, hostAssetId: item.id, type: 'install', date: '2025-01-01', amountBase: '0' } });
      await organizeFixedAssets(store, [host], { locationId: 'room' });
      await saveFixedAssetEvent(store, { event: { ...base(), fixedAssetId: part.id, type: 'detach', date: '2025-02-01', amountBase: '0' } });
      expect((await store.fixedAssets.get(part.id))?.storageLocationId).toBe('room');
      expect(await store.transactions.list()).toHaveLength(0);
    } finally { await store.close(); }
  });
  it('moves a selected batch atomically, rejects stale versions and preserves linked balances', async () => {
    const { store, item } = await setup();
    try {
      await expect(organizeFixedAssets(store, [{ id: item.id, version: item.version }, { id: 'missing', version: 1 }], { locationId: 'room' })).rejects.toThrow('已变更');
      expect((await store.fixedAssets.get(item.id))?.storageLocationId).toBe('kitchen');
      await organizeFixedAssets(store, [item], { locationId: 'room' });
      const moved = (await store.fixedAssets.get(item.id))!;
      expect(JSON.parse(moved.locationMovesJson!)[0]).toMatchObject({ from: '家 / 厨房', to: '卧室' });
      await expect(organizeFixedAssets(store, [item], { locationId: 'kitchen' })).rejects.toThrow('已变更');
      expect(await store.transactions.list()).toHaveLength(0);
    } finally { await store.close(); }
  });
  it('archives a location subtree, migrates items and round-trips the directory and moves', async () => {
    const { store, item } = await setup();
    const restored = await openLedger();
    try {
      await expect(archiveFixedLocation(store, 'home', 'kitchen')).rejects.toThrow('不能迁移');
      await archiveFixedLocation(store, 'home', 'room');
      expect((await store.fixedAssets.get(item.id))?.storageLocationId).toBe('room');
      const preferences = parseFixedWorkspace((await store.settings.list())[0]?.fixedAssetWorkspaceJson);
      expect(preferences.locations.filter((row) => row.archived).map((row) => row.id)).toEqual(['home', 'kitchen']);
      await restoreLedger(restored, await exportLedger(store));
      expect((await restored.fixedAssets.get(item.id))?.locationMovesJson).toBe((await store.fixedAssets.get(item.id))?.locationMovesJson);
      expect((await restored.settings.list())[0]?.fixedAssetWorkspaceJson).toBe((await store.settings.list())[0]?.fixedAssetWorkspaceJson);
    } finally { await restored.close(); await store.close(); }
  });
  it('advances maintenance only after completion, writes a zero-cost history event and rejects repeats', async () => {
    const { store, item } = await setup();
    try {
      const scheduled = await store.fixedAssets.put({ ...item, maintenanceDueDate: '2026-11-10', maintenanceIntervalDays: 30 });
      await completeFixedMaintenance(store, item.id, scheduled.version, '2026-11-16');
      expect((await store.fixedAssets.get(item.id))?.maintenanceDueDate).toBe('2026-12-16');
      expect((await store.fixedAssetEvents.list())[0]).toMatchObject({ type: 'repair', amountBase: '0', cashflowMode: 'record_only' });
      await expect(completeFixedMaintenance(store, item.id, scheduled.version, '2026-11-16')).rejects.toThrow('已变更');
      expect(await store.transactions.list()).toHaveLength(0);
    } finally { await store.close(); }
  });
  it('requires an exact purchase date before a year-only item can create a cash flow', async () => {
    const { store, item } = await setup();
    try {
      const old: FixedAsset = { ...item, purchaseDatePrecision: 'year' };
      await expect(saveFixedAssetAcquisition(store, { asset: old, purchaseAmount: '100', cashflow: { mode: 'create_transaction', createTransaction: { categoryId: 'shopping' } } })).rejects.toThrow('补齐准确日期');
      await saveFixedAssetAcquisition(store, { asset: old, purchaseAmount: '100', cashflow: { mode: 'record_only' } });
      expect((await store.fixedAssets.get(item.id))?.purchaseDatePrecision).toBe('year');
      expect(await store.transactions.list()).toHaveLength(0);
    } finally { await store.close(); }
  });
});
