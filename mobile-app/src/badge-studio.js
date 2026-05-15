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
        // May 2026 — character picker + share-message picker added
        // alongside the futuristic backdrop.
        selectedCharacter: 'caped_guardian',
        usePhotoInsteadOfCharacter: false,
        selectedMessageIdx: -1,         // -1 = "Surprise me" (deterministic random)
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
            // Futuristic backdrop on top of the navy base for WA.
            _paintFuturisticBackdrop(ctx, w, h, tier);
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
            // Subtle futuristic backdrop on story too (full bleed).
            _paintFuturisticBackdrop(ctx, w, h, tier);
        }
    }

    /**
     * Paint a sci-fi HUD-style backdrop behind the avatar:
     *   - sparse hex-grid pattern (low alpha)
     *   - 3 concentric arc tick-marks (HUD reticle)
     *   - diagonal sweep glow top-left
     * Centered on the canvas. Pure Canvas paint; no external deps.
     */
    function _paintFuturisticBackdrop(ctx, w, h, tier) {
        const meta = TIER_META[tier] || TIER_META.T4_LIFEKEEPER;
        const cx = w / 2;
        const cy = h * 0.42;
        const baseRadius = Math.min(w, h) * 0.30;

        ctx.save();

        // 1. Hex-grid pattern — sparse cells across the whole canvas.
        ctx.strokeStyle = 'rgba(70, 223, 177, 0.07)'; // tier-mint, very low alpha
        ctx.lineWidth = 2;
        const hexR = 38;
        const hexW = hexR * Math.sqrt(3);
        const hexH = hexR * 1.5;
        for (let y = -hexR; y < h + hexR; y += hexH) {
            const rowOffset = (Math.floor(y / hexH) % 2) ? hexW / 2 : 0;
            for (let x = -hexW + rowOffset; x < w + hexW; x += hexW) {
                _drawHexagon(ctx, x, y, hexR);
            }
        }

        // 2. Concentric arc tick-marks around the avatar circle.
        //    Three radii, each with a small gap (HUD reticle vibe).
        const tickRadii = [baseRadius * 1.18, baseRadius * 1.32, baseRadius * 1.46];
        ctx.strokeStyle = `${meta.ringEnd}`;
        tickRadii.forEach((r, i) => {
            ctx.globalAlpha = 0.32 - i * 0.06;
            ctx.lineWidth = 3;
            // Draw 3/4 of the arc with a gap on the right.
            ctx.beginPath();
            ctx.arc(cx, cy, r, Math.PI * 0.18, Math.PI * 1.82);
            ctx.stroke();
            // Short tick on the opposite side.
            ctx.beginPath();
            ctx.arc(cx, cy, r, -Math.PI * 0.10, Math.PI * 0.10);
            ctx.stroke();
        });
        ctx.globalAlpha = 1;

        // 3. Diagonal sweep glow — soft radial highlight 30° top-left.
        const sweepGrad = ctx.createRadialGradient(
            w * 0.20, h * 0.15, 10,
            w * 0.20, h * 0.15, Math.max(w, h) * 0.7,
        );
        sweepGrad.addColorStop(0, `${meta.ringEnd}26`);  // 26 hex = ~15% alpha
        sweepGrad.addColorStop(0.5, `${meta.ringEnd}0d`); // 0d hex = ~5% alpha
        sweepGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = sweepGrad;
        ctx.fillRect(0, 0, w, h);

        ctx.restore();
    }

    function _drawHexagon(ctx, cx, cy, r) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const angle = (Math.PI / 3) * i + Math.PI / 6; // pointy-top hex
            const x = cx + r * Math.cos(angle);
            const y = cy + r * Math.sin(angle);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
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

    /**
     * Paint the user's chosen character silhouette into the avatar
     * circle. The character SVG ships in `character-pack.js` and is
     * rendered to an Image element via a data: URL; we then clip
     * to a circle and drawImage like a regular bitmap.
     *
     * The circle is filled first with a dark-teal base so the
     * silhouette pops against the futuristic backdrop instead of
     * blending into the canvas gradient. The character SVG paints
     * coloured via the tier's gradient-end value (mint / lime / teal
     * depending on tier).
     */
    async function _drawCharacterAvatar(ctx, cx, cy, radius, tier, slug) {
        const meta = TIER_META[tier] || TIER_META.T1_SCOUT;
        // 1. Tier-tinted base disc.
        ctx.save();
        const baseGrad = ctx.createRadialGradient(
            cx - radius * 0.3, cy - radius * 0.3, radius * 0.1,
            cx, cy, radius,
        );
        baseGrad.addColorStop(0, '#0C6478');   // mid-teal centre
        baseGrad.addColorStop(0.7, '#0a1b2a');
        baseGrad.addColorStop(1, '#06121e');   // dark navy edge
        ctx.fillStyle = baseGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // 2. Inner glow ring just outside the silhouette zone.
        ctx.save();
        ctx.strokeStyle = meta.ringEnd;
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 14;
        ctx.beginPath();
        ctx.arc(cx, cy, radius * 0.92, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        // 3. Character silhouette — coloured via the character pack's
        // own gradient end-stop so each character has a distinct
        // accent. Defer-loaded; if it fails we fall through to the
        // emoji placeholder so the canvas never has a hole.
        if (!window.crispCharacterPack) {
            _drawAvatarPlaceholder(ctx, cx, cy, radius, tier);
            return;
        }
        try {
            const charMeta = window.crispCharacterPack.meta(slug);
            const img = await window.crispCharacterPack.loadAsImage(
                slug, charMeta.gradient[1],
            );
            // Center + scale so the silhouette fills ~90% of the circle.
            const D = radius * 1.8;
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(img, cx - D / 2, cy - D / 2 + radius * 0.05, D, D);
            ctx.restore();
        } catch (e) {
            console.warn('[BadgeStudio] character load failed; falling back:', e);
            _drawAvatarPlaceholder(ctx, cx, cy, radius, tier);
        }
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

    // ── Share-card message pack (Phase B) ──────────────────────────
    //
    // 8 GenZ-friendly messages the user can pick from on the story
    // template. "Surprise me" rotates deterministically based on
    // Date.now() % 8 so the same session gets a stable pick. Each
    // message ≤ 70 chars to fit the 1080×1920 layout under the
    // tier name without wrapping into a 3rd line.
    //
    // English fallbacks here mirror the i18n keys
    // `bs_message_1` … `bs_message_8`. Caller passes `messageIdx`
    // (0..7); -1 means "Surprise me".
    const SHARE_MESSAGES = [
        { key: 'bs_message_1', en: 'Saw it. Said it. Saved lives. 💚' },
        { key: 'bs_message_2', en: 'Real ones spot real problems. Reported. Got results.' },
        { key: 'bs_message_3', en: "My report turned into someone's good day. ⚡" },
        { key: 'bs_message_4', en: "Plot twist: I'm the help that arrived." },
        { key: 'bs_message_5', en: "Crisis tried me. I CRISP'd back." },
        { key: 'bs_message_6', en: "Bystander? Never met them. I'm a Lifekeeper. 🦸" },
        { key: 'bs_message_7', en: 'Verified reporter. Verified impact. ✓' },
        { key: 'bs_message_8', en: 'First on scene with a phone in my hand. 📡' },
    ];

    function _resolveShareMessage(idx) {
        // -1 = Surprise me — deterministic per ~minute so the preview
        // is stable but tomorrow's session pulls a different message.
        const pickIdx = (idx < 0 || idx >= SHARE_MESSAGES.length)
            ? Math.floor((Date.now() / 60000) % SHARE_MESSAGES.length)
            : idx;
        const m = SHARE_MESSAGES[pickIdx];
        return _t(m.key, m.en);
    }

    function _drawStoryContent(ctx, w, h, tier, stats, messageIdx) {
        const meta = TIER_META[tier] || TIER_META.T4_LIFEKEEPER;
        const cx = w / 2;
        // Emoji large + centred near the top third.
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `${260}px "Inter", system-ui, sans-serif`;
        ctx.fillText(meta.emoji, cx, h * 0.28);
        // Tier name.
        ctx.font = `900 96px "Outfit", "Inter", system-ui, sans-serif`;
        const tierLabel = _t(`tier_${tier.toLowerCase()}_label`, meta.label);
        ctx.fillText(tierLabel.toUpperCase(), cx, h * 0.44);
        // Stats line.
        ctx.font = `600 48px "Inter", system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
        const lives = Number.isFinite(stats.lives) ? stats.lives : 0;
        const reps  = Number.isFinite(stats.reports) ? stats.reports : 0;
        ctx.fillText(`${reps} reports · ${lives} lives saved`, cx, h * 0.52);
        // GenZ share message — bold, identity-forward.
        const msg = _resolveShareMessage(
            typeof messageIdx === 'number' ? messageIdx : state.selectedMessageIdx
        );
        ctx.font = `700 52px "Inter", system-ui, sans-serif`;
        ctx.fillStyle = '#ffffff';
        _wrapText(ctx, msg, cx, h * 0.62, w - 160, 64);
        // Brand block at the bottom.
        ctx.font = `800 72px "Outfit", "Inter", system-ui, sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText('CRISP', cx, h * 0.84);
        ctx.font = `500 36px "Inter", system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
        const tagline = _t('badge_studio_share_card_tagline', 'Report what you see — crisplabs.tech');
        ctx.fillText(tagline, cx, h * 0.89);
    }

    /** Simple word-wrap text painter — splits on spaces, keeps lines
     *  under `maxWidth`. Up to 3 lines centred at `(cx, y)`. */
    function _wrapText(ctx, text, cx, y, maxWidth, lineHeight) {
        const words = String(text || '').split(/\s+/);
        const lines = [];
        let line = '';
        for (const w of words) {
            const test = line ? `${line} ${w}` : w;
            if (ctx.measureText(test).width > maxWidth && line) {
                lines.push(line);
                line = w;
            } else {
                line = test;
            }
            if (lines.length >= 3) break;
        }
        if (line && lines.length < 3) lines.push(line);
        const totalH = (lines.length - 1) * lineHeight;
        const yStart = y - totalH / 2;
        lines.forEach((ln, i) => ctx.fillText(ln, cx, yStart + i * lineHeight));
    }

    async function _composeBadgeImage(template, userBitmap, tier, stats, opts) {
        const { w, h } = _dimensions(template);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');
        opts = opts || {};
        const usePhoto = opts.usePhoto !== false && !!userBitmap;
        const characterSlug = opts.characterSlug || state.selectedCharacter;
        const messageIdx = (typeof opts.messageIdx === 'number')
            ? opts.messageIdx : state.selectedMessageIdx;

        // 1. Background (now carries the futuristic backdrop).
        _paintBackground(ctx, template, tier);

        // 2. Avatar — photo > character > emoji placeholder.
        if (template !== 'story') {
            const cx = w / 2;
            const cy = h * 0.42;
            const radius = Math.min(w, h) * 0.30;
            if (usePhoto && userBitmap) {
                _drawCircularPhoto(ctx, userBitmap, cx, cy, radius);
            } else if (window.crispCharacterPack) {
                await _drawCharacterAvatar(ctx, cx, cy, radius, tier, characterSlug);
            } else {
                _drawAvatarPlaceholder(ctx, cx, cy, radius, tier);
            }
            // 3. Tier ring.
            _drawTierRing(ctx, cx, cy, radius, tier);
            // 4. Tier badge pill below the ring.
            _drawTierBadge(ctx, cx, cy + radius + 100, template === 'wa' ? 1.05 : 1.0, tier);
        } else {
            // Story template — no profile photo; full content block.
            _drawStoryContent(ctx, w, h, tier, stats, messageIdx);
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
        const usePhoto = state.usePhotoInsteadOfCharacter && !!state.userPhotoBlob;
        if (state.template !== 'story') {
            const cx = w / 2;
            const cy = h * 0.42;
            const radius = Math.min(w, h) * 0.30;
            if (usePhoto) {
                _drawCircularPhoto(ctx, state.userPhotoBlob, cx, cy, radius);
            } else if (window.crispCharacterPack) {
                await _drawCharacterAvatar(ctx, cx, cy, radius, state.tier, state.selectedCharacter);
            } else {
                _drawAvatarPlaceholder(ctx, cx, cy, radius, state.tier);
            }
            _drawTierRing(ctx, cx, cy, radius, state.tier);
            _drawTierBadge(ctx, cx, cy + radius + 100, state.template === 'wa' ? 1.05 : 1.0, state.tier);
        } else {
            _drawStoryContent(ctx, w, h, state.tier, { lives: state.lives, reports: state.reports }, state.selectedMessageIdx);
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
            // pii-blur.js's `applyPiiBlur` returns
            //   { blob, blurred, facesDetected, skipped, error }
            // — NOT a Blob/canvas directly. Pre-fix this function
            // duck-typed for Blob|canvas, missed every real return
            // value, and silently returned the original bitmap →
            // blur looked like it was working but actually never ran
            // on the studio's photo path. Fixed in the second-pass
            // futuristic-badge work (May 2026).
            //
            // The function takes a File/Blob input. Convert the
            // bitmap to a blob via a working canvas.
            const c = document.createElement('canvas');
            c.width = bitmap.width || bitmap.naturalWidth;
            c.height = bitmap.height || bitmap.naturalHeight;
            c.getContext('2d').drawImage(bitmap, 0, 0);
            const inputBlob = await new Promise((resolve, reject) => {
                c.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob null')), 'image/jpeg', 0.92);
            });
            const result = await window.applyPiiBlur(inputBlob);
            if (!result || typeof result !== 'object') return bitmap;
            if (result.skipped) {
                // Model load / detect failed — fall back to the original
                // bitmap + tell the user we couldn't blur this time.
                _toast(_t('photo_blur_unavailable',
                    'Face blur unavailable; using the original photo.'), 'info');
                return bitmap;
            }
            if (result.blob instanceof Blob) {
                return await _readImageFile(result.blob);
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
        // LinkedIn's share dialog does NOT accept image attachments via
        // URL — it only scrapes Open Graph meta from the share URL.
        // We mint a signed token via POST /api/v1/share/mint and
        // deep-link LinkedIn at /api/v1/share/<token> so the rendered
        // page carries the user's badge as og:image.
        //
        // Fallback path: if the mint endpoint is unreachable (offline,
        // backend down, mint returns non-2xx), fall back to the
        // crisplabs.tech landing page so the share still works — just
        // with the generic OG preview instead of the per-user badge.
        try {
            const blob = await _composeForShare();
            // Always download the PNG too — LinkedIn's scraper can fail
            // on data URLs >50 KB and the user may want to attach the
            // image manually as a backup.
            _downloadBlob(blob, `crisp-${state.tier.toLowerCase()}.png`);

            // Convert the PNG blob to a data URL for OG embed. Cap at
            // ~100 KB (LinkedIn scraper limit + backend mint endpoint
            // limit) — if larger, send null and let the share page
            // render with the default brand image.
            let imgDataUrl = null;
            if (blob.size <= 100_000) {
                imgDataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            }

            const apiBase = (typeof window.API_BASE === 'string' && window.API_BASE)
                ? window.API_BASE
                : '/api/v1';
            let shareUrl = 'https://crisplabs.tech';
            try {
                const mintRes = await fetch(`${apiBase}/share/mint`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tier: state.tier,
                        lives: state.lives || 0,
                        reports: state.reports || 0,
                        img: imgDataUrl,
                    }),
                });
                if (mintRes.ok) {
                    const { url: signedPath } = await mintRes.json();
                    // signedPath is "/api/v1/share/<token>" (relative).
                    // Build absolute URL off the same host so LinkedIn
                    // can fetch the OG page. Both dev (localhost:8000)
                    // and prod (undp.crisplabs.tech) work.
                    const origin = new URL(apiBase, window.location.href).origin;
                    shareUrl = `${origin}${signedPath}`;
                } else {
                    console.warn('[BadgeStudio] /share/mint returned', mintRes.status,
                        '— falling back to crisplabs.tech');
                }
            } catch (e) {
                console.warn('[BadgeStudio] /share/mint unreachable, using crisplabs.tech fallback', e);
            }

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
            state.usePhotoInsteadOfCharacter = true;  // explicit upload → prefer photo
            state.lastPngBlob = null;
            _showPhotoThumbnail(file);
            _renderPreview();
        } catch (e) {
            console.warn('[BadgeStudio] photo decode failed:', e);
            _toast(_t('badge_studio_photo_failed', 'Could not load that photo'), 'error');
        }
    }

    // ── Phase A — character picker ─────────────────────────────────

    function _buildCharacterGrid() {
        const grid = document.getElementById('bs-char-grid');
        if (!grid || !window.crispCharacterPack) return;
        const chars = window.crispCharacterPack.list();
        grid.innerHTML = '';
        chars.forEach((c) => {
            const tile = document.createElement('button');
            tile.type = 'button';
            tile.className = 'bs-char-tile';
            tile.setAttribute('role', 'radio');
            tile.setAttribute('data-slug', c.slug);
            tile.setAttribute('aria-label', c.label_en);
            tile.setAttribute('title', c.label_en);
            const previewColor = c.gradient ? c.gradient[1] : '#46DFB1';
            tile.innerHTML = window.crispCharacterPack.previewHtml(c.slug, previewColor);
            tile.addEventListener('click', () => _selectCharacter(c.slug));
            grid.appendChild(tile);
        });
        _highlightCharacter(state.selectedCharacter);
    }

    function _highlightCharacter(slug) {
        document.querySelectorAll('.bs-char-tile').forEach((t) => {
            const sel = t.getAttribute('data-slug') === slug;
            t.classList.toggle('is-selected', sel);
            t.setAttribute('aria-checked', sel ? 'true' : 'false');
        });
    }

    function _selectCharacter(slug) {
        state.selectedCharacter = slug;
        // Picking a character disables photo-mode automatically — the
        // user is signalling they want a hero, not their selfie.
        state.usePhotoInsteadOfCharacter = false;
        state.lastPngBlob = null;
        _highlightCharacter(slug);
        _renderPreview();
    }

    // ── Phase B — share-message picker ─────────────────────────────

    function _selectMessage(idx) {
        const n = Number(idx);
        state.selectedMessageIdx = Number.isFinite(n) ? n : -1;
        state.lastPngBlob = null;
        _renderPreview();
    }

    // ── Phase C — photo consent modal + thumbnail ──────────────────

    const PHOTO_CONSENT_KEY = 'crisp_photo_studio_consent_v1';

    function _hasPhotoConsent() {
        try { return localStorage.getItem(PHOTO_CONSENT_KEY) === '1'; } catch (_) { return false; }
    }
    function _grantPhotoConsent() {
        try { localStorage.setItem(PHOTO_CONSENT_KEY, '1'); } catch (_) {}
    }

    function _openPhotoConsentModal() {
        // May 2026 — toggle ONLY via the `hidden` attribute; the
        // CSS (`.photo-consent-overlay[hidden] { display: none }`)
        // handles visibility. Setting `style.display = 'flex'`
        // previously masked the original bug (where `.upload-overlay`
        // class inherited `display:flex` and the modal appeared on
        // every load), so removing both the inherited class AND the
        // inline-style write together is the proper fix.
        const ov = document.getElementById('photo-consent-overlay');
        if (!ov) return;
        ov.removeAttribute('hidden');
    }
    function _closePhotoConsentModal() {
        const ov = document.getElementById('photo-consent-overlay');
        if (!ov) return;
        ov.setAttribute('hidden', '');
    }

    function _onChoosePhotoClicked() {
        if (_hasPhotoConsent()) {
            _triggerPhotoFilePicker();
        } else {
            _openPhotoConsentModal();
        }
    }
    function _triggerPhotoFilePicker() {
        const photoIn = document.getElementById('bs-photo-input');
        if (photoIn) photoIn.click();
    }

    function _showPhotoThumbnail(file) {
        const wrap = document.getElementById('bs-photo-thumb');
        const img  = document.getElementById('bs-photo-thumb-img');
        if (!wrap || !img) return;
        // Revoke any previous object URL we minted to keep memory clean.
        if (img._lastUrl) {
            try { URL.revokeObjectURL(img._lastUrl); } catch (_) {}
        }
        const url = URL.createObjectURL(file);
        img._lastUrl = url;
        img.src = url;
        wrap.hidden = false;
    }
    function _clearPhotoThumbnail() {
        const wrap = document.getElementById('bs-photo-thumb');
        const img  = document.getElementById('bs-photo-thumb-img');
        if (img && img._lastUrl) {
            try { URL.revokeObjectURL(img._lastUrl); } catch (_) {}
            img._lastUrl = null; img.src = '';
        }
        if (wrap) wrap.hidden = true;
        // Also clear the file input value so the user can re-pick the same file.
        const photoIn = document.getElementById('bs-photo-input');
        if (photoIn) photoIn.value = '';
        state.userPhotoBlob = null;
        state.usePhotoInsteadOfCharacter = false;
        state.lastPngBlob = null;
        _renderPreview();
    }

    function _initStage() {
        // Tab switching.
        document.querySelectorAll('.badge-studio-tabs .bs-tab').forEach((b) => {
            b.addEventListener('click', () => _setActiveTab(b.getAttribute('data-template')));
        });
        // Character picker — populated on first stage entry.
        _buildCharacterGrid();
        // Share-message picker.
        const msgSel = document.getElementById('bs-message-select');
        if (msgSel) {
            msgSel.addEventListener('change', () => _selectMessage(msgSel.value));
        }
        // Photo input — handler stays, but the trigger is now the
        // consent-modal-OK button (or direct file picker if previously
        // consented).
        const photoIn = document.getElementById('bs-photo-input');
        if (photoIn) {
            photoIn.addEventListener('change', (ev) => {
                const f = ev.target && ev.target.files && ev.target.files[0];
                if (f) _onPhotoSelected(f);
            });
        }
        // "Choose photo" entry button — gates through consent modal.
        const btnPhoto = document.getElementById('btn-bs-photo');
        if (btnPhoto) btnPhoto.addEventListener('click', _onChoosePhotoClicked);
        // Thumbnail clear button.
        const btnClear = document.getElementById('btn-bs-photo-clear');
        if (btnClear) btnClear.addEventListener('click', _clearPhotoThumbnail);
        // Photo-consent modal buttons.
        const ok = document.getElementById('btn-photo-consent-ok');
        if (ok) ok.addEventListener('click', () => {
            _grantPhotoConsent();
            _closePhotoConsentModal();
            _triggerPhotoFilePicker();
        });
        const cancel = document.getElementById('btn-photo-consent-cancel');
        if (cancel) cancel.addEventListener('click', _closePhotoConsentModal);
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
        // Rebuild character grid in case it wasn't populated at boot
        // (character-pack.js may have raced the first stage paint).
        _buildCharacterGrid();
        try { window.goToStage('stage-badge-studio'); } catch (_) {}
        // Set the active tab to "ring" by default + paint.
        _setActiveTab(state.template || 'ring');
    };

    // ── Boot — initialise stage handlers on DOMContentLoaded ──
    //
    // May 2026 (second pass) — the home badge chip is DECORATIVE-ONLY.
    // Badge Studio is now reached via the dedicated #btn-rewards →
    // stage-rewards → #btn-rewards-open-studio path wired in
    // home-screen.js (`_wireRewardsNav` / `_openRewardsStage`).
    // Direct callers (other modules or tests) still invoke the
    // `window.openBadgeStudio()` entry point exported below.
    function _boot() {
        try { _initStage(); } catch (e) { console.warn('[BadgeStudio] init:', e); }
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
