import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { test, expect } from '@playwright/test';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';

test('legacy /app/ entry redirects to the root even with a cached root shell', async ({ page }) => {
  const temporary = mkdtempSync(join(tmpdir(), 'zichan-root-worker-'));
  const webDir = join(temporary, 'web');
  cpSync(resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'), webDir, { recursive: true });
  const server = createSyncServer({ webDir, enableWeb: true });
  try {
    await server.ready;
    await listenOnSafePort(server.server, '127.0.0.1');
    const origin = `http://127.0.0.1:${server.server.address().port}`;
    await page.goto(`${origin}/`);
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await page.evaluate(async () => {
      const current = (await caches.keys()).find((name) => name.startsWith('zichan-shell:/:'));
      if (!current) throw new Error('root shell cache missing');
      const oldShell = '<!doctype html><div id="root"></div><script type="module" src="./assets/legacy-only.js"></script>';
      await (await caches.open(current)).put(new URL('/index.html', location.origin),
        new Response(oldShell, { headers: { 'Content-Type': 'text/html' } }));
      await (await caches.open('zichan-shell:/:legacy')).put(new URL('/assets/legacy-only.js', location.origin),
        new Response("document.getElementById('root').textContent='old root works';",
          { headers: { 'Content-Type': 'text/javascript' } }));
    });
    await page.reload();
    await expect(page.locator('#root')).toHaveText('old root works');
    await page.goto(`${origin}/app/`);
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.locator('#root')).toHaveText('old root works');
  } finally {
    await closeTestSyncServer(server);
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('opening the root unregisters an old /app/ worker', async ({ page }) => {
  const temporary = mkdtempSync(join(tmpdir(), 'zichan-app-worker-'));
  const webDir = join(temporary, 'web');
  cpSync(resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'), webDir, { recursive: true });
  writeFileSync(join(webDir, 'legacy-sw.js'), `
    self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', (event) => {
      if (event.request.mode === 'navigate') event.respondWith(new Response('<div id="root">old app</div>',
        { headers: { 'Content-Type': 'text/html' } }));
    });
  `);
  const server = createSyncServer({ webDir, enableWeb: true });
  try {
    await server.ready;
    await listenOnSafePort(server.server, '127.0.0.1');
    const origin = `http://127.0.0.1:${server.server.address().port}`;
    await page.goto(`${origin}/`);
    await page.evaluate(async () => { await navigator.serviceWorker.register('/legacy-sw.js', { scope: '/app/' }); });
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations())
      .some((registration) => registration.scope.endsWith('/app/') && registration.active?.state === 'activated'))).toBe(true);
    await page.reload();
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations())
      .some((registration) => registration.scope.endsWith('/app/')))).toBe(false);
    await page.goto(`${origin}/app/`);
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.getByRole('heading', { name: '账号登录' })).toBeVisible();
  } finally {
    await closeTestSyncServer(server);
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('update one page while another keeps its old shell, then remove unused caches', async ({ page, context }) => {
  const temporary = mkdtempSync(join(tmpdir(), 'zichan-update-'));
  const webDir = join(temporary, 'web');
  cpSync(resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'), webDir, { recursive: true });
  const server = createSyncServer({ webDir, enableWeb: true, basePath: '/ledger' });
  try {
    await server.ready;
    await listenOnSafePort(server.server, '127.0.0.1');
    const url = `http://127.0.0.1:${server.server.address().port}/ledger/`;
    await page.goto(url);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    const originalVersion = await page.locator('meta[name="zichan-shell-version"]').getAttribute('content');
    const previousTitle = await page.title();
    await page.evaluate(() => localStorage.setItem('update-test-marker', 'keep'));
    await page.evaluate(async () => {
      const key = (await caches.keys()).find((value) => value.startsWith('zichan-shell:/ledger/:'));
      await (await caches.open(key)).put(new URL('assets/old-only.js', location.href), new Response('old bundle'));
    });

    const second = await context.newPage();
    await second.goto(url);
    await second.evaluate(async () => { await navigator.serviceWorker.ready; });

    const workerFile = join(webDir, 'sw.js');
    writeFileSync(workerFile, readFileSync(workerFile, 'utf8').replace(/const cacheName = .*;/, 'const cacheName = `${prefix}acceptance-update`;'));
    const htmlFile = join(webDir, 'index.html');
    writeFileSync(htmlFile, readFileSync(htmlFile, 'utf8')
      .replace(/<title>.*?<\/title>/, '<title>Lifecycle updated release</title>')
      .replace(`content="${originalVersion}"`, 'content="acceptance-update"'));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
    await expect(page.getByRole('button', { name: '更新此页' })).toBeVisible();
    await page.getByRole('button', { name: '更新此页' }).click();

    await expect(page).toHaveTitle('Lifecycle updated release');
    expect(await page.evaluate(() => localStorage.getItem('update-test-marker'))).toBe('keep');
    await expect(second).toHaveTitle(previousTitle);
    await expect(second.getByRole('button', { name: '刷新此页' })).toBeVisible();
    expect(await second.evaluate(async () => (await fetch('assets/old-only.js')).text())).toBe('old bundle');
    const retained = await page.evaluate(() => caches.keys());
    expect(retained).toContain(`zichan-shell:/ledger/:${originalVersion}`);
    expect(retained).toContain('zichan-shell:/ledger/:acceptance-update');

    await second.getByRole('button', { name: '刷新此页' }).click();
    await expect(second).toHaveTitle('Lifecycle updated release');
    await expect.poll(() => page.evaluate(() => caches.keys())).toEqual(['zichan-shell:/ledger/:acceptance-update']);
  } finally {
    await context.close();
    await closeTestSyncServer(server);
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('a legacy worker can migrate without closing every tab', async ({ page, context }) => {
  const temporary = mkdtempSync(join(tmpdir(), 'zichan-legacy-update-'));
  const webDir = join(temporary, 'web');
  cpSync(resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'), webDir, { recursive: true });
  const workerFile = join(webDir, 'sw.js');
  const upgradedWorker = readFileSync(workerFile, 'utf8');
  writeFileSync(workerFile, `
    const cacheName = 'zichan-shell:/ledger/:legacy';
    const shell = new URL('index.html', self.registration.scope).href;
    self.addEventListener('install', (event) => event.waitUntil(caches.open(cacheName).then((cache) => cache.add(shell))));
    self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', (event) => {
      if (event.request.mode === 'navigate') event.respondWith(caches.open(cacheName).then((cache) => cache.match(shell)));
    });
  `);
  const server = createSyncServer({ webDir, enableWeb: true, basePath: '/ledger' });
  try {
    await server.ready;
    await listenOnSafePort(server.server, '127.0.0.1');
    const url = `http://127.0.0.1:${server.server.address().port}/ledger/`;
    await page.goto(url);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    const previousTitle = await page.title();
    const htmlFile = join(webDir, 'index.html');
    writeFileSync(htmlFile, readFileSync(htmlFile, 'utf8').replace(/<title>.*?<\/title>/, '<title>Migrated release</title>'));
    writeFileSync(workerFile, upgradedWorker);
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
    await expect(page.getByRole('button', { name: '刷新此页' })).toBeVisible();
    await expect(page).toHaveTitle(previousTitle);
    await page.getByRole('button', { name: '刷新此页' }).click();
    await expect(page).toHaveTitle('Migrated release');
  } finally {
    await context.close();
    await closeTestSyncServer(server);
    rmSync(temporary, { recursive: true, force: true });
  }
});
