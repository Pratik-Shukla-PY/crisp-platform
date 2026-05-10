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
        const t = setInterval(() => {
            if (_ready()) {
                clearInterval(t);
                cb();
            }
        }, 50);
        // Timeout — never silently hang.
        setTimeout(() => clearInterval(t), 8000);
    }

    // ── Feature flag ────────────────────────────────────────────────────
    // May 2026 — re-enabled default ON after the 9-bug fix sweep.
    // Bugs covered + verified by tests in 30-v4-bug-fixes.spec.ts:
    //   1. Landing-page fluctuation (landing-pending CSS gate)
    //   2. Desktop webcam (route to openCameraModal on getUserMedia presence)
    //   3. Android back button (history.pushState wraps every goToStage,
    //      v4 stages already in STAGES array)
    //   4. Voice-only path (CrispV4 owns startRecording/stopRecording with
    //      MediaRecorder + Web Speech mirrored to v4 mic + textarea)
    //   5. Building tagging (move #building-select-box into v4 review on
    //      stage entry; BuildingSelect listens for stage-v4-review)
    //   6. Image upload chain (delegate _handlePhoto to v3's
    //      __crispIngestFile so state.photoDataUrl + photoVariants land)
    //   7. State reset on goToCapture (call _clearCaptureState +
    //      explicit v4Photos / thumb / chip resets)
    //   8. Location pill (prefer state.locationName; trigger
    //      resolveLocationName / reverseGeocode after GPS)
    //   9. Offline queue (CrispV4._onSend → __crispSubmitReport → enqueueReport)
    //
    // Escape hatches: ?ui=v3 forces v3, localStorage['crisp_ui_v4']='off'
    // forces v3 globally for the device.
    function _v4Enabled() {
        try {
            const url = new URL(window.location.href);
            const param = url.searchParams.get('ui');
            if (param === 'v3') return false;
            if (param === 'v4') return true;
            const ls = localStorage.getItem('crisp_ui_v4');
            if (ls === 'on') return true;
            if (ls === 'off') return false;
            return true;  // default ON (re-enabled after 9-bug fix sweep)
        } catch { return true; }
    }

    if (!_v4Enabled()) {
        console.log('[v4] disabled — falling back to v3 flow');
        return;
    }
    window.__crispUiV4 = true;

    // ── Chip-grid component (replaces v3 carousel) ─────────────────────
    // May 2026 hot-fix #2: the original carousel showed only 1 chip at
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

        // May 2026 a11y — every role="radio" must carry aria-checked
        // (true OR false). Previously only the selected tile had the
        // attribute → axe-core "aria-required-attr" critical failure.
        // M10 (May 2026) — custom Lucide-style SVG icons for the four
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

    // ── Page 1: capture ─────────────────────────────────────────────────
    function _initCaptureStage() {
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

        // Hero / browse → trigger native file inputs.
        // BUG 2 fix (May 2026) — on desktop, `<input capture=environment>`
        // falls back to file picker. We detect desktop (no iOS UA + has
        // getUserMedia) and open the existing #camera-modal instead, which
        // uses live <video> + getUserMedia. The modal already writes
        // state.photoDataUrl + state.photoVariants on snap (matches v4
        // contract), so v4 just needs to refresh the thumbnail strip when
        // the modal closes.
        heroBtn.addEventListener('click', () => {
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
            const hasGUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
            if (!isIOS && hasGUM && typeof window.openCameraModal === 'function') {
                // Watch state.photoDataUrl: when the user snaps, the modal
                // writes it. After modal closes, we refresh the v4 thumb
                // strip + advance like _handlePhoto would.
                const _preDataUrl = _getState().photoDataUrl;
                window.openCameraModal();
                // Hook the close: when state.photoDataUrl changes from null
                // → set, run the v4 post-capture flow once.
                const _modalCloseHandler = () => {
                    const dataUrl = _getState().photoDataUrl;
                    if (dataUrl && dataUrl !== _preDataUrl) {
                        // Inject into v4Photos so the thumb strip renders.
                        if (!_getState().v4Photos) _setState({ v4Photos: [] });
                        const photos = _getState().v4Photos;
                        if (!photos.find((p) => p.url === dataUrl)) {
                            photos.push({
                                blob: _getState().photoBlob,
                                url: dataUrl,
                                ts: Date.now(),
                            });
                        }
                        _renderThumbs();
                        nextBtn.disabled = false;
                        nextBtn.classList.add('is-ready');
                        // Fire AI prefill on the captured frame too.
                        _maybeFireAiPrefill(_getState().photoBlob || null).catch(() => {});
                        // Auto-advance after 1.2s (same as file-input path).
                        setTimeout(() => {
                            if (document.querySelector('#stage-v4-capture.active')) {
                                _goToClassify();
                            }
                        }, 1200);
                    }
                    document.removeEventListener('camera-modal-closed', _modalCloseHandler);
                };
                document.addEventListener('camera-modal-closed', _modalCloseHandler);
                // Also poll as fallback in case the modal close event isn't
                // dispatched (legacy installs without the patch). Polls
                // every 200ms for up to 60s, then gives up.
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
        });
        browseBtn.addEventListener('click', () => browseInput.click());

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
            try {
                // Make sure v3's stage-photo setup ran (it exposes
                // __crispIngestFile via window). If not yet ready (e.g.
                // user tapped capture before app.js boot finished), we
                // fall back to a minimal in-place pipeline that still
                // sets state.photoDataUrl so submitReport doesn't fail.
                if (typeof window.__crispIngestFile === 'function') {
                    window.__crispIngestFile(file, { asExtra: false });
                } else {
                    // Fallback path: set photoDataUrl manually so submit
                    // works even if the v3 ingest helper isn't ready yet.
                    await _v4FallbackIngest(file);
                }

                // Wait briefly for v3's pipeline to set state.photoDataUrl
                // (the FileReader.onload + canvas.toDataURL chain runs
                // synchronously after the file is read; in practice
                // ~50-200ms in real browsers, ~1s for 4MB images).
                const startedAt = Date.now();
                while (!_getState().photoDataUrl && Date.now() - startedAt < 4000) {
                    await new Promise((r) => setTimeout(r, 50));
                }

                // Render the v4 thumbnail strip from state.photoDataUrl
                // (the same SMALL data URL v3 uses for #photo-preview).
                const dataUrl = _getState().photoDataUrl;
                if (dataUrl) {
                    const photoEntry = {
                        blob: _getState().photoBlob,
                        url: dataUrl,
                        ts: Date.now(),
                    };
                    if (!_getState().v4Photos) _setState({ v4Photos: [] });
                    // Replace the most recent v4Photos entry on re-pick of the
                    // primary slot, otherwise append.
                    const photos = _getState().v4Photos;
                    if (photos.length === 0) {
                        photos.push(photoEntry);
                    } else {
                        // Subsequent files via #v4-add-more route through
                        // browseInput (asExtra=true via state.extraPhotos).
                        // For now we append to v4Photos for thumb display.
                        photos.push(photoEntry);
                    }
                    _renderThumbs();
                    nextBtn.disabled = false;
                    nextBtn.classList.add('is-ready');
                }

                // Fire AI pre-fill if bandwidth is good. Don't block — the
                // user can tap Continue immediately.
                _maybeFireAiPrefill(_getState().photoBlob || file).catch((e) =>
                    console.warn('[v4] AI prefill error:', e));

                // Auto-advance after 1.2s if user doesn't add another photo.
                if (_getState().v4Photos && _getState().v4Photos.length === 1) {
                    setTimeout(() => {
                        // Only advance if the user is still on this stage.
                        if (document.querySelector('#stage-v4-capture.active')) {
                            _goToClassify();
                        }
                    }, 1200);
                }
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
            Array.from(e.target.files || []).forEach((f) => _handlePhoto(f));
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

        function _renderThumbs() {
            const photos = _getState().v4Photos || [];
            if (!photos.length) {
                thumbsRow.style.display = 'none';
                return;
            }
            thumbsRow.style.display = 'flex';
            thumbsRow.innerHTML = photos.map((p, i) => `
                <div class="v4-thumb">
                    <img src="${p.url}" alt="">
                    <button class="v4-thumb-x" data-idx="${i}" type="button" aria-label="Remove">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            `).join('') + `
                <button class="v4-thumb v4-thumb-add" id="v4-add-more" type="button">
                    <i class="fa-solid fa-plus"></i>
                </button>
            `;
            thumbsRow.querySelectorAll('.v4-thumb-x').forEach((btn) => {
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
                    _getState().v4Photos.splice(idx, 1);
                    if (_getState().v4Photos.length === 0) {
                        nextBtn.disabled = true;
                        nextBtn.classList.remove('is-ready');
                        _setState({ photoBlob: null });
                    }
                    _renderThumbs();
                });
            });
            const addBtn = thumbsRow.querySelector('#v4-add-more');
            if (addBtn) addBtn.addEventListener('click', () => cameraInput.click());
        }
    }

    // BUG 8 fix (May 2026) — prefer state.locationName (resolved by
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
        return 'Locating…';
    }
    function _paintV4LocationPills() {
        const s = _getState();
        const label = _formatLocationLabel(s.location, s.locationName);
        const captureText = document.getElementById('v4-meta-location-text');
        const reviewText = document.getElementById('v4-row-location-text');
        if (captureText) captureText.textContent = label;
        if (reviewText) reviewText.textContent = label;
    }
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
        // If we already have a locationName from a previous resolve, paint
        // it immediately while we re-fetch GPS (the user may have moved).
        const current = _getState();
        text.textContent = current.locationName || 'Locating…';
        if (!navigator.geolocation) {
            text.textContent = current.locationName || 'GPS unavailable';
            return;
        }
        navigator.geolocation.getCurrentPosition((pos) => {
            const { latitude, longitude, accuracy } = pos.coords;
            _setState({
                location: { lat: latitude, lng: longitude, acc: accuracy },
            });
            // Paint coords as immediate feedback; the async geocode below
            // will replace this with a place name shortly.
            _paintV4LocationPills();

            // Trigger reverse-geocode resolve. resolveLocationName is
            // module-scope in app.js but exposed via the implicit
            // top-level-function-as-global pattern. Fallback: call
            // reverseGeocode + write state.locationName ourselves.
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
            console.warn('[v4] GPS failed:', err);
            text.textContent = current.locationName || 'GPS unavailable';
        }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    }

    // ── Page 2: classify ────────────────────────────────────────────────
    function _initClassifyStage() {
        // Damage chips
        const damageRow = document.getElementById('v4-chips-damage');
        if (damageRow) {
            damageRow.querySelectorAll('.v4-chip').forEach((chip) => {
                chip.addEventListener('click', () => {
                    damageRow.querySelectorAll('.v4-chip').forEach((c) => {
                        c.classList.remove('is-selected');
                        c.setAttribute('aria-checked', 'false');
                    });
                    chip.classList.add('is-selected');
                    chip.setAttribute('aria-checked', 'true');
                    _setState({ damage_classification: chip.getAttribute('data-value') });
                    _updateReviewSummary();
                });
            });
            // Default selection.
            const defaultChip = damageRow.querySelector('.v4-chip.is-selected');
            if (defaultChip) {
                _setState({ damage_classification: defaultChip.getAttribute('data-value') });
            }
        }

        // Infra carousel
        const infraCarousel = _initCarousel(document.getElementById('v4-carousel-infra'));
        if (infraCarousel) {
            infraCarousel.addEventListener('v4:select', (e) => {
                _setState({ infrastructure_type: e.detail.value });
                _updateReviewSummary();
            });
            // Set default
            _setState({ infrastructure_type: infraCarousel._getValue() });
        }

        // Crisis carousel
        const crisisCarousel = _initCarousel(document.getElementById('v4-carousel-crisis'));
        if (crisisCarousel) {
            crisisCarousel.addEventListener('v4:select', (e) => {
                _setState({ crisis_type: e.detail.value });
                _updateReviewSummary();
            });
            _setState({ crisis_type: crisisCarousel._getValue() });
        }

        // Navigation
        document.getElementById('btn-v4-classify-back').addEventListener(
            'click', () => window.__crispGoToStage('stage-v4-capture')
        );
        document.getElementById('btn-v4-classify-next').addEventListener(
            'click', _goToReview
        );

        // Apply i18n now that carousels populated.
        if (typeof window.applyI18n === 'function') {
            try { window.applyI18n(); } catch (e) {}
        }
    }

    // Apply AI suggestions to the chips. Called from the AI pre-fill
    // promise resolver; safe to call multiple times.
    function _applyAiSuggestions(result) {
        if (!result || result.source !== 'ai') return;

        const banner = document.getElementById('v4-ai-banner');
        if (banner) {
            banner.style.display = 'flex';
            setTimeout(() => { banner.style.display = 'none'; }, 4000);
        }

        // Damage chip
        const damageRow = document.getElementById('v4-chips-damage');
        if (damageRow && result.damage_classification) {
            const chip = damageRow.querySelector(`.v4-chip[data-value="${result.damage_classification}"]`);
            if (chip) {
                damageRow.querySelectorAll('.v4-chip').forEach((c) => {
                    c.classList.remove('is-selected');
                    c.setAttribute('aria-checked', 'false');
                });
                chip.classList.add('is-selected');
                chip.setAttribute('aria-checked', 'true');
                _setState({ damage_classification: result.damage_classification });
            }
        }
        // Infra carousel
        const infraEl = document.getElementById('v4-carousel-infra');
        if (infraEl && infraEl._setValue && result.infrastructure_type) {
            infraEl._setValue(result.infrastructure_type);
            _setState({ infrastructure_type: result.infrastructure_type });
        }
        // Crisis carousel
        const crisisEl = document.getElementById('v4-carousel-crisis');
        if (crisisEl && crisisEl._setValue && result.crisis_type) {
            crisisEl._setValue(result.crisis_type);
            _setState({ crisis_type: result.crisis_type });
        }
        _updateReviewSummary();
    }

    // ── AI pre-fill ─────────────────────────────────────────────────────
    async function _maybeFireAiPrefill(blob) {
        // Bandwidth gate — only fire on FAST or better. The probe runs
        // independently in app.js; we read the cached tier here. If it's
        // missing we default to NOT firing (conservative — never block
        // user on degraded networks).
        let tier = null;
        try {
            tier = (window.getMeasuredTier && window.getMeasuredTier()) ||
                   (window._pwaTier) ||
                   localStorage.getItem('crisp_bw_tier');
        } catch (e) {}

        if (tier && (tier === 'VERY_SLOW' || tier === 'SLOW')) {
            console.log('[v4] AI prefill skipped — bandwidth tier:', tier);
            return;
        }
        if (!navigator.onLine) {
            console.log('[v4] AI prefill skipped — offline');
            return;
        }

        // Resize to ~640 px long-side to keep the upload fast.
        const resized = await _resizeBlobForAi(blob);
        const b64 = await _blobToBase64(resized);
        if (!b64) return;

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);

        try {
            const apiBase = window.API_BASE || '/api/v1';
            const lat = _getState().location?.lat;
            const lng = _getState().location?.lng;
            const res = await fetch(`${apiBase}/reports/classify-suggest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_b64: b64,
                    media_type: 'image/jpeg',
                    lat: typeof lat === 'number' ? lat : undefined,
                    lng: typeof lng === 'number' ? lng : undefined,
                }),
                signal: ctrl.signal,
            });
            clearTimeout(timer);
            if (!res.ok) {
                console.log('[v4] classify-suggest non-200:', res.status);
                return;
            }
            const result = await res.json();
            console.log('[v4] AI suggested:', result);
            _applyAiSuggestions(result);
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') {
                console.log('[v4] AI prefill aborted (>1.5s)');
            } else {
                console.warn('[v4] AI prefill failed:', e);
            }
        }
    }

    function _resizeBlobForAi(blob) {
        return new Promise((resolve) => {
            const img = new Image();
            const url = URL.createObjectURL(blob);
            img.onload = () => {
                const max = 640;
                const ratio = Math.min(1, max / Math.max(img.width, img.height));
                const w = Math.round(img.width * ratio);
                const h = Math.round(img.height * ratio);
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                URL.revokeObjectURL(url);
                canvas.toBlob((b) => resolve(b || blob), 'image/jpeg', 0.7);
            };
            img.onerror = () => { URL.revokeObjectURL(url); resolve(blob); };
            img.src = url;
        });
    }

    function _blobToBase64(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result || '';
                const i = result.indexOf(',');
                resolve(i >= 0 ? result.slice(i + 1) : '');
            };
            reader.onerror = () => resolve('');
            reader.readAsDataURL(blob);
        });
    }

    // ── Page 3: review ──────────────────────────────────────────────────
    function _initReviewStage() {
        // BUG 5 fix (May 2026) — UNDP must-have #6: relocate the existing
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
            // (added in May 2026). The double-rAF + setTimeout(500) inside
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
            if (stage === 'stage-v4-review') _ensureBuildingBoxInV4();
        });
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
        // BUG 4 fix (May 2026) — voice-only path. v4 originally forwarded
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
            });
        }

        // Debris yes/no
        document.querySelectorAll('.v4-yn-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                btn.parentElement.querySelectorAll('.v4-yn-btn').forEach((b) =>
                    b.classList.remove('is-active'));
                btn.classList.add('is-active');
                _setState({ debris_present: btn.getAttribute('data-debris') === 'true' });
            });
        });

        // Service status
        const elecSel = document.getElementById('v4-elec');
        const healthSel = document.getElementById('v4-health');
        if (elecSel) {
            elecSel.addEventListener('change', () => {
                _setState({ electricity_status: elecSel.value || null });
            });
        }
        if (healthSel) {
            healthSel.addEventListener('change', () => {
                _setState({ health_status: healthSel.value || null });
            });
        }

        // Pressing needs (multi-select chips)
        document.querySelectorAll('.v4-need-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                chip.classList.toggle('is-selected');
                const all = Array.from(document.querySelectorAll('.v4-need-chip.is-selected'))
                    .map((c) => c.getAttribute('data-need'));
                _setState({ pressing_needs: all });
            });
        });

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

        // Photo thumb. May 2026 hot-fix: add `.has-photo` class so the
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
    }

    // ── V4 voice recorder (BUG 4 fix, May 2026) ────────────────────────
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
        window.state.isRecording = false;
        _setV4MicVisualState(false);
    }
    function _setV4MicVisualState(recording) {
        const btn = document.getElementById('btn-v4-mic');
        if (!btn) return;
        const icon = btn.querySelector('i');
        const label = btn.querySelector('span');
        if (recording) {
            btn.classList.add('is-recording');
            if (icon) icon.className = 'fa-solid fa-stop';
            if (label) label.textContent = 'Stop recording';
        } else {
            btn.classList.remove('is-recording');
            if (icon) icon.className = 'fa-solid fa-microphone';
            if (label) {
                label.textContent = (typeof window.t === 'function')
                    ? (window.t('v4_record') || 'Record voice')
                    : 'Record voice';
            }
        }
    }

    // ── Send ────────────────────────────────────────────────────────────
    async function _onSend() {
        const sendBtn = document.getElementById('btn-v4-send');
        sendBtn.disabled = true;
        sendBtn.classList.add('is-sending');
        sendBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Sending…';

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
        // BUG 7 fix (May 2026) — clear prior report state before showing
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
        // Reset pressing-needs chips.
        document.querySelectorAll('.v4-need-chip.is-selected').forEach((c) =>
            c.classList.remove('is-selected'));
        // Reset debris yes/no to default (No).
        document.querySelectorAll('.v4-yn-btn').forEach((b) => b.classList.remove('is-active'));
        const noBtn = document.querySelector('.v4-yn-btn[data-debris="false"]');
        if (noBtn) noBtn.classList.add('is-active');
        // Reset service-status selects.
        const elec = document.getElementById('v4-elec');
        if (elec) elec.value = '';
        const hlth = document.getElementById('v4-health');
        if (hlth) hlth.value = '';

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
            // BUG 4 (May 2026) — voice-only path. Exposing the recorder
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
