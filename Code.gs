// ==========================================================================
// AUDIT DASHBOARD — Code.gs (Apps Script backend)
// v81: idempotent Detailed Profile remark saves, bounded token-verification stampedes, and slow-action timing logs.
// v80: change-aware scheduled Firestore sync; avoid six-sheet rewrites when verified source data is unchanged.
// v79: health-result cache + lightweight health path; reduce duplicate Drive checks and make backend health reliable under concurrency.
// v75: client-side Analysis opening is non-blocking; canonical state remains server-authoritative.
// ==========================================================================


// ##########################################################################
// ##########################################################################
// ##                                                                      ##
// ##   ACCESS EDITOR — EDIT WHO CAN DO WHAT HERE, AND ONLY HERE           ##
// ##                                                                      ##
// ##########################################################################
// ##########################################################################
//
// One row per person. To ADD someone: copy a row, change the email, set the
// flags. To REMOVE someone: delete their row. To CHANGE permissions: flip
// the true/false flags. Nothing else in this file (or in index.html) holds
// an email list — everything below is generated from this table.
//
//   viewer          -> can open/view the dashboard at all (also unlocks
//                      heartbeat, My Devices, sign out own devices,
//                      Overall Data, Analysis view sync)
//   editor          -> can edit assignments, highlights, remarks, the
//                      emergency auditor/rotation, run "Update Sheet",
//                      and read the audit log
//   quickLinks      -> can open the Quick Links (the 5 Google Sheets/Folder)
//   accountManager  -> can Block / Unblock / Force sign-out OTHER accounts
//                      and sign out / remove other accounts' devices
//                      (also receives backup-failure alert emails)
//   ratingRules     -> can SAVE the "Rating Rules & Manual Settings" of
//                      Audit Risk & Schedule Analysis (levels, cycles, red
//                      flags, weights...). The dashboard also asks this
//                      person for their password before every save.
//                      Everyone else can still see the rules, but the
//                      server refuses any change to them.
//
// Notes:
//   - Emails are matched case-insensitively (they are lowercased below).
//   - A person with all flags false is effectively denied everything.
//   - Give "viewer: true" to everyone who should be able to sign in; the
//     other flags do not imply viewer access.
//   - After editing: Deploy > Manage deployments > Edit > New version,
//     otherwise the live web app keeps using the old list.
//
const ACCESS_CONFIG = [
  //  email                       editor  quickLinks  viewer  accountManager  ratingRules
  { email: "karljenard@gmail.com",    editor: true,  quickLinks: true,  viewer: true, accountManager: true,  ratingRules: true  },
  { email: "auditdept2022@gmail.com", editor: true,  quickLinks: true,  viewer: true, accountManager: true,  ratingRules: false },
  { email: "edison@gmail.com",        editor: false, quickLinks: false, viewer: true, accountManager: false, ratingRules: false },
  // { email: "newperson@gmail.com",  editor: false, quickLinks: false, viewer: true, accountManager: false, ratingRules: false },
];

function emailsWithFlag(flag) {
  return ACCESS_CONFIG
    .filter(function (row) { return !!row[flag]; })
    .map(function (row) { return String(row.email || "").toLowerCase().trim(); })
    .filter(Boolean);
}

// Derived lists (same names/values as the original hardcoded arrays, so
// nothing else needs to change).
const EDITOR_EMAILS                  = emailsWithFlag("editor");
const QUICKLINKS_ALLOWED_EMAILS      = emailsWithFlag("quickLinks");
const DASHBOARD_VIEW_ALLOWED_EMAILS  = emailsWithFlag("viewer");
const ACTIVE_ACCOUNTS_MANAGER_EMAILS = emailsWithFlag("accountManager");
const RATING_RULES_EDITOR_EMAILS     = emailsWithFlag("ratingRules");

// ##########################################################################
// END ACCESS EDITOR
// ##########################################################################


// ==========================================================================
// OTHER SETTINGS YOU MIGHT WANT TO CHANGE (all in one place)
// ==========================================================================
const SPREADSHEET_ID = "1_5VBVpcHYpdRIuEWLg5Rry-BIgWq8bJiVQZZHRNM05k";

// "account" = each account's Audit Risk & Schedule Analysis view follows
// that account across its own devices; "team" = one shared view that only
// editors can change. (Rating rules additionally need the "ratingRules"
// flag in ACCESS_CONFIG, in either mode.)
const ANALYSIS_STATE_SCOPE = "team";

const DASHBOARD_CACHE_WARMER_INTERVAL_MINUTES = 5;
const AUDIT_LOG_RETENTION_DAYS = 30;
const DEVICE_PRESENCE_RETENTION_DAYS = 90;
const PRESENCE_ACTIVE_WINDOW_MS = 2 * 60 * 1000; // "active" = heartbeat in last 2 min

// ==========================================================================
// CHANGE HISTORY (condensed — full logic is unchanged)
// ==========================================================================
//  #1  Single ACCESS_CONFIG table, audit_log collection, emergency-auditor
//      sheet layout moved to row 2, "My Devices" (device_presence).
//  #2  Server-side filtered device query, device-list caching, combined
//      myDevicesBundle endpoint.
//  #3  urlfetch daily-quota fixes: longer caches, memoized Firestore client.
//  #4  De-duplicated per-request presence-doc reads; longer TTLs.
//  #5  Heartbeat's device read now uses the cached device list.
//  #6  Token-verify quota failures are reported as "at capacity", not
//      "Unauthorized".
//  #7  Deferred FULL sync self-heals Firestore after a manual Sheet edit.
//  #8  Proactive dashboard cache warmer (run
//      createDashboardCacheWarmerTrigger() ONCE).
//  #9  Cross-device sync of Audit Risk & Schedule Analysis view.
//  #10 Access editor moved to the very top; settings gathered together.
//  #11 Dead code removed (unused doPost, superseded actions, etc.).
//  #12 diagnoseAuth action (dispatched BEFORE the shared-secret gate).
//  #13 IDLE / TIMEOUT FIXES ("ping" action, 30,000-char cache chunks,
//      Overall Data kept warm, fewer Sheet calls, 3-min blocked cache).
//  #14 RATING RULES ARE OWNER-ONLY AND SAVE-ONLY ("ratingRules" flag).
//  #15 LIVE DATA — "dataVersion" action + cache validated against the
//      Sheet's real modified time (rebuilds rate-limited).
//  #16 LOADING / TIMEOUT FIXES (rebuild-stampede fix, batched cache writes,
//      one deferred full sync per 2 min, heartbeat de-dupe).
//  #17 MATCHED TO index.html + SPEED
//      - STALE-ROW GUARD: index.html has always sent expectedBranch /
//        expectedRemark with every remark edit/delete ("refuse instead of
//        overwriting the wrong remark"), but the server ignored them. A
//        delete by one person shifts every row below it, so a second
//        person's stale row number could silently overwrite or delete
//        ANOTHER branch's remark. Now the server checks the row still holds
//        the remark the page saw and refuses (without changing anything)
//        if not.
//      - SHEET WRITE LOCK: remark save/delete (the only writes that shift
//        or depend on row numbers) now run one at a time.
//      - HEARTBEAT CACHE PATCH: every heartbeat used to DELETE the device
//        list caches, so the next heartbeat/My Devices poll re-queried
//        Firestore. The heartbeat now updates its own row inside the
//        cached lists instead (sign-out/remove paths still clear them
//        instantly, so a remote sign-out is never delayed).
//  #18 TIMEOUT / SNAPPINESS FIXES
//      - COLD-CACHE GAP: the dashboard cache lived 15 min but the warmer ran
//        every 10 min, leaving a cold window of up to 5 min in every cycle.
//        The cache now lives 6 h (real freshness is still checked against the
//        Sheet's modified time) and the warmer re-fills it every 2 h.
//      - SAVES NO LONGER THROW AWAY THE WHOLE CACHE: a save marks only the
//        sheet it touched as "dirty"; the next read re-reads JUST that sheet
//        and patches the cached copy (was: re-read all 6 sheets, and read the
//        slow Sheet path because Firestore was behind).
//      - NO MORE 6-SECOND LOCK WAITS: dashboard rebuild and Overall Data
//        rebuild use a cache-based "soft lock" of their own instead of the one
//        script-wide lock (which remark saves and the sync scheduler also use).
//        A request that cannot get the rebuild lock serves the cached copy.
//      - TOKEN CHECK: Identity Toolkit 429 / 5xx replies are no longer treated
//        as "token rejected" (and cached as INVALID); one quick retry on
//        transient failures.
//      - doGet is wrapped so ANY unexpected error still answers valid JSON
//        (an HTML error page is what shows up as a JSON/JSONP failure).
//      - JSONP callback name is validated.
//      - Deferred syncs: a save that arrives while a sync is running can no
//        longer be lost; a failed sheet sync no longer advances the
//        "Firestore is in sync" marker.
//      - Hourly/deferred full sync no longer wipes the (still valid) cache.
//      - Cache reads are batched (getAll is limited to 100 keys per call).
//      - Audit-log read asks Firestore for just the newest entries.
//  #21 TIMEOUT PATCH (this version)
//      - "Update data" (hardReset) serves the cached copy when the spreadsheet
//        has not changed since it was built; a real rebuild is single-flight.
//      - "Update Overall Data": new-month values are written with ONE
//        setValues() per column block (6 writes total) instead of ~6 writes
//        per branch.
//      - Partial-month repair is batched the same way (no per-cell writes).
//      - "Update Overall Data" is guarded by a soft lock so a double-click or
//        two editors cannot insert the same month twice.
//  #23 RATING-RULES SAVE FIX ("my saved settings change again")
//      - Saves are one-at-a-time and read the stored record fresh, so one
//        device's save can no longer write old rules back over the owner's.
//      - The cache is never left holding an older copy after a save.
//      - Versions always increase.
//  #22 LIVE-SHEET SPEED PATCH (scan only when something really changed)
//      - REBUILD NO LONGER DOWNLOADS FIRESTORE JUNK: after an edit Firestore is
//        (almost) always behind, yet the old code still pulled all 6 big
//        snapshot documents (megabytes) before noticing, then threw them away
//        and read the Sheet. Now only the tiny "_sync_meta" document is read
//        first; the big documents are fetched only when Firestore is in sync.
//      - NO TRIGGER CREATION ON A USER'S REQUEST: the first request after an
//        edit used to also create a time trigger (slow). Firestore is now
//        repaired in the background by the 5-minute warmer instead.
//      - WARMER IS CHEAP: it no longer reads + parses the whole cached payload
//        every run just to learn that nothing changed.
//      - OVERALL DATA ONLY RELOADS WHEN OVERALL DATA CHANGED: every in-app save
//        (remarks, assignments, highlights) bumps the whole spreadsheet's
//        modified time, which used to rebuild and re-download Overall Data
//        every time. Now a content fingerprint of just the OVERALL DATA tab is
//        compared; if it is the same, the cached copy is kept and the browser
//        is told {unchanged:true} (a few bytes instead of the whole payload).
//      - diagnoseSpeed(): run it once from the editor to see exactly which
//        step/sheet is slow (see the Execution log).
//  #24 BACKEND PERFORMANCE PASS (behaviour, data, auth, risk logic unchanged)
//      - Warmer no longer downloads + parses the whole cached Overall payload
//        every 5 min just to learn it is warm (tiny-key check, like the dashboard).
//      - Warmer's blocked-account priming = ONE cache getAll + at most ONE
//        batched Firestore read (was one Firestore read per expired account).
//      - Firestore "_sync_meta" read is remembered (cache) once seen in sync, so
//        the 5-min heal check / rebuilds skip that read until the Sheet changes.
//      - A full Sheet read done earlier in the same execution is reused by
//        syncSheetsToFirestore() (warmer: rebuild + heal read the Sheet once).
//        The hourly trigger still does its own full read + full write.
//      - Overall rebuild reuses the range the fingerprint just read (was read twice).
//      - Cached dashboard hit: dirty/version/meta keys fetched in ONE getAll.
//      - Cache removes batched (removeAll); deferred syncs list triggers once;
//        section-header scan and emergency-rotation read done once, not 2-3x.
// #25 CHANGE-AWARE BACKGROUND SYNC
//      - The hourly trigger first checks the verified Firestore sync marker and skips
//        the six-sheet read/write when no data changed; uncertain/pending cases still
//        fall back to the original full sync. Manual and recovery syncs remain unchanged.
//      - Trigger setup for hourly sync and daily cleanup is idempotent, preventing
//        repeated setup runs from creating duplicate background jobs.
// ==========================================================================

// The warmer keeps BOTH caches filled. Besides "fill if empty" it re-fills a
// cache once it is older than WARM_REFRESH_AFTER_MS, so the 6-hour cache TTL
// is never allowed to run out underneath a real user.
const WARM_REFRESH_AFTER_MS = 2 * 60 * 60 * 1000;
const DASH_BUILTAT_KEY = "dash_builtat_v1";
const OVERALL_BUILTAT_KEY = "overall_builtat_v1";

function cacheIsOlderThan(cache, key, maxAgeMs) {
  try {
    const v = Number(cache.get(key));
    if (!v) return true;
    return (Date.now() - v) > maxAgeMs;
  } catch (err) {
    return true;
  }
}

// Primes the "is this account blocked?" cache for every known account so the
// first real request after an idle period doesn't pay a Firestore round trip.
function warmBlockedCaches_() {
  try {
    const emails = getAllKnownEmails();
    if (!emails.length) return;
    const cache = CacheService.getScriptCache();
    const keys = emails.map(blockedCacheKey);
    const got = cache.getAll(keys); // one cache round trip for every account
    const missing = emails.filter(function (em, i) {
      return got[keys[i]] === undefined || got[keys[i]] === null;
    });
    if (!missing.length) return;

    // One batched Firestore read for ALL expired accounts (was one read each).
    let byId = null;
    try {
      const docs = getFirestoreClient().getDocuments(PRESENCE_COLLECTION, missing.map(presenceDocId));
      byId = {};
      (docs || []).forEach(function (doc) {
        const obj = doc && (doc.obj || doc.fields || doc);
        const k = presenceDocId(obj && obj.email);
        if (k) byId[k] = obj;
      });
    } catch (fsErr) {
      byId = null;
    }
    if (byId === null) { // same behaviour as before: per-account path
      missing.forEach(function (em) { isAccountBlocked(em); });
      return;
    }
    const toPut = {};
    missing.forEach(function (em) {
      const doc = byId[presenceDocId(em)];
      toPut[blockedCacheKey(em)] = (doc && doc.blocked === true) ? "1" : "0";
    });
    cache.putAll(toPut, BLOCKED_CACHE_TTL_SECONDS);
  }
  catch (err) { Logger.log("warmBlockedCaches_ failed (non-fatal): " + err); }
}

function warmDashboardCache() {
  const cache = CacheService.getScriptCache();
  warmBlockedCaches_();
  try {
    if (cacheIsOlderThan(cache, DASH_BUILTAT_KEY, WARM_REFRESH_AFTER_MS)) {
      refreshDashboardCacheNow();
      Logger.log("warmDashboardCache: dash_payload_v1 re-filled.");
    } else {
      // #22: decide from the tiny version keys. Only touch the (large) cached
      // payload when something is actually missing, dirty or out of date.
      const warmVer = Number(cache.get(DASH_VER_KEY)) || 0;
      const needsWork = !warmVer ||
                        !cache.get(DASH_CACHE_KEY + ":meta") ||
                        readDirtySheets(cache).length > 0 ||
                        cachedPayloadIsStale(cache, { dataVersion: warmVer });
      if (needsWork) {
        getFreshestDataCached(); // exact same path every real request already uses
        Logger.log("warmDashboardCache: dash_payload_v1 refreshed.");
      } else {
        Logger.log("warmDashboardCache: dash_payload_v1 is warm (nothing changed).");
      }
    }
  } catch (err) {
    Logger.log("warmDashboardCache failed (non-fatal): " + err);
  }
  // Also keep Overall Data warm so it opens instantly after a long idle.
  try {
    if (cacheIsOlderThan(cache, OVERALL_BUILTAT_KEY, WARM_REFRESH_AFTER_MS)) {
      refreshOverallCacheNow();
      Logger.log("warmDashboardCache: overall_payload_v1 re-filled.");
    } else if (overallCacheLooksWarm_()) {
      Logger.log("warmDashboardCache: overall_payload_v1 is warm (nothing changed).");
    } else {
      getOverallDataStructuredCached();
      Logger.log("warmDashboardCache: overall_payload_v1 is warm.");
    }
  } catch (err) {
    Logger.log("warmDashboardCache (overall) failed (non-fatal): " + err);
  }
  // #22: LAST (users are already served from the warm caches above): bring the
  // Firestore snapshot back in line with the Sheet if a manual edit left it behind.
  healFirestoreIfBehind_();
}

const FIRESTORE_HEAL_COOLDOWN_KEY = "firestore_heal_cooldown_v1";
const FIRESTORE_HEAL_COOLDOWN_SECONDS = 240;

// #24: the last "_sync_meta" time actually READ from Firestore. Used only as a
// positive shortcut ("already in sync, skip the read"); a lower/missing value
// always falls back to the real Firestore read, so it can never hide a gap.
const FIRESTORE_SYNCED_CACHE_KEY = "firestore_synced_time_v1";

function rememberFirestoreSynced_(t) {
  try {
    const n = Number(t) || 0;
    if (n > 0) CacheService.getScriptCache().put(FIRESTORE_SYNCED_CACHE_KEY, String(n), RESPONSE_CACHE_TTL_SECONDS);
  } catch (err) { /* non-fatal */ }
}

function cachedFirestoreSynced_() {
  try { return Number(CacheService.getScriptCache().get(FIRESTORE_SYNCED_CACHE_KEY)) || 0; }
  catch (err) { return 0; }
}

function healFirestoreIfBehind_() {
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get(FIRESTORE_HEAL_COOLDOWN_KEY)) return;
    const live = getSheetModifiedTimeFast();
    let synced = cachedFirestoreSynced_();
    if (!(synced >= live)) { // not known to be in sync: ask Firestore (as before)
      const firestore = getFirestoreClient();
      const metaDoc = firestoreDocsToMap_(firestore.getDocuments(FIRESTORE_COLLECTION, [SYNC_META_DOC_ID]))[SYNC_META_DOC_ID];
      synced = metaDoc ? (Number(metaDoc.lastSyncedSheetModifiedTime) || 0) : 0;
      rememberFirestoreSynced_(synced);
    }
    if (live > synced) {
      try { cache.put(FIRESTORE_HEAL_COOLDOWN_KEY, "1", FIRESTORE_HEAL_COOLDOWN_SECONDS); } catch (err) { /* non-fatal */ }
      syncSheetsToFirestore();
      Logger.log("healFirestoreIfBehind_: Firestore snapshot refreshed in the background.");
    }
  } catch (err) {
    Logger.log("healFirestoreIfBehind_ failed (non-fatal): " + err);
  }
}

// Removes duplicate scheduled triggers for one handler before installing its replacement.
// This is only used by explicit setup functions; normal dashboard requests never touch triggers.
function deleteTriggersForHandler_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) {
      try { ScriptApp.deleteTrigger(t); }
      catch (err) { Logger.log("Could not delete duplicate trigger for " + handlerName + ": " + err); }
    }
  });
}

function createDashboardCacheWarmerTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "warmDashboardCache") {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger("warmDashboardCache")
    .timeBased()
    .everyMinutes(DASHBOARD_CACHE_WARMER_INTERVAL_MINUTES)
    .create();
  Logger.log("Dashboard cache warmer trigger created (runs every " + DASHBOARD_CACHE_WARMER_INTERVAL_MINUTES + " min).");
}

// Records WHY verifyFirebaseIdToken() returned null: "quota" / "network"
// when Identity Toolkit couldn't be reached, null when it actively rejected
// the token. Reset by Apps Script on every execution (not a cross-request
// cache).
let _lastTokenVerifyFailureReason = null;

// -------- PRESENCE / "CURRENTLY ACTIVE" — constants + helpers --------

const PRESENCE_COLLECTION = "presence";

// Every email across all allowlists, deduped and lowercased. This is the
// fixed universe of accounts "Currently Active" checks.
function getAllKnownEmails() {
  const set = {};
  EDITOR_EMAILS.concat(QUICKLINKS_ALLOWED_EMAILS, DASHBOARD_VIEW_ALLOWED_EMAILS, ACTIVE_ACCOUNTS_MANAGER_EMAILS, RATING_RULES_EDITOR_EMAILS).forEach(function (email) {
    const key = String(email || "").toLowerCase().trim();
    if (key) set[key] = true;
  });
  return Object.keys(set);
}

function presenceDocId(email) {
  return String(email || "").toLowerCase().trim();
}

// ============================================================
// "MY DEVICES" — per-device presence (self-service sign-out)
// ============================================================
// Separate collection from PRESENCE_COLLECTION: "presence" stays one doc
// per email; "device_presence" adds one doc per (email, deviceId).
const DEVICE_PRESENCE_COLLECTION = "device_presence";

function sanitizeDeviceIdForDocId(deviceId) {
  return String(deviceId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 120);
}

function devicePresenceDocId(email, deviceId) {
  return presenceDocId(email) + "__" + sanitizeDeviceIdForDocId(deviceId);
}

// ---- Device list: server-side filtered query + short cache ----
// TTL 55s: just under index.html's 60s background presence watcher, so the
// whole fleet shares roughly one live Firestore read per window.
const DEVICE_LIST_CACHE_TTL_SECONDS = 55;

function deviceListCacheKey(email) {
  return "deviceListv1_" + presenceDocId(email);
}

function clearDeviceListCache(email) {
  try { CacheService.getScriptCache().remove(deviceListCacheKey(email)); } catch (err) { /* non-fatal */ }
  clearAllDevicePresenceCache();
}

// Lists every device_presence row for ONE account, filtered server-side
// with a Where clause (never truncated by a whole-collection page cap).
function listDevicePresenceForEmail(email) {
  const emailKey = presenceDocId(email);
  const firestore = getFirestoreClient();

  try {
    const docs = firestore.query(DEVICE_PRESENCE_COLLECTION).Where("email", "==", emailKey).Execute() || [];
    return docs.map(function (doc) { return doc.obj || doc.fields || doc; }).filter(Boolean);
  } catch (whereErr) {
    Logger.log("listDevicePresenceForEmail: Where() query failed, falling back to full scan: " + whereErr);
  }

  try {
    const docs = firestore.query(DEVICE_PRESENCE_COLLECTION).Execute() || [];
    return docs
      .map(function (doc) { return doc.obj || doc.fields || doc; })
      .filter(function (d) { return d && presenceDocId(d.email) === emailKey; });
  } catch (err) {
    Logger.log("listDevicePresenceForEmail: fallback full-scan query also failed, returning empty: " + err);
    return [];
  }
}

function listDevicePresenceForEmailCached(email) {
  const cache = CacheService.getScriptCache();
  const key = deviceListCacheKey(email);
  const cached = cache.get(key);
  if (cached !== null) {
    try { return JSON.parse(cached); } catch (err) { /* corrupt entry -- re-fetch */ }
  }
  const rows = listDevicePresenceForEmail(email);
  try { cache.put(key, JSON.stringify(rows), DEVICE_LIST_CACHE_TTL_SECONDS); } catch (err) { /* non-fatal */ }
  return rows;
}

// Full (small) collection scan, for the merged manager view only.
const ALL_DEVICE_PRESENCE_CACHE_KEY = "allDevicePresenceV1";
const ALL_DEVICE_PRESENCE_CACHE_TTL_SECONDS = 55;

function clearAllDevicePresenceCache() {
  try { CacheService.getScriptCache().remove(ALL_DEVICE_PRESENCE_CACHE_KEY); } catch (err) { /* non-fatal */ }
}

function listAllDevicePresence() {
  try {
    const firestore = getFirestoreClient();
    const docs = firestore.query(DEVICE_PRESENCE_COLLECTION).Execute() || [];
    return docs.map(function (doc) { return doc.obj || doc.fields || doc; }).filter(Boolean);
  } catch (err) {
    Logger.log("listAllDevicePresence failed: " + err);
    return [];
  }
}

function listAllDevicePresenceCached() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(ALL_DEVICE_PRESENCE_CACHE_KEY);
  if (cached !== null) {
    try { return JSON.parse(cached); } catch (err) { /* corrupt entry -- re-fetch */ }
  }
  const rows = listAllDevicePresence();
  try { cache.put(ALL_DEVICE_PRESENCE_CACHE_KEY, JSON.stringify(rows), ALL_DEVICE_PRESENCE_CACHE_TTL_SECONDS); } catch (err) { /* non-fatal */ }
  return rows;
}

// #17: after a heartbeat writes its device row, update THAT row inside the
// cached lists (only if a cached list exists) instead of deleting the
// caches. Falls back to the old "clear everything" behaviour on any doubt.
// Sign-out / remove paths still call clearDeviceListCache(), so a remote
// sign-out is still picked up by the very next heartbeat.
function patchDevicePresenceCaches(email, deviceId, fields) {
  try {
    const cache = CacheService.getScriptCache();
    const emailKey = presenceDocId(email);

    function patchOne(cacheKey, ttl) {
      const raw = cache.get(cacheKey);
      if (raw === null) return; // nothing cached -> next reader queries fresh anyway
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows)) { cache.remove(cacheKey); return; }
      let found = false;
      const patched = rows.map(function (d) {
        if (d && String(d.deviceId || "") === deviceId && presenceDocId(d.email) === emailKey) {
          found = true;
          return Object.assign({}, d, fields);
        }
        return d;
      });
      if (!found) patched.push(Object.assign({ email: emailKey, deviceId: deviceId }, fields));
      cache.put(cacheKey, JSON.stringify(patched), ttl);
    }

    patchOne(deviceListCacheKey(email), DEVICE_LIST_CACHE_TTL_SECONDS);
    patchOne(ALL_DEVICE_PRESENCE_CACHE_KEY, ALL_DEVICE_PRESENCE_CACHE_TTL_SECONDS);
  } catch (err) {
    clearDeviceListCache(email); // safe fallback
  }
}

function buildMyDevicesPayload(verifiedUser, myDeviceId) {
  const rows = listDevicePresenceForEmailCached(verifiedUser.email);
  return rows
    .map(function (d) {
      const lastSeenAt = (d.lastSeenAt && !isNaN(Number(d.lastSeenAt))) ? Number(d.lastSeenAt) : null;
      const sessionStartedAt = (d.sessionStartedAt && !isNaN(Number(d.sessionStartedAt))) ? Number(d.sessionStartedAt) : lastSeenAt;
      return {
        deviceId: d.deviceId,
        label: d.deviceLabel || "Unknown device",
        lastSeenAt: lastSeenAt,
        sessionStartedAt: sessionStartedAt,
        current: !!(myDeviceId && d.deviceId === myDeviceId)
      };
    })
    .sort(function (a, b) { return (b.lastSeenAt || 0) - (a.lastSeenAt || 0); });
}

// Stamps forceSignOutAt on ONE of the caller's own devices. The doc id is
// built from verifiedUser.email, so this can only touch the caller's own
// namespace.
function handleSignOutDeviceGet(e, verifiedUser) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const deviceId = String(p.deviceId || "").trim();
    if (!deviceId) {
      return respondJson(e, { error: "Missing deviceId" });
    }

    const firestore = getFirestoreClient();
    const docId = devicePresenceDocId(verifiedUser.email, deviceId);
    upsertDocument(firestore, DEVICE_PRESENCE_COLLECTION + "/" + docId, {
      email: presenceDocId(verifiedUser.email),
      deviceId: deviceId,
      forceSignOutAt: Date.now()
    });
    clearDeviceListCache(verifiedUser.email);
    clearHeartbeatDedupe(verifiedUser.email, deviceId);
    logAuditEvent(verifiedUser.email, "signOutDevice", { deviceId: deviceId });
    return respondJson(e, { success: true, deviceId: deviceId });
  } catch (err) {
    Logger.log("handleSignOutDeviceGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to sign out that device" });
  }
}

// Signs out every device under the caller's account except the calling one.
function handleSignOutAllOtherDevicesGet(e, verifiedUser) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const myDeviceId = String(p.deviceId || "").trim();

    const firestore = getFirestoreClient();
    // Deliberately uncached: a device that just checked in must not be missed.
    const rows = listDevicePresenceForEmail(verifiedUser.email);

    let signedOut = 0;
    rows.forEach(function (d) {
      if (!d || !d.deviceId) return;
      if (myDeviceId && d.deviceId === myDeviceId) return;

      const docId = devicePresenceDocId(verifiedUser.email, d.deviceId);
      try {
        upsertDocument(firestore, DEVICE_PRESENCE_COLLECTION + "/" + docId, {
          email: presenceDocId(verifiedUser.email),
          deviceId: d.deviceId,
          forceSignOutAt: Date.now()
        });
        clearHeartbeatDedupe(verifiedUser.email, d.deviceId);
        signedOut++;
      } catch (err) {
        Logger.log("handleSignOutAllOtherDevicesGet: failed to update " + docId + ": " + err);
      }
    });

    clearDeviceListCache(verifiedUser.email);
    logAuditEvent(verifiedUser.email, "signOutAllOtherDevices", { signedOut: signedOut, exceptDeviceId: myDeviceId });
    return respondJson(e, { success: true, signedOut: signedOut });
  } catch (err) {
    Logger.log("handleSignOutAllOtherDevicesGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to sign out other devices" });
  }
}

