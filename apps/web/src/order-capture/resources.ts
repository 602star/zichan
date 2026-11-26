import { sha256Bytes } from '@zichan/core';

export interface OcrResource { file: string; bytes: number; sha256: string }
export interface OcrManifest { version: string; resources: OcrResource[] }
export type OcrResourceStorage = 'persistent' | 'session';
export interface OcrProgress { phase: 'resources' | 'initializing' | 'recognizing'; current: number; total: number; storage?: OcrResourceStorage }
export interface OcrMemoryAsset { file: string; blob: Blob }
export interface PreparedOcrResources { storage: OcrResourceStorage; assets: OcrMemoryAsset[] }
const sessionResources = new Map<string, { sha256: string; blob: Blob }>();
let sessionGeneration = 0;
export function ocrBaseUrl(): URL { return new URL(import.meta.env.BASE_URL || './', document.baseURI); }
export function validateOcrManifest(value: unknown): OcrManifest {
  const row = value as { version?: unknown; resources?: unknown } | null;
  if (!row || !['string', 'number'].includes(typeof row.version) || !Array.isArray(row.resources) || row.resources.length < 4 || row.resources.length > 24) throw new Error('识别资源清单无效，请更新应用。');
  const seen = new Set<string>();
  const resources = row.resources.map((item: unknown) => {
    const resource = item as OcrResource;
    if (!resource || typeof resource.file !== 'string' || !/^(?:ocr\/[A-Za-z0-9_.-]+|assets\/(?:ocr-worker-|ort\.)[A-Za-z0-9_.-]+)$/.test(resource.file)
      || resource.file.includes('..') || seen.has(resource.file) || !Number.isSafeInteger(resource.bytes) || resource.bytes <= 0 || resource.bytes > 64 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(resource.sha256)) throw new Error('识别资源清单无效，请更新应用。');
    seen.add(resource.file); return resource;
  });
  if (!seen.has('ocr/PP-OCRv5_mobile_det_onnx_infer.tar') || !seen.has('ocr/PP-OCRv5_mobile_rec_onnx_infer.tar')) throw new Error('识别模型清单不完整。');
  return { version: String(row.version), resources };
}
async function loadManifest(signal?: AbortSignal): Promise<OcrManifest> {
  const response = await fetch(new URL(import.meta.env.DEV ? 'ocr/resources.json' : 'ocr/manifest.json', ocrBaseUrl()), { signal, credentials: 'omit', cache: 'no-cache' });
  if (!response.ok) throw new Error('本机识别资源尚不可用，请更新应用或稍后重试。');
  return validateOcrManifest(await response.json());
}
function cacheName(manifest: OcrManifest) { return `zichan-ocr:${ocrBaseUrl().pathname}:${manifest.version}`; }
const digest = (bytes: ArrayBuffer) => sha256Bytes(new Uint8Array(bytes));
function cacheStorage(): CacheStorage | null { try { return globalThis.caches ?? null; } catch { return null; } }
async function openResourceCache(manifest: OcrManifest): Promise<Cache | null> {
  try { return await cacheStorage()?.open(cacheName(manifest)) ?? null; }
  catch { return null; }
}
export async function clearOcrResourceCache(): Promise<void> {
  sessionGeneration++; sessionResources.clear();
  const storage = cacheStorage(); if (!storage) return;
  const prefix = `zichan-ocr:${ocrBaseUrl().pathname}:`;
  for (const key of await storage.keys()) if (key.startsWith(prefix)) await storage.delete(key);
}
export async function prepareOcrResources(signal: AbortSignal, progress: (value: OcrProgress) => void): Promise<PreparedOcrResources> {
  signal.throwIfAborted();
  const manifest = await loadManifest(signal);
  let cache = await openResourceCache(manifest);
  const generation = sessionGeneration;
  const prepared: { resource: OcrResource; blob: Blob }[] = [];
  const allowed = new Map(manifest.resources.map((row) => [new URL(row.file, ocrBaseUrl()).href, row.sha256]));
  for (const [url, row] of sessionResources) if (allowed.get(url) !== row.sha256) sessionResources.delete(url);
  const total = manifest.resources.reduce((sum, row) => sum + row.bytes, 0);
  let current = 0;
  const report = (received = 0) => progress({ phase: 'resources', current: current + received, total, storage: cache ? 'persistent' : 'session' });
  report();
  for (const resource of manifest.resources) {
    signal.throwIfAborted();
    const url = new URL(resource.file, ocrBaseUrl());
    let stored: Response | undefined, inCurrentCache = false;
    try {
      stored = await cache?.match(url.href); inCurrentCache = !!stored;
      if (!stored && cache) {
        const prefix = `zichan-ocr:${ocrBaseUrl().pathname}:`;
        const storage = cacheStorage();
        for (const key of await storage?.keys() ?? []) {
          if (!key.startsWith(prefix) || key === cacheName(manifest)) continue;
          stored = await (await storage!.open(key)).match(url.href);
          if (stored) break;
        }
      }
    } catch { cache = null; }
    const memory = sessionResources.get(url.href);
    if (!stored && memory?.sha256 === resource.sha256) stored = new Response(memory.blob);
    let needsWrite = !inCurrentCache;
    let bytes = stored ? await stored.arrayBuffer() : null;
    if (!bytes || bytes.byteLength !== resource.bytes || await digest(bytes) !== resource.sha256) {
      needsWrite = true;
      const response = await fetch(url, { signal, credentials: 'omit', cache: 'no-cache', redirect: 'error' });
      if (!response.ok) throw new Error(response.status === 404 || response.status === 410
        ? `识别资源缺失（${resource.file}，HTTP ${response.status}）。应用可能刚更新，请刷新页面后重新提取；若仍失败，请检查服务器资源是否完整。`
        : `识别资源下载失败（${resource.file}，HTTP ${response.status}），请稍后重新提取。`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('浏览器不支持准备识别资源。');
      const chunks: Uint8Array[] = []; let received = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.byteLength;
        if (received > resource.bytes) { await reader.cancel(); throw new Error('识别资源校验失败，请更新应用。'); }
        chunks.push(next.value); report(received);
      }
      const joined = new Uint8Array(received); let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      bytes = joined.buffer;
      if (received !== resource.bytes || await digest(bytes) !== resource.sha256) throw new Error('识别资源校验失败，请更新应用。');
      signal.throwIfAborted();
    }
    const type = resource.file.endsWith('.wasm') ? 'application/wasm' : /\.(?:js|mjs)$/.test(resource.file) ? 'text/javascript' : 'application/octet-stream';
    const blob = new Blob([bytes], { type });
    if (needsWrite || stored?.headers.get('content-type') !== type) {
      try { await cache?.put(url.href, new Response(blob, { headers: { 'Content-Type': type } })); }
      catch { cache = null; }
    }
    prepared.push({ resource, blob }); current += resource.bytes; report();
  }
  signal.throwIfAborted();
  if (!cache && generation === sessionGeneration) for (const { resource, blob } of prepared) sessionResources.set(new URL(resource.file, ocrBaseUrl()).href, { sha256: resource.sha256, blob });
  return { storage: cache ? 'persistent' : 'session', assets: prepared.filter(({ resource }) => resource.file.startsWith('ocr/')).map(({ resource, blob }) => ({ file: resource.file.slice(4), blob })) };
}
