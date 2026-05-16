// ──────────────────────────────────────────────────────────────────────────
// CRISP — UI v4 capture flow (3-page, ≤10 click target).
//
// Pages:
//   1. stage-v4-capture   — OS-native camera + auto-meta (location/time)
//   2. stage-v4-classify  — 3 questions on one screen (damage chips + infra
//                           carousel + crisis carousel)
//   3. stage-v4-review    — summary + voice/text drawer + UNDP details
//                           (expanded by default for UNDP judges)
//
// Gated behind UI_V4_ENABLED (defaults ON; ?ui=v3 URL or
// localStorage['crisp_ui_v4']='off' falls back to legacy v3 flow).
//
// AI pre-fill (Page 2):
//   On photo capture, if measured upload bandwidth ≥ FAST tier and an
//   AbortController-bound 1.5 s timeout permits, POST the image to
//   /api/v1/reports/classify-suggest. When the response arrives, the
//   3 chip rows snap to the AI-suggested values. The user is NEVER
//   blocked waiting for AI — Continue is enabled the moment the photo
//   lands. AI only updates pre-selected defaults if it returns in time.
//
// State sharing with v3:
//   v4 reads/writes the SAME `window.state` object that v3 uses, so on
//   send we just call the existing `submit()` / queue helpers. Building-
//   footprint selector, voice transcription, GPS auto-detect — all live
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
        // — app.js exposes `__crispGoToStage` within the first ~50-100 ms
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
    //   2. The repo presents ONE capture flow — easier to audit, easier
    //      to maintain, smaller attack surface, no dead branches in JS.
    //
    // V4 still calls into V3 HELPER FUNCTIONS (state object,
    // `__crispIngestFile`, `openCameraModal`, `__crispSubmitReport`,
    // `enqueueReport`, BuildingSelect listener for stage-v4-review) —
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

        // a11y — every role="radio" must carry aria-checked
        // (true OR false). Previously only the selected tile had the
        // attribute → axe-core "aria-required-attr" critical failure.
        // M10 — custom Lucide-style SVG icons for the four
        // crisis types FontAwesome handled awkwardly: tsunami (was just
        // a generic up-arrow water), wildfire (was a single flame —
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
    // Backward-compat alias — anything still calling _initCarousel routes
    // through the new grid. v4-flow's own classify init uses the new name
    // directly below.
    const _initCarousel = _initChipGrid;

    // ── State helpers (write into shared window.state) ──────────────────
    function _setState(patch) {
        Object.assign(window.state, patch);
    }
    function _getState() { return window.state; }

    // Hard cap on photos per report. Matches the v3 MAX_PHOTOS_TOTAL
    // (4 extras + 1 primary). Earlier, the `+` button in the v4 thumb
    // strip accepted photos past the cap because v4's _handlePhoto did
    // not check. Now enforced at three gates: _handlePhoto,
    // _renderThumbs (hides the + button at the cap), and the chooser
    // overlay.
    const V4_MAX_PHOTOS = 5;

    // ── Page 1: capture ─────────────────────────────────────────────────
    /**
     * Phase 3 (May 2026 — docs §4.4) — consume any
     * `crisp_prefill_v1` envelope written by nearby.js when the user
     * tapped a nearby group. Pre-populates building_id / location /
     * crisis_type into the capture-flow state, and surfaces the
     * cluster's `severity_max` as a SUGGESTED severity (user can
     * always tap to override). Cleared after consumption so a
     * subsequent direct-capture entry doesn't get stale prefill.
     *
     * Safe to call repeatedly — the sessionStorage key is the
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
            // Lat/lng — group centroid, NOT a specific reporter's
            // coords. Privacy-safe.
            if (typeof env.centroid_lat === 'number' && typeof env.centroid_lng === 'number') {
                s.location = s.location || {};
                s.location.lat = env.centroid_lat;
                s.location.lng = env.centroid_lng;
                s.location.acc = 0;
                s.location.is_prefilled_from_nearby = true;
            }
            // Building id — public OSM ref, no PII.
            if (env.building_id) {
                s.building_id = env.building_id;
                s.building_id_from_nearby = true;
            }
            // Crisis type SUGGESTION — populated as a default
            // selection, NOT silently locked. The capture stage
            // surfaces it under the "Suggested" tag.
            if (env.crisis_type && !s.crisis_type) {
                s.crisis_type = env.crisis_type;
                s.crisis_type_suggested = true;
            }
            // Severity SUGGESTION — Phase-3 operator decision:
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
        // Phase 3 — consume prefill BEFORE any other init so the
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
        function _saveLocEdit() {
            if (!locEditInput) return;
            const name = locEditInput.value.trim();
            if (name) {
                const patch = {
                    userLocationName: name,
                    locationName: name,
                };
                let _locationMoved = false;
                // If the user picked a suggestion AND didn't edit the text
                // after, also update lat/lng + the location object so the
                // map + coords sub-line reflect the corrected place.
                if (_locSelected && _locSelected.name === name &&
                    Number.isFinite(_locSelected.lat) && Number.isFinite(_locSelected.lng)) {
                    patch.location = {
                        lat: _locSelected.lat,
                        lng: _locSelected.lng,
                        accuracy: null,
                        source: 'user_corrected',
                    };
                    _locationMoved = true;
                }
                _setState(patch);
                _paintV4LocationPills();
                // BUGFIX May 2026 — UNDP must-have #6 regression.
                //
                // Operator-reported: reporter physically in Electronic City
                // changed the report's location to Panaji, Goa (~700 km away).
                // The v4 Step-3 inline map updated its terrain but NO OSM
                // building outlines appeared — the "Tap a building outline"
                // instruction was moot, forcing free-text fallback and silently
                // breaking UNDP must-have #6.
                //
                // Root cause: `_saveLocEdit` updated `state.location` but never
                // told BuildingSelect to re-fetch buildings for the new bbox.
                // The fullscreen picker had a workaround call site (app.js
                // line 10374); the inline editor was missing the equivalent.
                //
                // Fix: dispatch a `crisp-location-changed` CustomEvent that
                // BuildingSelect listens to, and as a defence-in-depth call
                // `ensureMap` directly here. Either path repaints the
                // building polygon overlay for the new lat/lng.
                if (_locationMoved && patch.location) {
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
                }
            }
            _closeLocEdit();
        }
        if (locEditBtn) locEditBtn.addEventListener('click', _openLocEdit);
        if (locEditCancelBtn) locEditCancelBtn.addEventListener('click', _closeLocEdit);
        if (locEditSaveBtn) locEditSaveBtn.addEventListener('click', _saveLocEdit);
        if (locEditInput) {
            // May 2026 — debounced remote fallback. Previously the input
            // handler ONLY called placeSearch.search() (offline: ~700
            // bundled cities + nearby-GPS pre-fetch + localStorage cache).
            // Anything outside that set — "Dudhwa National Park", a
            // village, a landmark, a town outside the prefetch box —
            // returned [] and the user saw NO suggestions. The
            // searchRemote() helper exists in places.js:498 and hits
            // Nominatim; it was just never wired into v4. Now:
            //   · Local results render INSTANTLY (cached + bundled) for
            //     responsive typing
            //   · Remote fetch fires after 350ms of typing pause + only
            //     when online; results merge with local + re-render
            //   · navigator.onLine off → skip remote, hint "offline —
            //     limited suggestions"
            //   · Empty merged results → hint "no matches — try a
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
                // results stay on top — they're frequently the user's
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
                    _showHint('Offline — only cached places searched. Connect to find more.', 'offline');
                } else {
                    _showHint('No matches yet — try a nearby city or be more specific.', 'empty');
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
                    _showHint('Offline — searching cached places only…', 'offline');
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
                    } catch (_) { /* searchRemote unavailable — keep local hint */ }
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

            // May 2026 — smart-contextual tips card. Mark each tip as
            // done when its corresponding capture lands; CSS dims the
            // tip + reveals a green check. Wired into the same
            // section-badge refresh so it stays in sync with the
            // existing chip-status painter.
            const tips = document.getElementById('v4-cap-tips');
            if (tips) {
                tips.classList.toggle('tip-done-photo', photos > 0);
                tips.classList.toggle('tip-done-voice', audioOk);
                tips.classList.toggle('tip-done-text',  anyText);
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
        }
        if (voiceChipBtn && voicePanel) {
            voiceChipBtn.addEventListener('click', () => {
                const expanding = voiceChipBtn.getAttribute('aria-expanded') !== 'true';
                _setChipExpanded(voiceChipBtn, voicePanel, expanding);
                // Auto-collapse the other chip's panel to keep the
                // capture stage compact — only one extra surface open
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
        //   • Camera   — opens the same smart camera path as the hero
        //                button (live getUserMedia on desktop, OS
        //                camera on iOS / Android).
        //   • Browse   — opens the existing file-picker (gallery).
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
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
            const hasGUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
            if (!isIOS && hasGUM && typeof window.openCameraModal === 'function') {
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

                    // BUGFIX May 2026 — we used to clear state.extraPhotos
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
                        nextBtn.disabled = false;
                        nextBtn.classList.add('is-ready');
                    }
                    if (capHit && candidates.length > added) {
                        _toastCapHit();
                    }
                    // User taps Continue manually after each step — no
                    // auto-advance, no AI-assisted prefill.
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
        // Hero button (first-capture slot) — uses the extracted smart
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

        // Photo handler — delegates to v3's `__crispIngestFile` so the
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
        // the v4 thumbnail — same data URL, no extra encode pass.
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
                // BUGFIX May 2026 — `asExtra` MUST be true for every photo
                // beyond the first one in this session. Previously this
                // call was hard-coded `asExtra: false`, which made the v3
                // ingest helper write the new file into state.photoDataUrl
                // + state.photoVariants — OVERWRITING the primary slot
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
                    // The fallback only knows about the primary slot —
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
                    // Primary path — same wait-for-change loop as before.
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
        // window yet (race during boot — should be rare). Sets the
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
            // BUGFIX May 2026 — serialise the per-file ingest calls.
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
            // Voice-only path — skip directly to review with no photo.
            _setState({ v4VoiceOnly: true });
            nextBtn.disabled = false;
            _goToClassify();
        });

        nextBtn.addEventListener('click', _goToClassify);
        backBtn.addEventListener('click', () => window.__crispGoToStage('stage-home'));

        retryGpsBtn.addEventListener('click', () => {
            _refreshGps();
        });

        // ── Delta-C — multi-modal additive capture wiring ──
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

        // Voice mic — start/stop using the same MediaRecorder helpers
        // wired for the (now legacy) review-stage drawer.
        if (capMicBtn) {
            capMicBtn.addEventListener('click', () => {
                if (_isV4Recording()) {
                    _stopV4Recording();
                    capMicBtn.classList.remove('is-recording');
                    const lbl = capMicBtn.querySelector('span');
                    if (lbl) lbl.textContent =
                        (typeof window.t === 'function' ? (window.t('v4_record') || 'Record voice') : 'Record voice');
                    const ic = capMicBtn.querySelector('i');
                    if (ic) ic.className = 'fa-solid fa-microphone';
                } else {
                    _startV4Recording();
                    capMicBtn.classList.add('is-recording');
                    const lbl = capMicBtn.querySelector('span');
                    if (lbl) lbl.textContent =
                        (typeof window.t === 'function' ? (window.t('v4_stop') || 'Stop recording') : 'Stop recording');
                    const ic = capMicBtn.querySelector('i');
                    if (ic) ic.className = 'fa-solid fa-stop';
                }
                setTimeout(_refreshCapStrip, 120);
            });
        }

        // Textarea — mirror to state.description + transcript so submit
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
        // are gone — the compact Voice/Text chips above handle their
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
            if (stage === 'stage-v4-capture') _refreshCapStrip();
        });

        // Expose the refresh so the existing _handlePhoto + recording
        // helpers can fire it after they mutate state.
        window.__crispV4RefreshCapStrip = _refreshCapStrip;

        function _renderThumbs() {
            const photos = _getState().v4Photos || [];
            if (!photos.length) {
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
                    const state = _getState();
                    const removed = state.v4Photos[idx];
                    state.v4Photos.splice(idx, 1);

                    // BUGFIX May 2026 — keep state.extraPhotos in sync.
                    // submitReport reads from state.extraPhotos to build
                    // the upload work list. If a user removes a thumbnail
                    // here but the corresponding extraPhotos entry stays,
                    // submit queues a deleted photo. Match by dataUrl.
                    if (removed && state.extraPhotos && state.extraPhotos.length > 0) {
                        const extraIdx = state.extraPhotos.findIndex(
                            (e) => e && e.dataUrl === removed.url
                        );
                        if (extraIdx >= 0) state.extraPhotos.splice(extraIdx, 1);
                    }

                    // If the user removed the PRIMARY (idx === 0) and
                    // there's at least one other photo, promote the new
                    // first v4Photo into the primary slot — its variants
                    // live in state.extraPhotos (because the asExtra
                    // pipeline persisted them there). Copy the variants
                    // up into state.photoVariants so submitReport's
                    // primary-photo branch finds them.
                    if (idx === 0 && state.v4Photos.length > 0) {
                        const newPrimary = state.v4Photos[0];
                        // Find the matching extraPhotos entry for the
                        // promoted photo (still there if it was an
                        // extra) and lift its data into primary slots.
                        const promotedExtraIdx = state.extraPhotos.findIndex(
                            (e) => e && e.dataUrl === newPrimary.url
                        );
                        if (promotedExtraIdx >= 0) {
                            const promoted = state.extraPhotos[promotedExtraIdx];
                            state.photoDataUrl = promoted.dataUrl;
                            state.photoBlob = promoted.blob;
                            state.photoVariants = promoted.variants || null;
                            state.photoGroupId = promoted.groupId || state.photoGroupId;
                            state.photoClientBlurApplied = Boolean(promoted.clientBlurApplied);
                            // Once promoted, drop the extras entry — it's
                            // now represented in the primary slot.
                            state.extraPhotos.splice(promotedExtraIdx, 1);
                        }
                    }
                    if (state.v4Photos.length === 0) {
                        nextBtn.disabled = true;
                        nextBtn.classList.remove('is-ready');
                        _setState({
                            photoBlob: null,
                            photoDataUrl: null,
                            photoVariants: null,
                            extraPhotos: [],
                        });
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
        if (captureText) captureText.textContent = label;
        if (reviewText) reviewText.textContent = label;
        // Coords sub-line. Hidden when no GPS yet, shown as "12.9716°N,
        // 77.5946°E · ±20m" otherwise.
        const coordsEl = document.getElementById('v4-meta-loc-coords');
        if (coordsEl) {
            const loc = s.location;
            if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
                const acc = Math.max(0, Math.round(loc.acc || 0));
                coordsEl.textContent =
                    `${loc.lat.toFixed(4)}°, ${loc.lng.toFixed(4)}°` +
                    (acc > 0 ? ` · ±${acc} m` : '');
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
    // May 2026 — three-line timestamp. Was a single line like
    // "2026-05-12 22:39:35 GMT+5:30" which buried the meaningful
    // bits behind a numeric offset operators don't recognise at a
    // glance. New layout (top → bottom):
    //   • IANA timezone name           e.g. "Asia/Kolkata"
    //   • Human-readable timezone      e.g. "India Standard Time"
    //   • Local 12-hour clock          e.g. "10:42 PM"
    // All three drawn from Intl.DateTimeFormat — supported by every
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

        // 1. IANA timezone name — resolvedOptions.timeZone returns the
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

        // 2. Human-readable timezone label — timeZoneName 'long' gives
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

        // 3. Local 12-hour clock — "10:42 PM". hour: 'numeric' (not
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

        if (elIana)  elIana.textContent  = iana;
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

    function _refreshGps() {
        const text = document.getElementById('v4-meta-location-text');
        if (!text) return;
        // i18n the status strings.
        const _t = (typeof window.t === 'function') ? window.t : ((k) => k);
        const LOCATING = _t('v4_gps_locating') || 'Locating…';
        const UNAVAILABLE = _t('v4_gps_unavailable') || 'GPS unavailable';
        const current = _getState();
        text.textContent = current.locationName || LOCATING;

        // v7 (May 2026, operator bug) — "GPS shows not available when I
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
                    // 30-min staleness gate — same as nearby.js.
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

        // Apply cached GPS IMMEDIATELY as a fallback so the user sees
        // a location instantly — fresh fix will overwrite if it lands.
        const cached = _readCachedGps();
        if (cached && !current.location) {
            _setState({ location: cached });
            _paintV4LocationPills();
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
                } else if (!cached) {
                    // No fresh, no cache, no IP — give up.
                    text.textContent = current.locationName || UNAVAILABLE;
                }
            }).catch(() => {
                if (!cached) text.textContent = current.locationName || UNAVAILABLE;
            });
        }

        if (!navigator.geolocation) {
            // No geo API at all — IP fallback if we don't already have cache.
            if (!cached) _tryIpFallback();
            return;
        }

        navigator.geolocation.getCurrentPosition((pos) => {
            const { latitude, longitude, accuracy } = pos.coords;
            _setState({ location: { lat: latitude, lng: longitude, acc: accuracy } });
            _writeCachedGps(latitude, longitude, accuracy);
            _paintV4LocationPills();
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
            // and silently move on — no "unavailable" placeholder.
            if (cached) return;
            // No cache → IP fallback.
            _tryIpFallback();
        }, {
            // v7 — maximumAge bumped 60_000 → 300_000 so the browser's
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
    // Crisis sub-step renders as a single flat grid (May 2026 rewrite —
    // was a drill-down with group cards + subtype-list; operator
    // flagged the extra click). All 9 crisis types visible at once,
    // organised under 3 visual section headers. Same i18n keys + same
    // server contract (single `state.crisis_type` UNDP enum value).
    const CRISIS_GROUPS = {
        natural: [
            { v: 'EARTHQUAKE', i: 'fa-house-crack', k: 'crisis_earthquake' },
            { v: 'FLOOD',      i: 'fa-water',       k: 'crisis_flood' },
            { v: 'TSUNAMI',    svg: '<path d="M2 17c3 0 4-3 8-3s5 3 9 3"/><path d="M2 21c3 0 4-3 8-3s5 3 9 3"/><path d="M9 14c0-3 1-5 3-7l4 8"/>', k: 'crisis_tsunami' },
            // UNDP wording is "Hurricane/Cyclone" — one category. CYCLONE
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
                _setState({ damage_classification: opt.getAttribute('data-value') });
                _updateReviewSummary();
                _refreshClassifyNext();
                // Auto-progress to "What was hit?" after a 200ms
                // confirmation pulse. Race-guarded.
                _scheduleClassifyAdvance('damage', opt);
            });
        });
        // Default selected = the one already with .is-selected (Partial).
        const defaultOpt = damageOpts.find((o) => o.classList.contains('is-selected'));
        if (defaultOpt) _setState({ damage_classification: defaultOpt.getAttribute('data-value') });

        // Infra tiles (sub-view 2). Tap a tile to mark selection;
        // user taps Continue to advance. No auto-advance anywhere in
        // the classify flow — it surprised low-literacy users and
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
                // step (still pulses) — advance waits for Enter/blur on
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
        // — see helper above. Idempotent (sets a sentinel on the
        // element so repeat init calls don't double-bind).
        _wireInfraOtherAdvance();

        // ── Crisis tiles, flat layout (sub-view 3) — May 2026 ──
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

        // Delegated click handler — survives the innerHTML rewrites
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
                const idx = CLASSIFY_ORDER.indexOf(_classifyStep);
                if (idx <= 0) {
                    window.__crispGoToStage('stage-v4-capture');
                    return;
                }
                _showSubStep(CLASSIFY_ORDER[idx - 1]);
            });
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                if (!_canAdvanceFrom(_classifyStep)) return;
                const idx = CLASSIFY_ORDER.indexOf(_classifyStep);
                if (idx === CLASSIFY_ORDER.length - 1) {
                    _goToReview();
                    return;
                }
                _showSubStep(CLASSIFY_ORDER[idx + 1]);
            });
        }

        // Re-render i18n now that views are populated.
        if (typeof window.applyI18n === 'function') {
            try { window.applyI18n(); } catch (e) {}
        }

        // Default sub-step on stage entry. Reset when user arrives from
        // earlier in the flow; preserved otherwise (e.g. back from
        // review — they should land on crisis again).
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
        // BUGFIX May 2026 — _clearCaptureState() (app.js, end) dispatches
        // this event after wiping state. Without this listener, the
        // user-visible flow after "Add Another Report" was:
        //   · _classifyStep stayed 'crisis' from the prior submit
        //   · DOM still showed the crisis sub-step ("WHAT CAUSED IT · 3 of 3")
        //   · state.crisis_type was null (correctly cleared)
        //   · Continue button kept whichever enabled/disabled state the
        //     LAST _refreshClassifyNext call had set — confusing
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
            // Clear any selected crisis tile so the user doesn't see a
            // stale highlight on the next entry. May 2026 — replaces
            // the older "_crisisGroup = null + show group cards / hide
            // subtypes" reset; the drill-down was retired when the
            // crisis sub-step was flattened to a single grid.
            try {
                const grid = document.getElementById('v4-cause-grid');
                if (grid) {
                    grid.querySelectorAll('.v4-cause-tile.is-selected').forEach((t) => {
                        t.classList.remove('is-selected');
                        t.setAttribute('aria-checked', 'false');
                    });
                }
            } catch (_) {}
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
        return true;
    }
    // ── Auto-progress helpers — May 2026 ──────────────────────────────
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
    // tap — it reveals the free-text input and waits for the user to
    // press Enter or blur the input with non-empty text. See the
    // separate _wireInfraOtherAdvance() below.
    const CLASSIFY_ADVANCE_MS = 200;
    const CLASSIFY_ADVANCE_MS_REDUCED = 80;
    let _advancingFromStep = null;

    function _doClassifyAdvance(step) {
        if (!_canAdvanceFrom(step)) return;
        const idx = CLASSIFY_ORDER.indexOf(step);
        if (idx === -1) return;
        if (idx === CLASSIFY_ORDER.length - 1) {
            _goToReview();
            return;
        }
        _showSubStep(CLASSIFY_ORDER[idx + 1]);
    }

    function _scheduleClassifyAdvance(step, tileEl) {
        // Race guard — bail if an advance is already in flight from
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
                // OTHER tile: don't navigate — input is now visible +
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
        // match — we no-op.)
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
        if (!CLASSIFY_ORDER.includes(step)) return;
        // If the user navigated back via the Back button (or programmatic
        // _showSubStep call), clear any pending advance from the
        // departing step.
        _advancingFromStep = null;
        _classifyStep = step;
        ['damage','infra','crisis'].forEach((s) => {
            const view = document.getElementById('v4-view-' + s);
            if (!view) return;
            if (s === step) view.removeAttribute('hidden');
            else view.setAttribute('hidden', '');
        });
        // Sub-step label
        const label = document.getElementById('v4-substep-label');
        if (label) {
            const titleKey = step === 'damage' ? 'v4_substep_how_bad'
                          : step === 'infra'  ? 'v4_substep_what_hit'
                          : 'v4_substep_what_caused';
            const stepNum = CLASSIFY_ORDER.indexOf(step) + 1;
            const ttl = (typeof window.t === 'function' ? window.t(titleKey) : titleKey);
            label.innerHTML = `<span>${ttl}</span><span class="v4-substep-of"> · ${stepNum} of 3</span>`;
        }
        // Continue button enabled based on current selection.
        const nextBtn = document.getElementById('btn-v4-classify-next');
        if (nextBtn) {
            const ok = _canAdvanceFrom(step);
            nextBtn.disabled = !ok;
            nextBtn.classList.toggle('is-ready', ok);
        }
        // Reset crisis drill-down state when arriving at the crisis step
        // fresh — ensures the group-card surface shows by default.
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
            _refreshGps();
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
                // Q10 — refresh the multi-modal captured strip
                // every time the user lands on stage-v4-review. Photo /
                // voice / text states could have changed during navigation
                // (back→capture→retake, drawer→record, etc.).
                try { _refreshCapturedStrip(); } catch (err) { console.warn('[Q10] strip:', err); }
            }
        });

        // May 2026 — V4 review-card click handlers (operator rethink).
        // The captured-strip + summary card + voice-drawer trio was
        // replaced by 4 single-purpose content cards. Each card is its
        // own button or has its own edit button — wire each here.

        // Card 1 (Photo) — tap → return to capture stage.
        const photoCard = document.getElementById('v4-edit-photo');
        if (photoCard) {
            photoCard.addEventListener('click', () => {
                window.__crispGoToStage('stage-v4-capture');
            });
        }

        // Card 2 (Description) — both the "Edit" pill in the filled-state
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
        // Tap classification rows → jump back to Page 2 with focus on that row.
        document.getElementById('v4-edit-infra').addEventListener('click', () => {
            window.__crispGoToStage('stage-v4-classify');
            setTimeout(() => {
                document.getElementById('v4-carousel-infra')?.scrollIntoView({ behavior: 'smooth' });
            }, 200);
        });
        document.getElementById('v4-edit-crisis').addEventListener('click', () => {
            window.__crispGoToStage('stage-v4-classify');
            setTimeout(() => {
                document.getElementById('v4-carousel-crisis')?.scrollIntoView({ behavior: 'smooth' });
            }, 200);
        });
        document.getElementById('v4-edit-damage').addEventListener('click', () => {
            window.__crispGoToStage('stage-v4-classify');
        });

        // Voice drawer — wire mic + textarea.
        // voice-only path. v4 originally forwarded
        // btn-v4-mic clicks to btn-mic.click(), which writes to v3-only
        // DOM (mic-icon, mic-label, rec-timer) — invisible in v4. Now
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
                // Q10 — refresh the strip on every keystroke so the text chip
                // turns green the moment the textarea has any content.
                try { _refreshCapturedStrip(); } catch (_) {}
            });
        }

        // ── UNDP details bottom-sheet (May 2026 — operator-restored UX) ───
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
            const filled = [
                !!s.electricity_status,
                !!s.water_status,
                !!s.health_status,
                s.debris_present !== null && s.debris_present !== undefined,
                Array.isArray(s.pressing_needs) && s.pressing_needs.length > 0,
            ].filter(Boolean).length;
            const badge = _undpTrigger.querySelector('.undp-details-cta-time');
            if (!badge) return;
            if (filled === 0) {
                // Defer to i18n for the default state — t() returns the
                // active locale's "Optional" translation or the EN
                // fallback if the key isn't resolved yet.
                try {
                    const fn = window.t || ((k) => k);
                    const v = fn('v4_undp_trigger_time');
                    badge.textContent = (v && v !== 'v4_undp_trigger_time') ? v : 'Optional';
                } catch { badge.textContent = 'Optional'; }
            } else {
                badge.textContent = `${filled}/5`;
            }
        }
        // Expose so app.js setLanguage() can call after i18n re-application.
        window.__crispV4RefreshUndpBadge = _refreshTriggerBadge;

        // Sheet open / close — pure DOM, no state change.
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
        // Escape key support — accessibility parity with .nearby-sheet.
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

    function _updateReviewSummary() {
        const s = _getState();
        const setText = (id, val) => {
            const el = document.getElementById(id);
            if (el && val) el.textContent = val;
        };
        setText('v4-row-infra-text', s.infrastructure_type
            ? s.infrastructure_type.replace('_', ' ').toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase())
            : '—');
        setText('v4-row-crisis-text', s.crisis_type
            ? s.crisis_type.replace('_', ' ').toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase())
            : '—');
        setText('v4-row-damage-text', s.damage_classification
            ? s.damage_classification.charAt(0) + s.damage_classification.slice(1).toLowerCase()
            : '—');

        // Photo thumb. hot-fix: add `.has-photo` class so the
        // dashed-border placeholder styling flips to a clean image card.
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
        // Update photo-card count + meta line (May 2026 review rethink).
        // Shows "1 photo" / "N photos" + a privacy reassurance line.
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

        // Description card — paint filled vs empty state from state.*
        // (operator review rethink, May 2026).
        try { _refreshDescriptionCard(); } catch (_) {}
    }

    // ── V4 voice recorder ────────────────────────
    // Self-contained MediaRecorder wrapper. Mirrors v3's startRecording
    // + stopRecording but updates the v4 mic-button visual state and
    // the v4 textarea instead of v3's #live-transcript / #mic-label.
    // state.audioBlob + state.audioChunks remain the contract submit
    // reads — v3 + v4 share the upload path, so audio sent from v4 lands
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
                    console.info('[v4 speech] start failed — raw audio still recording:', e);
                }
            }
        } catch (err) {
            console.error('[v4 mic] error:', err);
            if (typeof window.showToast === 'function') {
                window.showToast('Mic permission denied or unsupported.');
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
        // Q10 — refresh the captured strip so the voice chip turns green
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

    // Q10 — multi-modal "captured" strip on stage-v4-review.
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

        // Voice captured signal — matches the prior logic.
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
            // Voice row — show transcript snippet (truncated) or a
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
            // Text row — show typed description snippet OR a placeholder
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
    async function _onSend() {
        const sendBtn = document.getElementById('btn-v4-send');
        sendBtn.disabled = true;
        sendBtn.classList.add('is-sending');
        // i18n the spinner label. Note: we keep the icon as a
        // sibling so RTL layouts mirror correctly via flex flow.
        const _t = (typeof window.t === 'function') ? window.t : ((k) => k);
        const sendingLabel = _t('v4_sending') || 'Sending…';
        sendBtn.innerHTML =
            '<i class="fa-solid fa-circle-notch fa-spin"></i> '
            + sendingLabel;

        try {
            // Defer to the existing v3 submit() / queue path. v3's logic
            // reads window.state directly, so all the chip selections are
            // already in place. We just trigger the same code path the
            // v3 #btn-send button does.
            if (typeof window.__crispSubmitReport === 'function') {
                await window.__crispSubmitReport();
            } else {
                // Fall back to clicking the v3 send button if exposed.
                const v3Send = document.getElementById('btn-send') ||
                               document.getElementById('btn-review-submit');
                if (v3Send) v3Send.click();
            }
            // On success, navigate to the existing stage-success
            // (the v3 path's terminal state). v3's submit handler does
            // this on its own; we add a fallback in case.
            setTimeout(() => {
                if (document.querySelector('#stage-v4-review.active')) {
                    window.__crispGoToStage('stage-success');
                }
            }, 500);
        } catch (e) {
            console.error('[v4] send failed:', e);
            sendBtn.disabled = false;
            sendBtn.classList.remove('is-sending');
            sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> <span data-i18n="v4_send">Send to UNDP</span>';
            if (typeof window.showToast === 'function') {
                window.showToast('Send failed — your report was saved offline and will retry.', 'error');
            }
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
        // Reset UNDP sheet UI to defaults (May 2026 — bottom-sheet refresh).
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
        // handler is added via addEventListener, we can't remove it — but
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
            // BUG 4 — voice-only path. Exposing the recorder
            // surface lets tests verify the contract even in headless
            // environments without a real mic (mocking MediaRecorder).
            startRecording: _startV4Recording,
            stopRecording: _stopV4Recording,
            isRecording: _isV4Recording,
        };

        // Initial GPS fetch when entering capture.
        _refreshGps();

        console.log('[v4] flow initialised — UI v4 active');
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