// Deletes ONE of the caller's own device rows outright.
function handleRemoveDeviceGet(e, verifiedUser) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const deviceId = String(p.deviceId || "").trim();
    if (!deviceId) {
      return respondJson(e, { error: "Missing deviceId" });
    }

    const firestore = getFirestoreClient();
    const docId = devicePresenceDocId(verifiedUser.email, deviceId);
    try {
      firestore.deleteDocument(DEVICE_PRESENCE_COLLECTION + "/" + docId);
    } catch (err) {
      Logger.log("handleRemoveDeviceGet: delete failed (may already be gone): " + err);
    }
    clearDeviceListCache(verifiedUser.email);
    logAuditEvent(verifiedUser.email, "removeDevice", { deviceId: deviceId });
    return respondJson(e, { success: true, deviceId: deviceId });
  } catch (err) {
    Logger.log("handleRemoveDeviceGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to remove that device" });
  }
}

// Manager-only: delete one device row belonging to a DIFFERENT account.
function handleRemoveAccountDeviceGet(e, actorEmail) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const targetEmail = String(p.email || "").trim();
    const deviceId = String(p.deviceId || "").trim();
    if (!targetEmail || !deviceId) {
      return respondJson(e, { error: "Missing email or deviceId" });
    }

    const firestore = getFirestoreClient();
    const docId = devicePresenceDocId(targetEmail, deviceId);
    try {
      firestore.deleteDocument(DEVICE_PRESENCE_COLLECTION + "/" + docId);
    } catch (err) {
      Logger.log("handleRemoveAccountDeviceGet: delete failed (may already be gone): " + err);
    }
    clearDeviceListCache(targetEmail);
    logAuditEvent(actorEmail, "removeAccountDevice", { target: targetEmail, deviceId: deviceId });
    return respondJson(e, { success: true, email: targetEmail, deviceId: deviceId });
  } catch (err) {
    Logger.log("handleRemoveAccountDeviceGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to remove that device" });
  }
}

// Manager-only: sign out ONE device belonging to a DIFFERENT account.
function handleSignOutAccountDeviceGet(e, actorEmail) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const targetEmail = String(p.email || "").trim();
    const deviceId = String(p.deviceId || "").trim();
    if (!targetEmail || !deviceId) {
      return respondJson(e, { error: "Missing email or deviceId" });
    }

    const firestore = getFirestoreClient();
    const docId = devicePresenceDocId(targetEmail, deviceId);
    upsertDocument(firestore, DEVICE_PRESENCE_COLLECTION + "/" + docId, {
      email: presenceDocId(targetEmail),
      deviceId: deviceId,
      forceSignOutAt: Date.now()
    });
    clearDeviceListCache(targetEmail);
    clearHeartbeatDedupe(targetEmail, deviceId);
    logAuditEvent(actorEmail, "signOutAccountDevice", { target: targetEmail, deviceId: deviceId });
    return respondJson(e, { success: true, email: targetEmail, deviceId: deviceId });
  } catch (err) {
    Logger.log("handleSignOutAccountDeviceGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to sign out that device" });
  }
}

// ============================================================
// DEVICE PRESENCE RETENTION — deletes rows with no heartbeat in
// DEVICE_PRESENCE_RETENTION_DAYS. Run createDailyDevicePresencePurgeTrigger()
// ONCE from the editor to install the daily trigger.
// ============================================================
function purgeStaleDevicePresence() {
  const cutoffMs = Date.now() - (DEVICE_PRESENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const firestore = getFirestoreClient();

  let docs;
  try {
    docs = firestore.query(DEVICE_PRESENCE_COLLECTION).Execute() || [];
  } catch (err) {
    Logger.log("purgeStaleDevicePresence: query failed, nothing to purge: " + err);
    return;
  }

  let deletedCount = 0;
  docs.forEach(function (doc) {
    const data = doc.obj || doc.fields || doc;
    const lastSeenAt = data && Number(data.lastSeenAt);
    if (!data || !lastSeenAt || isNaN(lastSeenAt) || lastSeenAt >= cutoffMs) return;

    const pathStr = doc.path || doc.name || "";
    if (!pathStr) return;
    try {
      firestore.deleteDocument(pathStr);
      deletedCount++;
    } catch (err) {
      Logger.log("purgeStaleDevicePresence: failed to delete " + pathStr + ": " + err);
    }
  });

  Logger.log("purgeStaleDevicePresence: removed " + deletedCount + " stale device row(s) older than " + DEVICE_PRESENCE_RETENTION_DAYS + " days.");
}

function createDailyDevicePresencePurgeTrigger() {
  deleteTriggersForHandler_("purgeStaleDevicePresence");
  ScriptApp.newTrigger("purgeStaleDevicePresence")
    .timeBased()
    .everyDays(1)
    .atHour(4)
    .create();
  Logger.log("Daily device presence purge trigger created (runs ~4am, deletes rows older than " + DEVICE_PRESENCE_RETENTION_DAYS + " days).");
}
// ============================================================
// END "MY DEVICES"
// ============================================================

// ============================================================
// AUDIT LOG — best-effort, never blocks the underlying action
// ============================================================
const AUDIT_LOG_COLLECTION = "audit_log";

function logAuditEvent(actorEmail, action, details) {
  try {
    const firestore = getFirestoreClient();
    const id = Utilities.getUuid();
    const path = AUDIT_LOG_COLLECTION + "/" + id;
    const fields = {
      actor: String(actorEmail || "").toLowerCase().trim(),
      action: action,
      details: JSON.stringify(details || {}),
      at: Date.now(),
      atIso: new Date().toISOString()
    };
    // The id is a fresh UUID, so the document cannot exist yet: create it
    // directly (upsertDocument would first send an update that always fails,
    // i.e. two Firestore calls per audited action). Falls back to the old
    // upsert if the direct create fails for any reason.
    try {
      firestore.createDocument(path, fields);
    } catch (createErr) {
      upsertDocument(firestore, path, fields);
    }
  } catch (err) {
    Logger.log("logAuditEvent failed (non-fatal): " + err);
  }
}

// ---- Heartbeat de-dupe (#16) ----
// A repeat heartbeat from the same device within HEARTBEAT_DEDUPE_SECONDS is
// answered from memory: no Firestore reads or writes. Cleared whenever a
// sign-out is stamped for that device so a remote sign-out is never delayed.
const HEARTBEAT_DEDUPE_SECONDS = 40; // #20: was 15
const PRESENCE_WRITE_SKIP_SECONDS = 60; // #77: account-level presence is already considered active for 2 min; reduce multi-device write contention

function heartbeatDedupeKey(email, deviceId) {
  return "hbv1_" + presenceDocId(email) + "__" + sanitizeDeviceIdForDocId(deviceId || "none");
}

function clearHeartbeatDedupe(email, deviceId) {
  try { CacheService.getScriptCache().remove(heartbeatDedupeKey(email, deviceId)); } catch (err) { /* non-fatal */ }
}

function handleHeartbeatGet(e, verifiedUser) {
  try {
    const docId = presenceDocId(verifiedUser.email);
    const p = (e && e.parameter) ? e.parameter : {};
    const now = Date.now();
    const dedupeCache = CacheService.getScriptCache();
    const dedupeKey = heartbeatDedupeKey(verifiedUser.email, String(p.deviceId || "").trim());

    try {
      if (dedupeCache.get(dedupeKey)) {
        return respondJson(e, { success: true, forceSignOut: false, forceSignOutDevice: false, deduped: true });
      }
    } catch (dedupeErr) { /* non-fatal: just do the normal work */ }

    // Only now is Firestore needed. Creating the client costs an OAuth
    // round trip, which a de-duped heartbeat (answered above) never pays.
    const firestore = getFirestoreClient();

    // Pending forced sign-out? Read via the per-execution memo shared with
    // isAccountBlocked() so this doc is fetched at most once per request.
    let forceSignOut = false;
    let existing = null;
    try {
      existing = getPresenceDocCached(verifiedUser.email);
      if (existing && existing.forceSignOutAt) forceSignOut = true;
    } catch (readErr) {
      Logger.log("handleHeartbeatGet: could not check forceSignOutAt: " + readErr);
    }

    // A session continues while heartbeats land within PRESENCE_ACTIVE_WINDOW_MS
    // of each other; a longer gap starts a new session.
    const prevLastSeen = existing && existing.lastSeenAt ? Number(existing.lastSeenAt) : null;
    const prevSessionStartedAt = existing && existing.sessionStartedAt ? Number(existing.sessionStartedAt) : null;
    const sessionStartedAt = (prevLastSeen && prevSessionStartedAt && (now - prevLastSeen) <= PRESENCE_ACTIVE_WINDOW_MS)
      ? prevSessionStartedAt
      : now;

    // #20: with several devices on one account the account doc was rewritten by
    // every device every beat. Now at most once per PRESENCE_WRITE_SKIP_SECONDS
    // ("active" uses a 2-minute window, so nothing changes on screen). A pending
    // sign-out is never skipped.
    const acctWriteKey = "pwv1_" + docId;
    let skipAcctWrite = false;
    try {
      skipAcctWrite = !forceSignOut && !!dedupeCache.get(acctWriteKey);
    } catch (skipErr) { /* non-fatal: just write */ }
    if (!skipAcctWrite) {
      upsertDocument(firestore, PRESENCE_COLLECTION + "/" + docId, {
        email: verifiedUser.email,
        lastSeenAt: now,
        sessionStartedAt: sessionStartedAt,
        forceSignOutAt: 0
      });
      clearPresenceDocMemo(verifiedUser.email);
      try { dedupeCache.put(acctWriteKey, "1", PRESENCE_WRITE_SKIP_SECONDS); } catch (putErr) { /* non-fatal */ }
    }
    // A valid heartbeat proves the account has an active device even when the
    // account-level Firestore write is intentionally de-duped. Patch only the
    // already-cached list so the UI updates immediately without extra I/O.
    patchActiveAccountPresenceCache_(verifiedUser.email, now, sessionStartedAt);

    // -------- Per-device presence (see "My Devices") --------
    let forceSignOutDevice = false;
    const deviceId = String(p.deviceId || "").trim();
    if (deviceId) {
      const deviceLabel = String(p.deviceLabel || "").trim();
      const deviceDocId = devicePresenceDocId(verifiedUser.email, deviceId);

      // Uses the short-lived cached device list instead of a live read;
      // every path that sets forceSignOutAt busts this cache immediately.
      let existingDevice = null;
      try {
        const cachedDevices = listDevicePresenceForEmailCached(verifiedUser.email);
        existingDevice = (cachedDevices || []).find(function (d) {
          return d && String(d.deviceId || "") === deviceId;
        }) || null;
        if (existingDevice && existingDevice.forceSignOutAt) forceSignOutDevice = true;
      } catch (readErr) {
        Logger.log("handleHeartbeatGet: could not check device forceSignOutAt: " + readErr);
      }

      const prevDeviceLastSeen = existingDevice && existingDevice.lastSeenAt ? Number(existingDevice.lastSeenAt) : null;
      const prevDeviceSessionStartedAt = existingDevice && existingDevice.sessionStartedAt ? Number(existingDevice.sessionStartedAt) : null;
      const deviceSessionStartedAt = (prevDeviceLastSeen && prevDeviceSessionStartedAt && (now - prevDeviceLastSeen) <= PRESENCE_ACTIVE_WINDOW_MS)
        ? prevDeviceSessionStartedAt
        : now;

      try {
        const deviceFields = {
          email: presenceDocId(verifiedUser.email),
          deviceId: deviceId,
          deviceLabel: deviceLabel || "Unknown device",
          lastSeenAt: now,
          sessionStartedAt: deviceSessionStartedAt,
          forceSignOutAt: 0
        };
        upsertDocument(firestore, DEVICE_PRESENCE_COLLECTION + "/" + deviceDocId, deviceFields);
        // #17: patch this row inside the cached lists instead of deleting them.
        patchDevicePresenceCaches(verifiedUser.email, deviceId, deviceFields);
      } catch (writeErr) {
        Logger.log("handleHeartbeatGet: could not upsert device presence (non-fatal): " + writeErr);
      }
    }

    // Remember this heartbeat, but ONLY when no sign-out is pending -- a
    // pending sign-out must be reported again on the next call.
    if (!forceSignOut && !forceSignOutDevice) {
      try { dedupeCache.put(dedupeKey, "1", HEARTBEAT_DEDUPE_SECONDS); } catch (err) { /* non-fatal */ }
    }

    return respondJson(e, { success: true, forceSignOut: forceSignOut, forceSignOutDevice: forceSignOutDevice });
  } catch (err) {
    Logger.log("handleHeartbeatGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to record heartbeat" });
  }
}

// Raw per-account data is cached and `active` is recomputed fresh on every
// request; cleared immediately on block/unblock.
const ACTIVE_USERS_CACHE_KEY = "activeUsersRawV1";
const ACTIVE_USERS_CACHE_TTL_SEC = 55;

function clearActiveUsersCache() {
  try { CacheService.getScriptCache().remove(ACTIVE_USERS_CACHE_KEY); } catch (err) { /* non-fatal */ }
}

// Keep the short-lived active-account cache aligned with a successful heartbeat
// without forcing another Firestore read. If the cache is absent, the normal
// rebuild path remains authoritative. This makes "Who's logged in" recover
// immediately after a heartbeat instead of waiting for the cache TTL.
function patchActiveAccountPresenceCache_(email, lastSeenAt, sessionStartedAt) {
  try {
    const cache = CacheService.getScriptCache();
    const raw = cache.get(ACTIVE_USERS_CACHE_KEY);
    if (!raw) return;
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return;
    const target = presenceDocId(email);
    let found = false;
    rows.forEach(function (row) {
      if (presenceDocId(row && row.email) !== target) return;
      row.lastSeenAt = Number(lastSeenAt) || Date.now();
      row.sessionStartedAt = Number(sessionStartedAt) || row.lastSeenAt;
      found = true;
    });
    if (found) cache.put(ACTIVE_USERS_CACHE_KEY, JSON.stringify(rows), ACTIVE_USERS_CACHE_TTL_SEC);
  } catch (err) { /* non-fatal: Firestore remains authoritative */ }
}

// Used by buildMergedPresenceRows() (manager view of the merged
// "My Devices" + "Who's Logged In" list).
function computeActiveAccountsPayload() {
  const cache = CacheService.getScriptCache();
  let rawAccounts;
  const cached = cache.get(ACTIVE_USERS_CACHE_KEY);
  if (cached) {
    try { rawAccounts = JSON.parse(cached); } catch (parseErr) { rawAccounts = null; }
  }
  if (!rawAccounts) {
    const firestore = getFirestoreClient();
    const knownEmails = getAllKnownEmails();
    const docIds = knownEmails.map(presenceDocId);
    const docs = firestore.getDocuments(PRESENCE_COLLECTION, docIds);

    const byDocId = {};
    docs.forEach(function (doc) {
      const obj = doc.obj || doc.fields || doc;
      if (!obj) return;
      const key = presenceDocId(obj.email);
      if (key) byDocId[key] = obj;
    });

    // One row per KNOWN email, so stale or never-signed-in accounts still show.
    rawAccounts = knownEmails.map(function (email) {
      const obj = byDocId[presenceDocId(email)];
      const lastSeenAt = (obj && obj.lastSeenAt) ? Number(obj.lastSeenAt) : null;
      const sessionStartedAt = (obj && obj.sessionStartedAt && !isNaN(Number(obj.sessionStartedAt))) ? Number(obj.sessionStartedAt) : lastSeenAt;
      return {
        email: (obj && obj.email) || email,
        lastSeenAt: (lastSeenAt && !isNaN(lastSeenAt)) ? lastSeenAt : null,
        sessionStartedAt: sessionStartedAt,
        blocked: !!(obj && obj.blocked === true)
      };
    });

    try { cache.put(ACTIVE_USERS_CACHE_KEY, JSON.stringify(rawAccounts), ACTIVE_USERS_CACHE_TTL_SEC); } catch (cacheErr) { /* non-fatal */ }
  }

  const now = Date.now();
  const accounts = rawAccounts.map(function (a) {
    const active = !!(a.lastSeenAt && (now - a.lastSeenAt) <= PRESENCE_ACTIVE_WINDOW_MS);
    return { email: a.email, lastSeenAt: a.lastSeenAt, sessionStartedAt: a.sessionStartedAt, active: active, blocked: a.blocked };
  });

  accounts.sort(function (a, b) {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
  });

  return { accounts: accounts };
}

// MERGED "My Devices" + "Who's Logged In" VIEW
//   - Non-manager: rows are just your own devices.
//   - Manager: one row per device for every known account; an account with
//     no device rows still gets one row from its account-level presence doc.
function buildMergedPresenceRows(verifiedUser, myDeviceId) {
  const now = Date.now();
  const canManage = isAuthorizedAccountManager(verifiedUser);
  const myEmailKey = presenceDocId(verifiedUser.email);

  if (!canManage) {
    const devices = buildMyDevicesPayload(verifiedUser, myDeviceId);
    const rows = devices.map(function (d) {
      const active = !!(d.lastSeenAt && (now - d.lastSeenAt) <= PRESENCE_ACTIVE_WINDOW_MS);
      return {
        email: verifiedUser.email,
        deviceId: d.deviceId,
        label: d.label,
        lastSeenAt: d.lastSeenAt,
        sessionStartedAt: d.sessionStartedAt,
        active: active,
        blocked: false,
        current: d.current,
        isYou: true
      };
    });
    return { rows: rows, canManage: false, now: now };
  }

  const activePayload = computeActiveAccountsPayload();
  const allDeviceRows = listAllDevicePresenceCached();

  const devicesByEmail = {};
  allDeviceRows.forEach(function (d) {
    const key = presenceDocId(d && d.email);
    if (!key) return;
    if (!devicesByEmail[key]) devicesByEmail[key] = [];
    devicesByEmail[key].push(d);
  });

  const rows = [];
  activePayload.accounts.forEach(function (acct) {
    const key = presenceDocId(acct.email);
    const deviceRows = devicesByEmail[key] || [];

    if (!deviceRows.length) {
      rows.push({
        email: acct.email,
        deviceId: null,
        label: null,
        lastSeenAt: acct.lastSeenAt,
        sessionStartedAt: acct.sessionStartedAt,
        active: acct.active,
        blocked: acct.blocked,
        current: false,
        isYou: key === myEmailKey
      });
      return;
    }

    deviceRows.forEach(function (d) {
      const lastSeenAt = (d.lastSeenAt && !isNaN(Number(d.lastSeenAt))) ? Number(d.lastSeenAt) : null;
      const sessionStartedAt = (d.sessionStartedAt && !isNaN(Number(d.sessionStartedAt))) ? Number(d.sessionStartedAt) : lastSeenAt;
      const active = !!(lastSeenAt && (now - lastSeenAt) <= PRESENCE_ACTIVE_WINDOW_MS);
      rows.push({
        email: acct.email,
        deviceId: d.deviceId,
        label: d.deviceLabel || "Unknown device",
        lastSeenAt: lastSeenAt,
        sessionStartedAt: sessionStartedAt,
        active: active,
        blocked: acct.blocked,
        current: key === myEmailKey && !!myDeviceId && d.deviceId === myDeviceId,
        isYou: key === myEmailKey
      });
    });
  });

  rows.sort(function (a, b) {
    if (a.isYou !== b.isYou) return a.isYou ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
  });

  return { rows: rows, canManage: true, now: now };
}

function handleMyDevicesBundleGet(e, verifiedUser) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const myDeviceId = String(p.deviceId || "").trim();

    const merged = buildMergedPresenceRows(verifiedUser, myDeviceId);

    return respondJson(e, {
      success: true,
      rows: merged.rows,
      canManage: merged.canManage,
      serverNow: merged.now
    });
  } catch (err) {
    Logger.log("handleMyDevicesBundleGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to load devices" });
  }
}

// ============================================================
// Cross-device sync for "Audit Risk & Schedule Analysis"
// (filters, sort, thresholds, risk weights)
//
// The saved state has two parts:
//   VIEW  = ANALYSIS_VIEW_KEYS (search, filters, sort). Any account that
//           may save the analysis (see ANALYSIS_STATE_SCOPE) can change it.
//   RULES = everything else (rating levels, cycles, red flags, numbers,
//           switches, weights, model version). Only an account with the
//           "ratingRules" flag in ACCESS_CONFIG can change it, and only
//           through a request carrying rules=1 (the dashboard sends that
//           only after "Save changes" + password confirmation). Every
//           other save keeps the stored rules exactly as they are.
// ============================================================
const ANALYSIS_STATE_COLLECTION = "shared_settings";
const ANALYSIS_STATE_CACHE_TTL_SECONDS = 5;
const ANALYSIS_DATA_HASH_KEY = "dash_analysis_hash_v1";
const ANALYSIS_STATE_MAX_JSON_CHARS = 4000;
const ANALYSIS_VIEW_KEYS = [
  "filterBucket", "tierFilter", "auditorFilter", "queueFilter", "search",
  "reasonFilter", "distFilter", "driverFilter", "sortField", "sortDir"
];

function isAuthorizedRatingRulesEditor(verifiedUser) {
  const email = verifiedEmailKey(verifiedUser);
  if (!email) return false;
  return RATING_RULES_EDITOR_EMAILS.indexOf(email) !== -1;
}

function analysisStateDocId(verifiedUser) {
  // Exactly one canonical analysis document for the entire dashboard team.
  // Never fall back to a per-user document: that would allow different
  // computers/phones to maintain different saved analysis settings.
  return "audit_analysis__team";
}

function analysisStateCacheKey(docId) {
  return "analysisStatev1_" + docId;
}

// Fingerprint of the exact dashboard inputs used by Audit Risk & Schedule
// Analysis. This is deliberately stored separately from the big dashboard
// cache so a tiny dataVersion request can also prove that two devices are
// looking at the same underlying data, not merely the same modified time.
function computeAnalysisDataHash_(payload) {
  const src = {
    dashboardData: payload && payload.dashboardData || [],
    auditRotation: payload && payload.auditRotation || [],
    auditReport: payload && payload.auditReport || [],
    auditFindings: payload && payload.auditFindings || [],
    auditorsEmergency: payload && payload.auditorsEmergency || [],
    auditData: payload && payload.auditData || []
  };
  const raw = JSON.stringify(src);
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, "");
}

// Returns { version, stateJson, updatedBy }. version 0 = nothing saved yet.
// Firestore ERRORS are deliberately not cached (they throw).
function readAnalysisStateRecord(docId, bypassCache) {
  const cache = CacheService.getScriptCache();
  const key = analysisStateCacheKey(docId);
  const cached = bypassCache ? null : cache.get(key);
  if (cached !== null) {
    try { return JSON.parse(cached); } catch (err) { /* corrupt entry -- re-read */ }
  }

  const firestore = getFirestoreClient();
  const docs = firestore.getDocuments(ANALYSIS_STATE_COLLECTION, [docId]);
  let rec = { version: 0, stateJson: "", updatedBy: "", sourceDataVersion: 0, sourceDataHash: "" };
  if (docs && docs.length) {
    const obj = docs[0].obj || docs[0].fields || docs[0];
    if (obj && obj.stateJson) {
      rec = {
        version: Number(obj.version) || 0,
        stateJson: String(obj.stateJson),
        updatedBy: String(obj.updatedBy || ""),
        sourceDataVersion: Number(obj.sourceDataVersion) || 0,
        sourceDataHash: String(obj.sourceDataHash || "")
      };
    }
  }
  try { cache.put(key, JSON.stringify(rec), ANALYSIS_STATE_CACHE_TTL_SECONDS); } catch (err) { /* non-fatal */ }
  return rec;
}

function handleGetAnalysisStateGet(e, verifiedUser) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const since = Number(p.sinceVersion) || 0;
    const rec = readAnalysisStateRecord(analysisStateDocId(verifiedUser));
    // Tells the dashboard whether THIS account may save rating rules (it
    // greys out "Save changes" otherwise). The server enforces it either way.
    const canEditRules = isAuthorizedRatingRulesEditor(verifiedUser);

    if (rec.version && since === rec.version) {
      return respondJson(e, { success: true, unchanged: true, version: rec.version, sourceDataVersion: rec.sourceDataVersion || 0, sourceDataHash: rec.sourceDataHash || "", canEditRules: canEditRules });
    }
    let state = null;
    if (rec.stateJson) {
      try { state = JSON.parse(rec.stateJson); } catch (err) { state = null; }
    }
    return respondJson(e, { success: true, version: rec.version, sourceDataVersion: rec.sourceDataVersion || 0, sourceDataHash: rec.sourceDataHash || "", state: state, updatedBy: rec.updatedBy, canEditRules: canEditRules });
  } catch (err) {
    Logger.log("handleGetAnalysisStateGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to load analysis view" });
  }
}

// #23: the whole read-merge-write now runs under the script lock and reads the
// STORED record fresh (not from the cache). Before, a "view" save from one
// device could read the old rules just before the owner's rules save landed
// and then write those old rules back over it -- the saved settings came back
// changed. Saves are now strictly one at a time.
function handleSaveAnalysisStateGet(e, verifiedUser) {
  let lock = null;
  let gotLock = false;
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const raw = String(p.state || "");
    if (!raw) return respondJson(e, { error: "Missing state" });
    if (raw.length > ANALYSIS_STATE_MAX_JSON_CHARS) return respondJson(e, { error: "State too large" });

    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) { return respondJson(e, { error: "State is not valid JSON" }); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return respondJson(e, { error: "State must be an object" });
    }

    // Rating rules can only be written by an explicit rules=1 request from
    // a "ratingRules" account. NOTE: the message deliberately says "rating
    // rules" and NOT "unauthorized" -- the dashboard treats "unauthorized"
    // as "this account is view-only" and would wrongly lock the whole view.
    const wantsRules = (p.rules === "1" || p.rules === "true");
    const expectedVersionRaw = String(p.expectedVersion || "").trim();
    if (expectedVersionRaw === "") {
      return respondJson(e, { error: "SYNC_VERSION_REQUIRED: this dashboard client is outdated. Reload the latest dashboard before saving analysis." });
    }
    const expectedVersion = Number(expectedVersionRaw);
    if (!Number.isFinite(expectedVersion) || expectedVersion < 0) {
      return respondJson(e, { error: "Invalid expected version" });
    }

    const sourceDataVersionRaw = String(p.sourceDataVersion || "").trim();
    if (sourceDataVersionRaw === "") {
      return respondJson(e, { error: "SYNC_DATA_VERSION_REQUIRED: refresh the dashboard before saving analysis." });
    }
    const sourceDataVersion = Number(sourceDataVersionRaw);
    if (!Number.isFinite(sourceDataVersion) || sourceDataVersion < 0) {
      return respondJson(e, { error: "Invalid source data version" });
    }
    const sourceDataHash = String(p.sourceDataHash || "").trim();
    if (!sourceDataHash) {
      return respondJson(e, { error: "SYNC_DATA_HASH_REQUIRED: reload the latest dashboard before saving analysis." });
    }
    if (sourceDataHash.length > 128) {
      return respondJson(e, { error: "Invalid source data hash" });
    }
    if (wantsRules && !isAuthorizedRatingRulesEditor(verifiedUser)) {
      return respondJson(e, { error: "Not permitted: only the rating rules owner account can save rating rules." });
    }

    const docId = analysisStateDocId(verifiedUser);

    lock = LockService.getScriptLock();
    try { gotLock = lock.tryLock(8000); } catch (lockErr) { gotLock = false; }
    if (!gotLock) {
      // Deliberately worded so the dashboard just retries (no "unauthorized" / "rating rules").
      return respondJson(e, { error: "The server is busy saving another change. Retrying shortly." });
    }

    let finalState = parsed;
    if (!wantsRules) {
      // View-only save: take the VIEW fields from the request and keep the
      // RULES exactly as already stored. Whatever rule values the browser
      // sent along are ignored.
      const stored = readAnalysisStateRecord(docId, true);
      let storedState = null;
      if (stored && stored.stateJson) {
        try { storedState = JSON.parse(stored.stateJson); } catch (err) { storedState = null; }
      }

      const merged = {};
      ANALYSIS_VIEW_KEYS.forEach(function (k) {
        if (parsed[k] !== undefined) merged[k] = parsed[k];
      });
      if (storedState && typeof storedState === "object" && !Array.isArray(storedState)) {
        Object.keys(storedState).forEach(function (k) {
          if (ANALYSIS_VIEW_KEYS.indexOf(k) === -1) merged[k] = storedState[k];
        });
      } else if (parsed.modelVersion !== undefined) {
        // Nothing saved yet: keep only the model version so devices don't
        // mistake this record for an out-of-date one. No rule values.
        merged.modelVersion = parsed.modelVersion;
      }
      finalState = merged;
    }

    const stateJson = JSON.stringify(finalState);

    // The analysis must be tied to the exact dashboard data version the user
    // saw. A device with stale cached Sheet data is not allowed to publish
    // analysis settings into the canonical team state.
    // Validate against the SAME canonical dashboard cache used for all devices.
    // This catches the case where two payloads accidentally have the same file
    // modified time but different contents, and it prevents a stale device from
    // publishing analysis settings against old local data.
    let canonicalData = null;
    try { canonicalData = getFreshestDataCached(); } catch (err) {
      return respondJson(e, { error: "SYNC_DATA_UNAVAILABLE: refresh the dashboard and try the analysis save again." });
    }
    const currentDataVersion = Number(canonicalData && canonicalData.dataVersion) || Number(getSheetModifiedTimeFast(true)) || 0;
    const currentDataHash = String(canonicalData && canonicalData.analysisDataHash || "");
    if (sourceDataVersion !== currentDataVersion || !currentDataHash || sourceDataHash !== currentDataHash) {
      return respondJson(e, {
        error: "SYNC_DATA_STALE: the dashboard data changed before this analysis was saved. Refresh the dashboard and reopen Analysis.",
        staleData: true,
        currentDataVersion: currentDataVersion,
        currentDataHash: currentDataHash
      });
    }

    // Strictly increasing, so a later save can never look "older" than an earlier one.
    const prev = readAnalysisStateRecord(docId, true);
    const currentVersion = (prev && prev.version) ? Number(prev.version) : 0;
    if (expectedVersion !== null && expectedVersion !== currentVersion) {
      let conflictState = null;
      if (prev && prev.stateJson) { try { conflictState = JSON.parse(prev.stateJson); } catch (err) { conflictState = null; } }
      return respondJson(e, {
        error: "SYNC_CONFLICT: this analysis changed on another device before your save. The newer server copy was kept.",
        conflict: true,
        version: currentVersion,
        sourceDataVersion: prev && prev.sourceDataVersion ? Number(prev.sourceDataVersion) : 0,
        sourceDataHash: prev && prev.sourceDataHash ? String(prev.sourceDataHash) : "",
        state: conflictState,
        updatedBy: prev && prev.updatedBy ? String(prev.updatedBy) : ""
      });
    }
    const version = Math.max(Date.now(), currentVersion + 1);

    const firestore = getFirestoreClient();
    upsertDocument(firestore, ANALYSIS_STATE_COLLECTION + "/" + docId, {
      stateJson: stateJson,
      version: version,
      updatedBy: presenceDocId(verifiedUser.email),
      sourceDataVersion: sourceDataVersion,
      sourceDataHash: sourceDataHash,
      updatedAtIso: new Date().toISOString()
    });

    // Never leave an OLD copy in the cache after a successful write.
    try {
      CacheService.getScriptCache().put(
        analysisStateCacheKey(docId),
        JSON.stringify({ version: version, stateJson: stateJson, updatedBy: presenceDocId(verifiedUser.email), sourceDataVersion: sourceDataVersion, sourceDataHash: sourceDataHash }),
        ANALYSIS_STATE_CACHE_TTL_SECONDS
      );
    } catch (cacheErr) {
      try { CacheService.getScriptCache().remove(analysisStateCacheKey(docId)); } catch (e2) { /* non-fatal */ }
    }

    if (wantsRules) {
      logAuditEvent(verifiedUser.email, "saveRatingRules", { version: version });
    }

    return respondJson(e, { success: true, version: version, rulesSaved: wantsRules, sourceDataVersion: sourceDataVersion, sourceDataHash: sourceDataHash, state: finalState, updatedBy: presenceDocId(verifiedUser.email) });
  } catch (err) {
    Logger.log("handleSaveAnalysisStateGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to save analysis view" });
  } finally {
    if (gotLock && lock) { try { lock.releaseLock(); } catch (relErr) { /* non-fatal */ } }
  }
}
// ============================================================
// END analysis-state helpers
// ============================================================

