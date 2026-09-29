// service-worker.js — Audit Data Dashboard
// Bump CACHE_VERSION any time you change what gets precached.
const CACHE_VERSION = 'audit-dashboard-v41';
// v41: Branch Picker is now add-only: type branches yourself (Enter to add), or add the Overview list / all branches with one tap.
// v40: Fixed the "new version available" prompt showing on every visit even when nothing changed: the service worker now compares the real index.html content instead of ETag/Last-Modified headers.
// v39: Assignment Branches Overview: the "Data Analysis" toolbar button is replaced by a Branch Picker (shuffle papers, tap one, it flips up and shows the branch to visit). Bumped so installed apps refetch index.html.
// v38: Analysis now references the same numbers as Operations Highpoints / Auditor Workload: each auditor row shows branches waiting AND audits done (tap opens the same Auditor Workload popup), and when two auditors are equally free the one with fewer audits done gets the branch. Detailed Profile already shares the same audit-round data. Bumped so installed apps refetch index.html.
// v37: Connected to the AUDITORS EMERGENCY sheet: emergency audits now count as real audits for their branch (names matched safely, e.g. LAIYA = LAIYA SAN JUAN), and an audit that started a few days ago still blocks that auditor's next days when suggesting dates. Bumped so installed apps refetch index.html.
// v36: Audit schedule fixes: an audit dated TODAY is no longer treated as missed; an audit already done on/after its planned date is no longer queued again; audits planned only as a future-dated round now count as scheduled; suggested dates avoid every day an auditor is already booked (one lane per auditor name, any case). Bumped so installed apps refetch index.html.
// v35: Loading progress bar + status text is back under the logo on the boot splash (follows the real load). Bumped so installed apps refetch index.html.
// v34: Audit status banner realigned: headline no longer wraps onto a second line with a lone word, tighter line spacing, more room between the status block and the rating bar. Bumped so installed apps refetch index.html.
// v33: Audit schedule now uses ONE audit-cycle rule per branch: its own data-based due interval, shortened (never lengthened) by its rating's limit. Before, the score used the branch's due interval but the schedule/overdue/on-track checks used a fixed rating cycle, so the two could disagree. Bumped so installed apps refetch index.html.
// v32: Audit status banner: plainer wording ("23 branches need an audit plan", "39 of 56 branches are audited on time or already scheduled"), "ON TRACK" label inside the ring. Bumped so installed apps refetch index.html.
// v31: Risk Drivers panel: right-hand counts no longer squeezed/wrapped (wider fixed column, no wrapping), simpler wording ("28 of 56 branches"), plainer subtitle. Bumped so installed apps refetch index.html.
// v30: Branch popup lower sections: trend cards one per row with bigger numbers, sales as 3 months + full-width total, service rows stacked, slightly wider content. Bumped so installed apps refetch index.html.
// v29: Branch popup rebuilt for phones: full-screen sheet with larger text (14-15px), 44px touch targets, section cards,
//  score breakdown as rows with a risk bar, sales as small cards instead of a 5-column table, cleaner findings header.
//  Bumped so installed apps refetch index.html.
// v28: Loading + double-load fix. index.html: boot splash now shows a REAL progress bar that follows the actual
//  data load, the dashboard no longer re-renders when the fresh data is identical to the cache (data version is
//  remembered), and a new service worker no longer force-reloads the page (shows the update prompt instead).
//  Bumped so installed apps refetch index.html.
// v27: Branch popup compact pass: minimal spacing, no mid-word breaks (MARC/H), breakdown table stacks on phones,
//  2-column stat cards, tidier findings header. Bumped so installed apps refetch index.html.
// v26: Branch popup fix: schedule-status badge no longer overflows onto Last audited, action button sized properly,
//  no nested/double scrolling (page behind is locked, findings + tables flow inside one scroller). Bumped so
//  installed apps refetch index.html.
// v25: Branch popup (Audit Risk & Schedule Analysis) now also shows the Audit Findings panel (AUDIT FINDINGS sheet)
//  under Service, plus popup layout/padding fixes for phone + desktop and less lag (throttled page observers,
//  no full re-scoring on every popup open). Bumped so installed apps refetch index.html.
// v24: MOBILE PASS on Audit Risk & Schedule Analysis + Rating Rules (full-screen sheet on phones, wrapped tabs,
//  stacked footer, no truncated labels). Bumped so installed apps refetch index.html.
// v23: LIVE DATA. index.html now checks a tiny "dataVersion" endpoint every ~20 s (and instantly on
//  focus/online) and only downloads data when the Sheet actually changed; it also keeps an IndexedDB
//  copy of the dashboard so a new sign-in / cleared browser storage still opens instantly, and wakes
//  the backend while the sign-in screen is still loading. Bumped so installed apps refetch index.html.
// v22: Rating Rules & Manual Settings: nothing changes until "Save changes" is pressed, and saving now
//  asks for the owner's password (only the account flagged ratingRules in Code.gs can save). Bumped so
//  installed apps refetch index.html.
// v21: Rating Rules & Manual Settings: new "Data scales" tab, extra red-flag and queue rules, and faster
//  live cross-device sync (5 s while open, 20 s in the background, instant on focus/online). Bumped so
//  installed apps refetch index.html.
// v20: redesigned "Rating Rules & Manual Settings" (tabs, presets, live preview, editable
//  rating levels, cycles and red flags). Bumped so installed apps refetch index.html.
// v19: data-driven rating levels (top ~15% Critical / ~40% High, fixed minimums kept),
//  rebuilt "How branches are rated" panel. Bumped so installed apps refetch index.html.
// v18: Audit Risk model v3 (peer-relative efficiency/repo scoring, data-driven
//  "How branches are compared" panel with evidence table). Bumped so installed apps refetch.
// v17: scoring scales are now fully automatic (no manual caps).
// v16: clearer Advanced scoring scales panel (calibration checks shown).
// v15: new Audit Risk rating model (risk-based audit cycles, findings for a new year,
//  INS/COD/CA sales, service vs target amount, fairer account-size scale, new default weights).
// v14: removed the Audit history detected panel.
// v13: profile Recent/Last use every dated engagement incl. scheduled.
// v12: profile shows an Audit history detected panel.
// v11: Recent/Last auditor merge AUDIT DATA + ROTATION rounds.
// v10: Priority Queue keeps the already-assigned Up Next auditor.
// v9: profile Recent/Last auditor + analysis auditor fixes.
// v8: index.html update (remark drafts, shared Audit Risk analysis sync,
//  removed the "Right now" rules box). Bumped so installed apps refetch it.
// v7: FIXED stale live data. The cross-origin handler used to cache EVERY
//  cross-origin GET stale-while-revalidate, including api.open-meteo.com
//  (the weather call in attendance_dashboard.html), so the weather could
//  show an old reading. Now only a fixed allowlist of static CDN hosts
//  (scripts / fonts) is cached; every other cross-origin request goes
//  straight to the network untouched.
// v6 (this file): FIXED a navigation bug. The old handler treated EVERY
//  same-origin page navigation as "the dashboard": it answered with the
//  cached ./index.html and, on refresh, overwrote that cache entry with
//  whatever page was requested. index.html links to sibling pages
//  (attendance_dashboard.html, Parts_Request.html, Opex.html, and the
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

// True only when the two responses have different BODY bytes (SHA-256).
// Any error => false, so a hiccup never produces a false "update" prompt.
function bodiesDiffer(a, b) {
  const hash = (res) =>
    res.arrayBuffer()
      .then((buf) => crypto.subtle.digest('SHA-256', buf))
      .then((d) => Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join(''));
  return Promise.all([hash(a), hash(b)])
    .then((h) => h[0] !== h[1])
    .catch(() => false);
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
                  cache.put('./index.html', toStore).then(() => {
                    if (changed) return notifyClientsOfUpdate();
                  })
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
