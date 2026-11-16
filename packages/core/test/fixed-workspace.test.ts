import { describe, expect, it } from 'vitest';
import { emptyFixedWorkspace, fixedAssetCost, fixedDateReminders, fixedLocationContains, fixedLocationPath, parseFixedWorkspace, withFixedLocationMove, type FixedAsset } from '../src/index.js';

const asset = (patch: Partial<FixedAsset> = {}): FixedAsset => ({ id: 'item', createdAt: '', updatedAt: '', version: 1, isDeleted: false, name: '咖啡机', categoryId: 'appliance', status: 'active', purchaseDate: '2024-01-01', baseCurrencyAssetId: 'CNY', ...patch });
const locations = [{ id: 'home', name: '家' }, { id: 'room', name: '卧室', parentId: 'home' }, { id: 'cabinet', name: '衣柜', parentId: 'room' }];

describe('物品位置、日期精度与提醒', () => {
  it('uses location identities for paths, descendants and nonfinancial move history', () => {
    expect(fixedLocationPath(locations, 'cabinet')).toBe('家 / 卧室 / 衣柜');
    expect(fixedLocationContains(locations, 'home', 'cabinet')).toBe(true);
    const moved = withFixedLocationMove(asset({ storageLocationId: 'room' }), asset(), locations, '2026-11-16T08:00:00Z');
    expect(JSON.parse(moved.locationMovesJson!)).toEqual([{ at: '2026-11-16T08:00:00Z', from: '未设置位置', to: '家 / 卧室' }]);
    expect(withFixedLocationMove(moved, moved, locations, '2026-11-17T08:00:00Z').locationMovesJson).toBe(moved.locationMovesJson);
  });
  it('rejects cycles and duplicate sibling names while allowing rooms in different homes', () => {
    const preferences = { ...emptyFixedWorkspace(), locations };
    expect(parseFixedWorkspace(JSON.stringify(preferences))).toEqual(preferences);
    expect(() => parseFixedWorkspace(JSON.stringify({ ...preferences, locations: locations.map((row) => row.id === 'home' ? { ...row, parentId: 'cabinet' } : row) }))).toThrow('循环');
    expect(() => parseFixedWorkspace(JSON.stringify({ ...preferences, locations: [...locations, { id: 'another', name: '卧室', parentId: 'home' }] }))).toThrow('重复');
  });
  it('never manufactures holding-day costs from a year-only purchase', () => {
    const item = asset({ purchaseDatePrecision: 'year' });
    const events = [{ id: 'purchase', createdAt: '', updatedAt: '', version: 1, isDeleted: false, fixedAssetId: item.id, type: 'purchase' as const, date: item.purchaseDate, amountBase: '2400' }];
    const cost = fixedAssetCost(item, events, { asOf: '2026-11-16' });
    expect(cost.netCost).toBe('2400'); expect(cost.heldDays).toBeUndefined(); expect(cost.perDay).toBeUndefined(); expect(cost.usageCosts).toEqual([]);
    const knownActivation = fixedAssetCost({ ...item, activatedDate: '2026-11-15' }, events, { asOf: '2026-11-16' });
    expect(knownActivation.heldDays).toBe(2); expect(knownActivation.perDay).toBe('1200');
  });
  it('reminds only within date windows, keeps overdue maintenance and excludes disposed items', () => {
    const reminders = fixedDateReminders([
      asset({ warrantyEndDate: '2026-11-18', returnDeadline: '2026-11-15', priceProtectionDeadline: '2026-12-30', maintenanceDueDate: '2026-11-10' }),
      asset({ id: 'sold', status: 'sold', warrantyEndDate: '2026-11-18' }),
    ], '2026-11-16');
    expect(reminders.map((row) => [row.kind, row.days])).toEqual([['maintenance', -6], ['warranty', 2]]);
  });
});