// -------- ACCOUNT BLOCK / FORCE SIGN-OUT --------
// Reuses the one-doc-per-email "presence" doc. Extra fields:
//   - blocked: true/false (checked on EVERY authenticated request)
//   - forceSignOutAt: stamped by a manager; the target's next heartbeat
//     sees it, signs out locally, and the flag is cleared.

// Per-EXECUTION memo (reset by Apps Script on every invocation) so the same
// presence doc is never fetched twice within one request.
let _memoizedPresenceDocsByEmail = {};

function getPresenceDocCached(email) {
  const key = presenceDocId(email);
  if (Object.prototype.hasOwnProperty.call(_memoizedPresenceDocsByEmail, key)) {
    return _memoizedPresenceDocsByEmail[key];
  }
  const doc = getPresenceDoc(email);
  _memoizedPresenceDocsByEmail[key] = doc;
  return doc;
}

function clearPresenceDocMemo(email) {
  const key = presenceDocId(email);
  delete _memoizedPresenceDocsByEmail[key];
}

function getPresenceDoc(email) {
  try {
    const firestore = getFirestoreClient();
    const docId = presenceDocId(email);
    const docs = firestore.getDocuments(PRESENCE_COLLECTION, [docId]);
    if (!docs || !docs.length) return null;
    return docs[0].obj || docs[0].fields || docs[0];
  } catch (err) {
    Logger.log("getPresenceDoc failed for " + email + ": " + err);
    return null;
  }
}

// Blocked-status cache. TTL 600s: one fewer Firestore round trip on most
// requests, and the warmer re-primes it every few minutes. Busted instantly
// for the TARGET on block/unblock via clearBlockedCache(), so a block still
// takes effect immediately.
function blockedCacheKey(email) {
  return "blockedv1_" + presenceDocId(email);
}

const BLOCKED_CACHE_TTL_SECONDS = 600;

function isAccountBlocked(email) {
  const cache = CacheService.getScriptCache();
  const key = blockedCacheKey(email);
  const cached = cache.get(key);
  if (cached !== null) return cached === "1";

  const doc = getPresenceDocCached(email);
  const blocked = !!(doc && doc.blocked === true);
  try { cache.put(key, blocked ? "1" : "0", BLOCKED_CACHE_TTL_SECONDS); } catch (err) { /* non-fatal */ }
  return blocked;
}

function clearBlockedCache(email) {
  try { CacheService.getScriptCache().remove(blockedCacheKey(email)); } catch (err) { /* non-fatal */ }
  clearPresenceDocMemo(email);
}

function handleBlockAccountGet(e, blocked, actorEmail) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const targetEmail = String(p.email || "").trim();
    if (!targetEmail) {
      return respondJson(e, { error: "Missing email" });
    }
    const firestore = getFirestoreClient();
    const docId = presenceDocId(targetEmail);
    upsertDocument(firestore, PRESENCE_COLLECTION + "/" + docId, {
      email: targetEmail,
      blocked: blocked
    });
    clearBlockedCache(targetEmail);
    clearActiveUsersCache();
    logAuditEvent(actorEmail, blocked ? "blockAccount" : "unblockAccount", { target: targetEmail });
    return respondJson(e, { success: true, email: targetEmail, blocked: blocked });
  } catch (err) {
    Logger.log("handleBlockAccountGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to update block status" });
  }
}

function handleForceSignOutAccountGet(e, actorEmail) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const targetEmail = String(p.email || "").trim();
    if (!targetEmail) {
      return respondJson(e, { error: "Missing email" });
    }
    const firestore = getFirestoreClient();
    const docId = presenceDocId(targetEmail);
    upsertDocument(firestore, PRESENCE_COLLECTION + "/" + docId, {
      email: targetEmail,
      forceSignOutAt: Date.now()
    });
    clearPresenceDocMemo(targetEmail);
    // A pending account-level sign-out must be seen by the target's very
    // next heartbeat, so drop any heartbeat de-dupe entries for that account.
    try {
      listDevicePresenceForEmail(targetEmail).forEach(function (d) {
        if (d && d.deviceId) clearHeartbeatDedupe(targetEmail, d.deviceId);
      });
      clearHeartbeatDedupe(targetEmail, "");
    } catch (dedupeErr) { /* non-fatal */ }
    logAuditEvent(actorEmail, "forceSignOutAccount", { target: targetEmail });
    return respondJson(e, { success: true, email: targetEmail });
  } catch (err) {
    Logger.log("handleForceSignOutAccountGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to sign out account" });
  }
}
// -------- END ACCOUNT BLOCK / FORCE SIGN-OUT --------

// Per-EXECUTION memo of the main spreadsheet handle (script-level variable,
// reset by Apps Script on every invocation, so never stale across requests).
// openById() is a slow service call; several code paths used to repeat it
// within one request (e.g. Overall fingerprint + Overall build, the warmer,
// the deferred sync loop). Reading/writing through the same handle is
// consistent, so reuse within one execution is safe.
let _memoizedSpreadsheet = null;
function getSpreadsheet_() {
  if (!_memoizedSpreadsheet) _memoizedSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  return _memoizedSpreadsheet;
}

const SHEET_NAMES = [
  "AUDIT DATA (FINAL)",
  "AUDIT ROTATION (FINAL)",
  "AUDITORS EMERGENCY",
  "DASHBOARDDATA",
  "AUDIT REPORT",
  "AUDIT FINDINGS"
];

const SHEET_KEY_MAP = {
  "AUDIT DATA (FINAL)": "auditData",
  "AUDIT ROTATION (FINAL)": "auditRotation",
  "AUDITORS EMERGENCY": "auditorsEmergency",
  "DASHBOARDDATA": "dashboardData",
  "AUDIT REPORT": "auditReport",
  "AUDIT FINDINGS": "auditFindings"
};

const FIRESTORE_COLLECTION = "sheet_snapshots";
const SYNC_META_DOC_ID = "_sync_meta";
// 6 h (the CacheService maximum). Freshness does NOT depend on the TTL: every
// read compares the cached copy against the Sheet's real modified time, every
// in-app save marks its sheet dirty (see invalidateSheetInCache), and the
// warmer re-fills the cache every 2 h so it can never run out under a user.
// (Was 900 s with a 10-min warmer = a cold window of up to 5 min each cycle.)
const RESPONSE_CACHE_TTL_SECONDS = 21600;
const OVERALL_DATA_CACHE_TTL_SECONDS = 21600;
const TOKEN_CACHE_TTL_SECONDS = 900;
// Health is a diagnostic snapshot, not the freshness authority. Keep it very
// short-lived so several tabs opening together reuse one Sheet-modified-time
// lookup without making an edit sit stale for long.
const HEALTH_CACHE_TTL_SECONDS = 8;
// #16: was 10000. Shorter wait; a request that still has no lock serves the
// cached copy instead of rebuilding (see getFreshestDataCached()).
const CACHE_LOCK_WAIT_MS = 6000;

const AUDIT_DATA_SHEET_NAME = "AUDIT DATA (FINAL)";
const ROTATION_ROUND_COUNT = 4;
// Fixed column for the Assignment Branches Overview row-highlight dots
// (Column AX). If AX ever moves, also update index.html's
// adfHighlightColIdx fallback (0-based twin, currently 49).
const AUDIT_DATA_HIGHLIGHT_COL = 50; // Column AX
// Expected-date / rotation / up-next columns are resolved from the row-4
// header text — see resolveAuditDataFinalColumns() below.

const AUDIT_REPORT_SHEET_NAME = "AUDIT REPORT";
const AUDIT_REPORT_BRANCH_COL = 1;
const AUDIT_REPORT_AUDITOR_COL = 2;
const AUDIT_REPORT_REMARK_COL = 3;

const QUICK_LINKS = [
  { id: "data",        label: "AUDIT DATA",             url: "https://docs.google.com/spreadsheets/d/1_5VBVpcHYpdRIuEWLg5Rry-BIgWq8bJiVQZZHRNM05k/edit", requireRealClick: true },
  { id: "accounts",    label: "AUDIT AUDITED ACCOUNTS", url: "https://docs.google.com/spreadsheets/d/19U6AfFdkirKnlDK2Xj8FJb6rcPEz44RcbdbxiJNJheU/edit", requireRealClick: true },
  { id: "sheets",      label: "AUDIT SHEETS",           url: "https://docs.google.com/spreadsheets/d/1lYL15dFpM6Ic3HlG1uiAh71DWjUucWOIk_aqmr95fBw/edit", requireRealClick: true },
  { id: "personnel",   label: "PERSONNEL",              url: "https://docs.google.com/spreadsheets/d/1eAX9Imva0Do6_qtdrkU_gXtD66vUwll3/edit", requireRealClick: true },
  { id: "auditreport", label: "AUDIT FOLDER",           url: "https://drive.google.com/drive/folders/1wu4kj1EnytoxQr-MFsltuqByxcIrSiEr", appendAuthUser: false, requireRealClick: true }
];

// Lower-cased, trimmed email of a verified Firebase user ("" if missing).
function verifiedEmailKey(verifiedUser) {
  return verifiedUser && verifiedUser.email ? String(verifiedUser.email).toLowerCase().trim() : "";
}

function isAuthorizedEditor(verifiedUser) {
  const email = verifiedEmailKey(verifiedUser);
  if (!email) return false;
  return EDITOR_EMAILS.indexOf(email) !== -1;
}

function isAuthorizedQuickLink(verifiedUser) {
  const email = verifiedEmailKey(verifiedUser);
  if (!email) return false;
  return QUICKLINKS_ALLOWED_EMAILS.indexOf(email) !== -1;
}

function isAuthorizedViewer(verifiedUser) {
  const email = verifiedEmailKey(verifiedUser);
  if (!email) return false;
  return DASHBOARD_VIEW_ALLOWED_EMAILS.indexOf(email) !== -1;
}

// Gate for managing OTHER accounts (Block / Unblock / Force sign-out).
function isAuthorizedAccountManager(verifiedUser) {
  const email = verifiedEmailKey(verifiedUser);
  if (!email) return false;
  return ACTIVE_ACCOUNTS_MANAGER_EMAILS.indexOf(email) !== -1;
}

function sheetNameToDocId(name) {
  if (!name) return "";
  return name.toString().toLowerCase();
}

function normalizeBranchNameForMatch(name) {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ------------------------------------------------------------
// diagnoseAuth — dispatched from doGet() BEFORE the shared-secret gate.
// This is the one diagnostic whose entire job is telling the caller when
// the secret is wrong, so it can never itself be blocked by a wrong secret.
// It never echoes back the actual secret or token contents — only booleans
// and short status strings.
// ------------------------------------------------------------
function handleDiagnoseAuthGet(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  const props = PropertiesService.getScriptProperties();

  const expectedSecret = props.getProperty("API_SHARED_SECRET");
  const providedSecret = p.secret || null;
  const secretConfigured = !!expectedSecret;
  const secretMatches = !!(expectedSecret && providedSecret === expectedSecret);

  const apiKeyConfigured = !!props.getProperty("FIREBASE_WEB_API_KEY");

  const idToken = p.idToken || null;
  let tokenVerification = "NO_TOKEN";
  let tokenVerificationDetail = "No idToken was supplied with this request.";
  let verifiedEmail = null;

  if (idToken) {
    const verifiedUser = verifyFirebaseIdToken(idToken);
    if (verifiedUser) {
      tokenVerification = "OK";
      tokenVerificationDetail = "";
      verifiedEmail = verifiedUser.email;
    } else if (!apiKeyConfigured) {
      tokenVerification = "NO_API_KEY";
      tokenVerificationDetail = "FIREBASE_WEB_API_KEY is not set in Script Properties, so the token could not be checked at all.";
    } else if (_lastTokenVerifyFailureReason === "quota") {
      tokenVerification = "QUOTA";
      tokenVerificationDetail = "Identity Toolkit's shared daily request limit was reached — this is temporary and unrelated to this specific token.";
    } else if (_lastTokenVerifyFailureReason === "network") {
      tokenVerification = "NETWORK";
      tokenVerificationDetail = "Identity Toolkit could not be reached (network-level failure) — this says nothing about whether the token itself is valid.";
    } else {
      tokenVerification = "REJECTED";
      tokenVerificationDetail = "Identity Toolkit was reached and rejected the token (invalid, expired, or from the wrong Firebase project).";
    }
  }

  return respondJson(e, {
    success: true,
    diagnosis: {
      secretConfigured: secretConfigured,
      secretMatches: secretMatches,
      firebaseWebApiKeyConfigured: apiKeyConfigured,
      tokenVerification: tokenVerification,
      tokenVerificationDetail: tokenVerificationDetail,
      verifiedEmail: verifiedEmail
    }
  });
}

// #18: every request goes through this wrapper so ANY unexpected error (a
// Google service hiccup, a daily quota, a bug) still answers valid JSON. An
// uncaught exception makes Apps Script return an HTML error page, which the
// dashboard's JSONP loader reports as a JSON / script failure.
function doGet(e) {
  const startedAt = Date.now();
  const action = String(e && e.parameter && e.parameter.action || "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  try {
    return doGetInner_(e);
  } catch (err) {
    const msg = String((err && err.message) || err);
    Logger.log("doGet unhandled error (action=" + action + "): " + msg + ((err && err.stack) ? "\n" + err.stack : ""));
    const friendly = /too many times|quota|limit exceeded|rate limit|service invoked/i.test(msg)
      ? "The dashboard is temporarily at capacity (a Google rate or daily limit was reached). Please try again in a few minutes."
      : "The server hit a temporary problem. Please try again in a moment.";
    try {
      return respondJson(e, { error: friendly });
    } catch (err2) {
      return ContentService.createTextOutput(JSON.stringify({ error: friendly })).setMimeType(ContentService.MimeType.JSON);
    }
  } finally {
    // Makes slow-but-completed requests visible in Apps Script execution logs.
    // Do not log tokens, emails, remark text, or other request parameters.
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 4000) Logger.log("[PERF] slow doGet action=" + action + " durationMs=" + elapsed);
  }
}

function healthCacheKey_(email) {
  return "health_v1_" + hashToken(String(email || "").toLowerCase().trim() || "anonymous");
}

function getHealthSnapshotCached_(verifiedUser, forceFresh) {
  const cache = CacheService.getScriptCache();
  const key = healthCacheKey_(verifiedUser && verifiedUser.email);
  if (!forceFresh) {
    try {
      const raw = cache.get(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.dataVersion) return parsed;
      }
    } catch (err) { /* fall through to live check */ }
  }

  const dataVersion = getSheetModifiedTimeFast(!!forceFresh);
  const snapshot = {
    dataVersion: dataVersion,
    canEdit: isAuthorizedEditor(verifiedUser),
    serverTime: Date.now()
  };
  try { cache.put(key, JSON.stringify(snapshot), HEALTH_CACHE_TTL_SECONDS); } catch (err) { /* non-fatal */ }
  return snapshot;
}

