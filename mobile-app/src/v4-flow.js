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

    // Phase 25.4 (May 2026) — hard cap on photos per report. Matches
    // the v3 MAX_PHOTOS_TOTAL (4 extras + 1 primary). User-reported
    // bug: the `+` button in the v4 thumb strip would keep accepting
    // photos past the cap because v4's _handlePhoto didn't check.
    // Now enforced at three gates: _handlePhoto, _renderThumbs (hides
    // the + button at the cap), and the chooser overlay.
    const V4_MAX_PHOTOS = 5;

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

        // Phase 25.4 — show a toast (via app.js's helper if available)
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

        // Phase 25.4 — small action sheet shown when the `+` button on
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

        // Phase 25.4 — extracted from the heroBtn click handler so the
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
                    // Phase 25.7 (May 2026) — the camera modal supports
                    // MULTI-SNAP: first snap → state.photoDataUrl, every
                    // subsequent snap → state.extraPhotos.push(...).
                    // The previous close handler only read photoDataUrl,
                    // so users who took 5+ snaps inside the modal saw
                    // only ONE thumbnail in the v4 strip after closing
                    // (user-reported bug with screenshot showing 11
                    // thumbs in the modal gallery → 1/5 in v4).
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

                    // Phase 25.7 — after we copy the modal's snaps into
                    // v4Photos, CLEAR state.extraPhotos so the v3-shape
                    // accumulator doesn't double-count on the next
                    // modal session. (We keep state.photoDataUrl + blob
                    // because submitReport's `hasPhoto` gate reads them
                    // and the v3 path still relies on the primary slot.)
                    _setState({ extraPhotos: [] });

                    if (added > 0) {
                        _renderThumbs();
                        nextBtn.disabled = false;
                        nextBtn.classList.add('is-ready');
                    }
                    if (capHit && candidates.length > added) {
                        _toastCapHit();
                    }
                    // AI prefill call retained but no-ops while
                    // AI_PREFILL_ENABLED is false (top of file).
                    _maybeFireAiPrefill(_getState().photoBlob || null).catch(() => {});
                    // Phase 25.6 — auto-advance REMOVED. User taps
                    // Continue manually.
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
        // BUG 2 fix (May 2026) — on desktop, `<input capture=environment>`
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
            // Phase 25.4 — hard 5-photo cap. The previous code would
            // accept indefinite photos via the `+` button. Bail before
            // the v3 ingest pipeline runs so we don't leak state.
            const photosNow = _getState().v4Photos || [];
            if (photosNow.length >= V4_MAX_PHOTOS) {
                _toastCapHit();
                return;
            }
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

                // Phase 25.6 (May 2026) — wait for state.photoDataUrl to
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
                const _preDataUrl = _getState().photoDataUrl;
                const startedAt = Date.now();
                while (_getState().photoDataUrl === _preDataUrl
                       && Date.now() - startedAt < 4000) {
                    await new Promise((r) => setTimeout(r, 50));
                }

                // Render the v4 thumbnail strip from state.photoDataUrl
                // (the same SMALL data URL v3 uses for #photo-preview).
                const dataUrl = _getState().photoDataUrl;
                if (dataUrl && dataUrl !== _preDataUrl) {
                    const photoEntry = {
                        blob: _getState().photoBlob,
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

                // Fire AI pre-fill if bandwidth is good (no-op while
                // AI_PREFILL_ENABLED is false — see top of file).
                _maybeFireAiPrefill(_getState().photoBlob || file).catch((e) =>
                    console.warn('[v4] AI prefill error:', e));

                // Phase 25.6 — REMOVED auto-advance. User reported the
                // 1.2s timer made it impossible to add a second photo
                // via the `+` button, and the abrupt stage change felt
                // like the app was "deciding things for me". User now
                // taps Continue manually.
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
            // Phase 25.4 — multi-select from gallery: slice down to the
            // remaining cap so a user who picks 10 files at once doesn't
            // race past the per-call check inside _handlePhoto (each call
            // reads state synchronously before any push, so without this
            // slice the first 10 calls would all see length=0).
            const incoming = Array.from(e.target.files || []);
            const current = (_getState().v4Photos || []).length;
            const remaining = Math.max(0, V4_MAX_PHOTOS - current);
            if (incoming.length > remaining) _toastCapHit();
            incoming.slice(0, remaining).forEach((f) => _handlePhoto(f));
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

        // ── Delta-C (May 2026) — multi-modal additive capture wiring ──
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
        const capStrip = document.getElementById('v4-cap-strip');

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

        // Captured-strip refresh: read window.state and toggle chip
        // visibility / labels. Continue is enabled whenever any chip
        // is showing.
        function _refreshCapStrip() {
            const s = window.state || {};
            const photoEl = document.getElementById('v4-cap-chip-photo');
            const photoLbl = document.getElementById('v4-cap-chip-photo-label');
            const voiceEl = document.getElementById('v4-cap-chip-voice');
            const voiceLbl = document.getElementById('v4-cap-chip-voice-label');
            const textEl = document.getElementById('v4-cap-chip-text');
            const textLbl = document.getElementById('v4-cap-chip-text-label');
            const photos = (s.v4Photos && s.v4Photos.length) || (s.photoDataUrl ? 1 : 0);
            const audioOk = !!(s.audioBlob && s.audioBlob.size > 0) || !!(s.transcript && s.transcript.trim().length > 4);
            const textOk = !!(s.description && s.description.trim().length > 0) && s.description !== s.transcript;
            // ↑ text chip only when the textarea has content distinct from
            //   the voice transcript (otherwise voice + text would double-count).
            //   When the user types directly we set both description &
            //   transcript to the same string, so the heuristic compares them.
            const anyTextLike = !!(s.description && s.description.trim().length > 0);

            if (photoEl) {
                if (photos > 0) {
                    photoEl.removeAttribute('hidden');
                    if (photoLbl) {
                        // Phase 25 — i18n photo count.
                        const _t = (typeof window.t === 'function') ? window.t : ((k) => k);
                        if (photos === 1) {
                            photoLbl.textContent = _t('v4_photos_count_one') || '1 photo';
                        } else {
                            const tmpl = _t('v4_photos_count_many') || '{n} photos';
                            photoLbl.textContent = tmpl.replace('{n}', String(photos));
                        }
                    }
                } else photoEl.setAttribute('hidden', '');
            }
            if (voiceEl) {
                if (audioOk) voiceEl.removeAttribute('hidden');
                else voiceEl.setAttribute('hidden', '');
            }
            if (textEl) {
                // Show text chip when description has content. If voice was
                // captured and the textarea echoes the transcript, prefer the
                // voice chip alone (avoid duplicate "voice + text" when the
                // user only spoke).
                const showText = anyTextLike && !audioOk;
                if (showText) textEl.removeAttribute('hidden');
                else textEl.setAttribute('hidden', '');
            }

            // Show the strip wrapper if any chip is visible.
            const anyShown = (photos > 0) || audioOk || anyTextLike;
            if (capStrip) {
                if (anyShown) capStrip.removeAttribute('hidden');
                else capStrip.setAttribute('hidden', '');
            }
            // Continue button enabled whenever any modality has content.
            if (nextBtn) {
                nextBtn.disabled = !anyShown;
                nextBtn.classList.toggle('is-ready', anyShown);
            }
        }

        // Chip-x: clear the matching modality + refresh.
        const chipPhotoX = document.getElementById('v4-cap-chip-photo-x');
        const chipVoiceX = document.getElementById('v4-cap-chip-voice-x');
        const chipTextX = document.getElementById('v4-cap-chip-text-x');
        if (chipPhotoX) chipPhotoX.addEventListener('click', (ev) => {
            ev.stopPropagation();
            _setState({ v4Photos: [], photoDataUrl: null, photoBlob: null });
            try { _renderThumbs(); } catch (_) {}
            _refreshCapStrip();
        });
        if (chipVoiceX) chipVoiceX.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (_isV4Recording()) _stopV4Recording();
            _setState({ audioBlob: null, audioChunks: [], transcript: '' });
            // If the textarea echoes the transcript, clear it too.
            if (capTextArea && capTextArea.value === (_getState().description || '')) {
                capTextArea.value = '';
                _setState({ description: '' });
            }
            _refreshCapStrip();
        });
        if (chipTextX) chipTextX.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (capTextArea) capTextArea.value = '';
            _setState({ description: '' });
            _refreshCapStrip();
        });

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
            // Phase 25.4 — hide the `+` button entirely once at the cap.
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
            // Phase 25.4 — `+` opens the Camera / Browse chooser instead
            // of jumping straight to a file picker on desktop.
            if (addBtn) addBtn.addEventListener('click', () => _openAddPhotoChooser());
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
        // Phase 25 — i18n the "Locating…" status.
        const _t = (typeof window.t === 'function') ? window.t : ((k) => k);
        return _t('v4_gps_locating') || 'Locating…';
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
        // Phase 25 — i18n the status strings.
        const _t = (typeof window.t === 'function') ? window.t : ((k) => k);
        const LOCATING = _t('v4_gps_locating') || 'Locating…';
        const UNAVAILABLE = _t('v4_gps_unavailable') || 'GPS unavailable';
        // If we already have a locationName from a previous resolve, paint
        // it immediately while we re-fetch GPS (the user may have moved).
        const current = _getState();
        text.textContent = current.locationName || LOCATING;
        if (!navigator.geolocation) {
            text.textContent = current.locationName || UNAVAILABLE;
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

    // ── Page 2: classify (Delta-D + E rebuild, May 2026) ──────────────
    //
    // Single-question per sub-view. _classifyStep ∈ {'damage','infra','crisis'}
    // drives which .v4-classify-view is visible. Continue advances; Back
    // either returns to a previous sub-step or pops out to capture.
    //
    // Crisis sub-step has its own internal drill: 3 group cards →
    // sub-types list. _crisisGroup remembers which group the user
    // tapped so Back from sub-types returns to the group cards.
    const CRISIS_GROUPS = {
        natural: [
            { v: 'EARTHQUAKE', i: 'fa-house-crack', k: 'crisis_earthquake' },
            { v: 'FLOOD',      i: 'fa-water',       k: 'crisis_flood' },
            { v: 'TSUNAMI',    svg: '<path d="M2 17c3 0 4-3 8-3s5 3 9 3"/><path d="M2 21c3 0 4-3 8-3s5 3 9 3"/><path d="M9 14c0-3 1-5 3-7l4 8"/>', k: 'crisis_tsunami' },
            { v: 'HURRICANE',  i: 'fa-wind',        k: 'crisis_hurricane' },
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
                    o.setAttribute('aria-checked', 'false');
                });
                opt.classList.add('is-selected');
                opt.setAttribute('aria-checked', 'true');
                _setState({ damage_classification: opt.getAttribute('data-value') });
                _updateReviewSummary();
            });
        });
        // Default selected = the one already with .is-selected (Partial).
        const defaultOpt = damageOpts.find((o) => o.classList.contains('is-selected'));
        if (defaultOpt) _setState({ damage_classification: defaultOpt.getAttribute('data-value') });

        // ── Infra tiles (sub-view 2) — auto-advance on tap ──
        const infraView = document.getElementById('v4-view-infra');
        const infraTiles = infraView ? Array.from(infraView.querySelectorAll('.v4-hit-tile')) : [];
        infraTiles.forEach((tile) => {
            tile.addEventListener('click', () => {
                infraTiles.forEach((t) => {
                    t.classList.remove('is-selected');
                    t.setAttribute('aria-checked', 'false');
                });
                tile.classList.add('is-selected');
                tile.setAttribute('aria-checked', 'true');
                _setState({ infrastructure_type: tile.getAttribute('data-value') });
                _updateReviewSummary();
                // Phase 25.6 (May 2026) — auto-advance to the crisis
                // sub-step REMOVED. The user reported the automatic
                // page transition felt like the app was deciding
                // things for them. They tap Next to advance.
            });
        });

        // ── Crisis cards + drill-down (sub-view 3) ──
        const crisisView = document.getElementById('v4-view-crisis');
        const causeCards = crisisView ? Array.from(crisisView.querySelectorAll('.v4-cause-card')) : [];
        const subtypesContainer = document.getElementById('v4-cause-subtypes');
        const subtypesList = document.getElementById('v4-cause-subtypes-list');
        const groupCards = document.getElementById('v4-cause-cards');
        const causeBackBtn = document.getElementById('btn-v4-cause-back');
        const causeBackLabel = document.getElementById('v4-cause-back-label');
        let _crisisGroup = null;

        function _renderSubtypes(group) {
            if (!subtypesList) return;
            const items = CRISIS_GROUPS[group] || [];
            const titleKey = group === 'natural' ? 'v4_cause_natural'
                          : group === 'tech'    ? 'v4_cause_tech'
                          : 'v4_cause_human';
            if (causeBackLabel) causeBackLabel.textContent = (typeof window.t === 'function' ? window.t(titleKey) : titleKey);
            const _ti = (k, fb) => (typeof window.t === 'function' ? (window.t(k) || fb) : fb);
            subtypesList.innerHTML = items.map((it) => {
                const label = _ti(it.k, it.v);
                const iconHtml = it.svg
                    ? `<svg class="v4-cause-sub-opt-svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${it.svg}</svg>`
                    : `<i class="fa-solid ${it.i}"></i>`;
                return `<button class="v4-cause-sub-opt" data-value="${it.v}" type="button" role="radio" aria-checked="false">
                    <span class="v4-cause-sub-opt-icon" aria-hidden="true">${iconHtml}</span>
                    <span>${label}</span>
                </button>`;
            }).join('');
            // Wire the new buttons
            subtypesList.querySelectorAll('.v4-cause-sub-opt').forEach((btn) => {
                btn.addEventListener('click', () => {
                    subtypesList.querySelectorAll('.v4-cause-sub-opt').forEach((b) => {
                        b.classList.remove('is-selected');
                        b.setAttribute('aria-checked', 'false');
                    });
                    btn.classList.add('is-selected');
                    btn.setAttribute('aria-checked', 'true');
                    _setState({ crisis_type: btn.getAttribute('data-value') });
                    _updateReviewSummary();
                });
            });
        }

        causeCards.forEach((card) => {
            card.addEventListener('click', () => {
                _crisisGroup = card.getAttribute('data-group') || 'natural';
                _renderSubtypes(_crisisGroup);
                if (groupCards) groupCards.setAttribute('hidden', '');
                if (subtypesContainer) subtypesContainer.removeAttribute('hidden');
            });
        });
        if (causeBackBtn) {
            causeBackBtn.addEventListener('click', () => {
                if (subtypesContainer) subtypesContainer.setAttribute('hidden', '');
                if (groupCards) groupCards.removeAttribute('hidden');
                _crisisGroup = null;
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
        if (step === 'infra')  return !!s.infrastructure_type;
        if (step === 'crisis') return !!s.crisis_type;
        return true;
    }
    function _showSubStep(step) {
        if (!CLASSIFY_ORDER.includes(step)) return;
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
    // Hook _setState so any selection mutation auto-updates the button.
    // Idempotent — wrapping is safe across multiple inits.
    const _origSetState = _setState;
    function _wrappedSetState(patch) {
        _origSetState(patch);
        try { _refreshClassifyNext(); } catch (_) {}
    }
    // Monkey-patch local reference. `_setState` was const-bound earlier;
    // we rely on the outer scope keeping the same reference, so instead
    // of reassigning we just call _refreshClassifyNext after the fact
    // wherever it matters. Keep _wrappedSetState exported for tests.
    window.__crispV4RefreshClassifyNext = _refreshClassifyNext;

    // Apply AI suggestions to the chips. Called from the AI pre-fill
    // promise resolver; safe to call multiple times.
    function _applyAiSuggestions(result) {
        if (!result || result.source !== 'ai') return;

        const banner = document.getElementById('v4-ai-banner');
        if (banner) {
            banner.style.display = 'flex';
            setTimeout(() => { banner.style.display = 'none'; }, 4000);
        }

        // Damage radio (Delta-D rebuild — new .v4-q-opt selector).
        const damageView = document.getElementById('v4-view-damage');
        if (damageView && result.damage_classification) {
            const target = damageView.querySelector(`.v4-q-opt[data-value="${result.damage_classification}"]`);
            if (target) {
                damageView.querySelectorAll('.v4-q-opt').forEach((o) => {
                    o.classList.remove('is-selected');
                    o.setAttribute('aria-checked', 'false');
                });
                target.classList.add('is-selected');
                target.setAttribute('aria-checked', 'true');
                _setState({ damage_classification: result.damage_classification });
            }
        }
        // Infra tile (Delta-E rebuild — new .v4-hit-tile selector).
        const infraView = document.getElementById('v4-view-infra');
        if (infraView && result.infrastructure_type) {
            const target = infraView.querySelector(`.v4-hit-tile[data-value="${result.infrastructure_type}"]`);
            if (target) {
                infraView.querySelectorAll('.v4-hit-tile').forEach((t) => {
                    t.classList.remove('is-selected');
                    t.setAttribute('aria-checked', 'false');
                });
                target.classList.add('is-selected');
                target.setAttribute('aria-checked', 'true');
                _setState({ infrastructure_type: result.infrastructure_type });
            }
        }
        // Crisis sub-type — set state but don't auto-drill into the
        // sub-types view; that's the user's choice. The summary on the
        // review page will display whatever the AI suggested.
        if (result.crisis_type) {
            _setState({ crisis_type: result.crisis_type });
        }
        _updateReviewSummary();
        try { _refreshClassifyNext(); } catch (_) {}
    }

    // Phase 25.4 (May 2026) — disable AI auto-completion of damage /
    // infra / crisis chips per user direction. The user reported the
    // auto-fill quality was not OK; we'd rather have the reporter
    // pick the 3 chips deliberately than auto-fill from a Claude
    // vision pass that occasionally guessed wrong. The pre-fill
    // function below is preserved (call sites + UI banner unchanged)
    // but gated by this flag so re-enabling later is a one-line edit.
    const AI_PREFILL_ENABLED = false;

    // ── AI pre-fill ─────────────────────────────────────────────────────
    async function _maybeFireAiPrefill(blob) {
        if (!AI_PREFILL_ENABLED) {
            return;  // feature disabled — see AI_PREFILL_ENABLED comment above
        }
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
            if (stage === 'stage-v4-review') {
                _ensureBuildingBoxInV4();
                // Q10 (May 2026) — refresh the multi-modal captured strip
                // every time the user lands on stage-v4-review. Photo /
                // voice / text states could have changed during navigation
                // (back→capture→retake, drawer→record, etc.).
                try { _refreshCapturedStrip(); } catch (err) { console.warn('[Q10] strip:', err); }
            }
        });

        // Q10 — captured-strip click handlers. Photo chip → bounce back to
        // capture page. Voice / Text chips → open the drawer + scroll to
        // the relevant control + focus it (so the keyboard pops up for text
        // and the mic-button gets the keyboard tab anchor for voice).
        const stripPhoto = document.getElementById('v4-captured-photo');
        const stripVoice = document.getElementById('v4-captured-voice');
        const stripText = document.getElementById('v4-captured-text');
        const _openVoiceDrawerAnd = (focusFn) => {
            const drawer = document.getElementById('v4-voice-drawer');
            if (drawer && !drawer.open) drawer.open = true;
            setTimeout(() => {
                if (drawer) drawer.scrollIntoView({ behavior: 'smooth', block: 'center' });
                if (typeof focusFn === 'function') focusFn();
            }, 80);
        };
        if (stripPhoto) {
            stripPhoto.addEventListener('click', () => {
                window.__crispGoToStage('stage-v4-capture');
            });
        }
        if (stripVoice) {
            stripVoice.addEventListener('click', () => {
                _openVoiceDrawerAnd(() => {
                    document.getElementById('btn-v4-mic')?.focus();
                });
            });
        }
        if (stripText) {
            stripText.addEventListener('click', () => {
                _openVoiceDrawerAnd(() => {
                    document.getElementById('v4-text-desc')?.focus();
                });
            });
        }
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
                // Q10 — refresh the strip on every keystroke so the text chip
                // turns green the moment the textarea has any content.
                try { _refreshCapturedStrip(); } catch (_) {}
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
        // Phase 25 — fully i18n the mic-button label. Both branches now
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

    // Q10 (May 2026) — multi-modal "captured" strip on stage-v4-review.
    // Reads state.photoDataUrl + state.audioBlob + state.description and
    // toggles the .is-captured class on each chip with a localized state
    // label ("Captured", "1.2s", "12 chars", or "Not added"). Called
    // every time stage-v4-review is entered, after recording stops, and
    // on each keystroke in the textarea.
    function _refreshCapturedStrip() {
        const strip = document.getElementById('v4-captured-strip');
        if (!strip) return;
        const st = window.state || {};
        const tt = (k, fb) => (typeof window.t === 'function' ? (window.t(k) || fb) : fb);
        // Photo — captured if state.photoDataUrl OR thumbs strip has any
        // primary thumb attached. The thumbs strip mirrors photoDataUrl
        // already, so checking the primary is sufficient.
        const photoChip = document.getElementById('v4-captured-photo');
        const photoState = !!(st.photoDataUrl);
        if (photoChip) {
            photoChip.classList.toggle('is-captured', photoState);
            const stateEl = photoChip.querySelector('.v4-captured-state');
            if (stateEl) stateEl.textContent = photoState
                ? tt('v4_cap_added', 'Added')
                : tt('v4_cap_none', 'Not added');
        }
        // Voice — captured if state.audioBlob has size or transcript exists
        // (the latter covers Web-Speech-only fallback where MediaRecorder
        // failed but text came through).
        const voiceChip = document.getElementById('v4-captured-voice');
        const audioBlobOk = !!(st.audioBlob && st.audioBlob.size && st.audioBlob.size > 0);
        const transcriptOk = !!(st.transcript && st.transcript.trim() && st.transcript.length > 4);
        const voiceState = audioBlobOk || transcriptOk;
        if (voiceChip) {
            voiceChip.classList.toggle('is-captured', voiceState);
            const stateEl = voiceChip.querySelector('.v4-captured-state');
            if (stateEl) stateEl.textContent = voiceState
                ? tt('v4_cap_added', 'Added')
                : tt('v4_cap_none', 'Not added');
        }
        // Text — captured if state.description has non-whitespace content.
        // We treat transcript === description as text too (since the
        // textarea now mirrors transcript live).
        const textChip = document.getElementById('v4-captured-text');
        const textVal = (st.description || '').trim();
        const textState = textVal.length > 0;
        if (textChip) {
            textChip.classList.toggle('is-captured', textState);
            const stateEl = textChip.querySelector('.v4-captured-state');
            if (stateEl) stateEl.textContent = textState
                ? tt('v4_cap_added', 'Added')
                : tt('v4_cap_none', 'Not added');
        }
    }

    // ── Send ────────────────────────────────────────────────────────────
    async function _onSend() {
        const sendBtn = document.getElementById('btn-v4-send');
        sendBtn.disabled = true;
        sendBtn.classList.add('is-sending');
        // Phase 25 — i18n the spinner label. Note: we keep the icon as a
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
        // Phase 25.3 (May 2026) — reset the classify-stage closure
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
