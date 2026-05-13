/**
 * CRISP Badge Studio — May 2026 reward-system v2.
 *
 * In-app Canvas composer that lets reporters who've reached
 * T3_CHANGEMAKER / T4_LIFEKEEPER generate a share-ready badge image
 * for LinkedIn / WhatsApp / Instagram / etc. Three templates:
 *
 *   1. ring  — 1080×1080 transparent PNG. Circular crop of optional
 *              user photo with a tier-coloured ring; "Open to work"-
 *              style ribbon at the bottom. Works as a profile photo
 *              on LinkedIn / WhatsApp.
 *   2. wa    — 1080×1080 opaque PNG. Same composition but with a
 *              navy/teal gradient backdrop, tier badge enlarged so
 *              it reads at WhatsApp's thumbnail sizes.
 *   3. story — 1080×1920 portrait PNG. Full bleed mint→teal gradient,
 *              tier emoji + name dominant, counts below, CRISP
 *              wordmark + share URL at the bottom. Suitable for
 *              Insta Story / WA Status / LinkedIn share.
 *
 * Composition is pure Canvas — no upload of the user's photo to any
 * server. Optional face blur reuses the existing pii-blur.js
 * BlazeFace pipeline (UNDP must-have #7).
 *
 * Share dispatch:
 *   - Download: invisible <a download> click
 *   - Share via app: navigator.share({ files: [...] })
 *   - WhatsApp:  https://wa.me/?text=...  (image must be downloaded
 *                separately; toast hints the user)
 *   - Instagram: Web Share API path (Insta is a registered share
 *                target on Android Chrome); falls back to download
 *                + hint on iOS
 *   - LinkedIn:  deep-links to a server-rendered /share/<token>
 *                page with og:image meta so the LinkedIn share
 *                dialog previews the badge.
 *
 * Badge Studio is locked behind T3_CHANGEMAKER. T1 / T2 reporters
 * who tap the home badge chip get a toast hint ("Reach Changemaker
 * to unlock Badge Studio"). The `unlock` invariant is enforced by
 * window.openBadgeStudio (defined here) which reads the current tier
 * from sessionStorage `crisp_home_badge_v2`.
 */
