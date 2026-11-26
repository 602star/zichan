import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('OCR service worker version isolation', () => {
  it('uses the current verified resource cache and bypasses it for revalidation', async () => {
    const handlers: Record<string, (event: unknown) => void> = {};
    const open = vi.fn(async (key: string) => ({ match: async () => new Response(key.endsWith(':new') ? 'new-runtime' : 'old-runtime') }));
    const fetcher = vi.fn(async () => new Response('network-runtime'));
    const source = readFileSync(new URL('../offline-worker.js', import.meta.url), 'utf8')
      .replace('__ASSETS__', '[]').replace('__VERSION__', 'shell').replace('__OCR_VERSION__', 'new')
      .replace('__OCR_ASSETS__', '["ocr/runtime.wasm"]');
    runInNewContext(source, { self: { registration: { scope: 'https://local.example/' }, addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; } }, URL, Set, caches: { open }, fetch: fetcher });
    let response!: Promise<Response>;
    const respondWith = (value: Promise<Response>) => { response = value; };
    handlers.fetch!({ request: new Request('https://local.example/ocr/runtime.wasm'), respondWith });
    expect(await (await response).text()).toBe('new-runtime');
    expect(open).toHaveBeenCalledWith('zichan-ocr:/:new');
    expect(fetcher).not.toHaveBeenCalled();
    handlers.fetch!({ request: new Request('https://local.example/ocr/runtime.wasm', { cache: 'no-cache' }), respondWith });
    expect(await (await response).text()).toBe('network-runtime');
  });
});
