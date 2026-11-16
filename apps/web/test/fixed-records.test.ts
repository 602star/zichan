import { describe, expect, it } from 'vitest';
import { addDays, type FixedAssetEvent } from '@zichan/core';
import { makeSnapshot } from './fixtures.js';
import { buildFixed } from '../src/selectors/fixed.js';
import { fixedRecordMonths, fixedRecordPage, fixedRecordProject } from '../src/selectors/fixed-records.js';

function fixture(count: number) {
  const snap = makeSnapshot(); const asset = snap.fixedAssets[0]!;
  snap.fixedEvents = Array.from({ length: count }, (_, index): FixedAssetEvent => ({
    id: `cost-${index}`, fixedAssetId: asset.id, createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    date: addDays('2024-01-01', index), type: 'operating_cost', amountBase: '0.60',
    operatingCostJson: JSON.stringify({ version: 1, mode: 'quantity', name: index % 2 ? '电费' : '充电费', unit: 'kWh', source: 'manual', sequence: index + 1, quantity: '1', unitPrice: '0.6', costKnown: true }),
  }));
  return { snap, asset, item: buildFixed(snap, '2026-11-16').find((item) => item.id === asset.id)! };
}
const all = { kind: 'operating' as const, month: 'all', project: 'all', page: 1 };

describe('物品记录固定分页与筛选', () => {
  it('keeps a thousand records to ten rendered rows while retaining the complete cost', () => {
    const { item } = fixture(1003);
    const first = fixedRecordPage(item, all);
    const second = fixedRecordPage(item, { ...all, page: 2 });
    const last = fixedRecordPage(item, { ...all, page: 999 });
    expect(first.rows).toHaveLength(10); expect(first.total).toBe(1003);
    expect(second.rows).toHaveLength(10); expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(20);
    expect(last).toMatchObject({ page: 101, pageCount: 101 }); expect(last.rows).toHaveLength(3);
    expect(item.operatingCost).toBe('601.8'); expect(item.net).toBe('601.8');
    expect(fixedRecordPage({ ...item, timeline: item.timeline.slice(0, 10) }, { ...all, page: 101 })).toMatchObject({ page: 1, pageCount: 1, total: 10 });
  });
  it('combines a month and project filter before pagination, with no excluded rows leaking in', () => {
    const { item } = fixture(70);
    const project = fixedRecordProject(item.timeline.find((row) => row.label.startsWith('电费'))!)!;
    const result = fixedRecordPage(item, { ...all, month: '2024-02', project });
    expect(result.total).toBe(15); expect(result.rows).toHaveLength(10);
    expect(result.rows.every((row) => row.date.startsWith('2024-02-') && row.label.startsWith('电费'))).toBe(true);
    expect(fixedRecordMonths(item)).toEqual(['2024-03', '2024-02', '2024-01']);
  });
  it('finds old unpriced quantities, excludes pauses, and does not invent months for year-only purchases', () => {
    const { item } = fixture(30);
    const pending = item.timeline.at(-1)!;
    const data = JSON.parse((pending.raw as FixedAssetEvent).operatingCostJson!);
    (pending.raw as FixedAssetEvent).operatingCostJson = JSON.stringify({ ...data, costKnown: false, unitPrice: undefined });
    const result = fixedRecordPage(item, { ...all, kind: 'unpriced' });
    expect(result.rows.map((row) => row.id)).toEqual([pending.id]);
    const purchase = { ...pending, id: 'purchase', date: '2023-01-01', raw: { ...pending.raw, type: 'purchase' as const } };
    const yearly = { ...item, raw: { ...item.raw, purchaseDatePrecision: 'year' as const }, timeline: [...item.timeline, purchase] };
    expect(fixedRecordMonths(yearly)).not.toContain('2023-01');
    expect(fixedRecordPage(yearly, { ...all, kind: 'all', month: '2023-01' }).total).toBe(0);
  });
});
