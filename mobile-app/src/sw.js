// CRISP service worker — offline caching, background sync, and push delivery.
//
// Cache-bump policy: any change to STATIC_ASSETS or any precached
// resource MUST bump CACHE_NAME so existing installs evict their stale
// snapshot on the next activate. Without this, returning users keep
// serving the old build forever.

const CACHE_NAME = 'crisp-v126';

// Derive base path from SW's own URL (works regardless of where the app is served)
const SW_BASE = self.location.href.replace(/sw\.js$/, '');

const STATIC_ASSETS = [
    SW_BASE,
    SW_BASE + 'index.html',
    SW_BASE + 'app.js',
    SW_BASE + 'places.js',
    SW_BASE + 'pii-blur.js',
    SW_BASE + 'image-variants.js',
    SW_BASE + 'blurhash.js',
    SW_BASE + 'building-select.js',  // UNDP §3.2 — building-footprint selector
    SW_BASE + 'auth.js',
    SW_BASE + 'install-prompt.js',
    SW_BASE + 'home-screen.js',
    SW_BASE + 'voice-readout.js',
    SW_BASE + 'v4-flow.js',
    // vendor/blazeface/model.json + .bin are NOT precached. They're
    // loaded on demand by pii-blur.js::ensureModel on first photo
    // capture and runtime-cached by the fetch handler below.
    SW_BASE + 'components/icon-pack.js',
    SW_BASE + 'styles.css',
    SW_BASE + 'manifest.json',
    SW_BASE + 'favicon.svg',
    SW_BASE + 'assets/icon-192.png',
    SW_BASE + 'assets/icon-512.png',
    // UNDP §3.1b — full 594-key translation packs, one per supported
    // locale. Precached so a user who installs the PWA online and goes
    // offline can pick ANY of the 22 supported languages and see the
    // UI in their language. `_loadLocaleJson()` in app.js fetches these
    // lazily on `activateLang(code)`; the cache-first handler serves
    // them from this cache without touching the network.
    //
    // 22-locale set:
    //   Tier 1 (UN official): en, zh, es, ar, fr, ru
    //   Tier 2 (UNDP submission set): hi, pt, bn, ja, tr, vi, ko, id, ur
    //   Tier 3 (Indian sub-national): kn, ta, te, ml, gu, mr, pa
    SW_BASE + 'i18n/en.json',
    SW_BASE + 'i18n/zh.json',
    SW_BASE + 'i18n/es.json',
    SW_BASE + 'i18n/ar.json',
    SW_BASE + 'i18n/fr.json',
    SW_BASE + 'i18n/ru.json',
    SW_BASE + 'i18n/hi.json',
    SW_BASE + 'i18n/pt.json',
    SW_BASE + 'i18n/bn.json',
    SW_BASE + 'i18n/ja.json',
    SW_BASE + 'i18n/tr.json',
    SW_BASE + 'i18n/vi.json',
    SW_BASE + 'i18n/ko.json',
    SW_BASE + 'i18n/id.json',
    SW_BASE + 'i18n/ur.json',
    SW_BASE + 'i18n/kn.json',
    SW_BASE + 'i18n/ta.json',
    SW_BASE + 'i18n/te.json',
    SW_BASE + 'i18n/ml.json',
    SW_BASE + 'i18n/gu.json',
    SW_BASE + 'i18n/mr.json',
    SW_BASE + 'i18n/pa.json'
];

const EXTERNAL_ASSETS = [
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;600;800&family=Noto+Sans+Arabic:wght@400;600;700&family=Noto+Sans+SC:wght@400;600;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    // TF.js + BlazeFace UMD are NOT precached. pii-blur.js's
    // _ensureScripts() lazy-loads them on first photo capture; the
    // runtime fetch handler below opportunistically caches them.
];

// Domains the runtime fetch handler should cache opportunistically so that a
// subsequent offline capture / map load still works.
const RUNTIME_CACHE_HOSTS = [
    'cdn.jsdelivr.net',
    'tfhub.dev',
    'storage.googleapis.com',  // where tfhub models are served from
    'www.kaggle.com',          // kaggle is the new tfhub host
    'unpkg.com',               // lazy-loaded Leaflet JS + CSS
];

