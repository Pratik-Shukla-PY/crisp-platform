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
        if (window.state) {
            window.state.buildingId = composite;
            window.state.buildingOsmElement = {
                type: osmType,
                id: element.id,
                tags: element.tags || {},
            };
        }
        const pill = document.getElementById('building-selected-pill');
        if (pill) pill.style.display = 'flex';
        console.log('[BuildingSelect] selected', composite, element.tags || {});
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
            _map = L.map(container, {
                zoomControl: true,
                attributionControl: false,
                dragging: true,
                tap: true,
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

    // Wire the <details> expand → map init. The element may or may not
    // exist yet when this script loads; we poll via a DOM-ready check.
    function _wire() {
        const box = document.getElementById('building-select-box');
        if (!box) return;
        box.addEventListener('toggle', () => {
            if (!box.open) return;
            const loc = window.state && window.state.location;
            if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
                console.log('[BuildingSelect] no GPS yet — skipping map init');
                return;
            }
            ensureMap(loc.lat, loc.lng).catch((e) =>
                console.warn('[BuildingSelect] init failed:', e)
            );
        });
        const clearBtn = document.getElementById('btn-building-clear');
        if (clearBtn) clearBtn.addEventListener('click', _clearSelection);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _wire);
    } else {
        _wire();
    }

    window.BuildingSelect = { ensureMap, getSelection };
})();
