import { describe, expect, it } from 'vitest';
import { parseOrder } from '../src/order-capture/parser.js';
import { suggestedCaptureFields } from '../src/order-capture/attachment-review.js';
import { detectPrivacyRegions } from '../src/order-capture/privacy.js';
import type { OcrLine, ParsedOrder } from '../src/order-capture/types.js';

const line = (text: string, y: number, x = 20, width = 700): OcrLine => ({ id: `${y}:${x}`, text, score: .98, poly: [[x, y], [x + width, y], [x + width, y + 30], [x, y + 30]] });
const rows = (...text: string[]) => text.map((text, index) => line(text, index * 100));

describe('platform rule registry', () => {
  const cases: [string, ParsedOrder['platform'], string][] = [
    ['京东', 'jd', '实际支付'], ['淘宝', 'taobao', '买家实付'], ['天猫', 'taobao', '买家实付'],
    ['拼多多', 'pinduoduo', '实付共计'], ['抖音', 'douyin', '支付合计'], ['快手小店', 'kuaishou', '实际支付'],
    ['闲鱼', 'xianyu', '我实付款'], ['美团外卖', 'meituan', '实付合计'], ['饿了么', 'eleme', '在线支付金额'],
    ['唯品会', 'vip', '订单实付'], ['苏宁易购', 'suning', '已支付金额'], ['1688', '1688', '买家实付'],
    ['小红书', 'xiaohongshu', '实付合计'],
  ];
  it.each(cases)('%s adds explicit aliases and retains generic fields', (brand, platform, label) => {
    const result = parseOrder(rows(`${brand}订单详情`, '支付成功', `${label}：￥1,234.50`, '付款时间：2026-11-25 12:34:56', '订单编号：00001234567890', '商品金额：1500.00', '优惠金额：265.50'));
    expect(result.platform).toBe(platform); expect(result.documentKind).toBe('order');
    expect(result.fields.amount.value).toBe('1234.5'); expect(result.fields.paymentDate.value).toBe('2026-11-25');
    expect(result.fields.orderNumber.value).toBe('00001234567890'); expect(result.ruleIds.length).toBeGreaterThan(0);
  });
  it.each(['微信支付', '支付宝'])('%s handles signed expense without confusing payment IDs and merchant orders', (brand) => {
    const result = parseOrder(rows(`${brand}账单详情`, '支付成功', '-39.90', '交易单号：42000009999999999999', '商户订单号：00001234567890', '支付时间：2026-11-25 12:00'));
    expect(result.documentKind).toBe('payment'); expect(result.fields.amount.value).toBe('39.9');
    expect(result.fields.orderNumber.value).toBe('00001234567890');
    expect(result.fields.orderNumber.candidates).toHaveLength(1);
  });
  it.each(['收入', '转账', '充值', '提现'])('does not infer a purchase amount from a %s payment bill', (kind) => {
    const result = parseOrder(rows('支付宝账单详情', '交易成功', kind, '-39.90'));
    expect(result.fields.amount.state).toBe('missing'); expect(result.warnings.join('')).toContain('业务类型');
  });
  it.each([
    ['wechat', '交易单号：42000009999999999999', '商户单号：00001234567890'],
    ['alipay', '交易号：20261125000000000001', '商家订单号：00001234567890'],
  ])('identifies %s bill structure without requiring a brand logo OCR result', (platform, paymentId, merchantId) => {
    const result = parseOrder(rows('账单详情', '支付成功', '-39.90', paymentId, merchantId));
    expect(result.platform).toBe(platform); expect(result.fields.amount.value).toBe('39.9');
    expect(result.fields.orderNumber.value).toBe('00001234567890');
  });
  it('keeps conflicting platform evidence ambiguous and isolates each parse', () => {
    expect(parseOrder(rows('京东订单详情', '实际支付：39.9', '实付款：49.9')).fields.amount.state).toBe('ambiguous');
    expect(parseOrder(rows('未知平台订单', '实际支付：39.9')).fields.amount.state).toBe('missing');
    expect(parseOrder(rows('京东订单详情', '应付总额：39.9', '待付款')).fields.amount.state).toBe('missing');
  });
  it('reads spaced Chinese labels and splits merged discount fields', () => {
    const result = parseOrder(rows('实 付 金 额：49.90 优惠金额：10.00 运费：3.00', '付 款 时 间：2026-11-25 12:30'));
    expect(result.fields.amount.value).toBe('49.9'); expect(result.fields.paymentTime.value).toBe('12:30');
  });
  it('accepts shipping annotations and OCR spacing without taking shipping charges as another paid amount', () => {
    const result = parseOrder(rows('淘宝订单详情', '实付款（含运费）49.90 优惠10.00 运费3.00', '付款时间：2026 - 11 - 25 12 : 34 : 56'));
    expect(result.fields.amount.value).toBe('49.9'); expect(result.fields.amount.candidates).toHaveLength(1);
    expect(result.fields.paymentDate.value).toBe('2026-11-25'); expect(result.fields.paymentTime.value).toBe('12:34:56');
  });
});

