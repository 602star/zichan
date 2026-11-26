import { expect } from '@playwright/test';
import QRCode from 'qrcode';
import { crc32 } from 'node:zlib';
import { openLedger } from './helpers.mjs';
import { openLedgerSection } from '../ledger-navigation.mjs';
export const ORDER = '00009876543210987654', TRACKING = 'SF00000123456789', PHONE = '13800138000';
export async function entry(page) {
  await openLedger(page); await openLedgerSection(page, 'transactions', 'records');
  await page.locator('#transaction-records').getByRole('button', { name: /^\+ 记(账|支出)$/ }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  await expect(form.getByRole('button', { name: '从截图识别金额与日期', exact: true })).toHaveCount(0);
  return form;
}
export async function receipt(page, amount = '49.90', long = false) {
  const qr = await QRCode.toDataURL(`private-phone:${PHONE}`, { width: 200, margin: 1 });
  const data = await page.evaluate(async ({ amount, long, qr, ORDER, TRACKING, PHONE }) => {
    await document.fonts.load('42px "LXGW WenKai Screen"');
    const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = long ? 3200 : 1400;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = 'black'; ctx.font = '42px "LXGW WenKai Screen", sans-serif';
    ['订单详情', '支付成功', `实付款：${amount} CNY`, '付款时间：2026-11-25 12:34:56', `订单号：${ORDER}`, `运单号：${TRACKING}`, '收货人：虚构测试姓名', `联系电话：${PHONE}`, '收货地址：虚构测试市测试路88号', '测试大楼虚构门牌99室'].forEach((text, i) => ctx.fillText(text, 40, (long ? 1400 : 70) + i * 80));
    const img = new Image(); img.src = qr; await img.decode(); ctx.drawImage(img, 760, long ? 2300 : 900, 200, 200);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { amount, long, qr, ORDER, TRACKING, PHONE });
  const png = Buffer.from(data, 'base64'), comment = Buffer.from('Comment\0PRIVATE-META');
  const chunk = Buffer.alloc(comment.length + 12); chunk.writeUInt32BE(comment.length); chunk.write('tEXt', 4); comment.copy(chunk, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + comment.length)), 8 + comment.length);
  return { name: 'synthetic-order.png', mimeType: 'image/png', buffer: Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]) };
}
export async function addAndExtract(page, form, image) {
  await form.getByLabel('附件 / 图片', { exact: true }).setInputFiles(image);
  const item = form.locator('.zc-attachment-item').last();
  await expect(item.getByText(image.name, { exact: true })).toBeVisible();
  await item.getByRole('button', { name: '提取信息', exact: true }).click();
  const panel = page.locator('.zc-attachment-processing');
  await expect(panel.locator('.zc-attachment-file-tools > summary')).toHaveText('图片信息与重新提取', { timeout: 120_000 });
  await expect(panel.getByRole('alert')).toHaveCount(0);
  return panel;
}
