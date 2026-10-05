import { describe, expect, it } from 'vitest';
import {
  fixedAssetCost,
  fixedConsumableRemaining,
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
  it('does not consume the life of a spare before installation', () => {
    const metric: FixedAssetUsageMetric = { ...base(), id: 'pages', fixedAssetId: 'printer', name: '页数',
      unit: 'count', entryMode: 'increment', startValue: '0', isPrimary: true, isActive: true };
    const logs: FixedAssetUsageLog[] = [{ ...base(), id: 'pages-1', fixedAssetId: 'printer', metricId: 'pages',
      date: '2026-03-01', value: '90', entryMode: 'increment' }];
    const spare = { ...consumable('printer', '20'), usageMetricId: 'pages', installedAtUsage: '0', targetLife: '100' };
    expect(fixedConsumableRemaining(spare, [metric], logs)).toBeUndefined();
    expect(fixedConsumableRemaining({ ...spare, installedDate: '2026-01-01' }, [metric], logs)).toBe('10');
  });

  it('keeps reference value separate from net investment', () => {
    const item = asset({ id: 'ip', purchaseDate: '2024-05-10', status: 'active' });
    const events = [event('ip', 'purchase', '2024-05-10', '999'), event('ip', 'residual_update', '2026-03-01', '520')];
    const cost = fixedAssetCost(item, events, { asOf: '2026-07-04', consumables: [consumable('ip', '45')] });
    expect(cost.basis).toBe('current');
    expect(round(cost.investedCost, 2)).toBe('1044.00');
    expect(round(cost.netCost, 2)).toBe('1044.00');
    const snapshot = fixedAssetCost(item, events, { asOf: dateAfter('2024-05-10', 784), consumables: [consumable('ip', '45')] });
    expect(snapshot.heldDays).toBe(785);
    expect(round(snapshot.perDay, 2)).toBe('1.33');
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
    expect(round(cost.netCost, 2)).toBe('500.00');
  });

  it('counts a part sale as recovery without ending the parent item', () => {
    const item = asset({ id: 'laptop', purchaseDate: '2024-01-01', status: 'active' });
    const cost = fixedAssetCost(item, [
      event('laptop', 'purchase', '2024-01-01', '5000'),
      event('laptop', 'upgrade', '2026-01-01', '2000'),
      event('laptop', 'part_sale', '2026-02-01', '400'),
    ], { asOf: '2026-03-01' });
    expect(cost.investedCost).toBe('7000');
    expect(cost.recoveredCost).toBe('400');
    expect(cost.netCost).toBe('6600');
    expect(cost.basis).toBe('current');
  });

  it('excludes future events, consumables, and usage from an as-of snapshot', () => {
    const item = asset({ id: 'snapshot', purchaseDate: '2026-01-01', status: 'sold' });
    const metric: FixedAssetUsageMetric = {
      ...base(), id: 'snapshot-km', fixedAssetId: item.id, name: '里程', unit: 'km', entryMode: 'increment',
      startValue: '0', isPrimary: true, isActive: true,
    };
    const cost = fixedAssetCost(item, [
      event(item.id, 'purchase', '2026-01-01', '500'),
      event(item.id, 'residual_update', '2026-12-01', '100'),
      event(item.id, 'sale', '2026-12-15', '120'),
    ], {
      asOf: '2026-06-01',
      consumables: [{ ...consumable(item.id, '50'), purchaseDate: '2026-07-01' }],
      usageMetrics: [metric],
      usageLogs: [
        { ...base(), id: 'past', fixedAssetId: item.id, metricId: metric.id, date: '2026-05-01', value: '10', entryMode: 'increment' },
        { ...base(), id: 'future', fixedAssetId: item.id, metricId: metric.id, date: '2026-07-01', value: '20', entryMode: 'increment' },
      ],
    });
    expect(cost.investedCost).toBe('500');
    expect(cost.basis).toBe('current');
    expect(cost.currentResidual).toBeUndefined();
    expect(cost.usageCosts.find((row) => row.metricId === metric.id)?.totalUsage).toBe('10');
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
    expect(round(cost.netCost, 2)).toBe('380.00');
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