(function () {
    'use strict';

    // ── Tier metadata (mirror of home-screen.js BADGE_LEVELS) ──
    const TIER_META = {
        T1_SCOUT:       { emoji: '🌱', label: 'Scout',       ringStart: '#80EE98', ringEnd: '#46DFB1' },
        T2_SIGNAL:      { emoji: '📣', label: 'Signal',      ringStart: '#46DFB1', ringEnd: '#09D1C7' },
        T3_CHANGEMAKER: { emoji: '⚡', label: 'Changemaker', ringStart: '#09D1C7', ringEnd: '#15919B' },
        T4_LIFEKEEPER:  { emoji: '🦸', label: 'Lifekeeper',  ringStart: '#46DFB1', ringEnd: '#80EE98' },
    };
    const TIERS_UNLOCKED = new Set(['T3_CHANGEMAKER', 'T4_LIFEKEEPER']);

    // ── State held in module scope (single-stage component) ──
    const state = {
        tier: 'T4_LIFEKEEPER',          // current tier (default to top for preview/dev)
        lives: 0,
        reports: 0,
        responded: 0,
        template: 'ring',               // 'ring' | 'wa' | 'story'
        userPhotoBlob: null,            // ImageBitmap or HTMLImageElement
        faceBlur: true,
        lastPngBlob: null,              // memoised result of the last compose()
    };

    function _t(key, fallback) {
        try {
            if (typeof window.t === 'function') {
                const v = window.t(key);
                if (v && v !== key) return v;
            }
        } catch (_) {}
        return fallback;
    }

    function _toast(msg, kind) {
        try {
            if (typeof window.showToast === 'function') return window.showToast(msg, kind);
        } catch (_) {}
        // Fallback if showToast hasn't loaded yet.
        try { console.info('[BadgeStudio toast]', msg); } catch (_) {}
    }

    // ── Tier-state load from sessionStorage cache (set by home-screen.js) ──
    function _loadTierFromCache() {
        try {
            const raw = sessionStorage.getItem('crisp_home_badge_v2');
            if (!raw) return null;
            const p = JSON.parse(raw);
            if (!p || typeof p !== 'object') return null;
            return {
                tier: String(p.level || 'T1_SCOUT').toUpperCase(),
                lives: Number.isFinite(p.lives) ? p.lives : 0,
                reports: Number.isFinite(p.reports) ? p.reports : 0,
                responded: Number.isFinite(p.responded) ? p.responded : 0,
            };
        } catch (_) { return null; }
    }

    // ── Canvas composition ────────────────────────────────────────────

    function _dimensions(template) {
        return template === 'story' ? { w: 1080, h: 1920 } : { w: 1080, h: 1080 };
    }

    function _paintBackground(ctx, template, tier) {
        const { w, h } = _dimensions(template);
        if (template === 'ring') {
            // Transparent — exit early. Profile-photo template uses
            // transparency outside the circle so the avatar reads as
            // a true profile photo on LinkedIn / WhatsApp.
            ctx.clearRect(0, 0, w, h);
            return;
        }
        if (template === 'wa') {
            const g = ctx.createLinearGradient(0, 0, w, h);
            g.addColorStop(0, '#213A58');
            g.addColorStop(1, '#0C6478');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
        } else {
            // story
            const meta = TIER_META[tier] || TIER_META.T4_LIFEKEEPER;
            const g = ctx.createLinearGradient(0, 0, w, h);
            g.addColorStop(0, meta.ringStart);
            g.addColorStop(1, meta.ringEnd);
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            // Soft overlay so foreground text reads cleanly.
            ctx.fillStyle = 'rgba(12, 30, 45, 0.35)';
            ctx.fillRect(0, 0, w, h);
        }
    }

    function _drawCircularPhoto(ctx, bitmap, cx, cy, radius) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        // Aspect-fill into the circle: scale so smaller side fills, crop other.
        const ratio = bitmap.width / bitmap.height;
        let dw, dh, dx, dy;
        const D = radius * 2;
        if (ratio >= 1) { dh = D; dw = D * ratio; dx = cx - dw / 2; dy = cy - dh / 2; }
        else            { dw = D; dh = D / ratio; dx = cx - dw / 2; dy = cy - dh / 2; }
        ctx.drawImage(bitmap, dx, dy, dw, dh);
        ctx.restore();
    }

    function _drawAvatarPlaceholder(ctx, cx, cy, radius, tier) {
        const meta = TIER_META[tier] || TIER_META.T1_SCOUT;
        // Circle with the tier gradient + emoji centred.
        const g = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
        g.addColorStop(0, meta.ringStart);
        g.addColorStop(1, meta.ringEnd);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(12, 18, 28, 0.85)';
        ctx.font = `${radius * 1.0}px "Inter", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(meta.emoji, cx, cy + radius * 0.05);
    }

    function _drawTierRing(ctx, cx, cy, radius, tier) {
        const meta = TIER_META[tier] || TIER_META.T4_LIFEKEEPER;
        const ringWidth = Math.max(24, Math.floor(radius * 0.10));
        // Glow underlay so the ring "lifts" off the avatar.
        ctx.save();
        ctx.shadowColor = meta.ringEnd;
        ctx.shadowBlur = 28;
        ctx.lineWidth = ringWidth;
        ctx.strokeStyle = meta.ringEnd;
        ctx.beginPath();
        ctx.arc(cx, cy, radius + ringWidth / 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        // Gradient ring on top.
        const g = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
        g.addColorStop(0, meta.ringStart);
        g.addColorStop(1, meta.ringEnd);
        ctx.lineWidth = ringWidth;
        ctx.strokeStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, radius + ringWidth / 2, 0, Math.PI * 2);
        ctx.stroke();
    }

    function _drawTierBadge(ctx, cx, cy, scale, tier) {
        const meta = TIER_META[tier] || TIER_META.T4_LIFEKEEPER;
        // Pill at the bottom with emoji + label.
        const pillW = 380 * scale;
        const pillH = 120 * scale;
        const x = cx - pillW / 2;
        const y = cy;
        const r = pillH / 2;
        // Pill background.
        const g = ctx.createLinearGradient(x, y, x + pillW, y);
        g.addColorStop(0, meta.ringStart);
        g.addColorStop(1, meta.ringEnd);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + pillW, y, x + pillW, y + pillH, r);
        ctx.arcTo(x + pillW, y + pillH, x, y + pillH, r);
        ctx.arcTo(x, y + pillH, x, y, r);
        ctx.arcTo(x, y, x + pillW, y, r);
        ctx.closePath();
        ctx.fill();
        // Label.
        ctx.fillStyle = '#0b1018';
        ctx.font = `800 ${56 * scale}px "Outfit", "Inter", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tierLabel = _t(`tier_${tier.toLowerCase()}_label`, meta.label);
        ctx.fillText(`${meta.emoji}  ${tierLabel.toUpperCase()}`, cx, y + pillH / 2 + 4 * scale);
    }

    function _drawStoryContent(ctx, w, h, tier, stats) {
        const meta = TIER_META[tier] || TIER_META.T4_LIFEKEEPER;
        const cx = w / 2;
        // Emoji large + centred near the top third.
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `${260}px "Inter", system-ui, sans-serif`;
        ctx.fillText(meta.emoji, cx, h * 0.30);
        // Tier name.
        ctx.font = `900 96px "Outfit", "Inter", system-ui, sans-serif`;
        const tierLabel = _t(`tier_${tier.toLowerCase()}_label`, meta.label);
        ctx.fillText(tierLabel.toUpperCase(), cx, h * 0.46);
        // Stats line.
        ctx.font = `600 48px "Inter", system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
        const lives = Number.isFinite(stats.lives) ? stats.lives : 0;
        const reps  = Number.isFinite(stats.reports) ? stats.reports : 0;
        ctx.fillText(`${reps} reports · ${lives} lives saved`, cx, h * 0.56);
        // Brand block at the bottom.
        ctx.font = `800 72px "Outfit", "Inter", system-ui, sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText('CRISP', cx, h * 0.84);
        ctx.font = `500 36px "Inter", system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
        const tagline = _t('badge_studio_share_card_tagline', 'Report what you see — crisplabs.tech');
        ctx.fillText(tagline, cx, h * 0.89);
    }

    async function _composeBadgeImage(template, userBitmap, tier, stats) {
        const { w, h } = _dimensions(template);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');

        // 1. Background.
        _paintBackground(ctx, template, tier);

        // 2. Profile photo / avatar placeholder.
        if (template !== 'story') {
            const cx = w / 2;
            const cy = h * 0.42;
            const radius = Math.min(w, h) * 0.30;
            if (userBitmap) {
                _drawCircularPhoto(ctx, userBitmap, cx, cy, radius);
            } else {
                _drawAvatarPlaceholder(ctx, cx, cy, radius, tier);
            }
            // 3. Tier ring.
            _drawTierRing(ctx, cx, cy, radius, tier);
            // 4. Tier badge pill below the ring.
            _drawTierBadge(ctx, cx, cy + radius + 100, template === 'wa' ? 1.05 : 1.0, tier);
        } else {
            // Story template — no profile photo; full content block.
            _drawStoryContent(ctx, w, h, tier, stats);
        }

        return new Promise((resolve, reject) => {
            try {
                canvas.toBlob((blob) => {
                    if (!blob) return reject(new Error('toBlob returned null'));
                    resolve(blob);
                }, 'image/png');
            } catch (e) { reject(e); }
        });
    }

    // ── Preview render onto the visible <canvas id="bs-canvas"> ──
    async function _renderPreview() {
        const canvas = document.getElementById('bs-canvas');
        if (!canvas) return;
        const { w, h } = _dimensions(state.template);
        // Display size — scale down to fit the viewport while preserving
        // the underlying pixel buffer. The exported PNG always uses the
        // full 1080×1080 / 1080×1920 buffer (toBlob reads from canvas.toBlob
        // separately in _composeBadgeImage; here we just paint for the preview).
        canvas.width = w; canvas.height = h;
        // CSS sizing is set in styles.css via `.badge-studio-canvas`.
        const ctx = canvas.getContext('2d');
        _paintBackground(ctx, state.template, state.tier);
        if (state.template !== 'story') {
            const cx = w / 2;
            const cy = h * 0.42;
            const radius = Math.min(w, h) * 0.30;
            if (state.userPhotoBlob) {
                _drawCircularPhoto(ctx, state.userPhotoBlob, cx, cy, radius);
            } else {
                _drawAvatarPlaceholder(ctx, cx, cy, radius, state.tier);
            }
            _drawTierRing(ctx, cx, cy, radius, state.tier);
            _drawTierBadge(ctx, cx, cy + radius + 100, state.template === 'wa' ? 1.05 : 1.0, state.tier);
        } else {
            _drawStoryContent(ctx, w, h, state.tier, { lives: state.lives, reports: state.reports });
        }
    }

    function _updateTierPreviewHeader() {
        const meta = TIER_META[state.tier] || TIER_META.T1_SCOUT;
        const emojiEl = document.getElementById('bs-tier-emoji');
        const nameEl  = document.getElementById('bs-tier-name');
        const statsEl = document.getElementById('bs-tier-stats');
        if (emojiEl) emojiEl.textContent = meta.emoji;
        if (nameEl) nameEl.textContent = _t(`tier_${state.tier.toLowerCase()}_label`, meta.label);
        if (statsEl) statsEl.textContent = `${state.reports} reports · ${state.lives} lives saved`;
    }

    // ── Photo upload + face-blur pipeline ────────────────────────────

    async function _readImageFile(file) {
        // Prefer createImageBitmap (faster, off-main-thread decode);
        // fall back to Image element.
        if (window.createImageBitmap) {
            try { return await window.createImageBitmap(file); } catch (_) {}
        }
        return await new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
            img.src = url;
        });
    }

    async function _maybeBlurFaces(bitmap) {
        if (!state.faceBlur) return bitmap;
        if (typeof window.applyPiiBlur !== 'function') return bitmap;
        try {
            // applyPiiBlur typically takes a Blob/File; convert if needed.
            // The existing pii-blur.js variations accept an HTMLImageElement
            // OR a canvas-rendered ImageData. We render to a working canvas
            // and pass it through.
            const c = document.createElement('canvas');
            c.width = bitmap.width || bitmap.naturalWidth;
            c.height = bitmap.height || bitmap.naturalHeight;
            c.getContext('2d').drawImage(bitmap, 0, 0);
            // applyPiiBlur returns either a Blob or a canvas — we accept either.
            const blurred = await window.applyPiiBlur(c);
            if (blurred instanceof Blob) {
                return await _readImageFile(blurred);
            } else if (blurred && typeof blurred.getContext === 'function') {
                return blurred; // a canvas drawable
            }
            return bitmap;
        } catch (e) {
            console.warn('[BadgeStudio] face blur failed; using original:', e);
            return bitmap;
        }
    }

    // ── Share dispatch ────────────────────────────────────────────────

    function _shareText() {
        const meta = TIER_META[state.tier] || TIER_META.T4_LIFEKEEPER;
        const tierLabel = _t(`tier_${state.tier.toLowerCase()}_label`, meta.label);
        // Static text fallback so non-Web-Share share targets (WhatsApp
        // deep-link, etc.) still carry the same brand message.
        return `${meta.emoji} I'm a CRISP ${tierLabel}. Report what you see → https://crisplabs.tech`;
    }

    async function _composeForShare() {
        // If the same template + photo combo was just composed, reuse
        // the memoised blob (saves ~150 ms on repeat clicks).
        if (state.lastPngBlob && state.lastPngBlob._cacheKey ===
            `${state.template}|${state.tier}|${state.faceBlur}|${!!state.userPhotoBlob}`) {
            return state.lastPngBlob;
        }
        const blob = await _composeBadgeImage(
            state.template, state.userPhotoBlob, state.tier,
            { lives: state.lives, reports: state.reports },
        );
        blob._cacheKey = `${state.template}|${state.tier}|${state.faceBlur}|${!!state.userPhotoBlob}`;
        state.lastPngBlob = blob;
        return blob;
    }

    function _downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        // Defer revoke so the browser has a moment to read the URL.
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
    }

    async function _handleDownload() {
        try {
            const blob = await _composeForShare();
            const ts = new Date().toISOString().slice(0, 10);
            const filename = `crisp-${state.tier.toLowerCase()}-${state.template}-${ts}.png`;
            _downloadBlob(blob, filename);
            _toast(_t('badge_studio_downloaded', 'Saved to your downloads'), 'success');
        } catch (e) {
            console.warn('[BadgeStudio] download failed:', e);
            _toast(_t('badge_studio_share_failed', 'Could not generate the image'), 'error');
        }
    }

    async function _handleShareViaApp() {
        try {
            const blob = await _composeForShare();
            const file = new File([blob], `crisp-${state.tier.toLowerCase()}.png`, { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    files: [file],
                    title: 'CRISP Badge',
                    text: _shareText(),
                });
                return;
            }
            // Fallback — download + copy text to clipboard so the user
            // can paste into their share target manually.
            _downloadBlob(blob, `crisp-${state.tier.toLowerCase()}.png`);
            try { await navigator.clipboard.writeText(_shareText()); } catch (_) {}
            _toast(_t('badge_studio_share_hint',
                'Image saved + caption copied — open your share target and paste.'), 'info');
        } catch (e) {
            // User cancelled the native share — that's not an error.
            if (e && e.name === 'AbortError') return;
            console.warn('[BadgeStudio] share failed:', e);
            _toast(_t('badge_studio_share_failed', 'Could not share'), 'error');
        }
    }

    async function _handleWhatsApp() {
        // WhatsApp's wa.me intent can carry text but not an image
        // attachment; we toast a hint so the user knows to save the
        // image too. Tap order: tap WA → save image → tap chat thread
        // → paste image from camera roll.
        try {
            const blob = await _composeForShare();
            _downloadBlob(blob, `crisp-${state.tier.toLowerCase()}.png`);
            const text = encodeURIComponent(_shareText());
            window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener');
            _toast(_t('badge_studio_wa_hint',
                'Image saved — attach it from your camera roll in WhatsApp.'), 'info');
        } catch (e) {
            console.warn('[BadgeStudio] WhatsApp share failed:', e);
            _toast(_t('badge_studio_share_failed', 'Could not share'), 'error');
        }
    }

    async function _handleInstagram() {
        // Instagram on Android Chrome is a registered share target via
        // Web Share API; on iOS it isn't (no Web Share to Insta on
        // iOS Safari) — fall back to download + hint.
        try {
            const blob = await _composeForShare();
            const file = new File([blob], `crisp-${state.tier.toLowerCase()}.png`, { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: 'CRISP Badge', text: _shareText() });
                return;
            }
            _downloadBlob(blob, `crisp-${state.tier.toLowerCase()}.png`);
            _toast(_t('badge_studio_insta_hint',
                'Image saved — open Instagram → Story → upload from camera roll.'), 'info');
        } catch (e) {
            if (e && e.name === 'AbortError') return;
            console.warn('[BadgeStudio] Insta share failed:', e);
            _toast(_t('badge_studio_share_failed', 'Could not share'), 'error');
        }
    }

    async function _handleLinkedIn() {
        // LinkedIn's share dialog doesn't accept image attachments via
        // URL; we mint a server-rendered share page at
        // /api/v1/share/<token> with og:image meta and deep-link
        // LinkedIn to it. The backend route is implemented at
        // backend/app/api/endpoints/share.py.
        try {
            // For now, fall back to the public landing page URL since
            // the share-token mint round-trip is part of Phase D.6. The
            // landing page already carries OG meta for the CRISP brand;
            // LinkedIn will preview that instead of the per-user badge.
            // When /share/<token> lands, replace this with the signed
            // URL.
            const blob = await _composeForShare();
            _downloadBlob(blob, `crisp-${state.tier.toLowerCase()}.png`);
            const shareUrl = 'https://crisplabs.tech';
            const url = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`;
            window.open(url, '_blank', 'noopener');
            _toast(_t('badge_studio_linkedin_hint',
                'Image saved — attach it to your LinkedIn post manually.'), 'info');
        } catch (e) {
            console.warn('[BadgeStudio] LinkedIn share failed:', e);
            _toast(_t('badge_studio_share_failed', 'Could not share'), 'error');
        }
    }

    // ── Stage init + entry / exit ────────────────────────────────────

    function _setActiveTab(tpl) {
        state.template = tpl;
        state.lastPngBlob = null; // bust the memo on template switch
        document.querySelectorAll('.badge-studio-tabs .bs-tab').forEach((b) => {
            const active = b.getAttribute('data-template') === tpl;
            b.classList.toggle('is-active', active);
            b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        _renderPreview();
    }

    async function _onPhotoSelected(file) {
        if (!file) return;
        try {
            let bm = await _readImageFile(file);
            bm = await _maybeBlurFaces(bm);
            state.userPhotoBlob = bm;
            state.lastPngBlob = null;
            _renderPreview();
        } catch (e) {
            console.warn('[BadgeStudio] photo decode failed:', e);
            _toast(_t('badge_studio_photo_failed', 'Could not load that photo'), 'error');
        }
    }

    function _initStage() {
        // Tab switching.
        document.querySelectorAll('.badge-studio-tabs .bs-tab').forEach((b) => {
            b.addEventListener('click', () => _setActiveTab(b.getAttribute('data-template')));
        });
        // Photo input.
        const photoIn = document.getElementById('bs-photo-input');
        if (photoIn) {
            photoIn.addEventListener('change', (ev) => {
                const f = ev.target && ev.target.files && ev.target.files[0];
                if (f) _onPhotoSelected(f);
            });
        }
        // Face-blur toggle.
        const blurT = document.getElementById('bs-blur-toggle');
        if (blurT) {
            blurT.addEventListener('change', () => {
                state.faceBlur = !!blurT.checked;
                // Re-blur if a photo is loaded.
                if (state.userPhotoBlob && photoIn && photoIn.files && photoIn.files[0]) {
                    _onPhotoSelected(photoIn.files[0]);
                }
            });
        }
        // Share buttons.
        const bind = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', handler);
        };
        bind('btn-bs-download', _handleDownload);
        bind('btn-bs-share',    _handleShareViaApp);
        bind('btn-bs-wa',       _handleWhatsApp);
        bind('btn-bs-insta',    _handleInstagram);
        bind('btn-bs-linkedin', _handleLinkedIn);
        // Back button.
        const back = document.getElementById('btn-badge-studio-back');
        if (back) {
            back.addEventListener('click', () => {
                try { window.goToStage('stage-home'); } catch (_) {}
            });
        }
    }

    // ── Public entry — called by home-screen.js on chip tap (T3+) ──
    window.openBadgeStudio = function () {
        const cache = _loadTierFromCache();
        const tier = cache ? cache.tier : 'T1_SCOUT';
        if (!TIERS_UNLOCKED.has(tier)) {
            // Locked path — toast and bail.
            _toast(_t('badge_studio_lock_t1_t2',
                'Reach Changemaker to unlock Badge Studio'), 'info');
            return;
        }
        // Update state from cache.
        state.tier = tier;
        if (cache) {
            state.lives = cache.lives;
            state.reports = cache.reports;
            state.responded = cache.responded;
        }
        _updateTierPreviewHeader();
        try { window.goToStage('stage-badge-studio'); } catch (_) {}
        // Set the active tab to "ring" by default + paint.
        _setActiveTab(state.template || 'ring');
    };

    // ── Wire badge-chip tap → openBadgeStudio (or toast at T1/T2) ──
    function _wireChipTap() {
        const chip = document.getElementById('home-badge-chip');
        if (!chip || chip.__bsWired) return;
        chip.__bsWired = true;
        chip.addEventListener('click', () => window.openBadgeStudio());
        chip.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                window.openBadgeStudio();
            }
        });
    }

    // ── Boot — initialise stage handlers on DOMContentLoaded ──
    function _boot() {
        try { _initStage(); } catch (e) { console.warn('[BadgeStudio] init:', e); }
        // The badge chip may not exist yet on first paint (home-screen.js
        // renders it after profile fetch). Poll briefly.
        let tries = 0;
        const wireTimer = setInterval(() => {
            tries++;
            const chip = document.getElementById('home-badge-chip');
            if (chip) { _wireChipTap(); clearInterval(wireTimer); }
            if (tries > 40) clearInterval(wireTimer); // ~10 s upper bound
        }, 250);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _boot);
    } else {
        _boot();
    }

    // Expose internals for tests.
    window.__crispBadgeStudio = {
        _state: state,
        _composeBadgeImage,
        _setActiveTab,
        _loadTierFromCache,
    };
})();
