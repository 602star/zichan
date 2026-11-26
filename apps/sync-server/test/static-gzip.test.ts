import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createTestSyncServer } from './support/server-fixture.js';

describe('v1 update package compressed Web resources', () => {
  it('serves the original URL with its MIME, cache and CSP, and handles gzip rejection and corruption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-web-gzip-'));
    mkdirSync(join(root, 'assets')); mkdirSync(join(root, 'ocr'));
    writeFileSync(join(root, 'index.html'), '<title>fixture</title>');
    const script = 'self.postMessage("public worker");';
    writeFileSync(join(root, 'assets/worker.js.gz'), gzipSync(script));
    writeFileSync(join(root, 'ocr/model.wasm.gz'), gzipSync(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])));
    writeFileSync(join(root, 'ocr/manifest.json.gz'), gzipSync('{}'));
    writeFileSync(join(root, 'assets/broken.js.gz'), 'broken');
    const server = createTestSyncServer({ webDir: root, enableWeb: true, enableSync: false, basePath: '/ledger' });
    await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}/ledger`;
    try {
      for (const encoding of ['gzip, deflate', 'identity', 'gzip;q=0', 'gzip; q=0.000', 'gzip;q=0.5']) {
        const response = await fetch(`${url}/assets/worker.js`, { headers: { 'Accept-Encoding': encoding } });
        expect(response.status).toBe(200); expect(await response.text()).toBe(script);
        expect(response.headers.get('content-type')).toContain('javascript');
        expect(response.headers.get('vary')).toBe('Accept-Encoding');
        expect(response.headers.get('content-encoding')).toBe(encoding === 'gzip, deflate' || encoding === 'gzip;q=0.5' ? 'gzip' : null);
        expect(response.headers.get('cache-control')).toContain('immutable');
        expect(response.headers.get('content-security-policy')).toContain("script-src 'self' 'wasm-unsafe-eval'");
      }
      expect((await fetch(`${url}/ocr/model.wasm`)).headers.get('content-type')).toBe('application/wasm');
      expect((await fetch(`${url}/ocr/manifest.json`)).headers.get('cache-control')).toBe('no-cache');
      expect((await fetch(`${url}/assets/worker.js`, { method: 'HEAD' })).status).toBe(200);
      expect((await fetch(`${url}/assets/missing.js`)).status).toBe(404);
      const corrupt = await fetch(`${url}/assets/broken.js`, { headers: { 'Accept-Encoding': 'identity' } });
      expect(corrupt.status).toBe(500); expect(corrupt.headers.get('cache-control')).toBe('no-store');
    } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
