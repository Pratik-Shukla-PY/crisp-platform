/**
 * CRISP Web Dashboard - Service Worker
 * ─────────────────────────────────────
 * Strategy:
 *   App files (HTML/JS/CSS) → Network-First (always get latest, cache as fallback)
 *   CDN assets              → Cache-First   (fonts, icons - rarely change)
 *   Static data (world.json)→ Cache-First   (large, never changes)
 *   API /api/v1/reports     → Stale-While-Revalidate (instant + background refresh)
 *   Everything else         → Network with cache fallback
 */

// v9/v8/v8/v11 → v10/v9/v9/v12 - Apr 2026 round-2 CSP fix.
// Bumping to evict any client that has stale HTML/CDN entries cached
// from the brief window where connect-src was missing tile hosts +
// the browser was heuristic-pinning the old CSP. Old SWs auto-replace
// because skipWaiting() runs in install + nginx now sends Cache-Control:
// no-cache on sw.js so the new code lands within seconds of deploy.
const APP_CACHE    = 'crisp-app-v60';  // v60 (Jun 2026): pre-rollout Phase 1-5 remediation. Counts: ONE canonical contract (Critical = open CRITICAL everywhere; needs_review = open & not-yet-accepted, closing the REJECTED-leak; pending-verification open-only) across the server summary + operations rollup + client KPI strip/pill/home card; op-card Critical no longer inflated by closed reports. Operations: op switcher refetches fresh (ENDED ops drop out, new ones appear); a deleted/unknown op shows a "not found" state (not a phantom GREEN dashboard) + ENDED ops show READ-ONLY; the shell scope chip syncs on the op-scoped feed; chip filters clear on scope change; a LIVE op must have a form pack (server-enforced). Routing/session: the fetch wrapper reads the CURRENT token each call (no more force-logout after rotation); queue-sync folded into the ordered dispatch; /reports/markers carry crisis_event_id so map/recent clicks open in the right op; opening an incident on the op-scoped feed stays in place; incident search survives a refresh (sessionStorage). Scale: KPI strip + map + banner total reflect ALL reports at 500k scale (summary + /markers); crisis-top10 N+1 removed; deletions badge counts via X-Total-Count. Security: POST /reports/{id}/verify now requires analyst; undo-delete requires device-owner-or-admin. SW offline-fallback bug fixed; geo-cache capped. Returning operators must evict the precached index.html + stale app.js/cc-*.js/router.js/crisp-nav.js. // v59 (Jun 2026): Phase-0 critical-blocker hardening. C1 (scale): the feed-truncation banner now fires on ANY shortfall (was only past the unreachable 10K ceiling) and shows the real "newest N of TOTAL"; at scale the KPI strip + context-banner total come from the scope-aware /analytics/summary + X-Total-Count, and the main map plots the full lean /reports/markers set (was the truncated 500 slice) so counts + the Common Operating Picture stay honest at 500k scale; opening an out-of-window incident lazily fetches it via the new GET /reports/{id}. C2 (scope): every export path (Tools->Export submenu, Export Center, sitrep + analytics-summary briefings) now threads the active operation scope (crisis_event_id) so an op-scoped feed no longer silently exports the GLOBAL dataset. (C3 undo-delete ownership auth is backend-only.) Returning operators must evict the precached index.html + stale app.js/cc-exports.js/crisp-nav.js. // v58 (Jun 2026): Incidents - operation scoping + filter discoverability. (1) The GLOBAL feed is now operation-scopable via #/incidents;op={id}: the context banner gains an always-on "Operation" switcher (dropdown of Global + live operations) so the analyst can jump to any operation's incidents or back to global; the router preserves op= on /incidents + applies the scope after hideAll. (2) Context PERSISTS from an operation dashboard: "Open full incident feed" + each vital now carry op= so the banner names the operation + region. (3) The secondary filter chips now WRAP (all visible) instead of horizontal-scrolling off-screen. Returning operators must evict the precached index.html + stale app.js/router.js/cc-operations.js/styles.css. // v57 (Jun 2026): overlay/modal fixes. (1) FIX the v56 regression: the docked + fullscreen detail panel (reparented to body) now positions its top BELOW the fixed shell so its header + ✕ close are reachable (was top:16px, hidden behind the 52px shell). (2) fullscreen detail z 60→100000 (was BEHIND the route overlays). (3) the gallery reclaim-modal raised above the detail (opened from it, was hidden behind). (4) GLOBAL Escape closes the topmost open dropdown / in-page panel / transient modal. (5) the analytics panel gains a ✕ close; the in-page panels (analytics/predictions/deletions/moderation) are now mutually exclusive + close an open detail that would float over them. Returning operators must evict the precached index.html + stale app.js/crisp-shell.js/predictions.js/styles.css. // v56 (Jun 2026): Incidents layout - removed the intermediate command-bar. Its action group (time filter · Export · Tools) is re-parented into the global shell header (shown only on /incidents); the LIVE/clock/bell/profile chrome was already there. The secondary filter-chip row moved into the feed panel (under the KPI strip - finally clickable; it used to sit hidden behind the command-bar). With the top band freed, the feed/detail/analytics/deletions panels expand to top:16px (were 88px). Returning operators must evict the precached index.html + stale app.js/crisp-shell.js/styles.css. // v55 (Jun 2026): Incidents page → crisis command center. (1) NEW Incident Context Banner at the top of the feed panel, ALWAYS visible, stating scope (GLOBAL / queue / SEARCH / OPERATION) + count + a clear/exit - the analyst always knows WHERE/WHAT/WHY. (2) The status-KPI strip (Critical/Pending/Helped/Total) moved OFF the top command bar INTO the feed panel (Closed + Avg-Wait dropped; the triple-counted critical de-duped); still click-to-filter. (3) Feed cards simplified for rapid triage - severity/crisis/damage/location/time/source/action + ONE consolidated evidence+verification chip + a single blocking ⚠; the per-tier data-receipt icons, the multi-state PII/upload chips, the orig-pending + crisis-form chips moved to the detail panel (new dp-status-chips row). (4) Reverse map↔feed sync: selecting a feed incident now highlights + pulses its map marker (was camera-only). (5) Detail panel gains a breadcrumb (Global › Incident, or Global › Operations › {op} › Incident). (6) Operation dashboard worklist header reads "Operation incidents" + region. Returning operators must evict the precached index.html + stale app.js/cc-operations.js/styles.css. // v54 (Jun 2026): Operations UX refinements. (1) The standalone "Operations" nav button is REMOVED from the shell - the route is reached from the Home "Active Operations" rail/cards + a new Expand control + deep-links (route/role-gate/breadcrumb intact). (2) The home section "Active Response" is renamed "Active Operations". (3) The home rail header gains an Expand (⤢ View all) control → #/operations. (4) Clicking the "N critical, no operation" cluster no longer FORCES creation (was a window.prompt auto-claim): it opens a deliberate two-option chooser - "View ungrouped reports" (new #/incidents;queue=ungrouped filter, NO operation created) or "Create new operation" (the 4-step wizard, fromCluster). Operation creation is now a choice, not the default. Returning operators must evict the precached index.html + stale app.js/cc-home.js/cc-operations.js/crisp-shell.js. // v53 (Jun 2026): copy + housekeeping only, zero runtime-logic change - (1) the analytics-panel label "Claude-Haiku synthesis" is now "AI synthesis"; (2) dashboard i18n (6 UN locales) + JS comments had em dashes normalized to hyphens; (3) marketing branding in README + the pitch deck genericized off the AI vendor name. Returning operators must evict the precached index.html + stale app.js. // v52 (Jun 2026): Global-vs-Operations redesign P4 - operation Local Conditions. The operation dashboard gains a backend-proxied weather + hazard-alerts panel: GET /operations/{id}/weather fans out (async httpx, graceful no-op) to Open-Meteo /v1/forecast (current + 3-day; CC BY 4.0 attribution shown; free tier is non-commercial - CRISP/UN qualifies) and GDACS geteventlist (UN OCHA · EC JRC multi-hazard alerts, haversine-filtered to the op circle + 500km buffer). Cached server-side 45 min (in-process TTL); returns 200 {available:false} (never 5xx) when providers are down so the dashboard never hard-fails. STRICT PII boundary - the ONLY data sent upstream is the operation's centre coords (rounded) + radius, NEVER any report/reporter/device data (unit-tested). cc-operations renders the panel (current temp/humidity/precip/wind + 3-day forecast + nearby hazard alerts with alert-level colour). Returning operators must evict the precached index.html. // v51 (Jun 2026): Global-vs-Operations redesign P3 - scalability. The homepage global map used GET /reports/?limit=200 (heavy rows, server-capped at 500), so at 100k/500k reports it plotted a non-representative newest-200 slice. New GET /reports/markers returns up to 20k LIGHTWEIGHT points (id + coords + severity/status/type via a column tuple query joined to Location - NO media/AI/verification eager loads, optional bbox + operation scope), and cc-home loadFeed now decouples the two surfaces: the MAP pulls 5k lean markers (geo caption samples them) while Recent Activity pulls only the newest ~20 RICH rows. Backend also indexed buildings.escalation_risk (migration 0052) - the "escalating hotspots" filter (escalation_risk >= 70) runs on every /analytics/summary + every /operations rollup and was a full Building scan. (Deferred: batching the ~30 serial summary queries - behind a 30s cache, higher-risk refactor.) Returning operators must evict the precached index.html. // v50 (Jun 2026): Global-vs-Operations redesign - regression fixes. (1) Operation→Export now SCOPES to the operation: the export button stashes the op id at click time (the router's hideAll clears the live op scope before /exports opens), cc-exports threads it as crisis_event_id on every data request + shows a "this operation only" indicator, and the backend export endpoints (csv/geojson/shapefile/pdf/kml/count) gained a crisis_event_id filter - previously an export from inside an operation silently downloaded EVERY report. (2) Added e2e coverage for the operation-scope-leak (op filter must not bleed into the global feed after leaving - confirmed it already un-leaks via overlay teardown) + canRoute('/operations'|'/exports') permission coverage. Returning operators must evict the precached index.html. // v49 (Jun 2026): Global-vs-Operations redesign P2 - unified operation card. ONE shared CrispOpCard (cc-operations.js, window.CrispOpCard) now backs BOTH the home Active-Operations rail and the #/operations list, retiring the two drifted implementations (health green #34D399 vs #4ade80; "Crit/New" vs "Critical/New 24h"). The card adds: a crisis-type icon, a LIVE/DRAFT/PAUSED/ENDED status badge, the active form name, a "City, Country" place line + operation dates, the full stat cluster (Critical/New/Total/Verified/Responders), and an inline-SVG mini-map (centre dot + radius ring sized by radius_km - never a Leaflet instance per card, so 10/50/100 ops stay cheap). Backed by an extended /operations payload (OperationSummaryResponse + list_operations now also return radius_km, place_name, started_at, ended_at, form_pack_id, form_name, verified - all inside the existing single no-N+1 grouped query) and migration 0051 (denormalised CrisisEvent.place_name, resolved best-effort via the reverse-geocode cascade at create/launch/center-edit). PAUSED is a real status (String column already accepts it; the activation gate forces is_active=False so a paused op stops matching new reports). Returning operators must evict the precached index.html. // v48 (Jun 2026): Global-vs-Operations redesign P0+P1 - kill the cognitive-load conflation. cc-home is now a TWO-ZONE Command Center: "⚡ Active Response" (the operations rail, full-width primary) over "🌐 Global Monitoring" (the global map dropped full-width below + attention + analytics), replacing the side-by-side ops|map row that conflated the two. The map-header badge is REMOVED (it echoed the rail's active-ops count - the triple-count), and the Global Attention terminal row is relabeled "In response" (a REPORT count) instead of "Active operations" (a CrisisEvent count that lives solely on the rail). The shell gains a symmetric GLOBAL/OP scope chip in #cgn-right (op mode already had banner + body class + accent; global mode had NO affirmative cue). Dead code removed: renderKpis/kpiSkeleton/loadOrg/deltaChip + cc-home's own setConn/startClock (the shell owns identity/clock) + orphaned .cc-kpis/.cc-map-badge/.cc-clock CSS. Returning operators must evict the precached index.html. // v47 (Jun 2026): Operations Phase 3 - backend-authoritative operation health (RED/AMBER/GREEN dot + "why" hover, replacing the client stand-in) on the home rail + operations views; the "Launch operation here" cluster CTA now performs the real auto-claim (create operation + bulk-claim the critical cluster) with an "Undo claim" action on the operation dashboard; operation responder count surfaced in the operation banner. Returning operators must evict the precached index.html. // v46 (Jun 2026): Operations Phase 2 (2c/2e) - operations-first home (cc-home: removed the 8-tile Executive KPI strip → Active Operations rail ‖ global map; critical + in-response counts fold into a map-header badge; 5-card attention demoted to a full-width "Global Attention" block) + operation context system in the shell (colored chrome + persistent "Exit to global" breadcrumb banner on /operations/{id}, driven by a setOpContext hook). Returning operators must evict the precached index.html. // v45 (Jun 2026): Operations Phase 2 - new cc-operations.js (#/operations list + #/operations/{id} worklist dashboard), router gains positional /operations/{id}, shell nav relabel (Operations primary, Incidents = global feed), app.js operation-scope (window.setOperationScope threads crisis_event_id into the feed). Returning operators must evict the precached index.html to pick up the new <script>. // v44 (Jun 2026): map re-init on Home re-visit - openLanding rebuilds #cc-map each visit, so tear down a stale (detached-container) Leaflet map and re-attach (fixes "Operations → Home → blank map"). Returning operators must evict the precached index.html. // v43 (Jun 2026): Home fixes - org-branding cache made authoritative (no-store), map first-load hardened (whenReady + ResizeObserver), geo caption overlaid (height-match), KPI tiles + recent-activity rows now deep-link. Returning operators must evict the precached index.html. // v42 (Jun 2026): action-based "Immediate attention" - 7 status cards → 5 action cards (Critical incidents · Needs review · Escalating hotspots · Needs response · Active operations); entity-correct counts (incidents/hotspots) + new mutually-exclusive queue predicates. Returning operators must evict the precached index.html. // v41 (Jun 2026): removed the redundant "Home" nav button from the shell - the CRISP brand mark is the Home affordance. Returning operators must evict the precached index.html. // v40 (Jun 2026): header polish - org identity + clock moved into the global shell; removed the floating cc-home situational banner that overlapped the KPI cards. Returning operators must evict the precached index.html. // v39 (Jun 2026): notification unification - bell re-parented into the global shell + #notif-panel queue-shortcut footer added to index.html. Returning operators must evict the precached index.html. // v38 (Jun 2026): unified Command Center shell - new crisp-shell.js global nav bar wired into index.html (+ cc-home nav removed). Returning operators must evict the precached index.html to pick up the new <script>. // v37 (Jun 2026): remove the auto-submit-regions admin UI (regions CRUD + #regions-panel/#region-form-overlay DOM + .region-* CSS + the Reporting-module "Auto-submit regions" tab + the cosmetic is_auto_submitted badge). Returning operators must evict stale app.js + styles.css. // v36 (Jun 2026): login page redesign - bigger logo + full-height layout + home-style footer (Privacy · Help · version) + back-arrow → citizen PWA. // v35 (May 2026): 425-aware variant picker - the dashboard no longer renders a blur-pending tier's /file (returns 425 Too Early → blank image). thumbVariant/bestVariant/highestCompleteVariant + tier-switcher now require pii_blur_status!=='pending'; falls back to the ungated thumbnail/blurhash during blur and auto-upgrades to the full image when blur completes. Returning operators must evict stale app.js. // v34 (May 2026): Upload-recovery R1 - chip predicate flips to `abandon_reason && !recovered_at`, so successfully-resumed uploads (R1 backend revival path) stop rendering as "Upload abandoned" after recovery. // v33 (May 2026): Forensic Blur Audit B-H - 4-state PII chip in createIncidentCard ('Checking PII…' amber, 'Auto-redacted' green, 'Redaction failed' red); NEW .k5a-chip-green class in styles.css. Backend's canonical pii_blur_status drives chip text 1:1.  // v32 (May 2026): empty stub for v31's superseded definition; the long comment chain below applies as before. // v31 (May 2026): Phase L Batch 2 third hotfix. The "Original landed" check at _classifyHighTier + 3 sister sites used `m.resolution_tier === 'HIGH'` post-rename. Result: dashboard rendered "ORIG missing" chip even when ORIGINAL Media row existed + assembled cleanly. All 4 sites updated to compare against 'ORIGINAL'. Tier-label switch in detail panel ('LOW'/'MEDIUM'/'HIGH' → 'SMALL'/'MEDIUM'/'LARGE') also extended to accept canonical values. validate-phase-l-tier-vocab.mjs regex extended to catch `.resolution_tier === 'HIGH'` patterns.  // v30 (May 2026): Phase L Batch 2 - tier-rename cleanup. TIER_RANK now includes SMALL; 4 'HIGH' default fallbacks switched to ORIGINAL. Validator script `validate-phase-l-tier-vocab.mjs` added so no future tier-vocab regression sneaks in. // v29 (May 2026): Phase K Batch 6 - operator-visible visibility chips + filter correctness. K.5.a adds the .k5a-chip row in createIncidentCard for the new abandon_reason (checksum_mismatch / chunks_never_arrived / bandwidth_tier_deferred / assembly_worker_lost), pii_blur_status='failed', submitted_as_anonymous_due_to_expired_token, and sync_status=PARTIAL+pending signals. K.5.b changes every time-filter site (renderTriageQueue + renderTreeFeed + _getFilteredReports + analytics) to use _priorityTime() instead of server_created_at so offline-drained reports are filtered by capture time. K.5.c caps _seenIds at 1000 with FIFO eviction + load-time trim - prevents localStorage quota exhaustion on weeks-long sessions. K.5.d raises _MAX_NOTIFS 10 → 50 so burst-mode arrivals don't shed older entries off the bell LIFO. K.5.e adds an operator-visible truncation banner when X-Total-Count exceeds DASHBOARD_PAGE_LIMIT - pre-fix only logged to console. Returning operators must evict the stale app.js + styles.css to pick up the chips + banner. Test-only helper __crispSetTimeFilterHoursForTest added.
                                       // v28 (May 2026): notification regression follow-up to v27.
                                       // v27 (May 2026): notification-stack lifecycle rewrite - dedup-first ordering, incremental DOM (no innerHTML thrash), CSS-driven position transitions, centralised _refreshStackTimers state machine, .is-entering / .is-leaving entrance/exit classes (replaces baseline flash-in animation that re-fired on every render). Fixes "cards float/reposition randomly" + "notifications repeat for same report on media upgrade" + "full-refresh cascade of duplicate notifications". Introduced `_suppressNewReportNotifications` (later REMOVED in v28 - see above).
                                       // v26 (May 2026): Phase F image-reliability - assembly recovery sweep, abandoned-upload terminal state, tri-state LARGE-tier chip, Reclaim modal, offline banner.
