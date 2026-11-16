import { describe, expect, it } from 'vitest';
import { D, parseFixedOperatingCost } from '@zichan/core';
import { makeSnapshot } from './fixtures.js';
import { fixedOperatingCostForm } from '../src/fixed-operating-form.js';
import { buildFixed } from '../src/selectors/fixed.js';

describe('使用费用录入与物品成本展示', () => {
  it('previews a charging bill total without adding the service fee twice', () => {
    const snap = makeSnapshot(); const item = snap.fixedAssets[0]!;
    const spec = fixedOperatingCostForm(snap, item.id);
    const values = { mode: 'quantity', name: '公共充电', unit: 'kWh', source: 'receipt', date: '2026-08-01', quantity: '30', unitPrice: '0.6', serviceFee: '3', billedAmount: '22.55', cashflowMode: 'record_only' };
    const event = spec.fromValues(values);
    expect(event.amountBase).toBe('22.55'); expect(spec.summary?.(values)).toContain('22.55');
    const before = buildFixed(snap, '2026-08-01').find((row) => row.id === item.id)!;
    snap.fixedEvents.push(event);
    const after = buildFixed(snap, '2026-08-01').find((row) => row.id === item.id)!;
    expect(D(after.net).minus(before.net).toString()).toBe('22.55');
    expect(after.timeline.find((row) => row.id === event.id)?.detail).toContain('按实际总费用');
  });
  it('shows quantity-only entries as unpriced and keeps estimates out of actual net cost', () => {
    const snap = makeSnapshot(); const item = snap.fixedAssets[0]!; const spec = fixedOperatingCostForm(snap, item.id);
    const common = { name: '电费', unit: 'kWh', source: 'manual', date: '2026-08-01', cashflowMode: 'record_only' };
    const pending = spec.fromValues({ ...common, mode: 'quantity', quantity: '5' });
    const estimate = spec.fromValues({ ...common, mode: 'estimate', quantity: '10', unitPrice: '0.6', fromDate: '2026-07-01', toDate: '2026-07-10' });
    const before = buildFixed(snap, '2026-08-01').find((row) => row.id === item.id)!;
    snap.fixedEvents.push(pending, estimate);
    const after = buildFixed(snap, '2026-08-01').find((row) => row.id === item.id)!;
    expect(after.net).toBe(before.net); expect(after.estimatedOperatingCost).toBe('6');
    expect(after.timeline.find((row) => row.id === pending.id)).toMatchObject({ amount: undefined, detail: expect.stringContaining('费用待补') });
    expect(after.timeline.find((row) => row.id === estimate.id)).toMatchObject({ moneyKind: 'reference' });
    expect(parseFixedOperatingCost(pending.operatingCostJson)?.costKnown).toBe(false);
  });
});
