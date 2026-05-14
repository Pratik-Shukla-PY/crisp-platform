/* eslint-disable */
/**
 * "Verified Reports Nearby" — home-stage intelligence module (May 2026).
 *
 * Public surface: window.NearbyIntel.boot()
 *
 * Behaviour matrix (per the operator-approved design plan):
 *
 *   Connectivity  GPS         Cache               Render?
 *   ────────────  ────────    ─────────────────   ──────────────────
 *   online        granted     live API            YES (full list)
 *   online        granted     empty 200           YES (empty state)
 *   online        denied      —                   HIDDEN
 *   online        pending     —                   HIDDEN
 *   offline       granted     fresh < 5 min       OPTIONAL (cached + "Last seen X")
 *   offline       granted     stale > 5 min       HIDDEN
 *   offline       —           none                HIDDEN
 *   any           any         API error           HIDDEN (silent fail)
 *
 * The module NEVER prompts for GPS on the home stage — operator rule
 * "offline-first reporting flow must remain unaffected". We read
 * whatever is already cached in localStorage / IndexedDB from the
 * last v4 capture stage. First-time visitors with no cached GPS see
 * a hidden module; the module appears after their first report.
 *
 * Privacy guarantees on the wire:
 *   ✓ Client rounds lat/lng to 3 decimals (~110 m) before sending
 *   ✓ Endpoint response carries no PII (server-side projection)
 *   ✓ Cached payload is also PII-free (same projection)
 *
 * This file ships as a module under STATIC_ASSETS (see sw.js). Bump
 * CACHE_NAME when the file changes.
 */
