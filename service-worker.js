// service-worker.js — Audit Data Dashboard
// Bump CACHE_VERSION any time you change what gets precached.
const CACHE_VERSION = 'audit-dashboard-v90'
// Only caches whose name starts with this prefix belong to this app (see activate).
const CACHE_PREFIX = 'audit-dashboard-';
// v81: plain-language rewrite of the Audit Score & Schedule Settings screen (labels, help text, riskiest-% wording).
// v82: risk levels now use fixed minimum scores only (rank-based top-% rule removed).
// v87: save completion is now receipt-backed; queued writes cannot be reported as complete; toast priority stays above every modal; reports split wide tables so data remains visible.
// v88: report freshness checks are silent; critical save toasts can minimize into a side chip, then expand with the completion check animation.
// v90: Overall Data now performs a header-only need-check before any write; routine startup health no longer adds a duplicate backend probe.
// v72: pairs with canonical team analysis state, source-data version binding, and 3 s analysis polling. manual refresh version gating, safer one-shot writes, lighter Online status checks, reduced boot-time traffic, and deferred cache persistence.
// v78: pairs with the transport/auth health hardening in index.html + Code.gs; forces the repaired shell onto installed clients.
// v80: findings-analysis UX pass pairs with index.html: category filtering works in every findings view, annual top/repeated finding intelligence is local and fast, and finding counts respect the selected categories.
// v76: mobile/profile layout hardening and connection-state recovery are shipped with the new shell.
// v74: canonical save response is applied locally; refreshes clients onto the latest sync code.
// v73: canonical Analysis data fingerprint + background Analysis sync foundation.
//  (a) activate only deletes this app's OWN old caches (other apps on the same origin keep theirs)
//  and one failed delete can no longer block activation; (b) Range / only-if-cached requests are
//  left to the browser; (c) only complete 200 responses are cached, and responses the server marks
//  "no-store" are not re-saved at runtime; (d) the cache-first CDN path and sibling-page saves no
//  longer leave unhandled rejections and are kept alive until the write finishes.
// v67 (review pass, CACHE_VERSION unchanged on purpose - precache list and strategy are the same):
//  (a) the saved index.html is cloned BEFORE it is handed to respondWith, so the background
//  comparison can't throw "body already used" (which silently disabled update detection);
//  (b) manifest / icons / unpinned CDN files are only re-written to the cache when their content
//  really changed (a 304 revalidation used to be re-saved on every load); (c) the 8 s fallback for
//  sibling pages reuses the in-flight request instead of firing a second one; (d) install reuses a
//  pinned CDN file already saved by the previous version instead of downloading it again.
// v67: update-flow hardening. (1) index.html is only re-written to the cache when its content
//  really changed, and the "update available" message is only sent after that write succeeded
//  (no repeat prompts / loops if storage is full). (2) Tabs that are already open are told about
//  a new version when the new worker activates (only if index.html actually changed).
//  (3) CDN precache can no longer stall install on a hung connection. (4) Background refresh of
//  icons uses a conditional request (304) instead of a full re-download.
// v66: pairs with index.html device-friendly pass (no iPhone zoom-on-tap in text boxes,
//  notch-safe in landscape, no double-tap delay, correct full-height on mobile browsers).
// v65: pairs with index.html fix: Rating Rules preview/save no longer throws
//  "escapeHTML is not defined" when a rule problem is shown. No behaviour change here.
// v64: pairs with the Audit Risk & Schedule Analysis save fix (Code.gs #23 + index.html).
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

// Set during install when the freshly precached index.html differs from the one in the
// previous cache. Used by activate to tell already-open tabs about the update.
let shellChangedOnInstall = false;

// ---- Install ----
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Copy of the shell from the previous version (if any), to detect a real change.
    const previous = await caches.match(shellUrl()).catch(() => null);

    await Promise.all(
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
        // Aborted after 15 s so a hung CDN can't delay the install.
        // Pinned (exact version) => identical bytes, so reuse the copy the previous version saved.
        caches.match(url).then((hit) => hit ||
          fetchWithAbort(url, { mode: 'cors', credentials: 'omit' }, 15000))
          .then((res) => (res && res.ok ? cache.put(url, res) : null))
          .catch(() => null)
      ))
    );

    if (previous) {
      const fresh = await cache.match('./index.html');
      shellChangedOnInstall = fresh ? await bodiesDiffer(previous, fresh.clone()) : false;
    }
    await self.skipWaiting();
  })());
});

