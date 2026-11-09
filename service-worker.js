// service-worker.js — Audit Data Dashboard
// v196: native mobile scorecard scrolling, capability-aware motion, cheaper filter refreshes, referrer hardening, and complete Android PWA assets.
// v195: faster Overall Data snapshot (leaner table cells, contained layout, coalesced filter taps), no overlay blur on phones.
// v194: scorecard is a fixed box showing 14 branches; only the branch rows scroll vertically (header stays pinned), columns scroll sideways, nothing frozen.
// v193: phone scorecard is no longer a nested vertical scroller (page scrolls smoothly, table scrolls sideways only); uniform row shading; 3-digit row numbers fit; height refit ignores URL-bar resizes.
// v192: scorecard no longer freezes # / Branch columns (all columns scroll horizontally); Drive root shows icon instead of 'All files' text; Snapshot Filter metrics menu no longer closes itself and no longer collapses on mobile address-bar resize; touch/hover smoothness fixes.
// v191: fixes mobile scorecard table cascade specificity; preserves native 13-column desktop table in its own phone-width scroller.
// Bump CACHE_VERSION any time you change what gets precached.
// v233: route authenticated default dashboard data requests to the Sheets API; improve live refresh diagnostics.
// v231: Opex Home navigation fallback; v230: unified sub-app navigation.
// v229: preserve the active Drive folder across page refresh; only the Drive Home button returns to dashboard.
// v228: popup recent-files browser; package + cache all connected HTML pages; page-local refresh/home navigation safety.
// v227: show ten recently modified files in the Drive sidebar.
// v226: Drive header leading Home icon and preview-only pinch zoom.
// v225: lower idle GPU/motion overhead on constrained devices; targeted control transitions.
// v224: scoped motion optimization, Findings Editor entrance polish, and unified Apps Script request routing.
// v223: viewport-adaptive full-width layout for desktop/workstation screens.
// v222: explicit touch-scroll handoff and light momentum across the five-item findings list and its profile parent.
// v220: continuous detailed-profile scrolling; nested modal scroll areas hand off vertical gestures at their edges.
// v219: restore the measured 14-row vertical scorecard scroller on phones and desktops; preserve native touch chaining.
// v215: pairs with index.html - removes hidden refresh animation work, eliminates scroll-lock polling, and tightens desktop/mobile motion.
// v214: pairs with index.html - fluid motion system and event-driven calendar scroll-lock safety.
// v213: pairs with index.html - mobile scorecard toolbar spacing fix (Filters/Reset buttons, collapsible filter panel).
// v212: pairs with index.html - clickable scheduled/completed chips, whole-month branch list, past dates count as completed.
// v211: pairs with index.html - calendar header: removed next-audit pill, arrows grouped around the month.
// v210: pairs with index.html - holidays under the calendar, single close button.
// v209: pairs with index.html - fixes page not scrolling (scroll lock only applies while the calendar is open).
// v208: pairs with index.html - compact two-column calendar, close button on the right edge.
// v207: pairs with index.html - calendar redesign + page scroll lock while it is open.
// v206: pairs with index.html - calendar highlights audit schedule, day details, close actions.
// v205: pairs with index.html - clock calendar opens as a big centered pop-up.
// v204: pairs with index.html - queued / recent audit labels no longer squeezed.
// v203: pairs with index.html - cards no longer show around the pinned Branch Performance bar (design unchanged).
// v202: pairs with index.html scorecard toolbar fix (Reset button no longer overlaps the filters).
// v201: pairs with index.html clean-scroll fix under the pinned Branch Performance bar.
// v200: pairs with the new index.html (mobile + desktop overview card redesign). Bumped so installed clients fetch the new shell.
// v185: Drive UI updates (sortable headers, Make a copy, select-then-open, Audit files title). Bumped so phones fetch the new index.html.
// v186: Drive native-behaviour update (UI only; precache list unchanged).
// v184: Adds authenticated server-side Drive download relay for files up to 8 MiB; larger files use Google direct links. v183 metadata checks retained.
// v181: Fixes shortcut and resource-key Drive previews, refreshes folder listings on open, and reduces Drive menu rendering/pagination work.
// v176: Restores Auto AI routing and live-data verification indicator in the assistant UI.
// v174: assistant always reads live sheet data for any data-style question (no more guessing); browser view attaches for the same questions.
// v155: assistant replies now open at their first line; findings summary under collection/sales/service.
// v154: detailed prioritized recommendations and additional insights; pp suffix removed from replies.
// v153: assistant status line under the header removed; assistant tables and headings restyled to fit the panel without sideways scrolling.
// v152: links the HTML assistant to Code.gs six-source snapshots, removes duplicate browser findings uploads, and selects full detail by query.
// v106: app header stays pinned (dimmed behind the overlay) while ANY popup is open.
// v172: Faster Drive search responses (no per-page parent lookups), word-level name/content matching, repeated-query browser cache, and scroll pagination.
// v168: expanded in-folder creation, original-file previews, and fullscreen preview controls.
// v162: assistant speed pass (instant local answers, fewer POST round-trips, early wake-up, compact prompt for general chat).
// v161: bounded Gemini overload failover/retry and removal of the chat Drive workspace.
// v172: Drive-native user-corpus search with Shared Drive inclusion, exact phrases, expanded file-type filters, and faster cache refresh.
const CACHE_VERSION = 'audit-dashboard-v236'
// v141: native Google Sheets creation, flexible natural-language Drive destinations, explicit My Drive root handling and Docs/DOCX/PDF creation; v138 response profiles and v137 transport/template safeguards retained.
// v137: CORS-resilient assistant file POST/result retrieval, API-key-scoped quota cooldowns, and guarded DOCX section saves.
// v136: persistent daily-quota cooldown, stable-model preference over preview overrides, and precise template edits.
// v135: per-model daily quota circuit-breaker, Flash fallback, and targeted section edits in permanent report templates.
// v134: shared AI approval queue allows the primary owner and auditdept2022@gmail.com to approve/reject.
// v133: discovers API-key-available Gemini text models and routes quick, standard and complex work by model capability.
// v131: parses nested Drive folder paths, searches inside the final folder, and creates named DOCX files in that exact folder.
// v130: respects Gemini RetryInfo up to 60 seconds, falls back on model-scoped 429 quotas, clarifies daily quota errors and removes the Approvals checkmark icon.
// v129: permanently saved Drive workspace, bounded folder/file search, editor-only Drive access and assistant responsiveness fixes.
// v128: authenticated Google Drive workspace, Google Docs template support and DOCX report creation.
// v127: additional AI assistant integration and folder persistence hardening.
// v126: finding questions pass the exact HTML itemized rows, report each finding separately, and avoid substituting other branches when a requested branch has no matching HTML detail.
// v122: adaptive AI response budgets, compact chat payloads, no redundant health probes, and shorter bounded retries.
// v123: dashboard AI grounding reads compound audit headers, structured Overall Data aggregates/rankings, exact remark/emergency layouts, branch-specific contexts, and whole-record truncation.
// v124: full-dashboard review requests include all six dashboard source sheets plus structured OVERALL DATA.
// v121: maps dashboard Audit Status to the NEXT ENGAGEMENT header, with legacy-header fallback.
// v120: repairs auditor assignment header resolution when merged rotation headers export blank cells; prefers explicit auditor headers and safely falls back to the paired date column.
// v118: one consolidated print stylesheet (no grey body band, icons no longer balloon, ID-scoped popup styling kept), Ctrl+P no longer prints a blank page, and print buttons added to the branch risk popup, Top Findings popups and score-factor popup.
// v117: repairs print rendering, preserves sortable table header text, adds print actions to content popups including audit findings.
// v116: print every row/column in the current modal view; split wide tables without squeezing and honor selected paper size/orientation.
// v115: print only on-screen visible table rows/columns and current visible panels; keep wide prints readable.
// v114: print only currently visible/filtered modal content, split wide tables into readable column groups, fix print widths, and add Service month filtering to Overall Data Snapshot.
// v113: adds Collection/Sales metric filtering in Overall Data Snapshot, keeps filtered current-view exports aligned, and ensures the consolidated report uses refreshed dashboard data.
// v112: completes Download Report coverage for Overall Data, risk/scheduling summaries, emergency rotation, and branch-detail exports; refreshes Overall Data before the consolidated report.
// v111: repairs print layout and consistent Excel/Word/PDF export formatting without changing dashboard data or workflows.
// v110: fixes Audit Risk & Schedule Analysis popups that opened behind the modal / swallowed taps on mobile; restores page scroll after closing.
// v108: prevents close-animation races that left mobile popups visually open/closed out of sync.
// v103: keeps the main dashboard header visible above the Detailed Profile popup on the scorecard.
// v102: stable background refresh avoids dashboard flicker; pairs with reliable Overall Data header merging.
// v101: manual Update Data verifies live sheet contents even when Drive modified-time is stale.
// v100: mobile branch scorecard names are left-aligned; preserves v99 touch-scrolling fixes.
// v98: repeat-issues popup lists all branches, reuses branch-detail analysis, and reduces unnecessary re-render work.
// v93: stable reveal visibility, mobile drawer sizing, and fewer redundant SW update checks.
// v109: fixes dashboard cards/header jumping when a popup opens or closes (header-height spacer was stuck at 0px).
// v92: reduces avoidable background traffic (deferred Findings warm-up, 30 s My Devices modal refresh, 10 s server-side sheet-version memo).
// v91: removes the external portfolio-risk status card and clarifies the average branch risk index label.
// v89: protects pending shared rating-rule saves from stale background polling; syncs all scoring caps and retries after version conflicts.
// v88: relocates portfolio risk status from the outer dashboard card into the Audit Risk & Schedule Analysis modal.
// v87: adds a mobile-only Compact / Full details switch for the All Branches Branch Scorecard; desktop is unchanged.
// v86: removes the unwanted scorecard-only Update action and explicitly keeps the All Branches scorecard visible on mobile.
// v84: stabilizes audit-risk weights for consistent period-over-period management reporting; adds visible data-coverage and red-flag indicators, and labels the headline as a composite index.
// v83: responsive mobile scorecard cards, non-overlapping filter controls, and no sideways scorecard scroll; retains v82 remark-save safeguards.
// Only caches whose name starts with this prefix belong to this app (see activate).
const CACHE_PREFIX = 'audit-dashboard-';
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
  './app-navigation.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  // Sibling tools are cached as their own documents. Their navigation remains
  // network-first and never falls back to the dashboard shell.
  './Data-updater.html',
  './Opex.html',
  './Parts_Request.html',
  './attendance_dashboard.html'
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

  // Same-origin navigation to a page OTHER than the dashboard (Data-updater.html,
  // Opex.html, Parts_Request.html, attendance_dashboard.html, and other siblings):
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
