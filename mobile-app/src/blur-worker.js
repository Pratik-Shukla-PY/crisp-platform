/**
 * blur-worker.js - Web Worker that runs PII face blur off the main
 * thread.
 *
 * Created May 2026 (Batch B-D of the Forensic Blur Audit). Sibling
 * to pii-blur.js which still handles the legacy main-thread path.
 *
 * Goal: 3 × 5-10 MB photos captured back-to-back never block the
 * main thread. Each photo's detect + blur + encode happens in a
 * Web Worker; the main thread stays at 60 fps for typing,
 * scrolling, and classification picks.
 *
 * Message protocol (main → worker):
 *   { type: 'process', jobId, blob }
 *     - jobId: opaque string the pool tracks for routing the
 *       response back to the right Promise.
 *     - blob: source photo Blob (transferable; ownership moves to
 *       the worker).
 *
 * Message protocol (worker → main):
 *   { type: 'done', jobId, blob, normalizedBoxes, blurred, facesDetected, ms }
 *     - On success. `blob` is the (possibly blurred) JPEG. If
 *       facesDetected=0, blob is the original (unmodified).
 *       normalizedBoxes is [] when no faces were detected.
 *
 *   { type: 'error', jobId, error: <string>, blob }
 *     - On failure (decode error, model load failure, etc.). `blob`
 *       is the ORIGINAL input - the main thread can still upload it
 *       and the server will run its own blur as a safety net.
 *
 * Browser compatibility:
 *   - Workers: universally supported (≥ IE10).
 *   - importScripts: required for TF.js + BlazeFace CDN load.
 *     Available in every classic worker.
 *   - createImageBitmap: Chrome 50+, Firefox 42+, Safari 15+.
 *   - OffscreenCanvas: Chrome 69+, Firefox 105+, Safari 16.4+.
 *
 * Fallback contract: if the pool can't construct a worker (very old
 * browser, security policy block) or the worker fails to load TF.js,
 * the pool's processPhoto() rejects with a sentinel error. The
 * caller (pii-blur.js's blurFaces) catches and falls back to the
 * legacy main-thread path, preserving back-compat.
 */
'use strict';

// ── TF.js + BlazeFace model load (singleton; first call is slow,
//    subsequent calls are zero-cost since the model stays in worker
//    memory until the worker is terminated).
let _modelPromise = null;
let _tfReady = false;

// HC89 (Sprint 1B, May 2026) - local-first script load. Previously
// the worker pulled both libs from jsdelivr at every cold start; any
// time jsdelivr was rate-limited / 404'd (which broke
// `blazeface.min.js`'s alias in some windows) the worker errored
// closed and faces shipped UNBLURRED - a UNDP must-have #7 violation.
//
// Now we try the same-origin vendored copies first
// (mobile-app/src/vendor/{tf,blazeface}/). If those importScripts
// calls fail (network glitch, file removed by a SW cache desync,
// etc.), we fall back to the original CDN URLs as a last resort.
// The vendored files are part of STATIC_ASSETS so they install
// with the SW; offline first-capture works without any CDN at all.
//
// Version pin: TF.js 4.22.0 (unified with pii-blur.js's main-thread
// path; pre-HC89 the worker shipped 3.21.0 while the page used
// 4.22.0 - silent behavioural divergence between the two blur paths).
const LOCAL_TF = './vendor/tf/tf.min.js';
const LOCAL_BLAZEFACE = './vendor/blazeface/blazeface.min.js';
const TF_CDN = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const BLAZEFACE_CDN = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.1.0/dist/blazeface.min.umd.js';

function _loadTfStack() {
    if (_tfReady) return Promise.resolve();
    // Classic worker: importScripts is synchronous (blocks the worker
    // thread, NOT the main thread - that's the point).
    //
    // Try vendored first; both libs in a single call so we share the
    // same network/install round-trip. If that throws, fall back to
    // the CDN. If both fail, reject and the pool falls back to the
    // legacy main-thread blur path (pii-blur.js).
    try {
        importScripts(LOCAL_TF, LOCAL_BLAZEFACE);
        _tfReady = true;
        return Promise.resolve();
    } catch (localErr) {
        try {
            importScripts(TF_CDN, BLAZEFACE_CDN);
            _tfReady = true;
            // eslint-disable-next-line no-console
            console.warn(
                '[blur-worker] vendored libs unavailable, loaded from CDN fallback: '
                + (localErr && localErr.message || localErr),
            );
            return Promise.resolve();
        } catch (cdnErr) {
            return Promise.reject(new Error(
                'importScripts failed (vendored + CDN): '
                + 'vendored="' + (localErr && localErr.message || localErr) + '", '
                + 'cdn="' + (cdnErr && cdnErr.message || cdnErr) + '"',
            ));
        }
    }
}