(function () {
    'use strict';

    // ── Configuration ──────────────────────────────────────────────────

    const API_BASE = (typeof window !== 'undefined' && window.CRISP_API_BASE)
        || '/api/v1';
    const ENDPOINT = `${API_BASE}/reports/nearby`;

    const DEFAULT_RADIUS_KM = 5;
    const DEFAULT_LIMIT = 20;
    const COLLAPSED_ROWS = 3;             // rows shown before "View N more"
    const CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes
    const STALE_LOCATION_TTL_MS = 30 * 60 * 1000;  // 30 minutes
    const IDB_NAME = 'crisp_nearby_cache_v1';
    const IDB_KEY = 'latest';

    // ── i18n helper — proxies to window.t if present, falls back to en
    function _t(key, fallback) {
        if (typeof window.t === 'function') {
            const v = window.t(key);
            if (v && v !== key) return v;
        }
        return (typeof fallback === 'string') ? fallback : key;
    }

    // ── Location resolution ───────────────────────────────────────────
    //
    // Read whatever is already cached from prior capture stages. We
    // DO NOT call navigator.geolocation — that would prompt the user
    // on the home stage, breaking the operator's offline-first rule.
    function _getCachedLocation() {
        // Try the v4-flow cache first (most recent + most accurate).
        // The capture stage writes to localStorage under multiple
        // keys depending on platform/flow version; check the common
        // ones in priority order.
        const candidates = [
            'crisp_last_location_v2',
            'crisp_last_location',
            'crisp_location_context',
        ];
        for (const k of candidates) {
            try {
                const raw = localStorage.getItem(k);
                if (!raw) continue;
                const obj = JSON.parse(raw);
                // Common shapes: {lat, lng, ts} OR {latitude, longitude, ts}
                const lat = obj.lat ?? obj.latitude;
                const lng = obj.lng ?? obj.longitude;
                const ts = obj.ts ?? obj.timestamp ?? obj.updatedAt ?? 0;
                if (typeof lat !== 'number' || typeof lng !== 'number') continue;
                // Stale-location gate — ignore if older than 30 min.
                if (Date.now() - ts > STALE_LOCATION_TTL_MS) continue;
                return { lat, lng, ts };
            } catch { /* ignore parse errors */ }
        }
        return null;
    }

    // ── 3-decimal rounding — privacy guarantee on the wire
    function _round3(n) {
        return Math.round(n * 1000) / 1000;
    }

    // ── IndexedDB cache wrappers ─────────────────────────────────────
    //
    // Use a single key/value object store so the schema is minimal +
    // the migration story is trivial (bump store name to invalidate).

    function _openIdb() {
        return new Promise((resolve, reject) => {
            try {
                const req = indexedDB.open('crisp-nearby', 1);
                req.onupgradeneeded = () => req.result.createObjectStore('cache');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            } catch (e) { reject(e); }
        });
    }

    async function _idbGet() {
        try {
            const db = await _openIdb();
            return await new Promise((resolve) => {
                const tx = db.transaction('cache', 'readonly');
                const req = tx.objectStore('cache').get(IDB_KEY);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        } catch { return null; }
    }

    async function _idbSet(value) {
        try {
            const db = await _openIdb();
            await new Promise((resolve) => {
                const tx = db.transaction('cache', 'readwrite');
                tx.objectStore('cache').put(value, IDB_KEY);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        } catch { /* best-effort */ }
    }

    // ── Network helpers ──────────────────────────────────────────────

    function _isOnline() {
        return typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    }

    async function _fetchNearby({ lat, lng, radius_km, limit }) {
        const url = new URL(ENDPOINT, window.location.origin);
        url.searchParams.set('lat', _round3(lat).toString());
        url.searchParams.set('lng', _round3(lng).toString());
        url.searchParams.set('radius_km', String(radius_km));
        url.searchParams.set('limit', String(limit));
        // 6-second hard cap so a slow API doesn't drag down home boot.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        try {
            const res = await fetch(url.toString(), {
                signal: ctrl.signal,
                cache: 'no-store',
            });
            if (!res.ok) return null;
            return await res.json();
        } catch { return null; }
        finally { clearTimeout(timer); }
    }

    // ── Time helpers ──────────────────────────────────────────────────

    function _humanizeAgo(iso) {
        if (!iso) return '';
        const ts = new Date(iso).getTime();
        if (!isFinite(ts)) return '';
        const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
        if (mins < 60) {
            return _t('nearby_minutes_ago', '{n} min ago').replace('{n}', String(mins));
        }
        const hrs = Math.round(mins / 60);
        return _t('nearby_hours_ago', '{n} hr ago').replace('{n}', String(hrs));
    }

    // ── Group → DOM ───────────────────────────────────────────────────
    //
    // Build a single row. All text passes through _t so locale-switch
    // re-renders correctly when home is re-mounted.

    function _esc(s) {
        const div = document.createElement('div');
        div.textContent = String(s == null ? '' : s);
        return div.innerHTML;
    }

    function _summaryLabel(group) {
        // Prefer server-localized key → en fallback → "Report Filed".
        if (group.summary_key) {
            return _t(group.summary_key, group.summary || 'Report Filed');
        }
        return group.summary || _t('nearby_summary_unknown', 'Report Filed');
    }

    function _buildRow(group) {
        const summary = _summaryLabel(group);
        const countText = _t('nearby_count_reports', '{n} reports')
            .replace('{n}', String(group.count));
        const distance = _t('nearby_distance_km', '{km} km')
            .replace('{km}', group.approx_distance_km.toFixed(1));
        const ago = _humanizeAgo(group.latest_at);
        const verifiedLine = (group.verified_count > 0)
            ? ` · <span class="nearby-row-verified">✓ ${_esc(_t('nearby_verified_badge', 'verified'))}</span>`
            : '';
        const pendingLine = (group.pending_count > 0 && group.verified_count === 0)
            ? ` · <span class="nearby-row-pending">⏳ ${_esc(_t('nearby_pending_badge', 'pending'))}</span>`
            : '';

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'home-nearby-row';
        row.setAttribute('data-group-id', group.id);
        row.setAttribute('aria-label', `${countText}, ${summary}, ${group.label}, ${distance}`);
        row.innerHTML = `
            <span class="home-nearby-row-dot" aria-hidden="true"></span>
            <span class="home-nearby-row-body">
                <span class="home-nearby-row-head">
                    <span class="home-nearby-row-count">${_esc(countText)}</span>
                    <span class="home-nearby-row-sep" aria-hidden="true">·</span>
                    <span class="home-nearby-row-summary">${_esc(summary)}</span>
                </span>
                <span class="home-nearby-row-label">${_esc(group.label)}</span>
                <span class="home-nearby-row-meta">
                    ${_esc(distance)} · ${_esc(ago)}${verifiedLine}${pendingLine}
                </span>
            </span>
        `;
        // Detail-sheet click is wired in Phase 2; for Phase 1 the row
        // is keyboard-focusable but a click is a no-op (or could
        // navigate to the report stage with pre-fill).
        row.addEventListener('click', () => {
            try {
                window.dispatchEvent(new CustomEvent('crisp:nearby-row-click', {
                    detail: { groupId: group.id, group },
                }));
            } catch { /* ignore */ }
        });
        return row;
    }

    function _buildEmptyState() {
        const el = document.createElement('div');
        el.className = 'home-nearby-empty';
        el.innerHTML = `
            <span class="home-nearby-empty-icon" aria-hidden="true">✓</span>
            <span class="home-nearby-empty-title">${_esc(_t('nearby_all_clear', 'All clear in your area'))}</span>
            <span class="home-nearby-empty-body">${_esc(_t('nearby_no_reports', 'No verified reports nearby'))}</span>
        `;
        return el;
    }

    // ── Rendering ────────────────────────────────────────────────────

    function _renderInto(container, payload, opts) {
        // Clear previous rows
        container.innerHTML = '';

        const list = document.createElement('div');
        list.className = 'home-nearby-list';
        list.id = 'home-nearby-list';

        if (!payload || !payload.groups || payload.groups.length === 0) {
            list.appendChild(_buildEmptyState());
            container.appendChild(list);
            return;
        }

        const groups = payload.groups;
        const collapsed = (opts && opts.expanded) ? groups : groups.slice(0, COLLAPSED_ROWS);
        for (const g of collapsed) {
            list.appendChild(_buildRow(g));
        }

        if (groups.length > COLLAPSED_ROWS && (!opts || !opts.expanded)) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'home-nearby-view-more';
            more.id = 'home-nearby-view-more';
            more.textContent = _t('nearby_view_more', 'View {n} more')
                .replace('{n}', String(groups.length - COLLAPSED_ROWS));
            more.addEventListener('click', () => {
                // Inline lazy-expand — no extra fetch needed, the
                // server already returned the full top-N. Phase 2 may
                // page beyond N.
                _renderInto(container, payload, { expanded: true });
            });
            list.appendChild(more);
        }

        // Optional "Last seen X min ago" footer when rendering from
        // stale cache (offline + cache fresh path).
        if (opts && opts.fromCache && opts.cacheAgeMs != null) {
            const mins = Math.max(0, Math.round(opts.cacheAgeMs / 60000));
            const cap = document.createElement('div');
            cap.className = 'home-nearby-caption';
            cap.textContent = _t('nearby_last_seen', 'Last seen {n} min ago')
                .replace('{n}', String(mins));
            list.appendChild(cap);
        }

        container.appendChild(list);
    }

    // ── Boot ─────────────────────────────────────────────────────────

    async function boot(rootSelector) {
        const root = document.querySelector(rootSelector || '#home-nearby-intel');
        if (!root) return;

        // Always start HIDDEN. We unhide only when we have data to show.
        root.hidden = true;

        const location = _getCachedLocation();
        if (!location) {
            // No usable location → stay hidden. The module will
            // appear on the NEXT home visit, after the user has
            // completed a v4 capture stage (which caches GPS).
            return;
        }

        // Try live fetch first (when online); fall back to cache.
        let payload = null;
        let fromCache = false;
        let cacheAgeMs = null;

        if (_isOnline()) {
            payload = await _fetchNearby({
                lat: location.lat, lng: location.lng,
                radius_km: DEFAULT_RADIUS_KM, limit: DEFAULT_LIMIT,
            });
            if (payload) {
                _idbSet({ payload, fetchedAt: Date.now() });
            }
        }
        if (!payload) {
            const cached = await _idbGet();
            if (cached && cached.payload && cached.fetchedAt) {
                const age = Date.now() - cached.fetchedAt;
                if (age <= CACHE_TTL_MS) {
                    payload = cached.payload;
                    fromCache = true;
                    cacheAgeMs = age;
                }
            }
        }

        // Hard rule per operator: if we don't have CURRENT data, hide.
        // No broken states, no "loading" forever, no error placeholders.
        if (!payload) {
            return;
        }

        _renderInto(root, payload, { fromCache, cacheAgeMs });
        root.hidden = false;
    }

    // ── Public API ───────────────────────────────────────────────────

    window.NearbyIntel = {
        boot,
        // Exposed for unit-test injection if needed.
        _round3,
        _humanizeAgo,
    };
})();
