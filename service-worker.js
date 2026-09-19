// service-worker.js — Audit Data Dashboard
// Bump CACHE_VERSION any time you change what gets precached, so old
// clients pick up the new files instead of serving stale ones forever.
const CACHE_VERSION = 'audit-dashboard-v3'; // bumped: navigation handling
                                             // changed (network-first ->
                                             // stale-while-revalidate) --
                                             // see the fetch handler below.
                                             // Not strictly required for
                                             // the browser to notice this
                                             // file changed (it diffs the
                                             // script bytes on its own),
                                             // but keeping this in sync
                                             // with what actually changed
                                             // is the whole point of the
                                             // convention -- see the note
                                             // at the top of this file.
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
  // SPEED FIX (phone): this used to be network-first with { cache:
  // 'no-store' } -- meaning EVERY navigation, not just the first, forced
  // a full network round trip for the entire index.html (1.3MB) before
  // showing anything, with the cached copy only used if that request
  // failed outright. On a fast, low-latency connection that's mostly
  // hidden; on mobile data it's a real, direct, every-single-visit delay.
  //
  // Now: stale-while-revalidate. If we already have a cached shell,
  // serve it INSTANTLY (no network wait at all) and refresh the cache in
  // the background for next time. A brand-new visitor with nothing
  // cached yet still falls through to a real network fetch (nothing to
  // serve instantly), so first-ever load behaves the same as before.
  //
  // This does NOT reintroduce a "stuck on an old version" risk: real
  // dashboard data was never served from this cache to begin with (see
  // the script.google.com branch above -- always live), and code/shell
  // updates are already handled by the reg.update() check + the
  // controllerchange -> window.location.reload() in index.html, which
  // force a refresh onto the new version as soon as it's actually ready
  // -- independently of whether this fetch handler is network-first or
  // cache-first for any single request.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match('./index.html').then((cached) => {
          const updateCache = fetch(request, { cache: 'no-store' })
            .then((response) => {
              if (response && response.ok) {
                cache.put('./index.html', response.clone());
              }
              return response;
            });

          if (cached) {
            // Don't make this navigation wait on the network at all --
            // just keep the service worker alive long enough for the
            // background refresh to finish and land in the cache.
            event.waitUntil(updateCache.catch(() => {}));
            return cached;
          }

          // Nothing cached yet (first visit, or the cache was cleared) --
          // there's nothing to serve instantly, so this one request still
          // has to wait on the network, same as before, with the same
          // offline fallback if that fails outright.
          return updateCache.catch(() => caches.match('./index.html'));
        })
      )
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
