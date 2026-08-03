import { describe, expect, it } from 'vitest';
import {
  fixedAssetCost,
  fixedGoalProgress,
  fixedUsageTotal,
  round,
  type FixedAsset,
  type FixedAssetConsumable,
  type FixedAssetEvent,
  type FixedAssetGoal,
  type FixedAssetUsageLog,
  type FixedAssetUsageMetric,
} from '../src/index.js';

const base = () => ({ createdAt: '', updatedAt: '', version: 1, isDeleted: false });
function asset(p: Partial<FixedAsset> & Pick<FixedAsset, 'id' | 'purchaseDate' | 'status'>): FixedAsset {
  return { ...base(), name: 'x', categoryId: 'phone', baseCurrencyAssetId: 'GBP', ...p } as FixedAsset;
}
function event(fixedAssetId: string, type: FixedAssetEvent['type'], date: string, amountBase: string): FixedAssetEvent {
  return { ...base(), id: `${type}-${date}`, fixedAssetId, type, date, amountBase };
}
function consumable(fixedAssetId: string, amountBase: string): FixedAssetConsumable {
  return { ...base(), id: `con-${amountBase}`, fixedAssetId, name: 'filter', amountBase, cashflowMode: 'record_only', purchaseDate: '2024-05-12', status: 'active' };
}

describe('physical item cost', () => {
  it('keeps invested cost and net usage cost separate without automatic depreciation', () => {
    const item = asset({ id: 'ip', purchaseDate: '2024-05-10', status: 'active' });
    const events = [event('ip', 'purchase', '2024-05-10', '999'), event('ip', 'residual_update', '2026-03-01', '520')];
    const cost = fixedAssetCost(item, events, { asOf: '2026-07-04', consumables: [consumable('ip', '45')] });
    expect(cost.basis).toBe('current');
    expect(round(cost.investedCost, 2)).toBe('1044.00');
    expect(round(cost.netCost, 2)).toBe('524.00');
    const snapshot = fixedAssetCost(item, events, { asOf: dateAfter('2024-05-10', 784), consumables: [consumable('ip', '45')] });
    expect(snapshot.heldDays).toBe(785);
    expect(round(snapshot.perDay, 2)).toBe('0.67');
  });

  it('uses sale proceeds as final residual and stops the holding period', () => {
    const item = asset({ id: 'ps5', purchaseDate: '2022-06-15', status: 'sold' });
    const events = [event('ps5', 'purchase', '2022-06-15', '449'), event('ps5', 'sale', '2024-06-05', '260')];
    const cost = fixedAssetCost(item, events, { consumables: [consumable('ps5', '120')] });
    expect(cost.basis).toBe('final');
    expect(round(cost.netCost, 2)).toBe('309.00');
    expect(cost.heldDays).toBe(722);
  });

  it('uses the latest same-day residual/terminal event by createdAt (stable ordering)', () => {
    const item = asset({ id: 'cam', purchaseDate: '2026-01-01', status: 'active' });
    const events: FixedAssetEvent[] = [
      { ...base(), id: 'purchase', fixedAssetId: item.id, type: 'purchase', date: '2026-01-01', amountBase: '500' },
      // Same day, two residual updates: the later-created one must win.
      { ...base(), id: 'r1', fixedAssetId: item.id, type: 'residual_update', date: '2026-06-01', amountBase: '300', createdAt: '2026-06-01T08:00:00.000Z' },
      { ...base(), id: 'r2', fixedAssetId: item.id, type: 'residual_update', date: '2026-06-01', amountBase: '250', createdAt: '2026-06-01T12:00:00.000Z' },
    ];
    const cost = fixedAssetCost(item, events, { asOf: '2026-07-01' });
    expect(cost.currentResidual).toBe('250');
    expect(round(cost.netCost, 2)).toBe('250.00');
  });

  it('terminal event of the same day picks the later-created one', () => {
    const item = asset({ id: 'cam2', purchaseDate: '2026-01-01', status: 'scrapped' });
    const events: FixedAssetEvent[] = [
      { ...base(), id: 'purchase', fixedAssetId: item.id, type: 'purchase', date: '2026-01-01', amountBase: '500' },
      { ...base(), id: 'sale-1', fixedAssetId: item.id, type: 'sale', date: '2026-06-01', amountBase: '120', createdAt: '2026-06-01T08:00:00.000Z' },
      { ...base(), id: 'scrap-1', fixedAssetId: item.id, type: 'scrap', date: '2026-06-01', amountBase: '0', createdAt: '2026-06-01T09:00:00.000Z' },
    ];
    const cost = fixedAssetCost(item, events, { asOf: '2026-07-01' });
    expect(cost.basis).toBe('final');
    expect(cost.salePrice).toBeUndefined(); // scrap (not sale) is the latest terminal
    expect(round(cost.netCost, 2)).toBe('500.00');
  });

  it('supports meter readings, manual increments, and frozen unit-cost goals', () => {
    const item = asset({ id: 'car', purchaseDate: '2026-01-01', status: 'active' });
    const metric: FixedAssetUsageMetric = { ...base(), id: 'km', fixedAssetId: item.id, name: '里程', unit: 'km', entryMode: 'meter', startValue: '1000', isPrimary: true, isActive: true };
    const logs: FixedAssetUsageLog[] = [
      { ...base(), id: 'l1', fixedAssetId: item.id, metricId: metric.id, date: '2026-02-01', value: '1500', entryMode: 'meter' },
      { ...base(), id: 'l2', fixedAssetId: item.id, metricId: metric.id, date: '2026-03-01', value: '250', entryMode: 'increment' },
    ];
    expect(fixedUsageTotal(metric, logs)).toBe('750');
    const goal: FixedAssetGoal = { ...base(), id: 'g', fixedAssetId: item.id, name: '每公里 2 元', metricId: metric.id, unit: 'km', mode: 'unit_cost', costBasisAmount: '500', targetUnitCost: '2', targetUsage: '250', startDate: '2026-01-01', status: 'active' };
    const progress = fixedGoalProgress(goal, item, [], [metric], logs, '2026-03-01');
    expect(progress.currentUsage).toBe('750');
    expect(progress.achieved).toBe(true);
    expect(round(progress.currentUnitCost, 2)).toBe('0.67');
  });
});

function dateAfter(day: string, plusDays: number): string {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + plusDays);
  return date.toISOString().slice(0, 10);
}
