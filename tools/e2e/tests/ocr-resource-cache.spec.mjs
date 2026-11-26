import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { listenOnSafePort } from '../safe-listen.mjs';

test('revalidation escapes an immutable cached OCR manifest after deployment replaces its worker', async ({ page }) => {
  let version = 'old', requests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/ocr/manifest.json') {
      requests++;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(JSON.stringify({ version, worker: `ocr-worker-${version}.js` }));
    } else { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end('<title>Public resource cache fixture</title>'); }
  });
  try {
    await listenOnSafePort(server, '127.0.0.1');
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const read = (cache) => page.evaluate(async (cache) => (await fetch('/ocr/manifest.json', { cache })).json(), cache);
    expect((await read('default')).version).toBe('old');
    version = 'new';
    expect((await read('default')).version).toBe('old');
    expect(requests).toBe(1);
    expect((await read('no-cache')).version).toBe('new');
    expect(requests).toBe(2);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