describe('Chinese invoice evidence', () => {
  it.each(['增值税电子普通发票', '增值税专用发票', '电子发票（普通发票）', '电子发票（增值税专用发票）', '数电发票', '电子发票'])('parses %s without inventing a payment date', (header) => {
    const result = parseOrder(rows(header, '发票号码：00001234567890123456', '开票日期：2026年11月25日', '金额合计：100.00', '税额：13.00', '价税合计（小写）：￥113.00', '销售方名称：合成示例商店'));
    expect(result.documentKind).toBe('invoice'); expect(result.paymentState).toBe('unknown');
    expect(result.fields.amount.value).toBe('113'); expect(result.fields.invoiceDate.value).toBe('2026-11-25');
    expect(result.fields.invoiceNumber.value).toBe('00001234567890123456'); expect(result.fields.invoiceCode.state).toBe('missing');
    expect(result.fields.paymentDate.state).toBe('missing'); expect(result.fields.paymentTime.state).toBe('missing');
    expect(result.fields.merchant.value).toBe('合成示例商店');
    const selection = suggestedCaptureFields(result, {}, new Set());
    expect(selection).toMatchObject({ amount: '113', invoiceNumber: '00001234567890123456', invoiceDate: '2026-11-25' });
    expect(selection).not.toHaveProperty('date'); expect(selection).not.toHaveProperty('orderNumber');
    expect(result.warnings.join('')).toContain('不等于已付款');
  });
  it('uses the small-written total on a separate box, not net amount or tax', () => {
    const result = parseOrder([
      line('增值税电子普通发票', 0), line('金额合计：100.00', 100), line('税额：13.00', 200),
      line('价税合计（大写）：壹佰壹拾叁圆整', 300), line('（小写）￥113.00', 300, 800, 300),
      line('发票号码：00001234', 400), line('发票代码：012345678901', 500),
    ]);
    expect(result.fields.amount.value).toBe('113'); expect(result.fields.amount.candidates[0]?.lineIds).toHaveLength(2);
    expect(result.fields.invoiceNumber.value).toBe('00001234'); expect(result.fields.invoiceCode.value).toBe('012345678901');
  });
  it('uses seller name rather than buyer name in a labeled information section', () => {
    const result = parseOrder([line('电子发票（普通发票）', 0), line('开票日期：2026-11-25', 100), line('购买方信息', 200, 20, 150), line('名称：个人测试买家', 240, 20, 350), line('销售方信息', 200, 600, 150), line('名称：示例销售公司', 240, 600, 350), line('价税合计：113.00', 400)]);
    expect(result.fields.merchant.value).toBe('示例销售公司');
  });
  it.each(['红字发票', '发票作废', '已作废'])('flags %s instead of treating it as a normal purchase', (state) => {
    const result = parseOrder(rows('增值税电子普通发票', state, '价税合计：113.00', '开票日期：2026-11-25'));
    expect(['refunded', 'closed', 'ambiguous']).toContain(result.paymentState);
  });
  it('never turns a negative invoice total or two invoices into one definite payment', () => {
    expect(parseOrder(rows('电子发票（普通发票）', '价税合计：-113.00')).fields.amount.state).toBe('missing');
    const result = parseOrder(rows('增值税电子普通发票', '价税合计：113.00', '价税合计：226.00', '发票号码：00001234', '发票号码：00005678'));
    expect(result.fields.amount.state).toBe('ambiguous'); expect(result.fields.invoiceNumber.state).toBe('ambiguous');
  });
  it('does not mistake an order invoice menu for an invoice or store taxpayer IDs as invoice numbers', () => {
    const order = parseOrder(rows('京东订单详情', '发票信息', '实付款：113.00', '订单号：00001234567890'));
    expect(order.documentKind).toBe('order'); expect(order.fields.invoiceNumber.state).toBe('missing');
    const invoice = parseOrder(rows('电子发票（普通发票）', '纳税人识别号：91310000TEST000001', '开票日期：2026-11-25', '发票号码：123456789012345678901'));
    expect(invoice.fields.invoiceNumber.state).toBe('missing');
  });
  it('suggests masking buyer, taxpayer, bank and invoice identifiers including separated values', () => {
    const fields = ['购买方名称：测试买家', '纳税人识别号', '91310000TEST000001', '开户银行及账号：示例银行 000012345678', '发票号码', '00001234567890123456', '校验码：12345'].map((text, index) => line(text, index * 42));
    const regions = detectPrivacyRegions({ lines: fields, width: 1200, height: 900 });
    for (const source of fields) expect(regions.some((region) => region.y <= source.poly[0]![1] && region.y + region.height >= source.poly[2]![1])).toBe(true);
  });
});
