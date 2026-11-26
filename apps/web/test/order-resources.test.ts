import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { clearOcrResourceCache, prepareOcrResources } from '../src/order-capture/resources.js';

afterEach(async () => { await clearOcrResourceCache().catch(() => undefined); vi.unstubAllGlobals(); });
const files = ['PP-OCRv5_mobile_det_onnx_infer.tar', 'PP-OCRv5_mobile_rec_onnx_infer.tar', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
function setup() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (key: string) => {
    if (!stores.has(key)) stores.set(key, new Map());
    const rows = stores.get(key)!;
    return { match: async (url: string) => rows.get(url)?.clone(), put: async (url: string, response: Response) => { rows.set(url, new Response(await response.arrayBuffer(), { headers: response.headers })); } };
  };
  vi.stubGlobal('document', { baseURI: 'https://local.example/' });
  vi.stubGlobal('caches', { open, keys: async () => [...stores.keys()], delete: async (key: string) => stores.delete(key) });
  const manifest = { version: 'new', resources: files.map((file) => ({ file: `ocr/${file}`, bytes: 6, sha256: createHash('sha256').update('public').digest('hex') })) };
  const fetcher = vi.fn(async (url: URL | string) => String(url).endsWith('.json') ? Response.json(manifest) : new Response('public'));
  vi.stubGlobal('fetch', fetcher);
  return { stores, open, manifest, fetcher };
}
describe('public OCR resource cache', () => {
  it('revalidates the unversioned manifest to avoid cached references to a deleted build worker', async () => {
    const { fetcher, manifest } = setup();
    fetcher.mockImplementation(async (url, init?: RequestInit) => {
      if (String(url).endsWith('.json')) return Response.json(init?.cache === 'no-cache' ? manifest : { ...manifest, resources: [...manifest.resources, { file: 'assets/ocr-worker-deleted.js', bytes: 6, sha256: manifest.resources[0]!.sha256 }] });
      return String(url).includes('deleted') ? new Response(null, { status: 404 }) : new Response('public');
    });
    await expect(prepareOcrResources(new AbortController().signal, () => undefined)).resolves.toMatchObject({ storage: 'persistent' });
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ cache: 'no-cache', credentials: 'omit' }));
  });
  it('identifies a missing public file and gives an update recovery instead of blaming connectivity', async () => {
    const { fetcher, manifest } = setup();
    fetcher.mockImplementation(async (url) => String(url).endsWith('.json') ? Response.json(manifest) : new Response(null, { status: 404 }));
    await expect(prepareOcrResources(new AbortController().signal, () => undefined)).rejects.toThrow(`识别资源缺失（ocr/${files[0]}，HTTP 404）`);
  });
  it('uses and clears verified session resources on insecure HTTP without CacheStorage', async () => {
    const { fetcher } = setup(); vi.stubGlobal('isSecureContext', false); vi.stubGlobal('caches', undefined);
    const progress = vi.fn();
    const prepared = await prepareOcrResources(new AbortController().signal, progress);
    expect(prepared.storage).toBe('session'); expect(prepared.assets.map((asset) => asset.file)).toEqual(files);
    expect(await prepared.assets[0]!.blob.text()).toBe('public');
    expect(progress.mock.lastCall?.[0]).toMatchObject({ storage: 'session', current: 24, total: 24 });
    expect(fetcher).toHaveBeenCalledTimes(5);
    await prepareOcrResources(new AbortController().signal, () => undefined);
    expect(fetcher).toHaveBeenCalledTimes(6);
    await clearOcrResourceCache();
    await prepareOcrResources(new AbortController().signal, () => undefined);
    expect(fetcher).toHaveBeenCalledTimes(11);
  });
  it('allows a secure browser without a cache interface', async () => {
    setup(); vi.stubGlobal('isSecureContext', true); vi.stubGlobal('caches', undefined);
    expect((await prepareOcrResources(new AbortController().signal, () => undefined)).storage).toBe('session');
  });
  it('falls back on cache access denial without forwarding a browser error payload', async () => {
    setup(); vi.stubGlobal('caches', { open: async () => { throw new DOMException('private browser error', 'SecurityError'); } });
    expect((await prepareOcrResources(new AbortController().signal, () => undefined)).storage).toBe('session');
  });
  it('continues in memory when opening a cache exceeds quota', async () => {
    setup(); vi.stubGlobal('caches', { open: async () => { throw new DOMException('full', 'QuotaExceededError'); } });
    expect((await prepareOcrResources(new AbortController().signal, () => undefined)).storage).toBe('session');
  });
  it('retains verified assets when cache writes exceed quota', async () => {
    const { open, fetcher } = setup(); const cache = await open('zichan-ocr:/:new');
    const put = vi.fn(cache.put).mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    vi.stubGlobal('caches', { open: async () => ({ ...cache, put }), keys: async () => [] });
    expect((await prepareOcrResources(new AbortController().signal, () => undefined)).assets).toHaveLength(4);
    expect(put).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(5);
    vi.stubGlobal('caches', undefined);
    await prepareOcrResources(new AbortController().signal, () => undefined);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it('continues when reading the cache is denied', async () => {
    setup(); vi.stubGlobal('caches', { open: async () => ({ match: async () => { throw new DOMException('denied', 'SecurityError'); } }) });
    expect((await prepareOcrResources(new AbortController().signal, () => undefined)).storage).toBe('session');
  });
  it('still rejects substituted downloads without persistent caching', async () => {
    const { fetcher, manifest } = setup(); vi.stubGlobal('caches', undefined);
    fetcher.mockImplementation(async (url) => String(url).endsWith('.json') ? Response.json(manifest) : new Response('broken'));
    await expect(prepareOcrResources(new AbortController().signal, () => undefined)).rejects.toThrow('校验失败');
  });
  it('reuses verified resources across versions without downloading or cloning consumed responses', async () => {
    const { open, fetcher } = setup();
    const old = await open('zichan-ocr:/:old');
    for (const file of files) await old.put(`https://local.example/ocr/${file}`, new Response('public'));
    await prepareOcrResources(new AbortController().signal, () => undefined);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const current = await open('zichan-ocr:/:new');
    expect(await (await current.match(`https://local.example/ocr/${files[0]}`))?.text()).toBe('public');
  });
  it('replaces corrupted cache entries only after checking downloaded bytes', async () => {
    const { open, fetcher } = setup();
    const current = await open('zichan-ocr:/:new');
    for (const file of files) await current.put(`https://local.example/ocr/${file}`, new Response('broken'));
    await prepareOcrResources(new AbortController().signal, () => undefined);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(await (await current.match(`https://local.example/ocr/${files[0]}`))?.text()).toBe('public');
  });
  it('rejects a substituted download and keeps it out of the public cache', async () => {
    const { fetcher, stores } = setup();
    fetcher.mockImplementation(async (url) => String(url).endsWith('.json') ? Response.json({ version: 'new', resources: files.map((file) => ({ file: `ocr/${file}`, bytes: 6, sha256: 'a'.repeat(64) })) }) : new Response('public'));
    await expect(prepareOcrResources(new AbortController().signal, () => undefined)).rejects.toThrow('校验失败');
    expect(stores.get('zichan-ocr:/:new')?.size).toBe(0);
  });
  it('cleans only this deployment’s OCR caches', async () => {
    const { stores, open } = setup();
    await open('zichan-ocr:/:old'); await open('zichan-shell:v1'); await open('zichan-ocr:/other/:v1');
    await clearOcrResourceCache();
    expect([...stores.keys()]).toEqual(['zichan-shell:v1', 'zichan-ocr:/other/:v1']);
  });
});
