import { isValidDay } from './dates.js';
import type { FixedAsset } from './types.js';

export interface FixedStorageLocation { id: string; name: string; parentId?: string; archived?: boolean; }
export interface FixedInventoryFilters {
  query: string;
  categoryId: string;
  status: 'all' | 'active' | 'stored' | 'terminal';
  year: string;
  locationId: string;
  attentionOnly: boolean;
  sort: 'newest' | 'oldest' | 'net_desc' | 'name';
  display: 'list' | 'cards';
}
export interface FixedSavedView { id: string; name: string; filters: FixedInventoryFilters; }
export interface FixedWorkspacePreferences {
  version: 1;
  locations: FixedStorageLocation[];
  views: FixedSavedView[];
  categoryLocations: Record<string, string>;
}
export interface FixedLocationMove { at: string; from: string; to: string; }
export const defaultFixedFilters = (): FixedInventoryFilters => ({ query: '', categoryId: 'all', status: 'all', year: 'all', locationId: 'all', attentionOnly: false, sort: 'newest', display: 'cards' });
export const emptyFixedWorkspace = (): FixedWorkspacePreferences => ({ version: 1, locations: [], views: [], categoryLocations: {} });

export function fixedLocationPath(locations: readonly FixedStorageLocation[], id?: string): string {
  if (!id) return '未设置位置';
  const names: string[] = [];
  const visited = new Set<string>();
  let current = locations.find((location) => location.id === id);
  if (!current) return '位置资料缺失';
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = locations.find((location) => location.id === current?.parentId);
  }
  return names.join(' / ');
}

export function fixedLocationContains(locations: readonly FixedStorageLocation[], ancestor: string, id?: string): boolean {
  const visited = new Set<string>();
  while (id && !visited.has(id)) {
    if (ancestor === id) return true;
    visited.add(id);
    id = locations.find((location) => location.id === id)?.parentId;
  }
  return false;
}

export function parseFixedWorkspace(json?: string): FixedWorkspacePreferences {
  if (!json) return emptyFixedWorkspace();
  const value = JSON.parse(json) as FixedWorkspacePreferences;
  if (value.version !== 1 || !Array.isArray(value.locations) || !Array.isArray(value.views)
    || !value.categoryLocations || typeof value.categoryLocations !== 'object') throw new Error('物品目录格式无效');
  if (value.locations.length > 1000 || value.views.length > 100) throw new Error('物品位置或视图过多');
  const ids = new Set<string>();
  for (const location of value.locations) {
    if (!location || typeof location.id !== 'string' || !location.id || ids.has(location.id)
      || typeof location.name !== 'string' || !location.name.trim() || location.name.length > 80) throw new Error('位置名称或标识无效');
    ids.add(location.id);
  }
  for (const location of value.locations) {
    if (location.parentId && !ids.has(location.parentId)) throw new Error('上级位置不存在');
    if (!location.archived && value.locations.some((row) => row.id === location.parentId && row.archived)) throw new Error('不能在已归档位置下添加位置');
    const visited = new Set([location.id]);
    let parent = location.parentId;
    while (parent) {
      if (visited.has(parent)) throw new Error('位置不能循环嵌套');
      visited.add(parent);
      if (visited.size > 12) throw new Error('位置层级最多 12 层');
      parent = value.locations.find((row) => row.id === parent)?.parentId;
    }
    if (!location.archived && value.locations.some((row) => row.id !== location.id && !row.archived
      && row.parentId === location.parentId && row.name.trim() === location.name.trim())) throw new Error('同一位置下名称不能重复');
  }
  const viewIds = new Set<string>();
  for (const view of value.views) {
    const f = view?.filters;
    if (!view || !view.id || viewIds.has(view.id) || typeof view.name !== 'string' || !view.name.trim() || view.name.length > 60
      || !f || !['query', 'categoryId', 'year', 'locationId'].every((key) => typeof f[key as keyof FixedInventoryFilters] === 'string')
      || !['all', 'active', 'stored', 'terminal'].includes(f.status) || !['newest', 'oldest', 'net_desc', 'name'].includes(f.sort)
      || !['list', 'cards'].includes(f.display) || typeof f.attentionOnly !== 'boolean') throw new Error('保存的物品视图无效');
    viewIds.add(view.id);
  }
  return value;
}

export function fixedLocationMoves(json?: string): FixedLocationMove[] {
  if (!json) return [];
  const rows = JSON.parse(json) as FixedLocationMove[];
  if (!Array.isArray(rows) || rows.some((row) => !row || !Number.isFinite(Date.parse(row.at))
    || typeof row.from !== 'string' || typeof row.to !== 'string')) throw new Error('位置变更记录无效');
  return rows;
}

export function withFixedLocationMove(asset: FixedAsset, previous: FixedAsset | undefined, locations: readonly FixedStorageLocation[], at: string): FixedAsset {
  const history = fixedLocationMoves(previous?.locationMovesJson);
  if (previous && (previous.storageLocationId || '') !== (asset.storageLocationId || '')) history.push({
    at, from: fixedLocationPath(locations, previous.storageLocationId), to: fixedLocationPath(locations, asset.storageLocationId),
  });
  return { ...asset, locationMovesJson: history.length ? JSON.stringify(history) : undefined };
}

export interface FixedDateReminder { id: string; assetId: string; kind: 'warranty' | 'return' | 'price' | 'maintenance'; label: string; date: string; days: number; }
export function fixedDateReminders(assets: readonly FixedAsset[], today: string): FixedDateReminder[] {
  if (!isValidDay(today)) return [];
  const result: FixedDateReminder[] = [];
  for (const asset of assets) {
    if (asset.isDeleted || asset.archivedAt || !['active', 'stored'].includes(asset.status) || asset.purchaseDate > today) continue;
    for (const [kind, label, date] of [
      ['warranty', '保修到期', asset.warrantyEndDate], ['return', '退货截止', asset.returnDeadline],
      ['price', '价保截止', asset.priceProtectionDeadline], ['maintenance', '定期保养', asset.maintenanceDueDate],
    ] as const) {
      if (!date || !isValidDay(date)) continue;
      const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      if (days > (asset.reminderDaysBefore ?? 7) || (days < 0 && kind !== 'maintenance')) continue;
      result.push({ id: `${asset.id}:${kind}`, assetId: asset.id, kind, label, date, days });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}
