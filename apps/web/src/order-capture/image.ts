import type { OcrLine } from './types.js';
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 24_000_000;
export function imageDimensions(bytes: ArrayBuffer): { width: number; height: number } | null {
  const data = new DataView(bytes);
  if (data.byteLength >= 24 && data.getUint32(0) === 0x89504e47 && data.getUint32(4) === 0x0d0a1a0a) return { width: data.getUint32(16), height: data.getUint32(20) };
  if (data.byteLength >= 30 && data.getUint32(0) === 0x52494646 && data.getUint32(8) === 0x57454250) {
    const format = data.getUint32(12);
    if (format === 0x56503858) return { width: 1 + data.getUint8(24) + (data.getUint8(25) << 8) + (data.getUint8(26) << 16), height: 1 + data.getUint8(27) + (data.getUint8(28) << 8) + (data.getUint8(29) << 16) };
    if (format === 0x56503820 && data.getUint8(23) === 0x9d && data.getUint8(24) === 1 && data.getUint8(25) === 0x2a) return { width: data.getUint16(26, true) & 0x3fff, height: data.getUint16(28, true) & 0x3fff };
    if (format === 0x5650384c && data.getUint8(20) === 0x2f) { const bits = data.getUint32(21, true); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
  }
  if (data.byteLength >= 4 && data.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 4 < data.byteLength) {
      if (data.getUint8(offset) !== 0xff) return null;
      const marker = data.getUint8(offset + 1);
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xd9 || marker === 0xda) return null;
      const length = data.getUint16(offset + 2);
      if (length < 2 || offset + length + 2 > data.byteLength) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) return { width: data.getUint16(offset + 7), height: data.getUint16(offset + 5) };
      offset += length + 2;
    }
  }
  return null;
}
export async function validateOrderImage(file: Blob) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片超过 20 MiB，请裁剪后重试。');
  const size = imageDimensions(await file.slice(0, 1024 * 1024).arrayBuffer());
  if (!size) throw new Error('请选择有效的 PNG、JPEG 或 WebP 图片。');
  if (size.width < 1 || size.height < 1 || size.width * size.height > MAX_IMAGE_PIXELS) throw new Error('图片像素过大，请裁剪或分张识别。');
  return size;
}
export function mergeOcrLines(lines: OcrLine[]): OcrLine[] {
  const result: OcrLine[] = [];
  for (const line of lines) {
    const x = Math.min(...line.poly.map((p) => p[0])), y = Math.min(...line.poly.map((p) => p[1]));
    const duplicate = result.find((other) => other.text.replace(/\s/g, '') === line.text.replace(/\s/g, '')
      && Math.abs(Math.min(...other.poly.map((p) => p[0])) - x) < 20 && Math.abs(Math.min(...other.poly.map((p) => p[1])) - y) < 20);
    if (!duplicate) result.push(line);
  }
  return result.sort((a, b) => Math.min(...a.poly.map((p) => p[1])) - Math.min(...b.poly.map((p) => p[1])));
}
