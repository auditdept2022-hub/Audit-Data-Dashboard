// service-worker.js — Audit Data Dashboard
// Bump CACHE_VERSION any time you change what gets precached.
const CACHE_VERSION = 'audit-dashboard-v63'
// v63: pairs with the live-sheet speed patch (Code.gs #22 + index.html): installing this
//  version re-precaches the new index.html at once so phones and desktops pick it up on the
//  next open. No behaviour change in this file.
// v62: pairs with the lean index.html (about 33% smaller, same features). Old per-version
//  changelog (v5-v61) removed to keep this file small, because the browser re-downloads it
//  on every update check. Behaviour is unchanged: app shell is served instantly from the
//  cache and revalidated in the background; backend calls (script.google.com /
//  script.googleusercontent.com) are never touched; pinned CDN files are cache-first;
//  sibling pages are network-first with an 8 s fallback to the saved copy.
const CACHE_NAME = CACHE_VERSION;

const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
// Pinned CDN files fetched once at install so charts work on the very first
// offline/slow open (non-fatal if any of them fails).
const CDN_PRECACHE = [
  'https://cdn.jsdelivr.net/npm/apexcharts@7.6.1/dist/apexcharts.min.js'
];
// Static CDN hosts that are safe to cache (libraries + fonts only).
const CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com'
];
// index.html is the only file the app cannot run without.
const APP_SHELL_CRITICAL = ['./index.html'];

// Race a promise against a timer. Resolves with `fallback()` if it is slower.
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      Promise.resolve().then(fallback).then(resolve, reject);
    }, ms);
    promise.then(
      (v) => { if (settled) return; settled = true; clearTimeout(t); resolve(v); },
      (e) => { if (settled) return; settled = true; clearTimeout(t); reject(e); }
    );
  });
}

// fetch() that is aborted after `ms` (so a hung connection can't hold the worker open).
function fetchWithAbort(input, init, ms) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  const opts = Object.assign({}, init || {}, ctl ? { signal: ctl.signal } : {});
  return fetch(input, opts).finally(() => { if (timer) clearTimeout(timer); });
}

// The ONE canonical URL of the dashboard shell (ignores ?query / #hash the app was opened with).
function shellUrl() {
  return new URL('index.html', self.registration.scope).href;
}

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
          }).concat(CDN_PRECACHE.map((url) =>
            // CORS request, same as the page's <script crossorigin="anonymous">.
            fetch(url, { mode: 'cors', credentials: 'omit' })
              .then((res) => (res && res.ok ? cache.put(url, res) : null))
              .catch(() => null)
          ))
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

// True only when the two responses have different BODY bytes (SHA-256).
// Any error => false, so a hiccup never produces a false "update" prompt.
function bodiesDiffer(a, b) {
  // Cheap checks first: same validator => same file; different size => changed.
  const ea = a.headers.get('etag'), eb = b.headers.get('etag');
  if (ea && eb && ea === eb) return Promise.resolve(false);
  const la = a.headers.get('content-length'), lb = b.headers.get('content-length');
  if (la && lb && !a.headers.get('content-encoding') && !b.headers.get('content-encoding') && la !== lb) return Promise.resolve(true);
  const hash = (res) =>
    res.arrayBuffer()
      .then((buf) => crypto.subtle.digest('SHA-256', buf))
      .then((d) => Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join(''));
  return Promise.all([hash(a), hash(b)])
    .then((h) => h[0] !== h[1])
    .catch(() => false);
}

// True only for URLs whose content cannot change: an EXACT x.y.z version in the
// path (not a range like @7 or @latest), or font binaries. Stylesheets such as
// fonts.googleapis.com/css2 are NOT included (they vary by browser and can change).
function isImmutableCdnUrl(url) {
  const h = url.hostname, p = url.pathname;
  if (h === 'cdn.jsdelivr.net') return /^\/npm\/(@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+\//.test(p);
  if (h === 'cdnjs.cloudflare.com') return /^\/ajax\/libs\/[^/]+\/\d+\.\d+\.\d+\//.test(p);
  if (h === 'www.gstatic.com') return /^\/firebasejs\/\d+\.\d+\.\d+\//.test(p);
  if (h === 'fonts.gstatic.com') return true;
  return false;
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

  // Cross-origin: only static CDN assets are cached. Anything else (weather
  // API, Google Docs/Mail links, etc.) is live and passes through untouched.
  if (url.origin !== self.location.origin && CDN_HOSTS.indexOf(url.hostname) === -1) {
    return;
  }

  // Version-pinned CDN files can never change at the same URL (exact x.y.z in
  // the path, or font binaries), so serve them cache-first and skip the
  // per-load re-fetch + cache.put that stale-while-revalidate does below.
  if (url.origin !== self.location.origin && isImmutableCdnUrl(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          })
        )
      )
    );
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
            .catch(() => cached || Response.error());   // FIX: undefined here made respondWith() throw
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
      // FIX: on a bad connection these pages waited on the network indefinitely even
      // when a saved copy existed. After 8 s the saved copy is used instead.
      withTimeout(
        fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        }),
        8000,
        () => caches.match(request).then((c) => c || fetch(request))
      )
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
          // Always revalidate the canonical index.html (never the raw navigation
          // request: its ?query or redirect mode could make the check meaningless).
          // 'no-cache' = revalidate with ETag/Last-Modified; a 304 costs a few
          // hundred bytes instead of re-downloading the whole file.
          // With a saved copy the check runs in the background and is abandoned
          // after 20 s; with NO saved copy (first ever open) it gets the browser's
          // normal patience because the page can't start without it.
          const updateCache = (cached
            ? fetchWithAbort(shellUrl(), { cache: 'no-cache' }, 20000)
            : fetch(shellUrl(), { cache: 'no-cache' })
          ).then((response) => {
              if (response && response.ok) {
                // Same strong validator as the cached copy => provably the same
                // file: nothing to hash, and no reason to re-write the whole file into
                // the cache on every app open.
                const etagCached = cached && cached.headers.get('etag');
                const etagFresh = response.headers.get('etag');
                if (etagCached && etagFresh && etagCached === etagFresh) return response;
                // Compare the real file CONTENT, not headers: ETag /
                // Last-Modified can differ between requests (CDN nodes,
                // weak vs strong ETags) even when index.html is identical,
                // which used to show the "new version" prompt every time.
                const fresh = response.clone();
                const toStore = response.clone();
                const check = cached
                  ? bodiesDiffer(cached.clone(), fresh)
                  : Promise.resolve(false);
                return check.then((changed) =>
                  // FIX: a failed cache write (storage full / quota) used to reject this
                  // whole chain, so on the very first open the page itself never loaded.
                  // The write is now best-effort: the response is returned either way.
                  cache.put('./index.html', toStore).then(
                    () => { if (changed) return notifyClientsOfUpdate(); },
                    (err) => { console.warn('[service-worker] could not save index.html (storage full?):', err); }
                  )
                ).then(() => response);
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
            .catch(() => cached || Response.error());
          if (cached) { event.waitUntil(network.catch(() => {})); return cached; }
          return network;
        })
      )
    );
    return;
  }

  // Same-origin static assets (icons, screenshots...): serve the saved copy at once,
  // refresh it quietly in the background so a replaced icon doesn't stay frozen
  // until the next CACHE_VERSION bump.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      });
      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }
      return network;
    })
  );
});
