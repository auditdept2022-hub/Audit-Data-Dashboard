// Simple offline-first service worker for the Audit Data Dashboard PWA.
// Bump CACHE_NAME any time you update any cached file so old clients refresh.
const CACHE_NAME = 'audit-dashboard-cache-v13';

const PRECACHE_URLS = [
  './',
  './index.html',
  './Opex.html',
  './attendance_dashboard_v35.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Stale-while-revalidate for navigations: show the cached page instantly
// (so the app opens immediately instead of blocking on a ~1MB download
// every launch), then silently fetch a fresh copy in the background and
// update the cache for next time. Cache-first for everything else.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const reqUrl = new URL(request.url);

  // Never cache Apps Script API calls (?action=list, ?action=opexActualTotal,
  // getRecord, budgetLimits, etc.). These carry live data from the Sheet --
  // caching them defeats the app's own fresh=1 cache-busting and, worse, a
  // cached entry never expires on its own, so the SAME stale response (a
  // row that's since been deleted, an old total) could be replayed forever
  // without ever touching the network again. Go network-first, and only
  // fall back to whatever's cached if there's genuinely no connection.
  if (reqUrl.searchParams.has('action') || reqUrl.origin !== self.location.origin) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            return response;
          })
          .catch(() => cached || caches.match('./index.html'));

        // Serve cached immediately if we have it; otherwise wait on network.
        return cached || networkFetch;
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});
