/**
 * CRISP Web Dashboard — Service Worker
 * ─────────────────────────────────────
 * Strategy:
 *   App files (HTML/JS/CSS) → Network-First (always get latest, cache as fallback)
 *   CDN assets              → Cache-First   (fonts, icons — rarely change)
 *   Static data (world.json)→ Cache-First   (large, never changes)
 *   API /api/v1/reports     → Stale-While-Revalidate (instant + background refresh)
 *   Everything else         → Network with cache fallback
 */

// v9/v8/v8/v11 → v10/v9/v9/v12 — Apr 2026 round-2 CSP fix.
// Bumping to evict any client that has stale HTML/CDN entries cached
// from the brief window where connect-src was missing tile hosts +
// the browser was heuristic-pinning the old CSP. Old SWs auto-replace
// because skipWaiting() runs in install + nginx now sends Cache-Control:
// no-cache on sw.js so the new code lands within seconds of deploy.
const APP_CACHE    = 'crisp-app-v30';  // v30 (May 2026): Phase L Batch 2 — tier-rename cleanup. TIER_RANK now includes SMALL; 4 'HIGH' default fallbacks switched to ORIGINAL. Validator script `validate-phase-l-tier-vocab.mjs` added so no future tier-vocab regression sneaks in. // v29 (May 2026): Phase K Batch 6 — operator-visible visibility chips + filter correctness. K.5.a adds the .k5a-chip row in createIncidentCard for the new abandon_reason (checksum_mismatch / chunks_never_arrived / bandwidth_tier_deferred / assembly_worker_lost), pii_blur_status='failed', submitted_as_anonymous_due_to_expired_token, and sync_status=PARTIAL+pending signals. K.5.b changes every time-filter site (renderTriageQueue + renderTreeFeed + _getFilteredReports + analytics) to use _priorityTime() instead of server_created_at so offline-drained reports are filtered by capture time. K.5.c caps _seenIds at 1000 with FIFO eviction + load-time trim — prevents localStorage quota exhaustion on weeks-long sessions. K.5.d raises _MAX_NOTIFS 10 → 50 so burst-mode arrivals don't shed older entries off the bell LIFO. K.5.e adds an operator-visible truncation banner when X-Total-Count exceeds DASHBOARD_PAGE_LIMIT — pre-fix only logged to console. Returning operators must evict the stale app.js + styles.css to pick up the chips + banner. Test-only helper __crispSetTimeFilterHoursForTest added.
                                       // v28 (May 2026): notification regression follow-up to v27.
                                       // v27 (May 2026): notification-stack lifecycle rewrite — dedup-first ordering, incremental DOM (no innerHTML thrash), CSS-driven position transitions, centralised _refreshStackTimers state machine, .is-entering / .is-leaving entrance/exit classes (replaces baseline flash-in animation that re-fired on every render). Fixes "cards float/reposition randomly" + "notifications repeat for same report on media upgrade" + "full-refresh cascade of duplicate notifications". Introduced `_suppressNewReportNotifications` (later REMOVED in v28 — see above).
                                       // v26 (May 2026): Phase F image-reliability — assembly recovery sweep, abandoned-upload terminal state, tri-state LARGE-tier chip, Reclaim modal, offline banner.
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
    return; // Let browser handle it directly — no SW interception
  }

  // ── Page navigations: bypass SW entirely when online; cache fallback
  //    for offline only. Apr 2026 fix — the old networkFirst-for-HTML
  //    path had a race-condition class of bug where a stale cached
  //    index.html / login.html got served on regular refresh, leaving
  //    the page in a broken state. Hard-refresh (Cmd+Shift+R) bypassed
  //    the SW and worked, which is the smoking-gun symptom for this
  //    bug. Standard SPA SW pattern: cache assets, but let the browser
  //    handle navigations natively.
  if (request.mode === 'navigate') {
    // Apr 2026 — force-revalidate against the server (cache: 'no-cache').
    // Without this, a navigation request can serve from the BROWSER HTTP
    // cache when the cached entry is heuristically fresh — even though
    // we want every navigation to pull the latest HTML so a deployed
    // CSP / app.js update reaches users immediately. The fetch() respects
    // the original request's mode/credentials by default, but we override
    // the cache strategy to revalidate. Combined with nginx's
    // Cache-Control: no-cache for HTML, this gives 304 Not Modified for
    // unchanged content (fast) and 200 + new HTML/headers for changes.
    event.respondWith(
      fetch(request, { cache: 'no-cache' }).catch(() => caches.match(request) || new Response(
        '<h1>CRISP — Offline</h1><p>You appear to be offline. Reconnect and reload.</p>',
        { headers: { 'Content-Type': 'text/html' }, status: 503 },
      )),
    );
    return;
  }

  // ── CDN assets: cache-first (fonts, icons — stable) ─────────────────────
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

    // App files (HTML/JS/CSS): NETWORK-FIRST — always get latest on normal refresh
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
    // Network failed — fall back to cache (offline mode)
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
    return new Response('Offline — asset not cached yet', { status: 503 });
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
