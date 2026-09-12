/* Public application resources only. Account APIs and user files never enter Cache Storage. */
const scope = self.registration.scope;
const prefix = `zichan-shell:${new URL(scope).pathname}:`;
const cacheName = `${prefix}__VERSION__`;
const urls = __ASSETS__.map((name) => new URL(name, scope).href);
const assets = new Set(urls);
const shell = new URL('index.html', scope).href;
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(urls.map((url) => new Request(url, { cache: 'reload', credentials: 'omit' })));
    // No skipWaiting: old tabs retain their matching bundle until all are closed.
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== new URL(scope).origin || /\/(api|admin)(\/|$)/.test(url.pathname)) return;
  if (request.mode === 'navigate' && request.url.startsWith(scope)) {
    event.respondWith((async () => (await (await caches.open(cacheName)).match(shell)) || fetch(request))());
  } else if (assets.has(request.url)) {
    event.respondWith((async () => (await (await caches.open(cacheName)).match(request)) || fetch(request))());
  }
});
