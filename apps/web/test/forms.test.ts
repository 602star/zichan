import { describe, expect, it } from 'vitest';
import type { PriceMark } from '@zichan/core';
import { priceMarkForm } from '../src/forms.js';
import { makeSnapshot } from './fixtures.js';

describe('price mark form', () => {
  it('only creates manual prices and exposes no automatic/API source', () => {
    const snap = makeSnapshot();
    const spec = priceMarkForm(snap);

    expect(spec.fields.some((field) => field.key === 'source')).toBe(false);

    const created = spec.fromValues({
      assetId: snap.ids.btc,
      quoteAssetId: snap.ids.gbp,
      price: '71000',
      date: '2026-03-04',
      source: 'api',
      note: '',
    });
    expect(created.source).toBe('manual');
  });

  it('normalizes a legacy API price to manual when it is edited', () => {
    const snap = makeSnapshot();
    const spec = priceMarkForm(snap);
    const legacy = { ...snap.priceMarks[0]!, source: 'api' } as PriceMark;

    const edited = spec.fromValues(spec.toValues(legacy), legacy);

    expect(edited.source).toBe('manual');
    expect(edited.id).toBe(legacy.id);
  });
});
