/// <reference lib="webworker" />
import { PaddleOCR } from '@paddleocr/paddleocr-js';
import cvModule from '@techstark/opencv-js';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { env } from 'onnxruntime-web';
import type { OcrMemoryAsset } from './resources.js';
import { mergeOcrLines, validateOrderImage } from './image.js';
import type { OcrLine, OcrResult } from './types.js';

const worker = self as DedicatedWorkerGlobalScope;
let engine: Awaited<ReturnType<typeof PaddleOCR.create>> | undefined;
let running = false;
// This OpenCV build is an Emscripten thenable, not a native Promise. Waiting
// for its runtime prevents model-ready messages from racing type registration.
const cvReady = new Promise<{ cv: typeof cvModule }>((resolve) => {
  const module = cvModule as typeof cvModule & { then?: (ready: (cv: typeof cvModule) => void) => unknown };
  if (typeof module.then === 'function') module.then((cv) => resolve({ cv }));
  else resolve({ cv: module });
});
const originalFetch = globalThis.fetch.bind(globalThis);
let assetBase: URL;
const verifiedResources = new Map<string, Blob>();
// Even an accidental SDK fallback is restricted to public, same-origin, read-only resources.
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, worker.location.href);
  if (!assetBase || url.origin !== assetBase.origin || !url.pathname.startsWith(assetBase.pathname)
    || url.search || (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'GET') {
    return Promise.reject(new Error('OCR_RESOURCE_NOT_ALLOWED'));
  }
  const verified = verifiedResources.get(url.href);
  if (verified) { verifiedResources.delete(url.href); return Promise.resolve(new Response(verified, { headers: { 'Content-Type': verified.type } })); }
  return originalFetch(input, { ...init, credentials: 'omit', redirect: 'error' });
};
worker.onmessage = async (event: MessageEvent<{ id: number; file: Blob; baseUrl: string; assets?: OcrMemoryAsset[] }>) => {
  const { id, file, baseUrl, assets } = event.data;
  if (running) { worker.postMessage({ id, error: 'BUSY' }); return; }
  running = true;
  let image: ImageBitmap | undefined;
  let initializationMs = 0;
  try {
    assetBase = new URL(baseUrl);
    await validateOrderImage(file);
    worker.postMessage({ id, progress: { phase: 'initializing', current: 0, total: 1 } });
    const { cv } = await cvReady;
    if (!engine) {
      const started = performance.now();
      for (const asset of assets ?? []) {
        if (!/^[A-Za-z0-9_.-]+$/.test(asset.file) || asset.file.includes('..')) throw new Error('OCR_RESOURCE_NOT_ALLOWED');
        verifiedResources.set(new URL(asset.file, assetBase).href, asset.blob);
      }
      const wasm = verifiedResources.get(new URL('ort-wasm-simd-threaded.wasm', assetBase).href);
      if (wasm) {
        env.wasm.wasmBinary = await wasm.arrayBuffer();
        verifiedResources.delete(new URL('ort-wasm-simd-threaded.wasm', assetBase).href);
      }
      prepareZXingModule({ overrides: { locateFile: () => new URL('zxing_reader.wasm', assetBase).href } });
      engine = await PaddleOCR.create({
        worker: false, textDetectionModelName: 'PP-OCRv5_mobile_det', textRecognitionModelName: 'PP-OCRv5_mobile_rec',
        textDetectionModelAsset: { url: new URL('PP-OCRv5_mobile_det_onnx_infer.tar', assetBase).href },
        textRecognitionModelAsset: { url: new URL('PP-OCRv5_mobile_rec_onnx_infer.tar', assetBase).href },
        ortOptions: { backend: 'wasm', wasmPaths: assetBase.href, numThreads: 1, proxy: false },
        textRecognitionBatchSize: 1, textDetectionBatchSize: 1,
        textDetLimitSideLen: 960, textDetLimitType: 'max', textDetMaxSideLimit: 1536,
      });
      initializationMs = performance.now() - started;
      env.wasm.wasmBinary = undefined;
    }
    image = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const lines: OcrLine[] = [];
    const barcodes: NonNullable<OcrResult['barcodes']> = [];
    let barcodeScan: OcrResult['barcodeScan'] = 'complete';
    const step = 1344, tileHeight = 1536;
    const tiles = Math.max(1, Math.ceil(Math.max(0, image.height - tileHeight) / step) + 1);
    const started = performance.now();
    for (let tile = 0; tile < tiles; tile++) {
      worker.postMessage({ id, progress: { phase: 'recognizing', current: tile, total: tiles } });
      const y = tile * step, height = Math.min(tileHeight, image.height - y);
      const scale = Math.min(1, 1280 / image.width);
      const canvas = new OffscreenCanvas(Math.round(image.width * scale), Math.round(height * scale));
      canvas.getContext('2d')!.drawImage(image, 0, y, image.width, height, 0, 0, canvas.width, canvas.height);
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const mat = cv.matFromImageData(pixels);
      let result;
      try { [result] = await engine.predict(mat); }
      finally { mat.delete(); }
      for (const [index, line] of (result?.items ?? []).entries()) lines.push({ id: `${tile}:${index}`, text: line.text, score: line.score,
        poly: line.poly.map(([x, at]) => [x / scale, at / scale + y]) });
      try {
        const detected = await readBarcodes(pixels, { tryHarder: true, tryRotate: true, tryInvert: true, returnErrors: true, maxNumberOfSymbols: 64 });
        for (const code of detected) barcodes.push({ poly: [code.position.topLeft, code.position.topRight, code.position.bottomRight, code.position.bottomLeft].map(({ x, y: at }) => [x / scale, at / scale + y]) });
        if (detected.length >= 64) barcodeScan = 'unavailable';
      } catch { barcodeScan = 'unavailable'; }
      canvas.width = 1; canvas.height = 1;
    }
    const result: OcrResult = { lines: mergeOcrLines(lines), width: image.width, height: image.height, initializationMs,
      recognitionMs: performance.now() - started, tileCount: tiles, barcodes, barcodeScan };
    worker.postMessage({ id, result });
  } catch {
    // Do not forward source text, file names, data URLs, or third-party error payloads.
    worker.postMessage({ id, error: 'OCR_FAILED' });
  } finally { image?.close(); running = false; }
};
