import { describe, expect, it } from 'vitest';
import { transactionCostFingerprint } from '@zichan/core';
import { transactionForm } from '../src/forms.js';
import { makeSnapshot } from './fixtures.js';

describe('daily transaction cost value editing', () => {
  it('preserves frozen evidence for metadata, and requires explicit confirmation after money changes', () => {
    const snap = makeSnapshot();
    snap.costState = { openingId: 'opening', occurredAtUtc: '2026-01-01T00:00:00.000Z', timezone: 'UTC', baseCurrencyAssetId: snap.ids.gbp!,
      invalidAssetIds: [], issues: [], lots: [], consumptions: [], gaps: [], events: [], positions: [] };
    const spec = transactionForm(snap);
    const values = { date: '2026-02-01', time: '12:00', timezone: 'UTC', type: 'income', amount: '1', assetId: snap.ids.btc!, category: 'salary',
      costValueInBase: '50', costValueConfirmed: 'true' };
    const saved = spec.fromValues(values);
    expect(saved.costQuote).toMatchObject({ source: 'manual', valueInBase: '50', dependencyFingerprint: transactionCostFingerprint(saved, snap.ids.gbp!) });
    const text = { ...spec.toValues(saved), note: 'Only a note' };
    expect(spec.fromValues(text, saved).costQuote).toEqual(saved.costQuote);
    const changed = spec.onFieldChange!({ ...text, amount: '2' }, 'amount', new Set());
    expect(spec.validate!(changed, saved)).toHaveProperty('costValueConfirmed');
    expect(() => spec.fromValues(changed, saved)).toThrow('重新确认');
    const confirmed = spec.fromValues({ ...changed, costValueConfirmed: 'true' }, saved);
    expect(confirmed.costQuote!.dependencyFingerprint).not.toBe(saved.costQuote!.dependencyFingerprint);
    expect(spec.fromValues({ ...changed, costValueInBase: '' }, saved).costQuote).toMatchObject({ source: 'unknown', valueInBase: null });
  });
});
