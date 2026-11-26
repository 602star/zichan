import { describe, expect, it } from 'vitest';
import { detectPrivacyRegions, maskBounds } from '../src/order-capture/privacy.js';
import type { OcrLine } from '../src/order-capture/types.js';
import { protectOrderDraft } from '../src/order-capture/application.js';
const line = (id: string, text: string, y: number, x = 20, width = 700): OcrLine => ({ id, text, score: 0.4, poly: [[x, y], [x + width, y], [x + width, y + 30], [x, y + 30]] });
describe('local order privacy region detection', () => {
  it('covers complete recipient blocks, adjacent values, and wrapped address lines at low OCR confidence', () => {
    const lines = [line('recipient', '收货人', 100, 20, 100), line('name', '虚构测试姓名', 100, 200, 200), line('phone', '联系电话：13800138000', 150), line('address', '收货地址', 200), line('wrapped1', '虚构测试省测试市', 240), line('wrapped2', '测试路88号虚构门牌', 280), line('amount', '实付款：19.90 CNY', 325)];
    const masks = detectPrivacyRegions({ lines, width: 1080, height: 900 });
    for (const row of lines.filter((value) => value.id !== 'amount')) {
      expect(masks.some((mask) => mask.x <= row.poly[0]![0] && mask.y <= row.poly[0]![1] && mask.x + mask.width >= row.poly[2]![0] && mask.y + mask.height >= row.poly[2]![1])).toBe(true);
    }
    expect(masks.some((mask) => mask.y <= 325 && mask.y + mask.height >= 355)).toBe(false);
    expect(masks.every((mask) => mask.required)).toBe(true);
  });
  it.each(['订单号：00001234567890', '运单号：SF0000123456789', '交易单号：123456789012345678', '银行卡：6222000012345678901', '邮箱 sentinel@example.test', '手机号 138****1234', '138 0013 8000'])('covers identifier or contact evidence: %s', (text) => {
    expect(detectPrivacyRegions({ lines: [line('private', text, 100)], width: 1080, height: 900 })).toHaveLength(1);
  });
  it('covers rotated barcode polygons with expanded, clipped opaque rectangles', () => {
    const masks = detectPrivacyRegions({ lines: [], width: 100, height: 100, barcodes: [{ poly: [[-2, 10], [40, 2], [50, 40], [0, 50]] }] });
    expect(masks[0]).toMatchObject({ x: 0, y: 0, width: 64, height: 64, required: true });
    expect(maskBounds([[90, 90], [110, 110]], 100, 100, 'test')).toMatchObject({ x: 80, y: 80, width: 20, height: 20 });
  });
  it('does not call arbitrary bare product names, prices, or payment dates private', () => {
    expect(detectPrivacyRegions({ lines: [line('name', '普通商品明细', 10), line('amount', '实付款：1234.56 CNY', 100), line('date', '付款时间：2026-11-24 12:34:56', 200)], width: 1080, height: 900 })).toEqual([]);
  });
  it('removes unreviewed legacy image blobs and source filenames before restoring ordinary autosave', () => {
    const raw = { fileName: 'PRIVATE-SOURCE-00001234567890.png', contentBlob: new Blob(['original']) };
    const existing = { id: 'historical-attachment', fileName: 'historical.png', sha256: 'a'.repeat(64) };
    const result = protectOrderDraft({ version: 1, key: 'transaction:new', savedAt: '', values: { amount: '19.9', attachmentDrafts: JSON.stringify([raw, existing]) }, files: { attachmentDrafts: [raw, existing] } });
    expect(result.removed).toBe(1); expect(result.draft.files.attachmentDrafts).toEqual([existing]);
    expect(JSON.stringify(result.draft)).not.toContain('PRIVATE-SOURCE'); expect(result.draft.values.amount).toBe('19.9');
  });
});