// ── Install: pre-cache static shell ──────────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // Cache static assets first (critical), then external (best-effort)
            return cache.addAll(STATIC_ASSETS)
                .then(() => cache.addAll(EXTERNAL_ASSETS).catch(() => {
                    console.log('SW: Some external assets failed to cache (offline?)');
                }));
        })
    );
    // Do NOT auto-skipWaiting. New workers stay in 'waiting' until the
    // user taps "Update now" on the in-app banner (wired in app.js).
    // Without this gate, an installed PWA would silently flip versions
    // on the next navigation and could drop in-progress capture state.
    // First install is unaffected — no existing controller to wait for,
    // so the worker activates directly.
});

// Accept SKIP_WAITING from the page. app.js posts this when the user
// taps the in-app update banner; it promotes a 'waiting' worker to
// 'active', which fires `controllerchange` on the page and triggers a
// clean reload.
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// ── Activate: clean old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            );
        })
    );
    self.clients.claim();
});

// ── Fetch: cache-first for static, network-only for API ──────────────────────
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // /regions/enabled is the one API endpoint we deliberately cache:
    // clients hit it on every "Start Report" tap to decide whether to
    // arm the auto-submit timer, and stale-while-revalidate keeps that
    // interaction usable even when the device is offline. Payload is
    // tiny + public — no privacy concern.
    if (event.request.method === 'GET' && url.pathname.endsWith('/api/v1/regions/enabled')) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                const net = fetch(event.request).then((response) => {
                    if (response && response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                }).catch(() => cached);
                return cached || net;
            })
        );
        return;
    }

    // Other API calls: always go to network (don't cache submissions)
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    // ML model weights from TF.js model host (tfhub / jsdelivr / etc.) —
    // explicitly cache-first so offline capture can still run BlazeFace.
    const isMLAsset = RUNTIME_CACHE_HOSTS.includes(url.hostname);

    // Static assets: cache-first with network fallback
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                // Opaque responses (cross-origin, CORS-less) still get cached for ML
                // because the browser will replay them to the same CDN origin.
                if (event.request.method === 'GET' && (response.ok || (isMLAsset && response.type === 'opaque'))) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Offline fallback: return cached index.html for navigation
                if (event.request.mode === 'navigate') {
                    return caches.match(SW_BASE + 'index.html');
                }
            });
        })
    );
});

// ── Web Push: reporter feedback when their report's status changes ──────────
//
// The backend POSTs an encrypted payload to APNs / FCM / Mozilla
// autopush when a Report's status flips (RESPONDING / RESOLVED /
// FALSE_ALARM). The provider routes it to this SW even when the PWA is
// closed; we render a native notification.
//
// Payload shape (set by backend/app/services/push.py::_build_payload):
//   { title, body, tag, data: { report_id, status, url } }
//
// `tag` deduplicates: re-sending the same tag REPLACES the existing
// notification rather than stacking — important if an analyst flips
// a report's status multiple times in quick succession.
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (_) {
        // Non-JSON payload (e.g. provider keep-alive) — fall through
        // with a generic title rather than silently dropping. Better UX
        // than a missed notification.
        payload = { title: 'CRISP', body: 'You have a new update.' };
    }
    const title = payload.title || 'CRISP';
    const opts = {
        body: payload.body || '',
        icon: '/mobile-app/src/assets/icon-192.png',
        badge: '/mobile-app/src/assets/icon-96.png',
        tag: payload.tag || 'crisp-update',
        // `renotify: true` makes the device buzz/sound even when a
        // notification with the same tag is already on-screen — desired
        // for a crisis-report status change because the user IS waiting
        // for that signal.
        renotify: true,
        data: payload.data || {},
        // Two action buttons surface on Android; iOS ignores them but
        // still renders the notification body. "View" is the default;
        // "Dismiss" is a no-op tap that the user might prefer over
        // swiping the OS notification away.
        actions: [
            { action: 'view',    title: 'View report' },
            { action: 'dismiss', title: 'Dismiss' },
        ],
    };
    event.waitUntil(self.registration.showNotification(title, opts));
});

// ── notificationclick: focus existing tab or open a new one ─────────────────
//
// When the user taps the notification, we want to land them on the PWA
// at the report's deep link. Behavior:
//   1. If a CRISP tab is already open, focus it (and navigate if URL differs).
//   2. Otherwise, open a new window/tab to the deep link.
// `event.action` is "view" / "dismiss" / "" (no action button tapped, just the body).
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    if (event.action === 'dismiss') return;

    const data = event.notification.data || {};
    const targetUrl = data.url || '/mobile-app/src/';

    event.waitUntil((async () => {
        const allClients = await self.clients.matchAll({
            type: 'window',
            includeUncontrolled: true,
        });
        // Prefer same-origin CRISP tabs.
        for (const c of allClients) {
            try {
                const u = new URL(c.url);
                if (u.pathname.startsWith('/mobile-app/')) {
                    await c.focus();
                    // Use postMessage so app.js can route to the report
                    // without a hard navigation. The handler is wired in
                    // app.js (search for 'NOTIFICATION_OPEN').
                    c.postMessage({ type: 'NOTIFICATION_OPEN', data });
                    return;
                }
            } catch (_) { /* malformed URL — skip */ }
        }
        // No matching tab — open a new one.
        if (self.clients.openWindow) {
            await self.clients.openWindow(targetUrl);
        }
    })());
});

