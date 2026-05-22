/**
 * blur-worker-pool.js — main-thread manager for the blur Web Worker
 * pool. Created May 2026 (Batch B-D of the Forensic Blur Audit).
 *
 * Public API (on window.BlurWorkerPool):
 *   - isAvailable() → boolean
 *       True iff Worker construction succeeded + OffscreenCanvas /
 *       createImageBitmap supported. Callers should branch on this
 *       to decide whether to use the pool or fall back to legacy
 *       main-thread blur.
 *
 *   - processPhoto(blob) → Promise<{
 *         blob: Blob,                              // (possibly blurred)
 *         normalizedBoxes: Array<{x,y,w,h}>,       // [0..1] coords
 *         blurred: boolean,                        // true if pipeline ran
 *         facesDetected: number,
 *         ms: number,                              // elapsed ms in worker
 *     }>
 *     Rejects ONLY on a worker-init failure (the pool then marks
 *     itself unavailable; subsequent callers fall back). Per-photo
 *     errors resolve with a structured result containing the
 *     original blob + error message + empty boxes — callers must
 *     upload the original and rely on the server-side blur safety
 *     net.
 *
 *   - preload() → void
 *       Fires a one-off `preload` message to warm BlazeFace +
 *       TF.js into worker memory. Recommended at PWA boot so the
 *       FIRST capture's worker job doesn't pay the ~1-2 s model
 *       download cost.
 *
 *   - getDebugState() → { workers: 'busy'|'idle'[], queueLength }
 *       Exposed for E2E test (102-burst-3-photos-no-lag).
 *
 * Design choices:
 *   - Pool size = min(2, navigator.hardwareConcurrency). Capped at
 *     2 on every device to bound memory (iOS WebView caps memory
 *     tightly; 2 × ~30 MB peak per worker = ~60 MB headroom is OK).
 *   - Workers are CREATED LAZILY on first job — pages that never
 *     touch the camera path pay zero overhead.
 *   - FIFO queue. Each worker pulls the next job when free. No
 *     priority scheduling — capture order = upload order in
 *     practice.
 *   - jobId is a monotonic counter scoped to the pool instance.
 *     Used to route worker → main thread responses back to the
 *     awaiting Promise.
 */
'use strict';

(function () {
    if (typeof window === 'undefined') return;

    const POOL_MAX = Math.min(
        2,
        Math.max(1, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2)
    );

    // Feature gate. If ANY of these are missing, the pool refuses to
    // initialise and callers fall back to the legacy main-thread blur.
    function _featuresAvailable() {
        if (typeof Worker === 'undefined') return false;
        if (typeof OffscreenCanvas === 'undefined') return false;
        if (typeof createImageBitmap === 'undefined') return false;
        return true;
    }

    let _available = null;   // tri-state: null=unprobed, true=usable, false=unusable
    let _workers = [];        // { worker: Worker, busy: boolean }
    let _queue = [];          // { blob, resolve, reject, jobId }
    let _nextJobId = 1;
    const _pendingJobs = new Map();  // jobId → { resolve, reject, blob }

    function _spawnOne() {
        try {
            // Same-origin static URL — works under the existing CSP
            // (worker-src 'self' blob: in CSP). The worker itself
            // imports TF.js + BlazeFace from CDNs at boot.
            const w = new Worker('/mobile-app/src/blur-worker.js');
            w.addEventListener('message', _onWorkerMessage.bind(null, w));
            w.addEventListener('error', (e) => {
                console.warn('[BlurPool] worker error:', e && e.message);
            });
            return { worker: w, busy: false };
        } catch (e) {
            console.warn('[BlurPool] Worker construction failed:', e);
            return null;
        }
    }

    function _ensureWorkers() {
        if (_available === false) return false;
        if (_workers.length >= POOL_MAX) return true;
        if (_available === null) {
            _available = _featuresAvailable();
            if (!_available) return false;
        }
        while (_workers.length < POOL_MAX) {
            const entry = _spawnOne();
            if (!entry) {
                if (_workers.length === 0) {
                    _available = false;
                    return false;
                }
                break;  // partial pool OK if at least one worker started
            }
            _workers.push(entry);
        }
        return true;
    }

    function _onWorkerMessage(workerInstance, ev) {
        const msg = ev.data || {};
        if (msg.type === 'done' || msg.type === 'error') {
            const job = _pendingJobs.get(msg.jobId);
            if (job) {
                _pendingJobs.delete(msg.jobId);
                if (msg.type === 'done') {
                    job.resolve({
                        blob: msg.blob,
                        normalizedBoxes: msg.normalizedBoxes || [],
                        blurred: !!msg.blurred,
                        facesDetected: msg.facesDetected || 0,
                        ms: msg.ms || 0,
                    });
                } else {
                    // Error path — resolve with the ORIGINAL blob +
                    // empty boxes so the caller can still upload.
                    // Server-side blur is the authoritative safety net.
                    job.resolve({
                        blob: msg.blob || job.blob,
                        normalizedBoxes: [],
                        blurred: false,
                        facesDetected: 0,
                        ms: 0,
                        error: msg.error || 'unknown worker error',
                    });
                }
            }
            // Mark this worker free + pull the next queued job.
            const entry = _workers.find((e) => e.worker === workerInstance);
            if (entry) {
                entry.busy = false;
                _drain();
            }
        } else if (msg.type === 'ready') {
            // Preload response — informational only.
            console.log('[BlurPool] worker preload ready');
        }
    }

    function _drain() {
        for (const entry of _workers) {
            if (entry.busy) continue;
            const next = _queue.shift();
            if (!next) return;
            entry.busy = true;
            _pendingJobs.set(next.jobId, {
                resolve: next.resolve,
                reject: next.reject,
                blob: next.blob,
            });
            try {
                entry.worker.postMessage({
                    type: 'process', jobId: next.jobId, blob: next.blob,
                });
            } catch (e) {
                // postMessage failed (worker died, structured-clone refused). Reject.
                _pendingJobs.delete(next.jobId);
                entry.busy = false;
                next.resolve({
                    blob: next.blob, normalizedBoxes: [], blurred: false,
                    facesDetected: 0, ms: 0,
                    error: 'postMessage failed: ' + (e && e.message || e),
                });
            }
        }
    }

    // ── Public API ────────────────────────────────────────────────────

    function isAvailable() {
        if (_available !== null) return _available;
        _available = _featuresAvailable();
        return _available;
    }

    function processPhoto(blob) {
        return new Promise((resolve, reject) => {
            if (!_ensureWorkers()) {
                return reject(new Error('blur worker pool unavailable'));
            }
            const jobId = String(_nextJobId++);
            _queue.push({ blob, resolve, reject, jobId });
            _drain();
        });
    }

    function preload() {
        if (!_ensureWorkers()) return;
        for (const entry of _workers) {
            try {
                entry.worker.postMessage({ type: 'preload' });
            } catch (_) { /* best-effort */ }
        }
    }

    function getDebugState() {
        return {
            workers: _workers.map((e) => e.busy ? 'busy' : 'idle'),
            queueLength: _queue.length,
            pendingJobs: _pendingJobs.size,
            available: _available,
            poolMax: POOL_MAX,
        };
    }

    window.BlurWorkerPool = {
        isAvailable,
        processPhoto,
        preload,
        getDebugState,
    };

    // Expose a debug hook the E2E tests use (102-burst-3-photos-no-lag).
    window.__crispBlurPoolState = getDebugState;
})();
