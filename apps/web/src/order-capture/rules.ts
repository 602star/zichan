import type { OrderFieldKey, ParsedOrder } from './types.js';

export type FieldLabels = Partial<Record<OrderFieldKey, RegExp>>;
export interface OrderRule {
  id: string;
  platform: ParsedOrder['platform'];
  matches: (text: string) => boolean;
  labels?: FieldLabels;
  documentKind?: ParsedOrder['documentKind'];
  signedExpense?: boolean;
}
const commerce = (brand: RegExp) => (text: string) => brand.test(text) && /订单|实付|收货|支付|交易|账单/.test(text);
export const INVOICE_HEADER = /(?:增值税(?:电子)?(?:普通|专用)?发票|电子(?:普通|专用)发票|电子发票\s*[（(](?:增值税)?(?:普通|专用)发票[）)]|(?:^|\n)电子发票(?:\n|$)|数电发票|全面数字化的电子发票)/;

/** Aliases establish meaning, never absolute screen coordinates or largest-number guesses. */
export const ORDER_RULES: readonly OrderRule[] = [
  { id: 'jd.order.v1', platform: 'jd', matches: commerce(/京东/), labels: { amount: /实际支付|已支付金额/ } },
  { id: 'taobao.order.v1', platform: 'taobao', matches: commerce(/淘宝|天猫/), labels: { amount: /买家实付|实付\s*\(含运费\)/ } },
  { id: 'pinduoduo.order.v1', platform: 'pinduoduo', matches: commerce(/拼多多|拼单已拼成/), labels: { amount: /实际支付|实付共计/, merchant: /店铺名称|商家名称/ } },
  { id: 'douyin.order.v1', platform: 'douyin', matches: commerce(/抖音|抖店/), labels: { amount: /实际支付|支付合计/, orderNumber: /主订单编号|主订单号/ } },
  { id: 'kuaishou.order.v1', platform: 'kuaishou', matches: commerce(/快手|快手小店/), labels: { amount: /实际支付|支付合计/ } },
  { id: 'xianyu.order.v1', platform: 'xianyu', matches: commerce(/闲鱼/), labels: { amount: /我实付款|买家实付|实际付款/, product: /宝贝名称/ } },
  { id: 'meituan.order.v1', platform: 'meituan', matches: commerce(/美团|美团外卖/), labels: { amount: /实际支付|实付合计/, merchant: /商家名称|餐厅名称/, product: /餐品名称/ } },
  { id: 'eleme.order.v1', platform: 'eleme', matches: commerce(/饿了么|饿了麼/), labels: { amount: /实际支付|在线支付金额/, merchant: /商家名称|餐厅名称/ } },
  { id: 'vip.order.v1', platform: 'vip', matches: commerce(/唯品会/), labels: { amount: /实际支付|订单实付/ } },
  { id: 'suning.order.v1', platform: 'suning', matches: commerce(/苏宁易购/), labels: { amount: /实际支付|已支付金额/ } },
  { id: '1688.order.v1', platform: '1688', matches: commerce(/1688|阿里巴巴/), labels: { amount: /买家实付|实际支付/ } },
  { id: 'xiaohongshu.order.v1', platform: 'xiaohongshu', matches: commerce(/小红书/), labels: { amount: /实际支付|实付合计/ } },
  { id: 'wechat.bill.v1', platform: 'wechat', matches: (text) => (/微信支付|微信账单/.test(text) || (/账单详情/.test(text) && /交易单号/.test(text) && /商户单号|零钱|财付通/.test(text))) && /账单详情|交易单号|支付成功/.test(text), documentKind: 'payment', signedExpense: true,
    labels: { amount: /支付总额|支出金额/, merchant: /收款方|商户全称/, orderNumber: /商户单号|商户订单号/ } },
  { id: 'alipay.bill.v1', platform: 'alipay', matches: (text) => (/支付宝/.test(text) || (/账单详情/.test(text) && /(?:^|\n)交易号/.test(text) && /花呗|余额宝|商家订单号/.test(text))) && /账单详情|交易号|支付成功/.test(text), documentKind: 'payment', signedExpense: true,
    labels: { amount: /支出金额|付款总额/, merchant: /对方名称|商家名称|收款方/, orderNumber: /商家订单号|商户订单号/ } },
  { id: 'cn.invoice.v1', platform: 'unknown', matches: (text) => INVOICE_HEADER.test(text) && /价税合计|开票日期|发票号码/.test(text), documentKind: 'invoice',
    labels: { amount: /价税合计(?:\s*\([大小]写\))?/, invoiceNumber: /发票号码/, invoiceCode: /发票代码/, invoiceDate: /开票日期/, merchant: /销售方名称|销方名称/ } },
];
