import { D, parseFixedOperatingCost } from '@zichan/core';
import type { FixedCardVM, FixedTimelineVM } from './fixed.js';

export const FIXED_RECORD_PAGE_SIZE = 10;
export type FixedRecordKind = 'all' | 'operating' | 'unpriced' | 'usage' | 'lifecycle' | 'consumable';
export interface FixedRecordFilters { kind: FixedRecordKind; month: string; project: string; page: number }
export function operatingRecord(entry: FixedTimelineVM) {
  return entry.kind === 'event' && 'type' in entry.raw && entry.raw.type === 'operating_cost'
    ? parseFixedOperatingCost(entry.raw.operatingCostJson) : undefined;
}
export function fixedRecordProject(entry: FixedTimelineVM): string | undefined {
  const data = operatingRecord(entry);
  return data ? JSON.stringify([data.name, data.unit]) : undefined;
}
function exactDay(item: FixedCardVM, entry: FixedTimelineVM): boolean {
  return !(item.raw.purchaseDatePrecision === 'year' && entry.kind === 'event' && 'type' in entry.raw && entry.raw.type === 'purchase');
}
export function fixedRecordMonths(item: FixedCardVM): string[] {
  return [...new Set(item.timeline.filter((entry) => exactDay(item, entry)).map((entry) => entry.date.slice(0, 7)))].sort().reverse();
}
export function fixedRecordPage(item: FixedCardVM, filters: FixedRecordFilters) {
  const filtered = item.timeline.filter((entry) => {
    const data = operatingRecord(entry);
    if (filters.kind === 'operating' && !data) return false;
    if (filters.kind === 'unpriced' && !(data?.quantity !== undefined && D(data.quantity).gt(0) && !data.costKnown && data.mode !== 'estimate')) return false;
    if (filters.kind === 'usage' && entry.kind !== 'usage') return false;
    if (filters.kind === 'lifecycle' && (entry.kind !== 'event' || !!data)) return false;
    if (filters.kind === 'consumable' && entry.kind !== 'consumable') return false;
    if (filters.month !== 'all' && (!exactDay(item, entry) || !entry.date.startsWith(`${filters.month}-`))) return false;
    return !['operating', 'unpriced'].includes(filters.kind) || filters.project === 'all' || fixedRecordProject(entry) === filters.project;
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / FIXED_RECORD_PAGE_SIZE));
  const page = Math.max(1, Math.min(Math.trunc(filters.page) || 1, pageCount));
  const start = (page - 1) * FIXED_RECORD_PAGE_SIZE;
  return { rows: filtered.slice(start, start + FIXED_RECORD_PAGE_SIZE), total: filtered.length, page, pageCount, start };
}
