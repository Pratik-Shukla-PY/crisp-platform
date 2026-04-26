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

// v8/v7/v7/v10 → v9/v8/v8/v11 — bump for the throttled-polling fix
// (decouple pending-deletions check from per-poll cycle, cap active-
// poll mode to 60 s of stalled progress). Forces SW reactivation
// + cache wipe so users pick up the new app.js immediately.
const APP_CACHE    = 'crisp-app-v9';
const CDN_CACHE    = 'crisp-cdn-v8';
const API_CACHE    = 'crisp-api-v8';
const STATIC_CACHE = 'crisp-static-v11';

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
    event.respondWith(
      fetch(request).catch(() => caches.match(request) || new Response(
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
