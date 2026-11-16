import { describe, expect, it } from 'vitest';
import { defaultFixedFilters, emptyFixedWorkspace } from '@zichan/core';
import { makeSnapshot } from './fixtures.js';
import { buildFixed } from '../src/selectors/fixed.js';
import { filterFixedInventory, fixedInventoryCsv } from '../src/selectors/fixed-inventory.js';
import { fixedAssetForm } from '../src/forms.js';

describe('物品清单筛选与导出', () => {
  it('combines year, location descendants, category and status without conflating stored items with active items', () => {
    const snap = makeSnapshot();
    const preferences = { ...emptyFixedWorkspace(), locations: [{ id: 'home', name: '家' }, { id: 'room', name: '卧室', parentId: 'home' }] };
    snap.setting!.fixedAssetWorkspaceJson = JSON.stringify(preferences);
    const item = snap.fixedAssets[0]!;
    item.storageLocationId = 'room'; item.status = 'stored'; item.purchaseDate = '2024-06-15';
    const rows = buildFixed(snap, '2026-11-16');
    const filters = { ...defaultFixedFilters(), year: '2024', locationId: 'home', categoryId: item.categoryId, status: 'stored' as const };
    expect(filterFixedInventory(rows, filters, preferences).map((row) => row.id)).toContain(item.id);
    expect(filterFixedInventory(rows, { ...filters, status: 'active' }, preferences).map((row) => row.id)).not.toContain(item.id);
    expect(filterFixedInventory(rows, { ...filters, year: '2025' }, preferences).map((row) => row.id)).not.toContain(item.id);
    const orphan = { ...rows[0]!, id: 'part-with-archived-host', isComponent: true, costOwnerId: 'archived-host' };
    expect(filterFixedInventory([orphan], defaultFixedFilters(), preferences)).toHaveLength(1);
  });
  it('marks incomplete dates and protects spreadsheet cells from formulas', () => {
    const snap = makeSnapshot(); const item = snap.fixedAssets[0]!;
    item.name = '=HYPERLINK("evil")'; item.purchaseDatePrecision = 'year'; item.purchaseDate = '2024-01-01';
    const rows = buildFixed(snap, '2026-11-16');
    expect(rows.find((row) => row.id === item.id)?.perDay).toBeUndefined();
    const csv = fixedInventoryCsv(rows);
    expect(csv).toContain("'=HYPERLINK"); expect(csv).toContain('2024 年（日期未补）'); expect(csv).toContain('日期不足');
  });
  it('accepts year-only registration but rejects funding until the date is known', () => {
    const snap = makeSnapshot(); const spec = fixedAssetForm(snap);
    const values = { purchaseDatePrecision: 'year', purchaseYear: '2024', purchaseAmount: '100', cashflowMode: 'record_only' };
    expect(spec.fromValues(values).purchaseDate).toBe('2024-01-01');
    expect(spec.validate?.({ ...values, cashflowMode: 'create_transaction' })).toMatchObject({ purchaseDatePrecision: expect.stringContaining('不能关联资金') });
  });
});