function doGetInner_(e) {
  const action = e && e.parameter ? e.parameter.action : null;

  // "ping": a do-nothing request the browser sends to WAKE this backend
  // after the app has been idle. Dispatched first, before any secret /
  // token / Firestore work, so it answers as fast as possible and reveals
  // nothing. See index.html's wakeBackendIfIdle().
  if (action === "ping") {
    return respondJson(e, { success: true, pong: Date.now() });
  }

  // Dispatched BEFORE the shared-secret gate below — see
  // handleDiagnoseAuthGet()'s comment for why.
  if (action === "diagnoseAuth") {
    return handleDiagnoseAuthGet(e);
  }

  const props = PropertiesService.getScriptProperties();
  const expectedSecret = props.getProperty("API_SHARED_SECRET");
  const providedSecret = e && e.parameter ? e.parameter.secret : null;

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return respondJson(e, { error: "Unauthorized" });
  }

  const idToken = e && e.parameter ? e.parameter.idToken : null;
  const verifiedUser = verifyFirebaseIdToken(idToken);
  if (!verifiedUser) {
    // Never tell the user to sign in again when verification only failed due
    // to a transient Google service problem or another request being in flight.
    if (_lastTokenVerifyFailureReason === "quota") {
      return respondJson(e, { error: "The dashboard is temporarily at capacity (a shared daily request limit was reached). This isn't a problem with your account or sign-in — please try again in a few minutes." });
    }
    if (_lastTokenVerifyFailureReason === "network") {
      return respondJson(e, { error: "The server hit a temporary problem. Please try again in a moment." });
    }
    return respondJson(e, { error: "Unauthorized" });
  }

  // Block check: locks a blocked account out of EVERY action.
  if (isAccountBlocked(verifiedUser.email)) {
    return respondJson(e, { error: "This account has been blocked from the dashboard. Contact an admin if you believe this is a mistake." });
  }

  // One authenticated health read replaces separate Sheet + editor probes.
  // The client shares this response so startup cannot stampede Apps Script.
  if (action === "health") {
    try {
      const forceFresh = e && e.parameter && (e.parameter.fresh === "1" || e.parameter.fresh === "true");
      const snapshot = getHealthSnapshotCached_(verifiedUser, !!forceFresh);
      return respondJson(e, {
        success: true,
        dataVersion: snapshot.dataVersion,
        canEdit: !!snapshot.canEdit,
        serverTime: Date.now(),
        healthCached: !forceFresh
      });
    } catch (err) {
      Logger.log("health failed: " + err);
      return respondJson(e, { error: "Health check could not read the live Sheet." });
    }
  }

  if (action === "open") {
    if (!isAuthorizedQuickLink(verifiedUser)) {
      return HtmlService.createHtmlOutput("<h3>Access denied</h3><p>Not authorized.</p>");
    }
    return handleQuickLinkOpen(e, verifiedUser);
  }

  if (action === "list") {
    if (!isAuthorizedQuickLink(verifiedUser)) {
      return respondJson(e, { error: "Not authorized" });
    }
    return handleQuickLinkList(e);
  }

  // Cheap pre-check before opening the Edit Assignment password gate.
  if (action === "checkEditorAuth") {
    if (!isAuthorizedEditor(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to edit assignments." });
    }
    return respondJson(e, { success: true });
  }

  if (action === "saveAssignment") {
    if (!isAuthorizedEditor(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to edit assignments." });
    }
    return handleSaveAssignmentGet(e, verifiedUser.email);
  }

  if (action === "saveHighlight") {
    if (!isAuthorizedEditor(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to edit branch highlights." });
    }
    return handleSaveHighlightGet(e, verifiedUser.email);
  }

  if (action === "saveAuditorRemark") {
    if (!isAuthorizedEditor(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to edit remarks." });
    }
    return handleSaveAuditorRemarkGet(e, verifiedUser.email);
  }

  if (action === "deleteAuditorRemark") {
    if (!isAuthorizedEditor(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to delete remarks." });
    }
    return handleDeleteAuditorRemarkGet(e, verifiedUser.email);
  }

  if (action === "saveEmergencyAuditor") {
    if (!isAuthorizedEditor(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to set the emergency auditor." });
    }
    return handleSaveEmergencyAuditorGet(e, verifiedUser.email);
  }

  if (action === "saveEmergencyRotation") {
    if (!isAuthorizedEditor(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to edit the emergency rotation." });
    }
    return handleSaveEmergencyRotationGet(e, verifiedUser.email);
  }

  // #21: guarded by a soft lock so a double-click or two editors can't run
  // two updates at once (each would insert the same month's columns).
  if (action === "updateOverallData") {
    if (!isAuthorizedEditor(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to update Overall Data." });
    }
    const updLock = trySoftLock("overall_update", 300, 0);
    if (!updLock) {
      return respondJson(e, { error: "Overall Data is already being updated by someone else. Please wait a minute and try again." });
    }
    try {
      const result = updateOverallDataWithLatestMonth();
      logAuditEvent(verifiedUser.email, "updateOverallData", { message: result && result.message });
      return respondJson(e, result);
    } catch (err) {
      Logger.log("updateOverallDataWithLatestMonth failed: " + err);
      return respondJson(e, { error: (err && err.message) ? err.message : "Failed to update Overall Data." });
    } finally {
      softUnlock(updLock);
    }
  }

  if (action === "overallData") {
    if (!isAuthorizedViewer(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to view this dashboard." });
    }
    try {
      // #22: the browser sends the fingerprint of the copy it already shows.
      // If OVERALL DATA has not changed, answer with a few bytes, not the payload.
      const sinceFp = e && e.parameter ? String(e.parameter.sinceFp || "") : "";
      const fastFp = overallUnchangedFast_(sinceFp);
      if (fastFp) return respondJson(e, { success: true, unchanged: true, fp: fastFp });
      const result = getOverallDataStructuredCached();
      if (sinceFp && result && result.fp && result.fp === sinceFp) {
        return respondJson(e, { success: true, unchanged: true, fp: result.fp });
      }
      return respondJson(e, result);
    } catch (err) {
      Logger.log("getOverallDataStructuredCached failed: " + err);
      return respondJson(e, { error: (err && err.message) ? err.message : "Failed to load Overall Data." });
    }
  }

  if (action === "heartbeat") {
    if (!isAuthorizedViewer(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized" });
    }
    return handleHeartbeatGet(e, verifiedUser);
  }

  if (action === "blockAccount") {
    if (!isAuthorizedAccountManager(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to block accounts." });
    }
    return handleBlockAccountGet(e, true, verifiedUser.email);
  }

  if (action === "unblockAccount") {
    if (!isAuthorizedAccountManager(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to unblock accounts." });
    }
    return handleBlockAccountGet(e, false, verifiedUser.email);
  }

  if (action === "forceSignOutAccount") {
    if (!isAuthorizedAccountManager(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to sign out other accounts." });
    }
    return handleForceSignOutAccountGet(e, verifiedUser.email);
  }

  // -------- "My Devices" (self-service, own account only) --------
  if (action === "myDevicesBundle") {
    if (!isAuthorizedViewer(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to view this dashboard." });
    }
    return handleMyDevicesBundleGet(e, verifiedUser);
  }

  if (action === "signOutDevice") {
    if (!isAuthorizedViewer(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to view this dashboard." });
    }
    return handleSignOutDeviceGet(e, verifiedUser);
  }

  if (action === "signOutAllOtherDevices") {
    if (!isAuthorizedViewer(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to view this dashboard." });
    }
    return handleSignOutAllOtherDevicesGet(e, verifiedUser);
  }

  // Manager-only: sign out ONE device on a DIFFERENT account.
  if (action === "signOutAccountDevice") {
    if (!isAuthorizedAccountManager(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to sign out other accounts' devices." });
    }
    return handleSignOutAccountDeviceGet(e, verifiedUser.email);
  }

  if (action === "removeDevice") {
    if (!isAuthorizedViewer(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to view this dashboard." });
    }
    return handleRemoveDeviceGet(e, verifiedUser);
  }

  if (action === "removeAccountDevice") {
    if (!isAuthorizedAccountManager(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to remove other accounts' devices." });
    }
    return handleRemoveAccountDeviceGet(e, verifiedUser.email);
  }

  // -------- Audit Risk & Schedule Analysis view sync --------
  if (action === "getAnalysisState") {
    if (!isAuthorizedViewer(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to view this dashboard." });
    }
    return handleGetAnalysisStateGet(e, verifiedUser);
  }

  if (action === "saveAnalysisState") {
    // "account" scope: any viewer may save THEIR OWN view.
    // "team" scope: one shared view, so only editors may change it.
    // Either way, the RATING RULES inside it can only be changed by a
    // "ratingRules" account (checked in handleSaveAnalysisStateGet).
    const canSave = (ANALYSIS_STATE_SCOPE === "team")
      ? isAuthorizedEditor(verifiedUser)
      : isAuthorizedViewer(verifiedUser);
    if (!canSave) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to change the shared analysis view." });
    }
    return handleSaveAnalysisStateGet(e, verifiedUser);
  }

  // Tiny change detector for live sync: just the Sheet's last-modified time.
  if (action === "dataVersion") {
    if (!isAuthorizedViewer(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to view this dashboard." });
    }
    try {
      const fresh = e && e.parameter && (e.parameter.fresh === "1" || e.parameter.fresh === "true");
      const dataVersion = getSheetModifiedTimeFast(!!fresh);
      let analysisDataHash = "";
      try { analysisDataHash = String(CacheService.getScriptCache().get(ANALYSIS_DATA_HASH_KEY) || ""); } catch (err) { /* non-fatal */ }
      return respondJson(e, { success: true, dataVersion: dataVersion, analysisDataHash: analysisDataHash, serverTime: Date.now() });
    } catch (err) {
      Logger.log("dataVersion failed: " + err);
      return respondJson(e, { error: "Failed to read data version." });
    }
  }

  // Editor-only: most recent audit_log entries.
  if (action === "auditLog") {
    if (!isAuthorizedEditor(verifiedUser)) {
      return respondJson(e, { error: "Unauthorized: your account is not permitted to view the audit log." });
    }
    try {
      return respondJson(e, getRecentAuditLog(e));
    } catch (err) {
      Logger.log("getRecentAuditLog failed: " + err);
      return respondJson(e, { error: (err && err.message) ? err.message : "Failed to load audit log." });
    }
  }

  if (!isAuthorizedViewer(verifiedUser)) {
    return respondJson(e, { error: "Unauthorized: your account is not permitted to view this dashboard." });
  }

  // Hard reset: only sent by a manual "Update Data" click.
  const hardReset = e && e.parameter && (e.parameter.hardReset === "1" || e.parameter.hardReset === "true");

  if (!hardReset) {
    const rawDash = tryServeDashboardRaw_(); // #20
    if (rawDash !== null) return respondRawJson_(e, rawDash);
  }

  let result;
  try {
    result = hardReset ? getFreshestDataForced(true) : getFreshestDataCached();
  } catch (err) {
    Logger.log("getFreshestData() failed: " + err);
    return respondJson(e, { error: "Failed to load data" });
  }

  // Perf: when this request just stored `result` in the cache, its JSON text
  // already exists: send it instead of stringifying the same object again.
  // Byte-identical to respondJson() (same JSON.stringify, same JSONP wrapping).
  const storedJson = dashJsonFor_(result);
  if (storedJson !== null) return respondRawJson_(e, storedJson);

  return respondJson(e, result);
}

function handleQuickLinkList(e) {
  const safeList = QUICK_LINKS.map(function (l) { return { id: l.id, label: l.label }; });
  return respondJson(e, { success: true, links: safeList });
}

function handleQuickLinkOpen(e, verifiedUser) {
  const id = e && e.parameter ? e.parameter.id : null;
  const match = QUICK_LINKS.filter(function (l) { return l.id === id; })[0];
  if (!match) {
    return HtmlService.createHtmlOutput("<h3>Link not found</h3>");
  }

  let targetUrl = match.url;
  if (match.appendAuthUser !== false) {
    const sep = match.url.indexOf("?") === -1 ? "?" : "&";
    targetUrl = match.url + sep + "authuser=" + encodeURIComponent(verifiedUser.email);
  }

  if (match.requireRealClick) {
    const html =
      "<!DOCTYPE html><html><head><meta name=\"referrer\" content=\"no-referrer\">" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">" +
      "<link href=\"https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap\" rel=\"stylesheet\">" +
      "<style>" +
      "*{box-sizing:border-box;}" +
      "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
      "background:linear-gradient(180deg,#f8fafc 0%,#eef2ff 100%);" +
      "font-family:'Plus Jakarta Sans',ui-sans-serif,system-ui,sans-serif;padding:24px;}" +
      ".card{background:#fff;border:1px solid rgba(99,102,241,0.14);border-radius:1.25rem;" +
      "box-shadow:0 25px 50px -12px rgba(0,0,0,0.18);padding:2.25rem 2rem;max-width:22rem;width:100%;text-align:center;}" +
      ".icon-wrap{width:3.75rem;height:3.75rem;border-radius:1rem;background:rgba(217,119,6,0.10);" +
      "display:flex;align-items:center;justify-content:center;margin:0 auto 1.25rem;}" +
      "h1{margin:0 0 0.4rem;font-size:1.15rem;font-weight:800;color:#0f172a;letter-spacing:-0.01em;}" +
      "p{margin:0 0 1.5rem;font-size:0.85rem;color:#64748b;line-height:1.5;}" +
      "p .label{font-weight:700;color:#334155;}" +
      "a.openBtn{display:inline-flex;align-items:center;justify-content:center;gap:0.5rem;width:100%;" +
      "padding:0.85rem 1.5rem;background:linear-gradient(to right,#4f46e5,#2563eb);color:#fff;" +
      "text-decoration:none;border-radius:0.75rem;font-size:0.9rem;font-weight:700;" +
      "box-shadow:0 10px 15px -3px rgba(37,99,235,0.25);transition:transform 0.15s ease,box-shadow 0.15s ease;}" +
      "a.openBtn:hover{transform:translateY(-2px);box-shadow:0 14px 20px -4px rgba(37,99,235,0.32);}" +
      "a.openBtn:active{transform:scale(0.98);}" +
      ".footnote{margin-top:1.1rem;font-size:0.7rem;color:#94a3b8;}" +
      "</style></head>" +
      "<body><div class=\"card\">" +
      "<div class=\"icon-wrap\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"28\" height=\"28\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#d97706\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"></path></svg></div>" +
      "<h1>Ready to open</h1>" +
      "<p>You're verified and cleared to access <span class=\"label\">" + escapeHtml(match.label) + "</span>.</p>" +
      "<a id=\"openBtn\" class=\"openBtn\" target=\"_top\" href=\"" + escapeHtml(targetUrl) + "\" autofocus>" +
      "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"></path><path d=\"M15 3h6v6\"></path><path d=\"M10 14 21 3\"></path></svg>" +
      "Open " + escapeHtml(match.label) +
      "</a>" +
      "<div class=\"footnote\">Signed in as " + escapeHtml(verifiedUser.email) + "</div>" +
      "</div>" +
      // Focus (do NOT auto-click) so the next Enter/Space activates the link;
      // programmatic clicks carry no user gesture and hit the sandbox's
      // top-navigation block.
      "<script>document.getElementById('openBtn').focus();<\/script>" +
      "</body></html>";
    return HtmlService.createHtmlOutput(html);
  }

  const html =
    "<html><head><meta name=\"referrer\" content=\"no-referrer\"></head><body>" +
    "<p>Opening " + escapeHtml(match.label) + "\u2026</p>" +
    "<script>(window.top || window).location.replace(" + JSON.stringify(targetUrl) + ");<\/script>" +
    "</body></html>";
  return HtmlService.createHtmlOutput(html);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
  });
}

function handleSaveAssignmentGet(e, actorEmail) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const branchName = String(p.branchName || "").trim();
    if (!branchName) {
      return respondJson(e, { error: "Missing branchName" });
    }

    let rotationsField = {};
    if (p.rotations) {
      try {
        rotationsField = { rotations: JSON.parse(p.rotations) };
      } catch (parseErr) {
        Logger.log("Could not parse rotations query param, falling back to flat fields: " + parseErr);
      }
    }
    const combined = {};
    for (const key in p) combined[key] = p[key];
    if (rotationsField.rotations) combined.rotations = rotationsField.rotations;

    const result = saveAuditorAssignmentToSheet(branchName, {
      expectedDate: p.expectedDate || "",
      upNextAuditor: p.upNextAuditor || "",
      rotations: normalizeRotationsInput(combined)
    });
    logAuditEvent(actorEmail, "saveAssignment", { branch: branchName });

    return respondJson(e, result);
  } catch (err) {
    Logger.log("handleSaveAssignmentGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to save assignment" });
  }
}

// #17: the page sends expectedBranch / expectedRemark with every remark
// edit/delete so a stale row number can never touch the wrong remark.
// Returns null when the page did not send them (older page = no guard).
function readRemarkGuard(p) {
  if (p.expectedBranch === undefined && p.expectedRemark === undefined) return null;
  return {
    branch: String(p.expectedBranch || ""),
    remark: String(p.expectedRemark || "")
  };
}

function handleSaveAuditorRemarkGet(e, actorEmail) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const branchName = String(p.branchName || "").trim();
    const auditor = String(p.auditor || "").trim();
    const remark = String(p.remark || "").trim();
    const rowIndex = p.rowIndex ? parseInt(p.rowIndex, 10) : null;
    const clientRequestId = String(p.clientRequestId || "").trim();

    if (!rowIndex && !branchName) {
      return respondJson(e, { error: "Missing branchName" });
    }
    if (!remark) {
      return respondJson(e, { error: "Missing remark" });
    }
    if (clientRequestId && !/^[A-Za-z0-9_-]{16,120}$/.test(clientRequestId)) {
      return respondJson(e, { error: "Invalid save request ID. Please try again." });
    }

    const result = saveAuditorRemarkToSheet(
      branchName, auditor, remark, rowIndex,
      rowIndex ? readRemarkGuard(p) : null,
      rowIndex ? "" : clientRequestId,
      actorEmail
    );
    // A retry of the same create is the same logical save, not a new audit event.
    if (!result.duplicateRequest) {
      logAuditEvent(actorEmail, "saveAuditorRemark", { branch: branchName, rowIndex: result.rowIndex });
    }
    return respondJson(e, result);
  } catch (err) {
    Logger.log("handleSaveAuditorRemarkGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to save remark" });
  }
}

function handleDeleteAuditorRemarkGet(e, actorEmail) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const rowIndex = p.rowIndex ? parseInt(p.rowIndex, 10) : null;
    if (!rowIndex) {
      return respondJson(e, { error: "Missing rowIndex" });
    }

    const result = deleteAuditorRemarkFromSheet(rowIndex, readRemarkGuard(p));
    logAuditEvent(actorEmail, "deleteAuditorRemark", { rowIndex: rowIndex });
    return respondJson(e, result);
  } catch (err) {
    Logger.log("handleDeleteAuditorRemarkGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to delete remark" });
  }
}

function normalizeRotationsInput(body) {
  const byRound = {};
  if (Array.isArray(body.rotations)) {
    body.rotations.forEach(function (r) {
      if (r && r.round) byRound[r.round] = { auditor: r.auditor || "", date: r.date || "" };
    });
  }
  const result = [];
  for (let n = 1; n <= ROTATION_ROUND_COUNT; n++) {
    const r = byRound[n] || { auditor: body["auditor" + n] || "", date: body["date" + n] || "" };
    result.push({ round: n, auditor: r.auditor, date: r.date });
  }
  return result;
}

function findBranchRow(ss, sheetName, branchName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error("Sheet not found: " + sheetName);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error(sheetName + " has no data rows.");
  }

  const nameRange = sheet.getRange(1, 1, lastRow, 2).getValues();
  const targetNormalized = normalizeBranchNameForMatch(branchName);

  for (let i = 0; i < nameRange.length; i++) {
    const candidate = String(nameRange[i][1] || nameRange[i][0] || "").trim();
    if (candidate && normalizeBranchNameForMatch(candidate) === targetNormalized) {
      return { sheet: sheet, rowNumber: i + 1 };
    }
  }

  throw new Error("Branch not found in " + sheetName + ": " + branchName);
}

function saveAuditorAssignmentToSheet(branchName, fields) {
  const ss = getSpreadsheet_();
  const found = findBranchRow(ss, AUDIT_DATA_SHEET_NAME, branchName);
  const cols = resolveAuditDataFinalColumns(found.sheet);

  found.sheet.getRange(found.rowNumber, cols.expectedDateCol).setValue(fields.expectedDate || "");

  const byRound = {};
  (fields.rotations || []).forEach(function (r) { byRound[r.round] = r; });
  const rowValues = [];
  for (let n = 1; n <= ROTATION_ROUND_COUNT; n++) {
    const r = byRound[n] || { auditor: "", date: "" };
    rowValues.push(r.auditor || "", r.date || "");
  }
  found.sheet.getRange(found.rowNumber, cols.rotationStartCol, 1, rowValues.length).setValues([rowValues]);
  // Separate call against the resolved column so this keeps working even
  // if a column is inserted between the rotation block and "Up Next Auditor".
  found.sheet.getRange(found.rowNumber, cols.upNextAuditorCol).setValue(fields.upNextAuditor || "");

  invalidateSheetInCache(AUDIT_DATA_SHEET_NAME, "assignment save");
  scheduleDeferredSync(AUDIT_DATA_SHEET_NAME);

  return { success: true, branch: branchName };
}

// ================= ROW HIGHLIGHT (Assignment Branches Overview) =================
const HIGHLIGHT_ALLOWED_COLORS = ["", "green", "yellow", "red", "blue"];

function handleSaveHighlightGet(e, actorEmail) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const branchName = String(p.branchName || "").trim();
    if (!branchName) {
      return respondJson(e, { error: "Missing branchName" });
    }

    const color = String(p.color || "").trim().toLowerCase();
    if (HIGHLIGHT_ALLOWED_COLORS.indexOf(color) === -1) {
      return respondJson(e, { error: "Invalid highlight color: " + color });
    }

    const result = saveHighlightToSheet(branchName, color);
    logAuditEvent(actorEmail, "saveHighlight", { branch: branchName, color: color });
    return respondJson(e, result);
  } catch (err) {
    Logger.log("handleSaveHighlightGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to save highlight" });
  }
}

function saveHighlightToSheet(branchName, color) {
  const ss = getSpreadsheet_();
  const found = findBranchRow(ss, AUDIT_DATA_SHEET_NAME, branchName);
  found.sheet.getRange(found.rowNumber, AUDIT_DATA_HIGHLIGHT_COL).setValue(color || "");

  invalidateSheetInCache(AUDIT_DATA_SHEET_NAME, "highlight save");
  scheduleDeferredSync(AUDIT_DATA_SHEET_NAME);

  return { success: true, branch: branchName, color: color };
}

// ---- #17: stale-row guard + write lock for AUDIT REPORT remarks ----
function normalizeRemarkForCompare(v) {
  return String(v === null || v === undefined ? "" : v).replace(/\s+/g, " ").trim();
}

// Branch names from the page can differ from the raw sheet text by case /
// punctuation / the PILILIA alias, so compare loosely: equal, or one
// contains the other, after stripping everything but letters and digits.
function remarkGuardBranchKey(name) {
  let k = normalizeBranchNameForMatch(name);
  if (k === "PILILIA") k = "PILILLA";
  return k;
}

// Throws (changing nothing) unless `rowIndex` still holds the remark the
// page showed. Called while holding the sheet write lock.
function assertRemarkRowUnchanged(sheet, rowIndex, guard) {
  if (!guard) return;
  const staleMsg = "That remark changed or moved since this page loaded (someone else may have edited AUDIT REPORT). Nothing was changed - please refresh and try again.";
  const row = sheet.getRange(rowIndex, AUDIT_REPORT_BRANCH_COL, 1, AUDIT_REPORT_REMARK_COL).getValues()[0];

  const sheetBranch = remarkGuardBranchKey(row[AUDIT_REPORT_BRANCH_COL - 1]);
  const expectedBranch = remarkGuardBranchKey(guard.branch);
  if (sheetBranch && expectedBranch && sheetBranch !== expectedBranch &&
      sheetBranch.indexOf(expectedBranch) === -1 && expectedBranch.indexOf(sheetBranch) === -1) {
    throw new Error(staleMsg);
  }

  if (guard.auditor !== undefined &&
      normalizeRemarkForCompare(row[AUDIT_REPORT_AUDITOR_COL - 1]) !== normalizeRemarkForCompare(guard.auditor)) {
    throw new Error(staleMsg);
  }

  const cell = row[AUDIT_REPORT_REMARK_COL - 1];
  // A date/time cell cannot be compared reliably to what the page received
  // as text, so only text and numbers are compared.
  if (!(cell instanceof Date)) {
    if (normalizeRemarkForCompare(cell) !== normalizeRemarkForCompare(guard.remark)) {
      throw new Error(staleMsg);
    }
  }
}

// Runs fn() as the only remark writer; waits briefly for a concurrent one.
// The lock is released BEFORE the caller clears caches / schedules a sync
// (those take the script lock themselves).
function withRemarkWriteLock(fn) {
  const lock = LockService.getScriptLock();
  // Fail promptly under contention instead of holding a browser save open for
  // eight seconds. New-remark retries are idempotent (clientRequestId below).
  if (!lock.tryLock(4000)) {
    throw new Error("The sheet is busy with another save. Nothing was changed; please try again in a moment.");
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

const REMARK_CREATE_DEDUPE_TTL_SECONDS = 21600; // CacheService maximum: six hours.

function remarkCreateDedupeKey_(actorEmail, clientRequestId) {
  if (!clientRequestId) return "";
  return "remark_create_v1_" + hashToken(String(actorEmail || "").toLowerCase().trim() + "|" + clientRequestId);
}

function saveAuditorRemarkToSheet(branchName, auditor, remark, rowIndex, guard, clientRequestId, actorEmail) {
  const dedupeKey = !rowIndex ? remarkCreateDedupeKey_(actorEmail, clientRequestId) : "";
  const fingerprint = hashToken(JSON.stringify({
    branch: String(branchName || "").trim(),
    auditor: String(auditor || "").trim(),
    remark: String(remark || "").trim()
  }));
  const cache = CacheService.getScriptCache();

  const saveResult = withRemarkWriteLock(function () {
    // Check under the same write lock as the append: concurrent clicks carrying
    // the same ID can create at most one row. An exact retry returns its row.
    // If the draft text changed after a timed-out response, update the row from
    // the same logical draft (only if the prior row still matches what we wrote).
    let priorCreate = null;
    if (dedupeKey) {
      try {
        const raw = cache.get(dedupeKey);
        if (raw) {
          const prior = JSON.parse(raw);
          if (prior && prior.rowIndex && prior.fingerprint === fingerprint) {
            return { rowIndex: Number(prior.rowIndex), duplicateRequest: true };
          }
          if (prior && prior.rowIndex) priorCreate = prior;
        }
      } catch (err) {
        Logger.log("Remark dedupe cache read failed (will continue with a guarded write): " + err);
      }
    }

    // Avoid opening the spreadsheet at all for an exact retry above.
    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(AUDIT_REPORT_SHEET_NAME);
    if (!sheet) throw new Error("Sheet not found: " + AUDIT_REPORT_SHEET_NAME);

    let row;
    if (priorCreate && !rowIndex) {
      row = Number(priorCreate.rowIndex);
      const lastRow = sheet.getLastRow();
      if (!Number.isInteger(row) || row < 2 || row > lastRow) {
        throw new Error("The earlier save row no longer exists. Refresh the profile and try again.");
      }
      if (remarkGuardBranchKey(priorCreate.branch) !== remarkGuardBranchKey(branchName)) {
        throw new Error("This save request belongs to a different branch. Reopen the remark form and try again.");
      }
      assertRemarkRowUnchanged(sheet, row, {
        branch: String(priorCreate.branch || ""),
        auditor: String(priorCreate.auditor || ""),
        remark: String(priorCreate.remark || "")
      });
      sheet.getRange(row, AUDIT_REPORT_AUDITOR_COL, 1, 2).setValues([[auditor || "", remark || ""]]);
    } else if (rowIndex) {
      const lastRow = sheet.getLastRow();
      if (rowIndex < 2 || rowIndex > lastRow) {
        throw new Error("rowIndex " + rowIndex + " is out of range in " + AUDIT_REPORT_SHEET_NAME);
      }
      assertRemarkRowUnchanged(sheet, rowIndex, guard);
      row = rowIndex;
      sheet.getRange(row, AUDIT_REPORT_AUDITOR_COL, 1, 2).setValues([[auditor || "", remark || ""]]);
    } else {
      row = sheet.getLastRow() + 1;
      if (row < 2) row = 2;
      sheet.getRange(row, AUDIT_REPORT_BRANCH_COL, 1, 3).setValues([[branchName, auditor || "", remark || ""]]);
    }

    if (dedupeKey) {
      try {
        // Cache the canonical row + last saved content before releasing the lock.
        cache.put(dedupeKey, JSON.stringify({
          rowIndex: row,
          fingerprint: fingerprint,
          branch: String(branchName || "").trim(),
          auditor: String(auditor || "").trim(),
          remark: String(remark || "").trim(),
          at: Date.now()
        }), REMARK_CREATE_DEDUPE_TTL_SECONDS);
      } catch (cacheErr) {
        Logger.log("Could not cache remark request ID after row " + row + " was written: " + cacheErr);
      }
    }
    return { rowIndex: row, duplicateRequest: false };
  });

  // A recognized retry changes nothing, so do not invalidate or queue another sync.
  if (!saveResult.duplicateRequest) {
    invalidateSheetInCache(AUDIT_REPORT_SHEET_NAME, "auditor remark save");
    scheduleDeferredSync(AUDIT_REPORT_SHEET_NAME);
  }

  return { success: true, rowIndex: saveResult.rowIndex, duplicateRequest: !!saveResult.duplicateRequest };
}


// ================= SET EMERGENCY AUDITOR =================
const AUDITORS_EMERGENCY_SHEET_NAME = "AUDITORS EMERGENCY";
const EMERGENCY_CURRENT_AUDITOR_CELL = "A2";
// History block layout: D = auditor, E = branch, F = date, G = optional
// remark (written together as one 4-column row starting at column D).
const EMERGENCY_HISTORY_FIRST_ROW = 2;
const EMERGENCY_HISTORY_AUDITOR_COL = 4;

// The rotation is read fresh from column A (A2, A3, ... until the first
// blank) every time, so it grows/shrinks with however many auditors are
// listed — no code change needed to add or remove a standby auditor.
const EMERGENCY_ROTATION_FIRST_ROW = 2;
const EMERGENCY_ROTATION_COL = 1;
// Fallback only — used if column A is completely empty.
const EMERGENCY_ROTATION_CYCLE_FALLBACK = ["GENESIS", "EDISON", "KARL", "LAURENCE"];

function getEmergencyRotationCycle(sheet) {
  const lastRow = sheet.getLastRow();
  const maxPossible = Math.max(0, lastRow - EMERGENCY_ROTATION_FIRST_ROW + 1);
  if (maxPossible === 0) return EMERGENCY_ROTATION_CYCLE_FALLBACK.slice();
  const values = sheet.getRange(EMERGENCY_ROTATION_FIRST_ROW, EMERGENCY_ROTATION_COL, maxPossible, 1).getValues();
  const cycle = [];
  for (let i = 0; i < values.length; i++) {
    const name = String(values[i][0] || "").trim();
    if (!name) break; // contiguous block only
    cycle.push(name.toUpperCase());
  }
  return cycle.length ? cycle : EMERGENCY_ROTATION_CYCLE_FALLBACK.slice();
}

function handleSaveEmergencyAuditorGet(e, actorEmail) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const auditor = String(p.auditor || "").trim();
    const branch = String(p.branch || "").trim();
    const date = String(p.date || "").trim();
    const remark = String(p.remark || "").trim();
    const isOverride = (p.override === "true" || p.override === "1");

    if (!auditor) {
      return respondJson(e, { error: "Missing auditor" });
    }

    const result = saveEmergencyAuditorToSheet(auditor, branch, date, isOverride, remark);
    logAuditEvent(actorEmail, "saveEmergencyAuditor", { auditor: auditor, branch: branch, date: date, override: isOverride });
    return respondJson(e, result);
  } catch (err) {
    Logger.log("handleSaveEmergencyAuditorGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to save emergency auditor" });
  }
}

// `names` arrives pipe-delimited and fully replaces the current rotation
// (add / remove / reorder via one endpoint).
function handleSaveEmergencyRotationGet(e, actorEmail) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const namesRaw = String(p.names || "");
    const names = namesRaw.split("|").map(function (s) { return s.trim(); }).filter(Boolean);

    if (!names.length) {
      return respondJson(e, { error: "The rotation needs at least one auditor." });
    }

    const result = saveEmergencyRotationCycleToSheet(names);
    logAuditEvent(actorEmail, "saveEmergencyRotation", { names: names.join(",") });
    return respondJson(e, result);
  } catch (err) {
    Logger.log("handleSaveEmergencyRotationGet failed: " + err);
    return respondJson(e, { error: (err && err.message) ? err.message : "Failed to save emergency rotation" });
  }
}

function saveEmergencyRotationCycleToSheet(names) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(AUDITORS_EMERGENCY_SHEET_NAME);
  if (!sheet) {
    throw new Error("Sheet not found: " + AUDITORS_EMERGENCY_SHEET_NAME);
  }

  const upper = names.map(function (n) { return n.toUpperCase(); });
  const oldCycle = getEmergencyRotationCycle(sheet);
  const rowCount = Math.max(oldCycle.length, upper.length);

  const values = [];
  for (let i = 0; i < rowCount; i++) {
    values.push([i < upper.length ? upper[i] : ""]);
  }
  sheet.getRange(EMERGENCY_ROTATION_FIRST_ROW, EMERGENCY_ROTATION_COL, rowCount, 1).setValues(values);

  invalidateSheetInCache(AUDITORS_EMERGENCY_SHEET_NAME, "emergency rotation save");
  scheduleDeferredSync(AUDITORS_EMERGENCY_SHEET_NAME);

  return { success: true, rotation: upper };
}

function writeFullRotationCycle(sheet, startAuditor, knownCycle) {
  const cycle = knownCycle || getEmergencyRotationCycle(sheet); // #24: caller may pass the cycle it just read
  const idx = cycle.indexOf(startAuditor);

  if (idx === -1) {
    sheet.getRange(EMERGENCY_CURRENT_AUDITOR_CELL).setValue(startAuditor);
    return;
  }

  const size = cycle.length;
  const ordered = [];
  for (let i = 0; i < size; i++) {
    ordered.push([cycle[(idx + i) % size]]);
  }
  sheet.getRange(EMERGENCY_ROTATION_FIRST_ROW, EMERGENCY_ROTATION_COL, size, 1).setValues(ordered);
}

function writeSkipOrder(sheet, startAuditor, oldCurrent) {
  const cycle = getEmergencyRotationCycle(sheet);
  const already = [startAuditor];
  if (oldCurrent && oldCurrent !== startAuditor) already.push(oldCurrent);

  const rest = cycle.filter(function (name) {
    return already.indexOf(name) === -1;
  });

  const fullOrder = already.concat(rest);
  const size = cycle.length;
  while (fullOrder.length < size) fullOrder.push("");
  const ordered = fullOrder.slice(0, size).map(function (name) { return [name]; });

  sheet.getRange(EMERGENCY_ROTATION_FIRST_ROW, EMERGENCY_ROTATION_COL, size, 1).setValues(ordered);
}

// `auditor` is whoever just COMPLETED the branch/date assignment being
// logged (always written to the history row D:G). Normal flow advances the
// standing rotation to the NEXT person after them. Override flow sets the
// given name directly as current, preserving the previous current via
// writeSkipOrder() so their turn isn't lost.
function saveEmergencyAuditorToSheet(auditor, branch, date, isOverride, remark) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(AUDITORS_EMERGENCY_SHEET_NAME);
  if (!sheet) {
    throw new Error("Sheet not found: " + AUDITORS_EMERGENCY_SHEET_NAME);
  }

  const auditorUpper = auditor.toUpperCase();
  const oldCurrent = String(sheet.getRange(EMERGENCY_CURRENT_AUDITOR_CELL).getValue() || "").trim().toUpperCase();

  if (isOverride) {
    if (oldCurrent && oldCurrent !== auditorUpper) {
      writeSkipOrder(sheet, auditorUpper, oldCurrent);
    } else {
      writeFullRotationCycle(sheet, auditorUpper);
    }
  } else {
    const cycle = getEmergencyRotationCycle(sheet);
    const idx = cycle.indexOf(auditorUpper);
    const nextAuditor = (idx === -1) ? auditorUpper : cycle[(idx + 1) % cycle.length];
    writeFullRotationCycle(sheet, nextAuditor, cycle); // nothing was written since `cycle` was read
  }

  const lastRow = Math.max(sheet.getLastRow(), EMERGENCY_HISTORY_FIRST_ROW - 1);
  let targetRow = EMERGENCY_HISTORY_FIRST_ROW;

  if (lastRow >= EMERGENCY_HISTORY_FIRST_ROW) {
    const existingAuditorCol = sheet.getRange(
      EMERGENCY_HISTORY_FIRST_ROW, EMERGENCY_HISTORY_AUDITOR_COL,
      lastRow - EMERGENCY_HISTORY_FIRST_ROW + 1, 1
    ).getValues();

    let firstBlankOffset = -1;
    for (let i = 0; i < existingAuditorCol.length; i++) {
      if (isBlankCellValue(existingAuditorCol[i][0])) {
        firstBlankOffset = i;
        break;
      }
    }
    targetRow = (firstBlankOffset === -1)
      ? (lastRow + 1)
      : (EMERGENCY_HISTORY_FIRST_ROW + firstBlankOffset);
  }

  sheet.getRange(targetRow, EMERGENCY_HISTORY_AUDITOR_COL, 1, 4)
       .setValues([[auditorUpper, branch || "", date || "", remark || ""]]);

  invalidateSheetInCache(AUDITORS_EMERGENCY_SHEET_NAME, "emergency auditor save");
  scheduleDeferredSync(AUDITORS_EMERGENCY_SHEET_NAME);

  return { success: true, row: targetRow, auditor: auditorUpper };
}
// ================= END SET EMERGENCY AUDITOR =================

function deleteAuditorRemarkFromSheet(rowIndex, guard) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(AUDIT_REPORT_SHEET_NAME);
  if (!sheet) {
    throw new Error("Sheet not found: " + AUDIT_REPORT_SHEET_NAME);
  }

  withRemarkWriteLock(function () {
    const lastRow = sheet.getLastRow();
    if (rowIndex < 2 || rowIndex > lastRow) {
      throw new Error("rowIndex " + rowIndex + " is out of range in " + AUDIT_REPORT_SHEET_NAME);
    }
    // #17: refuse (and change nothing) if this row is no longer the remark
    // the page was showing -- deleteRow() shifts every row below it.
    assertRemarkRowUnchanged(sheet, rowIndex, guard);
    sheet.deleteRow(rowIndex);
  });

  invalidateSheetInCache(AUDIT_REPORT_SHEET_NAME, "auditor remark delete");
  scheduleDeferredSync(AUDIT_REPORT_SHEET_NAME);

  return { success: true };
}

// Drops the cached dashboard payload so the next request re-reads fresh
// data. Used by the hard-reset path (and as the fallback when a sheet cannot
// be marked dirty). In-app saves use invalidateSheetInCache() instead.
function clearResponseCache(reasonForLog) {
  try {
    const cache = CacheService.getScriptCache();
    cache.removeAll([
      DASH_CACHE_KEY + ":meta",
      DASH_VER_KEY,
      SHEET_MODTIME_CACHE_KEY,
      LIVE_REBUILD_GUARD_KEY,
      SELF_PATCH_KEY
    ]);
  } catch (err) {
    Logger.log("Could not clear response cache after " + reasonForLog + ": " + err);
  }
}

// #18: called by every in-app save right after it wrote ONE sheet. Instead of
// throwing the whole cached payload away (the next read would then re-read all
// 6 sheets), it only marks that sheet "dirty"; getFreshestDataCached() re-reads
// just the dirty sheet(s) and patches the cached copy.
function invalidateSheetInCache(sheetName, reasonForLog) {
  let marked = false;
  try {
    marked = addDirtySheet(sheetName);
    const cache = CacheService.getScriptCache();
    // next version lookup must be live + a change-triggered rebuild may run right away
    cache.removeAll([SHEET_MODTIME_CACHE_KEY, LIVE_REBUILD_GUARD_KEY]);
  } catch (err) {
    Logger.log("invalidateSheetInCache: could not mark dirty after " + reasonForLog + ": " + err);
  }
  if (!marked) clearResponseCache(reasonForLog); // safe fallback = old behaviour
}

const DEFERRED_SYNC_PENDING_PROP = "DEFERRED_SYNC_PENDING_SHEETS";
const DEFERRED_SYNC_TRIGGER_PROP = "DEFERRED_SYNC_TRIGGER_ID";
const DEFERRED_SYNC_DELAY_MS = 4000;

function scheduleDeferredSync(sheetName) {
  try {
    const props = PropertiesService.getScriptProperties();
    const lock = LockService.getScriptLock();
    const gotLock = lock.tryLock(900);
    if (!gotLock) {
      Logger.log("scheduleDeferredSync: could not acquire scheduling lock quickly; save remains dirty and will be healed later.");
      return;
    }
    try {
      const existingRaw = props.getProperty(DEFERRED_SYNC_PENDING_PROP);
      const pending = existingRaw ? existingRaw.split(",").filter(Boolean) : [];
      if (pending.indexOf(sheetName) === -1) pending.push(sheetName);
      props.setProperty(DEFERRED_SYNC_PENDING_PROP, pending.join(","));

      const existingTriggerId = props.getProperty(DEFERRED_SYNC_TRIGGER_PROP);
      if (!existingTriggerId) {
        const trigger = ScriptApp.newTrigger("runDeferredSync")
          .timeBased()
          .after(DEFERRED_SYNC_DELAY_MS)
          .create();
        props.setProperty(DEFERRED_SYNC_TRIGGER_PROP, trigger.getUniqueId());
      }
    } finally {
      if (gotLock) lock.releaseLock();
    }
  } catch (err) {
    Logger.log("Could not schedule deferred sync for " + sheetName + " (non-fatal, save already succeeded): " + err);
  }
}

