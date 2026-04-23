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
            // Apr 2026 UI v2.1 — show the OSM name inside the pill so
            // the reporter gets immediate confirmation of WHAT they
            // just picked, not just "Building selected" generically.
            const nameSlot = pill.querySelector('.building-selected-name');
            if (nameSlot) nameSlot.textContent = osmName || `#${element.id}`;
        }
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
    }

    /** Public entry point — init the map (idempotent). Callers pass the
     * current lat/lng so we don't depend on any particular state shape. */
    async function ensureMap(lat, lng) {
        const container = document.getElementById('building-map');
        if (!container || typeof L === 'undefined') return;
        if (!(Number.isFinite(lat) && Number.isFinite(lng))) return;
        if (_map || _initInFlight) {
            // Already initialised — just recenter if the GPS moved noticeably.
            if (_map) _map.setView([lat, lng], _map.getZoom());
            return;
        }
        _initInFlight = true;

        try {
            // P5 scroll-lock fix (Apr 2026): explicit wheel/touch/dragging
            // flags so the outer PWA page scroll reaches past the map
            // instead of being swallowed by Leaflet's default `passive:
            // false` wheel handler. Mouse-wheel zoom is disabled on the
            // field app (buttons + pinch only); keyboard panning is off
            // because the map lives inside a scroll container where
            // arrow keys would fight. touchZoom + dragging stay on so
            // users can still interact; `tap` stays on for mobile hit
            // detection on building polygons.
            _map = L.map(container, {
                zoomControl: true,
                attributionControl: false,
                scrollWheelZoom: false,
                touchZoom: true,
                dragging: true,
                tap: true,
                keyboard: false,
            }).setView([lat, lng], 18);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap',
            }).addTo(_map);

            // Report-location marker so the user always sees their pin.
            L.marker([lat, lng], { zIndexOffset: 1000 }).addTo(_map);

            _overlay = L.layerGroup().addTo(_map);
            const elems = await _fetchBuildings(lat, lng);
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
            } else {
                console.log('[BuildingSelect] no building data — map-only fallback');
            }
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
    function _tryInitMap() {
        const box = document.getElementById('building-select-box');
        if (!box) return;
        const loc = window.state && window.state.location;
        if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
            console.log('[BuildingSelect] waiting for GPS');
            return;
        }
        const placeholder = document.getElementById('building-map-placeholder');
        if (placeholder) placeholder.style.display = 'none';
        ensureMap(loc.lat, loc.lng).catch((e) => {
            console.warn('[BuildingSelect] init failed:', e);
            // Restore placeholder so the user sees something explain-able.
            if (placeholder) placeholder.style.display = '';
        });
    }

    // Apr 2026 UI v2.1 — wire up the flat <section>. The box is always
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
            // Phase B4 (Apr 2026 UI v3) — the building-select box now lives
            // inside stage-crisis (moved there by migrateV3Blocks in app.js).
            // Init the map the moment the reporter lands there so the
            // Leaflet overlay is ready WHILE they're picking a crisis type.
            if (e.detail === 'stage-crisis') {
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

    // ── Phase B2 (Apr 2026 UI v3) — building pre-cache ────────────────────
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

    window.BuildingSelect = { ensureMap, getSelection, preCacheNearest };
})();
