import {
  addDays, fixedLocationContains, isValidDay, newId, parseFixedWorkspace, todayIn, withFixedLocationMove,
  type FixedAsset, type FixedWorkspacePreferences,
} from '@zichan/core';
import type { SqlLedgerStore } from './repository.js';
import { archiveMasterData } from './services.js';

export async function updateFixedWorkspace(store: SqlLedgerStore, update: (preferences: FixedWorkspacePreferences) => FixedWorkspacePreferences): Promise<void> {
  await store.runInAuditBatch('整理物品位置与常用视图', async (transaction) => {
    const setting = (await transaction.settings.list())[0];
    if (!setting) throw new Error('账本设置不存在');
    const next = update(parseFixedWorkspace(setting.fixedAssetWorkspaceJson));
    const json = JSON.stringify(next);
    parseFixedWorkspace(json);
    await transaction.settings.put({ ...setting, fixedAssetWorkspaceJson: json });
  });
}

export async function organizeFixedAssets(store: SqlLedgerStore, assets: { id: string; version: number }[], patch: { locationId?: string; categoryId?: string; archive?: boolean }): Promise<void> {
  if (!assets.length) throw new Error('请先选择物品');
  await store.runInAuditBatch('批量整理物品', async (transaction) => {
    const preferences = parseFixedWorkspace((await transaction.settings.list())[0]?.fixedAssetWorkspaceJson);
    if (patch.locationId && !preferences.locations.some((location) => location.id === patch.locationId && !location.archived)) throw new Error('目标位置不可用');
    const current: FixedAsset[] = [];
    for (const expected of assets) {
      const asset = await transaction.fixedAssets.get(expected.id);
      if (!asset || asset.isDeleted || asset.version !== expected.version) throw new Error('所选物品已变更，请刷新后重试');
      current.push(asset);
    }
    for (const asset of current) {
      if (patch.archive) await archiveMasterData(transaction, 'fixed_asset', asset.id, asset.version);
      else await transaction.fixedAssets.put(withFixedLocationMove({ ...asset,
        storageLocationId: patch.locationId === undefined ? asset.storageLocationId : patch.locationId || undefined,
        categoryId: patch.categoryId || asset.categoryId,
      }, asset, preferences.locations, new Date().toISOString()));
    }
  });
}

export async function restoreFixedAssetArchive(store: SqlLedgerStore, id: string, expectedVersion: number, usageStatus?: 'active' | 'stored' | 'retired'): Promise<void> {
  await store.runInAuditBatch('恢复物品档案', async (transaction) => {
    const asset = await transaction.fixedAssets.get(id);
    if (!asset || asset.isDeleted || asset.version !== expectedVersion) throw new Error('物品已变更，请刷新后重试');
    if (!asset.archivedAt || asset.mergedIntoId) throw new Error('该物品未归档或已合并，不能直接恢复');
    if (usageStatus && !['active', 'stored', 'retired'].includes(usageStatus)) throw new Error('恢复后的使用状态无效');
    const events = await transaction.fixedAssetEvents.list({ where: { fixedAssetId: id } });
    if (usageStatus && events.some((row) => ['sale', 'scrap', 'retire', 'gift'].includes(row.type))) throw new Error('已有真实处置事件，请先更正处置记录');
    await transaction.fixedAssets.put({ ...asset, status: usageStatus ?? asset.status, archivedAt: undefined, archiveReason: undefined });
    if (usageStatus === 'active' || usageStatus === 'stored') {
      const today = todayIn((await transaction.settings.list())[0]?.timezone);
      await transaction.fixedAssetEvents.put({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
        fixedAssetId: id, type: usageStatus === 'stored' ? 'store' : 'activate', date: today < asset.purchaseDate ? asset.purchaseDate : today,
        amountBase: '0', note: '恢复旧档案时确认使用状态' });
    }
  });
}

export async function archiveFixedLocation(store: SqlLedgerStore, id: string, targetId?: string): Promise<void> {
  await store.runInAuditBatch('归档物品位置并迁移物品', async (transaction) => {
    const setting = (await transaction.settings.list())[0];
    if (!setting) throw new Error('账本设置不存在');
    const preferences = parseFixedWorkspace(setting.fixedAssetWorkspaceJson);
    if (!preferences.locations.some((row) => row.id === id && !row.archived)) throw new Error('位置不存在或已归档');
    if (targetId && (!preferences.locations.some((row) => row.id === targetId && !row.archived)
      || fixedLocationContains(preferences.locations, id, targetId))) throw new Error('不能迁移到被归档的位置或其子位置');
    const affected = (await transaction.fixedAssets.list()).filter((asset) => fixedLocationContains(preferences.locations, id, asset.storageLocationId));
    for (const asset of affected) await transaction.fixedAssets.put(withFixedLocationMove({ ...asset, storageLocationId: targetId }, asset, preferences.locations, new Date().toISOString()));
    preferences.locations = preferences.locations.map((location) => fixedLocationContains(preferences.locations, id, location.id) ? { ...location, archived: true } : location);
    const archivedIds = new Set(preferences.locations.filter((row) => row.archived).map((row) => row.id));
    preferences.categoryLocations = Object.fromEntries(Object.entries(preferences.categoryLocations).filter(([, locationId]) => !archivedIds.has(locationId)));
    await transaction.settings.put({ ...setting, fixedAssetWorkspaceJson: JSON.stringify(preferences) });
  });
}

export async function completeFixedMaintenance(store: SqlLedgerStore, assetId: string, expectedVersion: number, date: string): Promise<void> {
  if (!isValidDay(date)) throw new Error('保养日期无效');
  await store.runInAuditBatch('完成物品保养', async (transaction) => {
    const asset = await transaction.fixedAssets.get(assetId);
    if (!asset || asset.isDeleted || asset.version !== expectedVersion || !['active', 'stored'].includes(asset.status)) throw new Error('物品已变更，请刷新后重试');
    if (!asset.maintenanceDueDate) throw new Error('该物品没有待处理保养');
    const nextDate = asset.maintenanceIntervalDays ? addDays(date, asset.maintenanceIntervalDays) : undefined;
    await transaction.fixedAssets.put({ ...asset, maintenanceDueDate: nextDate });
    await transaction.fixedAssetEvents.put({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      fixedAssetId: assetId, type: 'maintenance', date, amountBase: '0', cashflowMode: 'record_only',
      note: `完成定期保养${nextDate ? `；下次 ${nextDate}` : ''}（本次未登记费用）` });
  });
}

export async function prepareFixedAssetMetadata(store: SqlLedgerStore, asset: FixedAsset, previous?: FixedAsset): Promise<FixedAsset> {
  const preferences = parseFixedWorkspace((await store.settings.list())[0]?.fixedAssetWorkspaceJson);
  if (asset.storageLocationId && asset.storageLocationId !== previous?.storageLocationId
    && !preferences.locations.some((location) => location.id === asset.storageLocationId && !location.archived)) throw new Error('请选择启用的存放位置');
  return withFixedLocationMove(asset, previous, preferences.locations, new Date().toISOString());
}
