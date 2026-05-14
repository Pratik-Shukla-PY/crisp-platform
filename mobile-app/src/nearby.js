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
    //
    // Resolve the backend base URL. Local dev runs the PWA on :8080 and
    // the backend on :8000, so a relative `/api/v1` would 404. PROD
    // serves both behind one origin via nginx, so relative is correct
    // there. Mirror app.js's resolution: prefer window.API_BASE (set
    // by app.js after boot), else host-based fallback.

    function _resolveBase() {
        if (typeof window !== 'undefined') {
            if (window.API_BASE)        return window.API_BASE;
            if (window.CRISP_API_BASE)  return window.CRISP_API_BASE;
            try {
                const host = (window.location.hostname || '').toLowerCase();
                const isLocalDev = ['localhost', '127.0.0.1', '0.0.0.0'].includes(host);
                if (isLocalDev) {
                    return `${window.location.protocol}//${host}:8000/api/v1`;
                }
                return `${window.location.origin}/api/v1`;
            } catch { /* fall through */ }
        }
        return '/api/v1';
    }

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
        // Resolve base at call time, not module-load time — gives
        // app.js a chance to set window.API_BASE before we reach for it.
        const base = _resolveBase();
        const endpoint = `${base}/reports/nearby`;
        // URL() with absolute base needs a string base; with relative
        // base needs a window.location.origin base. Handle both.
        const url = (() => {
            try { return new URL(endpoint); }
            catch { return new URL(endpoint, window.location.origin); }
        })();
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
            if (!res.ok) {
                console.warn('[NearbyIntel] fetch failed:', res.status, url.toString());
                return null;
            }
            return await res.json();
        } catch (e) {
            console.warn('[NearbyIntel] fetch error:', e && e.message, url.toString());
            return null;
        }
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
        // Detail-sheet click + Material-style ripple feedback.
        // v7 (May 2026, operator) — "circular ripples on click."
        // The ripple element is a CSS-keyframed circle positioned at
        // the click coordinates inside the row. Falls back to a no-op
        // under prefers-reduced-motion (CSS handles that gate).
        row.addEventListener('click', (e) => {
            try {
                const rect = row.getBoundingClientRect();
                const size = Math.max(rect.width, rect.height) * 1.1;
                const x = (e.clientX || rect.left + rect.width / 2) - rect.left - size / 2;
                const y = (e.clientY || rect.top + rect.height / 2) - rect.top - size / 2;
                const ripple = document.createElement('span');
                ripple.className = 'home-nearby-ripple';
                ripple.style.width = `${size}px`;
                ripple.style.height = `${size}px`;
                ripple.style.left = `${x}px`;
                ripple.style.top = `${y}px`;
                row.appendChild(ripple);
                setTimeout(() => { try { ripple.remove(); } catch (_) {} }, 650);
            } catch (_) { /* never block the sheet on ripple errors */ }
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
        if (!root) {
            console.warn('[NearbyIntel] root element not found:', rootSelector);
            return;
        }

        // Always start HIDDEN. We unhide only when we have data to show.
        root.hidden = true;

        const location = _getCachedLocation();
        if (!location) {
            console.log('[NearbyIntel] no cached GPS in localStorage — module stays hidden. ' +
                'Run: localStorage.setItem("crisp_last_location_v2", JSON.stringify({lat:12.8456,lng:77.6603,ts:Date.now()}));location.reload();');
            return;
        }
        console.log('[NearbyIntel] boot with cached GPS:', location);

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

    // ── Detail sheet (Phase 2) ───────────────────────────────────────
    //
    // Listens for `crisp:nearby-row-click` (dispatched in `_buildRow`)
    // and renders a bottom-sheet modal with the group's full detail.
    // Dismiss handlers: backdrop tap, Escape key, ✕ button.
    //
    // PRIVACY: the event detail carries the SAME projection the API
    // returned — no extra fetch, no PII. The sheet just re-presents
    // it.

    const _SEVERITY_FILL = {
        CRITICAL: 100, HIGH: 78, MODERATE: 56, MEDIUM: 56,
        LOW: 34, MINOR: 34, UNKNOWN: 12,
    };

    function _formatSheetTimestamp(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            return d.toLocaleString(undefined, {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit',
            });
        } catch { return iso; }
    }

    function _closeSheet() {
        const sheet = document.getElementById('nearby-sheet');
        if (!sheet) return;
        sheet.classList.remove('is-open');
        // 240 ms slide-out, then hide
        setTimeout(() => { sheet.hidden = true; }, 240);
        document.body.style.overflow = '';
    }

    function _openDetailSheet(group) {
        const sheet = document.getElementById('nearby-sheet');
        if (!sheet || !group) return;

        // Build the title + distance + tiles
        const titleEl = sheet.querySelector('#nearby-sheet-label');
        if (titleEl) titleEl.textContent = group.label || '';
        const distEl = sheet.querySelector('#nearby-sheet-distance');
        if (distEl) {
            const kmTxt = _t('nearby_distance_km', '{km} km')
                .replace('{km}', (group.approx_distance_km ?? 0).toFixed(1));
            distEl.textContent = _t('nearby_sheet_distance_from_you', '{km} from you')
                .replace('{km}', kmTxt);
        }
        const countEl = sheet.querySelector('#nearby-sheet-count');
        if (countEl) countEl.textContent = String(group.count ?? 0);
        const vEl = sheet.querySelector('#nearby-sheet-verified');
        if (vEl) vEl.textContent = String(group.verified_count ?? 0);

        const latestEl = sheet.querySelector('#nearby-sheet-latest');
        if (latestEl) latestEl.textContent = _formatSheetTimestamp(group.latest_at);
        const earliestEl = sheet.querySelector('#nearby-sheet-earliest');
        if (earliestEl) earliestEl.textContent = _formatSheetTimestamp(group.earliest_at);

        // Incident types breakdown — top crisis_types with counts
        // from damage_classes. The endpoint returns these as arrays
        // sorted by frequency; we don't have per-type counts here,
        // so render as a small list of "Crisis × Damage" combos.
        const typesEl = sheet.querySelector('#nearby-sheet-types');
        if (typesEl) {
            typesEl.innerHTML = '';
            const crisisList = group.crisis_types || [];
            const damageList = group.damage_classes || [];
            const total = group.count || 0;
            // Use crisis_types as the primary key — show each as a row.
            if (crisisList.length === 0) {
                const li = document.createElement('li');
                li.className = 'nearby-sheet-type-row';
                li.textContent = _t('nearby_summary_unknown', 'Report Filed');
                typesEl.appendChild(li);
            } else {
                crisisList.forEach((crisis, i) => {
                    const dmg = damageList[i] || damageList[0] || 'PARTIAL';
                    const key = `nearby_summary_${_summaryKeyFor(crisis, dmg)}`;
                    const label = _t(key, group.summary || 'Report Filed');
                    const li = document.createElement('li');
                    li.className = 'nearby-sheet-type-row';
                    // count approx proportional to position; we don't
                    // have precise per-type counts so show total only
                    // on the first row to avoid lying.
                    const countStr = (i === 0) ? ` <span class="nearby-sheet-type-count">${total}</span>` : '';
                    li.innerHTML = `<span class="nearby-sheet-type-label">${_esc(label)}</span>${countStr}`;
                    typesEl.appendChild(li);
                });
            }
        }

        // Severity bar
        const fillEl = sheet.querySelector('#nearby-sheet-severity-fill');
        const labelEl = sheet.querySelector('#nearby-sheet-severity-label');
        const sev = group.severity_max || 'UNKNOWN';
        if (fillEl) fillEl.style.width = `${_SEVERITY_FILL[sev] || 12}%`;
        if (labelEl) labelEl.textContent = sev;

        // Soft pre-fill for "Add Your Report Here" — operator-approved
        // option #7: pre-fill only building_id + lat/lng. Store in
        // localStorage; v4-flow.js reads + clears on stage-v4-capture
        // entry. (v4-flow.js wiring lands in a separate commit; for
        // this phase the prefill is set + the user navigates manually.)
        const ctaEl = sheet.querySelector('#nearby-sheet-cta');
        if (ctaEl) {
            ctaEl.onclick = () => {
                try {
                    const prefill = {
                        building_id: group.id && group.id.startsWith('g_building_')
                            ? group.id.slice('g_building_'.length)
                            : null,
                        lat: group.centroid_lat,
                        lng: group.centroid_lng,
                        ts: Date.now(),
                    };
                    localStorage.setItem('crisp_nearby_prefill', JSON.stringify(prefill));
                } catch { /* ignore */ }
                _closeSheet();
                try {
                    // Use the existing primary CTA so the consent
                    // gate still fires + the same handler runs.
                    const start = document.getElementById('btn-start');
                    if (start && typeof start.click === 'function') start.click();
                } catch { /* ignore */ }
            };
        }

        // Apply i18n on any data-i18n attribute inside the sheet so
        // a locale switch since boot is reflected.
        try { if (typeof window.applyI18n === 'function') window.applyI18n(); } catch (_) {}

        sheet.hidden = false;
        // Force a reflow so the slide-up animation fires reliably
        // (browsers batch class additions otherwise).
        void sheet.offsetWidth;
        sheet.classList.add('is-open');
        document.body.style.overflow = 'hidden';

        // Focus management — move keyboard focus to the close button
        // so Escape works + screen reader announces the modal.
        const close = sheet.querySelector('#nearby-sheet-close');
        if (close && typeof close.focus === 'function') {
            try { close.focus(); } catch (_) {}
        }
    }

    /** Lookup helper — maps backend CrisisType + DamageClass to the
     *  i18n key suffix we use in `_SUMMARY_MATRIX` server-side. */
    function _summaryKeyFor(crisis, damage) {
        const cmap = {
            FLOOD: 'flood', EARTHQUAKE: 'quake', WILDFIRE: 'fire',
            EXPLOSION: 'blast', CONFLICT: 'unrest', CIVIL_UNREST: 'unrest',
        };
        const dmap = {
            MINIMAL: 'minimal', PARTIAL: 'partial', COMPLETE: 'complete',
        };
        const c = cmap[(crisis || '').toUpperCase()] || 'generic';
        const d = dmap[(damage || '').toUpperCase()] || 'partial';
        return `${c}_${d}`;
    }

    // Wire dismissal once on script load.
    document.addEventListener('DOMContentLoaded', () => {
        const sheet = document.getElementById('nearby-sheet');
        if (!sheet) return;
        const close = sheet.querySelector('#nearby-sheet-close');
        const backdrop = sheet.querySelector('#nearby-sheet-backdrop');
        if (close) close.addEventListener('click', _closeSheet);
        if (backdrop) backdrop.addEventListener('click', _closeSheet);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !sheet.hidden) _closeSheet();
        });
    });

    // Listen for the tap event from `_buildRow`.
    window.addEventListener('crisp:nearby-row-click', (e) => {
        try { _openDetailSheet(e && e.detail && e.detail.group); }
        catch (err) { /* never crash the home page from sheet errors */ }
    });

    // ── Public API ───────────────────────────────────────────────────

    window.NearbyIntel = {
        boot,
        openDetailSheet: _openDetailSheet,
        closeDetailSheet: _closeSheet,
        // Exposed for unit-test injection if needed.
        _round3,
        _humanizeAgo,
    };
})();
