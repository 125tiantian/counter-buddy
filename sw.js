/* Simple offline cache for Counter Buddy Web */
const CACHE_VERSION = 'v1.0.20';
const CACHE_NAME = `counter-buddy-web-${CACHE_VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of ASSETS) {
      try { await cache.add(url); } catch (e) { /* ignore missing */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  const clean = async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    try {
      if (self.registration && self.registration.navigationPreload && typeof self.registration.navigationPreload.enable === 'function') {
        await self.registration.navigationPreload.enable();
      }
    } catch {}
  };
  event.waitUntil(clean().then(() => self.clients.claim()));
});

// Allow the page to ask SW to skip waiting or clear caches (for manual refresh)
self.addEventListener('message', (event) => {
  const data = event && event.data;
  if (!data) return;
  if (data.type === 'SKIP_WAITING') {
    try { self.skipWaiting(); } catch {}
  } else if (data.type === 'CLEAR_CACHES') {
    event.waitUntil((async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {}
    })());
  }
});

// Helper strategies
const putInCache = async (req, res) => {
  try { const cache = await caches.open(CACHE_NAME); await cache.put(req, res.clone()); } catch {}
  return res;
};

const networkFirst = async (req, fallback, timeoutMs = 0) => {
  const fetchWithTimeout = async () => {
    if (!timeoutMs) return fetch(req);
    if (typeof AbortController === 'undefined') return fetch(req);
    const ctrl = new AbortController();
    const t = setTimeout(() => { try { ctrl.abort('timeout'); } catch {} }, timeoutMs);
    try { return await fetch(req, { signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  };
  try {
    const res = await fetchWithTimeout();
    return await putInCache(req, res);
  } catch {
    return (await caches.match(req)) || (fallback && (await caches.match(fallback)));
  }
};

const staleWhileRevalidate = async (req) => {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then((res) => putInCache(req, res)).catch(() => null);
  return cached || (await networkPromise) || fetch(req);
};

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const dest = req.destination;
  // Documents: always network-first with fallback to cached index
  if (dest === 'document') {
    event.respondWith((async () => {
      try {
        const pre = await event.preloadResponse; // nav preload often faster
        if (pre) return pre;
      } catch {}
      // Show cached shell immediately to avoid startup black screen
      try {
        const cache = await caches.open(CACHE_NAME);
        const cachedIndex = await cache.match('./index.html');
        if (cachedIndex) {
          // Revalidate in background
          event.waitUntil(fetch(req).then((res) => putInCache(req, res)).catch(() => {}));
          return cachedIndex;
        }
      } catch {}
      // Fallback to a short network-first with index.html as offline fallback
      return networkFirst(req, './index.html', 350);
    })());
    return;
  }
  // Critical assets: prefer stale-while-revalidate for instant startup; SW updates in background
  if (dest === 'script' || dest === 'style' || dest === 'worker' || dest === 'manifest' || dest === '') {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  // Others (images, fonts): stale-while-revalidate
  event.respondWith(staleWhileRevalidate(req));
});