// ---- Activate ----
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Only this app's own older caches; never touch caches that belong to other apps on this origin.
    const oldKeys = keys.filter((k) => k !== CACHE_NAME && k.indexOf(CACHE_PREFIX) === 0);
    const hadOld = oldKeys.length > 0;
    // One failed delete must not stop activation / clients.claim().
    await Promise.all(oldKeys.map((k) => caches.delete(k).catch(() => false)));
    await self.clients.claim();
    // Upgrade (not first install) AND index.html really changed: tabs that are open right now
    // are still running the old page, so let them show the Refresh button.
    if (hadOld && shellChangedOnInstall) await notifyClientsOfUpdate().catch(() => {});
  })());
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

// Save `response` over the existing entry ONLY if its content differs from `cachedCopy`
// (a clone taken before the saved response was handed to respondWith). No saved copy => save.
// Never rejects. Resolves true only if a write happened.
function putIfChanged(cache, request, cachedCopy, response) {
  // Only complete 200 responses (a 206 partial can't be cached), and respect "no-store".
  if (!(response && response.ok && response.status === 200)) return Promise.resolve(false);
  if (/no-store/i.test(response.headers.get('cache-control') || '')) return Promise.resolve(false);
  const save = () => cache.put(request, response.clone()).then(() => true, () => false);
  if (!cachedCopy) return save();
  return bodiesDiffer(cachedCopy, response.clone()).then((changed) => (changed ? save() : false));
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
  // Let the browser handle these itself: Range requests (a cached full file would be a wrong
  // answer) and the DevTools "only-if-cached" quirk that makes fetch() throw.
  if (request.headers.has('range')) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

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
            if (response && response.ok && response.status === 200) {
              event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
            }
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
          const cachedCopy = cached ? cached.clone() : null; // clone BEFORE cached goes to respondWith
          const network = fetch(request)
            .then((response) => {
              event.waitUntil(putIfChanged(cache, request, cachedCopy, response));
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
    // FIX: on a bad connection these pages waited on the network indefinitely even
    // when a saved copy existed. After 8 s the saved copy is used instead. With no saved
    // copy we keep waiting on the SAME request (no second fetch of the same page).
    let saved = Promise.resolve();
    const net = fetch(request).then((response) => {
      if (response && response.ok && response.status === 200) {
        const copy = response.clone();
        saved = caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    });
    // Keep the worker alive until the saved copy is written (no-op if the fetch fails).
    event.waitUntil(net.then(() => saved, () => {}));
    event.respondWith(
      withTimeout(
        net,
        8000,
        () => caches.match(request).then((c) => c || net)
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
          // Clone NOW: once `cached` is returned to respondWith its body is locked and a later
          // cached.clone() throws, which (swallowed by the .catch below) disabled update detection.
          const cachedCopy = cached ? cached.clone() : null;
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
              if (!(response && response.ok)) return response;

              // First ever open: no saved copy. Save one (best-effort) and serve the response.
              if (!cached) {
                return cache.put('./index.html', response.clone())
                  .catch((err) => { console.warn('[service-worker] could not save index.html (storage full?):', err); })
                  .then(() => response);
              }

              // Same strong validator as the saved copy => provably the same file: do nothing.
              const etagCached = cached.headers.get('etag');
              const etagFresh = response.headers.get('etag');
              if (etagCached && etagFresh && etagCached === etagFresh) return response;

              // Compare the real CONTENT (ETag/Last-Modified can differ between requests
              // even when the file is identical). Unchanged => do nothing, no cache write,
              // no message. Changed => save it, and only if the save worked tell the page
              // (a failed save + a message would loop: Refresh would just reload the old copy).
              return bodiesDiffer(cachedCopy, response.clone()).then((changed) => {
                if (!changed) return response;
                return cache.put('./index.html', response.clone()).then(
                  () => notifyClientsOfUpdate(),
                  (err) => { console.warn('[service-worker] could not save index.html (storage full?):', err); }
                ).then(() => response);
              });
            });

          if (cached) {
            event.waitUntil(updateCache.catch(() => {}));
            return cached;
          }
          return updateCache.catch(() => caches.match('./index.html').then((saved) => saved || new Response(
            '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<body style="font-family:system-ui;padding:2rem"><h2>Dashboard is temporarily unavailable</h2>' +
            '<p>The app shell could not be refreshed. Check your connection and reload.</p></body>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          )));
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
          const cachedCopy = cached ? cached.clone() : null;
          const network = fetch(request, { cache: 'no-cache' })
            .then((response) => {
              event.waitUntil(putIfChanged(cache, request, cachedCopy, response));
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
      const cachedCopy = cached ? cached.clone() : null;
      // With a saved copy, revalidate conditionally (a 304 is a few hundred bytes).
      const network = fetch(request, cached ? { cache: 'no-cache' } : undefined).then((response) => {
        if (response && response.ok) {
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => putIfChanged(cache, request, cachedCopy, response)).catch(() => {}));
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
