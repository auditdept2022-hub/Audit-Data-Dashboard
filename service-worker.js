// Audit Dashboard — offline app-shell cache.
//
// What this does and doesn't do:
// - Caches the page itself, its icons/manifest, and every third-party
//   library it loads from a CDN (Tailwind, ApexCharts, xlsx, docx, jsPDF,
//   jsPDF-autotable, Lucide, the Firebase SDK modules, Google Fonts), so
//   the dashboard can open and render with zero network connection —
//   including staying signed in, since Firebase's own session cache
//   (IndexedDB) doesn't depend on this service worker at all.
// - Deliberately does NOT cache anything from script.google.com /
//   script.googleusercontent.com (the live data source) or any Google
//   auth/identity endpoint. Those always go straight to the network. If
//   there's no connection, those requests just fail exactly as they did
//   before this file existed — the dashboard's own JS already falls back
//   to the last-synced data it saved to localStorage (see
//   loadDashboardDataFromCache() in index.html) and shows "Last synced …"
//   Bumping CACHE_VERSION forces every client to fetch fresh copies of
//   everything below on next load — do that whenever a library version
//   changes.
const CACHE_VERSION = 'v1';
const CACHE_NAME = 'audit-dashboard-' + CACHE_VERSION;

// Same-origin app shell.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Third-party libraries the page loads directly. Exact version pins (not
// "@latest") so a returning offline visitor always gets back the same
// code that was cached, not a version mismatch.
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/apexcharts',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/docx@8.5/build/index.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  'https://unpkg.com/lucide@latest',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap',
];

// Hosts that must ALWAYS go to the network, never through this cache —
// live data and auth are time-sensitive/security-sensitive and must never
// serve a stale or cached response.
const NEVER_CACHE_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache each URL individually (not cache.addAll) so one CDN being
      // briefly unreachable during install doesn't fail the whole thing —
      // whatever DOES succeed still gets cached.
      const all = APP_SHELL.concat(CDN_ASSETS);
      return Promise.all(
        all.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[service-worker] precache failed for', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept POSTs (data writes, auth calls)

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Live data + auth: always network, never cached.
  if (NEVER_CACHE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
    return; // let the browser handle it normally
  }

  // The page itself: network-first, so an online visitor always gets the
  // latest deployed version, but it still falls back to the cached shell
  // the moment the network is unavailable.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Everything else we know how to cache (CDN libraries, fonts, icons,
  // manifest): cache-first for instant offline loads, refreshing the
  // cache in the background whenever the network is available.
  const isKnownCdn = CDN_ASSETS.some((a) => req.url === a || req.url.startsWith(a.split('?')[0]));
  const isFontHost = url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com';
  const isSameOrigin = url.origin === self.location.origin;

  if (isKnownCdn || isFontHost || isSameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
