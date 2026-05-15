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
const APP_CACHE    = 'crisp-app-v16';  // v16 (May 2026): originals-pending chip drops on reports > 14d (matches PWA's deferred-variant timeout). Plus the dashboard image stretch fix (.dp-img .img-full-layer → object-fit:contain). Returning operators must evict v15 so the new logic lands.
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
