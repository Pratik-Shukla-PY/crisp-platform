/**
 * CRISP Web Dashboard — Service Worker
 * ─────────────────────────────────────
 * Strategy:
 *   Static local assets  → Cache-First  (instant on repeat visit)
 *   CDN assets           → Cache-First  (cache once, serve forever)
 *   API /api/v1/reports  → Stale-While-Revalidate (show cached data,
 *                          silently fetch fresh in background)
 *   Everything else      → Network with cache fallback
 */

const STATIC_CACHE  = 'crisp-static-v5';
const CDN_CACHE     = 'crisp-cdn-v2';
const API_CACHE     = 'crisp-api-v2';

// Local files to pre-cache on install (served instantly forever after)
const PRECACHE_ASSETS = [
  '/web-dashboard/src/index.html',
  '/web-dashboard/src/styles.css',
  '/web-dashboard/src/app.js',
  '/web-dashboard/src/world.json',
  '/web-dashboard/src/app_patch.js',
  '/web-dashboard/src/app_tooltip_patch.js',
];

// ── Install: pre-cache local assets ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // don't block install if a file 404s
  );
});

// ── Activate: wipe old caches ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  const valid = [STATIC_CACHE, CDN_CACHE, API_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !valid.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: route by request type ──────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET
  if (request.method !== 'GET') return;

  // ── API data: stale-while-revalidate ─────────────────────────────────────
  if (url.port === '8000' || url.pathname.startsWith('/api/')) {
    event.respondWith(staleWhileRevalidate(API_CACHE, request));
    return;
  }

  // ── CDN assets: cache-first ───────────────────────────────────────────────
  const CDN_HOSTS = [
    'unpkg.com', 'cdnjs.cloudflare.com',
    'fonts.googleapis.com', 'fonts.gstatic.com',
    'kit.fontawesome.com', 'use.fontawesome.com',
  ];
  if (CDN_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(cacheFirst(CDN_CACHE, request));
    return;
  }

  // ── Local static assets: cache-first ─────────────────────────────────────
  if (url.hostname === self.location.hostname) {
    event.respondWith(cacheFirst(STATIC_CACHE, request));
    return;
  }

  // ── Anything else: network with fallback ─────────────────────────────────
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ── Strategies ────────────────────────────────────────────────────────────────

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

  // Kick off network fetch in background regardless
  const networkFetch = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  // Return cached immediately if available, otherwise wait for network
  return cached || networkFetch;
}

// ── Background sync: notify clients when fresh data arrives ──────────────────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
