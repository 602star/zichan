import { describe, expect, it } from 'vitest';
import { fixedAssetCost, fixedMeterStates, parseFixedOperatingCost, prepareFixedOperatingEvent, type FixedAsset, type FixedAssetEvent, type FixedOperatingCost } from '../src/index.js';

const asset: FixedAsset = { id: 'item', createdAt: '', updatedAt: '', version: 1, isDeleted: false, name: '净水器', categoryId: 'water', status: 'active', purchaseDate: '2026-01-01', baseCurrencyAssetId: 'cny' };
function record(id: string, date: string, data: Partial<FixedOperatingCost>, events: FixedAssetEvent[] = []): FixedAssetEvent {
  return prepareFixedOperatingEvent({ id, createdAt: '', updatedAt: '', version: 1, isDeleted: false, fixedAssetId: asset.id, date,
    type: 'operating_cost', amountBase: '0', operatingCostJson: JSON.stringify({ version: 1, mode: 'quantity', name: '电费', unit: 'kWh', source: 'meter', ...data }) }, events);
}
describe('物品使用费用与计量空档', () => {
  it('charges only measured segments, freezes interval prices, and resumes from a fresh baseline', () => {
    const events: FixedAssetEvent[] = [];
    const add = (id: string, date: string, data: Partial<FixedOperatingCost>) => { const value = record(id, date, { meterId: 'plug', ...data }, events); events.push(value); return value; };
    expect(add('start', '2026-01-01', { mode: 'start', reading: '100' }).amountBase).toBe('0.00');
    expect(add('read', '2026-01-02', { mode: 'reading', reading: '110.5', unitPrice: '0.6' }).amountBase).toBe('6.30');
    expect(add('pause', '2026-01-03', { mode: 'pause', reading: '112', unitPrice: '0.8' }).amountBase).toBe('1.20');
    expect(() => add('bad', '2026-01-04', { mode: 'reading', reading: '120', unitPrice: '0.8' })).toThrow('已暂停');
    add('resume', '2026-01-10', { mode: 'resume', reading: '150' });
    expect(add('newread', '2026-01-11', { mode: 'reading', reading: '152', unitPrice: '1' }).amountBase).toBe('2.00');
    expect(fixedMeterStates(events)[0]).toMatchObject({ quantity: '14', active: true, reading: '152' });
    expect(fixedAssetCost(asset, events, '2026-01-11')).toMatchObject({ otherCost: '9.5', netCost: '9.5' });
    expect(parseFixedOperatingCost(events[1]!.operatingCostJson)?.unitPrice).toBe('0.6');
  });
  it('does not call a pause without closing reading zero consumption, and handles meter replacement', () => {
    const start = record('s', '2026-01-01', { mode: 'start', meterId: 'plug', reading: '90' });
    const pause = record('p', '2026-01-02', { mode: 'pause', meterId: 'plug' }, [start]);
    expect(parseFixedOperatingCost(pause.operatingCostJson)).toMatchObject({ costKnown: false });
    expect(parseFixedOperatingCost(pause.operatingCostJson)?.quantity).toBeUndefined();
    const reset = record('r', '2026-01-03', { mode: 'reset', meterId: 'plug', reading: '0' }, [start, pause]);
    const next = record('n', '2026-01-03', { mode: 'reading', meterId: 'plug', reading: '0.25', unitPrice: '0.5' }, [start, pause, reset]);
    expect(next.amountBase).toBe('0.13');
    expect(() => record('negative', '2026-01-04', { mode: 'reading', meterId: 'plug', reading: '0.1' }, [start, pause, reset, next])).toThrow('归零');
    expect(() => record('backdate', '2026-01-01', { mode: 'reading', meterId: 'plug', reading: '1' }, [start, pause, reset, next])).toThrow('不能早于');
  });
  it('uses an actual charging bill in place of calculated costs and preserves quantity-only records', () => {
    const charging = record('ev', '2026-01-02', { quantity: '23.5', unitPrice: '0.72', serviceFee: '3' });
    expect(charging.amountBase).toBe('19.92');
    const receipt = record('bill', '2026-01-03', { quantity: '23.5', unitPrice: '0.72', serviceFee: '3', billedAmount: '20.50' });
    expect(receipt.amountBase).toBe('20.50');
    const pending = record('pending', '2026-01-04', { quantity: '10' });
    expect(parseFixedOperatingCost(pending.operatingCostJson)).toMatchObject({ quantity: '10', costKnown: false });
    expect(fixedAssetCost(asset, [charging, receipt, pending], '2026-01-04').netCost).toBe('40.42');
  });
  it('keeps estimates separate and refuses overlapping measured coverage', () => {
    const estimate = record('est', '2026-02-01', { mode: 'estimate', quantity: '5', unitPrice: '0.6', fromDate: '2026-01-10', toDate: '2026-01-20' });
    expect(fixedAssetCost(asset, [estimate], '2026-02-01')).toMatchObject({ netCost: '0', estimatedOperatingCost: '3' });
    const start = record('s', '2026-01-01', { mode: 'start', meterId: 'plug', reading: '1' }, [estimate]);
    expect(() => record('r', '2026-01-21', { mode: 'reading', meterId: 'plug', reading: '10', unitPrice: '0.6' }, [start, estimate])).toThrow('估算期间重叠');
  });
  it('allows later pricing of an older reading without changing any downstream quantities', () => {
    const start = record('s', '2026-01-01', { mode: 'start', meterId: 'plug', reading: '100' });
    const read = record('r', '2026-01-02', { mode: 'reading', meterId: 'plug', reading: '105' }, [start]);
    const next = record('n', '2026-01-03', { mode: 'reading', meterId: 'plug', reading: '109', unitPrice: '1' }, [start, read]);
    const priced = prepareFixedOperatingEvent({ ...read, operatingCostJson: JSON.stringify({ ...parseFixedOperatingCost(read.operatingCostJson), unitPrice: '0.6' }) }, [start, read, next]);
    expect(priced.amountBase).toBe('3.00');
    expect(() => prepareFixedOperatingEvent({ ...read, operatingCostJson: JSON.stringify({ ...parseFixedOperatingCost(read.operatingCostJson), reading: '106' }) }, [start, read, next])).toThrow('历史记录只能');
  });
  it('rejects a stale billing preview instead of silently changing the quantity and payment allocation', () => {
    const start = record('s', '2026-01-01', { mode: 'start', meterId: 'plug', reading: '100' });
    const preview = record('preview', '2026-01-03', { mode: 'reading', meterId: 'plug', reading: '120', unitPrice: '0.6' }, [start]);
    const concurrent = record('other', '2026-01-02', { mode: 'reading', meterId: 'plug', reading: '110', unitPrice: '0.6' }, [start]);
    expect(() => prepareFixedOperatingEvent(preview, [start, concurrent])).toThrow('其他窗口变更');
  });
});
