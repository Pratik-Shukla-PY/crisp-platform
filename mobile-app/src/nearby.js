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

    // Phase 3 (May 2026, docs §5.2-5.3) — per-tier TTL replaces the
    // single CACHE_TTL_MS. Online TTL = "how long the cache stays
    // authoritative before we re-fetch". Offline TTL = "how long
    // we still RENDER the cache when network is gone". Weak-tier
    // values are shorter because single-witness signals decay
    // fastest in informational value.
    const ONLINE_CACHE_TTL = {
        verified:  5 * 60 * 1000,        // 5 min
        emerging:  3 * 60 * 1000,        // 3 min
        weak:      2 * 60 * 1000,        // 2 min
        disaster:  1 * 60 * 1000,        // 1 min
    };
    const OFFLINE_CACHE_TTL = {
        verified: 24 * 60 * 60 * 1000,   // 24 h
        emerging:  6 * 60 * 60 * 1000,   //  6 h
        weak:     30 * 60 * 1000,        // 30 min (hide after)
        disaster:  1 * 60 * 60 * 1000,   //  1 h
    };
    // Legacy single value — kept for code paths that don't yet
    // discriminate by tier. Defaults to the verified tier's online
    // TTL.
    const CACHE_TTL_MS = ONLINE_CACHE_TTL.verified;
    const STALE_LOCATION_TTL_MS = 30 * 60 * 1000;  // 30 minutes

    // IDB schema bumped to v2 for Phase 3 — the payload now carries
    // additional fields (recently_resolved_groups, tier, is_burst,
    // is_acute, acute_grade, crisis_ttl_hours, etc.). Versioned
    // store name forces old caches to evict on next activate.
    const IDB_NAME = 'crisp_nearby_cache_v2';
    const IDB_KEY = 'latest';
    // Legacy IDB store from v1 (Phase 0). Pruned on first v2 read
    // so localStorage / IDB doesn't accumulate dead schemas.
    const IDB_LEGACY_NAMES = ['crisp_nearby_cache_v1'];

    /** Highest-tier hint for the whole payload — drives which
     *  ONLINE_CACHE_TTL / OFFLINE_CACHE_TTL value applies. */
    function _payloadDominantTier(payload) {
        const groups = (payload && payload.groups) || [];
        if (!groups.length) return 'weak';
        let best = 'weak';
        let bestRank = 1;
        const rank = { weak: 1, emerging: 2, verified: 3 };
        for (const g of groups) {
            const r = rank[g.tier] || 0;
            if (r > bestRank) { bestRank = r; best = g.tier; }
        }
        return best;
    }

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
        // May 21, 2026 — architectural audit Item 2. Resolve the
        // caller's own device_hash from localStorage so we can send it
        // as the `X-Caller-Device-Hash` HEADER (not a query param —
        // headers don't leak into uvicorn's request-line access logs).
        // Backend uses the hash to exclude the caller's own reports
        // from the community-awareness feed. Privacy posture: hash
        // computes a device_id lookup + per-caller cache row, then
        // dropped. NEVER logged. See backend get_nearby_reports.
        let _callerHash = null;
        try {
            _callerHash = (typeof localStorage !== 'undefined')
                ? (localStorage.getItem('crisp_device_id_v2')
                   || localStorage.getItem('crisp_device_hash')
                   || localStorage.getItem('crisp_device_id'))
                : null;
        } catch (_) { /* private-mode localStorage throws — skip silently */ }
        // 6-second hard cap so a slow API doesn't drag down home boot.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        try {
            const _headers = { 'Accept': 'application/json' };
            if (_callerHash) _headers['X-Caller-Device-Hash'] = _callerHash;
            const res = await fetch(url.toString(), {
                signal: ctrl.signal,
                cache: 'no-store',
                headers: _headers,
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
            // Phase 3 (May 2026 — docs §4.4) — write the prefill
            // envelope BEFORE dispatching, so any consumer that
            // wants to route to /stage-v4-capture finds the state
            // already in sessionStorage.
            _writePrefillFromGroup(group);
            try {
                window.dispatchEvent(new CustomEvent('crisp:nearby-row-click', {
                    detail: { groupId: group.id, group },
                }));
            } catch { /* ignore */ }
        });
        return row;
    }

    function _buildEmptyState() {
        // May 2026 (operator preference, post-iPhone-14 audit) — was
        // a two-line layout with a ✓ icon + "All clear in your area"
        // title. The ✓ implied "success" which felt wrong when no
        // backend was available — the user reads "✓ All clear" and
        // assumes the system says their area is safe when actually
        // it just couldn't reach the service. New empty state is a
        // single plain line that's honest about its scope:
        // "No nearby reports" — no checkmark, no editorialising.
        // AUDIT 2026-05-23 — softened copy from operational "No nearby
        // reports" to reassuring "You're the first eyes on the ground
        // here." Same i18n key (`nearby_no_reports`); the EN value is
        // updated in en.json + propagated via the home-i18n gen-script.
        const el = document.createElement('div');
        el.className = 'home-nearby-empty';
        el.innerHTML = `
            <span class="home-nearby-empty-body">${_esc(_t('nearby_no_reports', "You're the first eyes on the ground here."))}</span>
        `;
        return el;
    }

    // ── Aggregate number block (v8 — May 2026 redesign) ──────────────
    //
    // Operator: "a single number with ripple effect thing first like
    // we had earlier and on click show in the banner sliding from
    // bottom what report and on further click the other actions
    // would happen."
    //
    // Front-of-home state is now a single AGGREGATE NUMBER (sum of
    // counts across all groups in the response) with pulse halos.
    // Tap → bottom-sheet slides up with the grouped rows. Tap a row
    // in that sheet → existing detail sheet for the group + actions.

    /**
     * Phase 3 (May 2026, docs §4.4) — smart reporting prefill flow.
     * When the user taps a nearby group, hand the v4-flow.js capture
     * stage a `crisp_prefill_v1` envelope (sessionStorage) with the
     * cluster's building / location / crisis context. The capture
     * stage consumes it once and clears it; the user only needs to
     * add photo / audio / text + (optionally) override the suggested
     * severity. Cuts cognitive load in humanitarian emergencies.
     *
     * Privacy: prefilled coords are the GROUP CENTROID (not any
     * individual reporter's coords); building_id is a public OSM
     * reference. No PII leakage — see docs §10.
     */
    function _writePrefillFromGroup(group) {
        if (!group) return;
        try {
            const payload = {
                v: 1,
                building_id: group.kind === 'building' ? group.id.replace(/^g_building_/, '') : null,
                centroid_lat: group.centroid_lat,
                centroid_lng: group.centroid_lng,
                // T1 weak: crisis_types is the coarse category; T2/T3
                // expose the full enum. Surface whatever the server gave.
                crisis_type: (group.crisis_types && group.crisis_types[0]) || null,
                // "Suggested" severity — visually marked in capture as
                // 'tap to change'; never silently overwrites the user's
                // own assessment.
                suggested_severity: group.severity_max || null,
                from_group_id: group.id,
                ts: Date.now(),
            };
            sessionStorage.setItem('crisp_prefill_v1', JSON.stringify(payload));
        } catch (e) {
            console.warn('[NearbyIntel] prefill write failed:', e);
        }
    }

    // ── Tier helpers (Phase 1, May 2026 — docs §3.2 + §4.1) ──────────
    // Three tiers: 'weak' (single-witness, < 30min), 'emerging' (2+
    // devices OR stale single), 'verified' (3+ devices). Highest
    // tier present in the response drives the block's visual.
    const _TIER_RANK = { weak: 1, emerging: 2, verified: 3 };
    function _highestTier(groups) {
        let best = null;
        let bestRank = 0;
        for (const g of groups) {
            const r = _TIER_RANK[g.tier] || 0;
            if (r > bestRank) { bestRank = r; best = g.tier; }
        }
        return best;   // null when groups list is empty
    }

    function _buildNumberBlock(payload) {
        const groups = (payload && payload.groups) || [];
        const totalReports = groups.reduce((sum, g) => sum + (g.count || 0), 0);
        const totalGroups = groups.length;
        // Phase 1 — tier-driven visual treatment
        const dominantTier = _highestTier(groups) || 'weak';
        const isAcute = groups.some((g) => g.is_acute);

        const block = document.createElement('button');
        block.type = 'button';
        block.className = 'home-nearby-number-block is-tier-' + dominantTier
            + (isAcute ? ' is-acute' : '');
        block.id = 'home-nearby-number-block';

        // Per-tier ARIA label so screen readers read the confidence
        // calibration alongside the count.
        const tierLabelKey =
            dominantTier === 'verified' ? 'nearby_tier_verified_label' :
            dominantTier === 'emerging' ? 'nearby_tier_emerging_label' :
                                          'nearby_tier_weak_label';
        const tierLabel = _t(tierLabelKey,
            dominantTier === 'verified' ? 'Verified Nearby Incident' :
            dominantTier === 'emerging' ? 'Emerging Reports' :
                                          'Weak Signal');
        block.setAttribute(
            'aria-label',
            tierLabel + ' — '
            + _t('nearby_count_reports', '{n} reports').replace('{n}', String(totalReports))
        );

        const subLabelText = _t('nearby_reports_nearby_label', 'reports nearby');

        block.innerHTML = `
            <span class="home-nearby-pulse-halo" aria-hidden="true"></span>
            <span class="home-nearby-pulse-halo is-secondary" aria-hidden="true"></span>
            <span class="home-nearby-number" id="home-nearby-number">${_esc(String(totalReports))}</span>
            <span class="home-nearby-number-sub">${_esc(subLabelText)}</span>
            <span class="home-nearby-number-groups">${_esc(_pluralizeGroups(totalGroups))}</span>
            <span class="home-nearby-tier-pill home-nearby-tier-pill--${dominantTier}"
                  aria-hidden="true">${_esc(tierLabel)}</span>
        `;

        block.addEventListener('click', (e) => {
            // Ripple at click coords (or block center if keyboard).
            try {
                const rect = block.getBoundingClientRect();
                const size = Math.max(rect.width, rect.height) * 1.2;
                const x = (e.clientX || rect.left + rect.width / 2) - rect.left - size / 2;
                const y = (e.clientY || rect.top + rect.height / 2) - rect.top - size / 2;
                const ripple = document.createElement('span');
                ripple.className = 'home-nearby-ripple';
                ripple.style.width = `${size}px`;
                ripple.style.height = `${size}px`;
                ripple.style.left = `${x}px`;
                ripple.style.top = `${y}px`;
                block.appendChild(ripple);
                setTimeout(() => { try { ripple.remove(); } catch (_) {} }, 650);
            } catch (_) {}

            // Open the list bottom-sheet.
            try {
                window.dispatchEvent(new CustomEvent('crisp:nearby-open-list', {
                    detail: { payload },
                }));
            } catch (_) {}
        });

        return block;
    }

    function _pluralizeGroups(n) {
        if (n <= 0) return '';
        if (n === 1) return _t('nearby_one_area', '1 area');
        return _t('nearby_n_areas', '{n} areas').replace('{n}', String(n));
    }

    // ── Rendering ────────────────────────────────────────────────────

    /**
     * Phase 1 (May 2026 — docs §3.6, §4.1) — render the
     * "Recently Resolved: N" subtotal line ALWAYS-SEPARATE from
     * the active count. Returns an element or null when nothing to
     * render.
     */
    function _buildResolvedSubtotal(payload) {
        const resolved = (payload && payload.recently_resolved_groups) || [];
        if (!resolved.length) return null;
        const totalResolved = resolved.reduce(
            (sum, g) => sum + (g.resolved_count || g.count || 0),
            0
        );
        const el = document.createElement('div');
        el.className = 'home-nearby-resolved-subtotal';
        el.innerHTML = `
            <span class="home-nearby-resolved-label">${_esc(_t('nearby_recently_resolved_label', 'Recently Resolved'))}</span>
            <span class="home-nearby-resolved-count">${_esc(String(totalResolved))}</span>
            <span class="home-nearby-resolved-sub">${_esc(_t('nearby_recently_resolved_sub', '{n} resolved in the last 24 hours').replace('{n}', String(totalResolved)))}</span>
        `;
        return el;
    }

    // Module-scope cache of the last successful render so we can
    // re-paint when the user changes language (no re-fetch needed —
    // strings are derived from the payload + i18n dict). Updated on
    // every `_renderInto` call; cleared when the module is hidden.
    let _lastRenderContainer = null;
    let _lastRenderPayload   = null;
    let _lastRenderOpts      = null;
    // Bottom-sheet re-render — track which group is currently shown.
    let _openSheetGroup = null;

    function _renderInto(container, payload, opts) {
        // Stash for the `crisp:lang-changed` re-render path below. We
        // need the payload itself (groups + counts) plus the opts
        // (fromCache, cacheAgeMs) the renderer uses to compose the
        // "Last seen X min ago" caption.
        _lastRenderContainer = container;
        _lastRenderPayload   = payload;
        _lastRenderOpts      = opts;
        // Phase F triage (May 2026) — preserve the static eyebrow `<h2
        // class="home-nearby-eyebrow">` defined in index.html instead
        // of wiping the entire container. The eyebrow is the screen-
        // reader-labelled section header (carries data-i18n="nearby_eyebrow"
        // → "NEARBY REPORTS") and was previously being destroyed every
        // time nearby.js painted rows or the empty state. Reach for
        // children explicitly so the eyebrow stays mounted.
        for (const child of Array.from(container.children)) {
            if (!child.classList?.contains('home-nearby-eyebrow')) {
                container.removeChild(child);
            }
        }

        if (!payload || !payload.groups || payload.groups.length === 0) {
            // May 2026 (operator preference) — append the empty state
            // DIRECTLY to the section, not wrapped in `.home-nearby-list`.
            // That wrapper carries the frosted-glass card treatment
            // intended for grouped data rows; on the empty path the
            // operator wants plain inline text with no tile/box. The
            // empty-state styling itself (italic + bold + light yellow,
            // see styles.css) is applied to `.home-nearby-empty-body`
            // and renders cleanly without any container chrome.
            container.appendChild(_buildEmptyState());
            // Even when there are no ACTIVE groups, the Recently
            // Resolved subtotal may still apply (a cluster resolved
            // in the past 24h — closure feedback).
            const resolvedEl = _buildResolvedSubtotal(payload);
            if (resolvedEl) container.appendChild(resolvedEl);
            return;
        }

        // v8 — single aggregate number block (not per-group rows).
        container.appendChild(_buildNumberBlock(payload));

        // Phase 1 (May 2026 — docs §3.6, §4.1) — separate
        // "Recently Resolved: N" subtotal line below the active block.
        // Operator-stated: never fold into the big number; honest
        // closure feedback.
        const resolvedEl = _buildResolvedSubtotal(payload);
        if (resolvedEl) container.appendChild(resolvedEl);

        // Optional "Last seen X min ago" caption beneath the block
        // when the payload came from the IDB cache (offline path).
        if (opts && opts.fromCache && opts.cacheAgeMs != null) {
            const mins = Math.max(0, Math.round(opts.cacheAgeMs / 60000));
            const cap = document.createElement('div');
            cap.className = 'home-nearby-caption';
            cap.textContent = _t('nearby_last_seen', 'Last seen {n} min ago')
                .replace('{n}', String(mins));
            container.appendChild(cap);
        }

        // Cache the latest payload on window for the list sheet to
        // re-read without re-fetching. Keeps the open-list handler
        // simple + stateless.
        try { window.__crispNearbyLastPayload = payload; } catch (_) {}
    }

    // ── Boot ─────────────────────────────────────────────────────────

    async function boot(rootSelector) {
        const root = document.querySelector(rootSelector || '#home-nearby-intel');
        if (!root) {
            console.warn('[NearbyIntel] root element not found:', rootSelector);
            return;
        }

        // AUDIT 2026-05-23 — section is now always visible (the `hidden`
        // attribute was removed in index.html). The empty state paints
        // immediately on home-stage entry so the user never sees a blank
        // slot, then upgrades to real data once GPS + fetch resolve.
        root.hidden = false;
        // Paint the empty state synchronously so the section has content
        // from frame 0 (no CLS when the upgrade lands).
        _renderInto(root, { groups: [] }, {});

        const location = _getCachedLocation();
        if (!location) {
            // No GPS yet — keep the empty state visible. The
            // `crisp:location-cached` listener at the bottom of this
            // module re-runs boot() when location resolves, which
            // triggers the real fetch + re-render. Until then, the
            // user reads "You're the first eyes on the ground here."
            console.log('[NearbyIntel] no cached GPS — empty state shown; waiting for crisp:location-cached.');
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

        // May 2026 (operator preference, post-iPhone-14 audit) — when we
        // have coords but the fetch failed (offline, no backend, 5xx,
        // CORS), render the empty state and unhide ANYWAY. The earlier
        // "silently hide on fetch failure" rule was confusing the
        // operator on local-dev + flapping-API days: the module
        // mysteriously vanished and they couldn't tell whether the
        // backend was empty or broken. New behaviour:
        //   • Coords + payload with groups   → number + ripple + sheet
        //   • Coords + payload with 0 groups → empty-state message
        //   • Coords + payload null (fail)   → empty-state message
        //   • No coords at all               → stay hidden (no module)
        // The single ambiguity — "empty actually means broken" — is
        // acceptable trade for consistent presence; a brief console
        // warn fires above in `_fetchNearby` so debugging on PROD
        // still has a signal.
        if (!payload) payload = { groups: [] };

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
        _openSheetGroup = null;  // sheet is now closed — drop the lang-re-render anchor
    }

    function _openDetailSheet(group) {
        const sheet = document.getElementById('nearby-sheet');
        if (!sheet || !group) return;
        // Stash the group object so `crisp:lang-changed` can re-render
        // the sheet's strings without needing the user to close + re-open.
        _openSheetGroup = group;

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

    // ── List bottom-sheet (v8 — May 2026) ────────────────────────────
    //
    // Slides up on tap of the aggregate number block. Renders all
    // groups as tappable rows; a row tap dispatches the existing
    // `crisp:nearby-row-click` event so the detail sheet chain still
    // works unchanged. The list sheet closes when the detail opens,
    // and is dismissable via backdrop / ✕ / Escape.

    function _openListSheet(payload) {
        const sheet = document.getElementById('nearby-list-sheet');
        if (!sheet || !payload) return;
        const listEl = sheet.querySelector('#nearby-list-sheet-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        const groups = payload.groups || [];
        if (groups.length === 0) {
            listEl.appendChild(_buildEmptyState());
        } else {
            groups.forEach((g) => listEl.appendChild(_buildRow(g)));
        }
        // Reset title each open (i18n-safe re-render).
        const titleEl = sheet.querySelector('#nearby-list-sheet-title');
        if (titleEl) titleEl.textContent = _t('nearby_eyebrow', 'NEARBY REPORTS');

        sheet.hidden = false;
        void sheet.offsetWidth;
        sheet.classList.add('is-open');
        document.body.style.overflow = 'hidden';
        const close = sheet.querySelector('#nearby-list-sheet-close');
        if (close && typeof close.focus === 'function') {
            try { close.focus(); } catch (_) {}
        }
    }

    function _closeListSheet() {
        const sheet = document.getElementById('nearby-list-sheet');
        if (!sheet) return;
        sheet.classList.remove('is-open');
        setTimeout(() => { sheet.hidden = true; }, 240);
        document.body.style.overflow = '';
    }

    // Wire dismissals on DOM ready.
    document.addEventListener('DOMContentLoaded', () => {
        // Detail sheet (existing — unchanged).
        const detail = document.getElementById('nearby-sheet');
        if (detail) {
            const close = detail.querySelector('#nearby-sheet-close');
            const backdrop = detail.querySelector('#nearby-sheet-backdrop');
            if (close) close.addEventListener('click', _closeSheet);
            if (backdrop) backdrop.addEventListener('click', _closeSheet);
        }

        // List sheet (new).
        const list = document.getElementById('nearby-list-sheet');
        if (list) {
            const close = list.querySelector('#nearby-list-sheet-close');
            const backdrop = list.querySelector('#nearby-list-sheet-backdrop');
            if (close) close.addEventListener('click', _closeListSheet);
            if (backdrop) backdrop.addEventListener('click', _closeListSheet);
        }

        // Single Escape handler covers both sheets — closes whichever
        // is currently open.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (detail && !detail.hidden) _closeSheet();
            else if (list && !list.hidden) _closeListSheet();
        });
    });

    // Tap on the aggregate number block → open list sheet.
    window.addEventListener('crisp:nearby-open-list', (e) => {
        try { _openListSheet(e && e.detail && e.detail.payload); }
        catch (err) { /* swallow */ }
    });

    // Tap on a row inside the list sheet → close list, open detail.
    window.addEventListener('crisp:nearby-row-click', (e) => {
        try {
            // If the list sheet is open, slide it down first so the
            // detail sheet animation has a clean stage.
            const list = document.getElementById('nearby-list-sheet');
            if (list && !list.hidden) _closeListSheet();
            _openDetailSheet(e && e.detail && e.detail.group);
        } catch (err) { /* swallow */ }
    });

    // Re-render on language change. Strings come from the i18n dict via
    // `_t(key)` which IS reactive to `activateLang`, but the strings are
    // baked into `innerHTML` at render time — they don't update unless we
    // re-paint. The home strip uses the cached payload (no re-fetch);
    // the detail sheet re-paints from the stashed group object.
    // Operator-reported (May 2026): installed PWA has no refresh
    // affordance, so users were stuck with stale strings until the SW
    // cycled a fresh shell.
    document.addEventListener('crisp:lang-changed', () => {
        try {
            if (_lastRenderContainer && _lastRenderPayload) {
                _renderInto(_lastRenderContainer, _lastRenderPayload, _lastRenderOpts);
            }
            const sheet = document.getElementById('nearby-sheet');
            if (sheet && !sheet.hidden && _openSheetGroup) {
                _openDetailSheet(_openSheetGroup);
            }
        } catch (err) { console.warn('[NearbyIntel] lang re-render failed:', err); }
    });

    // ── Public API ───────────────────────────────────────────────────

    window.NearbyIntel = {
        boot,
        openDetailSheet: _openDetailSheet,
        closeDetailSheet: _closeSheet,
        openListSheet: _openListSheet,
        closeListSheet: _closeListSheet,
        // Exposed for unit-test injection if needed.
        _round3,
        _humanizeAgo,
    };

    // ── Self-bootstrap (v8.1, May 2026) ──────────────────────────────
    //
    // home-screen.js's init() also tries to call boot() for back-
    // compat, BUT script-tags execute in document order so home-
    // screen.js's bottom-of-file init() (which fires SYNCHRONOUSLY
    // when the script tag is parsed) runs BEFORE nearby.js even
    // starts loading. At that moment `window.NearbyIntel` is
    // undefined and the `if (NearbyIntel && ...)` guard in
    // home-screen.js silently skips — module never boots.
    //
    // Fix: self-bootstrap here. Independent of home-screen.js
    // timing. If both paths fire, _renderInto just paints again
    // with the same payload (idempotent).
    function _autoBoot() {
        try {
            console.log('[NearbyIntel] self-bootstrap');
            boot('#home-nearby-intel');
        } catch (e) {
            console.warn('[NearbyIntel] self-bootstrap failed:', e);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _autoBoot);
    } else {
        // Doc already parsed; defer one tick so any sibling scripts
        // currently being parsed can finish setting up window globals
        // (e.g. window.t / window.API_BASE from app.js).
        setTimeout(_autoBoot, 0);
    }

    // May 2026 (operator-reported) — module was staying hidden on the
    // first home visit because IP-geolocation (in app.js) was still in
    // flight when _autoBoot ran. After app.js's _saveLocCtx writes
    // `crisp_last_location_v2`, it dispatches `crisp:location-cached`.
    // Re-boot on that event so the module appears the moment location
    // is available — no user tap, no permission prompt of our own.
    document.addEventListener('crisp:location-cached', () => {
        console.log('[NearbyIntel] crisp:location-cached received — re-booting.');
        _autoBoot();
    });
})();
