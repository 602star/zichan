import { describe, expect, it } from 'vitest';
import { parseOrder } from '../src/order-capture/parser.js';
import { changedCaptureFields, suggestedCaptureFields } from '../src/order-capture/attachment-review.js';
const line = (text: string, y: number) => ({ id: String(y), text, score: .98, poly: [[0, y], [700, y], [700, y + 30], [0, y + 30]] as [number, number][] });
const order = () => parseOrder([line('实付款：49.90 CNY', 100), line('付款时间：2026-11-25 18:42:00', 200), line('订单号：00001234567890', 300), line('运单号：SF1234567890', 400)]);
describe('per-attachment field review', () => {
  it('fills definite empty/default fields and keeps identifiers as strings', () => {
    expect(suggestedCaptureFields(order(), {}, new Set(), 'CNY')).toMatchObject({ amount: '49.9', date: '2026-11-25', time: '18:42:00', orderNumber: '00001234567890', trackingNumber: 'SF1234567890', assetId: 'CNY' });
  });
  it('protects hand-cleared and previously applied fields even when empty', () => {
    const result = suggestedCaptureFields(order(), { amount: '', date: '2026-11-26' }, new Set(['amount', 'date', 'orderNumber']));
    for (const key of ['amount', 'date', 'time', 'orderNumber']) expect(result).not.toHaveProperty(key);
  });
  it('does not preselect ambiguous results or rewrite matching values', () => {
    const parsed = order(); parsed.fields.amount.state = 'ambiguous';
    expect(suggestedCaptureFields(parsed, { orderNumber: '00001234567890' }, new Set())).not.toHaveProperty('amount');
    expect(suggestedCaptureFields(parsed, { orderNumber: '00001234567890' }, new Set())).not.toHaveProperty('orderNumber');
  });
  it('checks value and edit version before applying an asynchronous result', () => {
    expect(changedCaptureFields({ amount: '10' }, { amount: '20' }, { amount: '49.9', merchant: '店铺' })).toEqual(['amount']);
    expect(changedCaptureFields({ amount: '10' }, { amount: '10' }, { amount: '49.9' }, { amount: 1 }, { amount: 3 })).toEqual(['amount']);
    expect(changedCaptureFields({}, {}, { amount: '49.9' })).toEqual([]);
  });
});