function _ensureModel() {
    if (_modelPromise) return _modelPromise;
    _modelPromise = _loadTfStack().then(async () => {
        if (typeof self.blazeface === 'undefined') {
            throw new Error('blazeface global missing after importScripts');
        }
        // HC89 (Sprint 1B, May 2026) - vendored BlazeFace model URL.
        // Mirrors pii-blur.js's main-thread path. Default
        // blazeface.load() (no args) fetches model.json from tfhub.dev
        // / Kaggle which CORS-block from the worker's null origin and
        // 404 in some windows - same root cause as the JS lib outage.
        // The vendored model weights (model.json + shards) live at
        // mobile-app/src/vendor/blazeface/ and are part of STATIC_ASSETS.
        const modelUrl = new URL(
            'vendor/blazeface/model.json',
            self.location.href,
        ).toString();
        try {
            return await self.blazeface.load({ modelUrl });
        } catch (vendoredErr) {
            // eslint-disable-next-line no-console
            console.warn(
                '[blur-worker] vendored model load failed, trying default URL:',
                vendoredErr && vendoredErr.message || vendoredErr,
            );
            return await self.blazeface.load();
        }
    });
    return _modelPromise;
}

// ── Detection + blur compositing ──────────────────────────────────────
//
// Mirrors pii-blur.js's main-thread path. We re-implement here rather
// than importing from pii-blur.js because workers can't share modules
// with the main thread (different global, no document/window).

const CONF_THRESHOLD = 0.5;       // matches pii-blur.js
const DOWNSCALE_MAX_INFERENCE = 256;  // for BlazeFace inference
const DOWNSCALE_MAX_BLUR = 800;       // for blur paint canvas
const JPEG_QUALITY = 0.92;

async function _detectFaces(bitmap, model) {
    // Downscale the input for inference. BlazeFace was trained on
    // 128×128; running on a 4000×3000 image is wasteful and noisier.
    const longSide = Math.max(bitmap.width, bitmap.height);
    const scale = longSide > DOWNSCALE_MAX_INFERENCE
        ? DOWNSCALE_MAX_INFERENCE / longSide
        : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    // OffscreenCanvas: available in workers in supported browsers.
    let off;
    try {
        off = new OffscreenCanvas(w, h);
    } catch (e) {
        throw new Error('OffscreenCanvas unavailable: ' + (e && e.message || e));
    }
    off.getContext('2d').drawImage(bitmap, 0, 0, w, h);

    const preds = await model.estimateFaces(off, false, false);
    const invScale = 1 / scale;
    return preds
        .filter((p) => {
            const prob = Array.isArray(p.probability) ? p.probability[0] : p.probability;
            return typeof prob === 'number' && prob >= CONF_THRESHOLD;
        })
        .map((p) => {
            const [x1, y1] = p.topLeft;
            const [x2, y2] = p.bottomRight;
            return {
                x: Math.round(x1 * invScale),
                y: Math.round(y1 * invScale),
                w: Math.round((x2 - x1) * invScale),
                h: Math.round((y2 - y1) * invScale),
            };
        });
}

function _paintBlurOffscreen(srcCanvas, faces) {
    const ctx = srcCanvas.getContext('2d');
    const W = srcCanvas.width, H = srcCanvas.height;
    let maxRadius = 6;
    const perFace = faces.map((f) => {
        const r = Math.min(60, Math.max(6, Math.round(Math.max(f.w, f.h) / 10)));
        if (r > maxRadius) maxRadius = r;
        return r;
    });

    const longSide = Math.max(W, H);
    const scale = longSide > DOWNSCALE_MAX_BLUR ? DOWNSCALE_MAX_BLUR / longSide : 1;
    const smallW = Math.max(1, Math.round(W * scale));
    const smallH = Math.max(1, Math.round(H * scale));
    const scaledRadius = Math.max(2, Math.round(maxRadius * scale));

    const blurCanvas = new OffscreenCanvas(smallW, smallH);
    const bCtx = blurCanvas.getContext('2d');
    bCtx.filter = `blur(${scaledRadius}px)`;
    bCtx.drawImage(srcCanvas, 0, 0, smallW, smallH);
    bCtx.filter = 'none';

    faces.forEach((f, i) => {
        const padX = Math.round(f.w * 0.05);
        const padY = Math.round(f.h * 0.05);
        const x = Math.max(0, f.x - padX);
        const y = Math.max(0, f.y - padY);
        const w = Math.min(W - x, f.w + 2 * padX);
        const h = Math.min(H - y, f.h + 2 * padY);
        const cx = x + w / 2;
        const cy = y + h / 2;
        const rx = w / 2;
        const ry = h / 2;

        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.clip();
        // Map source rect on the blur (small) canvas → target rect on
        // the full-size source canvas. (sx, sy, sw, sh) on the
        // small-blur canvas maps to (x, y, w, h) on the full source.
        const sx = x * scale, sy = y * scale, sw = w * scale, sh = h * scale;
        ctx.drawImage(blurCanvas, sx, sy, sw, sh, x, y, w, h);
        ctx.restore();
    });
}

