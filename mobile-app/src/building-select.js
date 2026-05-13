// ─────────────────────────────────────────────────────────────────────────────
//  CRISP — Building-footprint selector (PWA, April 2026)
//
//  UNDP RAPIDA Problem Statement: "Buildings of interest shall be selected by
//  users via ... buildings shall be made available for users to pick from a
//  (satellite) map underlayer in the field app."
//
//  This module:
//    * Lazy-loads a Leaflet map inside `#building-map` the first time the
//      reporter expands the <details> block on stage-review.
//    * Centres on state.location.
//    * Queries OSM via Overpass for buildings in a ~200 m radius.
//    * Renders each footprint as a tappable polygon.
//    * On tap, stores the OSM way id into `state.buildingId` — the
//      submit handler in app.js already emits `building_id` on
//      POST /reports.
//
//  Offline behaviour: the Overpass response is cached in IndexedDB keyed
//  by a rounded lat/lng pair so repeat captures in the same neighbourhood
//  work without network. Failed fetches leave the map with just the
//  location pin (graceful degradation — the user falls through to the
//  existing GPS-only flow).
//
//  Exposed as a global `BuildingSelect` so app.js (non-module vanilla JS)
//  can call it without a bundler. Matches the TF.js + PIIBlur pattern.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
    const RADIUS_METERS = 200;
    // Rounding key for the cache; ~0.002° ≈ 220 m at the equator so one
    // cached tile covers exactly the fetch radius.
    const CACHE_KEY_PRECISION = 3;
    const IDB_NAME = 'crisp_buildings_v1';
    const IDB_STORE = 'tiles';

    let _map = null;
    let _overlay = null;
    let _selectedLayer = null;
    let _initInFlight = false;
    // BUGFIX May 2026 — track the lat/lng we last fetched buildings for.
    // When the reporter changes the report's location (e.g. picks a place
    // 700 km away via the Step-3 inline location editor), `ensureMap` is
    // re-called with new coords. The old fast-path early-returned after
    // `setView` — buildings stayed cached for the *original* GPS bbox and
    // the user saw terrain with zero tappable polygons (UNDP must-have #6
    // regression). Tracking the last fetch lets us detect "user moved
    // beyond the current buildings tile" and re-fetch.
    let _lastFetchLat = null;
    let _lastFetchLng = null;
    // ~50 m at the equator; well inside the 200 m fetch radius so we don't
    // re-fetch on a GPS jitter wobble, but well below the 220 m cache-tile
    // size so a cross-tile move triggers a re-fetch reliably.
    const _REFETCH_THRESHOLD_DEG = 0.0005;

    function _cacheKey(lat, lng) {
        const r = (n) => n.toFixed(CACHE_KEY_PRECISION);
        return `${r(lat)},${r(lng)}`;
    }

    async function _openIDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE, { keyPath: 'key' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function _readCache(key) {
        try {
            const db = await _openIDB();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = () => resolve(req.result && req.result.data);
                req.onerror = () => reject(req.error);
            });
        } catch (_) {
            return null;
        }
    }

    async function _writeCache(key, data) {
        try {
            const db = await _openIDB();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put({ key, data, at: Date.now() });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (_) {
            // best-effort — never block the UI on cache-write failure
        }
    }

    async function _fetchBuildings(lat, lng) {
        const key = _cacheKey(lat, lng);
        const cached = await _readCache(key);
        if (cached) return cached;

        if (!navigator.onLine) return null;

        const query = `
            [out:json][timeout:15];
            (
              way(around:${RADIUS_METERS},${lat},${lng})["building"];
              relation(around:${RADIUS_METERS},${lat},${lng})["building"];
            );
            out body geom;
        `.trim();
        try {
            const res = await fetch(OVERPASS_URL, {
                method: 'POST',
                body: 'data=' + encodeURIComponent(query),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });
            if (!res.ok) return null;
            const data = await res.json();
            const elems = (data && data.elements) || [];
            await _writeCache(key, elems);
            return elems;
        } catch (err) {
            console.warn('[BuildingSelect] Overpass fetch failed:', err);
            return null;
        }
    }

    function _buildingLatLngs(elem) {
        // Overpass 'out geom' attaches `geometry` to each way.
        if (Array.isArray(elem.geometry) && elem.geometry.length >= 3) {
            return elem.geometry.map((p) => [p.lat, p.lon]);
        }
        // Relations may have members[].geometry — aggregate the first
        // outer ring we find. Not all are well-formed but this is
        // sufficient for the common case of multipolygon buildings.
        if (Array.isArray(elem.members)) {
            for (const m of elem.members) {
                if (m.role === 'outer' && Array.isArray(m.geometry)) {
                    return m.geometry.map((p) => [p.lat, p.lon]);
                }
            }
        }
        return null;
    }

    function _commitSelection(id, layer, element) {
        // Clear any previous highlight
        if (_selectedLayer) {
            _selectedLayer.setStyle({
                color: '#2563eb', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.15,
            });
        }
        layer.setStyle({
            color: '#ef4444', weight: 2.5, fillColor: '#ef4444', fillOpacity: 0.45,
        });
        _selectedLayer = layer;

        // Store both the OSM id and the typed feature so the backend
        // building-versioning + the dashboard can pick it up.
        const osmType = element.type || 'way';
        const composite = `osm:${osmType}:${element.id}`;
        const tags = element.tags || {};
        // Pick the best human-readable name for the admin dashboard. OSM
        // conventions in order of usefulness: `name` > `name:en` > the
        // building/amenity type itself ("hospital", "residential"). If
        // none are present, leave null and let the indigo "Building
        // history" pill carry the raw ID.
        const osmName =
            tags.name || tags['name:en'] ||
            (tags.amenity ? `${tags.amenity}`.replace(/_/g, ' ') : null) ||
            (tags.building && tags.building !== 'yes' ? `${tags.building}`.replace(/_/g, ' ') : null) ||
            null;

        if (window.state) {
            window.state.buildingId = composite;
            window.state.buildingOsmElement = {
                type: osmType,
                id: element.id,
                tags: tags,
                name: osmName,
            };
            // Auto-fill `infrastructure_name` with the OSM name so the
            // dashboard renders "City Hospital" next to the indigo
            // Building-history pill. Only overwrite if the user hasn't
            // manually typed something — respects user intent. Tag with
            // a flag so `_clearSelection` below only clears what WE set.
            if (osmName && !(window.state.infraName && window.state.infraName.trim())) {
                window.state.infraName = osmName;
                window.state.infraNameFromOsm = true;
                // Mirror into the textbox if it exists on-screen so the
                // submitter sees what auto-filled. Bare HTMLInput so no
                // framework dance.
                const inp = document.getElementById('input-infra-name');
                if (inp && !inp.value.trim()) inp.value = osmName;
            }
        }
        const pill = document.getElementById('building-selected-pill');
        if (pill) {
            pill.style.display = 'flex';
            // UI v2.1 — show the OSM name inside the pill so
            // the reporter gets immediate confirmation of WHAT they
            // just picked, not just "Building selected" generically.
            const nameSlot = pill.querySelector('.building-selected-name');
            if (nameSlot) nameSlot.textContent = osmName || `#${element.id}`;
        }
        // M2 polish — broadcast selection so external listeners
        // (e.g. the fullscreen-picker bottom sheet in app.js) can react
        // without poking into BuildingSelect's internals. The detail
        // payload carries everything an external view needs to render
        // a confirmation card. Best-effort; never throws into the click
        // handler that called us.
        try {
            document.dispatchEvent(new CustomEvent('crisp:building-selected', {
                detail: {
                    buildingId: composite,
                    osmType,
                    osmId: element.id,
                    name: osmName,
                    tags,
                },
            }));
        } catch (_) { /* CustomEvent unsupported on very old browsers — skip */ }
        console.log('[BuildingSelect] selected', composite, osmName || '(no name tag)', tags);
    }

    function _clearSelection() {
        if (_selectedLayer) {
            _selectedLayer.setStyle({
                color: '#2563eb', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.15,
            });
            _selectedLayer = null;
        }
        if (window.state) {
            window.state.buildingId = null;
            window.state.buildingOsmElement = null;
            // Only clear infraName if WE auto-filled it. If the user
            // typed it manually (infraNameFromOsm is absent / false),
            // keep their value — they might reselect a nearby building.
            if (window.state.infraNameFromOsm) {
                window.state.infraName = '';
                window.state.infraNameFromOsm = false;
                const inp = document.getElementById('input-infra-name');
                if (inp) inp.value = '';
            }
        }
        const pill = document.getElementById('building-selected-pill');
        if (pill) pill.style.display = 'none';
        // M2 polish — companion event to crisp:building-selected so the
        // fullscreen picker's bottom sheet can revert to the empty-prompt
        // state (or stay closed if no selection had been made).
        try {
            document.dispatchEvent(new CustomEvent('crisp:building-cleared'));
        } catch (_) {}
    }

    // ─── Lazy-load Leaflet ─────────────────────────
    // Was eagerly loaded via <script> + <link> in index.html (~46 KB
    // home-page tax). Now injected on first ensureMap call. Idempotent
    // + concurrent-safe via a cached promise.
    const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    let _leafletPromise = null;
    function _injectScript(url, integrity) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${url}"]`);
            if (existing) {
                if (existing.dataset.loaded === '1') return resolve();
                existing.addEventListener('load', () => resolve());
                existing.addEventListener('error', () => reject(new Error('script load failed: ' + url)));
                return;
            }
            const s = document.createElement('script');
            s.src = url;
            s.crossOrigin = '';
            if (integrity) s.integrity = integrity;
            s.async = false;
            s.onload = () => { s.dataset.loaded = '1'; resolve(); };
            s.onerror = () => reject(new Error('script load failed: ' + url));
            document.head.appendChild(s);
        });
    }
    function _injectStylesheet(url, integrity) {
        if (document.querySelector(`link[href="${url}"]`)) return;
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = url;
        l.crossOrigin = '';
        if (integrity) l.integrity = integrity;
        document.head.appendChild(l);
    }
    function _ensureLeaflet() {
        if (typeof L !== 'undefined') return Promise.resolve();
        if (_leafletPromise) return _leafletPromise;
        _leafletPromise = (async () => {
            // CSS first — Leaflet's JS reads computed styles for tile sizing.
            _injectStylesheet(LEAFLET_CSS, 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=');
            await _injectScript(LEAFLET_JS, 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=');
            if (typeof L === 'undefined') {
                throw new Error('Leaflet did not initialise (window.L missing after script load)');
            }
        })();
        return _leafletPromise;
    }

    /** Public entry point — init the map (idempotent). Callers pass the
     * current lat/lng so we don't depend on any particular state shape. */
    /**
     * Repaint the building-polygon overlay for the given lat/lng. Clears
     * any prior polygons on `_overlay`, fetches the OSM buildings for
     * the new bbox, and draws + wires tap handlers. Updates the cache
     * tracker so subsequent jitter calls don't re-fetch needlessly.
     *
     * Idempotent + safe to call on an already-mounted map. Used by both
     * the first-init path inside `ensureMap` AND the "user moved the
     * report location" re-fetch path.
     */
    async function _paintBuildings(lat, lng) {
        if (!_map || !_overlay) return;
        const elems = await _fetchBuildings(lat, lng);
        // Clear the old polygons BEFORE drawing the new ones so a
        // remote-location move doesn't leave the previous neighbourhood's
        // outlines floating in space. _selectedLayer is also reset so a
        // stale selection doesn't survive a location change.
        try { _overlay.clearLayers(); } catch (_) {}
        _selectedLayer = null;
        if (Array.isArray(elems)) {
            elems.forEach((el) => {
                const latlngs = _buildingLatLngs(el);
                if (!latlngs) return;
                const poly = L.polygon(latlngs, {
                    color: '#2563eb',
                    weight: 1,
                    fillColor: '#3b82f6',
                    fillOpacity: 0.15,
                }).addTo(_overlay);
                poly.on('click', () => _commitSelection(el.id, poly, el));
            });
            console.log(
                `[BuildingSelect] painted ${elems.length} building(s) ` +
                `near (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
            );
        } else {
            console.log('[BuildingSelect] no building data — map-only fallback');
        }
        _lastFetchLat = lat;
        _lastFetchLng = lng;
    }

    async function ensureMap(lat, lng) {
        // lazy-load Leaflet on first ensureMap call. Was
        // eagerly loaded via <script> in index.html.
        try {
            await _ensureLeaflet();
        } catch (e) {
            console.warn('[BuildingSelect] Leaflet lazy-load failed:', e?.message || e);
            return;
        }
        const container = document.getElementById('building-map');
        if (!container || typeof L === 'undefined') return;
        if (!(Number.isFinite(lat) && Number.isFinite(lng))) return;
        if (_map || _initInFlight) {
            // Already initialised — recentre + optionally re-fetch buildings.
            //
            // BUGFIX May 2026 — UNDP must-have #6 regression.
            //
            // Pre-fix: this branch only called `_map.setView` and returned.
            // The basemap tiles updated (Leaflet fetches them automatically)
            // but the building-polygon overlay still held the polygons from
            // the original lat/lng. A reporter who manually changed the
            // report's location to a city 700 km away saw the new terrain
            // with ZERO tappable buildings — UNDP must-have #6 silently
            // dropped, forcing them onto the free-text fallback.
            //
            // Post-fix: if the new coords are >~50 m from the last fetch we
            // re-run `_paintBuildings`. Within 50 m we treat it as GPS
            // jitter and skip the Overpass round-trip.
            if (_map) {
                _map.setView([lat, lng], _map.getZoom());
                try { L.marker([lat, lng], { zIndexOffset: 1000 }).addTo(_map); } catch (_) {}
                const moved = (_lastFetchLat === null || _lastFetchLng === null)
                    || Math.abs(lat - _lastFetchLat) > _REFETCH_THRESHOLD_DEG
                    || Math.abs(lng - _lastFetchLng) > _REFETCH_THRESHOLD_DEG;
                if (moved) {
                    _paintBuildings(lat, lng).catch((e) => {
                        console.warn('[BuildingSelect] re-paint after location change failed:', e?.message || e);
                    });
                }
            }
            return;
        }
        _initInFlight = true;

        try {
            // P5 scroll-lock fix: explicit wheel/touch/dragging
            // flags so the outer PWA page scroll reaches past the map
            // instead of being swallowed by Leaflet's default `passive:
            // false` wheel handler. Mouse-wheel zoom is disabled on the
            // field app (buttons + pinch only); keyboard panning is off
            // because the map lives inside a scroll container where
            // arrow keys would fight. touchZoom + dragging stay on so
            // users can still interact; `tap` stays on for mobile hit
            // detection on building polygons.
            // `tap: true` removed. Deprecated in Leaflet 1.7+,
            // accepted-but-ignored in 1.9.4 we ship; on iOS Safari the
            // legacy tap-handler path used to fight with native click
            // synthesis and produced double-tap-zoom regressions on
            // building polygons. Modern Leaflet auto-detects touch and
            // wires native click/touchstart correctly without it.
            _map = L.map(container, {
                zoomControl: true,
                attributionControl: false,
                scrollWheelZoom: false,
                touchZoom: true,
                dragging: true,
                keyboard: false,
                // `preferCanvas: true` makes Leaflet render
                // overlays via a single <canvas> instead of one <svg>
                // path per polygon. iOS Safari's SVG renderer occasionally
                // failed to paint inside a transformed-then-detransformed
                // ancestor (the symptom that caused the original blank-
                // map bug). Canvas rendering bypasses the SVG path and
                // is also faster at 100+ polygons.
                preferCanvas: true,
            }).setView([lat, lng], 18);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                // Explicit subdomains — Leaflet's default `'abc'` works
                // in Chrome but iOS Safari occasionally fails DNS
                // prefetch on the rotated subdomain pattern. Listing
                // them as an array forces the parsed form.
                subdomains: ['a', 'b', 'c'],
                // crossOrigin allows the canvas-rendered tiles to be
                // exported (e.g., to a screenshot of the report).
                // Required when `preferCanvas: true` because canvas
                // tile-rendering taints the canvas without it.
                crossOrigin: 'anonymous',
                attribution: '© OpenStreetMap',
            }).addTo(_map);

            // Report-location marker so the user always sees their pin.
            L.marker([lat, lng], { zIndexOffset: 1000 }).addTo(_map);

            _overlay = L.layerGroup().addTo(_map);
            // Single source of truth for the polygon paint; `_paintBuildings`
            // both fetches + draws + updates the `_lastFetchLat/Lng` cache
            // tracker so the re-fetch threshold check above works on every
            // subsequent ensureMap call.
            await _paintBuildings(lat, lng);
        } finally {
            _initInFlight = false;
        }
    }

    function getSelection() {
        if (!window.state) return null;
        return {
            buildingId: window.state.buildingId || null,
            osm: window.state.buildingOsmElement || null,
        };
    }

    // Try to initialise the Leaflet map + placeholder swap. Idempotent:
    // safe to call multiple times; `ensureMap` itself is idempotent, and
    // we clear the placeholder only after a successful tile fetch.
    //
    // Safari fix: defer the init with double-rAF instead of
    // setTimeout(0). The stage transition from display:none → block
    // queues a style change that hasn't flushed by the next macrotask
    // tick, so setTimeout(0) saw container.getBoundingClientRect() ===
    // 0×0 → Leaflet cached that as the map size → tiles never paint in
    // Safari. Chrome was more forgiving because of its more aggressive
    // layout invalidation. Double-rAF guarantees the browser has run
    // a full paint between the style change and our init call.
    //
    // Also: ensureMap re-checks _map idempotency, so calling it on EVERY
    // stage-entered (not just the first time) gives us a chance to
    // invalidateSize() and recover from a half-rendered map that the
    // user briefly switched away from.
    function _tryInitMap() {
        const box = document.getElementById('building-select-box');
        if (!box) return;
        const loc = window.state && window.state.location;
        if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
            console.log('[BuildingSelect] waiting for GPS');
            return;
        }
        // Two animation frames: first to ensure the style change has
        // been applied, second to ensure layout has been recomputed.
        // Without this, Safari mobile saw 0×0 container and never painted.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const placeholder = document.getElementById('building-map-placeholder');
            if (placeholder) placeholder.style.display = 'none';
            ensureMap(loc.lat, loc.lng).then(() => {
                // After init (or on a subsequent show), kick Leaflet into
                // re-measuring its container. This is the canonical
                // Safari/iOS workaround for "map shows but tiles are
                // blank / clipped". Cheap — single ms — and idempotent.
                if (!_map) return;
                try { _map.invalidateSize({ animate: false }); } catch (_) {}

                // second-chance invalidateSize 500 ms later.
                // iOS Safari sometimes settles layout AFTER the rAF cycle
                // (when fetching CSS from cache, or when the page's flex
                // tree finishes during the same task as our init). The
                // first invalidateSize might still see a half-painted
                // state. The second one fires after Safari has painted at
                // least once, which forces tile prefetch + repaint of
                // the polygon overlay. Idempotent — Leaflet skips work
                // when dimensions haven't changed.
                setTimeout(() => {
                    if (!_map) return;
                    try {
                        _map.invalidateSize({ animate: false });
                        // Force a re-fetch of the current view's tiles.
                        // setView with the same coords + zoom is a no-op
                        // for position but does re-evaluate visible bounds
                        // and triggers tile loads we may have missed.
                        const c = _map.getCenter();
                        _map.setView([c.lat, c.lng], _map.getZoom(), { animate: false });
                    } catch (_) {}
                }, 500);
            }).catch((e) => {
                console.warn('[BuildingSelect] init failed:', e);
                // Restore placeholder so the user sees something explain-able.
                if (placeholder) placeholder.style.display = '';
            });
        }));
    }

    // UI v2.1 — wire up the flat <section>. The box is always
    // present in the DOM; the map initialises the first time the user
    // lands on v2-page-3 WITH a GPS fix. Previous design hung the
    // toggle off the <details> `toggle` event; after the flatten we
    // listen for custom `review-page-changed` and `stage-entered`
    // events + re-try on GPS-ready. Legacy v1 (collapsible) path still
    // works — `<details>` would have fired `toggle`; the flat tag does
    // not, but the explicit page-3 hook below handles both branches.
    function _wire() {
        const box = document.getElementById('building-select-box');
        if (!box) return;

        // Trigger 1: the PWA's review pager fires this whenever the user
        // navigates between pages. We react to page=3.
        document.addEventListener('review-page-changed', (e) => {
            if ((e && e.detail && e.detail.page) === 3) _tryInitMap();
        });
        // Trigger 2: stage-entered fires on every stage switch, which
        // catches the case where the user lands directly on review via
        // the submit-then-edit flow.
        document.addEventListener('stage-entered', (e) => {
            if (!e) return;
            // the building-select box now lives
            // inside stage-crisis (moved there by migrateV3Blocks in app.js).
            // Init the map the moment the reporter lands there so the
            // Leaflet overlay is ready WHILE they're picking a crisis type.
            if (e.detail === 'stage-crisis') {
                setTimeout(() => { _tryInitMap(); }, 0);
                return;
            }
            // v4 review uses #v4-building-mount as the new container; the
            // box is moved there by v4-flow.js's _initReviewStage on first
            // entry. Same _tryInitMap path works because it queries
            // #building-select-box by id (location-agnostic in DOM).
            if (e.detail === 'stage-v4-review') {
                setTimeout(() => { _tryInitMap(); }, 0);
                return;
            }
            if (e.detail === 'stage-review') {
                // Defer one tick so showReviewPage() has already applied
                // the data-v2-page filter before we inspect the DOM.
                setTimeout(() => {
                    const root = document.getElementById('stage-review');
                    const p = root && root.getAttribute('data-review-page');
                    // On legacy v1, page 2 is the confirm card (no map);
                    // on v2, page 3 is where we want to init. Match both.
                    if (p === '3' || p === '2') _tryInitMap();
                }, 0);
            }
        });
        // Trigger 3: GPS-ready (the capture flow dispatches this when
        // the Geolocation API resolves). Safe to call unconditionally —
        // `_tryInitMap` re-checks every precondition.
        document.addEventListener('gps-ready', _tryInitMap);

        // Trigger 4 (May 2026, UNDP must-have #6 follow-up) — the reporter
        // changed the report's location to a place far from their GPS fix.
        // The dispatcher (v4-flow.js's `_saveLocEdit`) carries the new
        // lat/lng on `event.detail`. We pass those straight through to
        // `ensureMap`, which then either initialises the Leaflet instance
        // (first time) or re-fetches buildings for the new bbox (already
        // mounted). The `_REFETCH_THRESHOLD_DEG` check in `ensureMap`
        // protects against noise from minor GPS-corrected updates.
        document.addEventListener('crisp-location-changed', (e) => {
            const lat = e && e.detail && e.detail.lat;
            const lng = e && e.detail && e.detail.lng;
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                ensureMap(lat, lng).catch((err) => {
                    console.warn('[BuildingSelect] location-changed handler failed:', err?.message || err);
                });
            }
        });

        // Legacy safety net — if someone flips the feature flag back
        // to v1, `<section>` becomes `<details>` again after a reload
        // and this listener is still the right thing.
        if (typeof box.addEventListener === 'function' && box.tagName === 'DETAILS') {
            box.addEventListener('toggle', () => {
                if (box.open) _tryInitMap();
            });
        }

        const clearBtn = document.getElementById('btn-building-clear');
        if (clearBtn) clearBtn.addEventListener('click', _clearSelection);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _wire);
    } else {
        _wire();
    }

    // ── — building pre-cache ────────────────────
    // Proactively warm the IndexedDB cache with the buildings nearest to
    // the user's current GPS position so an offline capture immediately
    // after opening the app (tunnel, crisis-zone cell-tower drop) still
    // paints the footprint overlay from cache. The same `_fetchBuildings`
    // pathway as the live map initialiser — just called without a map
    // context. Idempotent per-cache-key: the first hit seeds IndexedDB and
    // every subsequent call within the tile radius is a no-op.
    //
    // `count=10` shapes the returned slice by picking the 10 polygons with
    // the smallest centroid distance from (lat, lng). The cache itself
    // always stores every polygon within RADIUS_METERS — the slicing is
    // purely for callers that want a quick "nearest buildings" list (e.g.
    // the free-text fallback's autocomplete).
    function _centroid(elem) {
        const latlngs = _buildingLatLngs(elem);
        if (!latlngs || !latlngs.length) return null;
        let latSum = 0, lngSum = 0;
        for (const [la, ln] of latlngs) { latSum += la; lngSum += ln; }
        return [latSum / latlngs.length, lngSum / latlngs.length];
    }

    async function preCacheNearest(lat, lng, count = 10) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
        let elems;
        try {
            elems = await _fetchBuildings(lat, lng);
        } catch (_) {
            elems = null;
        }
        if (!Array.isArray(elems)) return [];
        // Compute centroid + distance, filter to those with usable geometry.
        const scored = [];
        for (const el of elems) {
            const c = _centroid(el);
            if (!c) continue;
            // Equirectangular approximation is fine for the 200 m radius.
            const dLat = (c[0] - lat) * 111_320;
            const dLng = (c[1] - lng) * 111_320 * Math.cos(lat * Math.PI / 180);
            const d = Math.hypot(dLat, dLng);
            scored.push({ el, d, centroid: c });
        }
        scored.sort((a, b) => a.d - b.d);
        const slice = scored.slice(0, count);
        // Reduce to the shape the free-text fallback wants — id + name
        // (see _commitSelection for the name-resolution rules).
        return slice.map(({ el, d, centroid }) => {
            const tags = el.tags || {};
            const osmType = el.type || 'way';
            const name =
                tags.name || tags['name:en'] ||
                (tags.amenity ? `${tags.amenity}`.replace(/_/g, ' ') : null) ||
                (tags.building && tags.building !== 'yes' ? `${tags.building}`.replace(/_/g, ' ') : null) ||
                null;
            return {
                id: `osm:${osmType}:${el.id}`,
                name,
                distance_m: Math.round(d),
                centroid,
                tags,
            };
        });
    }

    // `ensureLeaflet` is now part of the public
    // surface so My Reports' map-view + the report-detail mini-map can
    // eager-load Leaflet on first interaction. Before this, both
    // features silently no-op'd whenever the user hadn't already entered
    // the capture flow's building picker.
    window.BuildingSelect = { ensureMap, getSelection, preCacheNearest, ensureLeaflet: _ensureLeaflet };
})();
