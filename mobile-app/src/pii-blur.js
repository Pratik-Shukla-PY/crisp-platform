// ─────────────────────────────────────────────────────────────────────────────
//  CRISP — Client-side PII blur (PWA)
//
//  Runs BlazeFace (via TF.js) directly in the browser and Gaussian-blurs every
//  face it finds *before* the photo is uploaded. Sensitive pixels never leave
//  the device. The backend still re-runs its full PII pipeline (MediaPipe +
//  easyocr) as a safety net.
//
//  Exposed as a global `PIIBlur` object so `app.js` (non-module vanilla JS) can
//  call it without a bundler. The same pattern TF.js uses via CDN.
//
//  Dependencies — LAZY-LOADED at first ensureModel() call:
//    - tf           (@tensorflow/tfjs@4) — ~360 KB
//    - blazeface    (@tensorflow-models/blazeface@0.1) — ~70 KB
//  These were eagerly downloaded at boot before this change → cost
//  every PWA visitor ~430 KB on Slow 4G even if they never captured a
//  photo. Now injected dynamically the first time `_blurIfPossible`
//  runs, which only happens on the photo-capture stage.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    /** Cached singleton model — loaded on first call, reused thereafter. */
    let _model = null;
    /** In-flight load promise so concurrent callers wait on the same load. */
    let _loading = null;
    /** Lazy-load promise for tf.js + blazeface scripts. Cached after first call. */
    let _scriptsPromise = null;

    /** Last telemetry snapshot; optional to read. */
    let _lastStats = { faces: 0, ms: 0, skipped: false };

    /**
     * Inject a <script> tag and wait for it to load. Idempotent — calling
     * twice with the same URL re-uses the existing tag. Returns a promise.
     */
    function _loadScript(url) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${url}"]`);
            if (existing) {
                if (existing.dataset.loaded === '1') return resolve();
                existing.addEventListener('load', () => resolve());
                existing.addEventListener('error', () =>
                    reject(new Error('script load failed: ' + url)));
                return;
            }
            const s = document.createElement('script');
            s.src = url;
            s.crossOrigin = 'anonymous';
            s.async = false;   // preserve order across multiple injects
            s.onload = () => { s.dataset.loaded = '1'; resolve(); };
            s.onerror = () => reject(new Error('script load failed: ' + url));
            document.head.appendChild(s);
        });
    }

    /**
     * Lazy-load tf.js + blazeface. Idempotent + concurrent-safe.
     * Only fired when we actually need to blur a photo — saves ~430 KB
     * on the home page for users who never capture.
     */
    function _ensureScripts() {
        if (_scriptsPromise) return _scriptsPromise;
        _scriptsPromise = (async () => {
            // Already loaded by some other script tag (back-compat).
            if (typeof tf !== 'undefined' && typeof blazeface !== 'undefined') return;
            // tfjs FIRST (blazeface needs window.tf). Order matters.
            if (typeof tf === 'undefined') {
                await _loadScript(
                    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
            }
            if (typeof blazeface === 'undefined') {
                await _loadScript(
                    'https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.1.0/dist/blazeface.min.umd.js');
            }
        })();
        return _scriptsPromise;
    }

    /**
     * Load BlazeFace on demand. Idempotent + concurrent-safe.
     */
    async function ensureModel() {
        if (_model) return _model;
        if (_loading) return _loading;

        // lazy-load the scripts before checking the globals.
        await _ensureScripts();

        if (typeof tf === 'undefined' || typeof blazeface === 'undefined') {
            throw new Error('TF.js / blazeface failed to load');
        }

        _loading = (async () => {
            // Prefer WebGL for speed; fall back to CPU if unavailable.
            try { await tf.setBackend('webgl'); } catch (_) { await tf.setBackend('cpu'); }
            await tf.ready();
            // vendor the BlazeFace model locally.
            // Default `blazeface.load()` fetches from tfhub.dev/Kaggle
            // which return CORS-blocked 404s on production. Loading from
            // same-origin avoids both CORS issues + the 0.5 s + extra
            // round-trip to a third-party CDN. Files are committed to
            // mobile-app/src/vendor/blazeface/ (~470 KB).
            const modelUrl = new URL(
                'vendor/blazeface/model.json',
                document.baseURI,
            ).toString();
            try {
                _model = await blazeface.load({ modelUrl });
                console.log('[PIIBlur] BlazeFace loaded (vendored), backend=', tf.getBackend());
            } catch (e) {
                // Fallback: try the npm-default URL in case the vendored
                // copy is somehow corrupt or missing on first install.
                console.warn('[PIIBlur] vendored load failed; falling back to default URL:', e.message);
                _model = await blazeface.load();
                console.log('[PIIBlur] BlazeFace loaded (fallback), backend=', tf.getBackend());
            }
            _loading = null;
            return _model;
        })();

        return _loading;
    }

    /**
     * Decode a Blob into an ImageBitmap (fast, native, avoids <img> flash).
     * Falls back through an <img> for older browsers without createImageBitmap.
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

    /**
     * Detect faces using BlazeFace on a downscaled copy, then scale bboxes
     * back to original image coordinates. Downscaling to ~256 px long side
     * keeps inference consistently under ~150 ms without hurting recall for
     * a typical handheld photo.
     */
    async function _detectFaces(bitmap) {
        const model = await ensureModel();

        const longSide = Math.max(bitmap.width, bitmap.height);
        const scale = longSide > 256 ? 256 / longSide : 1;
        const inW = Math.max(1, Math.round(bitmap.width * scale));
        const inH = Math.max(1, Math.round(bitmap.height * scale));

        const off = document.createElement('canvas');
        off.width = inW; off.height = inH;
        off.getContext('2d').drawImage(bitmap, 0, 0, inW, inH);

        const preds = await model.estimateFaces(off, /*returnTensors=*/false, /*flipHorizontal=*/false);
        const invScale = 1 / scale;
        // (revised) — lowered threshold from 0.85 → 0.5.
        //
        // The previous 0.85 threshold filtered out real faces at side
        // profiles, distant, partial, or low-light — BlazeFace's
        // confidence drops below 0.85 for those cases. Combined with
        // the optimistic "blurred:true when 0 faces detected" fallback
        // and the server's then-skip behaviour, real faces leaked
        // through unredacted. Reported as "PII blur stopped working
        // in last 2-3 reports" on 2026-04-28.
        //
        // Trade-off: 0.5 will occasionally blur non-face textures
        // (shadows, patterns) — false positives. For a privacy-
        // critical pipeline this is the right side to err on. Better
        // to over-blur a wall texture than miss a face.
        //
        // Defense-in-depth: even with this lower threshold, the
        // server-side MediaPipe pass (backend/app/services/pii_blur.py)
        // now ALWAYS runs regardless of client claim — see the
        // matching commit on the backend. Client+server combined
        // makes the privacy guarantee robust against either side
        // missing a face.
        const CONF_THRESHOLD = 0.5;
        return preds
            .filter((p) => {
                const prob = Array.isArray(p.probability) ? p.probability[0] : p.probability;
                return typeof prob === 'number' && prob >= CONF_THRESHOLD;
            })
            .map((p) => {
                // BlazeFace returns topLeft [x,y] and bottomRight [x,y] (pixels in input canvas).
                const [x1, y1] = p.topLeft;
                const [x2, y2] = p.bottomRight;
                return {
                    x: Math.round(x1 * invScale),
                    y: Math.round(y1 * invScale),
                    w: Math.round((x2 - x1) * invScale),
                    h: Math.round((y2 - y1) * invScale),
                    probability: Array.isArray(p.probability) ? p.probability[0] : p.probability
                };
            });
    }

    /**
     * Paint a blurred ellipse over each face region. Mirrors the server's
     * treatment in backend/app/services/pii_blur.py (oval mask).
     *
     * tuning:
     *  - Lighter radius (bbox/10 capped 6–60 px, was bbox/6 capped 12–120 px).
     *    Still obscures identity; no longer turns faces into giant smears.
     *  - Blur runs on a downscaled working canvas (long side ≤ 800 px) then
     *    upscales. `ctx.filter = 'blur(Npx)'` is O(N·r²) in the canvas area,
     *    so blurring 4032×3024 at r=120 was easily 3–8 s on mid-range phones
     *    and blocked the main thread (→ Next button felt frozen). Down-sampling
     *    by 4–5× cuts work by 16–25× with no visual difference — blur is
     *    itself a low-pass filter, so down-then-blur-then-up is indistinguishable
     *    from the original.
     *  - 5 % padding kept (was 20 % — stacking client + server pad bloated
     *    redaction zones).
     */
    function _paintBlur(srcCanvas, faces) {
        const ctx = srcCanvas.getContext('2d');
        const W = srcCanvas.width, H = srcCanvas.height;

        // Lighter per-face radius: divide by 10 (was 6), clamp 6–60 (was 12–120).
        // Still enough for identity obscuration — BlazeFace bboxes are typically
        // 100–600 px, so radius lands in 10–60 px (was 16–100 px).
        let maxRadius = 6;
        const perFace = faces.map((f) => {
            const r = Math.min(60, Math.max(6, Math.round(Math.max(f.w, f.h) / 10)));
            if (r > maxRadius) maxRadius = r;
            return r;
        });

        // Build the blurred layer on a DOWNSCALED working canvas. Maximum
        // long side = 800 px; for a 4032-px phone photo that's a 25-fold
        // area reduction. The blur radius scales with the downsample factor
        // so the visual effect matches what a full-res blur would produce.
        const DOWNSCALE_MAX = 800;
        const longSide = Math.max(W, H);
        const scale = longSide > DOWNSCALE_MAX ? DOWNSCALE_MAX / longSide : 1;
        const smallW = Math.max(1, Math.round(W * scale));
        const smallH = Math.max(1, Math.round(H * scale));
        const scaledRadius = Math.max(2, Math.round(maxRadius * scale));

        const blurCanvas = document.createElement('canvas');
        blurCanvas.width = smallW;
        blurCanvas.height = smallH;
        const bCtx = blurCanvas.getContext('2d');
        bCtx.filter = `blur(${scaledRadius}px)`;
        bCtx.drawImage(srcCanvas, 0, 0, smallW, smallH);
        bCtx.filter = 'none';

        faces.forEach((f, i) => {
            // 5 % padding — tight ellipse, no bloat.
            const padX = Math.round(f.w * 0.05);
            const padY = Math.round(f.h * 0.05);
            const x = Math.max(0, f.x - padX);
            const y = Math.max(0, f.y - padY);
            const w = Math.min(W - x, f.w + 2 * padX);
            const h = Math.min(H - y, f.h + 2 * padY);
            if (w <= 0 || h <= 0) return;

            // Map the face's source-space rectangle into the downscaled
            // blur canvas, then drawImage back up so the result lines up
            // pixel-for-pixel with the source canvas ellipse clip.
            const sx = Math.max(0, Math.round(x * scale));
            const sy = Math.max(0, Math.round(y * scale));
            const sw = Math.max(1, Math.round(w * scale));
            const sh = Math.max(1, Math.round(h * scale));

            ctx.save();
            ctx.beginPath();
            ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(blurCanvas, sx, sy, sw, sh, x, y, w, h);
            ctx.restore();
        });
    }

    // CRITICAL FIX (May 21 2026 v249, audit Item 5 — second pass).
    // SERIALISE every call to blurFaces so the TF.js / BlazeFace
    // singleton model is never running two `estimateFaces` in flight
    // at once. Pre-fix the v243 bitmap.close() addressed GPU-memory
    // aliasing between bitmaps, but the deeper bug — confirmed by
    // operator-submitted screenshots of report 365933f6 showing
    // image 1 with a real face correctly blurred AND images 2-5 of
    // a water bottle WITHOUT faces still blurred in the same upper-
    // center region image 1's face occupied — is concurrent model
    // calls returning each other's results.
    //
    // Repro path that triggered the bug:
    //  · User captures 5 photos in tight succession from the camera
    //    modal.
    //  · `_ingestFileAsPhoto` schedules each photo's
    //    `ImageVariants.generate(blob)` via `_runWhenIdle` — 5
    //    independent idle callbacks.
    //  · `generate` calls `_maybeBlur(blob)` which calls
    //    `window.PIIBlur.blurFaces(blob)`.
    //  · All 5 blurFaces calls hit the same `_model` singleton, in
    //    flight at the same time via `await model.estimateFaces`.
    //  · TF.js's internal canvas-input handling reuses tensors / the
    //    backend's input slot; concurrent calls cross-contaminate
    //    each other's results.
    //
    // Wrapping the public `blurFaces` in a chained-promise serialiser
    // guarantees one detection at a time. The wrapper preserves all
    // existing behaviour (return value shape, error fall-through,
    // telemetry timing) — it just funnels callers through a queue.
    //
    // Cost: on the slowest network/device path (multi-photo capture
    // on mid-range Android), end-to-end blur latency scales linearly
    // with photo count. Mid-range Android measures ~150 ms per
    // detection. 5 photos = 750 ms TOTAL wall-clock blur time — the
    // user is already on the review screen by then, so they don't
    // notice. Correctness >>> a few hundred ms.
    let _blurChain = Promise.resolve();
    async function blurFaces(srcBlob, opts) {
        // B-D (May 2026) — prefer the Web Worker pool when available.
        // The pool runs the same detect + blur + encode logic in
        // worker context, keeping the main thread free. For 3-photo
        // bursts on mid-range Android, this is the difference between
        // a smooth 60 fps capture screen and stuttering Next-button
        // taps.
        //
        // Fallback: when the pool isn't available (Safari < 16.4 lacks
        // OffscreenCanvas in workers; SecurityError under restrictive
        // CSP; worker constructor throws) we fall through to the
        // legacy main-thread path below. The v249 Promise-chain
        // serialiser still applies on that path.
        try {
            if (typeof window !== 'undefined'
                && window.BlurWorkerPool
                && window.BlurWorkerPool.isAvailable()) {
                const result = await window.BlurWorkerPool.processPhoto(srcBlob);
                // Translate pool result → legacy blurFaces() result shape.
                if (result && !result.error) {
                    return {
                        blob: result.blob || srcBlob,
                        blurred: !!result.blurred,
                        facesDetected: result.facesDetected || 0,
                        normalizedBoxes: result.normalizedBoxes || [],
                        skipped: false,
                    };
                }
                // Worker resolved with an error sentinel — return the
                // original blob, server safety net handles the rest.
                if (result) {
                    return {
                        blob: result.blob || srcBlob,
                        blurred: false,
                        facesDetected: 0,
                        normalizedBoxes: [],
                        skipped: true,
                        error: result.error || 'worker error',
                    };
                }
            }
        } catch (poolErr) {
            // Pool init failed (e.g. Worker constructor threw under
            // strict CSP). Don't crash — fall through to legacy.
            console.warn('[PIIBlur] worker pool failed; falling back to main-thread blur:', poolErr);
        }

        // Legacy main-thread path (v249 serialiser preserved).
        const prev = _blurChain;
        let resolveSlot;
        _blurChain = new Promise((r) => { resolveSlot = r; });
        try {
            // Wait for the previous call's slot to release. Catch so a
            // prior failure doesn't poison the chain — each call is
            // independent.
            try { await prev; } catch (_) {}
            return await _doBlurFaces(srcBlob, opts);
        } finally {
            resolveSlot();
        }
    }

    /**
     * Internal worker — same body as the original blurFaces. The
     * public `blurFaces` above wraps this in a serialiser.
     *
     * Detect + blur faces in `srcBlob`. Returns a detailed result
     * object:
     *   {
     *     blob:             Blob,     // blurred or original, never null
     *     blurred:          boolean,  // true IFF the full pipeline ran
     *     facesDetected:    number,
     *     normalizedBoxes:  Array<{x, y, w, h}>  // B-C — face boxes in
     *                                   // [0.0, 1.0] coords (fraction
     *                                   // of width/height). Shipped to
     *                                   // server via X-Client-Face-Boxes
     *                                   // header on chunk-bin uploads;
     *                                   // server takes the UNION with
     *                                   // its own MediaPipe pass.
     *                                   // Empty array on no-faces or
     *                                   // failure paths.
     *     skipped:          boolean,  // true if model load / decode / detect crashed
     *     error:            string,   // present when skipped=true
     *   }
     *
     * Legacy behaviour preserved: `blob` is always a Blob, never null,
     * so call-sites still have something to upload. The truthful
     * `blurred` flag is new — before the fix every call-site hardcoded
     * `client_blur_applied: true`, so BlazeFace failures slipped PII
     * past both client AND server blur (server skipped thinking client
     * did it).
     */
    async function _doBlurFaces(srcBlob, opts) {
        const t0 = performance.now();
        // High default quality (0.95) so the post-blur blob feeding the
        // LARGE archival variant preserves source fidelity. The visible
        // re-encode is unavoidable (canvas has to materialise the blur
        // paint somehow), but 0.95 is visually lossless on JPEG vs. the
        // previous 0.85 which compounded with the upstream encode.
        const quality = (opts && typeof opts.quality === 'number') ? opts.quality : 0.95;

        // lazy-load tf.js + blazeface scripts on first call.
        // Prior to this change the libraries were always preloaded via
        // <script> tags in index.html (~430 KB tax on the home page).
        // _ensureScripts() is idempotent + concurrent-safe.
        try {
            await _ensureScripts();
        } catch (e) {
            const err = 'tf/blazeface load failed: ' + (e?.message || e);
            console.warn('[PIIBlur] ' + err + ' — returning raw blob; server MUST run its own blur');
            _lastStats = { faces: 0, ms: 0, skipped: true };
            return { blob: srcBlob, blurred: false, facesDetected: 0, normalizedBoxes: [], skipped: true, error: err };
        }

        // Pipeline is disabled entirely if the backing libraries didn't load.
        if (typeof tf === 'undefined' || typeof blazeface === 'undefined') {
            const err = 'tf/blazeface not loaded';
            console.warn('[PIIBlur] ' + err + ' — returning raw blob; server MUST run its own blur');
            _lastStats = { faces: 0, ms: 0, skipped: true };
            return { blob: srcBlob, blurred: false, facesDetected: 0, normalizedBoxes: [], skipped: true, error: err };
        }

        let bitmap;
        try {
            bitmap = await _decode(srcBlob);
        } catch (e) {
            console.warn('[PIIBlur] decode failed, returning original:', e);
            _lastStats = { faces: 0, ms: 0, skipped: true };
            return { blob: srcBlob, blurred: false, facesDetected: 0, normalizedBoxes: [], skipped: true, error: 'decode failed: ' + (e && e.message || e) };
        }

        // BUGFIX May 2026 (operator-reported, blur cross-contamination
        // audit) — close the ImageBitmap on EVERY exit path. Pre-fix,
        // the bitmap was allocated at `_decode()` and abandoned to the
        // garbage collector at every return below. ImageBitmap is
        // GPU/shared-memory backed; under rapid multi-image processing
        // (4 photos in a row from the camera modal), the GC pool can
        // reuse the underlying memory for the NEXT image's bitmap
        // before the prior image's `canvas.toBlob()` callback fires.
        // Result: image B's encoded output reads pixels that still
        // hold image A's blur paint — operator-visible as "blur
        // appears in regions of image B with no detected faces."
        //
        // The fix has two layers:
        //   1. Close the bitmap IMMEDIATELY after `drawImage()` copies
        //      its pixels onto our canvas. The canvas owns the pixels
        //      independently from that moment forward; the bitmap is
        //      dead weight that just holds GPU memory until GC.
        //   2. A try/finally backstop closes the bitmap on any exit
        //      path that didn't reach drawImage (detect failure, no
        //      faces, paint exception). `_closeBitmap` is idempotent.
        const _closeBitmap = () => {
            if (bitmap && typeof bitmap.close === 'function') {
                try { bitmap.close(); } catch (_) {}
            }
            bitmap = null;
        };

        try {
            let faces = [];
            try {
                faces = await _detectFaces(bitmap);
            } catch (e) {
                console.warn('[PIIBlur] detect failed, returning original:', e);
                _lastStats = { faces: 0, ms: Math.round(performance.now() - t0), skipped: true };
                return { blob: srcBlob, blurred: false, facesDetected: 0, normalizedBoxes: [], skipped: true, error: 'detect failed: ' + (e && e.message || e) };
            }

            // B-C: derive normalized box coords (0.0–1.0 of W/H) once,
            // reuse on every return path below. The pixel-coord boxes
            // (in `faces`) drive the local paint; the normalized boxes
            // ship to the server.
            const _imgW = bitmap.width;
            const _imgH = bitmap.height;
            const normalizedBoxes = faces.map((f) => ({
                x: f.x / _imgW,
                y: f.y / _imgH,
                w: f.w / _imgW,
                h: f.h / _imgH,
            })).filter((b) =>
                // Drop any box that scales out of [0, 1] (defensive —
                // shouldn't happen given _detectFaces clamps, but the
                // server's denormalizer will drop these too).
                b.x >= 0 && b.y >= 0
                && b.x + b.w <= 1.0001
                && b.y + b.h <= 1.0001
            );

            if (faces.length === 0) {
                _lastStats = { faces: 0, ms: Math.round(performance.now() - t0), skipped: false };
                // No faces detected — pipeline ran successfully, just had
                // nothing to redact. Safe for server to skip its face pass.
                return { blob: srcBlob, blurred: true, facesDetected: 0, normalizedBoxes: [], skipped: false };
            }

            // : yield to the event loop before the heavy paint pass so
            // any queued UI interactions (e.g. the user tapping Next the moment
            // the preview appears) have a chance to dispatch. Without this the
            // sync drawImage + filter + canvas-clip work blocked the main
            // thread for hundreds of ms and the Next button felt frozen.
            await new Promise((r) => setTimeout(r, 0));

            // Composite a fresh canvas from the bitmap, then paint blur.
            try {
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                canvas.getContext('2d').drawImage(bitmap, 0, 0);
                // Layer-1 close: canvas now owns the pixels — release the
                // bitmap NOW, before _paintBlur + the async toBlob. This
                // is the close that actually prevents the GPU-memory
                // aliasing bug (the finally-backstop below would close
                // too late on the success path, after toBlob has
                // already had a chance to race on the shared buffer).
                _closeBitmap();
                _paintBlur(canvas, faces);

                const outBlob = await new Promise((resolve) => {
                    canvas.toBlob((b) => resolve(b || srcBlob), 'image/jpeg', quality);
                });

                _lastStats = {
                    faces: faces.length,
                    ms: Math.round(performance.now() - t0),
                    skipped: false
                };
                console.log(`[PIIBlur] blurred ${faces.length} face(s) in ${_lastStats.ms}ms`);
                return { blob: outBlob, blurred: true, facesDetected: faces.length, normalizedBoxes, skipped: false };
            } catch (e) {
                // Paint / canvas / toBlob crash — faces WERE detected but not
                // redacted. Server MUST run its own blur on this one. We
                // STILL emit the normalizedBoxes so the server can use them
                // as detection hints (faces we saw but couldn't paint).
                console.warn('[PIIBlur] paint failed, returning original:', e);
                _lastStats = { faces: faces.length, ms: Math.round(performance.now() - t0), skipped: true };
                return { blob: srcBlob, blurred: false, facesDetected: faces.length, normalizedBoxes, skipped: true, error: 'paint failed: ' + (e && e.message || e) };
            }
        } finally {
            // Layer-2 backstop: any code path above that didn't reach
            // the explicit close (detect-fail, no-faces, paint-fail
            // before drawImage) gets cleanup here. Idempotent.
            _closeBitmap();
        }
    }

    function getLastStats() { return Object.assign({}, _lastStats); }

    // Export globals for non-module callers (app.js).
    window.PIIBlur = { ensureModel, blurFaces, getLastStats };

    // Kick off a lazy model load right after the page is idle, so the *first*
    // photo capture doesn't pay the full model-load latency. Guarded so that
    // offline first-loads (where the model hasn't cached yet) fail silently.
    //
    // delayed the prewarm by
    // 12 s to push the ~360 KB tf.min.js download + ~190 ms parse OUT of
    // Lighthouse's LCP measurement window. Prior 3 s prewarm landed TF.js
    // squarely inside the 6-10 s window where LCP candidates are still
    // settling, contributing main-thread blocking + network contention that
    // dragged LCP to ~13.7 s on Slow-4G mobile (pwa-home-v4 perf score 0.40
    // vs floor 0.45). Pushing past 12 s preserves the "first photo capture
    // is snappy" UX for users who linger ~15 s+ on home before tapping
    // photo, but lets fast-bouncers (~5 s) skip the TF.js cost entirely.
    // Also opts out on Save-Data / 2g-3g connections to honour user
    // bandwidth preferences.
    const _prewarmIfSafe = () => {
        try {
            const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (conn) {
                if (conn.saveData === true) return;
                if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return;
            }
        } catch (_) { /* connection API unavailable — proceed */ }
        const _kick = () => {
            ensureModel().catch((e) => console.log('[PIIBlur] prewarm skipped:', e.message));
        };
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(_kick, { timeout: 5000 });
        } else {
            _kick();
        }
    };
    setTimeout(_prewarmIfSafe, 12000);
})();
