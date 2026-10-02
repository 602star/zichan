import { describe, expect, it } from 'vitest';
import { freezeConversionQuote } from '@zichan/core';
import { buildConversionOperationDraft } from '../src/conversion-operation-draft.js';
import { makeSnapshot } from './fixtures.js';
describe('conversion operation form mapping', () => {
  it('keeps retained quantities explicit and creates stable segment identities', () => {
    const original = makeSnapshot().chains[0]!;
    const prepared = { chain: { ...original.chain, time: '12:00', timezone: 'UTC', occurredAtUtc: undefined, type: 'dca' as const },
      steps: [original.steps[0]!, { ...original.steps[0]!, id: 'next', fromAssetId: original.steps[0]!.toAssetId, fromAmount: '0.5' }] };
    const operation = { ...original.chain, id: 'operation', chainIds: [] };
    const input = { prepared, operation, links: [{ retainedQuantity: '0.5', supplementalQuantity: '0' }] };
    const built = buildConversionOperationDraft(input);
    expect(built).toEqual(buildConversionOperationDraft(input));
    expect(built.conversions.map((row) => row.chain.type)).toEqual(['exchange', 'dca']);
    expect(built.conversions.map((row) => row.steps[0]!.order)).toEqual([1, 1]);
    expect(built.conversions.every((row) => row.steps[0]!.chainId === row.chain.id)).toBe(true);
    expect(built.links).toEqual(input.links);
  });
  it('preserves each segment time, intent and value when editing the group title', () => {
    const row = makeSnapshot().chains[0]!;
    const first = { chain: { ...row.chain, id: 'first', date: '2026-01-01', time: '12:00', timezone: 'UTC', timePrecision: 'minute' as const, occurredAtUtc: undefined, type: 'exchange' as const, bookValueInBase: '10' },
      steps: [{ ...row.steps[0]!, id: 'a', chainId: 'first' }] };
    const last = { chain: { ...first.chain, id: 'last', date: '2026-01-02', time: '13:00', type: 'buy' as const, bookValueInBase: '20' },
      steps: [{ ...row.steps[0]!, id: 'b', chainId: 'last' }] };
    const operation = { ...row.chain, id: 'group', chainIds: ['first', 'last'] };
    const links = [{ retainedQuantity: '0', supplementalQuantity: '0' }];
    const built = buildConversionOperationDraft({ prepared: { chain: { ...first.chain, title: 'Updated', type: last.chain.type, bookValueInBase: last.chain.bookValueInBase }, steps: [...first.steps, ...last.steps] },
      operation, existing: { operation, conversions: [first, last], links }, links });
    expect(built.conversions.map(({ chain }) => [chain.date, chain.time, chain.type, chain.bookValueInBase])).toEqual([
      ['2026-01-01', '12:00', 'exchange', '10'], ['2026-01-02', '13:00', 'buy', '20'],
    ]);
    expect(built.conversions.map(({ chain }) => chain.occurredAtUtc)).toEqual(['2026-01-01T12:00:00.000Z', '2026-01-02T13:00:00.000Z']);
  });

  it('keeps individually confirmed intermediate values when splitting into segments', () => {
    const row = makeSnapshot().chains[0]!;
    const step = { ...row.steps[0]!, id: 'independent-value' };
    const quote = freezeConversionQuote(step, '2026-01-01T12:00:00.000Z', row.chain.baseCurrencyAssetId,
      { valueInBase: '42', source: 'price_mark', priceMarkIds: ['historic'], quoteDate: '2026-01-01' });
    const built = buildConversionOperationDraft({ prepared: { chain: { ...row.chain, date: '2026-01-01', time: '12:00', timezone: 'UTC', timePrecision: 'minute', costQuotes: [quote] }, steps: [step] },
      operation: { ...row.chain, id: 'operation', chainIds: [] }, links: [] });
    expect(built.conversions[0]!.chain.costQuotes![0]).toMatchObject({ valueInBase: '42', source: 'price_mark', priceMarkIds: ['historic'] });
  });

});
