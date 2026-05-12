// ─────────────────────────────────────────────────────────────────────────────
//  CRISP — Client-side image variant generator (PWA)
//
//  For every photo captured by the PWA, produce three JPEG variants on-device:
//
//      SMALL   max 320 px   quality 0.40   ~20–50 KB
//      MEDIUM  max 800 px   quality 0.60   ~100–200 KB
//      LARGE   ORIGINAL     no re-encode   raw-capture bytes
//
//  update: LARGE is now the original capture (post-PII-blur) with
//  no resize and no JPEG re-encode. Previously we'd downscale to 1600 px at
//  q=0.82, which silently discarded detail that responders might have
//  zoomed into (license plates, fine structural damage). User-visible
//  behaviour: SMALL + MEDIUM ship fast on narrow pipes for quick preview,
//  LARGE lands as the full-fidelity archival copy.
//
//  They upload to the backend in order SMALL → MEDIUM → LARGE (handled by
//  app.js + the sync path). The dashboard groups them by `photo_group_id` and
//  promotes the main image tier as each variant lands. Result: even on a
//  30 kbps link, responders see a complete SMALL image within seconds
//  instead of waiting for LARGE to finish.
//
//  Exposed as `window.ImageVariants.generate(srcBlob)` so the vanilla-JS
//  app.js can call it without a module system (same pattern as pii-blur.js).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    // Tier definitions. Keep these numbers aligned with the RN side
    // (`crisp-mobile/services/imageVariants.ts`) so SMALL/MEDIUM/LARGE are
    // visually comparable across clients.
    //
    // `passthrough: true` means the tier uses the blurred source blob
    // untouched — no canvas resize, no JPEG re-encode. LARGE is now
    // passthrough so responders get archival-quality bytes; SMALL + MEDIUM
    // are still downscaled for fast progressive delivery.
    const TIERS = [
        { name: 'small',  maxDim: 320,  quality: 0.40, tier: 'LOW' },
        { name: 'medium', maxDim: 800,  quality: 0.60, tier: 'MEDIUM' },
        { name: 'large',  passthrough: true,          tier: 'HIGH' },
    ];

    /**
     * Decode a Blob into an ImageBitmap. Falls back to <img> for browsers
     * without createImageBitmap (rare in 2026 but not impossible on locked-
     * down corporate / in-store devices).
     */
    async function _decode(blob) {
        if (typeof createImageBitmap === 'function') {
            return await createImageBitmap(blob);
        }
        return await new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
            img.src = url;
        });
    }

    /** Resize `bitmap` so its long side ≤ maxDim, encode as JPEG at `quality`. */
    async function _renderTier(bitmap, maxDim, quality) {
        const longSide = Math.max(bitmap.width, bitmap.height);
        const scale = longSide > maxDim ? maxDim / longSide : 1;
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, w, h);

        return await new Promise((resolve, reject) => {
            canvas.toBlob(
                (b) => b ? resolve(b) : reject(new Error('canvas.toBlob returned null')),
                'image/jpeg',
                quality,
            );
        });
    }

    /**
     * Apply the existing client-side PII blur (if PIIBlur is loaded). Apr
     * 2026 — returns the full result object from blurFaces:
     *   { blob, blurred, facesDetected, skipped, error? }
     *
     * Call-sites consume `.blurred` to decide whether to set
     * `client_blur_applied: true` on the upload. A `skipped: true`
     * result MUST NOT claim client blur — the server has to run its own
     * pass as the safety net for any PII in the image.
     *
     * If PIIBlur isn't loaded at all (SW cache miss, CDN blocked), we
     * return `{ blob, blurred: false }` — same safety-net contract.
     */
    async function _maybeBlur(blob) {
        if (typeof window.PIIBlur === 'undefined') {
            return { blob, blurred: false, facesDetected: 0, skipped: true, error: 'PIIBlur not loaded' };
        }
        try {
            const result = await window.PIIBlur.blurFaces(blob);
            // Back-compat with a hypothetical older PIIBlur that returned a raw Blob.
            if (result instanceof Blob) {
                return { blob: result, blurred: false, facesDetected: 0, skipped: true, error: 'legacy PIIBlur shape' };
            }
            return result || { blob, blurred: false, facesDetected: 0, skipped: true, error: 'null result' };
        } catch (e) {
            console.warn('[ImageVariants] PII blur skipped:', e);
            return { blob, blurred: false, facesDetected: 0, skipped: true, error: (e && e.message) || String(e) };
        }
    }

    /**
     * Public API. Given a source Blob (the raw captured JPEG), return
     * { small: {blob, bytes}, medium: {...}, large: {...} }.
     *
     * Phase 1: blur-once-then-resize.
     *  - OLD pipeline called _maybeBlur per tier → BlazeFace ran 3× on 3
     *    different downsampled images, producing inconsistent redaction
     *    across variants (SMALL at 320 px sometimes missed small faces that
     *    LARGE at 1600 px caught).
     *  - NEW pipeline runs PII blur ONCE on the original Blob, then decodes
     *    the blurred output and resizes to all three tiers. The downscale
     *    is itself a low-pass filter so SMALL ends up *more* redacted, not
     *    less. BlazeFace inference cost is now 1/3 of before.
     *
     * On any per-tier failure we fall back to the source blob for that
     * tier — we NEVER return fewer than three tiers because the sync engine
     * expects all three keys and the partial-delivery guarantee relies on
     * the SMALL tier always existing.
     */
    async function generate(srcBlob) {
        if (!srcBlob) throw new Error('ImageVariants.generate: srcBlob is null');

        // Step 1 — blur ONCE on the original bitmap. : we also
        // capture the truthful `blurred` flag here so every variant of
        // this capture reports accurate `client_blur_applied` to the
        // server. If BlazeFace failed, the raw pixels go up AND the
        // flag is false — server runs its own blur pass instead of
        // skipping on the client's (previously hardcoded) promise.
        const blurResult = await _maybeBlur(srcBlob);
        const blurredSrc = blurResult.blob;
        const clientBlurApplied = Boolean(blurResult.blurred);

        // Step 2 — decode the blurred (or original) source for resize.
        let bitmap;
        try {
            bitmap = await _decode(blurredSrc);
        } catch (e) {
            console.warn('[ImageVariants] decode failed, using source as all tiers:', e);
            const fallback = { blob: blurredSrc, bytes: blurredSrc.size, clientBlurApplied };
            return { small: fallback, medium: fallback, large: fallback, clientBlurApplied };
        }

        // Step 3 — render each tier. `passthrough` tiers
        // skip the canvas round-trip entirely — the blurred source blob
        // ships as-is, preserving full capture fidelity for archival use.
        // Downscaled tiers (SMALL/MEDIUM) go through the canvas path for
        // fast progressive delivery.
        const out = { clientBlurApplied };
        for (const t of TIERS) {
            if (t.passthrough) {
                out[t.name] = { blob: blurredSrc, bytes: blurredSrc.size, clientBlurApplied };
                continue;
            }
            try {
                const resized = await _renderTier(bitmap, t.maxDim, t.quality);
                out[t.name] = { blob: resized, bytes: resized.size, clientBlurApplied };
            } catch (e) {
                console.warn(`[ImageVariants] ${t.name} render failed:`, e);
                out[t.name] = { blob: blurredSrc, bytes: blurredSrc.size, clientBlurApplied };
            }
        }

        // Step 4 — blurhash placeholder (Phase 1 progressive-upload stack).
        // Encode a ~28-char DCT from a 32x32 working canvas. The dashboard
        // renders this as the first visual feedback BEFORE any media chunk
        // uploads — closes the time-to-first-visual gap from ~2 s (first
        // SMALL chunk) to ~200 ms (meta POST RTT). Costs ~10–20 ms of
        // main-thread time; already inside the _runWhenIdle deferral, so
        // the perceived-latency impact is zero.
        //
        // Best-effort — a failure here never breaks the upload path. The
        // variant pipeline outputs are already valid; `blurhash` is an
        // ADDITIONAL payload, not a replacement for anything.
        let blurhash = null;
        try {
            if (typeof self !== 'undefined' && self.BlurHash && typeof self.BlurHash.encodeFromCanvas === 'function') {
                const bhCanvas = document.createElement('canvas');
                bhCanvas.width = 32;
                bhCanvas.height = 32;
                const bhCtx = bhCanvas.getContext('2d');
                bhCtx.drawImage(bitmap, 0, 0, 32, 32);
                blurhash = self.BlurHash.encodeFromCanvas(bhCanvas, 4, 3);
            }
        } catch (e) {
            console.warn('[ImageVariants] blurhash encode failed (non-fatal):', e && e.message);
        }

        if (typeof bitmap.close === 'function') try { bitmap.close(); } catch (_) {}

        console.log(
            `[ImageVariants] sizes — small=${(out.small.bytes / 1024).toFixed(1)} KB` +
            `, medium=${(out.medium.bytes / 1024).toFixed(1)} KB` +
            `, large=${(out.large.bytes / 1024).toFixed(1)} KB` +
            `; clientBlurApplied=${clientBlurApplied} (faces=${blurResult.facesDetected}${blurResult.skipped ? ', SKIPPED: ' + blurResult.error : ''})` +
            (blurhash ? `; blurhash=${blurhash.slice(0, 8)}…(${blurhash.length} chars)` : '; blurhash=skipped')
        );
        out.blurhash = blurhash;
        return out;
    }

    // Tier → backend ResolutionEnum mapping. Kept in one place so callers
    // don't hard-code the translation.
    const TIER_TO_RESOLUTION = { small: 'LOW', medium: 'MEDIUM', large: 'HIGH' };

    window.ImageVariants = { generate, TIER_TO_RESOLUTION };
})();
