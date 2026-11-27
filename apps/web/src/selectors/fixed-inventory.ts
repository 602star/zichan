import { D, fixedLocationContains, type FixedInventoryFilters, type FixedWorkspacePreferences } from '@zichan/core';
import type { FixedCardVM } from './fixed.js';
import type { Table } from './reports.js';
import { money } from '../format.js';

export function filterFixedInventory(items: FixedCardVM[], filters: FixedInventoryFilters, preferences: FixedWorkspacePreferences, archivedOnly = false): FixedCardVM[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (Boolean(item.raw.archivedAt) !== archivedOnly) return false;
    if (!archivedOnly && item.isComponent && item.costOwnerId && items.some((owner) => owner.id === item.costOwnerId)) return false;
    if (filters.status === 'terminal' && !['sold', 'scrapped', 'retired', 'gifted'].includes(item.raw.status) || filters.status === 'active' && item.raw.status !== 'active'
      || filters.status === 'stored' && item.raw.status !== 'stored') return false;
    if (filters.categoryId !== 'all' && item.raw.categoryId !== filters.categoryId && item.categoryParentId !== filters.categoryId) return false;
    if (filters.year !== 'all' && item.raw.purchaseDate.slice(0, 4) !== filters.year) return false;
    if (filters.locationId === 'unset' && item.raw.storageLocationId) return false;
    if (!['all', 'unset'].includes(filters.locationId) && !fixedLocationContains(preferences.locations, filters.locationId, item.raw.storageLocationId)) return false;
    if (filters.attentionOnly && !item.reminders.length && !item.consumables.some((row) => row.needsAttention)) return false;
    return !query || [item.name, item.categoryParent, item.category, item.raw.brand, item.raw.model, item.raw.serialNumber, item.raw.barcode, item.locationPath, item.tag].join(' ').toLocaleLowerCase().includes(query);
  }).sort((a, b) => {
    if (filters.sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (filters.sort === 'net_desc') return a.currencyCode.localeCompare(b.currencyCode) || D(b.net).comparedTo(a.net) || a.id.localeCompare(b.id);
    return (filters.sort === 'oldest' ? a.raw.purchaseDate.localeCompare(b.raw.purchaseDate) : b.raw.purchaseDate.localeCompare(a.raw.purchaseDate)) || a.id.localeCompare(b.id);
  });
}

export function fixedInventoryTable(items: FixedCardVM[]): Table {
  return { headers: ['物品', '分类', '购置日期', '存放位置', '币种', '累计净投入', '参考现值', '持有天数', '单位净投入', '状态'],
    rows: items.map((item) => {
      const primary = item.metrics.find((metric) => metric.raw.isPrimary) ?? item.metrics[0];
      return [item.name, `${item.categoryParent} / ${item.category}`, item.raw.purchaseDatePrecision === 'year' ? `${item.raw.purchaseDate.slice(0, 4)} 年（日期未补）` : item.raw.purchaseDate,
        item.locationPath, item.currencyCode, item.net, item.referenceValue ?? '未记录', item.days === undefined ? '日期不足' : String(item.days),
        primary && D(primary.total).gt(0) ? `${money(primary.perUnit, item.currencySymbol)} / ${primary.unitLabel}` : item.perDay === undefined ? '日期不足' : `${money(item.perDay, item.currencySymbol)} / 天`, item.status].map((v) => ({ v }));
    }) };
}

/** Escape spreadsheet formulas as well as CSV punctuation; names and locations are user text. */
export function fixedInventoryCsv(items: FixedCardVM[]): string {
  const table = fixedInventoryTable(items);
  const escape = (value: string) => `"${(/^[\s]*[=+@-]/.test(value) ? "'" : '') + value.replace(/"/g, '""')}"`;
  return '\uFEFF' + [table.headers, ...table.rows.map((row) => row.map((cell) => cell.v))].map((row) => row.map(escape).join(',')).join('\r\n');
}
