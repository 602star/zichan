import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const counts = (process.argv[2] ?? '1000,10000,50000').split(',').map(Number);
if (counts.some((count) => !Number.isSafeInteger(count) || count < 1)) throw new Error('Counts must be positive integers');

const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('No benchmark port'));
    server.close(() => resolvePort(address.port));
  });
});
const base = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: resolve(root, 'apps/web'),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
vite.stdout.on('data', (chunk) => { output += chunk.toString(); });
vite.stderr.on('data', (chunk) => { output += chunk.toString(); });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early: ${output}`);
    try {
      const response = await fetch(`${base}/bench/scale.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the local benchmark server. */ }
    await delay(100);
  }
  if (!ready) throw new Error(`Vite did not start: ${output}`);
  const installedChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const installedEdge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
    || (existsSync(installedChrome) ? installedChrome : undefined)
    || (existsSync(installedEdge) ? installedEdge : undefined);
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
  });
  const page = await browser.newPage();
  await page.goto(`${base}/bench/scale.html`);
  const results = await page.evaluate(async (sizes) => {
    const benchmark = await import('/bench/browser-ledger-scale.ts');
    return benchmark.runBrowserLedgerScale(sizes);
  }, counts);
  console.log(JSON.stringify({ browser: await browser.version(), counts, results }, null, 2));
} finally {
  try {
    await browser?.close();
  } finally {
    vite.kill();
  }
}
