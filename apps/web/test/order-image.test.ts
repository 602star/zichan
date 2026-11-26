import { describe, expect, it } from 'vitest';
import { imageDimensions, mergeOcrLines, validateOrderImage } from '../src/order-capture/image.js';
import { validateOcrManifest } from '../src/order-capture/resources.js';

function png(width: number, height: number) {
  const bytes = new ArrayBuffer(24), view = new DataView(bytes);
  view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a); view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}
describe('order image and public resource boundaries', () => {
  it('validates pixel limits before attempting to decode an image', async () => {
    expect(imageDimensions(png(1080, 2400))).toEqual({ width: 1080, height: 2400 });
    await expect(validateOrderImage(new Blob([png(100000, 100000)]))).rejects.toThrow('像素过大');
    await expect(validateOrderImage(new Blob(['not a PNG'], { type: 'image/png' }))).rejects.toThrow('有效的');
    expect(imageDimensions(new ArrayBuffer(2))).toBeNull();
  });
  it('deduplicates overlap tiles without merging the same words on different rows', () => {
    const row = (y: number) => ({ id: String(y), text: '实付款', score: 0.9, poly: [[0, y], [100, y], [100, y + 20], [0, y + 20]] as [number, number][] });
    expect(mergeOcrLines([row(100), row(105), row(300)])).toHaveLength(2);
  });
  it('rejects private paths, redirects and arbitrary URLs in the OCR resource manifest', () => {
    const manifest = { version: 'v1', resources: [
      'ocr/PP-OCRv5_mobile_det_onnx_infer.tar', 'ocr/PP-OCRv5_mobile_rec_onnx_infer.tar',
      'ocr/ort-wasm-simd-threaded.jsep.mjs', 'assets/ocr-worker-public.js',
    ].map((file) => ({ file, bytes: 10, sha256: 'a'.repeat(64) })) };
    expect(validateOcrManifest(manifest).resources).toHaveLength(4);
    for (const path of ['https://example.com/model', 'ocr/../api/account', 'api/blobs', 'ocr/model?phone=123', 'assets/other.js']) {
      expect(() => validateOcrManifest({ ...manifest, resources: [{ ...manifest.resources[0], file: path }, ...manifest.resources.slice(1)] })).toThrow();
    }
  });
});
