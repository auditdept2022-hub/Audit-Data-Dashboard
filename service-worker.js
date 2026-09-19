// service-worker.js — Audit Data Dashboard
// Bump CACHE_VERSION any time you change what gets precached, so old
// clients pick up the new files instead of serving stale ones forever.
const CACHE_VERSION = 'audit-dashboard-v4'; // bumped: install is now
                                             // resilient to a single failed
                                             // asset (see the 'install'
                                             // handler below) instead of
                                             // failing the whole precache --
                                             // this matters most on mobile,
                                             // where a flaky connection is
                                             // far more likely to drop one
                                             // request out of five than on
                                             // a stable desktop connection.
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
//
// FIX (mobile reliability): this used to be a single Promise.all() over
// every APP_SHELL entry via cache.addAll()-style behavior -- if ANY one
// request failed (a dropped packet on a cellular connection, a slow icon
// fetch that timed out, a transient 5xx), the whole Promise.all() rejected,
// which failed the 'install' event outright. A failed install means the
// new service worker is discarded entirely: it never reaches 'activate',
// self.skipWaiting() never runs, and the OLD (possibly buggy/stale) worker
// stays in control indefinitely -- the browser will keep retrying the
// install in the background, but on a flaky mobile network that can fail
// the same way every time. This is a textbook cause of "phone is stuck /
// needs a bunch of refreshes to catch up" that doesn't show up on a
// stable desktop connection, since desktop rarely drops any of these five
// small requests.
//
// FIX: cache each APP_SHELL url independently and never let one failure
// sink the others. index.html is the one file the app cannot run without,
// so its failure DOES still fail the install (there's nothing useful to
// serve offline without it). Everything else (manifest, icons) is
// best-effort -- losing them only means a missing icon or a slightly
// broken "Add to Home Screen" prompt until the next successful install,
// never a stuck/broken dashboard.
const APP_SHELL_CRITICAL = ['./', './index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          APP_SHELL.map((url) => {
            // { cache: 'reload' } forces each of these requests to
            // actually hit the network, bypassing the browser's own HTTP
            // cache, so the app shell we precache is always the real
            // current version (not a stale one the browser happened to
            // have cached already).
            const req = new Request(url, { cache: 'reload' });
            const isCritical = APP_SHELL_CRITICAL.indexOf(url) !== -1;
            return cache.add(req).catch((err) => {
              if (isCritical) throw err; // still fails the install -- nothing to serve without this
              // Non-critical (manifest/icons): log and move on. A later
              // install attempt (next deploy, or the browser's own retry)
              // will pick it up; it never blocks the shell from working.
              console.warn('[service-worker] install: could not precache ' + url + ' (non-fatal):', err);
              return null;
            });
          })
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