// #18: the pending list and trigger marker are TAKEN (read + cleared) up front,
// under the lock. A save that lands while this sync is running therefore adds
// to a fresh list and schedules its own trigger, instead of having its pending
// sheet wiped by the cleanup at the end (which used to leave Firestore behind).
function runDeferredSync() {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    Logger.log("runDeferredSync: could not acquire lock; leaving pending sync marker for the next trigger.");
    return;
  }

  let pending = [];
  const myTriggers = []; // #24: listed once (was listed twice)
  try {
    const pendingRaw = props.getProperty(DEFERRED_SYNC_PENDING_PROP);
    pending = pendingRaw ? pendingRaw.split(",").filter(Boolean) : [];
    props.deleteProperty(DEFERRED_SYNC_PENDING_PROP);
    props.deleteProperty(DEFERRED_SYNC_TRIGGER_PROP);
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === "runDeferredSync") myTriggers.push(t);
    });
  } finally {
    if (gotLock) lock.releaseLock();
  }

  // Remove only the triggers that existed when this run started.
  myTriggers.forEach(function (t) {
    try { ScriptApp.deleteTrigger(t); }
    catch (err) { Logger.log("runDeferredSync: could not delete own trigger (non-fatal): " + err); }
  });

  let anyFailed = false;
  pending.forEach(function (sheetName) {
    if (!syncSingleSheetAndMeta(sheetName)) anyFailed = true;
  });
  // A failed sheet leaves Firestore behind for that sheet; hand the repair to
  // the (cooldown-limited) full sync instead of silently trusting Firestore.
  if (anyFailed) scheduleDeferredFullSyncIfNeeded();
}

// Returns true when the sheet AND the "in sync" marker were written. The
// marker is NOT advanced after a failure, so Firestore is never trusted
// while it is missing a saved change.
function syncSingleSheetAndMeta(sheetName) {
  try {
    const firestore = getFirestoreClient();
    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      Logger.log("syncSingleSheetAndMeta: sheet not found, skipping: " + sheetName);
      return true;
    }

    const values = sheet.getDataRange().getValues();
    const docId = sheetNameToDocId(sheetName);
    const payload = {
      sheetName: sheetName,
      valuesJson: JSON.stringify(values),
      syncedAt: new Date().toISOString()
    };
    upsertDocument(firestore, FIRESTORE_COLLECTION + "/" + docId, payload);

    const sheetModifiedTime = DriveApp.getFileById(SPREADSHEET_ID).getLastUpdated().getTime();
    const metaPayload = {
      lastSyncedSheetModifiedTime: sheetModifiedTime,
      syncedAt: new Date().toISOString()
    };
    upsertDocument(firestore, FIRESTORE_COLLECTION + "/" + SYNC_META_DOC_ID, metaPayload);

    Logger.log("Incrementally synced " + sheetName + " to Firestore after write; meta advanced to " + sheetModifiedTime);
    return true;
  } catch (err) {
    Logger.log("Could not incrementally sync " + sheetName + " to Firestore after write (non-fatal, save already succeeded): " + err);
    return false;
  }
}

// ============================================================
// Deferred FULL sync — self-heals Firestore after an external/manual
// Sheet edit instead of waiting for the hourly trigger.
// #16: at most ONE per DEFERRED_FULL_SYNC_COOLDOWN_SECONDS. Before, every
// request that saw an out-of-sync Firestore scheduled a new trigger, so a
// failing sync turned into a trigger/quota storm.
// ============================================================
const DEFERRED_FULL_SYNC_TRIGGER_PROP = "DEFERRED_FULL_SYNC_TRIGGER_ID";
const DEFERRED_FULL_SYNC_DELAY_MS = 4000;
const DEFERRED_FULL_SYNC_COOLDOWN_KEY = "deferredFullSyncCooldownV1";
const DEFERRED_FULL_SYNC_COOLDOWN_SECONDS = 120;

function scheduleDeferredFullSyncIfNeeded() {
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get(DEFERRED_FULL_SYNC_COOLDOWN_KEY)) return; // one was scheduled/run very recently

    const props = PropertiesService.getScriptProperties();
    const lock = LockService.getScriptLock();
    const gotLock = lock.tryLock(3000);
    if (!gotLock) {
      Logger.log("scheduleDeferredFullSyncIfNeeded: could not acquire scheduling lock; cooldown marker remains untouched.");
      return;
    }
    try {
      if (props.getProperty(DEFERRED_FULL_SYNC_TRIGGER_PROP)) return; // already scheduled
      const trigger = ScriptApp.newTrigger("runDeferredFullSync")
        .timeBased()
        .after(DEFERRED_FULL_SYNC_DELAY_MS)
        .create();
      props.setProperty(DEFERRED_FULL_SYNC_TRIGGER_PROP, trigger.getUniqueId());
      try { cache.put(DEFERRED_FULL_SYNC_COOLDOWN_KEY, "1", DEFERRED_FULL_SYNC_COOLDOWN_SECONDS); } catch (err) { /* non-fatal */ }
    } finally {
      if (gotLock) lock.releaseLock();
    }
  } catch (err) {
    Logger.log("Could not schedule deferred full sync (non-fatal): " + err);
  }
}

function runDeferredFullSync() {
  const props = PropertiesService.getScriptProperties();
  // Capture this run's own trigger ids first, so a trigger scheduled while the
  // sync is running is not deleted by the cleanup.
  const myTriggers = []; // #24: listed once (was listed twice)
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === "runDeferredFullSync") myTriggers.push(t);
    });
  } catch (err) { /* non-fatal */ }
  props.deleteProperty(DEFERRED_FULL_SYNC_TRIGGER_PROP);
  myTriggers.forEach(function (t) {
    try { ScriptApp.deleteTrigger(t); }
    catch (err) { Logger.log("runDeferredFullSync: could not delete own trigger (non-fatal): " + err); }
  });

  try {
    syncSheetsToFirestore();
  } catch (err) {
    Logger.log("runDeferredFullSync: syncSheetsToFirestore failed: " + err);
  }
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// A JSONP callback must be a plain (dotted) JavaScript identifier. Anything
// else is ignored (plain JSON is returned) instead of being echoed into a
// <script> response.
function safeJsonpCallback(raw) {
  const cb = String(raw || "");
  return /^[A-Za-z_$][A-Za-z0-9_$.]{0,100}$/.test(cb) ? cb : null;
}

function respondJson(e, obj) {
  const callback = (e && e.parameter) ? safeJsonpCallback(e.parameter.callback) : null;
  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + JSON.stringify(obj) + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonOutput(obj);
}

function verifyFirebaseIdToken(idToken) {
  _lastTokenVerifyFailureReason = null;
  if (!idToken) return null;

  const cache = CacheService.getScriptCache();
  const cacheKey = "tokv3_" + hashToken(idToken);

  const cached = cache.get(cacheKey);
  if (cached !== null) {
    if (cached === "INVALID") return null;
    try {
      return JSON.parse(cached);
    } catch (e) {
      // corrupt cache entry — re-verify
    }
  }

  // Several dashboard health checks can arrive together with the same fresh
  // Firebase token. Without a single-flight gate, each request calls Identity
  // Toolkit independently, which can queue Apps Script and cause browser-side
  // JSONP timeouts to masquerade as Sheet/permission failures.
  // Only one request should call Identity Toolkit for a newly-seen token.
  // If another request owns the verification lock, wait briefly for its cache
  // result instead of issuing the same external request concurrently.
  const verifyLock = trySoftLock("token_verify_" + cacheKey, 12, 250);
  if (!verifyLock) {
    const waitUntil = Date.now() + 2200;
    while (Date.now() < waitUntil) {
      try {
        const inFlight = cache.get(cacheKey);
        if (inFlight !== null) {
          if (inFlight === "INVALID") return null;
          try { return JSON.parse(inFlight); } catch (e) { /* malformed cache: keep waiting briefly */ }
        }
      } catch (cacheErr) { /* continue to the short deadline */ }
      Utilities.sleep(100);
    }
    _lastTokenVerifyFailureReason = "network";
    Logger.log("Identity Toolkit verification already in progress; avoided a duplicate external request because no result was cached in time.");
    return null;
  }

  try {
    const cachedAgain = cache.get(cacheKey);
    if (cachedAgain !== null) {
      if (cachedAgain === "INVALID") return null;
      try { return JSON.parse(cachedAgain); } catch (e) { /* continue */ }
    }

    const apiKey = PropertiesService.getScriptProperties().getProperty("FIREBASE_WEB_API_KEY");
  if (!apiKey) {
    Logger.log("FIREBASE_WEB_API_KEY is not set in Script Properties — cannot verify tokens.");
    return null;
  }

  const url = "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(apiKey);
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true
  };

  // #18: only a REAL rejection (Identity Toolkit answered and said the token is
  // bad) is "Unauthorized" and cached as INVALID. A 429 / 5xx / non-JSON reply,
  // or a failed fetch, says nothing about the token: it is reported as
  // quota/network, never cached, and retried once for transient trouble.
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      const text = response.getContentText();
      let body = null;
      try { body = JSON.parse(text); } catch (parseErr) { body = null; }

      if (code === 200 && body && body.users && body.users.length) {
        const user = body.users[0];
        // NOTE: Firebase's emailVerified flag is intentionally NOT checked —
        // accounts added via the Firebase console default to false. Access is
        // controlled by ACCESS_CONFIG at the top of this file.
        cache.put(cacheKey, JSON.stringify(user), TOKEN_CACHE_TTL_SECONDS);
        return user;
      }

      const apiMsg = String((body && body.error && body.error.message) || "");
      if (code === 429 || /quota|too_many|resource_exhausted|rate.?limit/i.test(apiMsg)) {
        _lastTokenVerifyFailureReason = "quota";
        Logger.log("Identity Toolkit quota/rate limit (HTTP " + code + "): " + apiMsg);
        return null;
      }
      if (code >= 500 || body === null) {
        _lastTokenVerifyFailureReason = "network";
        Logger.log("Identity Toolkit transient failure (HTTP " + code + ", attempt " + attempt + ")");
        if (attempt < MAX_ATTEMPTS) { Utilities.sleep(300); continue; }
        return null;
      }

      // Identity Toolkit was REACHED and rejected the token — genuine
      // "Unauthorized" (reason stays null, not "quota").
      Logger.log("ID token rejected by Identity Toolkit: " + text);
      cache.put(cacheKey, "INVALID", 60);
      return null;
    } catch (err) {
      // The fetch itself failed — says NOTHING about the token's validity.
      const errMsg = String((err && err.message) || err);
      _lastTokenVerifyFailureReason = /too many times|quota/i.test(errMsg) ? "quota" : "network";
      Logger.log("Error verifying ID token (attempt " + attempt + "): " + err);
      if (_lastTokenVerifyFailureReason === "quota" || attempt >= MAX_ATTEMPTS) return null;
      Utilities.sleep(300);
    }
  }
  } finally {
    if (verifyLock) softUnlock(verifyLock);
  }
}

function hashToken(token) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  return Utilities.base64EncodeWebSafe(digest).substring(0, 40);
}

// ---------------------------------------------------------------------------
// #18: SOFT LOCK. A tiny cache-based lock used ONLY to stop several requests
// rebuilding the same payload at once. It is deliberately separate from the
// script-wide LockService lock (which remark saves and the sync scheduler need
// for real mutual exclusion), so a slow rebuild can no longer make a remark
// save wait, and a remark save can no longer make a reader wait 6 seconds.
// A crashed holder cannot block anyone for longer than ttlSeconds, and any
// cache trouble degrades to "no lock" rather than blocking.
// ---------------------------------------------------------------------------
function trySoftLock(name, ttlSeconds, waitMs) {
  const cache = CacheService.getScriptCache();
  const key = "softlock_" + name;
  const token = Utilities.getUuid();
  const deadline = Date.now() + Math.max(0, waitMs || 0);
  while (true) {
    try {
      if (cache.get(key) === null) {
        cache.put(key, token, ttlSeconds);
        Utilities.sleep(40); // let a racing writer land, then see who won
        if (cache.get(key) === token) return { key: key, token: token };
      }
    } catch (err) {
      return { key: key, token: token, degraded: true };
    }
    if (Date.now() >= deadline) return null;
    Utilities.sleep(200);
  }
}

function softUnlock(handle) {
  if (!handle) return;
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get(handle.key) === handle.token) cache.remove(handle.key);
  } catch (err) { /* non-fatal: it expires by itself */ }
}

// ---- Dashboard payload cache keys ----
const DASH_CACHE_KEY = "dash_payload_v1";
const DASH_VER_KEY = "dash_ver_v1";                 // version of the cached copy (small key, cheap to update)
const DASH_SOFTLOCK_NAME = "dash_rebuild";
const DASH_SOFTLOCK_TTL_SECONDS = 60;
const DASH_STALE_WAIT_MS = 2500;                     // a stale copy exists: wait only briefly for a rebuild
const DIRTY_SHEETS_KEY = "dash_dirty_sheets_v1";     // sheets saved in-app since the cached copy was built
const SELF_PATCH_KEY = "dash_selfpatch_v1";          // set (30 s) right after a dirty-sheet patch
const SELF_PATCH_GRACE_SECONDS = 30;

function parseDirtySheets_(raw) {
  try {
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(function (n) { return !!SHEET_KEY_MAP[n]; }) : [];
  } catch (err) {
    return [];
  }
}

function readDirtySheets(cache) {
  try {
    return parseDirtySheets_(cache.get(DIRTY_SHEETS_KEY));
  } catch (err) {
    return [];
  }
}

function addDirtySheet(sheetName) {
  if (!SHEET_KEY_MAP[sheetName]) return true; // not part of the dashboard payload: nothing to invalidate
  try {
    const cache = CacheService.getScriptCache();
    const list = readDirtySheets(cache);
    if (list.indexOf(sheetName) === -1) list.push(sheetName);
    cache.put(DIRTY_SHEETS_KEY, JSON.stringify(list), RESPONSE_CACHE_TTL_SECONDS);
    return true;
  } catch (err) {
    return false;
  }
}

// Removes only the names that were handled; a sheet marked dirty by a save
// that landed in the meantime is not in `handled` ... unless it is the same
// sheet, which the data-version check below still catches.
function removeDirtySheets(handled) {
  if (!handled || !handled.length) return;
  try {
    const cache = CacheService.getScriptCache();
    const left = readDirtySheets(cache).filter(function (n) { return handled.indexOf(n) === -1; });
    if (left.length) cache.put(DIRTY_SHEETS_KEY, JSON.stringify(left), RESPONSE_CACHE_TTL_SECONDS);
    else cache.remove(DIRTY_SHEETS_KEY);
  } catch (err) { /* non-fatal */ }
}

// Writes a payload + its version + its build time to the cache.
function storeDashboardPayload(cache, payload) {
  // Compute once per cache rebuild; every device then receives the exact same
  // content fingerprint with the cached payload.
  if (!payload.analysisDataHash) {
    try { payload.analysisDataHash = computeAnalysisDataHash_(payload); } catch (err) { /* non-fatal */ }
  }
  const json = cacheSetChunked(cache, DASH_CACHE_KEY, payload, RESPONSE_CACHE_TTL_SECONDS);
  // Perf: remember the JSON text just built for the cache so doGetInner_ can
  // send the SAME text instead of stringifying the same multi-MB object again.
  // Identity-checked in dashJsonFor_(); one execution only.
  _lastStoredDash_ = (typeof json === "string") ? { obj: payload, json: json } : null;
  try {
    cache.put(DASH_VER_KEY, String(Number(payload && payload.dataVersion) || 0), RESPONSE_CACHE_TTL_SECONDS);
    cache.put(DASH_BUILTAT_KEY, String(Date.now()), RESPONSE_CACHE_TTL_SECONDS);
    if (payload && payload.analysisDataHash) cache.put(ANALYSIS_DATA_HASH_KEY, String(payload.analysisDataHash), RESPONSE_CACHE_TTL_SECONDS);
  } catch (err) { /* non-fatal */ }
}

// Perf: JSON text of the payload object most recently stored in THIS execution.
let _lastStoredDash_ = null;
function dashJsonFor_(result) {
  return (_lastStoredDash_ && _lastStoredDash_.obj === result) ? _lastStoredDash_.json : null;
}

// Perf: one tiny getAll() that identifies "which copy is in the cache" (version
// key + build-time key; storeDashboardPayload rewrites both on every store and
// clearResponseCache removes the version key). Lets a request that already holds
// the cached payload prove, after waiting for the lock, that nobody replaced it,
// instead of downloading and parsing the whole payload a second time.
// Returns null on any doubt => callers just re-read like before.
function dashCacheStamp_(cache) {
  try {
    const got = cache.getAll([DASH_VER_KEY, DASH_BUILTAT_KEY]);
    if (!got[DASH_VER_KEY] || !got[DASH_BUILTAT_KEY]) return null;
    return got[DASH_VER_KEY] + "|" + got[DASH_BUILTAT_KEY];
  } catch (err) {
    return null;
  }
}

// Reads the cached payload and applies the (possibly newer) version stamp.
function readDashboardPayload(cache) {
  const cached = cacheGetChunked(cache, DASH_CACHE_KEY);
  if (cached === null) return null;
  try {
    const v = Number(cache.get(DASH_VER_KEY)) || 0;
    if (v > 0) cached.dataVersion = v;
    const h = String(cache.get(ANALYSIS_DATA_HASH_KEY) || "");
    if (h) cached.analysisDataHash = h;
  } catch (err) { /* keep the values stored inside the payload */ }
  return cached;
}

// Live Sheet read of every dashboard sheet, stamped with the version read
// BEFORE reading (so an edit that lands mid-read is seen as "newer" next time).
// `knownVersion` (optional): a modified time the caller already looked up a
// moment ago. It is older-or-equal to "now", so it is as safe as a fresh
// lookup (an edit after it is seen as newer next time) and saves a Drive call.
function readFromSheetWithVersion(knownVersion) {
  let version = Number(knownVersion) || 0;
  if (!version) {
    try { version = DriveApp.getFileById(SPREADSHEET_ID).getLastUpdated().getTime(); } catch (err) { /* non-fatal */ }
  }
  const result = readFromSheet();
  if (version) {
    result.dataVersion = version;
    if (_lastFullSheetRead_) _lastFullSheetRead_.version = version; // looked up BEFORE the read
  }
  return result;
}

// Re-reads ONLY the given sheets and patches them into an existing payload.
function patchPayloadSheets(payload, sheetNames) {
  let version = 0;
  try { version = DriveApp.getFileById(SPREADSHEET_ID).getLastUpdated().getTime(); } catch (err) { /* non-fatal */ }
  const ss = getSpreadsheet_();
  sheetNames.forEach(function (sheetName) {
    const key = SHEET_KEY_MAP[sheetName];
    if (!key) return;
    const sheet = ss.getSheetByName(sheetName);
    payload[key] = sheet ? sheet.getDataRange().getValues() : [];
  });
  if (version) payload.dataVersion = version;
  return payload;
}

// #18 flow (replaces the #16 script-lock version):
//   1. fresh cached copy and nothing dirty  -> serve it (the normal case)
//   2. otherwise ONE request takes the soft lock and fixes the cache:
//        - dirty sheets  -> re-read just those sheets, patch the cached copy
//        - no copy / patch failed -> full rebuild
//      every other request serves the cached copy right away instead of
//      queueing behind the rebuild.
function getFreshestDataCached() {
  const cache = CacheService.getScriptCache();

  const dirty = readDirtySheets(cache);
  let cached = null;
  let cachedStamp = null;
  let haveCopy;
  if (!dirty.length) {
    cachedStamp = dashCacheStamp_(cache); // taken BEFORE the read (see dashCacheStamp_)
    cached = readDashboardPayload(cache);
    if (cached !== null && !cachedPayloadIsStale(cache, cached)) {
      Logger.log("Serving data from: CACHE");
      return cached;
    }
    haveCopy = cached !== null;
  } else {
    // Dirty sheets always mean a patch/rebuild, and the copy is re-read below
    // after the lock attempt anyway: skip downloading + parsing the whole
    // cached payload here just to learn whether one exists.
    haveCopy = cache.get(DASH_CACHE_KEY + ":meta") !== null;
  }

  // A stale copy exists: don't hold the caller long. Nothing at all to serve:
  // wait longer for whoever is building it.
  const lock = trySoftLock(DASH_SOFTLOCK_NAME, DASH_SOFTLOCK_TTL_SECONDS, haveCopy ? DASH_STALE_WAIT_MS : CACHE_LOCK_WAIT_MS);

  try {
    const dirtyNow = readDirtySheets(cache);
    let cachedNow;
    if (cached !== null && cachedStamp !== null && !dirtyNow.length && dashCacheStamp_(cache) === cachedStamp) {
      // Same cached copy we read above, which was already judged stale: nobody
      // refreshed it while we waited, so skip the second full download + parse
      // and the repeat staleness check.
      cachedNow = cached;
    } else {
      cachedNow = readDashboardPayload(cache);
      if (cachedNow !== null && !dirtyNow.length && !cachedPayloadIsStale(cache, cachedNow)) {
        Logger.log("Serving data from: CACHE (another request refreshed it while this one waited)");
        return cachedNow;
      }
    }

    if (!lock) {
      // Someone else is rebuilding. A slightly stale copy beats a stampede.
      const anyCopy = cachedNow !== null ? cachedNow : cached;
      if (anyCopy !== null) {
        Logger.log("Serving data from: CACHE (stale copy — another request is rebuilding)");
        return anyCopy;
      }
    }

    // In-app save(s): re-read just the sheet(s) that changed.
    if (cachedNow !== null && dirtyNow.length) {
      try {
        const patched = patchPayloadSheets(cachedNow, dirtyNow);
        storeDashboardPayload(cache, patched);
        removeDirtySheets(dirtyNow);
        try { cache.put(SELF_PATCH_KEY, "1", SELF_PATCH_GRACE_SECONDS); } catch (err) { /* non-fatal */ }
        Logger.log("Serving data from: CACHE patched with live " + dirtyNow.join(", "));
        return patched;
      } catch (err) {
        Logger.log("Dirty-sheet patch failed, falling back to a full rebuild: " + err);
      }
    }

    // Full rebuild. Unsynced in-app saves => Firestore is behind, so read the
    // Sheet directly; otherwise the normal Firestore-or-Sheet path.
    const result = dirtyNow.length ? readFromSheetWithVersion() : getFreshestData();
    storeDashboardPayload(cache, result);
    markLiveRebuild(cache);
    if (dirtyNow.length) removeDirtySheets(dirtyNow);
    return result;
  } finally {
    softUnlock(lock);
  }
}

// Used by the warmer: refill the dashboard cache from the live Sheet.
function refreshDashboardCacheNow() {
  const cache = CacheService.getScriptCache();
  const lock = trySoftLock(DASH_SOFTLOCK_NAME, DASH_SOFTLOCK_TTL_SECONDS, 0);
  if (!lock) return; // a real request is already rebuilding it
  try {
    const dirtySnapshot = readDirtySheets(cache);
    const result = readFromSheetWithVersion();
    storeDashboardPayload(cache, result);
    markLiveRebuild(cache);
    removeDirtySheets(dirtySnapshot);
  } finally {
    softUnlock(lock);
  }
}

// ============ HARD RESET: force a live read straight from the Sheet ============
// Used only by the "Update Data" button's manual clicks.
//
// #21 (timeout patch): this used to throw the cache away and re-read ALL 6
// sheets on every click, and several people clicking at once each did the full
// read.
//   - If nothing in the spreadsheet changed since the cached copy was built,
//     the cached copy is returned at once (the data is identical anyway).
//   - If something DID change, it still does a full live read, but only one
//     request does it at a time; others get the cached copy instead of piling on.
function getFreshestDataForced(forceFresh) {
  const cache = CacheService.getScriptCache();
  const cachedStamp = dashCacheStamp_(cache); // taken BEFORE the read (see dashCacheStamp_)
  const cached = readDashboardPayload(cache);
  const dirty = readDirtySheets(cache);

  let live = 0;
  try { live = getSheetModifiedTimeFast(!!forceFresh); } catch (err) { /* non-fatal */ }

  function unchanged(p, dirtyList) {
    return p !== null && !dirtyList.length && live > 0 &&
           (Number(p.dataVersion) || 0) >= live &&
           !cache.get(SELF_PATCH_KEY); // right after an in-app patch Drive's time can lag: do the full read
  }

  if (unchanged(cached, dirty)) {
    Logger.log("Hard reset: spreadsheet unchanged since the cached copy, serving CACHE.");
    return cached;
  }

  const lock = trySoftLock(DASH_SOFTLOCK_NAME, DASH_SOFTLOCK_TTL_SECONDS, cached !== null ? DASH_STALE_WAIT_MS : CACHE_LOCK_WAIT_MS);
  try {
    // Someone else may have rebuilt it while we waited. If the cache still
    // holds the very copy read above (already judged "changed"), skip the
    // second full download + parse.
    const dirtyAfterWait = readDirtySheets(cache);
    const sameCopy = cached !== null && cachedStamp !== null && !dirtyAfterWait.length && dashCacheStamp_(cache) === cachedStamp;
    const again = sameCopy ? cached : readDashboardPayload(cache);
    if (!sameCopy && unchanged(again, dirtyAfterWait)) return again;

    if (!lock) {
      const anyCopy = again !== null ? again : cached;
      if (anyCopy !== null) {
        Logger.log("Hard reset: another request is rebuilding, serving the cached copy.");
        return anyCopy;
      }
    }

    const dirtySnapshot = readDirtySheets(cache);
    const result = readFromSheetWithVersion(live);
    try {
      storeDashboardPayload(cache, result);
      markLiveRebuild(cache);
      removeDirtySheets(dirtySnapshot);
      cache.remove(SELF_PATCH_KEY);
    } catch (err) {
      Logger.log("getFreshestDataForced: could not warm cache after hard reset: " + err);
    }
    return result;
  } finally {
    softUnlock(lock);
  }
}
// ============ END HARD RESET ============

// CHUNK_SIZE is 30,000 CHARACTERS on purpose. CacheService caps each value
// at 100KB of BYTES, and one character can be up to 3 bytes (e.g. the peso
// sign, accented letters, smart quotes).
const CACHE_CHUNK_CHARS = 30000;
// #16: chunks are written in small batches (a single huge putAll() could fail
// as a whole and leave NOTHING cached).
const CACHE_PUTALL_BATCH = 20;
const CACHE_GETALL_BATCH = 50;

// ---- LIVE DATA (change detector) ----
const SHEET_MODTIME_CACHE_KEY = "dash_sheetmod_v1";
const SHEET_MODTIME_CACHE_TTL_SECONDS = 4;      // memo so many devices polling = ONE Drive lookup
const LIVE_REBUILD_GUARD_KEY = "dash_live_rebuild_guard_v1";
const LIVE_REBUILD_MIN_GAP_SECONDS = 15;        // at most one change-triggered rebuild per 15 s

// The Sheet's last-modified time (ms). Memoized for a few seconds.
function getSheetModifiedTimeFast(forceFresh) {
  const cache = CacheService.getScriptCache();
  try {
    const memo = forceFresh ? null : cache.get(SHEET_MODTIME_CACHE_KEY);
    if (memo) {
      const n = Number(memo);
      if (n > 0) return n;
    }
  } catch (err) { /* fall through to a live lookup */ }
  const t = DriveApp.getFileById(SPREADSHEET_ID).getLastUpdated().getTime();
  try { cache.put(SHEET_MODTIME_CACHE_KEY, String(t), SHEET_MODTIME_CACHE_TTL_SECONDS); } catch (err) { /* non-fatal */ }
  return t;
}

// True when the Sheet was edited after this cached payload was built.
// Never throws: on any doubt the cached copy is treated as fine.
// #18: right after an in-app save the cache was patched with the live sheet,
// but Drive's "last modified" time can lag a few seconds behind the write. For
// SELF_PATCH_GRACE_SECONDS after such a patch, a newer Drive time is adopted as
// the cached copy's version instead of triggering a pointless full rebuild.
// (Trade-off: a manual edit made in Google Sheets inside that 30 s window is
// picked up on the next change instead of immediately.)
function cachedPayloadIsStale(cache, payload) {
  try {
    const cachedVersion = Number(payload && payload.dataVersion) || 0;
    if (!cachedVersion) return false;
    const liveVersion = getSheetModifiedTimeFast();
    if (!(liveVersion > cachedVersion)) return false;
    if (cache.get(LIVE_REBUILD_GUARD_KEY)) return false; // rebuilt very recently
    if (cache.get(SELF_PATCH_KEY) && !readDirtySheets(cache).length) {
      cache.put(DASH_VER_KEY, String(liveVersion), RESPONSE_CACHE_TTL_SECONDS);
      payload.dataVersion = liveVersion;
      return false;
    }
    return true;
  } catch (err) {
    return false;
  }
}

function markLiveRebuild(cache) {
  try { cache.put(LIVE_REBUILD_GUARD_KEY, "1", LIVE_REBUILD_MIN_GAP_SECONDS); } catch (err) { /* non-fatal */ }
}

function cacheSetChunked(cache, key, obj, ttlSeconds) {
  try {
    const str = JSON.stringify(obj);
    const chunkCount = Math.max(1, Math.ceil(str.length / CACHE_CHUNK_CHARS));

    // Write the data chunks FIRST (in batches) and the ":meta" key LAST, so a
    // reader can never see a meta pointing at chunks that are not there yet.
    for (let start = 0; start < chunkCount; start += CACHE_PUTALL_BATCH) {
      const batch = {};
      for (let i = start; i < Math.min(chunkCount, start + CACHE_PUTALL_BATCH); i++) {
        batch[key + ":" + i] = str.substring(i * CACHE_CHUNK_CHARS, (i + 1) * CACHE_CHUNK_CHARS);
      }
      cache.putAll(batch, ttlSeconds);
    }
    cache.put(key + ":meta", String(chunkCount), ttlSeconds);
    return str; // Perf: lets the caller reuse the text (other callers ignore it)
  } catch (err) {
    Logger.log("Could not write response cache: " + err);
    // Do not leave a half-written entry behind.
    try { cache.remove(key + ":meta"); } catch (e2) { /* non-fatal */ }
    return null;
  }
}

