// service-worker.js — Audit Data Dashboard
// Bump CACHE_VERSION any time you change what gets precached, so old
// clients pick up the new files instead of serving stale ones forever.
const CACHE_VERSION = 'audit-dashboard-v2'; // bumped: forces every existing
                                             // client to install this fixed
                                             // worker instead of reusing v1
const CACHE_NAME = CACHE_VERSION;

// The app shell: the minimum set of files needed to render the dashboard
// UI while offline or on a flaky connection. Keep this list in sync with
// whatever static files index.html actually references.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// ---- Install: precache the app shell ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        // FIX: cache.addAll(APP_SHELL) previously let the browser's own
        // HTTP cache answer these fetches, so a freshly-installed service
        // worker could still precache an OLD copy of index.html if the
        // browser had one cached. { cache: 'reload' } forces each of
        // these requests to actually hit the network, bypassing HTTP
        // cache, so the app shell we precache is always the real current
        // version.
        Promise.all(
          APP_SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))
        )
      )
      .then(() => self.skipWaiting())
  );
});

// ---- Activate: clean up old cache versions ----
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

// ---- Fetch: serve smartly depending on what's being requested ----
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests; let POST/PUT/etc. (e.g. Apps Script writes)
  // go straight to the network untouched.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Live dashboard data and Quick Link calls go through Google Apps
  // Script. Never cache these — always hit the network so the numbers
  // on screen are current. If it fails, there's nothing sane to fall
  // back to, so just let the request fail normally.
  if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') {
    return;
  }

  // Cross-origin CDN assets (Tailwind, fonts, icon libraries, etc.):
  // stale-while-revalidate. Serve the cached version instantly if we
  // have one, and refresh the cache in the background for next time.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request)
            .then((response) => {
              if (response && response.ok) cache.put(request, response.clone());
              return response;
            })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // Same-origin navigation (loading the dashboard page itself):
  // network-first, so users get the latest deployed version when
  // online, with an offline fallback to the last cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      // FIX: plain fetch(request) could still be quietly answered by the
      // browser's own HTTP cache (separate from this Cache Storage API),
      // which defeats "network-first" — a login could run on a stale
      // cached build of index.html even though this code correctly asked
      // for the network. { cache: 'no-store' } forces a real round trip
      // to the server every time this branch runs.
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          // FIX: only cache genuinely good responses. Previously any
          // response (including a transient 404/500 from the host) got
          // written over the last good cached copy, so a brief server
          // hiccup could permanently poison the offline fallback.
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Same-origin static assets (icons, manifest, etc.): cache-first,
  // since these rarely change and don't need a network round trip.
  event.respondWith(
    caches.match(request).then((cached) =>
      cached ||
      fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
    )
  );
});
