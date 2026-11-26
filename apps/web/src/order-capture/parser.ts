import { D, isValidDay } from '@zichan/core';
import type { FieldCandidate, OcrLine, OrderField, OrderFieldKey, ParsedOrder } from './types.js';

type Labels = Partial<Record<OrderFieldKey, RegExp>>;
export interface OrderRule {
  id: string;
  platform: ParsedOrder['platform'];
  matches: (text: string) => boolean;
  labels?: Labels;
}
export const ORDER_RULES: readonly OrderRule[] = [
  { id: 'jd.order.v1', platform: 'jd', matches: (text) => /京东/.test(text) && /订单|实付|收货/.test(text), labels: { amount: /实际支付|已支付金额/ } },
  { id: 'taobao.order.v1', platform: 'taobao', matches: (text) => /淘宝|天猫/.test(text) && /订单|实付|收货/.test(text), labels: { amount: /买家实付/ } },
];
const LABELS: Labels = {
  amount: /实付款|实付金额|实际付款|支付金额|付款金额|实付(?!积分)|实收金额/,
  paymentDate: /付款时间|支付时间|交易时间|付款日期|支付日期/,
  paymentTime: /付款时间|支付时间|交易时间|付款日期|支付日期/,
  orderNumber: /订单编号|订单号码|订单号|商户订单号/,
  trackingNumber: /物流单号|快递单号|运单号码|运单号|物流编号/,
  merchant: /店铺名称|商家名称|收款商户|收款方|商户名称/,
  product: /商品名称|商品信息|商品明细/,
};
export function lineBox(line: OcrLine) {
  const xs = line.poly.map((point) => point[0]), ys = line.poly.map((point) => point[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}
const normalized = (text: string) => text.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
const compact = (text: string) => normalized(text).replace(/\s+/g, '');
function field(candidates: FieldCandidate[]): OrderField {
  const ranked = [...candidates].sort((a, b) => b.priority - a.priority);
  const unique: FieldCandidate[] = [];
  for (const candidate of ranked) {
    const existing = unique.find((row) => row.value === candidate.value);
    if (existing) existing.lineIds = [...new Set([...existing.lineIds, ...candidate.lineIds])];
    else unique.push({ ...candidate, lineIds: [...candidate.lineIds] });
  }
  const top = unique[0];
  if (!top) return { state: 'missing', candidates: [] };
  const competing = unique.filter((row) => row.priority === top.priority);
  return competing.length > 1 ? { state: 'ambiguous', candidates: unique }
    : { state: 'suggested', value: top.value, candidates: unique };
}
function extract(key: OrderFieldKey, text: string): string[] {
  const value = normalized(text);
  if (key === 'amount') {
    // Currency symbols are optional only after a payment label has established the meaning.
    const matches = [...value.matchAll(/(?:[¥￥$€]|CNY|RMB|USD|EUR|JPY)?\s*((?:\d{1,3}(?:,\d{3})+|\d{1,8})(?:\.\d{1,4})?)(?:\s*元)?/g)];
    return matches.filter((match) => !/[\dA-Za-z]/.test(value[(match.index ?? 0) - 1] ?? '')
      && !/[\dA-Za-z:/年月日]/.test(value[(match.index ?? 0) + match[0].length] ?? ''))
      .flatMap((match) => { try { const amount = D(match[1]!.replaceAll(',', '')); return amount.gt(0) ? [amount.toString()] : []; } catch { return []; } });
  }
  if (key === 'paymentDate') {
    return [...value.matchAll(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/g)].map((match) => `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`).filter(isValidDay);
  }
  if (key === 'paymentTime') return [...value.matchAll(/(?:^|[\s日T])([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?!\d)/g)]
    .map((match) => `${match[1]!.padStart(2, '0')}:${match[2]}${match[3] ? `:${match[3]}` : ''}`);
  if (key === 'orderNumber' || key === 'trackingNumber') return [...compact(value).matchAll(/[A-Za-z0-9][A-Za-z0-9-]{5,63}/g)].map((match) => match[0]);
  if (key === 'merchant' || key === 'product') {
    const cleaned = value.replace(/^[\s:：-]+/, '').trim();
    // Public prose is never applied automatically. Exclude obvious recipient/contact text even in preview fields.
    return cleaned && cleaned.length <= 160 && !/收货|收件|电话|手机|地址|\d{7,}/.test(cleaned) ? [cleaned] : [];
  }
  return [];
}
function neighboringValues(line: OcrLine, all: OcrLine[]): OcrLine[] {
  const box = lineBox(line), height = Math.max(1, box.bottom - box.y);
  return all.filter((other) => {
    if (other.id === line.id) return false;
    const at = lineBox(other), otherHeight = Math.max(1, at.bottom - at.y);
    const sameRow = Math.abs((at.y + at.bottom - box.y - box.bottom) / 2) <= Math.max(height, otherHeight) * 0.7
      && at.x >= box.right - height && at.x - box.right < Math.max(800, height * 30);
    const below = at.y >= box.bottom - 2 && at.y - box.bottom <= height * 2
      && Math.max(at.x, box.x) <= Math.min(at.right, box.right) + height * 2;
    return sameRow || below;
  }).sort((a, b) => {
    const left = lineBox(a), right = lineBox(b);
    return Math.abs(left.y - box.y) - Math.abs(right.y - box.y) || left.x - right.x;
  }).slice(0, 3);
}
export function parseOrder(lines: readonly OcrLine[], rules: readonly OrderRule[] = ORDER_RULES): ParsedOrder {
  const usable = lines.filter((line) => line.poly.length >= 3 && line.poly.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) && line.text.trim());
  const text = usable.map((line) => compact(line.text)).join('\n');
  const matched = rules.filter((rule) => rule.matches(text));
  const candidates: Record<OrderFieldKey, FieldCandidate[]> = { amount: [], currency: [], paymentDate: [], paymentTime: [], orderNumber: [], trackingNumber: [], merchant: [], product: [] };
  const gather = (labels: Labels, ruleId?: string) => {
    for (const [key, label] of Object.entries(labels) as [OrderFieldKey, RegExp][]) {
      for (const line of usable) {
        const source = normalized(line.text), match = label.exec(source);
        if (!match) continue;
        const tail = source.slice(match.index + match[0].length).replace(/^[\s:：]+/, '');
        const direct = extract(key, tail);
        const add = (values: string[], evidence: OcrLine[], priority: number, reason: string) => {
          for (const value of values) candidates[key].push({ value, lineIds: evidence.map((row) => row.id), priority, reason, ruleId });
        };
        if (direct.length) add(direct, [line], 100, `明确字段：${match[0]}`);
        else {
          for (const near of neighboringValues(line, usable)) {
            const nearby = normalized(near.text);
            // A neighboring label/value belonging to shipping, discount, recipient, or order identifiers is not payment evidence.
            if (/原价|优惠|运费|商品金额|订单号|运单|电话|收货|收件|地址|下单|创建/.test(nearby)) continue;
            add(extract(key, nearby), [line, near], 80, `字段邻近：${match[0]}`);
          }
        }
      }
    }
  };
  gather(LABELS);
  for (const rule of matched) if (rule.labels) gather(rule.labels, rule.id);
  for (const line of usable) {
    // Never turn a bare total, date, or the largest number into a paid amount.
    const currency = /\b(CNY|RMB|USD|EUR|JPY)\b/i.exec(normalized(line.text));
    if (currency && /实付|付款金额|支付金额|实际支付/.test(line.text)) candidates.currency.push({ value: currency[1]!.toUpperCase().replace('RMB', 'CNY'), lineIds: [line.id], priority: 100, reason: '明确币种代码' });
  }
  const states: ParsedOrder['paymentState'][] = [];
  if (/待付款|等待付款|尚未支付|未付款|待支付/.test(text)) states.push('unpaid');
  if (/交易关闭|订单关闭|已取消/.test(text)) states.push('closed');
  if (/退款成功|已退款|退款中|退款完成|部分退款/.test(text)) states.push('refunded');
  if (/已付款|付款成功|支付成功|交易成功|已支付|实付款|实付金额/.test(text)) states.push('paid');
  const distinct = [...new Set(states)];
  const paymentState = distinct.length > 1 ? 'ambiguous' : distinct[0] ?? 'unknown';
  const fields = Object.fromEntries(Object.entries(candidates).map(([key, values]) => [key, field(values)])) as ParsedOrder['fields'];
  const platforms = [...new Set(matched.map((rule) => rule.platform).filter((platform) => platform !== 'unknown'))];
  const warnings: string[] = [];
  if (paymentState !== 'paid') warnings.push(paymentState === 'unknown' ? '付款状态未识别，请核对是否已经支付。' : '订单状态需要处理，不能直接当作普通已付款支出。');
  if (fields.amount.state === 'ambiguous') warnings.push('检测到多个实付金额，请核对是否包含不同订单。');
  if (fields.orderNumber.state === 'ambiguous') warnings.push('检测到多个订单号，请核对图片范围。');
  if (fields.currency.state === 'missing') warnings.push('未确认币种，货币符号不足以确定币种。');
  return { platform: platforms.length === 1 ? platforms[0]! : 'unknown', fields, paymentState, ruleIds: matched.map((rule) => rule.id), warnings };
}