// #20: split so the raw cached text can be served without parse + re-stringify.
function cacheGetChunkedString(cache, key, knownMetaStr) {
  try {
    // #24: callers that already fetched the ":meta" value pass it in.
    const metaStr = (knownMetaStr !== undefined) ? knownMetaStr : cache.get(key + ":meta");
    if (!metaStr) return null;
    const chunkCount = parseInt(metaStr, 10);
    if (!chunkCount || chunkCount < 1) return null;

    const chunkKeys = [];
    for (let i = 0; i < chunkCount; i++) chunkKeys.push(key + ":" + i);
    // getAll() accepts at most 100 keys per call, so read in batches.
    const chunks = {};
    for (let start = 0; start < chunkKeys.length; start += CACHE_GETALL_BATCH) {
      const got = cache.getAll(chunkKeys.slice(start, start + CACHE_GETALL_BATCH));
      Object.keys(got).forEach(function (k) { chunks[k] = got[k]; });
    }

    const parts = [];
    for (let i = 0; i < chunkCount; i++) {
      const part = chunks[key + ":" + i];
      if (part === undefined || part === null) return null;
      parts.push(part);
    }
    return parts.join("");
  } catch (err) {
    Logger.log("Could not read response cache: " + err);
    return null;
  }
}

function cacheGetChunked(cache, key) {
  const str = cacheGetChunkedString(cache, key);
  if (str === null) return null;
  try {
    return JSON.parse(str);
  } catch (err) {
    Logger.log("Could not parse response cache: " + err);
    return null;
  }
}

// #20: a fresh cached dashboard payload is sent as-is (no parse/stringify per
// request). Returns null whenever anything is dirty, stale or missing so the
// normal path runs instead.
function tryServeDashboardRaw_() {
  try {
    const cache = CacheService.getScriptCache();
    // #24: the three small keys this check needs, in ONE cache round trip.
    const pre = cache.getAll([DIRTY_SHEETS_KEY, DASH_VER_KEY, DASH_CACHE_KEY + ":meta", ANALYSIS_DATA_HASH_KEY]);
    if (parseDirtySheets_(pre[DIRTY_SHEETS_KEY]).length) return null;
    const ver = Number(pre[DASH_VER_KEY]) || 0;
    if (!ver) return null;
    if (!pre[DASH_CACHE_KEY + ":meta"]) return null;

    const probe = { dataVersion: ver };
    if (cachedPayloadIsStale(cache, probe)) return null;

    const str = cacheGetChunkedString(cache, DASH_CACHE_KEY, pre[DASH_CACHE_KEY + ":meta"]);
    if (!str || str.charAt(str.length - 1) !== "}") return null;

    // Stamp the current version (a repeated JSON key is fine: the last one wins).
    let out = str.slice(0, -1) + ',"dataVersion":' + (Number(probe.dataVersion) || ver);
    const hash = String(pre[ANALYSIS_DATA_HASH_KEY] || "");
    if (hash) out += ',"analysisDataHash":' + JSON.stringify(hash);
    return out + "}";
  } catch (err) {
    Logger.log("tryServeDashboardRaw_ fell back to the normal path: " + err);
    return null;
  }
}

function respondRawJson_(e, jsonString) {
  const callback = (e && e.parameter) ? safeJsonpCallback(e.parameter.callback) : null;
  if (callback) {
    return ContentService.createTextOutput(callback + "(" + jsonString + ")").setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(jsonString).setMimeType(ContentService.MimeType.JSON);
}

// Turns the array returned by FirestoreApp.getDocuments() into { docId: fields }.
function firestoreDocsToMap_(docs) {
  const map = {};
  (docs || []).forEach(function (doc) {
    const pathStr = doc.path || doc.name || "";
    const parts = pathStr.split("/");
    map[parts[parts.length - 1]] = doc.obj || doc.fields || doc;
  });
  return map;
}

// #22: read the tiny "_sync_meta" document FIRST. The big snapshot documents
// (the whole Sheet as JSON, megabytes) are only downloaded when Firestore is
// actually in sync with the Sheet; otherwise they would be thrown away anyway.
// No time trigger is created here any more (it made the first request after an
// edit slow); warmDashboardCache() repairs Firestore in the background.
function getFreshestData() {
  const sheetModifiedTime = getSheetModifiedTimeFast();

  let firestore = null;
  let firestoreReachable = false;
  let firestoreSyncedTime = 0;
  try {
    firestore = getFirestoreClient();
    firestoreSyncedTime = cachedFirestoreSynced_();
    if (!(firestoreSyncedTime >= sheetModifiedTime)) { // not known to be in sync: read the marker (as before)
      const metaDoc = firestoreDocsToMap_(firestore.getDocuments(FIRESTORE_COLLECTION, [SYNC_META_DOC_ID]))[SYNC_META_DOC_ID];
      firestoreSyncedTime = metaDoc ? (Number(metaDoc.lastSyncedSheetModifiedTime) || 0) : 0;
      rememberFirestoreSynced_(firestoreSyncedTime);
    }
    firestoreReachable = true;
  } catch (err) {
    Logger.log("Could not read Firestore sync marker, falling back to Sheet: " + err);
    firestoreReachable = false;
  }

  const sheetHasUnsyncedChanges = !firestoreReachable || sheetModifiedTime > firestoreSyncedTime;

  // `dataVersion` (the Sheet's last-modified time) lets the client skip a
  // full re-render when nothing changed. Purely additive.
  if (sheetHasUnsyncedChanges) {
    Logger.log("Serving data from: SHEET (newer than last Firestore sync, or Firestore/meta not available yet)");
    const sheetResult = readFromSheet();
    sheetResult.dataVersion = sheetModifiedTime;
    if (_lastFullSheetRead_) _lastFullSheetRead_.version = sheetModifiedTime; // looked up BEFORE the read
    return sheetResult;
  }

  try {
    Logger.log("Serving data from: FIRESTORE (in sync) — single batched read");
    const batch = firestoreDocsToMap_(firestore.getDocuments(FIRESTORE_COLLECTION, SHEET_NAMES.map(sheetNameToDocId)));
    const firestoreResult = readFromFirestoreBatch(batch);
    firestoreResult.dataVersion = sheetModifiedTime;
    return firestoreResult;
  } catch (err) {
    Logger.log("Reading/parsing Firestore snapshot failed, falling back to Sheet: " + err);
    const fallbackResult = readFromSheet();
    fallbackResult.dataVersion = sheetModifiedTime;
    if (_lastFullSheetRead_) _lastFullSheetRead_.version = sheetModifiedTime; // looked up BEFORE the read
    return fallbackResult;
  }
}

// #24: the values of the most recent full Sheet read in THIS execution (script
// variable, reset per invocation). syncSheetsToFirestore() reuses them when the
// warmer has just read the Sheet for a rebuild, instead of reading all sheets
// a second time. `version` is the modified time looked up BEFORE that read
// (0 = unknown => never reused).
let _lastFullSheetRead_ = null;

function readFromSheet() {
  const ss = getSpreadsheet_();
  const result = {};
  const memo = { at: Date.now(), version: 0, values: {} };
  SHEET_NAMES.forEach(function (sheetName) {
    const key = SHEET_KEY_MAP[sheetName];
    const sheet = ss.getSheetByName(sheetName);
    if (sheet) {
      const vals = sheet.getDataRange().getValues();
      memo.values[sheetName] = vals;
      result[key] = vals;
    } else {
      result[key] = [];
    }
  });
  _lastFullSheetRead_ = memo;
  return result;
}

function readFromFirestoreBatch(batch) {
  const result = {};
  SHEET_NAMES.forEach(function (sheetName) {
    const key = SHEET_KEY_MAP[sheetName];
    const docId = sheetNameToDocId(sheetName);
    const docObj = batch[docId];
    result[key] = docObj && docObj.valuesJson ? JSON.parse(docObj.valuesJson) : [];
  });
  return result;
}

// Memoized for the lifetime of ONE execution (a plain script-level
// variable, reset by Apps Script on every request — never stale across
// requests). Saves repeated OAuth handshakes (urlfetch) per request.
let _memoizedFirestoreClient = null;

function getFirestoreClient() {
  if (_memoizedFirestoreClient) return _memoizedFirestoreClient;

  const props = PropertiesService.getScriptProperties();
  const email = props.getProperty("FIRESTORE_CLIENT_EMAIL");
  const rawKey = props.getProperty("FIRESTORE_PRIVATE_KEY");
  const projectId = props.getProperty("FIRESTORE_PROJECT_ID");

  if (!email || !rawKey || !projectId) {
    throw new Error(
      "Missing Firestore credentials in Script Properties. Run setup() first."
    );
  }

  const key = normalizeFirestorePrivateKey(rawKey);

  _memoizedFirestoreClient = FirestoreApp.getFirestore(email, key, projectId);
  return _memoizedFirestoreClient;
}

function normalizeFirestorePrivateKey(rawKey) {
  let key = String(rawKey || "").trim();

  key = key.replace(/^"|"$/g, "").trim();
  key = key.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");

  if (key.indexOf("\n") !== -1) {
    return key.trim() + "\n";
  }

  const beginMarker = "-----BEGIN PRIVATE KEY-----";
  const endMarker = "-----END PRIVATE KEY-----";
  const beginIdx = key.indexOf(beginMarker);
  const endIdx = key.indexOf(endMarker);

  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(
      "FIRESTORE_PRIVATE_KEY has no newlines and is missing BEGIN/END PRIVATE KEY markers — cannot reconstruct a valid PEM. Re-copy the private_key value from the service account JSON file."
    );
  }

  const body = key.substring(beginIdx + beginMarker.length, endIdx).replace(/\s+/g, "");
  const wrappedLines = body.match(/.{1,64}/g) || [];

  return beginMarker + "\n" + wrappedLines.join("\n") + "\n" + endMarker + "\n";
}

// #16: one failing sheet no longer aborts the rest, and the "in sync" marker
// only advances when EVERY sheet was written (otherwise a half-synced
// Firestore would be trusted as fully current).
// Scheduled hourly path: a verified Firestore marker can skip the expensive full scan
// when the spreadsheet has not changed. Manual syncs, restore repairs, and deferred repair
// paths continue to call syncSheetsToFirestore() directly and always perform a full sync.
function syncSheetsToFirestoreIfChanged_() {
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  let checkedFirestore = null;
  let checkedSheetModifiedTime = 0;
  try {
    const dirty = readDirtySheets(cache);
    const hasPendingSync = !!(props.getProperty(DEFERRED_SYNC_PENDING_PROP) ||
                              props.getProperty(DEFERRED_FULL_SYNC_TRIGGER_PROP));
    const inRecentPatchGrace = !!cache.get(SELF_PATCH_KEY);

    // Never use a timestamp shortcut while a save may still be waiting to sync,
    // a sheet is marked dirty, or Drive's modified time may still be settling.
    if (!dirty.length && !hasPendingSync && !inRecentPatchGrace) {
      const live = DriveApp.getFileById(SPREADSHEET_ID).getLastUpdated().getTime();
      if (live > 0) {
        const firestore = getFirestoreClient();
        const meta = firestoreDocsToMap_(firestore.getDocuments(FIRESTORE_COLLECTION, [SYNC_META_DOC_ID]))[SYNC_META_DOC_ID];
        const synced = meta ? (Number(meta.lastSyncedSheetModifiedTime) || 0) : 0;
        if (synced >= live && synced > 0) {
          rememberFirestoreSynced_(synced);
          Logger.log("syncSheetsToFirestoreIfChanged_: skipped full sync; Firestore is already current (no source change).");
          return;
        }
        // Carry the already-created client and pre-read modified time into the full path.
        checkedFirestore = firestore;
        checkedSheetModifiedTime = live;
      }
    }
  } catch (err) {
    // If the cheap check is uncertain, fall through to the existing full sync.
    Logger.log("syncSheetsToFirestoreIfChanged_: change check unavailable; running full sync: " + err);
  }

  if (checkedFirestore && checkedSheetModifiedTime > 0) {
    syncSheetsToFirestore({ firestore: checkedFirestore, sheetModifiedTime: checkedSheetModifiedTime });
    return;
  }
  syncSheetsToFirestore();
}

function syncSheetsToFirestore(context) {
  context = context || null;
  const firestore = (context && context.firestore) ? context.firestore : getFirestoreClient();
  const ss = getSpreadsheet_();
  // Read the modified time BEFORE reading the sheets, so an edit that lands
  // mid-sync is seen as "newer than synced" next time instead of being lost.
  // #24: if this same execution just read every sheet (warmer rebuild), reuse
  // those values together with the modified time that was looked up BEFORE that
  // read -- same guarantee, no second full read. A standalone run (the hourly
  // manual / repair run) has no earlier read and behaves exactly as before.
  const reuse = (_lastFullSheetRead_ && _lastFullSheetRead_.version > 0 &&
                 (Date.now() - _lastFullSheetRead_.at) < 3 * 60 * 1000) ? _lastFullSheetRead_ : null;
  const sheetModifiedTime = reuse ? reuse.version :
    ((context && Number(context.sheetModifiedTime) > 0)
      ? Number(context.sheetModifiedTime)
      : DriveApp.getFileById(SPREADSHEET_ID).getLastUpdated().getTime());

  let failed = 0;
  SHEET_NAMES.forEach(function (sheetName) {
    try {
      let values = reuse ? reuse.values[sheetName] : undefined;
      if (values === undefined) {
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet) {
          Logger.log("Sheet not found, skipping: " + sheetName);
          return;
        }
        values = sheet.getDataRange().getValues();
      }
      const docId = sheetNameToDocId(sheetName);
      const payload = {
        sheetName: sheetName,
        valuesJson: JSON.stringify(values),
        syncedAt: new Date().toISOString()
      };

      upsertDocument(firestore, FIRESTORE_COLLECTION + "/" + docId, payload);
      Logger.log("Synced sheet to Firestore: " + sheetName);
    } catch (err) {
      failed++;
      Logger.log("syncSheetsToFirestore: FAILED to sync \"" + sheetName + "\" (continuing with the others): " + err);
    }
  });

  if (failed === 0) {
    const metaPayload = {
      lastSyncedSheetModifiedTime: sheetModifiedTime,
      syncedAt: new Date().toISOString()
    };
    upsertDocument(firestore, FIRESTORE_COLLECTION + "/" + SYNC_META_DOC_ID, metaPayload);
    Logger.log("Firestore sync complete. Sheet modified time recorded: " + sheetModifiedTime);
  } else {
    Logger.log("Firestore sync INCOMPLETE (" + failed + " sheet(s) failed) — 'in sync' marker NOT advanced, so the dashboard keeps reading the live Sheet.");
  }

  // #18: the cached payload is NOT cleared here any more. A sync copies the
  // Sheet into Firestore without changing the Sheet, so the cached copy is
  // still right (and any later Sheet change is caught by the version check).
}

function upsertDocument(firestore, path, fields) {
  try {
    firestore.updateDocument(path, fields, true);
  } catch (err) {
    firestore.createDocument(path, fields);
  }
}

function createHourlySyncTrigger() {
  // Replace both the old full-sync trigger and the change-aware handler, so
  // re-running setup cannot leave duplicate hourly jobs behind.
  deleteTriggersForHandler_("syncSheetsToFirestore");
  deleteTriggersForHandler_("syncSheetsToFirestoreIfChanged_");
  ScriptApp.newTrigger("syncSheetsToFirestoreIfChanged_")
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log("Hourly change-aware sync trigger created (full Sheet-to-Firestore sync runs only when needed).");
}

// ================= AUTOMATIC BACKUPS + RESTORE =================
// backupSpreadsheet(): timestamped Drive copy of the whole spreadsheet,
// run weekly (run createWeeklyBackupTrigger() ONCE to turn it on).
// restoreSheetsFromBackup(): MANUAL, admin-run recovery — deliberately NOT
// exposed through doGet.

const BACKUP_FOLDER_ID_PROP = "BACKUP_FOLDER_ID";
const BACKUP_ALERT_EMAIL_PROP = "BACKUP_ALERT_EMAIL"; // optional override; falls back to account managers
const BACKUP_EMAIL_RECIPIENT_PROP = "BACKUP_EMAIL_RECIPIENT"; // offsite copy recipient (opt-in)
const BACKUP_EMAIL_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const BACKUP_RETENTION_DAYS = 15;   // delete backups older than this...
const BACKUP_MIN_KEEP = 10;         // ...but never go below this many
const BACKUP_LOG_COLLECTION = "backup_log";

function getOrCreateBackupFolder() {
  const props = PropertiesService.getScriptProperties();
  const storedId = props.getProperty(BACKUP_FOLDER_ID_PROP);
  if (storedId) {
    try {
      return DriveApp.getFolderById(storedId);
    } catch (err) {
      Logger.log("Stored backup folder id is no longer valid, recreating: " + err);
    }
  }
  const folder = DriveApp.createFolder("Audit Dashboard Backups");
  props.setProperty(BACKUP_FOLDER_ID_PROP, folder.getId());
  Logger.log("Created new backup folder: " + folder.getUrl());
  return folder;
}

function logBackupEvent(status, details) {
  try {
    const firestore = getFirestoreClient();
    const id = Utilities.getUuid();
    upsertDocument(firestore, BACKUP_LOG_COLLECTION + "/" + id, {
      status: status, // "success" | "failure" | "restore"
      details: JSON.stringify(details || {}),
      at: Date.now(),
      atIso: new Date().toISOString()
    });
  } catch (err) {
    Logger.log("logBackupEvent failed (non-fatal): " + err);
  }
}

function notifyBackupFailure(err) {
  try {
    const props = PropertiesService.getScriptProperties();
    const overrideEmail = props.getProperty(BACKUP_ALERT_EMAIL_PROP);
    const recipients = overrideEmail ? [overrideEmail] : ACTIVE_ACCOUNTS_MANAGER_EMAILS;
    if (!recipients || !recipients.length) return;
    const message = "The scheduled Audit Dashboard backup failed just now.\n\n" +
      "Error: " + (err && err.message ? err.message : String(err)) + "\n\n" +
      "This does NOT mean any data was lost -- it means today's backup copy was not created. " +
      "Check Apps Script > Executions for the full stack trace, and confirm the weekly backup " +
      "trigger is still installed (createWeeklyBackupTrigger()).";
    MailApp.sendEmail({
      to: recipients.join(","),
      subject: "\u26A0\uFE0F Audit Dashboard backup FAILED",
      body: message
    });
  } catch (mailErr) {
    Logger.log("notifyBackupFailure: could not send alert email: " + mailErr);
  }
}