// ── Background Sync: retry queued reports when online ────────────────────────
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-reports') {
        event.waitUntil(syncAllReports());
    }
});

async function syncAllReports() {
    let db;
    try {
        db = await openIDB();
    } catch (e) {
        console.log('SW: Could not open IndexedDB', e);
        return;
    }

    const items = await idbGetAll(db, 'pending-reports');
    if (items.length === 0) return;

    // Origin-aware backend host (matches app.js). On localhost dev the
    // page is served on :8080 with the backend on :8000, so swap port.
    // In prod the page and API share an origin behind nginx — use it
    // as-is.
    const _swHost = self.location.hostname;
    const _swIsLocalDev = ["localhost", "127.0.0.1", "0.0.0.0"].includes(_swHost);
    const apiBase = _swIsLocalDev
        ? self.location.origin.replace(/:\d+$/, ':8000')
        : self.location.origin;
    console.log(`SW: Syncing ${items.length} queued reports`);
    let synced = 0;

    for (const item of items) {
        try {
            const stages = item.stages || {};
            let reportId = item.serverId || null;

            // Stage 1: Send metadata if not done
            if (!stages.meta && item.meta) {
                const res = await fetch(`${apiBase}/api/v1/reports/meta`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(item.meta)
                });
                if (res.ok || res.status === 201) {
                    const data = await res.json();
                    reportId = data.id;
                    item.serverId = reportId;
                    item.stages.meta = true;
                    await idbPut(db, 'pending-reports', item);
                    console.log(`SW: Meta synced for ${item.client_report_id} -> ${reportId}`);
                } else if (res.status >= 400 && res.status < 500) {
                    await idbDelete(db, 'pending-reports', item.client_report_id);
                    continue;
                } else { throw new Error(`Meta: HTTP ${res.status}`); }
            }

            // Need a server report ID for media stages
            if (!reportId) { continue; }

            // Stage 2: Send photo if not done
            if (!stages.photo && item.photo) {
                const res = await fetch(`${apiBase}/api/v1/reports/${reportId}/media/attach`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'IMAGE', resolution_tier: 'MEDIUM',
                        url: item.photo, file_size_bytes: item.photoSize || 0
                    })
                });
                if (res.ok) {
                    item.stages.photo = true;
                    item.photo = null; // free memory
                    await idbPut(db, 'pending-reports', item);
                    console.log(`SW: Photo synced for ${reportId}`);
                }
                // On failure, leave in queue — will retry next sync
            }

            // Stage 3: Send audio if not done
            if (!stages.audio && item.audioBlob) {
                const res = await fetch(`${apiBase}/api/v1/reports/${reportId}/media/attach`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'AUDIO', resolution_tier: 'LOW',
                        url: item.audioBlob, file_size_bytes: item.audioSize || 0
                    })
                });
                if (res.ok) {
                    item.stages.audio = true;
                    item.audioBlob = null; // free memory
                    await idbPut(db, 'pending-reports', item);
                    console.log(`SW: Audio synced for ${reportId}`);
                }
            }

            // Check if all stages complete
            if (item.stages.meta && item.stages.photo && item.stages.audio) {
                await idbDelete(db, 'pending-reports', item.client_report_id);
                synced++;
                const clients = await self.clients.matchAll();
                clients.forEach(client => {
                    client.postMessage({
                        type: 'SYNC_SUCCESS',
                        client_report_id: item.client_report_id,
                        server_id: reportId
                    });
                });
            }

        } catch (err) {
            console.log(`SW: Sync failed for ${item.client_report_id}:`, err.message);
        }
    }

    if (synced > 0) {
        console.log(`SW: Fully synced ${synced}/${items.length} reports`);
    }
}

// ── IndexedDB helpers (service worker context) ───────────────────────────────
function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('crisp-offline', 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('pending-reports')) {
                db.createObjectStore('pending-reports', { keyPath: 'client_report_id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbGetAll(db, storeName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbDelete(db, storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function idbPut(db, storeName, item) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
