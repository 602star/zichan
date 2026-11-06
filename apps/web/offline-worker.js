/* Public application resources only. Account APIs and user files never enter Cache Storage. */
const scope = self.registration.scope;
const prefix = `zichan-shell:${new URL(scope).pathname}:`;
const cacheName = `${prefix}__VERSION__`;
const urls = __ASSETS__.map((name) => new URL(name, scope).href);
const assets = new Set(urls);
const shell = new URL('index.html', scope).href;
const assetPath = new URL('assets/', scope).pathname;
// The old /app/ entry now redirects to this scope's root. A cached root index
// must not intercept that navigation or resolve old assets below /app/assets/*.
const nestedAppPath = new URL('app', scope).pathname;
async function supportsInPlaceUpdate(worker) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, 500);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(event.data === true);
    };
    try {
      worker.postMessage({ type: 'ZICHAN_UPDATE_PROTOCOL' }, [channel.port2]);
    } catch {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(false);
    }
  });
}
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(urls.map((url) => new Request(url, { cache: 'reload', credentials: 'omit' })));
    // The old worker has no update button. Activate this migration release so
    // those pages can get the new UI with one ordinary refresh.
    if (self.registration.active && !(await supportsInPlaceUpdate(self.registration.active))) await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
async function clientVersion(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => { channel.port1.close(); resolve(null); }, 1000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(typeof event.data === 'string' ? event.data : null);
    };
    try {
      client.postMessage({ type: 'ZICHAN_SHELL_VERSION_REQUEST' }, [channel.port2]);
    } catch {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(null);
    }
  });
}
async function pruneUnusedCaches() {
  // The active worker must never delete a release being installed or waiting.
  if (self.registration.installing || self.registration.waiting) return;
  const candidates = (await caches.keys()).filter((key) => key.startsWith(prefix) && key !== cacheName);
  const clients = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .filter((client) => client.url.startsWith(scope));
  const versions = await Promise.all(clients.map(clientVersion));
  // An older page may not understand the version request. Keep its resources.
  if (versions.some((version) => !version) || self.registration.installing || self.registration.waiting) return;
  const needed = new Set([cacheName, ...versions.map((version) => `${prefix}${version}`)]);
  for (const key of candidates) if (!needed.has(key)) await caches.delete(key);
}
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ZICHAN_UPDATE_PROTOCOL') {
    event.ports[0]?.postMessage(true);
  } else if (event.data?.type === 'ZICHAN_SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  } else if (event.data?.type === 'ZICHAN_PRUNE_CACHES') {
    event.waitUntil(pruneUnusedCaches());
  }
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== new URL(scope).origin || /\/(api|admin)(\/|$)/.test(url.pathname)) return;
  if (request.mode === 'navigate' && (url.pathname === nestedAppPath || url.pathname.startsWith(`${nestedAppPath}/`))) return;
  if (request.mode === 'navigate' && request.url.startsWith(scope)) {
    event.respondWith((async () => (await (await caches.open(cacheName)).match(shell)) || fetch(request))());
  } else if (assets.has(request.url)) {
    event.respondWith((async () => (await (await caches.open(cacheName)).match(request)) || fetch(request))());
  } else if (url.pathname.startsWith(assetPath)) {
    event.respondWith((async () => {
      for (const key of await caches.keys()) {
        if (!key.startsWith(prefix) || key === cacheName) continue;
        const cached = await (await caches.open(key)).match(request);
        if (cached) return cached;
      }
      return fetch(request);
    })());
  }
});
