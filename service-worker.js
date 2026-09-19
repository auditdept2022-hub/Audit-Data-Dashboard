// service-worker.js — Audit Data Dashboard
// Bump CACHE_VERSION any time you change what gets precached.
const CACHE_VERSION = 'audit-dashboard-v6';
// v6 (this file): FIXED a navigation bug. The old handler treated EVERY
//  same-origin page navigation as "the dashboard": it answered with the
//  cached ./index.html and, on refresh, overwrote that cache entry with
//  whatever page was requested. index.html links to sibling pages
//  (attendance_dashboard_v35.html, Parts_Request.html, Opex.html, and the
//  manifest shortcuts point at them too), so those pages could show the
//  dashboard instead, and could even replace the cached dashboard with
//  themselves. Only the scope root / index.html use the app-shell logic now;
//  every other page is network-first with its own cache entry as fallback.
//  Also: manifest.json is now stale-while-revalidate (it used to be
//  cache-first, so manifest edits never reached installed users unless
//  CACHE_VERSION was bumped).
// v5 changes (see review):
//  - Navigation refresh now revalidates with ETag ('no-cache') instead of
//    re-downloading the full 1.3MB index.html ('no-store') on every open.
//  - When the background refresh finds a NEWER index.html, every open tab is
//    told via postMessage({type:'APP_UPDATE_AVAILABLE'}) so the page can show
//    a "New version - tap to refresh" prompt. Before this, an index.html-only
//    deploy (this file unchanged) silently showed the old version for one
//    extra visit, because the browser only re-installs the worker when THIS
//    file's bytes change.
//  - Background cache refreshes are kept alive with event.waitUntil() so the
//    browser can't kill the worker before cache.put() lands.
const CACHE_NAME = CACHE_VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
// index.html is the only file the app cannot run without.
const APP_SHELL_CRITICAL = ['./', './index.html'];

// ---- Install ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          APP_SHELL.map((url) => {
            const req = new Request(url, { cache: 'reload' });
            const isCritical = APP_SHELL_CRITICAL.indexOf(url) !== -1;
            return cache.add(req).catch((err) => {
              if (isCritical) throw err;
              console.warn('[service-worker] install: could not precache ' + url + ' (non-fatal):', err);
              return null;
            });
          })
        )
      )
      .then(() => self.skipWaiting())
  );
});

// ---- Activate ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// True only for the dashboard itself: the SW scope root or index.html
// (query strings / hashes ignored). Everything else is a different page.
function isDashboardShellUrl(url) {
  const scopePath = new URL(self.registration.scope).pathname; // e.g. "/repo/" or "/"
  return url.pathname === scopePath || url.pathname === scopePath + 'index.html';
}

// A cheap "version" fingerprint for a response, without reading the body.
function versionOf(res) {
  if (!res) return '';
  return res.headers.get('etag') || res.headers.get('last-modified') || res.headers.get('content-length') || '';
}

function notifyClientsOfUpdate() {
  return self.clients.matchAll({ type: 'window' }).then((clients) => {
    clients.forEach((c) => c.postMessage({ type: 'APP_UPDATE_AVAILABLE' }));
  });
}

// ---- Fetch ----
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Live data: never cache.
  if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') {
    return;
  }

  // Cross-origin CDN assets: stale-while-revalidate.
  // NOTE: only responses with response.ok are cached. A <script>/<link> tag
  // WITHOUT a crossorigin attribute makes a no-cors request whose response is
  // "opaque" (ok === false), so it is never stored here. index.html must add
  // crossorigin="anonymous" to the Tailwind / ApexCharts / Lucide <script>
  // tags and the Google Fonts <link> for offline caching to actually work.
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
          if (cached) {
            event.waitUntil(network.catch(() => {})); // keep worker alive for the refresh
            return cached;
          }
          return network;
        })
      )
    );
    return;
  }

  // Same-origin navigation to a page OTHER than the dashboard (sibling pages
  // such as Opex.html / Parts_Request.html / attendance_dashboard_*.html):
  // network-first, cache that page under its OWN key, never touch index.html.
  if (request.mode === 'navigate' && !isDashboardShellUrl(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) =>
            cached || new Response(
              '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
              '<body style="font-family:system-ui;padding:2rem"><h2>You\'re offline</h2>' +
              '<p>This page hasn\'t been opened online yet, so it isn\'t available offline.</p>' +
              '<p><a href="./">Back to the dashboard</a></p></body>',
              { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            )
          )
        )
    );
    return;
  }

  // Dashboard shell: serve cached shell instantly, revalidate in background.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match('./index.html').then((cached) => {
          // 'no-cache' = revalidate with ETag/Last-Modified. A 304 costs a few
          // hundred bytes instead of re-downloading the whole file.
          const updateCache = fetch(request, { cache: 'no-cache' })
            .then((response) => {
              if (response && response.ok) {
                const changed = cached && versionOf(cached) !== versionOf(response);
                return cache.put('./index.html', response.clone()).then(() => {
                  if (changed) return notifyClientsOfUpdate();
                }).then(() => response);
              }
              return response;
            });

          if (cached) {
            event.waitUntil(updateCache.catch(() => {}));
            return cached;
          }
          return updateCache.catch(() => caches.match('./index.html'));
        })
      )
    );
    return;
  }

  // manifest.json: stale-while-revalidate so edits reach installed users
  // without needing a CACHE_VERSION bump.
  if (url.pathname.endsWith('/manifest.json')) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request, { cache: 'no-cache' })
            .then((response) => {
              if (response && response.ok) cache.put(request, response.clone());
              return response;
            })
            .catch(() => cached);
          if (cached) { event.waitUntil(network.catch(() => {})); return cached; }
          return network;
        })
      )
    );
    return;
  }

  // Same-origin static assets: cache-first.
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