const CDN_CACHE    = 'crisp-cdn-v9';
const API_CACHE    = 'crisp-api-v9';
const STATIC_CACHE = 'crisp-static-v12';

// App files that should always be fresh (network-first)
const APP_FILES = ['index.html', 'login.html', 'app.js', 'styles.css', 'manifest.json'];

// ── Install: skip waiting immediately (don't wait for old tabs to close) ─────
self.addEventListener('install', event => {
  self.skipWaiting();
});

// ── Activate: claim all clients + wipe old caches ────────────────────────────
self.addEventListener('activate', event => {
  const valid = [APP_CACHE, CDN_CACHE, API_CACHE, STATIC_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !valid.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: route by request type ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // ── API data: network-only (always fresh, never serve stale) ────────────
  if (url.port === '8000' || url.pathname.startsWith('/api/')) {
    return; // Let browser handle it directly - no SW interception
  }

  // ── Page navigations: bypass SW entirely when online; cache fallback
  //    for offline only. Apr 2026 fix - the old networkFirst-for-HTML
  //    path had a race-condition class of bug where a stale cached
  //    index.html / login.html got served on regular refresh, leaving
  //    the page in a broken state. Hard-refresh (Cmd+Shift+R) bypassed
  //    the SW and worked, which is the smoking-gun symptom for this
  //    bug. Standard SPA SW pattern: cache assets, but let the browser
  //    handle navigations natively.
  if (request.mode === 'navigate') {
    // Apr 2026 - force-revalidate against the server (cache: 'no-cache').
    // Without this, a navigation request can serve from the BROWSER HTTP
    // cache when the cached entry is heuristically fresh - even though
    // we want every navigation to pull the latest HTML so a deployed
    // CSP / app.js update reaches users immediately. The fetch() respects
    // the original request's mode/credentials by default, but we override
    // the cache strategy to revalidate. Combined with nginx's
    // Cache-Control: no-cache for HTML, this gives 304 Not Modified for
    // unchanged content (fast) and 200 + new HTML/headers for changes.
    event.respondWith(
      fetch(request, { cache: 'no-cache' }).catch(async () => {
        // STALE-10 (Phase-5): AWAIT the cache lookup. caches.match() returns a
        // Promise (always truthy), so the old `match() || new Response(...)` never
        // reached the offline fallback - an offline navigation with no cached copy
        // resolved to `undefined` (a browser error) instead of the CRISP offline page.
        return (await caches.match(request)) || new Response(
          '<h1>CRISP - Offline</h1><p>You appear to be offline. Reconnect and reload.</p>',
          { headers: { 'Content-Type': 'text/html' }, status: 503 },
        );
      }),
    );
    return;
  }

  // ── CDN assets: cache-first (fonts, icons - stable) ─────────────────────
  const CDN_HOSTS = [
    'unpkg.com', 'cdnjs.cloudflare.com',
    'fonts.googleapis.com', 'fonts.gstatic.com',
    'kit.fontawesome.com', 'use.fontawesome.com',
  ];
  if (CDN_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(cacheFirst(CDN_CACHE, request));
    return;
  }

  // ── Local files on same host ────────────────────────────────────────────
  if (url.hostname === self.location.hostname) {
    const filename = url.pathname.split('/').pop() || '';

    // App files (HTML/JS/CSS): NETWORK-FIRST - always get latest on normal refresh
    if (APP_FILES.some(f => filename === f || url.pathname.endsWith(f))) {
      event.respondWith(networkFirst(APP_CACHE, request));
      return;
    }

    // Large static data (world.json): cache-first (280KB, never changes)
    if (filename === 'world.json') {
      event.respondWith(cacheFirst(STATIC_CACHE, request));
      return;
    }

    // Other local assets (images, patches): network-first
    event.respondWith(networkFirst(APP_CACHE, request));
    return;
  }

  // ── Everything else: network with fallback ──────────────────────────────
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ── Strategies ───────────────────────────────────────────────────────────────

async function networkFirst(cacheName, request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Network failed - fall back to cache (offline mode)
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function cacheFirst(cacheName, request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline - asset not cached yet', { status: 503 });
  }
}

async function staleWhileRevalidate(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || networkFetch;
}

// ── Messages ─────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