// Emails the backup as an xlsx attachment to BACKUP_EMAIL_RECIPIENT
// (best-effort; never makes backupSpreadsheet() report failure).
function emailBackupCopy(driveFile, backupName) {
  try {
    const props = PropertiesService.getScriptProperties();
    const recipient = props.getProperty(BACKUP_EMAIL_RECIPIENT_PROP);
    if (!recipient) return;

    // Native Google Sheets must go through the Drive export endpoint.
    const exportUrl = "https://docs.google.com/spreadsheets/d/" + driveFile.getId() + "/export?format=xlsx";
    const exportResponse = UrlFetchApp.fetch(exportUrl, {
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (exportResponse.getResponseCode() !== 200) {
      throw new Error("Sheet export to xlsx failed with HTTP " + exportResponse.getResponseCode() + ": " + exportResponse.getContentText());
    }
    const xlsxBlob = exportResponse.getBlob().setName(backupName + ".xlsx");
    const sizeBytes = xlsxBlob.getBytes().length;
    if (sizeBytes > BACKUP_EMAIL_MAX_ATTACHMENT_BYTES) {
      Logger.log("emailBackupCopy: backup is " + Math.round(sizeBytes / 1024 / 1024) + "MB, over the " +
        Math.round(BACKUP_EMAIL_MAX_ATTACHMENT_BYTES / 1024 / 1024) + "MB email limit -- sending a link instead of the attachment.");
      MailApp.sendEmail({
        to: recipient,
        subject: "Audit Dashboard backup - " + backupName + " (too large to attach)",
        body: "Today's backup (" + Math.round(sizeBytes / 1024 / 1024) + "MB) is too large to email as an attachment.\n\n" +
          "View/download it from Drive instead: " + driveFile.getUrl()
      });
      return;
    }

    MailApp.sendEmail({
      to: recipient,
      subject: "Audit Dashboard backup - " + backupName,
      body: "Attached: today's full backup of the Audit Dashboard spreadsheet.\n\n" +
        "Also stored in Drive: " + driveFile.getUrl(),
      attachments: [xlsxBlob]
    });
    Logger.log("emailBackupCopy: sent " + Math.round(sizeBytes / 1024) + "KB backup to " + recipient);
  } catch (err) {
    Logger.log("emailBackupCopy: failed to send, backup file itself is still safe in Drive: " + err);
  }
}

// Deletes backups past BACKUP_RETENTION_DAYS old, but always keeps at least
// BACKUP_MIN_KEEP most-recent ones regardless of age. At a weekly cadence,
// BACKUP_MIN_KEEP=10 alone guarantees ~10 weeks of history.
function pruneOldBackups(folder) {
  const cutoffMs = Date.now() - (BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const entries = [];
  const it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) {
    const f = it.next();
    entries.push({ file: f, createdMs: f.getDateCreated().getTime() });
  }
  entries.sort(function (a, b) { return b.createdMs - a.createdMs; }); // newest first

  let trashedCount = 0;
  entries.forEach(function (entry, idx) {
    if (idx < BACKUP_MIN_KEEP) return;
    if (entry.createdMs < cutoffMs) {
      try {
        entry.file.setTrashed(true);
        trashedCount++;
      } catch (err) {
        Logger.log("pruneOldBackups: could not trash " + entry.file.getName() + ": " + err);
      }
    }
  });
  if (trashedCount) Logger.log("pruneOldBackups: trashed " + trashedCount + " backup(s) older than " + BACKUP_RETENTION_DAYS + " days.");
}

function backupSpreadsheet() {
  const startedAt = Date.now();
  try {
    const sourceFile = DriveApp.getFileById(SPREADSHEET_ID);
    const folder = getOrCreateBackupFolder();
    const tz = Session.getScriptTimeZone() || "UTC";
    const stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd_HH-mm");
    const backupName = "Audit Dashboard Backup - " + stamp;

    const copy = sourceFile.makeCopy(backupName, folder);
    pruneOldBackups(folder);
    emailBackupCopy(copy, backupName);

    const durationMs = Date.now() - startedAt;
    logBackupEvent("success", { fileId: copy.getId(), name: backupName, durationMs: durationMs });
    Logger.log("Backup succeeded: " + backupName + " (" + copy.getId() + ") in " + durationMs + "ms");
    return { success: true, fileId: copy.getId(), name: backupName, url: copy.getUrl() };
  } catch (err) {
    Logger.log("Backup FAILED: " + err);
    logBackupEvent("failure", { error: String(err && err.message ? err.message : err) });
    notifyBackupFailure(err);
    throw err;
  }
}

// Run ONCE from the editor to enable weekly backups (Sunday ~8am). Safe to
// re-run: removes any existing backup trigger first.
function createWeeklyBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "backupSpreadsheet") {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger("backupSpreadsheet")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(8)
    .create();
  Logger.log("Weekly backup trigger created (runs ~8am every Sunday, " + (Session.getScriptTimeZone() || "script timezone") + ").");
}

// Lists backups, newest first, to find the fileId to restore from.
function listAvailableBackups() {
  const folder = getOrCreateBackupFolder();
  const it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  const rows = [];
  while (it.hasNext()) {
    const f = it.next();
    rows.push({ name: f.getName(), fileId: f.getId(), createdAt: f.getDateCreated().toISOString(), url: f.getUrl() });
  }
  rows.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  rows.forEach(function (r) { Logger.log(r.createdAt + "  " + r.name + "  " + r.fileId); });
  return rows;
}

// ---- RESTORE (run by hand from the editor) ----
// Replaces each named tab's used range with the backup tab's VALUES. Does
// not touch SPREADSHEET_ID, sharing, the project, or triggers. Takes its own
// safety snapshot of the current state first.
//   1. listAvailableBackups() -> copy a fileId
//   2. restoreSheetsFromBackup("fileId")  or  restoreSheetsFromBackup("fileId", ["AUDIT DATA (FINAL)"])
//   3. syncSheetsToFirestore() so the dashboard shows the restored data now
function restoreSheetsFromBackup(backupFileId, sheetNames) {
  if (!backupFileId) throw new Error("restoreSheetsFromBackup: backupFileId is required. Run listAvailableBackups() to find one.");
  const namesToRestore = (sheetNames && sheetNames.length) ? sheetNames : SHEET_NAMES;

  const preRestoreSnapshot = backupSpreadsheet();
  Logger.log("Pre-restore safety snapshot created: " + preRestoreSnapshot.name + " (" + preRestoreSnapshot.fileId + ")");

  const backupSs = SpreadsheetApp.openById(backupFileId);
  const liveSs = SpreadsheetApp.openById(SPREADSHEET_ID);

  const restored = [];
  const skipped = [];
  namesToRestore.forEach(function (sheetName) {
    const backupSheet = backupSs.getSheetByName(sheetName);
    const liveSheet = liveSs.getSheetByName(sheetName);
    if (!backupSheet || !liveSheet) {
      skipped.push(sheetName);
      Logger.log("restoreSheetsFromBackup: skipping \"" + sheetName + "\" -- not found in " + (!backupSheet ? "backup" : "live sheet") + ".");
      return;
    }
    liveSheet.clearContents();
    const values = backupSheet.getDataRange().getValues();
    if (values.length && values[0].length) {
      liveSheet.getRange(1, 1, values.length, values[0].length).setValues(values);
    }
    restored.push(sheetName);
  });

  logBackupEvent("restore", {
    fromFileId: backupFileId,
    sheetsRestored: restored,
    sheetsSkipped: skipped,
    preRestoreSnapshotFileId: preRestoreSnapshot.fileId
  });
  Logger.log("Restore complete. Restored: " + restored.join(", ") + (skipped.length ? (" | Skipped (not found): " + skipped.join(", ")) : ""));
  Logger.log("IMPORTANT: now run syncSheetsToFirestore() so the live dashboard picks up the restored data immediately.");
  return { restored: restored, skipped: skipped, preRestoreSnapshotFileId: preRestoreSnapshot.fileId };
}
// ================= END AUTOMATIC BACKUPS + RESTORE =================

// Read-only helper behind action=auditLog: most recent audit_log entries,
// sorted client-side (fine at this dashboard's volume).
function getRecentAuditLog(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  const limit = Math.min(parseInt(p.limit, 10) || 50, 200);

  const firestore = getFirestoreClient();
  let docs = null;
  try {
    // #18: newest-first with a limit, so Firestore sends `limit` rows instead
    // of the whole 30-day collection. Falls back to the full read below.
    docs = firestore.query(AUDIT_LOG_COLLECTION).OrderBy("at", "desc").Limit(limit).Execute() || [];
  } catch (orderErr) {
    Logger.log("getRecentAuditLog: ordered query failed, falling back to full read: " + orderErr);
    docs = null;
  }
  if (docs === null) {
    try {
      // query() returns a builder; .Execute() runs it.
      docs = firestore.query(AUDIT_LOG_COLLECTION).Execute() || [];
    } catch (err) {
      Logger.log("getRecentAuditLog: query failed, returning empty: " + err);
      return { success: true, entries: [] };
    }
  }

  const entries = docs
    .map(function (doc) { return doc.obj || doc.fields || doc; })
    .filter(Boolean)
    .sort(function (a, b) { return (b.at || 0) - (a.at || 0); })
    .slice(0, limit)
    .map(function (d) {
      let details = {};
      try { details = JSON.parse(d.details || "{}"); } catch (err) { /* ignore */ }
      return { actor: d.actor, action: d.action, at: d.at, atIso: d.atIso, details: details };
    });

  return { success: true, entries: entries };
}

// ============================================================
// AUDIT LOG RETENTION — deletes entries older than
// AUDIT_LOG_RETENTION_DAYS. Run createDailyAuditLogPurgeTrigger() ONCE.
// ============================================================
function purgeOldAuditLogEntries() {
  const cutoffMs = Date.now() - (AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const firestore = getFirestoreClient();

  let docs;
  try {
    docs = firestore.query(AUDIT_LOG_COLLECTION).Execute() || [];
  } catch (err) {
    Logger.log("purgeOldAuditLogEntries: query failed, nothing to purge: " + err);
    return;
  }

  let deletedCount = 0;
  docs.forEach(function (doc) {
    const data = doc.obj || doc.fields || doc;
    if (!data || typeof data.at !== "number" || data.at >= cutoffMs) return;

    const pathStr = doc.path || doc.name || "";
    if (!pathStr) return;

    try {
      firestore.deleteDocument(pathStr);
      deletedCount++;
    } catch (err) {
      Logger.log("purgeOldAuditLogEntries: failed to delete " + pathStr + ": " + err);
    }
  });

  Logger.log("purgeOldAuditLogEntries: removed " + deletedCount + " entr" + (deletedCount === 1 ? "y" : "ies") + " older than " + AUDIT_LOG_RETENTION_DAYS + " days.");
}

function createDailyAuditLogPurgeTrigger() {
  deleteTriggersForHandler_("purgeOldAuditLogEntries");
  ScriptApp.newTrigger("purgeOldAuditLogEntries")
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();
  Logger.log("Daily audit log purge trigger created (runs ~3am, deletes entries older than " + AUDIT_LOG_RETENTION_DAYS + " days).");
}

// ================= OVERALL DATA — "Update Sheet" + STRUCTURED READ =================
const OVERALL_DATA_SHEET_NAME = "OVERALL DATA";

const AUDIT_HDR_SECTION_ROW = 2;
const AUDIT_HDR_GROUP_ROW = 3;
const AUDIT_HDR_COL_ROW = 4;
const AUDIT_DATA_FIRST_DATA_ROW = 5;

// Resolves the "Expected Date To Audit" / rotation-round / "Up Next
// Auditor" columns by reading their header text off AUDIT_HDR_COL_ROW, so
// inserting/removing a column can't silently desync writes. Cached per
// sheet for the lifetime of one execution.
const _auditDataFinalColumnsCacheBySheetId = {};
function resolveAuditDataFinalColumns(sheet) {
  const cacheKey = sheet.getSheetId();
  const cached = _auditDataFinalColumnsCacheBySheetId[cacheKey];
  if (cached) return cached;

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(AUDIT_HDR_COL_ROW, 1, 1, lastCol).getValues()[0]
    .map(function (v) { return String(v || "").trim().toUpperCase(); });

  function findCol(label) {
    const idx = headers.indexOf(label.toUpperCase());
    if (idx === -1) {
      throw new Error("Could not find a '" + label + "' header in row " + AUDIT_HDR_COL_ROW + " of " + sheet.getName() + ".");
    }
    return idx + 1;
  }

  const expectedDateCol = findCol("EXPECTED DATE TO AUDIT");
  const round1DateCol = findCol("DATE OF 1ST ROTATION");
  // Each round is an AUDITOR column followed by its DATE column, so the
  // rotation block starts one column before "DATE OF 1ST ROTATION".
  const rotationStartCol = round1DateCol - 1;
  const upNextAuditorCol = findCol("UP NEXT AUDITOR");

  const resolved = {
    expectedDateCol: expectedDateCol,
    rotationStartCol: rotationStartCol,
    upNextAuditorCol: upNextAuditorCol
  };
  _auditDataFinalColumnsCacheBySheetId[cacheKey] = resolved;
  return resolved;
}

const OVERALL_HDR_SECTION_ROW = 1;
const OVERALL_HDR_GROUP_ROW = 2;
const OVERALL_HDR_COL_ROW = 3;
const OVERALL_DATA_FIRST_DATA_ROW = 4;
const OVERALL_DATA_NO_COL = 1;
const OVERALL_DATA_BRANCH_COL = 2;

const MONTH_ABBREVIATIONS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function canonicalMonthKey(text) {
  const t = String(text || "").trim().toUpperCase();
  if (t.length < 3) return null;
  const key = t.substring(0, 3);
  return MONTH_ABBREVIATIONS.indexOf(key) !== -1 ? key : null;
}

// Reads a header row as blocks (merged or repeated-text runs). Speed: the
// label of a merged block used to be fetched with its own getRange().getValue()
// round trip PER block; it now comes from the single getValues() already
// read for the row (an extra call is only made for a merge that starts left
// of the requested range, which is rare).
function getHeaderBlocks(sheet, rowIndex, startCol, endCol) {
  const width = endCol - startCol + 1;
  const range = sheet.getRange(rowIndex, startCol, 1, width);
  const values = range.getValues()[0];
  const merges = range.getMergedRanges();

  const mergeForCol = {};
  merges.forEach(function (m) {
    const mStart = m.getColumn();
    const mEnd = mStart + m.getNumColumns() - 1;
    for (let c = mStart; c <= mEnd; c++) mergeForCol[c] = { startCol: mStart, endCol: mEnd };
  });

  const singleCellBlocks = [];
  let col = startCol;
  while (col <= endCol) {
    const info = mergeForCol[col];
    if (info) {
      let label;
      if (info.startCol >= startCol) {
        label = String(values[info.startCol - startCol] || "").trim();
      } else {
        label = String(sheet.getRange(rowIndex, info.startCol).getValue() || "").trim();
      }
      singleCellBlocks.push({ label: label, startCol: info.startCol, endCol: info.endCol });
      col = info.endCol + 1;
    } else {
      const label = String(values[col - startCol] || "").trim();
      singleCellBlocks.push({ label: label, startCol: col, endCol: col });
      col++;
    }
  }

  const blocks = [];
  singleCellBlocks.forEach(function (b) {
    const last = blocks[blocks.length - 1];
    if (last && b.label !== "" && last.label === b.label) {
      last.endCol = b.endCol;
    } else {
      blocks.push({ label: b.label, startCol: b.startCol, endCol: b.endCol });
    }
  });
  return blocks;
}

// #24: callers that look up several sections of the same row pass the blocks
// they already read (`preBlocks`) instead of re-reading the row each time.
function findSectionColumnRange(sheet, sectionHeaderRow, sectionName, preBlocks) {
  const blocks = preBlocks || getHeaderBlocks(sheet, sectionHeaderRow, 1, sheet.getLastColumn());
  const match = blocks.filter(function (b) { return b.label.toUpperCase() === sectionName.toUpperCase(); })[0];
  if (!match) {
    throw new Error("Could not find a '" + sectionName + "' section header in row " + sectionHeaderRow + " of " + sheet.getName() + ".");
  }
  return match;
}

function getCollectionMetricBlocks(sheet, groupHeaderRow, sectionRange) {
  const blocks = getHeaderBlocks(sheet, groupHeaderRow, sectionRange.startCol, sectionRange.endCol);
  return blocks.filter(function (b) { return b.label !== ""; });
}

function getSalesMonthBlocks(sheet, groupHeaderRow, sectionRange) {
  const blocks = getHeaderBlocks(sheet, groupHeaderRow, sectionRange.startCol, sectionRange.endCol);
  return blocks.filter(function (b) { return canonicalMonthKey(b.label) !== null; });
}

function getServiceMonthColumns(sheet, colHeaderRow, sectionRange) {
  const width = sectionRange.endCol - sectionRange.startCol + 1;
  const labels = sheet.getRange(colHeaderRow, sectionRange.startCol, 1, width).getValues()[0];
  const monthCols = [];
  for (let i = 1; i < labels.length; i++) {
    const key = canonicalMonthKey(labels[i]);
    if (key) {
      monthCols.push({ col: sectionRange.startCol + i, key: key });
    } else if (monthCols.length) {
      break;
    }
  }
  return monthCols;
}

function getCollectionMetricMonthColumns(sheet, groupHeaderRow, colHeaderRow, sectionRange) {
  const metricBlocks = getCollectionMetricBlocks(sheet, groupHeaderRow, sectionRange);
  return metricBlocks.map(function (block) {
    const width = block.endCol - block.startCol + 1;
    const labels = sheet.getRange(colHeaderRow, block.startCol, 1, width).getValues()[0];
    const months = [];
    for (let i = 0; i < labels.length; i++) {
      const key = canonicalMonthKey(labels[i]);
      if (key) months.push({ key: key, col: block.startCol + i });
    }
    return { label: block.label, startCol: block.startCol, endCol: block.endCol, months: months };
  });
}

function getAuditMonthsList(auditSheet) {
  const sectionBlocks = getHeaderBlocks(auditSheet, AUDIT_HDR_SECTION_ROW, 1, auditSheet.getLastColumn());
  const collectionRange = findSectionColumnRange(auditSheet, AUDIT_HDR_SECTION_ROW, "COLLECTION", sectionBlocks);
  const collectionMetrics = getCollectionMetricMonthColumns(auditSheet, AUDIT_HDR_GROUP_ROW, AUDIT_HDR_COL_ROW, collectionRange);

  const salesRange = findSectionColumnRange(auditSheet, AUDIT_HDR_SECTION_ROW, "SALES", sectionBlocks);
  const salesBlocks = getSalesMonthBlocks(auditSheet, AUDIT_HDR_GROUP_ROW, salesRange);
  const salesMonths = salesBlocks.map(function (b) { return canonicalMonthKey(b.label); });

  const serviceRange = findSectionColumnRange(auditSheet, AUDIT_HDR_SECTION_ROW, "SERVICE", sectionBlocks);
  const serviceCols = getServiceMonthColumns(auditSheet, AUDIT_HDR_COL_ROW, serviceRange);
  const serviceMonths = serviceCols.map(function (c) { return c.key; });

  if (!serviceMonths.length) {
    throw new Error("Could not find any month columns in AUDIT DATA (FINAL)'s SERVICE section.");
  }

  const canonical = serviceMonths;

  function assertSameSequence(actual, label) {
    const mismatch = actual.length !== canonical.length || actual.some(function (v, i) { return v !== canonical[i]; });
    if (mismatch) {
      throw new Error("AUDIT DATA (FINAL)'s " + label + " months (" + actual.join(",") +
        ") don't match its Service months (" + canonical.join(",") + "). Fix AUDIT DATA (FINAL) before running Update Sheet.");
    }
  }
  assertSameSequence(salesMonths, "Sales");
  collectionMetrics.forEach(function (m) {
    assertSameSequence(m.months.map(function (x) { return x.key; }), "Collection ('" + m.label + "')");
  });

  return {
    months: canonical,
    collectionMetrics: collectionMetrics,
    salesBlocks: salesBlocks,
    serviceCols: serviceCols
  };
}

function getOverallMonthsInfo(overallSheet) {
  const sectionBlocks = getHeaderBlocks(overallSheet, OVERALL_HDR_SECTION_ROW, 1, overallSheet.getLastColumn());
  const collectionRange = findSectionColumnRange(overallSheet, OVERALL_HDR_SECTION_ROW, "COLLECTION", sectionBlocks);
  const collectionMetrics = getCollectionMetricMonthColumns(overallSheet, OVERALL_HDR_GROUP_ROW, OVERALL_HDR_COL_ROW, collectionRange);
  if (collectionMetrics.length !== 4) {
    throw new Error("OVERALL DATA's COLLECTION section doesn't have exactly 4 metric columns (found " +
      collectionMetrics.length + "). Fix OVERALL DATA before running Update Sheet.");
  }

  const salesRange = findSectionColumnRange(overallSheet, OVERALL_HDR_SECTION_ROW, "SALES", sectionBlocks);
  const salesBlocks = getSalesMonthBlocks(overallSheet, OVERALL_HDR_GROUP_ROW, salesRange);

  const serviceRange = findSectionColumnRange(overallSheet, OVERALL_HDR_SECTION_ROW, "SERVICE", sectionBlocks);
  const serviceCols = getServiceMonthColumns(overallSheet, OVERALL_HDR_COL_ROW, serviceRange);

  const serviceMonthSet = {};
  serviceCols.forEach(function (c) { serviceMonthSet[c.key] = true; });

  const salesMonthSet = {};
  salesBlocks.forEach(function (b) { salesMonthSet[canonicalMonthKey(b.label)] = true; });

  const allSets = collectionMetrics.map(function (m) {
    const s = {};
    m.months.forEach(function (x) { s[x.key] = true; });
    return s;
  }).concat([salesMonthSet, serviceMonthSet]);

  // monthSet = INTERSECTION of all sections; a month present in only some
  // sections is reported in partialMonths so updateOverallDataWithLatestMonth()
  // can self-heal it via repairPartialMonths() instead of throwing.
  const unionKeys = {};
  allSets.forEach(function (s) { for (const k in s) unionKeys[k] = true; });

  const monthSet = {};
  const partialMonths = {};
  for (const k in unionKeys) {
    const presentInCount = allSets.filter(function (s) { return !!s[k]; }).length;
    if (presentInCount === allSets.length) {
      monthSet[k] = true;
    } else {
      partialMonths[k] = true;
    }
  }

  return {
    monthSet: monthSet,
    partialMonths: partialMonths,
    collectionMetrics: collectionMetrics,
    salesRange: salesRange,
    salesBlocks: salesBlocks,
    serviceRange: serviceRange,
    serviceCols: serviceCols
  };
}

// Fixes a month present in some OVERALL DATA sections but missing from
// others (an interrupted earlier Update Sheet run): inserts ONLY the
// missing section columns, then backfills data for existing branch rows.
// Returns the list of month keys repaired.
function repairPartialMonths(auditSheet, overallSheet, auditMonthInfo) {
  const repaired = [];

  let info = getOverallMonthsInfo(overallSheet);
  const orderedKeys = auditMonthInfo.months.filter(function (m) {
    return !!info.partialMonths[m];
  });

  orderedKeys.forEach(function (monthKey) {
    info = getOverallMonthsInfo(overallSheet);
    if (!info.partialMonths[monthKey]) return;

    const points = [];

    info.collectionMetrics.forEach(function (oMetric) {
      const already = oMetric.months.some(function (x) { return x.key === monthKey; });
      if (already) return;
      const aMetric = auditMonthInfo.collectionMetrics.filter(function (m) {
        return normalizeHeaderLabel(m.label) === normalizeHeaderLabel(oMetric.label);
      })[0];
      if (!aMetric) throw new Error("Cannot repair " + monthKey + ": AUDIT DATA (FINAL) has no Collection column '" + oMetric.label + "'.");
      const auditEntry = aMetric.months.filter(function (x) { return x.key === monthKey; })[0];
      if (!auditEntry) throw new Error("Cannot repair " + monthKey + ": not found in AUDIT DATA (FINAL)'s '" + oMetric.label + "' Collection column.");
      const lastMonth = oMetric.months.length ? oMetric.months[oMetric.months.length - 1] : null;
      const afterCol = lastMonth ? lastMonth.col : oMetric.endCol;
      points.push({ kind: "collection", afterCol: afterCol, width: 1, auditCol: auditEntry.col, label: oMetric.label });
    });

    const hasSales = info.salesBlocks.some(function (b) { return canonicalMonthKey(b.label) === monthKey; });
    if (!hasSales) {
      const auditSalesBlock = auditMonthInfo.salesBlocks.filter(function (b) { return canonicalMonthKey(b.label) === monthKey; })[0];
      if (!auditSalesBlock) throw new Error("Cannot repair " + monthKey + ": not found in AUDIT DATA (FINAL)'s SALES section.");
      const lastSalesMonth = info.salesBlocks.length ? info.salesBlocks[info.salesBlocks.length - 1] : null;
      const salesAfterCol = lastSalesMonth ? lastSalesMonth.endCol : (info.salesRange.startCol - 1);
      points.push({ kind: "sales", afterCol: salesAfterCol, width: 3, auditCol: auditSalesBlock.startCol });
    }

    const hasService = info.serviceCols.some(function (c) { return c.key === monthKey; });
    if (!hasService) {
      const auditServiceCol = auditMonthInfo.serviceCols.filter(function (c) { return c.key === monthKey; })[0];
      if (!auditServiceCol) throw new Error("Cannot repair " + monthKey + ": not found in AUDIT DATA (FINAL)'s SERVICE section.");
      const lastServiceMonth = info.serviceCols.length ? info.serviceCols[info.serviceCols.length - 1] : null;
      const serviceAfterCol = lastServiceMonth ? lastServiceMonth.col : (info.serviceRange.startCol - 1);
      points.push({ kind: "service", afterCol: serviceAfterCol, width: 1, auditCol: auditServiceCol.col });
    }

    if (!points.length) return;

    const ascending = points.slice().sort(function (a, b) { return a.afterCol - b.afterCol; });
    let cumulative = 0;
    ascending.forEach(function (pt) {
      pt.finalStartCol = pt.afterCol + 1 + cumulative;
      cumulative += pt.width;
    });
    const descending = points.slice().sort(function (a, b) { return b.afterCol - a.afterCol; });

    const insertedPoints = [];
    try {
      descending.forEach(function (pt) {
        overallSheet.insertColumnsAfter(pt.afterCol, pt.width);
        insertedPoints.push(pt);
      });

      points.forEach(function (pt) {
        const startCol = pt.finalStartCol;
        if (pt.kind === "collection") {
          overallSheet.getRange(OVERALL_HDR_GROUP_ROW, startCol).setValue(pt.label);
          const monthLabel = auditSheet.getRange(AUDIT_HDR_COL_ROW, pt.auditCol).getValue();
          overallSheet.getRange(OVERALL_HDR_COL_ROW, startCol).setValue(monthLabel);
        } else if (pt.kind === "sales") {
          const monthLabel = auditSheet.getRange(AUDIT_HDR_GROUP_ROW, pt.auditCol).getValue();
          overallSheet.getRange(OVERALL_HDR_GROUP_ROW, startCol).setValue(monthLabel);
          const subLabels = auditSheet.getRange(AUDIT_HDR_COL_ROW, pt.auditCol, 1, 3).getValues();
          overallSheet.getRange(OVERALL_HDR_COL_ROW, startCol, 1, 3).setValues(subLabels);
        } else if (pt.kind === "service") {
          const monthLabel = auditSheet.getRange(AUDIT_HDR_COL_ROW, pt.auditCol).getValue();
          overallSheet.getRange(OVERALL_HDR_COL_ROW, startCol).setValue(monthLabel);
        }
        autoMergeMonthHeader(overallSheet, OVERALL_HDR_GROUP_ROW, pt);
        extendSectionTitleMerge(overallSheet, OVERALL_HDR_SECTION_ROW, pt);
      });
    } catch (err) {
      insertedPoints.forEach(function (pt) {
        try { overallSheet.deleteColumns(pt.finalStartCol, pt.width); } catch (e2) {
          Logger.log("Rollback failed while repairing " + monthKey + " at col " + pt.finalStartCol + ": " + e2);
        }
      });
      throw new Error("Failed to repair " + monthKey + " in OVERALL DATA, rolled back the partial change: " + (err && err.message ? err.message : err));
    }

    // Backfill only the newly-added columns; existing data is untouched.
    const auditLastRow = auditSheet.getLastRow();
    const auditLastCol = auditSheet.getLastColumn();
    const auditRows = auditSheet.getRange(
      AUDIT_DATA_FIRST_DATA_ROW, 1,
      Math.max(auditLastRow - AUDIT_DATA_FIRST_DATA_ROW + 1, 0), auditLastCol
    ).getValues();
    const auditRowByBranchKey = {};
    auditRows.forEach(function (r) {
      const bn = String(r[1] || r[0] || "").trim();
      if (bn) auditRowByBranchKey[normalizeBranchNameForMatch(bn)] = r;
    });

    const overallLastRow = overallSheet.getLastRow();
    if (overallLastRow >= OVERALL_DATA_FIRST_DATA_ROW) {
      const branchNames = overallSheet.getRange(
        OVERALL_DATA_FIRST_DATA_ROW, OVERALL_DATA_BRANCH_COL,
        overallLastRow - OVERALL_DATA_FIRST_DATA_ROW + 1, 1
      ).getValues();

      // #21: batched - one setValues() per new column block instead of one
      // write per branch per cell.
      const rowCount = branchNames.length;
      const matched = []; // { idx, auditRow }
      for (let r = 0; r < rowCount; r++) {
        const branchName = String(branchNames[r][0] || "").trim();
        if (!branchName) continue;
        const auditRow = auditRowByBranchKey[normalizeBranchNameForMatch(branchName)];
        if (!auditRow) continue;
        matched.push({ idx: r, auditRow: auditRow });
      }

      if (matched.length) {
        points.forEach(function (pt) {
          const w = pt.width;
          const grid = [];
          for (let r = 0; r < rowCount; r++) {
            const line = [];
            for (let c = 0; c < w; c++) line.push("");
            grid.push(line);
          }
          matched.forEach(function (m) {
            for (let c = 0; c < w; c++) {
              const v = m.auditRow[pt.auditCol - 1 + c];
              grid[m.idx][c] = (v === undefined || v === null) ? "" : v;
            }
          });
          overallSheet.getRange(OVERALL_DATA_FIRST_DATA_ROW, pt.finalStartCol, rowCount, w).setValues(grid);
        });
      }
    }

    repaired.push(monthKey);
  });

  return repaired;
}

function isBlankCellValue(v) {
  return v === null || v === undefined || String(v).trim() === "";
}

function normalizeHeaderLabel(label) {
  return String(label || "").trim().toUpperCase().replace(/\s+/g, " ");
}

// ============ AUTO-MERGE NEW MONTH HEADER (Collection/Sales/Service) ============
// Cosmetic only: getHeaderBlocks() reads merged or repeated-text headers
// equally, so a failed merge here can never break month detection.
function mergeHeaderRange(sheet, row, startCol, endCol) {
  if (endCol <= startCol) return;
  const range = sheet.getRange(row, startCol, 1, endCol - startCol + 1);
  // Break apart any overlapping merge first, or Sheets can throw.
  range.getMergedRanges().forEach(function (m) { m.breakApart(); });
  range.merge();
}

function autoMergeMonthHeader(sheet, groupRow, pt) {
  try {
    if (pt.width > 1) {
      // Sales-style block: merge the month label over its own 3 columns.
      mergeHeaderRange(sheet, groupRow, pt.finalStartCol, pt.finalStartCol + pt.width - 1);
      return;
    }

    // Single-column block (Collection/Service): if the new label matches
    // the label to its left, extend (or start) the merge to cover it.
    const newLabel = String(sheet.getRange(groupRow, pt.finalStartCol).getValue() || "").trim();
    if (!newLabel) return;
    const prevLabel = String(sheet.getRange(groupRow, pt.finalStartCol - 1).getValue() || "").trim();
    if (newLabel !== prevLabel) return;

    let blockStartCol = pt.finalStartCol - 1;
    const existingMerges = sheet.getRange(groupRow, blockStartCol).getMergedRanges();
    if (existingMerges.length) {
      blockStartCol = existingMerges[0].getColumn();
    } else {
      while (blockStartCol > 1) {
        const label = String(sheet.getRange(groupRow, blockStartCol - 1).getValue() || "").trim();
        if (label !== newLabel) break;
        blockStartCol--;
      }
    }
    mergeHeaderRange(sheet, groupRow, blockStartCol, pt.finalStartCol);
  } catch (err) {
    Logger.log("autoMergeMonthHeader: could not merge header at col " + pt.finalStartCol + ": " + (err && err.message ? err.message : err));
  }
}

// Extends the COLLECTION / SALES / SERVICE section-title merge (row 1) to
// cover a newly-inserted month. Sheets doesn't auto-extend a merge when a
// column is inserted just past its edge (this is what SERVICE needed).
function extendSectionTitleMerge(sheet, sectionRow, pt) {
  try {
    const newEndCol = pt.finalStartCol + pt.width - 1;
    const leftCol = pt.finalStartCol - 1;
    if (leftCol < 1) return;

    let sectionStartCol;
    const leftMerges = sheet.getRange(sectionRow, leftCol).getMergedRanges();
    if (leftMerges.length) {
      sectionStartCol = leftMerges[0].getColumn();
    } else {
      const leftLabel = String(sheet.getRange(sectionRow, leftCol).getValue() || "").trim();
      if (!leftLabel) return;
      sectionStartCol = leftCol;
    }

    const sectionLabel = String(sheet.getRange(sectionRow, sectionStartCol).getValue() || "").trim();
    if (!sectionLabel) return;

    mergeHeaderRange(sheet, sectionRow, sectionStartCol, newEndCol);
  } catch (err) {
    Logger.log("extendSectionTitleMerge: could not extend section header at col " + pt.finalStartCol + ": " + (err && err.message ? err.message : err));
  }
}

// Self-heal for SALES: makes sure every EXISTING month block is merged
// across its 3 sub-columns BEFORE month positions are calculated. Update
// Sheet only writes the label into the first of the 3 columns, and an
// unmerged block would be misread as 1 column wide, so the next insert
// could land on top of that month's COD/CA cells. No-op if already merged.
function repairExistingSalesMonthMerges(overallSheet) {
  try {
    const salesRange = findSectionColumnRange(overallSheet, OVERALL_HDR_SECTION_ROW, "SALES");
    let col = salesRange.startCol;
    while (col + 2 <= salesRange.endCol) {
      const label = String(overallSheet.getRange(OVERALL_HDR_GROUP_ROW, col).getValue() || "").trim();
      if (canonicalMonthKey(label)) {
        mergeHeaderRange(overallSheet, OVERALL_HDR_GROUP_ROW, col, col + 2);
        col += 3;
      } else {
        col += 1;
      }
    }
  } catch (err) {
    Logger.log("repairExistingSalesMonthMerges failed: " + (err && err.message ? err.message : err));
  }
}
// ============ END AUTO-MERGE NEW MONTH HEADER ============

function buildOverallToAuditColumnMap(auditMonthInfo, overallInfoBefore) {
  const map = [];

  overallInfoBefore.collectionMetrics.forEach(function (oMetric) {
    const aMetric = auditMonthInfo.collectionMetrics.filter(function (m) { return normalizeHeaderLabel(m.label) === normalizeHeaderLabel(oMetric.label); })[0];
    if (!aMetric) return;
    oMetric.months.forEach(function (oMonth) {
      const aEntry = aMetric.months.filter(function (x) { return x.key === oMonth.key; })[0];
      if (!aEntry) return;
      map.push({ overallCol: oMonth.col, auditCol: aEntry.col });
    });
  });

  overallInfoBefore.salesBlocks.forEach(function (oBlock) {
    const monthKey = canonicalMonthKey(oBlock.label);
    const aBlock = auditMonthInfo.salesBlocks.filter(function (b) { return canonicalMonthKey(b.label) === monthKey; })[0];
    if (!aBlock) return;
    for (let off = 0; off < 3; off++) {
      map.push({ overallCol: oBlock.startCol + off, auditCol: aBlock.startCol + off });
    }
  });

  overallInfoBefore.serviceCols.forEach(function (oCol) {
    const aCol = auditMonthInfo.serviceCols.filter(function (c) { return c.key === oCol.key; })[0];
    if (!aCol) return;
    map.push({ overallCol: oCol.col, auditCol: aCol.col });
  });

  return map;
}

function reconcileBranchRows(auditSheet, overallSheet, auditMonthInfo, overallInfoBefore, branchRowState) {
  const rowsAdded = [];
  let cellsFilled = 0;

  const auditLastRow = auditSheet.getLastRow();
  const auditLastCol = auditSheet.getLastColumn();
  if (auditLastRow < AUDIT_DATA_FIRST_DATA_ROW) {
    return { rowsAdded: rowsAdded, cellsFilled: cellsFilled };
  }

  const hasAnyExistingMonth = overallInfoBefore.serviceCols.length > 0;
  const colMap = hasAnyExistingMonth ? buildOverallToAuditColumnMap(auditMonthInfo, overallInfoBefore) : [];

  const auditRows = auditSheet.getRange(
    AUDIT_DATA_FIRST_DATA_ROW, 1,
    auditLastRow - AUDIT_DATA_FIRST_DATA_ROW + 1, auditLastCol
  ).getValues();

  const overallLastRowBefore = overallSheet.getLastRow();
  const overallLastCol = Math.max(overallSheet.getLastColumn(), OVERALL_DATA_BRANCH_COL);
  const hasExistingOverallRows = overallLastRowBefore >= OVERALL_DATA_FIRST_DATA_ROW;
  const overallGrid = hasExistingOverallRows
    ? overallSheet.getRange(
        OVERALL_DATA_FIRST_DATA_ROW, 1,
        overallLastRowBefore - OVERALL_DATA_FIRST_DATA_ROW + 1, overallLastCol
      ).getValues()
    : [];
  const gridIndexForSheetRow = function (sheetRow) { return sheetRow - OVERALL_DATA_FIRST_DATA_ROW; };

  const newRows = [];
  let existingGridTouched = false;

  auditRows.forEach(function (auditRow) {
    const branchName = String(auditRow[1] || auditRow[0] || "").trim();
    if (!branchName) return;

    const key = normalizeBranchNameForMatch(branchName);
    let sheetRow = branchRowState.rowByBranchKey[key];
    let gridRow;
    let isNewRow = false;

    if (!sheetRow) {
      gridRow = new Array(overallLastCol).fill("");
      gridRow[OVERALL_DATA_NO_COL - 1] = branchRowState.nextNo;
      gridRow[OVERALL_DATA_BRANCH_COL - 1] = branchName;
      branchRowState.nextNo++;
      sheetRow = branchRowState.nextRowToAppend;
      branchRowState.nextRowToAppend++;
      branchRowState.rowByBranchKey[key] = sheetRow;
      rowsAdded.push(branchName);
      isNewRow = true;
    } else {
      const idx = gridIndexForSheetRow(sheetRow);
      gridRow = (idx >= 0 && idx < overallGrid.length) ? overallGrid[idx] : null;
      if (!gridRow) return;
    }

    if (hasAnyExistingMonth) {
      colMap.forEach(function (m) {
        const idx = m.overallCol - 1;
        const current = gridRow[idx];
        if (!isBlankCellValue(current)) return;
        const auditVal = auditRow[m.auditCol - 1];
        if (isBlankCellValue(auditVal)) return;
        gridRow[idx] = auditVal;
        cellsFilled++;
        if (!isNewRow) existingGridTouched = true;
      });
    }

    if (isNewRow) newRows.push(gridRow);
  });

  if (existingGridTouched && overallGrid.length) {
    overallSheet.getRange(OVERALL_DATA_FIRST_DATA_ROW, 1, overallGrid.length, overallLastCol).setValues(overallGrid);
  }

  if (newRows.length) {
    const appendStartRow = branchRowState.nextRowToAppend - newRows.length;
    overallSheet.getRange(appendStartRow, 1, newRows.length, overallLastCol).setValues(newRows);
  }

  return { rowsAdded: rowsAdded, cellsFilled: cellsFilled };
}

// #21 (timeout patch): the per-branch cell writes are now batched. Values for
// each new column block are built in memory and written with ONE setValues()
// call per block (4 collection + 1 sales + 1 service = 6 writes total,
// regardless of how many branches). The new columns were just inserted, so
// they are blank - writing "" for rows that have no audit data changes nothing.
function insertOneMonthIntoOverallData(auditSheet, overallSheet, monthKey, auditMonthInfo, branchRowState) {
  const overallInfo = getOverallMonthsInfo(overallSheet);

  const auditMetricByLabel = {};
  auditMonthInfo.collectionMetrics.forEach(function (m) { auditMetricByLabel[normalizeHeaderLabel(m.label)] = m; });

  const points = [];

  overallInfo.collectionMetrics.forEach(function (oMetric) {
    const aMetric = auditMetricByLabel[normalizeHeaderLabel(oMetric.label)];
    if (!aMetric) {
      throw new Error("OVERALL DATA has a Collection metric column ('" + oMetric.label +
        "') that AUDIT DATA (FINAL) doesn't. Fix the sheets before running Update Sheet.");
    }
    const auditEntry = aMetric.months.filter(function (x) { return x.key === monthKey; })[0];
    if (!auditEntry) {
      throw new Error("Could not find " + monthKey + " in AUDIT DATA (FINAL)'s '" + oMetric.label + "' Collection column.");
    }
    const lastMonth = oMetric.months.length ? oMetric.months[oMetric.months.length - 1] : null;
    const afterCol = lastMonth ? lastMonth.col : oMetric.endCol;
    points.push({ kind: "collection", afterCol: afterCol, width: 1, auditCol: auditEntry.col, label: oMetric.label });
  });

  const auditSalesBlock = auditMonthInfo.salesBlocks.filter(function (b) { return canonicalMonthKey(b.label) === monthKey; })[0];
  if (!auditSalesBlock) throw new Error("Could not find " + monthKey + " in AUDIT DATA (FINAL)'s SALES section.");
  const lastSalesMonth = overallInfo.salesBlocks.length ? overallInfo.salesBlocks[overallInfo.salesBlocks.length - 1] : null;
  const salesAfterCol = lastSalesMonth ? lastSalesMonth.endCol : (overallInfo.salesRange.startCol - 1);
  points.push({ kind: "sales", afterCol: salesAfterCol, width: 3, auditCol: auditSalesBlock.startCol });

  const auditServiceCol = auditMonthInfo.serviceCols.filter(function (c) { return c.key === monthKey; })[0];
  if (!auditServiceCol) throw new Error("Could not find " + monthKey + " in AUDIT DATA (FINAL)'s SERVICE section.");
  const lastServiceMonth = overallInfo.serviceCols.length ? overallInfo.serviceCols[overallInfo.serviceCols.length - 1] : null;
  const serviceAfterCol = lastServiceMonth ? lastServiceMonth.col : (overallInfo.serviceRange.startCol - 1);
  points.push({ kind: "service", afterCol: serviceAfterCol, width: 1, auditCol: auditServiceCol.col });

  const ascending = points.slice().sort(function (a, b) { return a.afterCol - b.afterCol; });
  let cumulative = 0;
  ascending.forEach(function (pt) {
    pt.finalStartCol = pt.afterCol + 1 + cumulative;
    cumulative += pt.width;
  });
  const descending = points.slice().sort(function (a, b) { return b.afterCol - a.afterCol; });

  // Insert + label as one guarded step; roll back on failure so the month
  // is never left present in some sections but not others.
  const insertedPoints = [];
  try {
    descending.forEach(function (pt) {
      overallSheet.insertColumnsAfter(pt.afterCol, pt.width);
      insertedPoints.push(pt);
    });

    points.forEach(function (pt) {
      const startCol = pt.finalStartCol;
      if (pt.kind === "collection") {
        overallSheet.getRange(OVERALL_HDR_GROUP_ROW, startCol).setValue(pt.label);
        const monthLabel = auditSheet.getRange(AUDIT_HDR_COL_ROW, pt.auditCol).getValue();
        overallSheet.getRange(OVERALL_HDR_COL_ROW, startCol).setValue(monthLabel);
      } else if (pt.kind === "sales") {
        const monthLabel = auditSheet.getRange(AUDIT_HDR_GROUP_ROW, pt.auditCol).getValue();
        overallSheet.getRange(OVERALL_HDR_GROUP_ROW, startCol).setValue(monthLabel);
        const subLabels = auditSheet.getRange(AUDIT_HDR_COL_ROW, pt.auditCol, 1, 3).getValues();
        overallSheet.getRange(OVERALL_HDR_COL_ROW, startCol, 1, 3).setValues(subLabels);
      } else if (pt.kind === "service") {
        const monthLabel = auditSheet.getRange(AUDIT_HDR_COL_ROW, pt.auditCol).getValue();
        overallSheet.getRange(OVERALL_HDR_COL_ROW, startCol).setValue(monthLabel);
      }
      autoMergeMonthHeader(overallSheet, OVERALL_HDR_GROUP_ROW, pt);
      extendSectionTitleMerge(overallSheet, OVERALL_HDR_SECTION_ROW, pt);
    });
  } catch (err) {
    insertedPoints.forEach(function (pt) {
      try { overallSheet.deleteColumns(pt.finalStartCol, pt.width); } catch (e2) {
        Logger.log("Rollback failed while inserting " + monthKey + " at col " + pt.finalStartCol + ": " + e2);
      }
    });
    throw new Error("Failed to insert " + monthKey + " into OVERALL DATA, rolled back the partial change: " + (err && err.message ? err.message : err));
  }

  const auditLastRow = auditSheet.getLastRow();
  const auditLastCol = auditSheet.getLastColumn();
  const auditRows = auditSheet.getRange(AUDIT_DATA_FIRST_DATA_ROW, 1, Math.max(auditLastRow - AUDIT_DATA_FIRST_DATA_ROW + 1, 0), auditLastCol).getValues();

  // Pass 1: work out which OVERALL row each audit branch goes to (adding a
  // row for a brand-new branch - rare, so those few writes stay single).
  const branchesAdded = [];
  const targets = []; // { row, auditRow }
  for (let i = 0; i < auditRows.length; i++) {
    const auditRow = auditRows[i];
    const branchName = String(auditRow[1] || auditRow[0] || "").trim();
    if (!branchName) continue;

    const key = normalizeBranchNameForMatch(branchName);
    let targetRow = branchRowState.rowByBranchKey[key];
    if (!targetRow) {
      targetRow = branchRowState.nextRowToAppend;
      branchRowState.nextRowToAppend++;
      overallSheet.getRange(targetRow, OVERALL_DATA_NO_COL).setValue(branchRowState.nextNo);
      overallSheet.getRange(targetRow, OVERALL_DATA_BRANCH_COL).setValue(branchName);
      branchRowState.nextNo++;
      branchRowState.rowByBranchKey[key] = targetRow;
      branchesAdded.push(branchName);
    }
    targets.push({ row: targetRow, auditRow: auditRow });
  }

  // Pass 2: one setValues() per new column block.
  let maxRow = OVERALL_DATA_FIRST_DATA_ROW;
  targets.forEach(function (t) { if (t.row > maxRow) maxRow = t.row; });
  const rowCount = maxRow - OVERALL_DATA_FIRST_DATA_ROW + 1;

  points.forEach(function (pt) {
    const w = pt.width;
    const grid = [];
    for (let r = 0; r < rowCount; r++) {
      const line = [];
      for (let c = 0; c < w; c++) line.push("");
      grid.push(line);
    }
    targets.forEach(function (t) {
      const line = grid[t.row - OVERALL_DATA_FIRST_DATA_ROW];
      for (let c = 0; c < w; c++) {
        const v = t.auditRow[pt.auditCol - 1 + c];
        line[c] = (v === undefined || v === null) ? "" : v;
      }
    });
    overallSheet.getRange(OVERALL_DATA_FIRST_DATA_ROW, pt.finalStartCol, rowCount, w).setValues(grid);
  });

  return { branchesUpdated: targets.length, branchesAdded: branchesAdded };
}

function updateOverallDataWithLatestMonth() {
  const ss = getSpreadsheet_();
  const auditSheet = ss.getSheetByName(AUDIT_DATA_SHEET_NAME);
  const overallSheet = ss.getSheetByName(OVERALL_DATA_SHEET_NAME);
  if (!auditSheet) throw new Error("Sheet not found: " + AUDIT_DATA_SHEET_NAME);
  if (!overallSheet) throw new Error("Sheet not found: " + OVERALL_DATA_SHEET_NAME);

  const auditMonthInfo = getAuditMonthsList(auditSheet);

  // Must run BEFORE reading month positions — see repairExistingSalesMonthMerges().
  repairExistingSalesMonthMerges(overallSheet);

  // Self-heal partially-updated months before anything else, then re-read a
  // clean overallInfoBefore.
  let overallInfoBefore = getOverallMonthsInfo(overallSheet);
  const repairedMonths = Object.keys(overallInfoBefore.partialMonths || {}).length
    ? repairPartialMonths(auditSheet, overallSheet, auditMonthInfo)
    : [];
  if (repairedMonths.length) {
    overallInfoBefore = getOverallMonthsInfo(overallSheet);
  }

  const alreadyPresent = auditMonthInfo.months.filter(function (m) { return !!overallInfoBefore.monthSet[m]; });
  const missing = auditMonthInfo.months.filter(function (m) { return !overallInfoBefore.monthSet[m]; });

  const overallLastRowBefore = overallSheet.getLastRow();
  const rowByBranchKey = {};
  if (overallLastRowBefore >= OVERALL_DATA_FIRST_DATA_ROW) {
    const branchValues = overallSheet.getRange(OVERALL_DATA_FIRST_DATA_ROW, OVERALL_DATA_BRANCH_COL, overallLastRowBefore - OVERALL_DATA_FIRST_DATA_ROW + 1, 1).getValues();
    branchValues.forEach(function (r, idx) {
      const name = String(r[0] || "").trim();
      if (name) rowByBranchKey[normalizeBranchNameForMatch(name)] = OVERALL_DATA_FIRST_DATA_ROW + idx;
    });
  }
  let nextNo = 1;
  if (overallLastRowBefore >= OVERALL_DATA_FIRST_DATA_ROW) {
    const noValues = overallSheet.getRange(OVERALL_DATA_FIRST_DATA_ROW, OVERALL_DATA_NO_COL, overallLastRowBefore - OVERALL_DATA_FIRST_DATA_ROW + 1, 1).getValues();
    noValues.forEach(function (r) {
      const n = Number(r[0]);
      if (!isNaN(n) && n >= nextNo) nextNo = n + 1;
    });
  }
  const branchRowState = {
    rowByBranchKey: rowByBranchKey,
    nextNo: nextNo,
    nextRowToAppend: Math.max(overallLastRowBefore + 1, OVERALL_DATA_FIRST_DATA_ROW)
  };

  const reconcile = reconcileBranchRows(auditSheet, overallSheet, auditMonthInfo, overallInfoBefore, branchRowState);

  const monthsInserted = [];
  const branchesAddedAll = {};
  reconcile.rowsAdded.forEach(function (b) { branchesAddedAll[b] = true; });
  let branchesUpdatedLast = 0;

  missing.forEach(function (monthKey) {
    const result = insertOneMonthIntoOverallData(auditSheet, overallSheet, monthKey, auditMonthInfo, branchRowState);
    monthsInserted.push(monthKey);
    branchesUpdatedLast = result.branchesUpdated;
    result.branchesAdded.forEach(function (b) { branchesAddedAll[b] = true; });
  });

  clearOverallDataCache();

  const rowRepairNote =
    (repairedMonths.length ? " Repaired " + repairedMonths.length + " partially-updated month(s) (" + repairedMonths.join(", ") + ")." : "") +
    (reconcile.rowsAdded.length ? " Re-added " + reconcile.rowsAdded.length + " missing branch row(s) (" + reconcile.rowsAdded.join(", ") + ")." : "") +
    (reconcile.cellsFilled ? " Filled " + reconcile.cellsFilled + " blank cell(s) from AUDIT DATA (FINAL)." : "");

  if (!missing.length) {
    const nothingToRepair = !repairedMonths.length && !reconcile.rowsAdded.length && !reconcile.cellsFilled;
    return {
      success: true,
      alreadyUpToDate: nothingToRepair,
      monthsAlreadyInSheet: alreadyPresent,
      monthsRepaired: repairedMonths,
      monthsInserted: [],
      branchesAdded: reconcile.rowsAdded,
      cellsBackfilled: reconcile.cellsFilled,
      message: nothingToRepair
        ? "Already in the sheet — no new months to add" + (alreadyPresent.length ? " (" + alreadyPresent.join(", ") + ")." : ".")
        : "No new months to add, but OVERALL DATA was repaired." + rowRepairNote
    };
  }

  return {
    success: true,
    alreadyUpToDate: false,
    monthsAlreadyInSheet: alreadyPresent,
    monthsRepaired: repairedMonths,
    monthsInserted: monthsInserted,
    branchesUpdated: branchesUpdatedLast,
    branchesAdded: Object.keys(branchesAddedAll),
    cellsBackfilled: reconcile.cellsFilled,
    message: "Inserted " + monthsInserted.join(", ") + " into OVERALL DATA." +
      (alreadyPresent.length ? " (" + alreadyPresent.join(", ") + " were already there.)" : "") +
      rowRepairNote
  };
}

function buildOverallDataStructured() {
  const ss = getSpreadsheet_();
  const overallSheet = ss.getSheetByName(OVERALL_DATA_SHEET_NAME);
  if (!overallSheet) {
    throw new Error("Sheet not found: " + OVERALL_DATA_SHEET_NAME);
  }

  const overallInfo = getOverallMonthsInfo(overallSheet);

  const months = overallInfo.serviceCols.map(function (c) { return c.key; });

  const collectionMetrics = overallInfo.collectionMetrics.map(function (m) { return m.label; });

  let salesSubLabels = [];
  if (overallInfo.salesBlocks.length) {
    const firstBlock = overallInfo.salesBlocks[0];
    const width = firstBlock.endCol - firstBlock.startCol + 1;
    salesSubLabels = overallSheet.getRange(OVERALL_HDR_COL_ROW, firstBlock.startCol, 1, width).getValues()[0]
      .map(function (v) { return String(v || "").trim(); });
  }

  const branches = [];

  // #24: overallContentFingerprint_() has just read this exact range (rows 1..last,
  // all columns) in the same execution: reuse it instead of reading it again.
  // Single use, and only if it is fresh (a few seconds old at most).
  let rows = null;
  const fpRead = _overallFpRead_;
  _overallFpRead_ = null;
  if (fpRead && (Date.now() - fpRead.at) < 15000) {
    rows = fpRead.values.slice(OVERALL_DATA_FIRST_DATA_ROW - 1);
  } else {
    const lastRow = overallSheet.getLastRow();
    if (lastRow >= OVERALL_DATA_FIRST_DATA_ROW) {
      const lastCol = overallSheet.getLastColumn();
      rows = overallSheet.getRange(
        OVERALL_DATA_FIRST_DATA_ROW, 1,
        lastRow - OVERALL_DATA_FIRST_DATA_ROW + 1, lastCol
      ).getValues();
    }
  }

  if (rows && rows.length) {
    rows.forEach(function (row) {
      const branchName = String(row[OVERALL_DATA_BRANCH_COL - 1] || "").trim();
      if (!branchName) return;

      const collection = {};
      overallInfo.collectionMetrics.forEach(function (metric) {
        metric.months.forEach(function (m) {
          if (!collection[m.key]) collection[m.key] = {};
          collection[m.key][metric.label] = row[m.col - 1];
        });
      });

      const sales = {};
      overallInfo.salesBlocks.forEach(function (block) {
        const key = canonicalMonthKey(block.label);
        if (!key) return;
        const width = block.endCol - block.startCol + 1;
        const vals = {};
        for (let i = 0; i < width; i++) {
          const subLabel = salesSubLabels[i] || ("COL" + (i + 1));
          vals[subLabel] = row[block.startCol - 1 + i];
        }
        sales[key] = vals;
      });

      const service = {};
      overallInfo.serviceCols.forEach(function (c) {
        service[c.key] = row[c.col - 1];
      });

      branches.push({ name: branchName, collection: collection, sales: sales, service: service });
    });
  }

  return {
    success: true,
    months: months,
    collectionMetrics: collectionMetrics,
    salesSubLabels: salesSubLabels,
    totalBranches: branches.length,
    branches: branches,
    generatedAt: new Date().toISOString()
  };
}

const OVERALL_DATA_CACHE_KEY = "overall_payload_v1";
const OVERALL_DATA_MODTIME_CACHE_KEY = OVERALL_DATA_CACHE_KEY + ":sheetModTime";
// Tiny copy of the cached payload's fingerprint (see overallUnchangedFast_()).
const OVERALL_DATA_FP_CACHE_KEY = OVERALL_DATA_CACHE_KEY + ":fp";

// #22: content fingerprint of ONLY the OVERALL DATA tab (one range read +
// a digest). The Drive modified time changes on EVERY edit anywhere in the
// spreadsheet (every remark / assignment save); this tells us whether
// OVERALL DATA itself changed. Returns "" if it cannot be computed (callers
// then simply rebuild, the old behaviour).
// #24: the range read for the fingerprint is kept (this execution only) so
// buildOverallDataStructured() does not have to read it a second time.
let _overallFpRead_ = null;

function overallContentFingerprint_() {
  // Short script-cache memoization avoids repeating the same expensive full-range
  // read when multiple requests ask for the fingerprint close together.
  // The fingerprint format and source data remain unchanged.
  const cache = CacheService.getScriptCache();
  _overallFpRead_ = null;
  try {
    // Bind the short-lived fingerprint cache to the sheet's current
    // modified timestamp. This prevents a recent edit from being hidden
    // by a fingerprint cached before that edit.
    const sheetModifiedTime = getSheetModifiedTimeFast();
    const cacheKey = "overall_content_fingerprint_v4_" + String(sheetModifiedTime);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const sheet = getSpreadsheet_().getSheetByName(OVERALL_DATA_SHEET_NAME);
    if (!sheet) return "";
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return "empty";
    const fpValues = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    _overallFpRead_ = { at: Date.now(), values: fpValues };
    const json = JSON.stringify(fpValues);
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, json);
    const fingerprint = json.length + "-" + Utilities.base64EncodeWebSafe(digest);
    cache.put(cacheKey, fingerprint, 30);
    return fingerprint;
  } catch (err) {
    Logger.log("overallContentFingerprint_ failed (rebuild will run instead): " + err);
    return "";
  }
}

// Compares the Spreadsheet's Drive last-modified time against the time
// recorded when this cache was filled, so a direct edit in Google Sheets
// (bypassing the app) invalidates the cache immediately instead of waiting
// out the 6-hour TTL.
// #16: uses the memoized modified-time lookup (one Drive call shared by all
// requests within a few seconds) and, when it cannot get the lock because
// another request is already rebuilding, serves the existing copy instead
// of starting a second heavy rebuild.
const OVERALL_SOFTLOCK_NAME = "overall_rebuild";
const OVERALL_REBUILD_GUARD_KEY = "overall_rebuild_guard_v1";
const OVERALL_REBUILD_MIN_GAP_SECONDS = 30; // at most one change-triggered Overall rebuild per 30 s

function storeOverallPayload(cache, result, sheetModifiedTime) {
  cacheSetChunked(cache, OVERALL_DATA_CACHE_KEY, result, OVERALL_DATA_CACHE_TTL_SECONDS);
  try {
    if (result && result.fp) cache.put(OVERALL_DATA_FP_CACHE_KEY, String(result.fp), OVERALL_DATA_CACHE_TTL_SECONDS);
    else cache.remove(OVERALL_DATA_FP_CACHE_KEY);
    cache.put(OVERALL_DATA_MODTIME_CACHE_KEY, String(sheetModifiedTime), OVERALL_DATA_CACHE_TTL_SECONDS);
    cache.put(OVERALL_BUILTAT_KEY, String(Date.now()), OVERALL_DATA_CACHE_TTL_SECONDS);
    cache.put(OVERALL_REBUILD_GUARD_KEY, "1", OVERALL_REBUILD_MIN_GAP_SECONDS);
  } catch (err) { /* non-fatal */ }
}

// #18: soft lock instead of the script-wide lock, and a rebuild guard: an edit
// anywhere in the spreadsheet (every in-app save is one) changes the modified
// time, but only OVERALL DATA feeds this payload, so a rebuild is allowed at
// most once per OVERALL_REBUILD_MIN_GAP_SECONDS and otherwise the existing copy
// is served. "Update Sheet" clears the guard, so its result shows immediately.
// True only when the cached Overall payload is current (same conditions as the
// first cache hit in getOverallDataStructuredCached()) AND the browser already
// shows exactly that copy (sinceFp matches the stored fingerprint). Answers
// from three tiny cache keys instead of downloading and parsing the payload.
// Returns the fingerprint, or "" to fall through to the normal path.
// #24: used by the 5-minute warmer. True when the cached Overall payload is
// current for the Sheet's modified time and its first/last chunk are present,
// judged from a few tiny keys -- without downloading + parsing the payload.
// False on any doubt (the caller then runs the normal getOverallDataStructuredCached()).
function overallCacheLooksWarm_() {
  try {
    const cache = CacheService.getScriptCache();
    const live = getSheetModifiedTimeFast();
    const got = cache.getAll([OVERALL_DATA_MODTIME_CACHE_KEY, OVERALL_DATA_CACHE_KEY + ":meta"]);
    const modTime = got[OVERALL_DATA_MODTIME_CACHE_KEY];
    const metaStr = got[OVERALL_DATA_CACHE_KEY + ":meta"];
    if (!modTime || Number(modTime) !== live || !metaStr) return false;
    const n = parseInt(metaStr, 10);
    if (!n || n < 1) return false;
    const ends = [OVERALL_DATA_CACHE_KEY + ":0"];
    if (n > 1) ends.push(OVERALL_DATA_CACHE_KEY + ":" + (n - 1));
    const chunks = cache.getAll(ends);
    return ends.every(function (k) { return chunks[k] !== undefined && chunks[k] !== null; });
  } catch (err) {
    return false;
  }
}

function overallUnchangedFast_(sinceFp) {
  if (!sinceFp) return "";
  try {
    const cache = CacheService.getScriptCache();
    const sheetModifiedTime = getSheetModifiedTimeFast();
    const got = cache.getAll([OVERALL_DATA_MODTIME_CACHE_KEY, OVERALL_DATA_FP_CACHE_KEY, OVERALL_DATA_CACHE_KEY + ":meta"]);
    const modTime = got[OVERALL_DATA_MODTIME_CACHE_KEY];
    const fp = got[OVERALL_DATA_FP_CACHE_KEY];
    if (modTime && Number(modTime) === sheetModifiedTime && fp && fp === sinceFp && got[OVERALL_DATA_CACHE_KEY + ":meta"]) {
      Logger.log("Overall Data unchanged for this browser (answered from tiny cache keys)");
      return fp;
    }
  } catch (err) { /* fall through to the normal path */ }
  return "";
}

function getOverallDataStructuredCached() {
  const cache = CacheService.getScriptCache();
  const sheetModifiedTime = getSheetModifiedTimeFast();

  const cachedModTime = cache.get(OVERALL_DATA_MODTIME_CACHE_KEY);
  if (cachedModTime && Number(cachedModTime) === sheetModifiedTime) {
    const cached = cacheGetChunked(cache, OVERALL_DATA_CACHE_KEY);
    if (cached !== null) {
      Logger.log("Serving Overall Data from: CACHE (sheet unchanged since last cache fill)");
      return cached;
    }
  }

  const haveCopy = !!cache.get(OVERALL_DATA_CACHE_KEY + ":meta");
  if (haveCopy && cache.get(OVERALL_REBUILD_GUARD_KEY)) {
    const recent = cacheGetChunked(cache, OVERALL_DATA_CACHE_KEY);
    if (recent !== null) {
      Logger.log("Serving Overall Data from: CACHE (rebuilt very recently)");
      return recent;
    }
  }

  // #22: the spreadsheet changed, but did OVERALL DATA? One range read answers
  // that; if not, keep the cached copy and just remember the new modified time.
  let fpNow = "";
  if (haveCopy) {
    fpNow = overallContentFingerprint_();
    if (fpNow) {
      const sameCopy = cacheGetChunked(cache, OVERALL_DATA_CACHE_KEY);
      if (sameCopy !== null && sameCopy.fp && sameCopy.fp === fpNow) {
        try { cache.put(OVERALL_DATA_MODTIME_CACHE_KEY, String(sheetModifiedTime), OVERALL_DATA_CACHE_TTL_SECONDS); } catch (err) { /* non-fatal */ }
        Logger.log("Serving Overall Data from: CACHE (spreadsheet changed elsewhere; OVERALL DATA is identical)");
        return sameCopy;
      }
    }
  }

  const lock = trySoftLock(OVERALL_SOFTLOCK_NAME, 90, haveCopy ? DASH_STALE_WAIT_MS : CACHE_LOCK_WAIT_MS);
  try {
    const cachedModTimeAfterWait = cache.get(OVERALL_DATA_MODTIME_CACHE_KEY);
    if (cachedModTimeAfterWait && Number(cachedModTimeAfterWait) === sheetModifiedTime) {
      const cachedAfterWait = cacheGetChunked(cache, OVERALL_DATA_CACHE_KEY);
      if (cachedAfterWait !== null) {
        Logger.log("Serving Overall Data from: CACHE (after waiting briefly for another request to fill it)");
        return cachedAfterWait;
      }
    }

    if (!lock) {
      const anyCopy = cacheGetChunked(cache, OVERALL_DATA_CACHE_KEY);
      if (anyCopy !== null) {
        Logger.log("Serving Overall Data from: CACHE (stale copy — another request is rebuilding)");
        return anyCopy;
      }
    }

    // Fingerprint BEFORE building, so an edit that lands mid-build is seen as
    // "changed" next time instead of being masked.
    const fpBefore = fpNow || overallContentFingerprint_();
    const result = buildOverallDataStructured();
    if (fpBefore) result.fp = fpBefore;
    storeOverallPayload(cache, result, sheetModifiedTime);
    return result;
  } finally {
    softUnlock(lock);
  }
}

// Used by the warmer: refill Overall Data from the live Sheet.
function refreshOverallCacheNow() {
  const cache = CacheService.getScriptCache();
  const lock = trySoftLock(OVERALL_SOFTLOCK_NAME, 90, 0);
  if (!lock) return;
  try {
    const sheetModifiedTime = getSheetModifiedTimeFast();
    const fpBefore = overallContentFingerprint_();
    const result = buildOverallDataStructured();
    if (fpBefore) result.fp = fpBefore;
    storeOverallPayload(cache, result, sheetModifiedTime);
  } finally {
    softUnlock(lock);
  }
}

function clearOverallDataCache() {
  try {
    CacheService.getScriptCache().removeAll([
      OVERALL_DATA_CACHE_KEY + ":meta",
      OVERALL_DATA_MODTIME_CACHE_KEY,
      OVERALL_DATA_FP_CACHE_KEY,
      OVERALL_REBUILD_GUARD_KEY
    ]);
  } catch (err) {
    Logger.log("Could not clear Overall Data cache: " + err);
  }
}
// ================= END OVERALL DATA — STRUCTURED READ =================

// ==========================================================================
// diagnoseSpeed() — run ONCE from the Apps Script editor (Run > diagnoseSpeed,
// then View > Logs). It times every step of a dashboard rebuild and prints the
// size of each sheet, so a slow/timeout problem can be pinned to one cause
// (a huge sheet, a slow Firestore, a slow Drive lookup...) instead of guessed.
// It only READS; it changes nothing.
// ==========================================================================
function diagnoseSpeed() {
  const lines = [];
  function lap(label, t0, extra) {
    lines.push(("        " + (Date.now() - t0) + " ms").slice(-10) + "  " + label + (extra ? "  " + extra : ""));
  }
  let t = Date.now();
  const live = DriveApp.getFileById(SPREADSHEET_ID).getLastUpdated().getTime();
  lap("Drive: spreadsheet modified time", t);

  t = Date.now();
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  lap("SpreadsheetApp.openById", t);

  let totalChars = 0;
  SHEET_NAMES.forEach(function (name) {
    t = Date.now();
    const sh = ss.getSheetByName(name);
    if (!sh) { lines.push("   (missing)  " + name); return; }
    const vals = sh.getDataRange().getValues();
    const chars = JSON.stringify(vals).length;
    totalChars += chars;
    lap("read " + name, t, vals.length + " rows x " + (vals[0] ? vals[0].length : 0) + " cols, " + Math.round(chars / 1024) + " KB JSON");
  });
  lines.push("            Total dashboard payload: " + Math.round(totalChars / 1024) + " KB  (cache chunks: " + Math.ceil(totalChars / CACHE_CHUNK_CHARS) + ")");

  t = Date.now();
  try {
    const fs = getFirestoreClient();
    lap("Firestore: client / OAuth", t);
    t = Date.now();
    const meta = firestoreDocsToMap_(fs.getDocuments(FIRESTORE_COLLECTION, [SYNC_META_DOC_ID]))[SYNC_META_DOC_ID];
    const synced = meta ? (Number(meta.lastSyncedSheetModifiedTime) || 0) : 0;
    lap("Firestore: read sync marker", t, synced >= live ? "IN SYNC" : "BEHIND the Sheet by " + Math.round((live - synced) / 1000) + " s");
  } catch (err) {
    lap("Firestore FAILED", t, String(err));
  }

  t = Date.now();
  const fp = overallContentFingerprint_();
  lap("OVERALL DATA fingerprint", t, fp ? "ok" : "unavailable");

  _overallFpRead_ = null; // time a REAL build, not one that reuses the fingerprint read
  t = Date.now();
  try { buildOverallDataStructured(); lap("OVERALL DATA full build", t); } catch (err) { lap("OVERALL DATA build FAILED", t, String(err)); }

  const cache = CacheService.getScriptCache();
  t = Date.now();
  const cachedStr = cacheGetChunkedString(cache, DASH_CACHE_KEY);
  lap("Cache: read dashboard payload", t, cachedStr ? Math.round(cachedStr.length / 1024) + " KB cached" : "NOT CACHED (next user request will rebuild)");

  Logger.log("\n==== diagnoseSpeed ====\n" + lines.join("\n"));
}