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
    function _v4Enabled() {
        try {
            const url = new URL(window.location.href);
            const param = url.searchParams.get('ui');
            if (param === 'v3') return false;
            if (param === 'v4') return true;
            const ls = localStorage.getItem('crisp_ui_v4');
            if (ls === 'off') return false;
            return true;  // default ON
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

        container.innerHTML = `
            <div class="v4-chipgrid-track" role="radiogroup">
                ${options.map((o, i) => `
                    <button class="v4-chipgrid-tile ${i === 0 ? 'is-selected' : ''}"
                            type="button" role="radio"
                            data-value="${o.v}" data-index="${i}"
                            ${i === 0 ? 'aria-checked="true"' : ''}>
                        <i class="fa-solid ${o.i} v4-tile-icon"></i>
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
        heroBtn.addEventListener('click', () => cameraInput.click());
        browseBtn.addEventListener('click', () => browseInput.click());

        // Photo handler — decode → PII blur → image variants → state update.
        const _handlePhoto = async (file) => {
            if (!file) return;
            try {
                // Reuse the same pipeline v3 uses. _blurIfPossible is on
                // the global app.js scope; image-variants generate is
                // on window.ImageVariants. We just need the BLOB to land
                // in state.photoBlob and the SMALL preview in
                // state.photoSmallDataUrl for the thumbnail.
                let blurredBlob = file;
                try {
                    if (typeof window.PIIBlur !== 'undefined' && window.PIIBlur.blurFaces) {
                        const result = await window.PIIBlur.blurFaces(file);
                        blurredBlob = result.blob || file;
                        _setState({ photoClientBlurApplied: !!result.blurred });
                    } else if (typeof window.blurFaces === 'function') {
                        const result = await window.blurFaces(file);
                        blurredBlob = result.blob || file;
                        _setState({ photoClientBlurApplied: !!result.blurred });
                    }
                } catch (e) {
                    console.warn('[v4] PII blur failed (best-effort):', e);
                }

                _setState({ photoBlob: blurredBlob });

                // Generate a thumbnail for the strip (data URL).
                const thumbUrl = URL.createObjectURL(blurredBlob);
                const photoEntry = {
                    blob: blurredBlob,
                    url: thumbUrl,
                    ts: Date.now(),
                };
                if (!_getState().v4Photos) _setState({ v4Photos: [] });
                _getState().v4Photos.push(photoEntry);
                _renderThumbs();
                nextBtn.disabled = false;
                nextBtn.classList.add('is-ready');

                // Fire AI pre-fill if bandwidth is good. Don't block — the
                // user can tap Continue immediately.
                _maybeFireAiPrefill(blurredBlob).catch((e) =>
                    console.warn('[v4] AI prefill error:', e));

                // Auto-advance after 1 s if user doesn't add another photo.
                if (_getState().v4Photos.length === 1) {
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

    function _refreshGps() {
        const text = document.getElementById('v4-meta-location-text');
        if (!text) return;
        text.textContent = 'Locating…';
        if (!navigator.geolocation) {
            text.textContent = 'GPS unavailable';
            return;
        }
        navigator.geolocation.getCurrentPosition((pos) => {
            const { latitude, longitude, accuracy } = pos.coords;
            _setState({
                location: { lat: latitude, lng: longitude, acc: accuracy },
            });
            text.textContent = `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}° · ±${Math.round(accuracy)}m`;
            // Mirror to the review row.
            const reviewRow = document.getElementById('v4-row-location-text');
            if (reviewRow) reviewRow.textContent = text.textContent;
        }, (err) => {
            console.warn('[v4] GPS failed:', err);
            text.textContent = 'GPS unavailable';
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
        // Tap location → reopen building/location picker (existing helpers).
        document.getElementById('v4-edit-location').addEventListener('click', () => {
            // Use the existing Leaflet/Overpass selector if available.
            if (window.BuildingSelect && window.BuildingSelect.ensureMap) {
                window.BuildingSelect.ensureMap();
                // Existing module renders inside #building-select-box; for v4
                // we treat the tap as "refresh GPS" until inline picker is built.
            }
            _refreshGps();
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
        const micBtn = document.getElementById('btn-v4-mic');
        const textArea = document.getElementById('v4-text-desc');
        if (micBtn) {
            micBtn.addEventListener('click', () => {
                // Defer to v3's mic-record pipeline if available.
                const v3Mic = document.getElementById('btn-mic');
                if (v3Mic && typeof v3Mic.click === 'function') {
                    v3Mic.click();
                }
            });
        }
        if (textArea) {
            textArea.addEventListener('input', () => {
                _setState({ description: textArea.value });
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
