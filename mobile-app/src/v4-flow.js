// ──────────────────────────────────────────────────────────────────────────
// CRISP - UI v4 capture flow (3-page, ≤10 click target).
//
// Pages:
//   1. stage-v4-capture   - OS-native camera + auto-meta (location/time)
//   2. stage-v4-classify  - 3 questions on one screen (damage chips + infra
//                           carousel + crisis carousel)
//   3. stage-v4-review    - summary + voice/text drawer + UNDP details
//                           (expanded by default for UNDP judges)
//
// Gated behind UI_V4_ENABLED (defaults ON; ?ui=v3 URL or
// localStorage['crisp_ui_v4']='off' falls back to legacy v3 flow).
//
// AI pre-fill (Page 2): RETIRED (May 2026, Phase F operator decision).
//   The classify-suggest endpoint + service have been deleted from
//   backend/. The PWA never had a stable client caller for this
//   endpoint anyway - only this header comment referenced it. Users
//   classify manually via the 3-chip questions; the v4-flow's auto-
//   progress on chip-tap keeps the click count low without AI assist.
//
// State sharing with v3:
//   v4 reads/writes the SAME `window.state` object that v3 uses, so on
//   send we just call the existing `submit()` / queue helpers. Building-
//   footprint selector, voice transcription, GPS auto-detect - all live
//   in app.js and v4 calls them through their existing public surface.
// ──────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    // Wait until app.js exposes its public surface (`window.__crispGoToStage`,
    // `window.state`, `window.submit`, etc.).
    function _ready() {
        return typeof window.__crispGoToStage === 'function' && window.state;
    }

    function _whenReady(cb) {
        if (_ready()) { cb(); return; }
        // 50 ms poll competed for the
        // main thread during initial boot and inflated TBT on pwa-home-v4
        // (~25 ms TBT delta + measurable bootup-time hit). 200 ms is plenty
        // - app.js exposes `__crispGoToStage` within the first ~50-100 ms
        // of DOMContentLoaded; a single extra 200 ms wait worst-case is
        // invisible to the user but reclaims one entire frame budget per
        // tick. Use requestIdleCallback to yield to render work + cap with
        // a hard 8 s deadline so we never loop forever if app.js never
        // exposes its public surface.
        const _deadline = Date.now() + 8000;
        const _tick = () => {
            if (_ready()) { cb(); return; }
            if (Date.now() >= _deadline) return;
            setTimeout(_schedule, 200);
        };
        const _schedule = () => {
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(_tick, { timeout: 250 });
            } else { _tick(); }
        };
        _schedule();
    }

    // ── V4 is the ONLY capture flow (May 2026, operator-mandated) ──────
    //
    // Prior to this commit a `?ui=v3` URL param + `crisp_ui_v4='off'`
    // localStorage escape hatch let users / dev land in the legacy V3
    // capture chain (`stage-photo` → `stage-audio` → `stage-where` →
    // `stage-infra` → `stage-crisis` → `stage-extras` → `stage-review`).
    // The hatch was insurance during the V4 rollout (see the 9-bug fix
    // sweep covered by tests in 30-v4-bug-fixes.spec.ts) and is no
    // longer needed: V4 has been the default for weeks without rollback.
    //
    // The toggle has been deleted so:
    //   1. UNDP judges + first-time users cannot accidentally land in V3
    //      via a stale URL or another browser's localStorage.
    //   2. The repo presents ONE capture flow - easier to audit, easier
    //      to maintain, smaller attack surface, no dead branches in JS.
    //
    // V4 still calls into V3 HELPER FUNCTIONS (state object,
    // `__crispIngestFile`, `openCameraModal`, `__crispSubmitReport`,
    // `enqueueReport`, BuildingSelect listener for stage-v4-review) -
    // those remain in app.js and are deliberately preserved. Only the
    // V3 STAGES (UI) and the toggle code are gone.
    window.__crispUiV4 = true;

    // ── Chip-grid component (replaces v3 carousel) ─────────────────────
    // fix #2: the original carousel showed only 1 chip at
    // a time, wasting 50–70 % of vertical screen on Page 2 with empty
    // space below the second carousel. Field reporters had to swipe 4–7
    // times to reach the right infra/crisis chip. Replaced with a 4×2
    // (infra, 8 options) and 3×3 (crisis, 9 options) icon grid where
    // every chip is tap-target-sized and visible without any scroll.
    // Same data-options shape as before; same v4:select event; same
    // _setValue/_getValue API so the AI pre-fill code path is unchanged.
    function _initChipGrid(container) {
        let options = [];
        try {
            options = JSON.parse(container.getAttribute('data-options') || '[]');
        } catch (e) {
            console.error('[v4] chip-grid data-options parse failed', e);
            return;
        }
        if (!options.length) return;

        container.classList.add('v4-chipgrid');
        container.classList.remove('v4-carousel');

        // a11y - every role="radio" must carry aria-checked
        // (true OR false). Previously only the selected tile had the
        // attribute → axe-core "aria-required-attr" critical failure.
        // M10 - custom Lucide-style SVG icons for the four
        // crisis types FontAwesome handled awkwardly: tsunami (was just
        // a generic up-arrow water), wildfire (was a single flame -
        // visually identical to the explosion icon at small sizes),
        // conflict (a half-shield), chemical (a flask, easily
        // mis-read as "potion"). The new icons use a 24×24 viewBox
        // with 2 px stroke + round caps to match the existing Lucide
        // pack already used in headers / Step-4 cards.
        const _svgIcons = {
            TSUNAMI:           '<path d="M2 17c3 0 4-3 8-3s5 3 9 3"/><path d="M2 21c3 0 4-3 8-3s5 3 9 3"/><path d="M9 14c0-3 1-5 3-7l4 8"/>',
            WILDFIRE:          '<path d="M8 21h8"/><path d="M12 21v-3"/><path d="M9 18a4 4 0 0 1-2-3c0-3 3-4 3-7 0 3 4 3 4 7a4 4 0 0 1-2 3"/><path d="M11 11c-1-1-1-2 0-4 1 2 2 2 2 4"/>',
            CONFLICT:          '<path d="m14 4 6 6-2 2-6-6 2-2Z"/><path d="m4 20 6-6 2 2-6 6-2-2Z"/><path d="m20 14-6-6 2-2 6 6-2 2Z"/><path d="m4 4 6 6-2 2-6-6 2-2Z"/>',
            CHEMICAL_INCIDENT: '<path d="M12 3 2 21h20Z"/><path d="M12 9v4"/><circle cx="12" cy="17" r="0.6"/>',
        };
        const _renderIcon = (o) => {
            if (Object.prototype.hasOwnProperty.call(_svgIcons, o.v)) {
                return `<svg class="v4-tile-icon v4-tile-icon-svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${_svgIcons[o.v]}</svg>`;
            }
            return `<i class="fa-solid ${o.i} v4-tile-icon" aria-hidden="true"></i>`;
        };
        container.innerHTML = `
            <div class="v4-chipgrid-track" role="radiogroup">
                ${options.map((o, i) => `
                    <button class="v4-chipgrid-tile ${i === 0 ? 'is-selected' : ''}"
                            type="button" role="radio"
                            data-value="${o.v}" data-index="${i}"
                            aria-checked="${i === 0 ? 'true' : 'false'}"
                            aria-label="${(o.l || o.v).replace(/"/g, '&quot;')}">
                        ${_renderIcon(o)}
                        <span class="v4-tile-label" data-i18n="${o.k || ''}">${o.l}</span>
                    </button>
                `).join('')}
            </div>
        `;

        const tiles = Array.from(container.querySelectorAll('.v4-chipgrid-tile'));
        let currentIdx = 0;

        const _updateSelected = (idx) => {
            currentIdx = Math.max(0, Math.min(options.length - 1, idx));
            tiles.forEach((t, i) => {
                const sel = i === currentIdx;
                t.classList.toggle('is-selected', sel);
                t.setAttribute('aria-checked', sel ? 'true' : 'false');
            });
            container.dispatchEvent(new CustomEvent('v4:select', {
                detail: { value: options[currentIdx].v, index: currentIdx },
            }));
        };

        tiles.forEach((t, i) => t.addEventListener('click', () => _updateSelected(i)));

        container._setValue = (value) => {
            const idx = options.findIndex((o) => o.v === value);
            if (idx >= 0) _updateSelected(idx);
        };
        container._getValue = () => options[currentIdx]?.v || null;

        return container;
    }
    // Backward-compat alias - anything still calling _initCarousel routes
    // through the new grid. v4-flow's own classify init uses the new name
    // directly below.
    const _initCarousel = _initChipGrid;

    // ── State helpers (write into shared window.state) ──────────────────
    function _setState(patch) {
        Object.assign(window.state, patch);
    }
    function _getState() { return window.state; }

    // Hard cap on photos per report. Matches MAX_PHOTOS_TOTAL in app.js
    // (2 extras + 1 primary = 3 total - operator UX decision May 2026,
    // reduced from 5). Earlier, the `+` button in the v4 thumb strip
    // accepted photos past the cap because v4's _handlePhoto did not
    // check. Now enforced at three gates: _handlePhoto, _renderThumbs
    // (hides the + button at the cap), and the chooser overlay.
    const V4_MAX_PHOTOS = 3;

    /**
     * HC66 (May 2026) - shared photo-delete helper.
     *
     * Factored out of the capture-stage `_renderThumbs` × handler at
     * v4-flow.js:1410 (HC60) so the new HC66 review-stage photo strip
     * can reuse the same state-mutation contract. Preserves the May
     * 2026 bugfix that keeps `state.extraPhotos` in sync with
     * `state.v4Photos` (otherwise `submitReport` queues already-
     * deleted photos for upload). Also preserves the primary-photo
     * promotion when idx === 0 - the next-in-line photo lifts its
     * variants up into the `state.photoBlob` / `.photoDataUrl` /
     * `.photoVariants` slots so `submitReport`'s primary-photo
     * branch finds them.
     *
     * Returns the removed entry (or `null` if idx was out of range)
     * so callers can refresh their own UI without re-reading state.
     */
    function _deleteV4PhotoAt(idx) {
        const state = _getState();
        if (!state || !Array.isArray(state.v4Photos) || idx < 0 ||
            idx >= state.v4Photos.length) {
            return null;
        }
        const removed = state.v4Photos[idx];
        state.v4Photos.splice(idx, 1);

        // Keep state.extraPhotos in sync (HC60 bugfix). submitReport
        // reads from state.extraPhotos to build the upload work list;
        // a stale entry would queue a deleted photo.
        if (removed && state.extraPhotos && state.extraPhotos.length > 0) {
            const extraIdx = state.extraPhotos.findIndex(
                (e) => e && e.dataUrl === removed.url,
            );
            if (extraIdx >= 0) state.extraPhotos.splice(extraIdx, 1);
        }

        // Promote the next photo into the PRIMARY slot when idx 0
        // was the one removed AND another remains. Variants for the
        // promoted entry live in state.extraPhotos (because the
        // asExtra ingest pipeline persisted them there).
        if (idx === 0 && state.v4Photos.length > 0) {
            const newPrimary = state.v4Photos[0];
            // HC74 - ALWAYS update photoDataUrl + photoBlob to the
            // new v4Photos[0], even if extras doesn't have a matching
            // entry. Pre-HC74 this update ONLY happened when extras
            // had a match - but if the deleted photo was the primary
            // and the new primary was added via the review's + Add
            // flow (which writes to extras as `{ dataUrl }` not
            // `{ url }`), the find could miss it. Result: stale
            // photoDataUrl pointing to the just-deleted URL, which
            // HC74's render-time sync then resurrects.
            state.photoDataUrl = newPrimary.url;
            state.photoBlob = newPrimary.blob || null;
            const promotedExtraIdx = state.extraPhotos.findIndex(
                (e) => e && e.dataUrl === newPrimary.url,
            );
            if (promotedExtraIdx >= 0) {
                const promoted = state.extraPhotos[promotedExtraIdx];
                // Match found - pull variants/group/blur metadata up
                // into the primary slots; photoDataUrl + Blob already
                // set above but overwrite from the extras entry for
                // tighter accuracy.
                state.photoDataUrl = promoted.dataUrl;
                state.photoBlob = promoted.blob;
                state.photoVariants = promoted.variants || null;
                state.photoGroupId = promoted.groupId || state.photoGroupId;
                state.photoClientBlurApplied = Boolean(promoted.clientBlurApplied);
                state.extraPhotos.splice(promotedExtraIdx, 1);
            }
        }
        if (state.v4Photos.length === 0) {
            _setState({
                photoBlob: null,
                photoDataUrl: null,
                photoVariants: null,
                extraPhotos: [],
            });
        }
        return removed;
    }

    // ── Page 1: capture ─────────────────────────────────────────────────
    /**
     * Phase 3 (May 2026 - docs §4.4) - consume any
     * `crisp_prefill_v1` envelope written by nearby.js when the user
     * tapped a nearby group. Pre-populates building_id / location /
     * crisis_type into the capture-flow state, and surfaces the
     * cluster's `severity_max` as a SUGGESTED severity (user can
     * always tap to override). Cleared after consumption so a
     * subsequent direct-capture entry doesn't get stale prefill.
     *
     * Safe to call repeatedly - the sessionStorage key is the
     * one-shot signal that prefill is intended.
     */
    function _consumePrefillEnvelope() {
        let env = null;
        try {
            const raw = sessionStorage.getItem('crisp_prefill_v1');
            if (!raw) return;
            env = JSON.parse(raw);
            sessionStorage.removeItem('crisp_prefill_v1');
        } catch (e) {
            console.warn('[v4-flow] prefill parse failed:', e);
            try { sessionStorage.removeItem('crisp_prefill_v1'); } catch (_) {}
            return;
        }
        if (!env || env.v !== 1) return;
        try {
            const s = window.state || {};
            // Lat/lng - group centroid, NOT a specific reporter's
            // coords. Privacy-safe.
            if (typeof env.centroid_lat === 'number' && typeof env.centroid_lng === 'number') {
                s.location = s.location || {};
                s.location.lat = env.centroid_lat;
                s.location.lng = env.centroid_lng;
                s.location.acc = 0;
                s.location.is_prefilled_from_nearby = true;
            }
            // Building id - public OSM ref, no PII.
            if (env.building_id) {
                s.building_id = env.building_id;
                s.building_id_from_nearby = true;
            }
            // Crisis type SUGGESTION - populated as a default
            // selection, NOT silently locked. The capture stage
            // surfaces it under the "Suggested" tag.
            if (env.crisis_type && !s.crisis_type) {
                s.crisis_type = env.crisis_type;
                s.crisis_type_suggested = true;
            }
            // Severity SUGGESTION - Phase-3 operator decision:
            // SUGGEST, do NOT overwrite. Mark the field so the
            // capture UI can render the "Suggested" pill.
            if (env.suggested_severity) {
                s.suggested_severity = env.suggested_severity;
                s.suggested_severity_from_nearby = true;
            }
            // Audit breadcrumb so the submit payload carries the
            // origin (helps analyse tap-to-prefill conversion rate
            // in §13's observability).
            s.prefill_origin_group_id = env.from_group_id || null;
            window.state = s;
            try { document.dispatchEvent(new CustomEvent('crisp:prefill-applied', { detail: env })); } catch (_) {}
        } catch (e) {
            console.warn('[v4-flow] prefill apply failed:', e);
        }
    }

    function _initCaptureStage() {
        // Phase 3 - consume prefill BEFORE any other init so the
        // capture stage paints with the suggested values from the
        // first frame.
        _consumePrefillEnvelope();

        const cameraInput = document.getElementById('v4-file-camera');
        const browseInput = document.getElementById('v4-file-browse');
        const heroBtn = document.getElementById('btn-v4-camera');
        const browseBtn = document.getElementById('btn-v4-browse');
        const skipBtn = document.getElementById('btn-v4-skip-photo');
        const nextBtn = document.getElementById('btn-v4-capture-next');
        const backBtn = document.getElementById('btn-v4-capture-back');
        const retryGpsBtn = document.getElementById('btn-v4-retry-gps');
        const thumbsRow = document.getElementById('v4-thumbs');

        if (!cameraInput || !heroBtn) return;

        // wire the new meta-card location editor.
        // The pen button reveals an inline text input where the user can
        // type a place name or landmark (for cases where GPS is broken,
        // they're indoors, or the geocode returned the wrong area). On
        // Save we write to state.userLocationName + state.locationName
        // (the same shared fields the v3 path uses), repaint the label,
        // and hide the editor. Cancel just hides without writing.
        const locEditBtn = document.getElementById('btn-v4-loc-edit');
        const locEditWrap = document.getElementById('v4-meta-loc-edit');
        const locEditInput = document.getElementById('v4-meta-loc-input');
        const locEditCancelBtn = document.getElementById('btn-v4-loc-cancel');
        const locEditSaveBtn = document.getElementById('btn-v4-loc-save');
        const locSuggestBox = document.getElementById('v4-meta-loc-suggest');
        // offline autocomplete for the location edit
        // input. Reuses the same `placeSearch` singleton (mobile-app/src/places.js)
        // that powers v3's location search: ~700 bundled cities + nearby
        // GPS-prefetched places + localStorage cache. Fully offline-capable.
        // Suggestions render inside the modal as a tap-list; selecting one
        // fills the input + (when coords exist) stages a lat/lng update too.
        let _locSelected = null;  // last picked suggestion {name, lat, lng, ...}
        let _locActiveIdx = -1;
        let _locSuggestions = [];
        function _renderLocSuggestions(list) {
            if (!locSuggestBox) return;
            _locSuggestions = list || [];
            _locActiveIdx = -1;
            if (!_locSuggestions.length) {
                locSuggestBox.setAttribute('hidden', '');
                locSuggestBox.innerHTML = '';
                return;
            }
            locSuggestBox.innerHTML = _locSuggestions.slice(0, 5).map((p, i) => {
                const sub = [p.region, p.country].filter(Boolean).join(', ');
                const escName = String(p.name).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
                const escSub = String(sub).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
                return `<div class="v4-meta-loc-suggest-item" data-idx="${i}" role="option">
                    <i class="fa-solid fa-location-dot v4-meta-loc-suggest-icon" aria-hidden="true"></i>
                    <span class="v4-meta-loc-suggest-info">
                        <span class="v4-meta-loc-suggest-name">${escName}</span>
                        ${sub ? `<span class="v4-meta-loc-suggest-sub">${escSub}</span>` : ''}
                    </span>
                </div>`;
            }).join('');
            locSuggestBox.removeAttribute('hidden');
            locSuggestBox.querySelectorAll('.v4-meta-loc-suggest-item').forEach((el) => {
                // Use pointerdown so the suggestion fires before the input
                // blur event closes the dropdown.
                el.addEventListener('pointerdown', (e) => {
                    e.preventDefault();
                    const idx = parseInt(el.getAttribute('data-idx'), 10) || 0;
                    _pickLocSuggestion(_locSuggestions[idx]);
                });
            });
        }
        function _hideLocSuggestions() {
            if (locSuggestBox) {
                locSuggestBox.setAttribute('hidden', '');
                locSuggestBox.innerHTML = '';
            }
            _locSuggestions = [];
            _locActiveIdx = -1;
        }
        function _pickLocSuggestion(place) {
            if (!place || !locEditInput) return;
            _locSelected = place;
            locEditInput.value = place.name;
            _hideLocSuggestions();
            // Keep focus so the user can keep editing if they want.
            locEditInput.focus();
        }
        function _highlightLocSuggestion(idx) {
            if (!locSuggestBox) return;
            locSuggestBox.querySelectorAll('.v4-meta-loc-suggest-item').forEach((el, i) => {
                el.classList.toggle('is-active', i === idx);
            });
        }
        function _openLocEdit() {
            if (!locEditWrap || !locEditInput) return;
            const s = _getState();
            locEditInput.value = s.userLocationName || s.locationName || '';
            _locSelected = null;
            _hideLocSuggestions();
            locEditWrap.removeAttribute('hidden');
            setTimeout(() => locEditInput.focus(), 30);
        }
        function _closeLocEdit() {
            if (locEditWrap) locEditWrap.setAttribute('hidden', '');
            _hideLocSuggestions();
        }
        // Coordinate-bearing? (and never the {0,0} null-island sentinel).
        function _hasCoords(p) {
            return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0);
        }
        // Best coordinate-bearing match for a typed place name within a result
        // list - exact name, then prefix either way, then word-prefix. Requires a
        // NAME relationship so we never silently snap to an unrelated top result
        // (wrong coords in a crisis app routes to the wrong operation).
        function _bestSuggestionFor(name, list) {
            if (!Array.isArray(list) || !list.length) return null;
            const nl = String(name || '').toLowerCase().trim();
            if (!nl) return null;
            const nm = (p) => String(p.name || '').toLowerCase();
            let m = list.find((p) => _hasCoords(p) && nm(p) === nl);
            if (m) return m;
            m = list.find((p) => _hasCoords(p) && (nm(p).startsWith(nl) || nl.startsWith(nm(p))));
            if (m) return m;
            m = list.find((p) => _hasCoords(p) && nm(p).split(/[\s,\-]+/).some((w) => w && (w.startsWith(nl) || nl.startsWith(w))));
            return m || null;
        }
        // Online Nominatim resolve for a typed string → Promise<place|null>. Hard
        // 3s timeout; never throws; fail-safe to null offline (searchRemote only
        // calls back on success, so the timer covers the silent-fail path).
        function _resolveRemoteCoords(name) {
            return new Promise((resolve) => {
                let settled = false;
                const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
                const timer = setTimeout(() => finish(null), 3000);
                try {
                    const ps = (typeof placeSearch !== 'undefined') ? placeSearch
                             : (typeof window !== 'undefined' && window.placeSearch) || null;
                    if (!ps || typeof ps.searchRemote !== 'function') { clearTimeout(timer); return finish(null); }
                    ps.searchRemote(name, (results) => { clearTimeout(timer); finish(_bestSuggestionFor(name, results || [])); });
                } catch (_) { clearTimeout(timer); finish(null); }
            });
        }
        async function _saveLocEdit() {
            if (!locEditInput) return;
            const name = locEditInput.value.trim();
            if (!name) { _closeLocEdit(); return; }
            const patch = { userLocationName: name, locationName: name };

            // Resolve COORDINATES for the edited place so the edited location is
            // authoritative for crisis-form / operation matching - not just a
            // label. Priority: an explicit suggestion pick → the best name-match
            // among the rendered suggestions / bundled+cached DB (instant) → an
            // online Nominatim resolve (awaited, capped at 3s). A free-text edit
            // that doesn't tap a suggestion now still re-homes the report.
            let coords = null;
            if (_locSelected && _locSelected.name === name && _hasCoords(_locSelected)) {
                coords = _locSelected;
            } else {
                let local = [];
                try {
                    const ps = (typeof placeSearch !== 'undefined') ? placeSearch
                             : (typeof window !== 'undefined' && window.placeSearch) || null;
                    if (ps && typeof ps.search === 'function') local = ps.search(name) || [];
                } catch (_) {}
                coords = _bestSuggestionFor(name, _locSuggestions) || _bestSuggestionFor(name, local);
                if (!coords && typeof navigator !== 'undefined' && navigator.onLine !== false) {
                    if (locEditSaveBtn) locEditSaveBtn.disabled = true;
                    coords = await _resolveRemoteCoords(name);
                    if (locEditSaveBtn) locEditSaveBtn.disabled = false;
                }
            }

            let _locationMoved = false;
            if (_hasCoords(coords)) {
                patch.location = {
                    lat: coords.lat,
                    lng: coords.lng,
                    // Submit reads state.location.acc - write THAT key (not `accuracy`,
                    // which nothing reads). 0 + is_user_corrected = "user-placed pin".
                    acc: 0,
                    source: 'user_corrected',
                    // Edited place is AUTHORITATIVE (user-edited > GPS > device).
                    is_user_corrected: true,
                };
                _locationMoved = true;
            }
            _setState(patch);
            _paintV4LocationPills();
            if (_locationMoved && patch.location) {
                // Repaint the building overlay for the new bbox (UNDP must-have #6 -
                // BuildingSelect listens to crisp-location-changed; ensureMap is a
                // defence-in-depth direct call).
                try {
                    document.dispatchEvent(new CustomEvent('crisp-location-changed', {
                        detail: { lat: patch.location.lat, lng: patch.location.lng, source: 'user_corrected' },
                    }));
                } catch (_) {}
                try {
                    if (window.BuildingSelect && typeof window.BuildingSelect.ensureMap === 'function') {
                        window.BuildingSelect.ensureMap(patch.location.lat, patch.location.lng).catch(() => {});
                    }
                } catch (_) {}
                // AUTHORITATIVE RE-EVAL - re-run crisis-form + operation matching for
                // the NEW coords (overriding the jitter guard), drop the previous
                // zone's stock answers, toast. _onLocationReeval lives in a sibling
                // scope (_refreshGps) → call the global it exports.
                if (typeof window.__crispV4OnLocationReeval === 'function') {
                    window.__crispV4OnLocationReeval(patch.location.lat, patch.location.lng);
                }
            } else {
                // Couldn't resolve coordinates → the map + crisis form still reflect
                // the device GPS. Save the NAME (never {0,0}) and tell the user how to
                // make the edited place authoritative.
                const _K = 'v4_loc_saved_name_only';
                const _EN = 'Saved the name only - tap a suggestion to update the map and crisis form.';
                let msg = _EN;
                try { const fn = window.t; if (typeof fn === 'function') { const v = fn(_K); if (v && v !== _K) msg = v; } } catch (_) {}
                if (typeof window.showToast === 'function') window.showToast(msg, 3500);
            }
            _closeLocEdit();
        }
        if (locEditBtn) locEditBtn.addEventListener('click', _openLocEdit);
        if (locEditCancelBtn) locEditCancelBtn.addEventListener('click', _closeLocEdit);
        if (locEditSaveBtn) locEditSaveBtn.addEventListener('click', _saveLocEdit);
        if (locEditInput) {
            // May 2026 - debounced remote fallback. Previously the input
            // handler ONLY called placeSearch.search() (offline: ~700
            // bundled cities + nearby-GPS pre-fetch + localStorage cache).
            // Anything outside that set - "Dudhwa National Park", a
            // village, a landmark, a town outside the prefetch box -
            // returned [] and the user saw NO suggestions. The
            // searchRemote() helper exists in places.js:498 and hits
            // Nominatim; it was just never wired into v4. Now:
            //   · Local results render INSTANTLY (cached + bundled) for
            //     responsive typing
            //   · Remote fetch fires after 350ms of typing pause + only
            //     when online; results merge with local + re-render
            //   · navigator.onLine off → skip remote, hint "offline -
            //     limited suggestions"
            //   · Empty merged results → hint "no matches - try a
            //     nearby city or be more specific"
            // searchRemote() caches the Nominatim response keyed by
            // query, so a repeat type of the same prefix is instant.
            let _remoteDebounce = null;
            let _remoteInFlightFor = null;
            function _hintEl() {
                // Reuses the suggestion box as the hint surface so we
                // don't grow new DOM. Cleared by _hideLocSuggestions /
                // _renderLocSuggestions.
                return locSuggestBox;
            }
            function _showHint(text, kind) {
                if (!locSuggestBox) return;
                const escText = String(text).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
                locSuggestBox.innerHTML =
                    `<div class="v4-meta-loc-suggest-hint v4-meta-loc-suggest-hint-${kind}" role="status">${escText}</div>`;
                locSuggestBox.removeAttribute('hidden');
            }
            function _runLocalSearch(q) {
                let results = [];
                try {
                    const ps = (typeof placeSearch !== 'undefined') ? placeSearch
                             : (typeof window !== 'undefined' && window.placeSearch) || null;
                    if (ps && typeof ps.search === 'function') {
                        results = ps.search(q) || [];
                    }
                } catch (_) {}
                return results;
            }
            function _mergeAndRender(q, localResults, remoteResults) {
                // Dedupe by name|country. Local first (already-known
                // results stay on top - they're frequently the user's
                // own previously-picked places via cache).
                const seen = new Set();
                const merged = [];
                for (const list of [localResults, remoteResults || []]) {
                    for (const p of list) {
                        if (!p || !p.name) continue;
                        const key = (p.name + '|' + (p.country || '')).toLowerCase();
                        if (seen.has(key)) continue;
                        seen.add(key);
                        merged.push(p);
                    }
                }
                if (merged.length) {
                    _renderLocSuggestions(merged.slice(0, 8));
                    return;
                }
                // No matches at all.
                if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                    _showHint('Offline - only cached places searched. Connect to find more.', 'offline');
                } else {
                    _showHint('No matches yet - try a nearby city or be more specific.', 'empty');
                }
            }

            locEditInput.addEventListener('input', () => {
                _locSelected = null;
                const q = locEditInput.value.trim();
                // placeSearch.search() returns [] below 3 chars by design
                // (too noisy on 1-2 char prefixes). Mirror that here.
                if (q.length < 3) {
                    _hideLocSuggestions();
                    if (_remoteDebounce) { clearTimeout(_remoteDebounce); _remoteDebounce = null; }
                    return;
                }

                // Instant local results.
                const localResults = _runLocalSearch(q);
                if (localResults.length) {
                    _renderLocSuggestions(localResults);
                } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                    _showHint('Offline - searching cached places only…', 'offline');
                } else {
                    _showHint('Searching nearby places…', 'searching');
                }

                // Debounced remote enrichment (online only).
                if (_remoteDebounce) clearTimeout(_remoteDebounce);
                if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
                _remoteDebounce = setTimeout(() => {
                    _remoteDebounce = null;
                    // Don't fire if the user has typed past this query
                    // already (avoid stale paint after fast typing).
                    const currentQ = locEditInput.value.trim();
                    if (currentQ !== q) return;
                    _remoteInFlightFor = q;
                    try {
                        const ps = (typeof placeSearch !== 'undefined') ? placeSearch
                                 : (typeof window !== 'undefined' && window.placeSearch) || null;
                        if (!ps || typeof ps.searchRemote !== 'function') return;
                        ps.searchRemote(q, (remoteResults) => {
                            // Race guard: the user may have kept typing
                            // while Nominatim was responding. Only render
                            // if this callback is still the latest in-flight.
                            if (_remoteInFlightFor !== q) return;
                            if (locEditInput.value.trim() !== q) return;
                            _mergeAndRender(q, _runLocalSearch(q), remoteResults);
                        });
                    } catch (_) { /* searchRemote unavailable - keep local hint */ }
                }, 350);
            });
            locEditInput.addEventListener('keydown', (e) => {
                const hasList = _locSuggestions.length > 0;
                if (e.key === 'ArrowDown' && hasList) {
                    e.preventDefault();
                    _locActiveIdx = Math.min(_locActiveIdx + 1, Math.min(_locSuggestions.length, 5) - 1);
                    _highlightLocSuggestion(_locActiveIdx);
                } else if (e.key === 'ArrowUp' && hasList) {
                    e.preventDefault();
                    _locActiveIdx = Math.max(_locActiveIdx - 1, 0);
                    _highlightLocSuggestion(_locActiveIdx);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (hasList && _locActiveIdx >= 0) {
                        _pickLocSuggestion(_locSuggestions[_locActiveIdx]);
                    } else {
                        _saveLocEdit();
                    }
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    if (hasList) _hideLocSuggestions();
                    else _closeLocEdit();
                }
            });
            locEditInput.addEventListener('blur', () => {
                // Delay so a pointerdown on a suggestion lands before close.
                setTimeout(_hideLocSuggestions, 180);
            });
        }

        // section status badges (Photo n/5 count + Voice /
        // Text "Captured" pills). Driven by _refreshCapStrip's existing
        // call sites; this just adds a paint of the new per-section
        // elements alongside the now-hidden legacy chip strip.
        function _refreshSectionBadges() {
            const s = window.state || {};
            const photos = (s.v4Photos && s.v4Photos.length) || (s.photoDataUrl ? 1 : 0);
            const audioOk = !!(s.audioBlob && s.audioBlob.size > 0)
                || !!(s.transcript && s.transcript.trim().length > 4);
            const anyText = !!(s.description && s.description.trim().length > 0);
            const photoCount = document.getElementById('v4-cap-section-photo-count');
            if (photoCount) {
                photoCount.textContent = `${photos}/${V4_MAX_PHOTOS}`;
                photoCount.classList.toggle('is-captured', photos > 0);
                // HC60 - counter starts hidden (decorative noise pre-
                // capture) and reveals as soon as photos > 0.
                if (photos > 0) photoCount.removeAttribute('hidden');
                else            photoCount.setAttribute('hidden', '');
            }
            // Voice + Text are now compact chip toggles
            // (`#v4-cap-chip-voice-status` / `#v4-cap-chip-text-status`)
            // instead of full-bleed sections with header badges. Status
            // shows up as a green dot on the chip when content exists.
            const voiceChipStatus = document.getElementById('v4-cap-chip-voice-status');
            const voiceChip = document.getElementById('v4-cap-chip-voice');
            if (voiceChip) voiceChip.classList.toggle('is-captured', audioOk);
            if (voiceChipStatus) voiceChipStatus.classList.toggle('is-on', audioOk);
            const textChipStatus = document.getElementById('v4-cap-chip-text-status');
            const textChip = document.getElementById('v4-cap-chip-text');
            if (textChip) textChip.classList.toggle('is-captured', anyText);
            if (textChipStatus) textChipStatus.classList.toggle('is-on', anyText);

            // HC60 (May 2026) - auto-hide the tips card once the user
            // has captured ≥ 1 photo (by then the guidance has done its
            // job and the vertical real estate is more valuable for the
            // photo grid + the Continue CTA). `.v4-stage.is-has-photos`
            // hides `.v4-cap-tips` via CSS. Mirror class drops when
            // photos return to zero (e.g. user removed all captures via
            // the thumb-strip X buttons).
            const stageEl = document.getElementById('stage-v4-capture');
            if (stageEl) {
                stageEl.classList.toggle('is-has-photos', photos > 0);
            }
        }
        // Expose so _renderThumbs + other mutators can call it.
        window.__crispV4RefreshSectionBadges = _refreshSectionBadges;

        // Voice + Text are now collapsed-by-default compact
        // chips. Tapping a chip expands its inline panel (mic or
        // textarea) and collapses the other. Once the chip carries a
        // recording or text content, it stays styled as "captured" via
        // the green dot regardless of expand state. Auto-expand on first
        // tap of `Voice` / `Text` chip; user can manually collapse to
        // free vertical space.
        const voiceChipBtn = document.getElementById('v4-cap-chip-voice');
        const textChipBtn = document.getElementById('v4-cap-chip-text');
        const voicePanel = document.getElementById('v4-cap-voice-panel');
        const textPanel = document.getElementById('v4-cap-text-panel');
        // HC60 (May 2026) - `_setChipExpanded` now also toggles
        // `is-secondary-input-open` on the stage so the tips card
        // auto-hides whenever EITHER voice or text panel is open.
        // CSS rule:
        //     .v4-stage.is-secondary-input-open .v4-cap-tips { display:none }
        function _syncSecondaryInputClass() {
            const stageEl = document.getElementById('stage-v4-capture');
            if (!stageEl) return;
            const voiceOpen = voiceChipBtn && voiceChipBtn.getAttribute('aria-expanded') === 'true';
            const textOpen  = textChipBtn  && textChipBtn.getAttribute('aria-expanded')  === 'true';
            stageEl.classList.toggle('is-secondary-input-open', !!(voiceOpen || textOpen));
        }
        function _setChipExpanded(chip, panel, on) {
            if (!chip || !panel) return;
            if (on) {
                panel.removeAttribute('hidden');
                chip.classList.add('is-expanded');
                chip.setAttribute('aria-expanded', 'true');
            } else {
                panel.setAttribute('hidden', '');
                chip.classList.remove('is-expanded');
                chip.setAttribute('aria-expanded', 'false');
            }
            _syncSecondaryInputClass();
        }
        if (voiceChipBtn && voicePanel) {
            voiceChipBtn.addEventListener('click', () => {
                const expanding = voiceChipBtn.getAttribute('aria-expanded') !== 'true';
                _setChipExpanded(voiceChipBtn, voicePanel, expanding);
                // Auto-collapse the other chip's panel to keep the
                // capture stage compact - only one extra surface open
                // at a time.
                if (expanding) _setChipExpanded(textChipBtn, textPanel, false);
            });
        }
        if (textChipBtn && textPanel) {
            textChipBtn.addEventListener('click', () => {
                const expanding = textChipBtn.getAttribute('aria-expanded') !== 'true';
                _setChipExpanded(textChipBtn, textPanel, expanding);
                if (expanding) {
                    _setChipExpanded(voiceChipBtn, voicePanel, false);
                    const ta = document.getElementById('v4-cap-text-area');
                    if (ta) setTimeout(() => ta.focus(), 60);
                }
            });
        }

        // show a toast (via app.js's helper if available)
        // when the user tries to add a 6th photo. Stays user-visible
        // without blocking the rest of the capture flow.
        function _toastCapHit() {
            const _t = (typeof window.t === 'function') ? window.t : ((k) => k);
            const msg = _t('photo_cap_reached') || `Max ${V4_MAX_PHOTOS} photos per report`;
            if (typeof window.showToast === 'function') {
                window.showToast(msg, 'info');
            } else {
                console.warn('[v4]', msg);
            }
        }

        // small action sheet shown when the `+` button on
        // the thumb strip is tapped. Replaces the previous single-click
        // straight-to-cameraInput behaviour (which on desktop fell back
        // to a file picker, hiding any way for the user to ACTUALLY
        // open the live camera). Two options:
        //   • Camera   - opens the same smart camera path as the hero
        //                button (live getUserMedia on desktop, OS
        //                camera on iOS / Android).
        //   • Browse   - opens the existing file-picker (gallery).
        // Tapping the dim backdrop or Cancel dismisses with no action.
        function _openAddPhotoChooser() {
            const photos = _getState().v4Photos || [];
            if (photos.length >= V4_MAX_PHOTOS) {
                _toastCapHit();
                return;
            }
            const _t = (typeof window.t === 'function') ? window.t : ((k) => k);
            // Reuse if already present in DOM.
            let sheet = document.getElementById('v4-photo-chooser');
            if (!sheet) {
                sheet = document.createElement('div');
                sheet.id = 'v4-photo-chooser';
                sheet.className = 'v4-photo-chooser';
                document.body.appendChild(sheet);
            }
            sheet.innerHTML = `
                <div class="v4-photo-chooser-backdrop" data-action="cancel"></div>
                <div class="v4-photo-chooser-sheet" role="dialog" aria-modal="true">
                    <button class="v4-photo-chooser-btn" data-action="camera" type="button">
                        <i class="fa-solid fa-camera"></i>
                        <span>${_t('chooser_camera') || 'Camera'}</span>
                    </button>
                    <button class="v4-photo-chooser-btn" data-action="browse" type="button">
                        <i class="fa-solid fa-image"></i>
                        <span>${_t('chooser_gallery') || 'Browse files'}</span>
                    </button>
                    <button class="v4-photo-chooser-cancel" data-action="cancel" type="button">${_t('cancel') || 'Cancel'}</button>
                </div>
            `;
            sheet.style.display = 'flex';
            const _close = () => { sheet.style.display = 'none'; };
            sheet.querySelectorAll('[data-action]').forEach((el) => {
                el.addEventListener('click', (ev) => {
                    const action = el.getAttribute('data-action');
                    _close();
                    if (action === 'camera') _openCameraSmart();
                    else if (action === 'browse') browseInput.click();
                    // 'cancel' just closes
                    ev.stopPropagation();
                });
            });
        }

        // extracted from the heroBtn click handler so the
        // `+` chooser's Camera option can re-use the SAME smart camera
        // logic (live getUserMedia modal on desktop with the existing
        // openCameraModal helper, OS-native camera-capture input on
        // mobile/iOS where getUserMedia isn't reliable).
        function _openCameraSmart() {
            const photos = _getState().v4Photos || [];
            if (photos.length >= V4_MAX_PHOTOS) {
                _toastCapHit();
                return;
            }
            // HC97 (May 2026) - the custom getUserMedia camera modal is the
            // SINGLE camera UX across every platform + capture entry point.
            // Gate on CAPABILITY, not platform: iPhone Safari + installed PWA
            // DO support getUserMedia (the review "+ Add" already opened the
            // custom modal on iOS), so the old `!isIOS` fork is exactly what
            // forced Stage-1 alone to the native iOS camera. The
            // `<input capture>` branch below stays as the runtime fallback for
            // contexts where getUserMedia is unavailable or denied (iOS in-app
            // webviews, permission-denied) - openCameraModal also self-falls-
            // back on a getUserMedia reject. `__crispForceCameraMode`
            // ('modal' | 'native') lets e2e drive each branch deterministically
            // (Playwright can't exercise real getUserMedia).
            //
            // NOTE: the prior `!isIOS` gate existed for an iPadOS desktop-mode
            // tap-to-focus/layout quirk. If that resurfaces on iPad, narrow the
            // fallback to iPad-only HERE rather than re-excluding all iOS.
            const hasGUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
            const _forceMode = (typeof window !== 'undefined' && window.__crispForceCameraMode) || null;
            const _useModal = _forceMode === 'modal'
                || (_forceMode !== 'native' && hasGUM && typeof window.openCameraModal === 'function');
            if (_useModal && typeof window.openCameraModal === 'function') {
                const _preDataUrl = _getState().photoDataUrl;
                const _preCount = (_getState().v4Photos || []).length;
                window.openCameraModal();
                const _modalCloseHandler = () => {
                    // the camera modal supports
                    // MULTI-SNAP: first snap → state.photoDataUrl, every
                    // subsequent snap → state.extraPhotos.push(...).
                    // The previous close handler only read photoDataUrl,
                    // so taking 5+ snaps inside the modal surfaced only
                    // ONE thumbnail in the v4 strip after closing.
                    // Now we pull the primary + each extra, dedupe, and
                    // hard-cap at V4_MAX_PHOTOS.
                    if (!_getState().v4Photos) _setState({ v4Photos: [] });
                    const photosNow = _getState().v4Photos;
                    const dataUrl = _getState().photoDataUrl;
                    const extras = _getState().extraPhotos || [];

                    // Collect candidates in capture order: primary first
                    // (if it actually changed since modal open), then
                    // each extra in the order the user shot them.
                    const candidates = [];
                    if (dataUrl && dataUrl !== _preDataUrl) {
                        candidates.push({
                            blob: _getState().photoBlob,
                            url: dataUrl,
                            ts: Date.now(),
                        });
                    }
                    for (const ex of extras) {
                        if (ex && ex.dataUrl) {
                            candidates.push({
                                blob: ex.blob || null,
                                url: ex.dataUrl,
                                ts: Date.now(),
                            });
                        }
                    }

                    // Push each candidate, respecting the V4_MAX_PHOTOS
                    // hard cap and de-duping by data URL.
                    let added = 0;
                    let capHit = false;
                    for (const cand of candidates) {
                        if (photosNow.length >= V4_MAX_PHOTOS) {
                            capHit = true;
                            break;
                        }
                        if (!photosNow.find((p) => p.url === cand.url)) {
                            photosNow.push(cand);
                            added++;
                        }
                    }

                    // BUGFIX May 2026 - we used to clear state.extraPhotos
                    // here ("so the v3-shape accumulator doesn't
                    // double-count on the next modal session"). That
                    // turned out to be catastrophic: submitReport at
                    // app.js:7100 reads `state.extraPhotos.map(ep => …)`
                    // to build the upload work list, so wiping it dropped
                    // every camera-snap photo beyond the primary BEFORE
                    // the queue item was ever built. Every multi-snap
                    // capture submitted as a single-photo report.
                    //
                    // The "double-count" concern is already handled at
                    // line ~586 by the de-dupe-by-URL check inside this
                    // very candidates loop: if the modal opens a SECOND
                    // time with extras still in state, the new snaps push
                    // to state.extraPhotos as before, but the URL-set
                    // check refuses to re-add already-known entries to
                    // v4Photos. So leaving state.extraPhotos populated is
                    // safe across modal re-opens.
                    // (Do not re-introduce the clear without a test
                    // covering multi-snap → submit → backend asserts
                    // received_media >= snap_count × 3 tiers.)

                    if (added > 0) {
                        _renderThumbs();
                        // Repaint BOTH strips: the modal may be opened from the
                        // capture stage (this strip) OR the review "+ Add" -
                        // fire the review refresher too so snaps surface no
                        // matter which stage opened the camera.
                        if (typeof window.__crispV4RefreshReviewStrip === 'function') {
                            try { window.__crispV4RefreshReviewStrip(); } catch (_) {}
                        }
                        nextBtn.disabled = false;
                        nextBtn.classList.add('is-ready');
                    }
                    if (capHit && candidates.length > added) {
                        _toastCapHit();
                    }
                    // User taps Continue manually after each step - no
                    // auto-advance, no auto-prefill.
                    document.removeEventListener('camera-modal-closed', _modalCloseHandler);
                };
                document.addEventListener('camera-modal-closed', _modalCloseHandler);
                let _polls = 0;
                const _modalPoll = setInterval(() => {
                    const m = document.getElementById('camera-modal');
                    const stillOpen = m && getComputedStyle(m).display !== 'none';
                    if (!stillOpen) {
                        clearInterval(_modalPoll);
                        _modalCloseHandler();
                    } else if (++_polls > 300) {
                        clearInterval(_modalPoll);
                    }
                }, 200);
            } else {
                cameraInput.click();
            }
        }

        // Hero / browse → trigger native file inputs.
        // on desktop, `<input capture=environment>`
        // falls back to file picker. We detect desktop (no iOS UA + has
        // getUserMedia) and open the existing #camera-modal instead, which
        // uses live <video> + getUserMedia. The modal already writes
        // state.photoDataUrl + state.photoVariants on snap (matches v4
        // contract), so v4 just needs to refresh the thumbnail strip when
        // the modal closes.
        // Hero button (first-capture slot) - uses the extracted smart
        // camera path. Same behaviour as before; logic now lives in
        // _openCameraSmart so the `+` chooser can re-use it.
        heroBtn.addEventListener('click', () => _openCameraSmart());
        browseBtn.addEventListener('click', () => {
            const photos = _getState().v4Photos || [];
            if (photos.length >= V4_MAX_PHOTOS) {
                _toastCapHit();
                return;
            }
            browseInput.click();
        });

        // Photo handler - delegates to v3's `__crispIngestFile` so the
        // EXACT v3 pipeline runs:
        //   1. Network-tier-aware resize → state.photoDataUrl  (← THIS is
        //      the gate `submitReport()` checks for `hasPhoto`. Without it,
        //      every v4 report uploaded as text-only on the server.)
        //   2. ImageVariants.generate (deferred via _runWhenIdle)
        //      → state.photoVariants {small, medium, large} for the
        //      tier-first guaranteed-delivery upload path.
        //   3. PII blur via BlazeFace → state.photoClientBlurApplied flag.
        //   4. blurhash placeholder → state.blurhash.
        //   5. state.photoGroupId set so the 3 variants share a media group.
        //
        // After the v3 pipeline writes state.photoDataUrl, we use it as
        // the v4 thumbnail - same data URL, no extra encode pass.
        const _handlePhoto = async (file) => {
            if (!file) return;
            // hard 5-photo cap. The previous code would
            // accept indefinite photos via the `+` button. Bail before
            // the v3 ingest pipeline runs so we don't leak state.
            const photosNow = _getState().v4Photos || [];
            if (photosNow.length >= V4_MAX_PHOTOS) {
                _toastCapHit();
                return;
            }
            try {
                // BUGFIX May 2026 - `asExtra` MUST be true for every photo
                // beyond the first one in this session. Previously this
                // call was hard-coded `asExtra: false`, which made the v3
                // ingest helper write the new file into state.photoDataUrl
                // + state.photoVariants - OVERWRITING the primary slot
                // every time. Net result of a multi-select browse of N
                // files: only the LAST file's variants survived in state;
                // photos 1..N-1 were never pushed to state.extraPhotos +
                // were silently lost before submitReport even built the
                // queue item. DB census from the day proved it: every
                // recent APP-source report had media=3 groups=1 (just the
                // primary's three tiers) regardless of how many photos
                // the reporter actually captured.
                //
                // First photo: photoDataUrl is null AND v4Photos is empty
                // → goes to primary slot (asExtra=false). Subsequent
                // photos: append to state.extraPhotos so submitReport's
                // extraPhotosVariants.map(...) at app.js:7100 actually
                // finds them.
                const _hasPrimary = !!_getState().photoDataUrl
                                  || (_getState().v4Photos || []).length > 0;
                const asExtra = _hasPrimary;

                // Make sure v3's stage-photo setup ran (it exposes
                // __crispIngestFile via window). If not yet ready (e.g.
                // user tapped capture before app.js boot finished), we
                // fall back to a minimal in-place pipeline that still
                // sets state.photoDataUrl so submitReport doesn't fail.
                if (typeof window.__crispIngestFile === 'function') {
                    window.__crispIngestFile(file, { asExtra });
                } else {
                    // Fallback path: set photoDataUrl manually so submit
                    // works even if the v3 ingest helper isn't ready yet.
                    // The fallback only knows about the primary slot -
                    // multi-photo via fallback is a corner case (would
                    // require __crispIngestFile to fail to load), and
                    // the previous behavior was already lossy.
                    await _v4FallbackIngest(file);
                }

                // wait for state.photoDataUrl to
                // CHANGE, not just to become truthy. The previous version
                // checked `!_getState().photoDataUrl`, which works for
                // photo #1 but races on photo #2: state.photoDataUrl is
                // already set (from photo #1), so the loop exits
                // immediately BEFORE __crispIngestFile finishes its async
                // FileReader → canvas.toDataURL chain for photo #2. The
                // local `dataUrl` then captures the OLD photo's URL and
                // pushes a duplicate into v4Photos. User-visible: only
                // 1 thumbnail ever appears, no matter how many photos
                // are taken.
                // Branch on asExtra: primary writes to state.photoDataUrl,
                // extras append to state.extraPhotos[len-1].dataUrl. We
                // wait for the appropriate signal to land before reading
                // the new URL for the v4 thumbnail strip.
                const _preDataUrl = _getState().photoDataUrl;
                const _preExtrasLen = (_getState().extraPhotos || []).length;
                const startedAt = Date.now();
                if (asExtra) {
                    // Wait for the new entry to land at state.extraPhotos[len].
                    while ((_getState().extraPhotos || []).length === _preExtrasLen
                           && Date.now() - startedAt < 4000) {
                        await new Promise((r) => setTimeout(r, 50));
                    }
                } else {
                    // Primary path - same wait-for-change loop as before.
                    while (_getState().photoDataUrl === _preDataUrl
                           && Date.now() - startedAt < 4000) {
                        await new Promise((r) => setTimeout(r, 50));
                    }
                }

                // Render the v4 thumbnail strip. For the primary the URL
                // is state.photoDataUrl; for extras the new entry sits
                // at the tail of state.extraPhotos.
                let dataUrl;
                let entryBlob;
                if (asExtra) {
                    const extras = _getState().extraPhotos || [];
                    const tail = extras[extras.length - 1];
                    dataUrl = tail?.dataUrl || null;
                    entryBlob = tail?.blob || null;
                } else {
                    dataUrl = _getState().photoDataUrl;
                    entryBlob = _getState().photoBlob;
                }
                if (dataUrl && (asExtra || dataUrl !== _preDataUrl)) {
                    const photoEntry = {
                        blob: entryBlob,
                        url: dataUrl,
                        ts: Date.now(),
                    };
                    if (!_getState().v4Photos) _setState({ v4Photos: [] });
                    const photos = _getState().v4Photos;
                    // De-dupe defensively in case the same data URL is
                    // re-ingested (e.g. user picks the same gallery item
                    // twice).
                    if (!photos.find((p) => p.url === dataUrl)) {
                        photos.push(photoEntry);
                    }
                    _renderThumbs();
                    nextBtn.disabled = false;
                    nextBtn.classList.add('is-ready');
                    // Delta-C: refresh the captured-strip so the green
                    // 📷 chip lights up the moment a photo is ingested.
                    if (typeof window.__crispV4RefreshCapStrip === 'function') {
                        try { window.__crispV4RefreshCapStrip(); } catch (_) {}
                    }
                }

                // No auto-advance from here. Users tap Continue manually
                // so they can add more photos via the `+` button.
                // Classify-step prefill is reporter-driven (no AI).
            } catch (e) {
                console.error('[v4] photo handler failed:', e);
            }
        };

        // Fallback ingest used only if v3's __crispIngestFile isn't on
        // window yet (race during boot - should be rare). Sets the
        // critical state.photoDataUrl + state.photoBlob + state.photoGroupId
        // so submitReport's hasPhoto gate works. Variants are best-effort.
        async function _v4FallbackIngest(file) {
            const state = _getState();
            // Read the file as data URL.
            const dataUrl = await new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result || ''));
                r.onerror = () => reject(r.error);
                r.readAsDataURL(file);
            });
            state.photoDataUrl = dataUrl;
            state.photoBlob = file;
            state.photoGroupId = (window.crypto?.randomUUID?.() ||
                                   ('grp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)));
            // Best-effort variants if available.
            try {
                if (window.ImageVariants && window.ImageVariants.generate) {
                    const variants = await window.ImageVariants.generate(file);
                    if (variants) {
                        state.photoVariants = variants;
                        state.photoBlob = variants.small.blob || file;
                        state.photoClientBlurApplied = Boolean(variants.clientBlurApplied);
                        state.blurhash = variants.blurhash || null;
                    }
                }
            } catch (e) {
                console.warn('[v4 fallback] variant gen failed:', e);
            }
        }

        cameraInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            _handlePhoto(file);
            cameraInput.value = '';  // allow re-selecting the same file
        });
        browseInput.addEventListener('change', (e) => {
            // multi-select from gallery: slice down to the
            // remaining cap so a user who picks 10 files at once doesn't
            // race past the per-call check inside _handlePhoto (each call
            // reads state synchronously before any push, so without this
            // slice the first 10 calls would all see length=0).
            const incoming = Array.from(e.target.files || []);
            const current = (_getState().v4Photos || []).length;
            const remaining = Math.max(0, V4_MAX_PHOTOS - current);
            if (incoming.length > remaining) _toastCapHit();
            // BUGFIX May 2026 - serialise the per-file ingest calls.
            // forEach fired all N calls IN PARALLEL; each _handlePhoto
            // reads state.photoDataUrl synchronously to decide asExtra,
            // so 3 simultaneous calls all see photoDataUrl=null at the
            // same instant and all dispatch with asExtra=false → all
            // overwrite the primary slot → photos 1..N-1 are lost. The
            // sibling test 44-v4-multi-photo.spec.ts exposes this race
            // (multi-select via setInputFiles delivers all files in
            // one tick). Sequential await chains each call so by the
            // time iteration 2 starts, iteration 1 has already set
            // photoDataUrl + iteration 2's asExtra computation reads
            // the correct value.
            (async () => {
                for (const f of incoming.slice(0, remaining)) {
                    await _handlePhoto(f);
                }
            })();
            browseInput.value = '';
        });

        skipBtn.addEventListener('click', () => {
            // Voice-only path - skip directly to review with no photo.
            _setState({ v4VoiceOnly: true });
            nextBtn.disabled = false;
            _goToClassify();
        });

        nextBtn.addEventListener('click', _goToClassify);
        backBtn.addEventListener('click', () => window.__crispGoToStage('stage-home'));

        // HC55 (May 2026) - 5-second cooldown on the "Refresh GPS"
        // button. Pre-HC55 a tap-spam earned the entire mobile carrier
        // a 429 from Nominatim's CDN edge (the operator's HAR caught
        // two refreshes 10s apart, both rate-limited). The new backend
        // route caches results for 7 days so most refreshes are cheap,
        // but a client-side debounce makes the network behaviour
        // observably tame in DevTools too. aria-busy keeps screen
        // readers in step with the visual disabled state.
        const _GPS_REFRESH_COOLDOWN_MS = 5000;
        let _lastGpsRefreshAt = 0;
        retryGpsBtn.addEventListener('click', () => {
            const now = Date.now();
            const sinceLast = now - _lastGpsRefreshAt;
            if (sinceLast < _GPS_REFRESH_COOLDOWN_MS) return;
            _lastGpsRefreshAt = now;
            retryGpsBtn.disabled = true;
            retryGpsBtn.setAttribute('aria-busy', 'true');
            try {
                _refreshGps(true);   // user-initiated → a material move re-evals the crisis form
            } finally {
                setTimeout(() => {
                    retryGpsBtn.disabled = false;
                    retryGpsBtn.removeAttribute('aria-busy');
                }, _GPS_REFRESH_COOLDOWN_MS);
            }
        });

        // ── Delta-C - multi-modal additive capture wiring ──
        //
        // The new capture page has 3 equal tiles (Photo / Voice / Type).
        // Photo reuses the existing camera/file flow above. Voice and
        // Type each toggle their own drawer beneath the grid. The
        // captured-strip lights up green chips for every modality
        // present in window.state. Continue is enabled whenever ANY
        // modality has content.
        const voiceTile = document.getElementById('btn-v4-cap-voice');
        const textTile = document.getElementById('btn-v4-cap-text');
        const voiceDrawer = document.getElementById('v4-cap-voice-drawer');
        const textDrawer = document.getElementById('v4-cap-text-drawer');
        const capMicBtn = document.getElementById('btn-v4-cap-mic');
        const capTextArea = document.getElementById('v4-cap-text-area');
        // Legacy capture-strip element was removed from the DOM; the
        // function below keeps the same name so other modules that call
        // `__crispV4RefreshCapStrip` continue to work, but its only job
        // now is the Continue-button enable + section-badge repaint.

        function _setTileActive(tile, active) {
            if (!tile) return;
            tile.classList.toggle('is-active', !!active);
        }
        function _toggleDrawer(drawer, want) {
            if (!drawer) return false;
            const willOpen = want === undefined ? drawer.hasAttribute('hidden') : want;
            if (willOpen) drawer.removeAttribute('hidden');
            else drawer.setAttribute('hidden', '');
            return willOpen;
        }

        if (voiceTile) {
            voiceTile.addEventListener('click', () => {
                const opened = _toggleDrawer(voiceDrawer);
                _setTileActive(voiceTile, opened);
                if (opened && capMicBtn) {
                    setTimeout(() => capMicBtn.focus({ preventScroll: false }), 60);
                }
            });
        }
        if (textTile) {
            textTile.addEventListener('click', () => {
                const opened = _toggleDrawer(textDrawer);
                _setTileActive(textTile, opened);
                if (opened && capTextArea) {
                    setTimeout(() => capTextArea.focus({ preventScroll: false }), 60);
                }
            });
        }

        // HC60 (May 2026) - capture-stage recorder state machine.
        //
        // Three states drive the `.v4-cap-recorder` panel UI:
        //   · IDLE              → big mic CTA visible
        //   · RECORDING         → CTA hidden, recorder-state row visible
        //                         (pulsing red dot + live timer + delete/stop)
        //   · STOPPED-WITH-AUDIO → resume chip visible ("🎤 0:12 ✕")
        //
        // Class on the `.v4-cap-recorder` panel:
        //   · `.is-recording` toggles which child renders (CSS handles
        //     the hide/reveal - no DOM removal).
        //   · `.has-audio`   reveals the resume chip + hides the CTA.
        //
        // Cheap UX: pulse animation is CSS-only (no rAF loop), timer is
        // a single setInterval(1000), so battery cost is negligible.
        let _capRecorderTimerHandle = null;
        let _capRecorderStartTs = 0;

        function _fmtRecorderTimer(ms) {
            const total = Math.max(0, Math.floor(ms / 1000));
            const mm = Math.floor(total / 60);
            const ss = (total % 60).toString().padStart(2, '0');
            return `${mm}:${ss}`;
        }
        function _renderCapRecorderState(stateName, opts) {
            const panel       = document.getElementById('v4-cap-voice-panel');
            const micCta      = document.getElementById('btn-v4-cap-mic');
            const stateRow    = document.getElementById('v4-cap-recorder-state');
            const timerEl     = document.getElementById('v4-cap-recorder-timer');
            const resumeChip  = document.getElementById('v4-cap-recorder-resume');
            const resumeTime  = document.getElementById('v4-cap-recorder-resume-time');
            if (!panel) return;
            opts = opts || {};

            if (stateName === 'recording') {
                panel.classList.add('is-recording');
                panel.classList.remove('has-audio');
                if (stateRow) stateRow.removeAttribute('hidden');
                if (resumeChip) resumeChip.setAttribute('hidden', '');
                if (micCta) micCta.setAttribute('hidden', '');
                if (timerEl) timerEl.textContent = '0:00';
                _capRecorderStartTs = Date.now();
                if (_capRecorderTimerHandle) clearInterval(_capRecorderTimerHandle);
                _capRecorderTimerHandle = setInterval(() => {
                    if (!timerEl) return;
                    timerEl.textContent =
                        _fmtRecorderTimer(Date.now() - _capRecorderStartTs);
                }, 1000);
            } else if (stateName === 'stopped') {
                panel.classList.remove('is-recording');
                panel.classList.add('has-audio');
                if (stateRow) stateRow.setAttribute('hidden', '');
                if (_capRecorderTimerHandle) {
                    clearInterval(_capRecorderTimerHandle);
                    _capRecorderTimerHandle = null;
                }
                if (resumeChip) {
                    resumeChip.removeAttribute('hidden');
                    if (resumeTime) {
                        resumeTime.textContent = opts.durationLabel ||
                            _fmtRecorderTimer(Date.now() - _capRecorderStartTs);
                    }
                }
                if (micCta) micCta.setAttribute('hidden', '');
            } else {
                // 'idle' - default state. Mic CTA visible, no recording.
                panel.classList.remove('is-recording');
                panel.classList.remove('has-audio');
                if (stateRow) stateRow.setAttribute('hidden', '');
                if (resumeChip) resumeChip.setAttribute('hidden', '');
                if (micCta) micCta.removeAttribute('hidden');
                if (_capRecorderTimerHandle) {
                    clearInterval(_capRecorderTimerHandle);
                    _capRecorderTimerHandle = null;
                }
            }
        }
        // Expose for tests + edge callers (e.g. _clearCaptureState in
        // app.js can pull the recorder back to idle after a clean reset).
        window.__crispV4RenderCapRecorderState = _renderCapRecorderState;

        // RENDER-FROM-STATE - the v4 capture + classify DOM is a pure function of
        // `state`. Called on stage-v4-capture entry, on every classify sub-step
        // show, AND on crisp-capture-state-cleared. Because a cleared `state`
        // deterministically yields a clean DOM, NO future capture field can leak
        // into the next report by being "painted on tap but never cleared on
        // reset" - that imperative-paint gap was the root cause of the recurring
        // state-persistence bug (description textarea + recorder panel + grid
        // highlights all leaked because reset hand-enumerated DOM clears and kept
        // falling behind). Idempotent + fully guarded.
        function _renderV4FromState() {
            const s = window.state || {};
            // Capture stage: description textarea + voice recorder panel.
            try { const ta = document.getElementById('v4-cap-text-area'); if (ta) ta.value = s.description || ''; } catch (_) {}
            try { _renderCapRecorderState((s.audioBlob && s.audioBlob.size > 0) ? 'stopped' : 'idle'); } catch (_) {}
            // Review stage: required debris card (defined in _initReviewStage -
            // window hook, cross-scope safe; no-op before review init).
            try { if (window.__crispV4RenderDebrisCard) window.__crispV4RenderDebrisCard(); } catch (_) {}
            // Classify stage: damage / infra / crisis selections derive from state
            // (each option's data-value compared to the canonical state field).
            const sel = (selector, val) => {
                try {
                    document.querySelectorAll(selector).forEach((el) => {
                        const on = val != null && el.getAttribute('data-value') === val;
                        el.classList.toggle('is-selected', on);
                        if (!on) el.classList.remove('is-tap-confirmed');
                        try { el.setAttribute('aria-checked', on ? 'true' : 'false'); } catch (_) {}
                    });
                } catch (_) {}
            };
            sel('#v4-view-damage .v4-q-opt', s.damage_classification);
            sel('#v4-view-infra .v4-hit-tile', s.infrastructure_type);
            sel('#v4-cause-grid .v4-cause-tile', s.crisis_type);
            // Infra "OTHER, please specify" prompt + free-text mirror state.
            try {
                const isOther = s.infrastructure_type === 'OTHER';
                const prompt = document.getElementById('v4-infra-other-prompt');
                if (prompt) { if (isOther) prompt.removeAttribute('hidden'); else prompt.setAttribute('hidden', ''); }
                const input = document.getElementById('v4-infra-other-input');
                if (input) input.value = isOther ? (s.infrastructure_name || '') : '';
            } catch (_) {}
        }
        window.__crispV4RenderFromState = _renderV4FromState;

        // Voice mic CTA - start recording + flip into the RECORDING state.
        if (capMicBtn) {
            capMicBtn.addEventListener('click', () => {
                if (_isV4Recording()) {
                    // Defensive - shouldn't be visible during recording,
                    // but if it is, treat as a "stop" press.
                    _stopV4Recording();
                    _renderCapRecorderState('stopped');
                } else {
                    _startV4Recording();
                    _renderCapRecorderState('recording');
                }
                setTimeout(_refreshCapStrip, 120);
            });
        }

        // HC60 - Delete (trash) button: abort the in-progress recording,
        // discard the assembled blob, return to idle.
        const recDeleteBtn = document.getElementById('btn-v4-cap-recorder-delete');
        if (recDeleteBtn) {
            recDeleteBtn.addEventListener('click', () => {
                try {
                    if (window.state && window.state.mediaRecorder &&
                        window.state.mediaRecorder.state !== 'inactive') {
                        window.state.mediaRecorder.stop();
                    }
                } catch (_) {}
                window.state.audioBlob = null;
                window.state.audioChunks = [];
                window.state.isRecording = false;
                _renderCapRecorderState('idle');
                setTimeout(_refreshCapStrip, 60);
            });
        }
        // HC60 - Stop button: stop recording, KEEP the blob, show the
        // resume chip with the elapsed duration.
        const recStopBtn = document.getElementById('btn-v4-cap-recorder-stop');
        if (recStopBtn) {
            recStopBtn.addEventListener('click', () => {
                const dur = _fmtRecorderTimer(Date.now() - _capRecorderStartTs);
                _stopV4Recording();
                _renderCapRecorderState('stopped', { durationLabel: dur });
                setTimeout(_refreshCapStrip, 120);
            });
        }
        // HC70 (May 2026) - three explicit handlers on the resume chip:
        // Play / Re-record / Delete. Each is its own <button> in markup
        // so this code doesn't have to sniff the event target.

        // Play - preview the recorded audio before submitting. Uses a
        // closure-local <audio> element + Object URL pair; releases
        // the URL on stop/end/error so we don't leak memory across
        // repeated previews. The play button doubles as stop: the
        // glyph swaps via `.is-playing` class.
        const playBtn = document.getElementById('btn-v4-cap-recorder-play');
        if (playBtn) {
            let _audioEl = null;
            let _audioUrl = null;
            const _stopPlayback = () => {
                if (_audioEl) {
                    try { _audioEl.pause(); } catch (_) {}
                    try { _audioEl.src = ''; } catch (_) {}
                    _audioEl = null;
                }
                if (_audioUrl) {
                    try { URL.revokeObjectURL(_audioUrl); } catch (_) {}
                    _audioUrl = null;
                }
                playBtn.classList.remove('is-playing');
                const icon = playBtn.querySelector('i');
                if (icon) icon.className = 'fa-solid fa-play';
            };
            playBtn.addEventListener('click', () => {
                const blob = window.state && window.state.audioBlob;
                if (!blob || !blob.size) return;
                // Toggle: if currently playing, stop.
                if (_audioEl && !_audioEl.paused) {
                    _stopPlayback();
                    return;
                }
                try {
                    _audioUrl = URL.createObjectURL(blob);
                    _audioEl = new Audio(_audioUrl);
                    _audioEl.addEventListener('ended', _stopPlayback);
                    _audioEl.addEventListener('error', _stopPlayback);
                    _audioEl.play().then(() => {
                        playBtn.classList.add('is-playing');
                        const icon = playBtn.querySelector('i');
                        if (icon) icon.className = 'fa-solid fa-stop';
                    }).catch(() => _stopPlayback());
                } catch (_) {
                    _stopPlayback();
                }
            });
            // Expose stop so other paths (delete, re-record) can
            // cancel an in-flight preview before mutating the blob.
            window.__crispV4StopPlayback = _stopPlayback;
        }

        // Re-record - discard the old blob and start a fresh recording.
        const rerecordBtn = document.getElementById('btn-v4-cap-recorder-rerecord');
        if (rerecordBtn) {
            rerecordBtn.addEventListener('click', () => {
                // Cancel any in-progress playback before mutating state.
                try {
                    if (typeof window.__crispV4StopPlayback === 'function') {
                        window.__crispV4StopPlayback();
                    }
                } catch (_) {}
                window.state.audioBlob = null;
                window.state.audioChunks = [];
                _startV4Recording();
                _renderCapRecorderState('recording');
            });
        }

        // Delete - clear the blob + return to idle. HC70 also refreshes
        // the section badges so the green `is-captured` glow on the
        // `#v4-cap-chip-voice` trigger button resets correctly. (Pre-
        // HC70 only `_refreshCapStrip` was called, which paints photo
        // thumbs - the chip-voice badge stayed lit after delete.)
        const resumeDeleteBtn = document.getElementById('btn-v4-cap-recorder-resume-delete');
        if (resumeDeleteBtn) {
            resumeDeleteBtn.addEventListener('click', () => {
                try {
                    if (typeof window.__crispV4StopPlayback === 'function') {
                        window.__crispV4StopPlayback();
                    }
                } catch (_) {}
                window.state.audioBlob = null;
                window.state.audioChunks = [];
                _renderCapRecorderState('idle');
                // Explicit badge refresh - `_renderCapRecorderState`
                // doesn't know about chip-voice-status; this call
                // toggles `.is-captured` off the trigger button.
                try { _refreshSectionBadges(); } catch (_) {}
                setTimeout(_refreshCapStrip, 60);
            });
        }

        // Textarea - mirror to state.description + transcript so submit
        // sends whatever the user types (same contract as v3).
        if (capTextArea) {
            capTextArea.addEventListener('input', () => {
                _setState({
                    description: capTextArea.value,
                    transcript: capTextArea.value,
                });
                _refreshCapStrip();
            });
        }

        // Re-evaluate the capture-stage Continue button against the
        // current state and repaint the per-section status badges.
        // Named for back-compat with `window.__crispV4RefreshCapStrip`
        // call sites; no longer touches a chip strip (those elements
        // are gone - the compact Voice/Text chips above handle their
        // own UI).
        function _refreshCapStrip() {
            const s = window.state || {};
            const photos = (s.v4Photos && s.v4Photos.length) || (s.photoDataUrl ? 1 : 0);
            const audioOk = !!(s.audioBlob && s.audioBlob.size > 0)
                || !!(s.transcript && s.transcript.trim().length > 4);
            const anyTextLike = !!(s.description && s.description.trim().length > 0);
            const anyShown = (photos > 0) || audioOk || anyTextLike;
            if (nextBtn) {
                nextBtn.disabled = !anyShown;
                nextBtn.classList.toggle('is-ready', anyShown);
            }
            if (typeof window.__crispV4RefreshSectionBadges === 'function') {
                try { window.__crispV4RefreshSectionBadges(); } catch (_) {}
            }
        }

        // Initial paint + every stage entry to v4-capture re-paints.
        _refreshCapStrip();
        document.addEventListener('stage-entered', (e) => {
            const stage = typeof e.detail === 'string' ? e.detail : (e.detail?.stage || '');
            if (stage === 'stage-v4-capture') {
                _refreshCapStrip();
                // Defensive depth: derive the capture DOM (textarea + recorder)
                // from state on EVERY entry, so even a nav path that reaches
                // capture without firing a reset shows a state-consistent DOM
                // (and back-nav from classify preserves an in-progress capture).
                try { _renderV4FromState(); } catch (_) {}
            }
        });

        // Expose the refresh so the existing _handlePhoto + recording
        // helpers can fire it after they mutate state.
        window.__crispV4RefreshCapStrip = _refreshCapStrip;
        // HC97 - expose the smart camera entry so the review "+ Add" (and any
        // future Edit flow) routes through the SAME capability gate + custom
        // modal + multi-snap ingest + <input capture> fallback as Stage-1.
        window.__crispOpenCameraSmart = _openCameraSmart;

        function _renderThumbs() {
            const photos = _getState().v4Photos || [];
            if (!photos.length) {
                // Clear stale <img> thumbs (not just hide the row) so the
                // previous report's photo can't linger in the hidden DOM and
                // reappear on the next capture after "Report another".
                thumbsRow.innerHTML = '';
                thumbsRow.style.display = 'none';
                return;
            }
            thumbsRow.style.display = 'flex';
            // hide the `+` button entirely once at the cap.
            // Photo count badge (n/5) goes on the row regardless.
            const atCap = photos.length >= V4_MAX_PHOTOS;
            const addBtnHtml = atCap ? '' : `
                <button class="v4-thumb v4-thumb-add" id="v4-add-more" type="button"
                        aria-label="Add another photo">
                    <i class="fa-solid fa-plus"></i>
                </button>
            `;
            thumbsRow.innerHTML = photos.map((p, i) => `
                <div class="v4-thumb">
                    <img src="${p.url}" alt="">
                    <button class="v4-thumb-x" data-idx="${i}" type="button" aria-label="Remove">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            `).join('') + addBtnHtml + `
                <span class="v4-thumb-count" aria-live="polite">${photos.length}/${V4_MAX_PHOTOS}</span>
            `;
            thumbsRow.querySelectorAll('.v4-thumb-x').forEach((btn) => {
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
                    // HC66 - delegate state mutation to the shared
                    // helper (see _deleteV4PhotoAt at module top).
                    // Same primary-promotion + extraPhotos-sync
                    // behaviour, now shared with the review-stage
                    // photo strip.
                    _deleteV4PhotoAt(idx);
                    const state = _getState();
                    if (state.v4Photos.length === 0) {
                        nextBtn.disabled = true;
                        nextBtn.classList.remove('is-ready');
                    }
                    _renderThumbs();
                });
            });
            const addBtn = thumbsRow.querySelector('#v4-add-more');
            // `+` opens the Camera / Browse chooser instead
            // of jumping straight to a file picker on desktop.
            if (addBtn) addBtn.addEventListener('click', () => _openAddPhotoChooser());
        }
    }

    // prefer state.locationName (resolved by
    // reverseGeocode → Nominatim) over raw lat/lng. Falls back to coords
    // when offline or before the resolve completes. Triggers
    // resolveLocationName() asynchronously so the pill updates from
    // "12.97°, 77.59°" → "Koramangala, Bangalore" once the geocode lands.
    function _formatLocationLabel(loc, name) {
        if (name) return name;
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
            const acc = Math.max(0, Math.round(loc.acc || 0));
            return `${loc.lat.toFixed(4)}°, ${loc.lng.toFixed(4)}° · ±${acc}m`;
        }
        // i18n the "Locating…" status.
        const _t = (typeof window.t === 'function') ? window.t : ((k) => k);
        return _t('v4_gps_locating') || 'Locating…';
    }
    function _paintV4LocationPills() {
        const s = _getState();
        // prefer the user-typed name if present, then the
        // reverse-geocoded name, then the formatted coords. The coords
        // row in the new meta card is filled independently when GPS
        // resolves so the user can still see lat/lng even after they've
        // typed a custom landmark.
        const userName = s.userLocationName || '';
        const label = userName || _formatLocationLabel(s.location, s.locationName);
        const captureText = document.getElementById('v4-meta-location-text');
        const reviewText = document.getElementById('v4-row-location-text');
        // dir="auto" lets the browser detect Latin vs RTL per string,
        // paired with `unicode-bidi: isolate` in styles.css to fix the
        // AR/UR truncation-from-wrong-end bug for Latin location names.
        if (captureText) {
            captureText.textContent = label;
            captureText.setAttribute('dir', 'auto');
        }
        if (reviewText) {
            reviewText.textContent = label;
            reviewText.setAttribute('dir', 'auto');
        }
        // Coords sub-line.
        // AUDIT 2026-05-23 - the raw decimal coords "12.9716°, 77.5946°"
        // added cognitive load for non-technical disaster victims.
        // Default behaviour now: show accuracy only ("±20 m"), hide
        // the decimal coords. The technical view is preserved behind
        // `localStorage.crisp_tech_user = 'on'` for operator demos.
        const coordsEl = document.getElementById('v4-meta-loc-coords');
        if (coordsEl) {
            const loc = s.location;
            const techMode = (() => {
                try { return localStorage.getItem('crisp_tech_user') === 'on'; }
                catch { return false; }
            })();
            if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
                const acc = Math.max(0, Math.round(loc.acc || 0));
                if (techMode) {
                    coordsEl.textContent =
                        `${loc.lat.toFixed(4)}°, ${loc.lng.toFixed(4)}°` +
                        (acc > 0 ? ` · ±${acc} m` : '');
                } else {
                    coordsEl.textContent = acc > 0 ? `±${acc} m` : '';
                }
            } else {
                coordsEl.textContent = '';
            }
        }
    }

    // Live timestamp + timezone in the meta card. For crisis
    // forensics responders need the literal capture time, not "Just
    // now". Paints
    //   YYYY-MM-DD HH:MM:SS TZ
    // on stage-v4-capture entry and refreshes every second while the
    // user is on that stage so it stays current. Interval cleared
    // when the user navigates away.
    let _v4CapTimeInterval = null;
    // May 2026 - three-line timestamp. Was a single line like
    // "2026-05-12 22:39:35 GMT+5:30" which buried the meaningful
    // bits behind a numeric offset operators don't recognise at a
    // glance. New layout (top → bottom):
    //   • IANA timezone name           e.g. "Asia/Kolkata"
    //   • Human-readable timezone      e.g. "India Standard Time"
    //   • Local 12-hour clock          e.g. "10:42 PM"
    // All three drawn from Intl.DateTimeFormat - supported by every
    // PWA-target browser (Chrome 24+, Safari 10+, Firefox 29+, every
    // Android WebView since 2016). Locale follows navigator.language
    // so non-English PWA users get a label in their own language
    // ("Heure normale d'Inde", "Indische Standardzeit" etc.); we
    // pass `'en'` only as a fallback if Intl rejects the auto-detected
    // locale. Falls back gracefully on the rare browser without
    // timeZoneName 'long' support.
    function _paintCaptureTimestamp() {
        // Local-clock slot (kept the legacy id so any existing
        // selector pinned to #v4-meta-time-text still finds something).
        const elClock = document.getElementById('v4-meta-time-text');
        const elIana  = document.getElementById('v4-meta-time-tz-iana');
        const elLabel = document.getElementById('v4-meta-time-tz-label');
        if (!elClock && !elIana && !elLabel) return;
        const now = new Date();
        const browserLocale = (typeof navigator !== 'undefined' && navigator.language) || 'en';

        // 1. IANA timezone name - resolvedOptions.timeZone returns the
        // current zone in canonical form ("Asia/Kolkata"). On the rare
        // browser that returns "UTC" or an empty string we fall back
        // to a synthesised offset label.
        let iana = '';
        try {
            iana = new Intl.DateTimeFormat(browserLocale).resolvedOptions().timeZone || '';
        } catch (_) {}
        if (!iana) {
            const offMin = -now.getTimezoneOffset();
            const sign = offMin >= 0 ? '+' : '-';
            const abs = Math.abs(offMin);
            const hh = String(Math.floor(abs / 60)).padStart(2, '0');
            const mm = String(abs % 60).padStart(2, '0');
            iana = `UTC${sign}${hh}:${mm}`;
        }

        // 2. Human-readable timezone label - timeZoneName 'long' gives
        // the full name ("India Standard Time", "Pacific Daylight
        // Time"). Fallback to 'short' (IST, PDT) if the long form
        // isn't supported, then to the offset.
        let label = '';
        try {
            const longParts = new Intl.DateTimeFormat(browserLocale, {
                timeZoneName: 'long',
            }).formatToParts(now);
            label = (longParts.find((p) => p.type === 'timeZoneName') || {}).value || '';
        } catch (_) {}
        if (!label) {
            try {
                const shortParts = new Intl.DateTimeFormat(browserLocale, {
                    timeZoneName: 'short',
                }).formatToParts(now);
                label = (shortParts.find((p) => p.type === 'timeZoneName') || {}).value || '';
            } catch (_) {}
        }
        if (!label) label = iana;  // last-ditch fallback

        // 3. Local 12-hour clock - "10:42 PM". hour: 'numeric' (not
        // '2-digit') so we get "9:05 PM" instead of "09:05 PM", which
        // matches the operator's mental model.
        let clock = '';
        try {
            clock = new Intl.DateTimeFormat(browserLocale, {
                hour: 'numeric', minute: '2-digit', hour12: true,
            }).format(now);
        } catch (_) {
            const h = now.getHours();
            const m = String(now.getMinutes()).padStart(2, '0');
            const h12 = h % 12 || 12;
            clock = `${h12}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
        }

        // AUDIT 2026-05-23 - default to single-line "10:42 PM · India
        // Standard Time" for citizen reporters. The IANA name
        // ("Asia/Kolkata") is technical noise - useful for operator
        // forensics, useless for a panicked first-time reporter.
        // Surface it only when `localStorage.crisp_tech_user = 'on'`.
        const techMode = (() => {
            try { return localStorage.getItem('crisp_tech_user') === 'on'; }
            catch { return false; }
        })();
        if (elIana)  elIana.textContent  = techMode ? iana : '';
        if (elIana)  elIana.style.display = techMode ? '' : 'none';
        if (elLabel) elLabel.textContent = label;
        if (elClock) elClock.textContent = clock;
    }
    function _startCaptureTimer() {
        _paintCaptureTimestamp();
        if (_v4CapTimeInterval) clearInterval(_v4CapTimeInterval);
        _v4CapTimeInterval = setInterval(_paintCaptureTimestamp, 1000);
    }
    function _stopCaptureTimer() {
        if (_v4CapTimeInterval) {
            clearInterval(_v4CapTimeInterval);
            _v4CapTimeInterval = null;
        }
    }
    document.addEventListener('stage-entered', (e) => {
        const stage = typeof e.detail === 'string' ? e.detail : (e.detail?.stage || '');
        if (stage === 'stage-v4-capture') _startCaptureTimer();
        else _stopCaptureTimer();
    });
    // Re-paint whenever state.locationName resolves. v3's
    // _paintLocationDisplays runs on resolveLocationName completion; we
    // listen for the same gps-ready / location-resolved hooks plus
    // re-paint on every stage-entered to handle direct nav.
    document.addEventListener('gps-ready', _paintV4LocationPills);
    document.addEventListener('location-resolved', _paintV4LocationPills);
    document.addEventListener('stage-entered', (e) => {
        const stage = typeof e.detail === 'string' ? e.detail : (e.detail?.stage || '');
        if (stage === 'stage-v4-capture' || stage === 'stage-v4-review') {
            _paintV4LocationPills();
        }
    });

    // ── Crisis-pack swap → repaint the classify flow ─────────────────────
    // _maybeFetchCrisisPack swaps state.crisisPack ASYNCHRONOUSLY (notably after
    // the reporter edits the location and _onLocationReeval re-resolves the zone)
    // and fires 'crisis-pack-resolved'. _setState is non-reactive, so without this
    // listener the new zone's pack would never reach the DOM while the user is on
    // the classify stage - the stale device-zone questions would persist (the
    // reported "device-location form is still visible" bug). Re-assert the current
    // sub-step against the RECOMPUTED order so the visible crispack view (and
    // whether the step exists at all) reflects the EDITED location. No-op off the
    // classify stage - capture/review re-derive on their own entry.
    document.addEventListener('crisis-pack-resolved', () => {
        try {
            const stageEl = document.getElementById('stage-v4-classify');
            if (!stageEl || !stageEl.classList.contains('active')) return;
            const order = _classifyOrder();
            // If the current sub-step vanished (the edited zone dropped the
            // crispack or crisis-chip step), fall back to the last valid step
            // rather than stranding the reporter on a now-hidden view; otherwise
            // re-render the current view from the swapped state.
            const step = order.indexOf(_classifyStep) >= 0 ? _classifyStep : order[order.length - 1];
            _showSubStep(step);
            _refreshClassifyNext();
        } catch (_) {}
    });

    // userInitiated = the reporter tapped the GPS-refresh button (vs an automatic
    // capture-stage entry). Only a user-initiated MATERIAL move re-runs the
    // authoritative re-eval (which clears the previous zone's answers + toasts) -
    // an automatic re-fetch where the cached fix and the fresh fix differ by
    // >110 m must NOT spuriously fire "crisis form refreshed" on stage entry.
    function _refreshGps(userInitiated) {
        const text = document.getElementById('v4-meta-location-text');
        if (!text) return;
        // i18n the status strings.
        const _t = (typeof window.t === 'function') ? window.t : ((k) => k);
        const LOCATING = _t('v4_gps_locating') || 'Locating…';
        const UNAVAILABLE = _t('v4_gps_unavailable') || 'GPS unavailable';
        const current = _getState();
        text.textContent = current.locationName || LOCATING;

        // v7 (May 2026, operator bug) - "GPS shows not available when I
        // start reporting." Root cause: the error path of the prior
        // implementation just set "GPS unavailable" with NO fallback,
        // even though we already cache fresh GPS in localStorage via
        // nearby.js (`crisp_last_location_v2`) and have an IP-geo
        // fallback (`window.tryIPGeolocation`) wired in app.js.
        //
        // New fallback chain:
        //   1. navigator.geolocation.getCurrentPosition (fresh, accurate)
        //   2. localStorage cached GPS (instant, populated by prior runs)
        //   3. window.tryIPGeolocation() (network-based coarse fallback)
        //   4. only NOW show "GPS unavailable"
        //
        // Cache writeback: every successful fresh fix updates
        // `crisp_last_location_v2` so the home-stage nearby intel +
        // any future capture sees the freshest value.

        function _readCachedGps() {
            const keys = ['crisp_last_location_v2', 'crisp_last_location'];
            for (const k of keys) {
                try {
                    const raw = localStorage.getItem(k);
                    if (!raw) continue;
                    const obj = JSON.parse(raw);
                    const lat = obj.lat ?? obj.latitude;
                    const lng = obj.lng ?? obj.longitude;
                    const ts = obj.ts ?? obj.timestamp ?? 0;
                    // 30-min staleness gate - same as nearby.js.
                    if (typeof lat === 'number' && typeof lng === 'number'
                        && Date.now() - ts < 30 * 60 * 1000) {
                        return { lat, lng, acc: obj.acc || obj.accuracy || 100 };
                    }
                } catch (_) {}
            }
            return null;
        }

        function _writeCachedGps(lat, lng, acc) {
            try {
                localStorage.setItem('crisp_last_location_v2', JSON.stringify({
                    lat, lng, acc, ts: Date.now(),
                }));
            } catch (_) {}
        }

        // ── Dynamic Crisis Forms (geo-gate) ──────────────────────────────────
        // Once a Stage-1 location is fixed, ask the backend whether a
        // crisis-specific Stage 2/3 question pack is active for THIS point right
        // now. The answer is cached on state.crisisPack for the renderer to
        // consume. This call is intentionally inert with respect to the default
        // flow: on {active:false}, offline, or any error we leave/clear
        // crisisPack and the existing hardcoded Stage 2/3 runs UNCHANGED
        // (fail-safe). Idempotent to ~110 m so it fires at most once per spot.
        let _crisisPackKey = null;
        function _maybeFetchCrisisPack(loc) {
            try {
                if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return;
                const key = loc.lat.toFixed(3) + ',' + loc.lng.toFixed(3);
                if (key === _crisisPackKey) return;   // already resolved for ~here
                _crisisPackKey = key;
                const base = window.API_BASE;
                if (!base) return;
                const url = base + '/crisis-forms/active?lat=' + encodeURIComponent(loc.lat)
                    + '&lng=' + encodeURIComponent(loc.lng);
                // Expose the in-flight resolution so _onSend can await it before
                // assembling the payload - a fast edit→send must not ship the stale
                // device-zone form_pack_id/version/form_data (the server only
                // backstops crisis_event_id, not the form pack). Cleared on settle.
                const _p = fetch(url, { headers: { Accept: 'application/json' } })
                    .then((r) => (r && r.ok ? r.json() : null))
                    .then((data) => {
                        if (data && data.active && data.schema_json) {
                            const patch = { crisisPack: {
                                pack_id: data.pack_id, pack_version: data.pack_version,
                                event_id: data.event_id, crisis_type: data.crisis_type,
                                schema: data.schema_json,
                            } };
                            // The active zone already knows the crisis type - auto-set the
                            // canonical field so the "what caused it" sub-step is skipped.
                            // GUARD: only when the event's type is a canonical CrisisTypeEnum
                            // the PWA offers (must-have #5). A non-canonical, display-only event
                            // type (e.g. 'LANDSLIDE') leaves crisis_type unset → the crisis chip
                            // step stays so the reporter picks a valid type.
                            const _CANON = { EARTHQUAKE: 1, FLOOD: 1, TSUNAMI: 1, CYCLONE: 1,
                                WILDFIRE: 1, EXPLOSION: 1, CHEMICAL_INCIDENT: 1, CONFLICT: 1, CIVIL_UNREST: 1 };
                            if (data.crisis_type && _CANON[data.crisis_type]) {
                                patch.crisis_type = data.crisis_type;
                                patch._crisisTypeAuto = true;   // zone-derived → clearable on a later swap
                            } else if (_getState()._crisisTypeAuto) {
                                // New zone has a non-canonical type → drop the stale
                                // auto-applied type from the PREVIOUS zone (Bangalore→Chennai).
                                patch.crisis_type = null;
                                patch._crisisTypeAuto = false;
                            }
                            _setState(patch);
                        } else {
                            // No active zone here → drop the pack AND any crisis_type we
                            // auto-applied from a previous zone, so the "what caused it"
                            // chip step returns. A hand-picked crisis_type is preserved.
                            const patch = { crisisPack: null };
                            if (_getState()._crisisTypeAuto) {
                                patch.crisis_type = null;
                                patch._crisisTypeAuto = false;
                            }
                            _setState(patch);
                        }
                        document.dispatchEvent(new CustomEvent('crisis-pack-resolved'));
                    })
                    .catch(() => { /* offline / error → default flow (fail-safe) */ })
                    .finally(() => { if (window.__crispV4PackInFlight === _p) window.__crispV4PackInFlight = null; });
                window.__crispV4PackInFlight = _p;
            } catch (_) {}
        }

        // Authoritative re-evaluation when the reporter EDITS the location (place
        // search / edit-after-capture). The edited location is the source of truth:
        // force a fresh crisis-forms/active match (overriding the ~110 m jitter
        // guard), drop the previous zone's stock answers so the renderer can't paint
        // stale questions, then confirm. The pack + crisis_type re-apply (or clear)
        // inside _maybeFetchCrisisPack; the crispack sub-step re-renders on the
        // 'crisis-pack-resolved' event.
        function _onLocationReeval(lat, lng) {
            try {
                _crisisPackKey = null;                    // an explicit edit overrides the jitter guard
                _setState({ crisisStockAnswers: {} });    // clear the previous zone's answers
                _maybeFetchCrisisPack({ lat: lat, lng: lng });
                // Localize against window.t (the module-scope _tt helper lives in a
                // different function); fall back to EN if the key is unresolved.
                const _K = 'v4_location_pack_refreshed';
                const _EN = 'Location updated. Applicable crisis form has been refreshed based on the new location.';
                let msg = _EN;
                try {
                    const _fn = window.t;
                    if (typeof _fn === 'function') { const v = _fn(_K); if (v && v !== _K) msg = v; }
                } catch (_) {}
                // showToast(message, duration_ms) - pass a numeric dwell, NOT a type
                // string (a string coerces to NaN → the toast vanishes instantly).
                if (typeof window.showToast === 'function') window.showToast(msg, 3500);
            } catch (_) {}
        }
        window.__crispV4OnLocationReeval = _onLocationReeval;

        // Apply cached GPS IMMEDIATELY as a fallback so the user sees
        // a location instantly - fresh fix will overwrite if it lands.
        const cached = _readCachedGps();
        if (cached && !current.location) {
            _setState({ location: cached });
            _paintV4LocationPills();
            _maybeFetchCrisisPack(cached);
        }

        // After fresh + cache both fail, try IP geo. async.
        function _tryIpFallback() {
            const fn = window.tryIPGeolocation;
            if (typeof fn !== 'function') {
                text.textContent = current.locationName || UNAVAILABLE;
                return;
            }
            fn().then((coords) => {
                if (coords && typeof coords.lat === 'number') {
                    _setState({ location: coords });
                    _writeCachedGps(coords.lat, coords.lng, coords.acc || 5000);
                    _paintV4LocationPills();
                    _maybeFetchCrisisPack(coords);
                } else if (!cached) {
                    // No fresh, no cache, no IP - give up.
                    text.textContent = current.locationName || UNAVAILABLE;
                }
            }).catch(() => {
                if (!cached) text.textContent = current.locationName || UNAVAILABLE;
            });
        }

        if (!navigator.geolocation) {
            // No geo API at all - IP fallback if we don't already have cache.
            if (!cached) _tryIpFallback();
            return;
        }

        navigator.geolocation.getCurrentPosition((pos) => {
            const { latitude, longitude, accuracy } = pos.coords;
            const _prev = _getState().location;
            _setState({ location: { lat: latitude, lng: longitude, acc: accuracy } });
            _writeCachedGps(latitude, longitude, accuracy);
            _paintV4LocationPills();
            // A user-initiated GPS refresh that lands in a DIFFERENT ~110 m cell is a
            // material move → authoritative re-eval (re-runs matching, clears the
            // previous zone's stock answers, toasts). A same-spot refresh, a first
            // fix (no prior), or any automatic entry just (re)fetches the pack - no
            // answer loss, no spurious toast (the jitter guard makes it a no-op).
            const _key = (l) => (l && Number.isFinite(l.lat) && Number.isFinite(l.lng))
                ? (l.lat.toFixed(3) + ',' + l.lng.toFixed(3)) : null;
            const _movedMaterially = !!_prev && _key(_prev) !== null
                && _key(_prev) !== _key({ lat: latitude, lng: longitude });
            if (userInitiated && _movedMaterially && typeof _onLocationReeval === 'function') {
                _onLocationReeval(latitude, longitude);
            } else {
                _maybeFetchCrisisPack({ lat: latitude, lng: longitude, acc: accuracy });
            }
            (async () => {
                try {
                    if (typeof window.resolveLocationName === 'function') {
                        await window.resolveLocationName();
                    } else if (typeof window.reverseGeocode === 'function') {
                        const name = await window.reverseGeocode(latitude, longitude);
                        if (name) _setState({ locationName: name });
                    }
                } catch (e) {
                    console.warn('[v4] reverse geocode failed:', e);
                }
                _paintV4LocationPills();
                document.dispatchEvent(new CustomEvent('location-resolved'));
            })();
        }, (err) => {
            console.warn('[v4] GPS failed:', err && err.code, err && err.message);
            // Fresh fetch failed. If we already have cached or set, KEEP it
            // and silently move on - no "unavailable" placeholder.
            if (cached) return;
            // No cache → IP fallback.
            _tryIpFallback();
        }, {
            // v7 - maximumAge bumped 60_000 → 300_000 so the browser's
            // own GPS cache (which may already hold a 4-minute-old fix)
            // resolves instantly instead of triggering a fresh hardware
            // poll that may fail on Wi-Fi-only laptops / shaky permission.
            enableHighAccuracy: true,
            timeout: 8000,
            maximumAge: 300000,
        });
    }

    // ── Page 2: classify ──────────────
    //
    // Single-question per sub-view. _classifyStep ∈ {'damage','infra','crisis'}
    // drives which .v4-classify-view is visible. Continue advances; Back
    // either returns to a previous sub-step or pops out to capture.
    //
    // Crisis sub-step renders as a single flat grid (May 2026 rewrite -
    // was a drill-down with group cards + subtype-list; operator
    // flagged the extra click). All 9 crisis types visible at once,
    // organised under 3 visual section headers. Same i18n keys + same
    // server contract (single `state.crisis_type` UNDP enum value).
    const CRISIS_GROUPS = {
        natural: [
            { v: 'EARTHQUAKE', i: 'fa-house-crack', k: 'crisis_earthquake' },
            { v: 'FLOOD',      i: 'fa-water',       k: 'crisis_flood' },
            { v: 'TSUNAMI',    svg: '<path d="M2 17c3 0 4-3 8-3s5 3 9 3"/><path d="M2 21c3 0 4-3 8-3s5 3 9 3"/><path d="M9 14c0-3 1-5 3-7l4 8"/>', k: 'crisis_tsunami' },
            // UNDP wording is "Hurricane/Cyclone" - one category. CYCLONE
            // is the canonical wire-format enum (matches backend +
            // dashboard). The i18n key keeps its historical name; only
            // its English VALUE changed to "Hurricane / Cyclone".
            { v: 'CYCLONE',    i: 'fa-wind',        k: 'crisis_hurricane' },
            { v: 'WILDFIRE',   svg: '<path d="M8 21h8"/><path d="M12 21v-3"/><path d="M9 18a4 4 0 0 1-2-3c0-3 3-4 3-7 0 3 4 3 4 7a4 4 0 0 1-2 3"/><path d="M11 11c-1-1-1-2 0-4 1 2 2 2 2 4"/>', k: 'crisis_wildfire' },
        ],
        tech: [
            { v: 'EXPLOSION',         i: 'fa-explosion', k: 'crisis_explosion' },
            { v: 'CHEMICAL_INCIDENT', svg: '<path d="M12 3 2 21h20Z"/><path d="M12 9v4"/><circle cx="12" cy="17" r="0.6"/>', k: 'crisis_chemical' },
        ],
        human: [
            { v: 'CONFLICT',     svg: '<path d="m14 4 6 6-2 2-6-6 2-2Z"/><path d="m4 20 6-6 2 2-6 6-2-2Z"/><path d="m20 14-6-6 2-2 6 6-2 2Z"/><path d="m4 4 6 6-2 2-6-6 2-2Z"/>', k: 'crisis_conflict' },
            { v: 'CIVIL_UNREST', i: 'fa-people-group', k: 'crisis_unrest' },
        ],
    };
    const CLASSIFY_ORDER = ['damage', 'infra', 'crisis'];

    // Phase F image-reliability follow-up (May 2026) - derive severity
    // from the user's damage pick. The v3 capture flow had
    // `_v3AutoDeriveSeverity()` at app.js:~3234 doing this automatically;
    // it's gated on `UI_V3_ENABLED` so it never fires for v4. Without
    // this, v4 reports landed with `state.severity = null` → enqueue
    // sent severity: null → Pydantic 422 → offline queue retried forever
    // → "queued at 25%" (operator-reported May 19 via HAR file).
    // Mirrors the v3 map verbatim so behaviour is unchanged for v3 + v4.
    const _V4_DAMAGE_TO_SEVERITY = {
        MINIMAL:   'MINOR',
        PARTIAL:   'MODERATE',
        COMPLETE:  'SEVERE',
        // Legacy values still accepted by the schema; v4 UI doesn't show
        // them but a future flow / migration might still produce them.
        NO_DAMAGE: 'MINOR',
        DESTROYED: 'SEVERE',
    };
    function _v4ApplyDamage(damageValue) {
        const derived = _V4_DAMAGE_TO_SEVERITY[damageValue] || 'MODERATE';
        _setState({ damage_classification: damageValue, severity: derived });
    }

    // ── Dynamic Crisis Forms - Stage 2/3 pack renderer (geo-gated) ─────────
    // When state.crisisPack is active (set by _maybeFetchCrisisPack on the
    // location fix), a 4th classify sub-step 'crisispack' renders the pack's
    // EXTRA questions - the stock (non-maps_to) questions PLUS any maps_to
    // field the default chips don't already collect (e.g. debris_clearing_
    // needed). The hardcoded damage/infra/crisis chips are untouched and keep
    // populating the canonical fields for must-have #1 parity.
    const _CP_DEFAULT_CAPTURED = { damage_classification: 1, infrastructure_type: 1, crisis_type: 1, severity: 1 };
    const _CP_BASE_TYPES = { yes_no: 1, single_select: 1, multi_select: 1, short_text: 1, long_text: 1, integer: 1 };
    function _classifyOrder() {
        const s = window.state || {};
        if (s.crisisPack && s.crisisPack.schema) {
            const order = ['damage', 'infra'];
            // Skip "what caused it" when the active zone already auto-set a
            // canonical crisis_type (the reporter is inside a known-crisis zone).
            // Keep it as a fallback when the event's type wasn't canonical (so
            // crisis_type stayed unset) - must-have #5 always holds.
            if (!s.crisis_type) order.push('crisis');
            // Add the extra pack sub-step only when the pack has questions the
            // default chips don't already capture; a pure-core pack still records
            // form_pack_id at submit but needs no extra UI.
            if (_crisisPackFields().length > 0) order.push('crisispack');
            return order;
        }
        return CLASSIFY_ORDER;   // ['damage','infra','crisis'] - default flow, unchanged
    }
    // Re-derive the canonical crisis_type from an active zone's pack. crisisPack
    // SURVIVES _clearCaptureState (add-another) but state.crisis_type is nulled
    // (app.js:15241) - without this, the skipped "what caused it" step would
    // resurrect on the 2nd report in the same zone. Idempotent + canonical-guarded
    // (must-have #5: a non-canonical event type stays unset → crisis chip shown).
    const _CANON_CRISIS = { EARTHQUAKE: 1, FLOOD: 1, TSUNAMI: 1, CYCLONE: 1, WILDFIRE: 1,
        EXPLOSION: 1, CHEMICAL_INCIDENT: 1, CONFLICT: 1, CIVIL_UNREST: 1 };
    function _ensureZoneCrisisType() {
        const s = window.state || {};
        const cp = s.crisisPack;
        if (cp && cp.crisis_type && _CANON_CRISIS[cp.crisis_type] && s.crisis_type !== cp.crisis_type) {
            _setState({ crisis_type: cp.crisis_type });
        }
    }
    function _crisisPackFields() {
        const s = window.state || {};
        const cp = s.crisisPack;
        if (!cp || !cp.schema) return [];
        const out = [];
        (cp.schema.sections || []).forEach((sec) => (sec.fields || []).forEach((f) => {
            if (!f || !f.key || !_CP_BASE_TYPES[f.type]) return;       // skip special types
            if (f.maps_to && _CP_DEFAULT_CAPTURED[f.maps_to]) return;  // captured by chips
            out.push(f);
        }));
        return out;
    }
    // Does the active crisis-form pack already ask the debris question? A field
    // that maps_to 'debris_clearing_needed' means the DEPLOYED form collects
    // debris (the answer becomes report.debris_clearing_needed at submit, via the
    // crisispack sub-step). When it does, the standalone REQUIRED debris card on
    // the review surface is a duplicate - suppress it + skip its submit gate.
    function _packCollectsDebris() {
        const s = window.state || {};
        const cp = s.crisisPack;
        if (!cp || !cp.schema) return false;
        return (cp.schema.sections || []).some((sec) =>
            (sec.fields || []).some((f) => f && f.maps_to === 'debris_clearing_needed'));
    }
    window.__crispV4PackCollectsDebris = _packCollectsDebris;
    function _cpI18n(obj, fallback) {
        const lang = (window.state && window.state.lang) || 'en';
        if (obj && typeof obj === 'object') {
            if (obj[lang]) return obj[lang];
            if (obj.en) return obj.en;
        }
        return fallback;
    }
    function _cpLabel(field) {
        // 1) translations embedded in the pack (label_i18n) win; 2) else a static
        // i18n key - `cp_<fieldkey>` (the crisis-pack convention) then the bare
        // <fieldkey>; 3) else the plain English label. Stock packs ship English
        // `label` only, so the static `cp_*` keys are what localizes them.
        const fromI18n = _cpI18n(field.label_i18n, null);
        if (fromI18n) return fromI18n;
        if (typeof window.t === 'function') {
            const keys = ['cp_' + field.key, field.key];
            for (let i = 0; i < keys.length; i++) {
                const tv = window.t(keys[i]);
                if (tv && tv !== keys[i]) return tv;
            }
        }
        return field.label || field.key;
    }
    function _cpOptLabel(opt, fieldKey) {
        // Mirror _cpLabel for select options: embedded `label_i18n` → static key
        // `cpopt_<fieldkey>_<VALUE>` → plain English label.
        const fromI18n = _cpI18n(opt.label_i18n, null);
        if (fromI18n) return fromI18n;
        if (fieldKey && typeof window.t === 'function') {
            const k = 'cpopt_' + fieldKey + '_' + opt.value;
            const tv = window.t(k);
            if (tv && tv !== k) return tv;
        }
        return opt.label || opt.value;
    }
    function _cpYesNo(which) {
        const k = which === 'yes' ? 'v4_yes' : 'v4_no';
        const fb = which === 'yes' ? 'Yes' : 'No';
        return (typeof window.t === 'function' ? (window.t(k) || fb) : fb);
    }
    function _cpSetAnswer(key, type, raw, btnEl, qEl) {
        const s = window.state || {};
        const ans = Object.assign({}, s.crisisStockAnswers || {});
        if (type === 'yes_no') {
            ans[key] = (raw === 'true');
            if (qEl) qEl.querySelectorAll('.v4-q-opt').forEach((x) => x.classList.toggle('is-selected', x === btnEl));
        } else if (type === 'single_select') {
            ans[key] = raw;
            if (qEl) qEl.querySelectorAll('.v4-q-opt').forEach((x) => x.classList.toggle('is-selected', x === btnEl));
        } else if (type === 'multi_select') {
            const arr = Array.isArray(ans[key]) ? ans[key].slice() : [];
            const i = arr.indexOf(raw);
            if (i >= 0) arr.splice(i, 1); else arr.push(raw);
            ans[key] = arr;
            if (btnEl) btnEl.classList.toggle('is-selected');
        } else if (type === 'integer') {
            const n = parseInt(raw, 10);
            ans[key] = isNaN(n) ? null : n;
        } else {            // short_text / long_text
            ans[key] = raw;
        }
        _setState({ crisisStockAnswers: ans });
        _refreshClassifyNext();
    }
    function _renderCrisisPackView() {
        const view = document.getElementById('v4-view-crisispack');
        if (!view) return;
        const s = window.state || {};
        const cp = s.crisisPack || {};
        const ans = s.crisisStockAnswers || {};
        const fields = _crisisPackFields();
        const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
        const heading = esc((cp.schema && _cpI18n(cp.schema.title_i18n, cp.schema.title)) || '');
        let html = heading ? `<h1 class="v4-q-question"><span>${heading}</span></h1>` : '';
        html += '<div class="v4-cp-list">';
        fields.forEach((f) => {
            const cur = ans[f.key];
            html += `<div class="v4-cp-q" data-key="${esc(f.key)}" data-type="${esc(f.type)}">`;
            html += `<div class="v4-cp-label">${esc(_cpLabel(f))}${f.required ? ' <span class="v4-cp-req">*</span>' : ''}</div>`;
            if (f.type === 'yes_no') {
                html += `<div class="v4-cp-opts">
                    <button type="button" class="v4-q-opt v4-cp-opt${cur === true ? ' is-selected' : ''}" data-val="true"><span>${esc(_cpYesNo('yes'))}</span></button>
                    <button type="button" class="v4-q-opt v4-cp-opt${cur === false ? ' is-selected' : ''}" data-val="false"><span>${esc(_cpYesNo('no'))}</span></button>
                </div>`;
            } else if (f.type === 'single_select' || f.type === 'multi_select') {
                const isMulti = f.type === 'multi_select';
                // Compact 2-col grid for short option sets to cut scroll.
                const gridCls = ((f.options || []).length <= 4) ? ' is-grid' : '';
                html += '<div class="v4-cp-opts' + gridCls + '">' + (f.options || []).map((o) => {
                    const sel = isMulti ? (Array.isArray(cur) && cur.indexOf(o.value) >= 0) : (cur === o.value);
                    return `<button type="button" class="v4-q-opt v4-cp-opt${sel ? ' is-selected' : ''}" data-val="${esc(o.value)}"><span>${esc(_cpOptLabel(o, f.key))}</span></button>`;
                }).join('') + '</div>';
            } else if (f.type === 'integer') {
                html += `<input type="number" inputmode="numeric" class="v4-cp-input" />`;
            } else {
                const tag = f.type === 'long_text' ? 'textarea' : 'input';
                html += `<${tag} class="v4-cp-input"${f.type === 'short_text' ? ' type="text"' : ''}></${tag}>`;
            }
            html += '</div>';
        });
        html += '</div>';
        view.innerHTML = html;
        // Wire inputs.
        view.querySelectorAll('.v4-cp-q').forEach((q) => {
            const key = q.getAttribute('data-key');
            const type = q.getAttribute('data-type');
            if (type === 'yes_no' || type === 'single_select' || type === 'multi_select') {
                q.querySelectorAll('.v4-cp-opt').forEach((b) => b.addEventListener('click',
                    () => _cpSetAnswer(key, type, b.getAttribute('data-val'), b, q)));
            } else {
                const inp = q.querySelector('.v4-cp-input');
                if (!inp) return;
                if (ans[key] != null) inp.value = ans[key];
                inp.addEventListener('input', () => _cpSetAnswer(key, type, inp.value, null, q));
            }
        });
    }

    function _initClassifyStage() {
        // ── Damage radio (sub-view 1) ──
        const damageView = document.getElementById('v4-view-damage');
        const damageOpts = damageView ? Array.from(damageView.querySelectorAll('.v4-q-opt')) : [];
        damageOpts.forEach((opt) => {
            opt.addEventListener('click', () => {
                damageOpts.forEach((o) => {
                    o.classList.remove('is-selected');
                    o.classList.remove('is-tap-confirmed');
                    o.setAttribute('aria-checked', 'false');
                });
                opt.classList.add('is-selected');
                opt.setAttribute('aria-checked', 'true');
                _v4ApplyDamage(opt.getAttribute('data-value'));
                _updateReviewSummary();
                _refreshClassifyNext();
                // Auto-progress to "What was hit?" after a 200ms
                // confirmation pulse. Race-guarded.
                _scheduleClassifyAdvance('damage', opt);
            });
        });
        // Default selected = the one already with .is-selected (Partial).
        const defaultOpt = damageOpts.find((o) => o.classList.contains('is-selected'));
        if (defaultOpt) _v4ApplyDamage(defaultOpt.getAttribute('data-value'));

        // Infra tiles (sub-view 2). Tap a tile to mark selection;
        // user taps Continue to advance. No auto-advance anywhere in
        // the classify flow - it surprised low-literacy users and
        // made it impossible to undo a mis-tap. _refreshClassifyNext()
        // is called explicitly so the Continue button enables on first
        // tap (a `_setState` wrap-and-reassign is a silent no-op against
        // a const binding, so direct invocation is the right contract).
        const infraView = document.getElementById('v4-view-infra');
        const infraTiles = infraView ? Array.from(infraView.querySelectorAll('.v4-hit-tile')) : [];
        const otherPrompt = document.getElementById('v4-infra-other-prompt');
        const otherInput = document.getElementById('v4-infra-other-input');
        infraTiles.forEach((tile) => {
            tile.addEventListener('click', () => {
                infraTiles.forEach((t) => {
                    t.classList.remove('is-selected');
                    t.classList.remove('is-tap-confirmed');
                    t.setAttribute('aria-checked', 'false');
                });
                tile.classList.add('is-selected');
                tile.setAttribute('aria-checked', 'true');
                const value = tile.getAttribute('data-value');
                _setState({ infrastructure_type: value });
                // UNDP "Other, please specify": reveal the free-text input
                // when OTHER is selected; hide it (and clear any stale text)
                // when any other tile is selected.
                if (otherPrompt && otherInput) {
                    if (value === 'OTHER') {
                        otherPrompt.removeAttribute('hidden');
                        setTimeout(() => { try { otherInput.focus(); } catch (_) {} }, 60);
                    } else {
                        otherPrompt.setAttribute('hidden', '');
                        otherInput.value = '';
                        _setState({ infrastructure_name: null });
                    }
                }
                _updateReviewSummary();
                _refreshClassifyNext();
                // Auto-progress to "What caused it?" after a 200ms
                // confirmation pulse. OTHER tile bypasses the navigate
                // step (still pulses) - advance waits for Enter/blur on
                // the free-text input. See _wireInfraOtherAdvance.
                _scheduleClassifyAdvance('infra', tile);
            });
        });
        if (otherInput) {
            otherInput.addEventListener('input', () => {
                _setState({ infrastructure_name: otherInput.value });
                _refreshClassifyNext();
            });
        }
        // Wire Enter/blur auto-advance for the OTHER free-text input
        // - see helper above. Idempotent (sets a sentinel on the
        // element so repeat init calls don't double-bind).
        _wireInfraOtherAdvance();

        // ── Crisis tiles, flat layout (sub-view 3) - May 2026 ──
        //
        // Operator-reported: the previous 3-group drill-down (tap
        // Natural → see Earthquake/Flood/…) cost 2 clicks per
        // selection + the drill-down had its own state-leak history
        // (commit c4d2087 _crisisGroup reset, then the smarter Add-
        // Another listener in 0a26c7a). Flattening to one screen
        // with all 9 crisis tiles visible under 3 section headers
        // removes a click AND retires _crisisGroup entirely.
        //
        // Single source of truth for the tile list stays
        // CRISIS_GROUPS (module-level at line ~1455). _renderCrisisGrid
        // walks the dict in fixed order (natural → tech → human),
        // emits a `.v4-cause-group` block per section + a
        // `.v4-cause-tile` button per crisis type. Click handler is
        // bound delegated-style on the grid container so adding /
        // removing groups in CRISIS_GROUPS doesn't require any code
        // changes here.
        const crisisGrid = document.getElementById('v4-cause-grid');
        const CRISIS_GROUP_ORDER = ['natural', 'tech', 'human'];
        const CRISIS_GROUP_TITLE_KEY = {
            natural: 'v4_cause_natural',
            tech:    'v4_cause_tech',
            human:   'v4_cause_human',
        };

        function _renderCrisisGrid() {
            if (!crisisGrid) return;
            const _ti = (k, fb) => (typeof window.t === 'function' ? (window.t(k) || fb) : fb);
            const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
            crisisGrid.innerHTML = CRISIS_GROUP_ORDER.map((group) => {
                const items = CRISIS_GROUPS[group] || [];
                if (!items.length) return '';
                const headerKey = CRISIS_GROUP_TITLE_KEY[group];
                const headerLabel = _ti(headerKey, group);
                const tilesHtml = items.map((it) => {
                    const label = _ti(it.k, it.v);
                    const iconHtml = it.svg
                        ? `<svg class="v4-cause-tile-svg" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${it.svg}</svg>`
                        : `<i class="fa-solid ${escAttr(it.i)}"></i>`;
                    return `<button class="v4-cause-tile" data-value="${escAttr(it.v)}" data-group="${escAttr(group)}" type="button" role="radio" aria-checked="false">
                        <span class="v4-cause-tile-icon" aria-hidden="true">${iconHtml}</span>
                        <span class="v4-cause-tile-label">${escAttr(label)}</span>
                    </button>`;
                }).join('');
                return `<div class="v4-cause-group v4-cause-group-${escAttr(group)}">
                    <div class="v4-cause-group-header">${escAttr(headerLabel)}</div>
                    <div class="v4-cause-group-tiles">${tilesHtml}</div>
                </div>`;
            }).join('');
        }
        // Render now (initial paint) + re-render on i18n changes so
        // localized labels swap when the user re-picks a language.
        _renderCrisisGrid();
        document.addEventListener('crisp-i18n-applied', () => {
            try { _renderCrisisGrid(); } catch (_) {}
        });

        // Delegated click handler - survives the innerHTML rewrites
        // that _renderCrisisGrid does (no need to re-attach on each
        // re-render). Sets state.crisis_type, paints the selected
        // ring, refreshes the Continue gate.
        if (crisisGrid) {
            crisisGrid.addEventListener('click', (e) => {
                const tile = e.target && e.target.closest && e.target.closest('.v4-cause-tile');
                if (!tile || !crisisGrid.contains(tile)) return;
                const value = tile.getAttribute('data-value');
                if (!value) return;
                crisisGrid.querySelectorAll('.v4-cause-tile').forEach((b) => {
                    b.classList.remove('is-selected');
                    b.classList.remove('is-tap-confirmed');
                    b.setAttribute('aria-checked', 'false');
                });
                tile.classList.add('is-selected');
                tile.setAttribute('aria-checked', 'true');
                _setState({ crisis_type: value });
                _updateReviewSummary();
                _refreshClassifyNext();
                // Auto-progress to Stage 3 (review) after 200ms pulse.
                _scheduleClassifyAdvance('crisis', tile);
            });
        }

        // ── Sub-step navigation ──
        const backBtn = document.getElementById('btn-v4-classify-back');
        const nextBtn = document.getElementById('btn-v4-classify-next');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                const order = _classifyOrder();
                const idx = order.indexOf(_classifyStep);
                if (idx <= 0) {
                    window.__crispGoToStage('stage-v4-capture');
                    return;
                }
                _showSubStep(order[idx - 1]);
            });
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                if (!_canAdvanceFrom(_classifyStep)) return;
                const order = _classifyOrder();
                const idx = order.indexOf(_classifyStep);
                if (idx === order.length - 1) {
                    _goToReview();
                    return;
                }
                _showSubStep(order[idx + 1]);
            });
        }

        // Re-render i18n now that views are populated.
        if (typeof window.applyI18n === 'function') {
            try { window.applyI18n(); } catch (e) {}
        }

        // Default sub-step on stage entry. Reset when user arrives from
        // earlier in the flow; preserved otherwise (e.g. back from
        // review - they should land on crisis again).
        _showSubStep('damage');

        // Listen for stage-entered to ensure damage shows when entering
        // classify fresh. Subsequent re-entries (e.g. from review's
        // "edit" button) keep the user on whichever sub-step they last
        // visited.
        document.addEventListener('stage-entered', (e) => {
            const stage = typeof e.detail === 'string' ? e.detail : (e.detail?.stage || '');
            if (stage === 'stage-v4-classify' && !_classifyStep) {
                _showSubStep('damage');
            }
        });
        // BUGFIX May 2026 - _clearCaptureState() (app.js, end) dispatches
        // this event after wiping state. Without this listener, the
        // user-visible flow after "Add Another Report" was:
        //   · _classifyStep stayed 'crisis' from the prior submit
        //   · DOM still showed the crisis sub-step ("WHAT CAUSED IT · 3 of 3")
        //   · state.crisis_type was null (correctly cleared)
        //   · Continue button kept whichever enabled/disabled state the
        //     LAST _refreshClassifyNext call had set - confusing
        // Reset the local cursors + DOM cursor here so the next entry
        // starts at sub-step 1 with the gated Continue correctly disabled.
        document.addEventListener('crisp-capture-state-cleared', () => {
            _classifyStep = 'damage';
            try { _showSubStep('damage'); } catch (_) {}
            // Defensively re-evaluate the Continue gate against the fresh
            // (cleared) state. _showSubStep already does this, but if the
            // listener fires while the user is mid-stage (rare edge case
            // where a parallel reset path races) we want the gate to
            // immediately reflect emptiness.
            try { _refreshClassifyNext(); } catch (_) {}
            // Render-from-state: derive ALL capture + classify DOM from the
            // (now-cleared) state - the description textarea, the voice recorder
            // panel, and the damage/infra/crisis selections + the infra-OTHER
            // prompt. This REPLACES the old hand-maintained "clear these specific
            // selectors" block, which kept falling behind every time a new
            // capture field was added (the recurrence). With render-from-state,
            // a cleared `state` always yields a clean DOM, so the leak cannot
            // reappear for any future field that paints from state.
            try { if (window.__crispV4RenderFromState) window.__crispV4RenderFromState(); } catch (_) {}
        });
        // Re-render the dynamic sub-step label whenever the i18n pack
        // updates (e.g. async en.json load resolves after first paint).
        document.addEventListener('crisp-i18n-applied', () => {
            // Cheap; just re-write the label based on _classifyStep.
            try { _showSubStep(_classifyStep); } catch (_) {}
        });
    }

    // Sub-step state machine
    let _classifyStep = 'damage';
    function _canAdvanceFrom(step) {
        const s = window.state || {};
        if (step === 'damage') return !!s.damage_classification;
        if (step === 'infra') {
            if (!s.infrastructure_type) return false;
            // UNDP "Other, please specify": when OTHER is the selection,
            // require a non-empty descriptor before allowing Continue.
            if (s.infrastructure_type === 'OTHER') {
                const name = (s.infrastructure_name || '').trim();
                return name.length > 0;
            }
            return true;
        }
        if (step === 'crisis') return !!s.crisis_type;
        if (step === 'crisispack') {
            // All REQUIRED extra pack questions must be answered.
            const ans = s.crisisStockAnswers || {};
            return _crisisPackFields().every((f) => {
                if (!f.required) return true;
                const v = ans[f.key];
                if (f.type === 'multi_select') return Array.isArray(v) && v.length > 0;
                if (f.type === 'yes_no') return v === true || v === false;
                return v !== undefined && v !== null && String(v).trim() !== '';
            });
        }
        return true;
    }
    // ── Auto-progress helpers - May 2026 ──────────────────────────────
    //
    // Operator: "When the user selects any tile/card option in Stage 2
    // or Stage 3, the app should automatically progress to the next
    // step/page immediately after selection."
    //
    // For Stage 2 (damage → infra → crisis → review), each tile click
    // already does state save + .is-selected toggle. We add a thin
    // wrapper that fires AFTER the click handler completes:
    //   t=0   .is-tap-confirmed class added (CSS pulse: scale 1 → 1.04
    //         → 1 + tier-glow halo, 200ms ease-out)
    //   t=200 ms  _doClassifyAdvance(step) called → _showSubStep(next)
    //         OR _goToReview() if step === 'crisis'
    //
    // Race-condition guards:
    //   _advancingFromStep flag bails out on rapid double-tap so the
    //   advance only fires ONCE per user-tap-burst. Cleared after the
    //   timer fires (or on early-exit conditions like OTHER tile
    //   waiting for free-text input).
    //
    // prefers-reduced-motion users skip the 200 ms pulse and advance
    // at 80 ms so the experience still acknowledges the tap without
    // a scale animation.
    //
    // The OTHER tile on the infra sub-view does NOT auto-advance on
    // tap - it reveals the free-text input and waits for the user to
    // press Enter or blur the input with non-empty text. See the
    // separate _wireInfraOtherAdvance() below.
    const CLASSIFY_ADVANCE_MS = 200;
    const CLASSIFY_ADVANCE_MS_REDUCED = 80;
    let _advancingFromStep = null;

    function _doClassifyAdvance(step) {
        if (!_canAdvanceFrom(step)) return;
        const order = _classifyOrder();
        const idx = order.indexOf(step);
        if (idx === -1) return;
        if (idx === order.length - 1) {
            _goToReview();
            return;
        }
        _showSubStep(order[idx + 1]);
    }

    function _scheduleClassifyAdvance(step, tileEl) {
        // Race guard - bail if an advance is already in flight from
        // this step. Allows the FIRST tap of a rapid double-tap to
        // win + ignores the second.
        if (_advancingFromStep === step) return;
        _advancingFromStep = step;

        // Special-case OTHER infra: don't auto-advance on the tile
        // click; wait for the user to fill the free-text input + press
        // Enter / blur (handled by _wireInfraOtherAdvance below). The
        // OTHER tile still gets the confirmation pulse so the tap is
        // acknowledged.
        const isOther = (step === 'infra'
            && (window.state && window.state.infrastructure_type === 'OTHER'));

        if (tileEl) tileEl.classList.add('is-tap-confirmed');

        const reduced = (typeof window !== 'undefined'
            && window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        const delay = reduced ? CLASSIFY_ADVANCE_MS_REDUCED : CLASSIFY_ADVANCE_MS;

        setTimeout(() => {
            if (tileEl) tileEl.classList.remove('is-tap-confirmed');
            // Clear the guard BEFORE _doClassifyAdvance so re-selection
            // works smoothly when user comes back via the Back button
            // and picks again.
            _advancingFromStep = null;
            if (isOther) {
                // OTHER tile: don't navigate - input is now visible +
                // focused; user finishes by typing + Enter/blur.
                return;
            }
            _doClassifyAdvance(step);
        }, delay);
    }

    function _wireInfraOtherAdvance() {
        const otherInput = document.getElementById('v4-infra-other-input');
        if (!otherInput || otherInput.__crispOtherWired) return;
        otherInput.__crispOtherWired = true;
        // Enter on the input commits + advances (we trigger blur which
        // fires the blur listener below).
        otherInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            otherInput.blur();
        });
        // Blur with non-empty text + state still set to OTHER advances.
        // (If the user has since clicked another tile, the state won't
        // match - we no-op.)
        otherInput.addEventListener('blur', () => {
            const s = window.state || {};
            if (s.infrastructure_type !== 'OTHER') return;
            const name = (s.infrastructure_name || '').trim();
            if (name.length === 0) return;
            // Tiny delay so the user sees the input value commit before
            // the page transitions away.
            setTimeout(() => { _doClassifyAdvance('infra'); }, 120);
        });
    }

    function _showSubStep(step) {
        // Re-derive the zone's canonical crisis_type before computing the order,
        // so the "what caused it" skip survives add-another (crisisPack persists,
        // crisis_type was nulled by _clearCaptureState).
        try { _ensureZoneCrisisType(); } catch (_) {}
        if (!_classifyOrder().includes(step)) return;
        // If the user navigated back via the Back button (or programmatic
        // _showSubStep call), clear any pending advance from the
        // departing step.
        _advancingFromStep = null;
        _classifyStep = step;
        // Render the dynamic crisis-pack view lazily on entry. The pack step is
        // a multi-field form, so reveal the Continue footer (the single-pick
        // sub-steps hide it + auto-advance) by tagging the stage.
        if (step === 'crisispack') { try { _renderCrisisPackView(); } catch (_) {} }
        const _stageEl = document.getElementById('stage-v4-classify');
        if (_stageEl) _stageEl.classList.toggle('v4-cp-step', step === 'crisispack');
        // Hide EVERY classify sub-view - not just those in the current order. A
        // location edit can DROP the crispack (or crisis) step from the order; the
        // removed view must still be hidden, otherwise its stale questions stay on
        // screen even though that step is no longer part of the flow (the reported
        // "device-location form still visible" tail case when editing into a
        // no-zone location).
        document.querySelectorAll('.v4-classify-view').forEach((view) => {
            if (view.id === 'v4-view-' + step) view.removeAttribute('hidden');
            else view.setAttribute('hidden', '');
        });
        // Render-from-state: derive the shown sub-step's selection from `state`
        // on every entry, so back-nav re-highlights a saved pick and a fresh
        // report shows none (no imperative-paint drift).
        try { if (window.__crispV4RenderFromState) window.__crispV4RenderFromState(); } catch (_) {}
        // Sub-step label
        const label = document.getElementById('v4-substep-label');
        if (label) {
            const order = _classifyOrder();
            let ttl;
            if (step === 'crisispack') {
                const cp = (window.state && window.state.crisisPack) || {};
                ttl = (cp.schema && _cpI18n(cp.schema.title_i18n, cp.schema.title)) || 'Crisis details';
            } else {
                const titleKey = step === 'damage' ? 'v4_substep_how_bad'
                              : step === 'infra'  ? 'v4_substep_what_hit'
                              : 'v4_substep_what_caused';
                ttl = (typeof window.t === 'function' ? window.t(titleKey) : titleKey);
            }
            const stepNum = order.indexOf(step) + 1;
            label.innerHTML = `<span>${ttl}</span><span class="v4-substep-of"> · ${stepNum} of ${order.length}</span>`;
            // HC64 (May 2026) - crisis sub-view stacks 9 cause tiles
            // in a single-column flex-fill grid; we need every pixel
            // for the tiles. The substep label "WHAT CAUSED IT · 3
            // OF 3" is redundant - the page title says the same
            // thing one row below, and the progress pips in the
            // header already encode "3 of 3". Hide it for crisis
            // only; damage + infra keep it (those views still have
            // breathing room for it). Inline style is the simplest
            // toggle here - no class added/removed each visit.
            label.style.display = step === 'crisis' ? 'none' : '';
        }
        // Continue button enabled based on current selection.
        const nextBtn = document.getElementById('btn-v4-classify-next');
        if (nextBtn) {
            const ok = _canAdvanceFrom(step);
            nextBtn.disabled = !ok;
            nextBtn.classList.toggle('is-ready', ok);
        }
        // Reset crisis drill-down state when arriving at the crisis step
        // fresh - ensures the group-card surface shows by default.
        if (step === 'crisis') {
            const groupCards = document.getElementById('v4-cause-cards');
            const subtypesContainer = document.getElementById('v4-cause-subtypes');
            if (groupCards) groupCards.removeAttribute('hidden');
            if (subtypesContainer) subtypesContainer.setAttribute('hidden', '');
        }
    }
    // Refresh next-button enabled state whenever classification state
    // changes (e.g. user selects a damage option after navigating back).
    function _refreshClassifyNext() {
        const nextBtn = document.getElementById('btn-v4-classify-next');
        if (!nextBtn) return;
        const ok = _canAdvanceFrom(_classifyStep);
        nextBtn.disabled = !ok;
        nextBtn.classList.toggle('is-ready', ok);
    }
    // Exposed for tests + late re-syncs after auth / locale changes.
    window.__crispV4RefreshClassifyNext = _refreshClassifyNext;
    // Substep navigator - exposed so tests can jump directly to
    // 'damage'/'infra'/'crisis' without driving the Continue gate.
    window.__crispV4ShowSubStep = (step) => {
        try { _showSubStep(step); } catch (_) {}
    };


    // ── Page 3: review ──────────────────────────────────────────────────
    function _initReviewStage() {
        // UNDP must-have #6: relocate the existing
        // #building-select-box (which lives inside stage-crisis by default)
        // into the v4 review's #v4-building-mount the first time the user
        // lands on stage-v4-review. Done lazily so v3-mode users (when
        // they exist) never see a moved DOM node.
        function _ensureBuildingBoxInV4() {
            const box = document.getElementById('building-select-box');
            const mount = document.getElementById('v4-building-mount');
            if (!box || !mount) return;
            if (mount.contains(box)) return;  // already moved
            mount.appendChild(box);
            // BuildingSelect listens for `stage-entered: stage-v4-review`
            // (added in ). The double-rAF + setTimeout(500) inside
            // _tryInitMap handles the layout settle for Leaflet's
            // invalidateSize.
        }

        // Tap location → opens an inline GPS refresh + ensures the building
        // box is mounted + map initialised. Replaces v3's _refreshGps-only
        // behaviour so the user can ALSO pick a building footprint.
        document.getElementById('v4-edit-location').addEventListener('click', () => {
            _ensureBuildingBoxInV4();
            // User-initiated → if the GPS fix lands the reporter in a different
            // ~110 m cell (they physically moved since capture), re-run the
            // authoritative crisis-form / operation re-eval. The review stage has
            // no place-search input (the typed-place editor lives on capture by
            // design), so a different PLACE is changed there; here a material GPS
            // move re-homes the report. (V3 selectPlace / #input-loc-search is dead
            // in V4 - the element does not exist - and the backend re-derives
            // crisis_event_id from the submitted coords regardless.)
            _refreshGps(true);
            // Eager init in case the user taps before stage-entered fires.
            if (window.BuildingSelect && window.BuildingSelect.ensureMap) {
                const loc = _getState().location;
                if (loc && loc.lat && loc.lng) {
                    window.BuildingSelect.ensureMap(loc.lat, loc.lng).catch(() => {});
                }
            }
        });

        // On every entry to stage-v4-review, ensure the box is mounted.
        // Listens to the document-level `stage-entered` event (dispatched
        // by app.js's goToStage with detail = stage id).
        document.addEventListener('stage-entered', (e) => {
            const stage = typeof e.detail === 'string' ? e.detail : (e.detail?.stage || '');
            if (stage === 'stage-v4-review') {
                _ensureBuildingBoxInV4();
                // Q10 - refresh the multi-modal captured strip
                // every time the user lands on stage-v4-review. Photo /
                // voice / text states could have changed during navigation
                // (back→capture→retake, drawer→record, etc.).
                try { _refreshCapturedStrip(); } catch (err) { console.warn('[Q10] strip:', err); }
                // Required debris card renders from state on every entry
                // (covers reset, back-nav, and pre-filled state).
                try { if (window.__crispV4RenderDebrisCard) window.__crispV4RenderDebrisCard(); } catch (_) {}
            }
        });

        // May 2026 - V4 review-card click handlers (operator rethink).
        // The captured-strip + summary card + voice-drawer trio was
        // replaced by 4 single-purpose content cards. Each card is its
        // own button or has its own edit button - wire each here.

        // Card 1 (Photo) - tap → return to capture stage.
        const photoCard = document.getElementById('v4-edit-photo');
        if (photoCard) {
            photoCard.addEventListener('click', () => {
                window.__crispGoToStage('stage-v4-capture');
            });
        }

        // Card 2 (Description) - both the "Edit" pill in the filled-state
        // preview AND the empty-state "+ Add voice or text" CTA open the
        // same inline `<details id="v4-voice-drawer">` drawer. We toggle
        // `open` and focus the textarea so the user can start typing
        // immediately (mic button needs an explicit tap so we don't
        // surprise users with a permission prompt).
        const _openDescDrawer = () => {
            const drawer = document.getElementById('v4-voice-drawer');
            if (drawer && !drawer.open) drawer.open = true;
            setTimeout(() => {
                if (drawer) drawer.scrollIntoView({ behavior: 'smooth', block: 'center' });
                document.getElementById('v4-text-desc')?.focus();
            }, 80);
        };
        document.getElementById('btn-v4-desc-edit')?.addEventListener('click', _openDescDrawer);
        document.getElementById('v4-desc-empty')?.addEventListener('click', _openDescDrawer);
        // HC67 (May 2026) - tap classification rows → jump back to Page 2
        // AND open the targeted sub-step. Pre-HC67 all three handlers just
        // called `goToStage('stage-v4-classify')` which restored whatever
        // sub-step `_classifyStep` was last set to. After the user
        // completed the flow this was always 'crisis', so every edit
        // button landed on the same screen regardless of which one was
        // tapped. The `_carousel-infra` / `_carousel-crisis` scroll-into-
        // view targets were legacy V3 IDs that no longer exist. The fix:
        // explicitly call `_showSubStep(target)` for each handler.
        const _editSubStep = (target) => {
            window.__crispGoToStage('stage-v4-classify');
            // Defer one frame so the stage's display:flex applies before
            // _showSubStep flips the sub-view's `[hidden]` attribute.
            setTimeout(() => {
                try { _showSubStep(target); } catch (_) {}
            }, 30);
        };
        document.getElementById('v4-edit-damage').addEventListener('click',
            () => _editSubStep('damage'));
        document.getElementById('v4-edit-infra').addEventListener('click',
            () => _editSubStep('infra'));
        document.getElementById('v4-edit-crisis').addEventListener('click',
            () => _editSubStep('crisis'));

        // Voice drawer - wire mic + textarea.
        // voice-only path. v4 originally forwarded
        // btn-v4-mic clicks to btn-mic.click(), which writes to v3-only
        // DOM (mic-icon, mic-label, rec-timer) - invisible in v4. Now
        // we own the recorder lifecycle and update the v4 mic button
        // visual state directly. state.audioBlob + state.transcript
        // remain the contract submitReport() reads.
        const micBtn = document.getElementById('btn-v4-mic');
        const textArea = document.getElementById('v4-text-desc');
        if (micBtn) {
            micBtn.addEventListener('click', () => {
                if (_isV4Recording()) {
                    _stopV4Recording();
                } else {
                    _startV4Recording();
                }
            });
        }
        if (textArea) {
            textArea.addEventListener('input', () => {
                _setState({
                    description: textArea.value,
                    transcript: textArea.value,  // mirror so submit reads either
                });
                // Q10 - refresh the strip on every keystroke so the text chip
                // turns green the moment the textarea has any content.
                try { _refreshCapturedStrip(); } catch (_) {}
            });
        }

        // ── UNDP details bottom-sheet (May 2026 - operator-restored UX) ───
        //
        // The inline <details> drawer was replaced by a trigger button +
        // half-screen bottom-sheet. Trigger lives at `#btn-v4-open-undp`;
        // sheet body lives at `#v4-undp-sheet .v4-undp-sheet-body` and
        // contains the same 5 .undp-q-card question-cards as before.
        // Wiring is scoped to the sheet body so it doesn't collide with
        // the standalone stage-undp-details (which has its own setup).
        //
        // State writes use the V4 field names already in use:
        //   electricity_status / water_status / health_status (string|null)
        //   debris_present (boolean)
        //   pressing_needs (string[])
        const _undpSheet     = document.getElementById('v4-undp-sheet');
        const _undpSheetBody = _undpSheet
            ? _undpSheet.querySelector('.v4-undp-sheet-body') : null;
        const _undpTrigger   = document.getElementById('btn-v4-open-undp');
        const _undpBackdrop  = document.getElementById('v4-undp-sheet-backdrop');
        const _undpCloseBtn  = document.getElementById('btn-v4-undp-close');

        // Trigger-badge live-count helper. Reads V4 state and swaps the
        // `.undp-details-cta-time` pill text between "Optional" → "1/5"
        // → … → "5/5". Called after every state-mutating tap inside the
        // sheet AND on stage entry (in case state was pre-filled).
        function _refreshTriggerBadge() {
            if (!_undpTrigger) return;
            const s = _getState();
            // Jun 2026 - debris moved OUT of this sheet (it is a UNDP CORE
            // question, now a required card on the review surface), so the
            // sheet counts 4 optional questions, not 5.
            const filled = [
                !!s.electricity_status,
                !!s.water_status,
                !!s.health_status,
                Array.isArray(s.pressing_needs) && s.pressing_needs.length > 0,
            ].filter(Boolean).length;
            const badge = _undpTrigger.querySelector('.undp-details-cta-time');
            if (!badge) return;
            if (filled === 0) {
                // Defer to i18n for the default state - t() returns the
                // active locale's "Optional" translation or the EN
                // fallback if the key isn't resolved yet.
                try {
                    const fn = window.t || ((k) => k);
                    const v = fn('v4_undp_trigger_time');
                    badge.textContent = (v && v !== 'v4_undp_trigger_time') ? v : 'Optional';
                } catch { badge.textContent = 'Optional'; }
            } else {
                badge.textContent = `${filled}/4`;
            }
        }
        // Expose so app.js setLanguage() can call after i18n re-application.
        window.__crispV4RefreshUndpBadge = _refreshTriggerBadge;

        // ── REQUIRED debris card (UNDP core question, Jun 2026) ─────────
        // Moved out of the optional sheet onto the review surface
        // (#v4-debris-card). Taps write state.debris_present (explicit
        // true/false - null means unanswered); _onSend refuses to submit
        // while unanswered. Renders from state so reset/back-nav stay
        // correct (called from _renderV4FromState via the window hook +
        // review stage-entry below).
        function _renderDebrisCard() {
            const card = document.getElementById('v4-debris-card');
            if (!card) return;
            // If the deployed crisis form already asks debris, don't ask again here.
            if (_packCollectsDebris()) { card.style.display = 'none'; return; }
            card.style.display = '';
            const v = _getState().debris_present;
            const yes = document.getElementById('v4-debris-yes');
            const no = document.getElementById('v4-debris-no');
            if (yes) yes.classList.toggle('is-selected', v === true);
            if (no) no.classList.toggle('is-selected', v === false);
            card.classList.toggle('is-answered', v === true || v === false);
        }
        window.__crispV4RenderDebrisCard = _renderDebrisCard;
        (function _wireDebrisCard() {
            const yes = document.getElementById('v4-debris-yes');
            const no = document.getElementById('v4-debris-no');
            if (!yes || !no) return;
            yes.addEventListener('click', () => { _setState({ debris_present: true }); _renderDebrisCard(); });
            no.addEventListener('click', () => { _setState({ debris_present: false }); _renderDebrisCard(); });
        })();

        // Sheet open / close - pure DOM, no state change.
        function _openUndpSheet() {
            if (!_undpSheet) return;
            _undpSheet.hidden = false;
            document.body.style.overflow = 'hidden';
            // Force a frame so the slide-up transition runs from
            // translateY(100%) → translateY(0) rather than skipping
            // straight to the final state.
            requestAnimationFrame(() => _undpSheet.classList.add('is-open'));
        }
        function _closeUndpSheet() {
            if (!_undpSheet) return;
            _undpSheet.classList.remove('is-open');
            document.body.style.overflow = '';
            // Match the CSS transition (0.28 s) before flipping `hidden`
            // so the slide-down animation completes.
            setTimeout(() => { _undpSheet.hidden = true; }, 320);
        }

        if (_undpTrigger)  _undpTrigger.addEventListener('click',  _openUndpSheet);
        if (_undpCloseBtn) _undpCloseBtn.addEventListener('click', _closeUndpSheet);
        if (_undpBackdrop) _undpBackdrop.addEventListener('click', _closeUndpSheet);
        // Escape key support - accessibility parity with .nearby-sheet.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (_undpSheet && _undpSheet.classList.contains('is-open')) {
                _closeUndpSheet();
            }
        });

        // Single-select status rows (5-level: Power; 4-level: Water).
        if (_undpSheetBody) {
            _undpSheetBody.querySelectorAll('.undp-status-row').forEach((row) => {
                const field = row.getAttribute('data-undp-field');
                if (!field) return;
                row.querySelectorAll('.undp-lvl').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        row.querySelectorAll('.undp-lvl').forEach((b) =>
                            b.classList.remove('is-selected'));
                        btn.classList.add('is-selected');
                        _setState({ [field]: btn.getAttribute('data-value') || null });
                        _refreshTriggerBadge();
                    });
                });
            });

            // Single-select pill row (Health services).
            _undpSheetBody.querySelectorAll('.undp-pill-row').forEach((row) => {
                const field = row.getAttribute('data-undp-field');
                if (!field) return;
                row.querySelectorAll('.undp-pill').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        row.querySelectorAll('.undp-pill').forEach((b) =>
                            b.classList.remove('is-selected'));
                        btn.classList.add('is-selected');
                        _setState({ [field]: btn.getAttribute('data-value') || null });
                        _refreshTriggerBadge();
                    });
                });
            });

            // Yes/No row (Debris).
            _undpSheetBody.querySelectorAll('.undp-yn-row').forEach((row) => {
                const field = row.getAttribute('data-undp-field');
                if (!field) return;
                row.querySelectorAll('.undp-yn').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        row.querySelectorAll('.undp-yn').forEach((b) =>
                            b.classList.remove('is-selected'));
                        btn.classList.add('is-selected');
                        _setState({ [field]: btn.getAttribute('data-value') === 'true' });
                        _refreshTriggerBadge();
                    });
                });
            });

            // Multi-select chip grid (Pressing needs).
            _undpSheetBody.querySelectorAll('.undp-needs-grid').forEach((grid) => {
                const field = grid.getAttribute('data-undp-field') || 'pressing_needs';
                grid.querySelectorAll('.undp-need').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        btn.classList.toggle('is-selected');
                        const selected = Array.from(
                            grid.querySelectorAll('.undp-need.is-selected'),
                        ).map((c) => c.getAttribute('data-value'));
                        _setState({ [field]: selected });
                        _refreshTriggerBadge();
                    });
                });
            });
        }

        // Paint badge once at boot in case `state` is pre-populated.
        _refreshTriggerBadge();

        // Send
        document.getElementById('btn-v4-send').addEventListener('click', _onSend);

        // Back
        document.getElementById('btn-v4-review-back').addEventListener(
            'click', () => window.__crispGoToStage('stage-v4-classify')
        );
    }

    /**
     * HC66 (May 2026) - render the review photo strip.
     *
     * Replaces the pre-HC66 `#v4-summary-thumb` + `#v4-photo-count` +
     * `#v4-photo-meta` writes (those elements are gone in HC66 - the
     * legacy getElementById guards in `_updateReviewSummary` fall
     * through harmlessly when their targets don't exist).
     *
     * Paints 3 square slots into `#v4-review-photo-strip`:
     *   · Filled slots (one per existing v4Photo) → `<img>` thumb
     *     with a `× delete` corner button. Tap × → calls
     *     `_deleteV4PhotoAt(idx)` then re-paints.
     *   · Empty slots → `+` CTA button. Tap → opens the existing
     *     camera modal (or falls back to capture stage when
     *     `window.openCameraModal` isn't available).
     */
    function _renderReviewPhotoStrip() {
        const strip = document.getElementById('v4-review-photo-strip');
        if (!strip) return;
        // HC67 - wrap the existing capture-stage refresher so any
        // photo added/removed via `_ingestFileAsPhoto` (camera modal,
        // gallery picker, or paste) re-paints the review strip too.
        // Idempotent via the `__crispV4RefreshReviewWired` flag so
        // repeated paints don't stack wrappers. The wrapper is
        // installed lazily on first review-stage render - before
        // that point, only the capture stage was painting from
        // ingest events, so there was no review strip to refresh.
        if (!window.__crispV4RefreshReviewWired) {
            const _origCapRefresh = window.__crispV4RefreshCapStrip;
            window.__crispV4RefreshCapStrip = function () {
                if (typeof _origCapRefresh === 'function') {
                    try { _origCapRefresh(); } catch (_) {}
                }
                // Only re-paint the review strip when the review
                // stage is actually the active stage - keeps the
                // capture-stage thumb row's repaints from doing
                // double work.
                if (document.querySelector('#stage-v4-review.active')) {
                    try { _renderReviewPhotoStrip(); } catch (_) {}
                }
            };
            // HC76 (May 2026) - ALSO wrap the V3 refresher
            // `__crispRefreshPhotoStrip`. The camera modal's `btn-cam-
            // done` handler (app.js:6724) calls this name, NOT the
            // V4 one. Without this second wrapper, photos captured
            // from the review's + Add → openCameraModal → snap → Done
            // flow never trigger a review strip repaint and the
            // newly-captured photos render as empty + slots forever
            // (operator screenshot 2026-05-26, repeated after HC74).
            const _origV3Refresh = window.__crispRefreshPhotoStrip;
            window.__crispRefreshPhotoStrip = function () {
                if (typeof _origV3Refresh === 'function') {
                    try { _origV3Refresh(); } catch (_) {}
                }
                if (document.querySelector('#stage-v4-review.active')) {
                    try { _renderReviewPhotoStrip(); } catch (_) {}
                }
            };
            // HC76 - also expose a direct public hook so callers can
            // request a refresh without going through one of the
            // legacy wrappers.
            window.__crispV4RefreshReviewStrip = function () {
                if (document.querySelector('#stage-v4-review.active')) {
                    try { _renderReviewPhotoStrip(); } catch (_) {}
                }
            };
            window.__crispV4RefreshReviewWired = true;
        }
        // HC78 (May 2026) - REBUILD `state.v4Photos` canonically from
        // `[primary, ...extras]` at every paint. Replaces the HC74 +
        // HC77 3-source merge + sanitize chain, which had a fatal
        // race against BlazeFace's async post-processing:
        //
        //   1. User snaps photo A. Snap handler pushes `{ dataUrl:
        //      A_raw }` to `state.extraPhotos`.
        //   2. Render fires immediately. allPhotos = [primary, A_raw];
        //      sync-back writes `state.v4Photos = [primary, A_raw]`.
        //   3. BlazeFace finishes asynchronously and mutates
        //      `extras[0].dataUrl` to `A_blurred` (visually identical
        //      to A_raw but with face redaction - a NEW byte
        //      sequence and therefore a NEW dataUrl string).
        //   4. Next render fires (camera Done). extras[0].dataUrl =
        //      A_blurred; v4Photos[1].url still = A_raw. The 3-source
        //      merge treats them as DIFFERENT photos and pushes both
        //      → allPhotos = [primary, A_blurred, A_raw]. Operator
        //      sees the same photo in 2 review tiles (the May 2026
        //      "5th-attempt" bug).
        //
        // Fix: there is exactly ONE source of truth for review-stage
        // photos - `state.photoDataUrl` (the primary) plus
        // `state.extraPhotos` (the rest, in insertion order). Rebuild
        // `state.v4Photos` from this source at every paint so it
        // CANNOT drift from the live extras entries (whose `.dataUrl`
        // BlazeFace mutates in place). Each rebuilt entry carries a
        // LIVE reference back to the extras entry's variants/blob, so
        // subsequent BlazeFace mutations propagate on next paint.
        const state = _getState();
        const newV4 = [];
        const seenUrls = new Set();
        if (state.photoDataUrl) {
            newV4.push({
                url: state.photoDataUrl,
                blob: state.photoBlob || null,
                variants: state.photoVariants || null,
                groupId: state.photoGroupId || null,
                clientBlurApplied: Boolean(state.photoClientBlurApplied),
                ts: 0,
            });
            seenUrls.add(state.photoDataUrl);
        }
        // Track extras entries that resolve to a unique (and non-primary)
        // dataUrl. We ALSO sanitize state.extraPhotos in place so the
        // submitReport upload work-list doesn't queue duplicates.
        const cleanedExtras = [];
        for (const e of (state.extraPhotos || [])) {
            if (!e || !e.dataUrl) continue;
            // Skip extras entries that duplicate the primary OR a
            // prior extras entry (rapid-shutter-tap or BlazeFace-
            // convergence edge cases). The HC78 rebuild from
            // `[primary, ...extras]` is the canonical source of
            // truth - there is no second sync from v4Photos, so a
            // skipped extras entry stays skipped forever (no
            // resurrection on later paints).
            if (seenUrls.has(e.dataUrl)) continue;
            seenUrls.add(e.dataUrl);
            cleanedExtras.push(e);
            newV4.push({
                url: e.dataUrl,
                blob: e.blob || null,
                variants: e.variants || null,
                groupId: e.groupId || null,
                pid: e.pid || null,
                clientBlurApplied: Boolean(e.clientBlurApplied),
                ts: e.ts || 0,
            });
        }
        // Persist the dedupe so submitReport's upload pass doesn't
        // queue the duplicate either.
        if (cleanedExtras.length !== (state.extraPhotos || []).length) {
            state.extraPhotos = cleanedExtras;
        }
        state.v4Photos = newV4;
        const photos = newV4.slice(0, V4_MAX_PHOTOS);
        const slots = [];
        for (let i = 0; i < V4_MAX_PHOTOS; i++) {
            if (photos[i]) {
                slots.push(
                    '<div class="v4-review-photo-tile">' +
                    `<img src="${photos[i].url}" alt="">` +
                    `<button class="v4-review-photo-tile-x" type="button" ` +
                    `data-idx="${i}" aria-label="Remove photo">` +
                    '<i class="fa-solid fa-xmark" aria-hidden="true"></i>' +
                    '</button></div>',
                );
            } else {
                slots.push(
                    '<button class="v4-review-photo-add" type="button" ' +
                    'data-add-photo aria-label="Add photo">' +
                    '<i class="fa-solid fa-plus" aria-hidden="true"></i>' +
                    '</button>',
                );
            }
        }
        strip.innerHTML = slots.join('');
        // Wire `× delete` corner buttons. State mutation goes through
        // the shared `_deleteV4PhotoAt(idx)` helper so the
        // extraPhotos sync + primary-promotion behaviour matches
        // the capture-stage strip exactly.
        strip.querySelectorAll('.v4-review-photo-tile-x').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
                _deleteV4PhotoAt(idx);
                _renderReviewPhotoStrip();
            });
        });
        // Wire `+ Add` empty-slot CTAs. Opens the existing camera
        // modal when available; falls back to navigating to the
        // capture stage where the explicit Camera + Gallery buttons
        // live (older Android browsers without getUserMedia).
        strip.querySelectorAll('[data-add-photo]').forEach((btn) => {
            btn.addEventListener('click', () => {
                // HC97 - route through the SAME smart camera entry as Stage-1
                // so the review "+ Add" gets the identical capability gate,
                // custom modal, multi-snap ingest, and <input capture> fallback
                // (previously it called openCameraModal() directly with only a
                // weak "go back to capture" fallback).
                if (typeof window.__crispOpenCameraSmart === 'function') {
                    window.__crispOpenCameraSmart();
                } else if (typeof window.openCameraModal === 'function') {
                    window.openCameraModal();
                } else {
                    window.__crispGoToStage('stage-v4-capture');
                }
            });
        });
    }

    /**
     * HC66 (May 2026) - paint the timezone + local-time line under
     * the geocoded location name. `Intl.DateTimeFormat` is locale-
     * aware via the device's active language, so Arabic / Hindi /
     * any locale renders the time format correctly.
     */
    function _renderReviewLocationMeta() {
        const el = document.getElementById('v4-row-location-time');
        if (!el) return;
        try {
            const now = new Date();
            let tzShort = '';
            try {
                const parts = Intl.DateTimeFormat(undefined, {
                    timeZoneName: 'short',
                }).formatToParts(now);
                const tzPart = parts.find((p) => p.type === 'timeZoneName');
                tzShort = (tzPart && tzPart.value) || '';
            } catch (_) {}
            const time = now.toLocaleTimeString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
            });
            el.textContent = tzShort ? `${tzShort} · ${time}` : time;
        } catch (_) {
            el.textContent = '';
        }
    }

    function _updateReviewSummary() {
        const s = _getState();
        const setText = (id, val) => {
            const el = document.getElementById(id);
            if (el && val) el.textContent = val;
        };
        setText('v4-row-infra-text', s.infrastructure_type
            ? s.infrastructure_type.replace('_', ' ').toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase())
            : '-');
        setText('v4-row-crisis-text', s.crisis_type
            ? s.crisis_type.replace('_', ' ').toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase())
            : '-');
        // HC67 (May 2026) - use the same translation keys the damage
        // sub-view uses, so the review's display label stays in sync
        // with the canonical labels the user originally picked from
        // (and follows i18n into all 22 locales). Operator brief:
        // "Minimal Damage / Partial Damage / Fully Destroyed".
        const _damageLabel = (d) => {
            const map = {
                MINIMAL: 'damage_minimal',
                PARTIAL: 'damage_partial',
                COMPLETE: 'damage_complete',
            };
            const key = map[d];
            if (!key) return '-';
            if (typeof window.t === 'function') {
                const v = window.t(key);
                if (v) return v;
            }
            // Fallback if the i18n runtime hasn't booted yet -
            // canonical EN strings.
            return d === 'MINIMAL' ? 'Minimal Damage'
                : d === 'PARTIAL' ? 'Partial Damage'
                : d === 'COMPLETE' ? 'Fully Destroyed'
                : '-';
        };
        setText('v4-row-damage-text', _damageLabel(s.damage_classification));

        // HC66 - paint the new photo strip + location-time line. The
        // pre-HC66 `#v4-summary-thumb` / `#v4-photo-count` /
        // `#v4-photo-meta` writes below fall through harmlessly when
        // the elements are missing (HC66 markup removed them).
        try { _renderReviewPhotoStrip(); } catch (_) {}
        try { _renderReviewLocationMeta(); } catch (_) {}

        // Pre-HC66 photo thumb + count + meta writes. The HC66 markup
        // removed these elements; the getElementById guards null-out
        // and the calls become no-ops. Kept for back-compatibility if
        // a future HC ever re-introduces a single-thumb review tile.
        const photos = s.v4Photos || [];
        const thumbDiv = document.getElementById('v4-summary-thumb');
        if (thumbDiv) {
            if (photos.length) {
                thumbDiv.innerHTML = `<img src="${photos[0].url}" alt="">`;
                thumbDiv.classList.add('has-photo');
            } else {
                thumbDiv.classList.remove('has-photo');
                if (!thumbDiv.querySelector('i')) {
                    thumbDiv.innerHTML = '<i class="fa-solid fa-camera"></i>';
                }
            }
        }
        const photoCount = document.getElementById('v4-photo-count');
        if (photoCount) {
            const n = photos.length;
            const tt = (k, fb) => (typeof window.t === 'function' ? (window.t(k) || fb) : fb);
            if (n === 0) {
                photoCount.textContent = tt('v4_card_photo_empty', 'No photo captured');
            } else if (n === 1) {
                photoCount.textContent = tt('v4_card_photo_added', 'Photo captured');
            } else {
                photoCount.textContent = `${n} ` + tt('v4_card_photo_plural', 'photos');
            }
        }
        const photoMeta = document.getElementById('v4-photo-meta');
        if (photoMeta) {
            photoMeta.style.display = photos.length > 0 ? '' : 'none';
        }

        // Description card - paint filled vs empty state from state.*
        // (operator review rethink, May 2026).
        try { _refreshDescriptionCard(); } catch (_) {}
    }

    // ── V4 voice recorder ────────────────────────
    // Self-contained MediaRecorder wrapper. Mirrors v3's startRecording
    // + stopRecording but updates the v4 mic-button visual state and
    // the v4 textarea instead of v3's #live-transcript / #mic-label.
    // state.audioBlob + state.audioChunks remain the contract submit
    // reads - v3 + v4 share the upload path, so audio sent from v4 lands
    // on the dashboard exactly as if it had come from v3.
    function _isV4Recording() {
        return !!(window.state && window.state.isRecording);
    }
    let _v4SpeechRecognition = null;
    async function _startV4Recording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mr = new MediaRecorder(stream);
            window.state.mediaRecorder = mr;
            window.state.audioChunks = [];
            mr.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) window.state.audioChunks.push(e.data);
            };
            mr.onstop = () => {
                try {
                    window.state.audioBlob = new Blob(
                        window.state.audioChunks || [], { type: 'audio/webm' });
                } catch (e) { console.warn('[v4 audio] blob assemble failed:', e); }
                try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            };
            mr.start();
            window.state.isRecording = true;
            _setV4MicVisualState(true);
            // Best-effort live transcription via Web Speech API (mirrors
            // into the v4 textarea + state.description). Falls back to
            // raw audio if SpeechRecognition is unavailable.
            const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (SR) {
                try {
                    _v4SpeechRecognition = new SR();
                    _v4SpeechRecognition.continuous = true;
                    _v4SpeechRecognition.interimResults = true;
                    _v4SpeechRecognition.lang = (window.state && window.state.speechCode) ||
                        navigator.language || 'en-US';
                    let _base = (window.state && window.state.transcript) || '';
                    _v4SpeechRecognition.onresult = (ev) => {
                        let interim = '';
                        let finalText = _base;
                        for (let i = 0; i < ev.results.length; i++) {
                            const r = ev.results[i];
                            if (r.isFinal) finalText += (finalText ? ' ' : '') + r[0].transcript;
                            else interim += r[0].transcript;
                        }
                        const combined = (finalText + (interim ? ' ' + interim : '')).trim();
                        const ta = document.getElementById('v4-text-desc');
                        if (ta) ta.value = combined;
                        _setState({ transcript: combined, description: combined });
                    };
                    _v4SpeechRecognition.onend = () => {
                        // Auto-restart if still recording (some browsers
                        // end after each utterance).
                        if (_isV4Recording()) {
                            try { _v4SpeechRecognition.start(); } catch (_) {}
                        }
                    };
                    _v4SpeechRecognition.start();
                } catch (e) {
                    console.info('[v4 speech] start failed - raw audio still recording:', e);
                }
            }
        } catch (err) {
            console.error('[v4 mic] error:', err);
            if (typeof window.showToast === 'function') {
                // P1 (i18n audit, May 23) - was hard-coded EN.
                window.showToast(
                    (typeof window.t === 'function' && window.t('v4_mic_permission_denied'))
                    || 'Microphone access denied or not supported on this device.'
                );
            }
        }
    }
    function _stopV4Recording() {
        try {
            if (window.state && window.state.mediaRecorder &&
                window.state.mediaRecorder.state !== 'inactive') {
                window.state.mediaRecorder.stop();
            }
        } catch (e) { console.warn('[v4 mic] stop failed:', e); }
        if (_v4SpeechRecognition) {
            try { _v4SpeechRecognition.stop(); } catch (_) {}
            _v4SpeechRecognition = null;
        }
        // Q10 - refresh the captured strip so the voice chip turns green
        // the moment recording stops (state.audioBlob has been assembled
        // by the MediaRecorder's onstop handler).
        setTimeout(() => {
            try { _refreshCapturedStrip(); } catch (_) {}
        }, 100);
        window.state.isRecording = false;
        _setV4MicVisualState(false);
    }
    function _setV4MicVisualState(recording) {
        const btn = document.getElementById('btn-v4-mic');
        if (!btn) return;
        // fully i18n the mic-button label. Both branches now
        // resolve via window.t() with a hardcoded English last-resort
        // fallback (so unit-tests + first-paint pre-i18n still render).
        const _t = (typeof window.t === 'function') ? window.t : ((k) => k);
        const icon = btn.querySelector('i');
        const label = btn.querySelector('span');
        if (recording) {
            btn.classList.add('is-recording');
            if (icon) icon.className = 'fa-solid fa-stop';
            if (label) label.textContent = _t('v4_stop_recording') || 'Stop recording';
        } else {
            btn.classList.remove('is-recording');
            if (icon) icon.className = 'fa-solid fa-microphone';
            if (label) {
                label.textContent = _t('v4_record')
                    || _t('v4_record_voice_fallback')
                    || 'Record voice';
            }
        }
    }

    // Q10 - multi-modal "captured" strip on stage-v4-review.
    // Reads state.photoDataUrl + state.audioBlob + state.description and
    // toggles the .is-captured class on each chip with a localized state
    // label ("Captured", "1.2s", "12 chars", or "Not added"). Called
    // Description-card refresher (May 2026 review rethink).
    // Replaces the prior "captured-strip" rendering. Reads state and
    // either:
    //   (a) shows the FILLED-state preview (voice transcript snippet +
    //       text snippet + Edit button), OR
    //   (b) shows the EMPTY-state "+ Add voice or text" CTA.
    //
    // Called: on stage-v4-review entry, after voice recording stops,
    // and on every keystroke in the textarea (matches the prior
    // _refreshCapturedStrip cadence). Kept the old function name as
    // an alias so existing callsites don't break during the migration.
    function _refreshDescriptionCard() {
        const previewEl = document.getElementById('v4-desc-preview');
        const emptyEl = document.getElementById('v4-desc-empty');
        if (!previewEl || !emptyEl) return;

        const st = window.state || {};
        const tt = (k, fb) => (typeof window.t === 'function' ? (window.t(k) || fb) : fb);

        // Voice captured signal - matches the prior logic.
        const audioBlobOk = !!(st.audioBlob && st.audioBlob.size && st.audioBlob.size > 0);
        const transcript = (st.transcript || '').trim();
        const transcriptOk = transcript.length > 4;
        const voicePresent = audioBlobOk || transcriptOk;

        // Text captured signal.
        const textVal = (st.description || '').trim();
        const textPresent = textVal.length > 0;

        // Decide which state to render.
        const anyContent = voicePresent || textPresent;
        previewEl.hidden = !anyContent;
        emptyEl.hidden = anyContent;

        if (anyContent) {
            // Voice row - show transcript snippet (truncated) or a
            // "voice recorded" badge when audio exists but transcript
            // didn't transcribe.
            const voiceSnippet = document.getElementById('v4-desc-voice-snippet');
            const voiceRow = document.getElementById('v4-desc-voice-row');
            if (voiceSnippet && voiceRow) {
                if (voicePresent) {
                    voiceRow.removeAttribute('data-empty');
                    if (transcriptOk) {
                        // Truncate to ~60 chars + ellipsis for card height
                        // sanity. Full transcript still lives on state.
                        voiceSnippet.textContent = transcript.length > 60
                            ? transcript.slice(0, 60).trim() + '…'
                            : transcript;
                    } else {
                        voiceSnippet.textContent = tt('v4_desc_voice_recorded',
                            'Voice recorded');
                    }
                } else {
                    voiceRow.setAttribute('data-empty', 'true');
                    voiceSnippet.textContent = tt('v4_desc_voice_empty',
                        'No voice recorded');
                }
            }
            // Text row - show typed description snippet OR a placeholder
            // when only voice was captured.
            const textSnippet = document.getElementById('v4-desc-text-snippet');
            const textRow = document.getElementById('v4-desc-text-row');
            if (textSnippet && textRow) {
                if (textPresent) {
                    textRow.removeAttribute('data-empty');
                    // Avoid showing the same snippet twice when textarea
                    // mirrors transcript (current Web-Speech behaviour).
                    const sameAsVoice = transcriptOk && textVal === transcript;
                    if (sameAsVoice) {
                        textRow.setAttribute('data-empty', 'true');
                        textSnippet.textContent = tt('v4_desc_text_mirrors_voice',
                            'Same as voice transcript');
                    } else {
                        textSnippet.textContent = textVal.length > 60
                            ? textVal.slice(0, 60).trim() + '…'
                            : textVal;
                    }
                } else {
                    textRow.setAttribute('data-empty', 'true');
                    textSnippet.textContent = tt('v4_desc_text_empty',
                        'No text added');
                }
            }
        }
    }

    // Legacy alias so older callsites that still reference the prior
    // function name continue to work during the migration. Both names
    // call the same renderer.
    function _refreshCapturedStrip() { return _refreshDescriptionCard(); }
    // Expose for app.js setLanguage() (refresh after locale swap) and
    // for spec-90 to assert filled-vs-empty state without a full stage
    // re-entry.
    window.__crispV4RefreshDesc = _refreshDescriptionCard;

    // ── Send ────────────────────────────────────────────────────────────
    //
    // HC80 (May 2026) - operator reported the success stage never
    // painted after Send, leading to repeated taps and 5 duplicate
    // server-side report rows. Root causes addressed:
    //
    //   1. Pre-HC80 the handler awaited submitReport() BEFORE
    //      navigating, then setTimeout-ed goToStage('stage-success')
    //      after 500 ms IF still on review. On a slow chain (large
    //      photos / weak network) the user stared at "Sending…" for
    //      seconds with no movement, assumed it had failed, and
    //      kept tapping. Fix: navigate to stage-success IMMEDIATELY
    //      on click. The new HC79 success stage paints the radar +
    //      "Under review" pill instantly, so the user knows the
    //      report landed.
    //
    //   2. Pre-HC80 the button only had `sendBtn.disabled = true` as
    //      its dedup. K.4.b's `_submitInFlight` cleared as soon as
    //      the previous promise resolved - meaning a second tap that
    //      arrived 1 ms after the first resolution generated a fresh
    //      clientReportId + a fresh server row. Fix: app.js's HC80
    //      sticky `_submitCommitted` latch now refuses ANY second
    //      submitReport call until resetApp() opens the latch.
    //
    //   3. Pre-HC80 a submitReport failure re-enabled the button +
    //      showed "Send failed" toast, leaving the user on review.
    //      Combined with #1, the user often saw the toast WITHOUT
    //      having advanced - taps continued. Fix: even on failure,
    //      we stay on stage-success and the status pill flips to the
    //      offline "Queued" copy (already implemented in HC79).
    async function _onSend() {
        // ── UNDP core-question gate (Jun 2026) ──────────────────────────
        // The Problem Statement requires the infrastructure / crisis /
        // damage classifications AND the debris question to be answered
        // before a report may be submitted. The classify stage gates the
        // first three on the way through (_canAdvanceFrom), but this is the
        // last line of defence (back-nav edits, programmatic paths); debris
        // is answered here on review. The SERVER stays permissive - legacy
        // channels (SMS/IVR/WhatsApp) submit partial reports by design and
        // analysts classify them; this gate is the app-side UX enforcement.
        const _gateState = window.state || {};
        const _tt = (key, fallback) => {
            try {
                const fn = window.t;
                if (typeof fn === 'function') {
                    const v = fn(key);
                    if (v && v !== key) return v;
                }
            } catch (_) {}
            return fallback;
        };
        const _missingClassify =
            !_gateState.damage_classification || !_gateState.crisis_type
            || !_gateState.infrastructure_type
            || (_gateState.infrastructure_type === 'OTHER'
                && !String(_gateState.infrastructure_name || '').trim());
        if (_missingClassify) {
            if (typeof window.showToast === 'function') {
                window.showToast(_tt('v4_submit_missing_classify',
                    'Please answer the required questions first - damage, infrastructure and crisis type.'), 'warn');
            }
            try { window.__crispGoToStage('stage-v4-classify'); } catch (_) {}
            return;
        }
        if (!_packCollectsDebris()
            && _gateState.debris_present !== true && _gateState.debris_present !== false) {
            if (typeof window.showToast === 'function') {
                window.showToast(_tt('v4_submit_missing_debris',
                    'One required question left: is there debris to clear?'), 'warn');
            }
            const _debrisCard = document.getElementById('v4-debris-card');
            if (_debrisCard) {
                try { _debrisCard.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
                _debrisCard.classList.add('v4-debris-attn');
                setTimeout(() => _debrisCard.classList.remove('v4-debris-attn'), 1700);
            }
            return;
        }

        const sendBtn = document.getElementById('btn-v4-send');
        // Immediate visual feedback even though we navigate away
        // in the next tick.
        sendBtn.disabled = true;
        sendBtn.classList.add('is-sending');
        const _t = (typeof window.t === 'function') ? window.t : ((k) => k);
        const sendingLabel = _t('v4_sending') || 'Sending…';
        sendBtn.innerHTML =
            '<i class="fa-solid fa-circle-notch fa-spin"></i> '
            + sendingLabel;

        // HC80 - navigate to stage-success IMMEDIATELY. The user
        // sees the new mission-control snapshot (radar + "Under
        // review" + report ID + nearby) before submitReport even
        // starts hitting the backend. Removes the "stuck on review"
        // perception that drove the duplicate-tap loop.
        try {
            if (typeof window.__crispGoToStage === 'function') {
                window.__crispGoToStage('stage-success');
            }
        } catch (e) {
            console.warn('[HC80] pre-submit nav failed:', e);
        }

        // Barrier - if a location edit kicked off a crisis-pack re-resolution that
        // hasn't settled yet, wait for it (capped at 2.5 s) so __crispSubmitReport
        // reads the EDITED zone's state.crisisPack, not the stale device-zone pack.
        // The server only backstops crisis_event_id from coords - form_pack_id /
        // form_pack_version / form_data have NO server correction, so a fast
        // edit→send would otherwise tag the report with the wrong zone's pack. The
        // timeout keeps the offline-first guarantee (must-have #3): on a slow/dead
        // network we submit with whatever is in state rather than blocking.
        try {
            const _inflight = window.__crispV4PackInFlight;
            if (_inflight && typeof _inflight.then === 'function') {
                await Promise.race([_inflight, new Promise((res) => setTimeout(res, 2500))]);
            }
        } catch (_) {}

        // Kick off submitReport in the background. Don't await it
        // here - the user is already on stage-success watching the
        // status pill. HC80's _submitCommitted latch in app.js
        // prevents duplicate work even if a stray re-call fires.
        if (typeof window.__crispSubmitReport === 'function') {
            window.__crispSubmitReport()
                .then(() => {
                    // Success - the status pill already reads "Under
                    // review" thanks to HC79's render hook. Nothing
                    // more to do.
                })
                .catch((e) => {
                    console.error('[v4] send failed:', e);
                    // Flip the status pill to the offline/queued
                    // copy. _renderSuccessStatusPill picks this up
                    // from navigator.onLine + the queue state on
                    // its next paint; call it explicitly here so
                    // the user sees the state change immediately.
                    if (typeof window._renderSuccessStatusPill === 'function') {
                        try { window._renderSuccessStatusPill(); } catch (_) {}
                    }
                    if (typeof window.showToast === 'function') {
                        window.showToast(
                            (typeof window.t === 'function' && window.t('v4_send_failed_toast'))
                            || 'Send failed - your report was saved offline and will retry.',
                            'warn'    // warn, not error - the queue WILL retry
                        );
                    }
                });
        } else {
            // Defensive fallback - v3 #btn-send dispatch. Not
            // expected to fire in production (v4 is always active)
            // but kept so the handler degrades gracefully if app.js
            // is mid-deploy / mid-rollback.
            const v3Send = document.getElementById('btn-send') ||
                           document.getElementById('btn-review-submit');
            if (v3Send) v3Send.click();
        }
    }

    // ── Stage transitions ───────────────────────────────────────────────
    function _goToCapture() {
        // clear prior report state before showing
        // the capture stage. Without this, "Add another report" left the
        // previous photo in v4Photos, the previous description in state,
        // the previous buildingId / locationName / serviceStatus, and
        // re-armed Continue prematurely. v3 already does this via resetApp
        // → _clearCaptureState; v4 must follow the same contract.
        if (typeof window._clearCaptureState === 'function') {
            try { window._clearCaptureState(); } catch (e) { console.warn('[v4] reset failed:', e); }
        }
        // _clearCaptureState only knows about v3 fields; clear the
        // v4-specific accumulator + thumb strip explicitly.
        if (window.state) window.state.v4Photos = [];
        // reset the classify-stage closure
        // variables + DOM selections. _clearCaptureState (above)
        // resets the underlying state.damage_classification /
        // infrastructure_type / crisis_type fields it now also
        // knows about, but the DOM .is-selected highlight + the
        // sub-step pointer survive across submits unless explicitly
        // reset here. Without this, the user sees the previous
        // report's damage / infra / crisis chips still highlighted
        // when they enter the new report's classify stage.
        _classifyStep = 'damage';
        document.querySelectorAll(
            '.v4-q-opt.is-selected, ' +              // damage radio buttons
            '.v4-hit-tile.is-selected, ' +           // infra hit-tiles
            '.v4-cause-card.is-selected, ' +         // crisis cause group cards
            '.v4-cause-sub-opt.is-selected, ' +      // crisis sub-types
            '.v4-chipgrid-tile.is-selected'          // generic chipgrid tiles (catch-all)
        ).forEach((el) => {
            el.classList.remove('is-selected');
            el.setAttribute('aria-checked', 'false');
        });
        // Collapse the crisis drill-down panel if the previous report
        // left it expanded.
        const subtypesContainer = document.getElementById('v4-cause-subtypes');
        if (subtypesContainer) subtypesContainer.setAttribute('hidden', '');
        const groupCardsCt = document.getElementById('v4-cause-cards');
        if (groupCardsCt) groupCardsCt.removeAttribute('hidden');
        const thumbsRow = document.getElementById('v4-thumbs');
        if (thumbsRow) {
            thumbsRow.innerHTML = '';
            thumbsRow.style.display = 'none';
        }
        const nextBtn = document.getElementById('btn-v4-capture-next');
        if (nextBtn) {
            nextBtn.disabled = true;
            nextBtn.classList.remove('is-ready');
        }
        // Clear the v4 summary thumb (page 3) so a stale image doesn't
        // bleed through if user hits Back.
        const summaryThumb = document.getElementById('v4-summary-thumb');
        if (summaryThumb) {
            summaryThumb.classList.remove('has-photo');
            summaryThumb.innerHTML = '<i class="fa-solid fa-camera"></i>';
        }
        // Clear v4 description textarea + voice drawer state.
        const textArea = document.getElementById('v4-text-desc');
        if (textArea) textArea.value = '';
        // Reset UNDP sheet UI to defaults (May 2026 - bottom-sheet refresh).
        // The sheet's controls are `.undp-q-card` blocks with `.undp-lvl`
        // / `.undp-pill` / `.undp-yn` / `.undp-need` children. A single
        // `.is-selected` removal sweep handles every single- and
        // multi-select control inside the sheet. Also resets the
        // trigger-button badge back to "Optional".
        const _undpSheetEl = document.getElementById('v4-undp-sheet');
        if (_undpSheetEl) {
            _undpSheetEl.querySelectorAll('.is-selected').forEach((el) =>
                el.classList.remove('is-selected'));
        }
        if (typeof window.__crispV4RefreshUndpBadge === 'function') {
            try { window.__crispV4RefreshUndpBadge(); } catch (_) {}
        }

        window.__crispGoToStage('stage-v4-capture');
        setTimeout(_refreshGps, 100);
    }
    function _goToClassify() {
        window.__crispGoToStage('stage-v4-classify');
        // Re-assert the current sub-step against the live order so the crispack
        // view re-renders from the (possibly edited-location-swapped) state.crisisPack
        // instead of a stale device-zone form. _goToClassify previously never
        // called _showSubStep, so a back-nav after a location edit kept the old
        // questions on screen. Validate _classifyStep is still in the order (an edit
        // can add/remove the crispack or crisis step); fall back to the first step
        // only if it disappeared - never reset the reporter's place otherwise.
        try {
            const order = _classifyOrder();
            const step = order.indexOf(_classifyStep) >= 0 ? _classifyStep : order[0];
            _showSubStep(step);
        } catch (_) {}
        _updateReviewSummary();
    }
    function _goToReview() {
        window.__crispGoToStage('stage-v4-review');
        _updateReviewSummary();
    }

    // ── Hook into btn-start ─────────────────────────────────────────────
    function _hookBtnStart() {
        const btn = document.getElementById('btn-start');
        if (!btn) return;
        // Replace the existing handler with a v4-aware one. Since v3's
        // handler is added via addEventListener, we can't remove it - but
        // we can intercept at capture phase and stop propagation.
        btn.addEventListener('click', (e) => {
            if (window.__crispUiV4) {
                e.preventDefault();
                e.stopImmediatePropagation();
                _goToCapture();
            }
        }, true);  // capture: true ensures we run before v3's bubble-phase listener
    }

    // ── Init when DOM + app.js ready ────────────────────────────────────
    _whenReady(() => {
        _initCaptureStage();
        _initClassifyStage();
        _initReviewStage();
        _hookBtnStart();

        // Expose for tests + telemetry.
        window.CrispV4 = {
            goToCapture: _goToCapture,
            goToClassify: _goToClassify,
            goToReview: _goToReview,
            isEnabled: () => window.__crispUiV4 === true,
            // BUG 4 - voice-only path. Exposing the recorder
            // surface lets tests verify the contract even in headless
            // environments without a real mic (mocking MediaRecorder).
            startRecording: _startV4Recording,
            stopRecording: _stopV4Recording,
            isRecording: _isV4Recording,
            // Crisis chips render lazily (only on the crisis substep);
            // expose the source-of-truth data for tests that need to
            // assert UNDP taxonomy coverage without driving the UI.
            getCrisisTypes: () => Object.values(CRISIS_GROUPS).flat().map((c) => c.v),
        };

        // Initial GPS fetch when entering capture.
        _refreshGps();

        console.log('[v4] flow initialised - UI v4 active');
    });

    // Listen for direct stage-show events to refresh GPS + summary.
    // app.js dispatches `stage-entered` on every goToStage() call with
    // `event.detail = stage_id` (a string).
    document.addEventListener('stage-entered', (e) => {
        if (!_ready()) return;
        const stage = typeof e.detail === 'string' ? e.detail : (e.detail?.stage || '');
        if (stage === 'stage-v4-capture') _refreshGps();
        if (stage === 'stage-v4-review') _updateReviewSummary();
    });
})();