async function _processPhoto(blob) {
    const t0 = Date.now();
    const model = await _ensureModel();

    let bitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch (e) {
        // Decode failure. Return the original blob - server is the
        // authoritative blur layer; client output is cosmetic.
        return {
            blob, normalizedBoxes: [], blurred: false, facesDetected: 0,
            ms: Date.now() - t0, error: 'decode failed: ' + (e && e.message || e),
        };
    }

    try {
        const faces = await _detectFaces(bitmap, model);
        const _imgW = bitmap.width;
        const _imgH = bitmap.height;
        const normalizedBoxes = faces
            .map((f) => ({
                x: f.x / _imgW,
                y: f.y / _imgH,
                w: f.w / _imgW,
                h: f.h / _imgH,
            }))
            .filter((b) =>
                b.x >= 0 && b.y >= 0
                && b.x + b.w <= 1.0001
                && b.y + b.h <= 1.0001
            );

        if (faces.length === 0) {
            // No faces - return the ORIGINAL blob (no re-encode).
            // B-B's bit-identity invariant on the server side relies
            // on clients NOT re-encoding when they didn't change pixels.
            return {
                blob, normalizedBoxes, blurred: true, facesDetected: 0,
                ms: Date.now() - t0,
            };
        }

        // Composite blur on OffscreenCanvas.
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        try {
            bitmap.close();
        } catch (_) { /* not all browsers expose close() */ }

        _paintBlurOffscreen(canvas, faces);
        const outBlob = await canvas.convertToBlob({
            type: 'image/jpeg', quality: JPEG_QUALITY,
        });

        return {
            blob: outBlob, normalizedBoxes,
            blurred: true, facesDetected: faces.length,
            ms: Date.now() - t0,
        };
    } catch (e) {
        try { bitmap.close(); } catch (_) {}
        return {
            blob, normalizedBoxes: [], blurred: false, facesDetected: 0,
            ms: Date.now() - t0, error: 'detect/paint failed: ' + (e && e.message || e),
        };
    }
}

// ── Worker message loop ───────────────────────────────────────────────
self.addEventListener('message', async (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'process' && msg.jobId && msg.blob) {
        try {
            const result = await _processPhoto(msg.blob);
            if (result.error) {
                self.postMessage({
                    type: 'error', jobId: msg.jobId,
                    error: result.error, blob: result.blob,
                });
            } else {
                // Transfer the blob's ArrayBuffer back to main thread
                // when possible. Blobs themselves aren't transferable,
                // but the postMessage clone is structuredClone which
                // handles Blobs efficiently (the underlying byte slab
                // is shared, not copied).
                self.postMessage({
                    type: 'done', jobId: msg.jobId,
                    blob: result.blob,
                    normalizedBoxes: result.normalizedBoxes,
                    blurred: result.blurred,
                    facesDetected: result.facesDetected,
                    ms: result.ms,
                });
            }
        } catch (e) {
            self.postMessage({
                type: 'error', jobId: msg.jobId,
                error: 'worker exception: ' + (e && e.message || e),
                blob: msg.blob,
            });
        }
    } else if (msg.type === 'preload') {
        // Eager model load on idle. Returns 'ready' or 'error'.
        try {
            await _ensureModel();
            self.postMessage({ type: 'ready' });
        } catch (e) {
            self.postMessage({
                type: 'error', jobId: 'preload',
                error: 'preload failed: ' + (e && e.message || e),
            });
        }
    }
});
