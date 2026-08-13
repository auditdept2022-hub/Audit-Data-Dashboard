// Service worker for the Attendance Dashboard.
//
// What this does:
//   - The first time any page on this site is opened online, it's cached
//     automatically ("network first" below). After that, opening the same
//     page with no connection at all serves the cached copy instead of a
//     browser error, so the app itself loads offline.
//   - Precaches the shared manifest/icons up front so the "Add to Home
//     Screen" / install experience works offline too.
//   - Deliberately does NOT intercept requests to Google Sheets
//     (docs.google.com) or your Apps Script web app -- those are handled
//     by the page's own IndexedDB-backed offline cache/queue, which knows
//     what's actually synced vs. still pending. This service worker only
//     needs to get the app shell itself to load offline; the page's own
//     JavaScript takes it from there.
//
// Bump CACHE_NAME whenever you deploy a change, to drop old cached files
// and pick up new ones.
const CACHE_NAME = 'attendance-dashboard-shell-v1';

// Shared, known-good files to precache on install. Individual HTML pages
// are cached automatically the first time each one is visited (see the
// fetch handler below), so they don't need to be listed here.
const PRECACHE_FILES = [
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        PRECACHE_FILES.map((url) =>
          cache.add(url).catch(() => {
            /* ignore files that don't exist yet (e.g. icons not added) */
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GET requests. Everything else (Google Sheets
  // reads, the Apps Script web app POST/GET, any other cross-origin call)
  // passes straight through to the network untouched.
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // Page navigations (and the HTML file loaded directly): try the network
  // first so edits to the app are picked up right away when online, and
  // cache each page as it's visited. Fall back to whatever was last cached
  // for that exact URL when offline.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Everything else same-origin (CSS/JS/icons/manifest): cache-first, then
  // network, caching whatever the network returns for next time.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => cached);
    })
  );
});
