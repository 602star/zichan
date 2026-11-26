import { describe, expect, it } from 'vitest';
import { parseOrder } from '../src/order-capture/parser.js';
import { reviewedOrderFields } from '../src/order-capture/review.js';
import type { OcrLine } from '../src/order-capture/types.js';

const line = (text: string, y: number, x = 20, width = 700): OcrLine => ({ id: `${y}:${x}:${text}`, text, score: 0.95, poly: [[x, y], [x + width, y], [x + width, y + 30], [x, y + 30]] });
const receipt = (amount = '49.90', extra: OcrLine[] = []) => [line(`实付款：${amount} CNY`, 100), line('付款时间：2026-11-24 12:34:56', 200), ...extra];

describe('generic order parsing with specialized evidence', () => {
  it('extracts explicit fields on an unknown platform without any registered rules', () => {
    const parsed = parseOrder(receipt('49.90', [line('订单号：00001234567890', 300), line('运单号：SF0123456789', 400)]), []);
    expect(parsed.platform).toBe('unknown'); expect(parsed.ruleIds).toEqual([]);
    expect(parsed.fields.amount).toMatchObject({ value: '49.9', state: 'suggested' });
    expect(parsed.fields.currency.value).toBe('CNY');
    expect(parsed.fields.paymentDate.value).toBe('2026-11-24');
    expect(parsed.fields.paymentTime.value).toBe('12:34:56');
    expect(parsed.fields.orderNumber.value).toBe('00001234567890');
    expect(parsed.fields.trackingNumber.value).toBe('SF0123456789');
  });
  it('associates separate label/value boxes and keeps evidence on both lines', () => {
    const parsed = parseOrder([line('实付款', 100, 20, 110), line('99.50', 100, 300, 120)]);
    expect(parsed.fields.amount.value).toBe('99.5');
    expect(parsed.fields.amount.candidates[0]?.lineIds).toHaveLength(2);
  });
  it('does not guess the largest amount, a product price, order ID, or creation date', () => {
    const parsed = parseOrder([line('商品金额：9999.00', 100), line('优惠：10.00', 200), line('合计：9989.00', 300), line('下单时间：2026-11-23 12:30', 400)]);
    expect(parsed.fields.amount.state).toBe('missing');
    expect(parsed.fields.paymentDate.state).toBe('missing');
    expect(parseOrder([line('实付款', 100), line('订单号：123456789012345', 145)]).fields.amount.state).toBe('missing');
  });
  it('keeps conflicting payments and orders ambiguous instead of silently selecting one', () => {
    const parsed = parseOrder([...receipt(), line('实付款：59.90', 450), line('订单号：123456789', 500), line('订单号：987654321', 600)]);
    expect(parsed.fields.amount.state).toBe('ambiguous'); expect(parsed.fields.amount.value).toBeUndefined();
    expect(parsed.fields.orderNumber.state).toBe('ambiguous');
    expect(parsed.fields.amount.candidates.map((row) => row.value)).toEqual(['49.9', '59.9']);
  });
  it('specialized aliases add evidence to the same candidate set while generic parsing remains available', () => {
    const rows = [line('京东订单详情', 20), line('实际支付：39.00', 100), line('付款时间：2026-11-24 12:00', 200)];
    expect(parseOrder(rows, []).fields.amount.state).toBe('missing');
    const specialized = parseOrder(rows);
    expect(specialized.fields.amount.value).toBe('39');
    expect(specialized.fields.amount.candidates[0]?.ruleId).toBe('jd.order.v1');
    expect(specialized.fields.paymentDate.value).toBe('2026-11-24');
    expect(parseOrder(receipt('49.90', [line('京东订单详情', 20)])).fields.amount.value).toBe('49.9');
  });
  it.each(['待付款', '交易关闭', '退款成功', '部分退款', '退款中'])('blocks direct application for %s', (status) => {
    const parsed = parseOrder(receipt('49.90', [line(status, 300)]));
    expect(() => reviewedOrderFields(parsed, { amount: '49.9', confirmed: true })).toThrow();
  });
  it('keeps OCR confidence separate from field correctness and rejects invalid dates', () => {
    expect(parseOrder([line('付款日期：2026-02-30', 100)]).fields.paymentDate.state).toBe('missing');
    expect(parseOrder([line('付款时间：2026年11月24日12:34', 100)]).fields.paymentTime.value).toBe('12:34');
    expect(parseOrder([line('实付款：1,234.50', 100)]).fields.amount.value).toBe('1234.5');
  });
  it('requires deliberate review and only returns public numeric/date fields, never prose or identifiers', () => {
    const parsed = parseOrder(receipt('49.90', [line('订单号：00001234567890', 300), line('收货人：张测试 13800138000', 400)]));
    expect(() => reviewedOrderFields(parsed, { amount: '49.9', confirmed: false })).toThrow();
    expect(reviewedOrderFields(parsed, { amount: '49.9', date: '2026-11-24', confirmed: true })).toEqual({ amount: '49.9', date: '2026-11-24', time: '' });
    expect(() => reviewedOrderFields(parsed, { amount: '888', confirmed: true })).toThrow();
    expect(reviewedOrderFields(parsed, { time: '12:34:56', confirmed: true })).toEqual({});
  });
  for (let index = 0; index < 100; index++) {
    const amount = `${index + 1}.${String(index % 100).padStart(2, '0')}`;
    it(`parses independent explicit receipt ${index + 1} without platform rules`, () => {
      const parsed = parseOrder(receipt(amount), []);
      expect(reviewedOrderFields(parsed, { amount: parsed.fields.amount.value, date: '2026-11-24', confirmed: true }).amount).toBe(parsed.fields.amount.value);
      expect(parsed.fields.amount.state).toBe('suggested');
      expect(parsed.fields.amount.value).toBe(amount.replace(/0+$/, '').replace(/\.$/, ''));
    });
  }
});
