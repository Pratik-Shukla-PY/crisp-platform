// ─────────────────────────────────────────────────────────────────────────────
//  CRISP - Client-side image variant generator (PWA)
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
    // untouched - no canvas resize, no JPEG re-encode. ORIGINAL is
    // passthrough so responders get archival-quality bytes; SMALL + MEDIUM
    // are still downscaled for fast progressive delivery.
    //
    // Phase L (May 2026) - tier vocabulary is SMALL / MEDIUM / ORIGINAL.
    // Pre-L this was small/medium/large mapped to LOW/MEDIUM/HIGH.
    const TIERS = [
        { name: 'small',    maxDim: 320,  quality: 0.40, tier: 'SMALL' },
        { name: 'medium',   maxDim: 800,  quality: 0.60, tier: 'MEDIUM' },
        { name: 'original', passthrough: true,            tier: 'ORIGINAL' },
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

    // Phase L L.2.b (May 2026) - server enforces 5 MB cap on ORIGINAL
    // at /attach + chunked-assembly. Client mirrors the cap so the
    // upload never burns chunks just to be rejected at the end. The
    // ladder runs in order, stops as soon as the blob fits 5 MB:
    //
    //   1. passthrough - no decode, no re-encode (best fidelity)
    //   2. quality ladder at full source dimensions - q=0.85, 0.75, 0.65
    //   3. downscale ladder at q=0.85 - maxDim 4096, 3072, 2048
    //
    // Each call returns { blob, strategy } where `strategy` is one of:
    //   passthrough / quality_q85 / quality_q75 / quality_q65 /
    //   downscale_4096px_q85 / downscale_3072px_q85 /
    //   downscale_2048px_q85 / hard_floor_2048px_q85
    //
    // The strategy is stamped onto the variant so the dashboard can
    // render an "Original (compressed)" chip vs "Original" when the
    // ladder fell below q=0.95 fidelity.
    const _ORIGINAL_MAX_BYTES = 5 * 1024 * 1024;

    async function _encodeJpeg(bitmap, maxDim, quality) {
        const longSide = Math.max(bitmap.width, bitmap.height);
        const scale = (maxDim && longSide > maxDim) ? (maxDim / longSide) : 1;
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
     * Apply the L.2.b ladder to keep the ORIGINAL tier ≤ 5 MB.
     * Returns { blob, strategy }. Best fidelity wins; downscale is the
     * last resort. If even the hard floor (2048 px q=0.85) exceeds
     * 5 MB (extremely unusual - would be a 50+ MP capture with
     * pathological content), we return that floor anyway and the
     * server-side guard will reject + the operator gets the
     * "original_too_large" abandon_reason chip.
     */
    async function _encodeOriginalWithCap(bitmap, sourceBlob) {
        // PRIVACY FIX (May 2026, validation Finding 4): always re-encode at
        // very high quality (q=0.95) instead of returning the raw source
        // blob. canvas.toBlob() does NOT carry EXIF, so this strips GPS +
        // device-identifying metadata from the ORIGINAL tier. Pre-fix,
        // passthrough preserved the iPhone HEIC→JPEG EXIF chain, leaking
        // capture GPS into the assembled storage bytes that responders /
        // exports can fetch. Verified by `exiftool` on assembled bytes in
        // validation scenario 01's 04b_exif_phash artifact.
        //
        // The visual cost is negligible (q=0.95 is well above visual
        // threshold for 5 MP+ captures); the privacy guarantee is the
        // operator-stated requirement.
        //
        // Step 1 - high-quality re-encode at full source dimensions.
        // Common case: phone JPEG already < 5 MB, so this lands in
        // step 1's first try.
        if (sourceBlob.size <= _ORIGINAL_MAX_BYTES) {
            try {
                const stripped = await _encodeJpeg(bitmap, null, 0.95);
                if (stripped.size <= _ORIGINAL_MAX_BYTES) {
                    return { blob: stripped, strategy: 'exif_strip_q95' };
                }
                // If the q=0.95 re-encode actually grew the file past 5 MB
                // (rare - typically only when the source was an extremely
                // small / heavily-compressed JPEG that q=0.95 inflates),
                // fall through to the quality ladder below.
            } catch (e) {
                console.warn('[ImageVariants] EXIF-strip re-encode failed; ' +
                    'falling back to quality ladder:', e);
            }
        }

        // Step 2 - quality ladder at full source dimensions. JPEG
        // re-encode keeps every pixel; only the compression coefficients
        // change. For 5 MP–25 MP captures, q=0.85 is visually
        // indistinguishable from the source.
        for (const q of [0.85, 0.75, 0.65]) {
            try {
                const blob = await _encodeJpeg(bitmap, null, q);
                if (blob.size <= _ORIGINAL_MAX_BYTES) {
                    return { blob, strategy: `quality_q${Math.round(q * 100)}` };
                }
            } catch (e) {
                console.warn('[ImageVariants] quality-ladder encode failed:', e);
            }
        }

        // Step 3 - downscale ladder at q=0.85. Dimensions drop;
        // operator-visible quality reduction.
        for (const maxDim of [4096, 3072, 2048]) {
            try {
                const blob = await _encodeJpeg(bitmap, maxDim, 0.85);
                if (blob.size <= _ORIGINAL_MAX_BYTES) {
                    return { blob, strategy: `downscale_${maxDim}px_q85` };
                }
                // Hard floor - return what we have. Server may still
                // reject with 413 + operator chip.
                if (maxDim === 2048) {
                    return { blob, strategy: 'hard_floor_2048px_q85' };
                }
            } catch (e) {
                console.warn('[ImageVariants] downscale-ladder encode failed:', e);
            }
        }

        // Total failure - fall back to source bytes (server will reject)
        return { blob: sourceBlob, strategy: 'passthrough_fallback_over_cap' };
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
     * 2026 - returns the full result object from blurFaces:
     *   { blob, blurred, facesDetected, skipped, error? }
     *
     * Call-sites consume `.blurred` to decide whether to set
     * `client_blur_applied: true` on the upload. A `skipped: true`
     * result MUST NOT claim client blur - the server has to run its own
     * pass as the safety net for any PII in the image.
     *
     * If PIIBlur isn't loaded at all (SW cache miss, CDN blocked), we
     * return `{ blob, blurred: false }` - same safety-net contract.
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
     * { small: {blob, bytes}, medium: {...}, original: {...} }.
     *
     * Phase 1: blur-once-then-resize.
     *  - OLD pipeline called _maybeBlur per tier → BlazeFace ran 3× on 3
     *    different downsampled images, producing inconsistent redaction
     *    across variants (SMALL at 320 px sometimes missed small faces that
     *    ORIGINAL at full-resolution caught).
     *  - NEW pipeline runs PII blur ONCE on the original Blob, then decodes
     *    the blurred output and resizes to all three tiers. The downscale
     *    is itself a low-pass filter so SMALL ends up *more* redacted, not
     *    less. BlazeFace inference cost is now 1/3 of before.
     *
     * On any per-tier failure we fall back to the source blob for that
     * tier - we NEVER return fewer than three tiers because the sync engine
     * expects all three keys and the partial-delivery guarantee relies on
     * the SMALL tier always existing.
     */
    async function generate(srcBlob) {
        if (!srcBlob) throw new Error('ImageVariants.generate: srcBlob is null');

        // Step 1 - blur ONCE on the original bitmap. : we also
        // capture the truthful `blurred` flag here so every variant of
        // this capture reports accurate `client_blur_applied` to the
        // server. If BlazeFace failed, the raw pixels go up AND the
        // flag is false - server runs its own blur pass instead of
        // skipping on the client's (previously hardcoded) promise.
        const blurResult = await _maybeBlur(srcBlob);
        const blurredSrc = blurResult.blob;
        const clientBlurApplied = Boolean(blurResult.blurred);

        // Step 2 - decode the blurred (or original) source for resize.
        let bitmap;
        try {
            bitmap = await _decode(blurredSrc);
        } catch (e) {
            console.warn('[ImageVariants] decode failed, using source as all tiers:', e);
            const fallback = { blob: blurredSrc, bytes: blurredSrc.size, clientBlurApplied };
            return { small: fallback, medium: fallback, original: fallback, clientBlurApplied };
        }

        // Step 3 - render each tier.
        //
        // SMALL + MEDIUM go through the canvas resize+toBlob path for
        // fast progressive delivery.
        //
        // ORIGINAL (passthrough) runs the L.2.b ladder: passthrough
        // when source ≤ 5 MB, else quality-then-downscale until the
        // blob fits 5 MB. The chosen strategy is stamped onto the
        // variant so the dashboard can render "Original (compressed)"
        // when fidelity dropped below q=0.95.
        const out = { clientBlurApplied };
        for (const t of TIERS) {
            if (t.passthrough) {
                try {
                    const { blob, strategy } = await _encodeOriginalWithCap(bitmap, blurredSrc);
                    out[t.name] = {
                        blob,
                        bytes: blob.size,
                        clientBlurApplied,
                        strategy,
                    };
                    if (strategy !== 'passthrough') {
                        console.log(
                            `[ImageVariants] ORIGINAL ladder picked '${strategy}' ` +
                            `(${(blob.size / 1024).toFixed(0)} KB, ` +
                            `source was ${(blurredSrc.size / 1024).toFixed(0)} KB)`,
                        );
                    }
                } catch (e) {
                    console.warn('[ImageVariants] ORIGINAL ladder failed; using source as fallback:', e);
                    out[t.name] = {
                        blob: blurredSrc,
                        bytes: blurredSrc.size,
                        clientBlurApplied,
                        strategy: 'ladder_failed_fallback',
                    };
                }
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

        // Step 4 - blurhash placeholder (Phase 1 progressive-upload stack).
        // Encode a ~28-char DCT from a 32x32 working canvas. The dashboard
        // renders this as the first visual feedback BEFORE any media chunk
        // uploads - closes the time-to-first-visual gap from ~2 s (first
        // SMALL chunk) to ~200 ms (meta POST RTT). Costs ~10–20 ms of
        // main-thread time; already inside the _runWhenIdle deferral, so
        // the perceived-latency impact is zero.
        //
        // Best-effort - a failure here never breaks the upload path. The
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
            `[ImageVariants] sizes - small=${(out.small.bytes / 1024).toFixed(1)} KB` +
            `, medium=${(out.medium.bytes / 1024).toFixed(1)} KB` +
            `, original=${(out.original.bytes / 1024).toFixed(1)} KB` +
            `; clientBlurApplied=${clientBlurApplied} (faces=${blurResult.facesDetected}${blurResult.skipped ? ', SKIPPED: ' + blurResult.error : ''})` +
            (blurhash ? `; blurhash=${blurhash.slice(0, 8)}…(${blurhash.length} chars)` : '; blurhash=skipped')
        );
        out.blurhash = blurhash;
        return out;
    }

    // Tier → backend ResolutionEnum mapping. Kept in one place so callers
    // don't hard-code the translation.
    // Phase L (May 2026) - canonical SMALL/MEDIUM/ORIGINAL on both sides.
    const TIER_TO_RESOLUTION = { small: 'SMALL', medium: 'MEDIUM', original: 'ORIGINAL' };

    window.ImageVariants = { generate, TIER_TO_RESOLUTION };
})();
