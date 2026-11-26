import type { OcrLine, OcrResult, Point } from './types.js';
import { lineBox } from './parser.js';

export const REDACTION_RULE_VERSION = 'order-privacy.v1';
export interface MaskRegion { x: number; y: number; width: number; height: number; reason: string; required: boolean }
export function maskBounds(points: Point[], width: number, height: number, reason: string, padding = 10): MaskRegion {
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  const x = Math.max(0, Math.floor(Math.min(...xs) - padding)), y = Math.max(0, Math.floor(Math.min(...ys) - padding));
  const right = Math.min(width, Math.ceil(Math.max(...xs) + padding)), bottom = Math.min(height, Math.ceil(Math.max(...ys) + padding));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y), reason, required: true };
}
const CONTACT = /收货(?:人|信息|地址)?|收件(?:人|信息|地址)?|寄件(?:人|信息|地址)?|配送地址|详细地址|联系(?:人|电话|方式)|手机(?:号|号码)?|电话|定位|经纬度/;
const IDENTIFIER = /订单(?:号|编号|号码)|交易(?:号|编号|单号)|支付(?:单号|交易号)|商户单号|运单(?:号|号码)|快递单号|物流(?:单号|编号)|银行卡|身份证|证件号|账号|账户名|会员号|昵称|买家信息/;
const PRIVATE_PATTERN = /(?:\+?86[ -]?)?1[3-9](?:[ -]?\d){9}|\d{3,4}[ -]?(?:\*{3,}|×{3,})[ -]?\d{2,4}|\b\d{15,19}[Xx]?\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/;
const STOP = /商品|实付|付款|支付金额|优惠|运费|订单编号|订单号|交易时间|下单时间|店铺|商家|发票|售后/;
export function detectPrivacyRegions(result: Pick<OcrResult, 'lines' | 'width' | 'height' | 'barcodes'>): MaskRegion[] {
  const { lines, width, height } = result;
  const regions: MaskRegion[] = [];
  const add = (line: OcrLine, reason: string) => regions.push(maskBounds(line.poly, width, height, reason));
  for (const line of lines) {
    const text = line.text.normalize('NFKC');
    const contact = CONTACT.test(text), identifier = IDENTIFIER.test(text);
    if (contact || identifier || PRIVATE_PATTERN.test(text)) add(line, contact ? '收件或联系信息' : identifier ? '订单、物流或账号信息' : '号码或邮箱');
    if (contact || identifier) {
      const at = lineBox(line), h = Math.max(12, at.bottom - at.y);
      for (const near of lines) {
        if (near.id === line.id) continue;
        const box = lineBox(near), sameRow = Math.abs((box.y + box.bottom - at.y - at.bottom) / 2) < h;
        const below = box.y >= at.bottom - 2 && box.y - at.bottom < h * (contact ? 4 : 1.5);
        if ((sameRow || below) && !STOP.test(near.text) && (contact || !CONTACT.test(near.text))) add(near, contact ? '关联的姓名、电话或跨行地址' : '字段关联号码');
      }
    }
  }
  for (const barcode of result.barcodes ?? []) regions.push(maskBounds(barcode.poly, width, height, '二维码或条形码', 14));
  return regions.filter((row) => row.width > 0 && row.height > 0).filter((row, index, all) => !all.slice(0, index).some((other) => other.x <= row.x && other.y <= row.y && other.x + other.width >= row.x + row.width && other.y + other.height >= row.y + row.height));
}
