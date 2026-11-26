export type Point = [number, number];
export interface OcrLine { id: string; text: string; poly: Point[]; score: number }
export type OrderFieldKey = 'amount' | 'currency' | 'paymentDate' | 'paymentTime' | 'orderNumber' | 'trackingNumber' | 'merchant' | 'product' | 'invoiceNumber' | 'invoiceCode' | 'invoiceDate';
export interface FieldCandidate {
  value: string;
  lineIds: string[];
  reason: string;
  priority: number;
  ruleId?: string;
}
export interface OrderField {
  value?: string;
  state: 'missing' | 'suggested' | 'ambiguous';
  candidates: FieldCandidate[];
}
export interface ParsedOrder {
  platform: 'unknown' | 'taobao' | 'jd' | 'pinduoduo' | 'douyin' | 'kuaishou' | 'xianyu' | 'meituan' | 'eleme' | 'vip' | 'suning' | '1688' | 'xiaohongshu' | 'wechat' | 'alipay';
  documentKind: 'order' | 'payment' | 'invoice';
  fields: Record<OrderFieldKey, OrderField>;
  paymentState: 'paid' | 'unpaid' | 'closed' | 'refunded' | 'ambiguous' | 'unknown';
  ruleIds: string[];
  warnings: string[];
}
export interface OcrResult {
  barcodes?: { poly: Point[] }[];
  barcodeScan?: 'complete' | 'unavailable';
  lines: OcrLine[];
  width: number;
  height: number;
  initializationMs: number;
  recognitionMs: number;
  tileCount: number;
}
/** Only these reviewed values may cross into the normal, automatically saved form. */
export interface ReviewedOrderFields { amount?: string; date?: string; time?: string }
