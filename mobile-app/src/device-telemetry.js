/**
 * CRISP PWA - Device Telemetry Capture (Phase 5.1)
 * ────────────────────────────────────────────────
 * Companion to backend commit 79ffc56 + docs/NEARBY_REPORTS_PIPELINE.md §6.2.
 *
 * Captures a small behaviour-summary of the device on app boot and POSTs
 * it to /api/v1/devices/telemetry. The backend's fraud_batch
 * emulator-farm detector reads this to fingerprint emulators (real
 * implementation replacing the Phase-5 UA-substring scaffold).
 *
 * Privacy (UNDP must-have #7):
 *   - No raw sensor streams; only a 1-bit accel-active flag derived from
 *     local variance on ~600 ms of samples.
 *   - No GPS; no PII fields.
 *   - The values posted are exactly the allow-list the backend will
 *     accept; anything else is silently dropped server-side too.
 *
 * Behaviour:
 *   - Self-throttles to once per 24 hours via localStorage so subsequent
 *     app opens don't spam the endpoint.
 *   - Best-effort + fire-and-forget: POST failures are swallowed.
 *   - Runs ~1.2s after DOMContentLoaded so it doesn't compete with the
 *     critical-path home-render work.
 *   - On iOS Safari 13+, DeviceMotion requires explicit user permission.
 *     We do NOT prompt for it - if no events arrive, accel_active stays
 *     null (inconclusive), and the backend's compound-score detector
 *     does not penalise unknown signals.
 *
 * This is a standalone module - not part of app.js - so a future
 * privacy-conscious deployment can disable telemetry entirely by
 * removing one <script> tag from index.html.
 */
(function () {
    'use strict';

    // HC27 (May 2026, HAR root-cause fix) - was the bare relative
    // '/api/v1/devices/telemetry' which the browser anchored to the
    // current origin. In dev this hit the Python static server on
    // :8080 and 404'd; in PROD the same-origin nginx proxy made it
    // accidentally work. Resolve the absolute backend URL from
    // window.API_BASE (set by the head-IIFE in index.html); the
    // tail '/devices/telemetry' is appended at fetch time so this
    // module never resolves an undefined window.API_BASE at parse.
    var ENDPOINT_TAIL = '/devices/telemetry';
    function _endpoint() {
        var base = (typeof window !== 'undefined' && typeof window.API_BASE === 'string' && window.API_BASE)
            ? window.API_BASE.replace(/\/$/, '')
            : null;
        return base ? base + ENDPOINT_TAIL : null;
    }
    var LS_KEY   = 'crisp_telemetry_collected_at';
    var MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;  // re-capture once per day
    var BOOT_DELAY_MS = 1200;                   // wait past critical path

    function _deviceHash() {
        try {
            return localStorage.getItem('crisp_device_id_v2') ||
                   localStorage.getItem('crisp_device_hash') ||
                   localStorage.getItem('crisp_device_id') || '';
        } catch (_) {
            return '';
        }
    }

    function _readWebGLRenderer() {
        try {
            var canvas = document.createElement('canvas');
            var gl = canvas.getContext('webgl') ||
                     canvas.getContext('experimental-webgl');
            if (!gl) return '';
            var ext = gl.getExtension('WEBGL_debug_renderer_info');
            if (!ext) {
                // No debug extension → fall back to the masked vendor
                // string; usually says "Google Inc. (Apple)" or similar.
                return String(gl.getParameter(gl.RENDERER) || '');
            }
            return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
        } catch (_) {
            return '';
        }
    }

    function _probeAccel() {
        // Sample DeviceMotion for ~600 ms; if values VARY between
        // samples, the device is being handled by a real user (or sitting
        // on a vibrating surface - close enough). Emulators report
        // either no DeviceMotion events at all or static values.
        return new Promise(function (resolve) {
            if (typeof window.DeviceMotionEvent === 'undefined') {
                resolve(null);
                return;
            }
            var samples = [];
            var onMotion = function (ev) {
                var a = ev.acceleration || ev.accelerationIncludingGravity;
                if (a && (a.x != null || a.y != null || a.z != null)) {
                    samples.push([a.x || 0, a.y || 0, a.z || 0]);
                }
            };
            try {
                window.addEventListener('devicemotion', onMotion);
            } catch (_) {
                resolve(null);
                return;
            }
            setTimeout(function () {
                try { window.removeEventListener('devicemotion', onMotion); } catch (_) {}
                if (samples.length < 3) {
                    // No events at all → iOS-without-permission or no sensor.
                    resolve(null);
                    return;
                }
                var totalVar = 0;
                for (var axis = 0; axis < 3; axis++) {
                    var vals = [];
                    for (var i = 0; i < samples.length; i++) vals.push(samples[i][axis]);
                    var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
                    var v = 0;
                    for (var j = 0; j < vals.length; j++) v += (vals[j] - mean) * (vals[j] - mean);
                    totalVar += v / vals.length;
                }
                // 0.01 threshold matches typical sensor jitter floor on
                // real devices sitting still on a desk; emulators sit at
                // exactly 0.
                resolve(totalVar > 0.01);
            }, 600);
        });
    }

    async function _collectSummary() {
        var summary = { platform_ua: (navigator.userAgent || '').slice(0, 200) };

        try {
            summary.screen_w = (window.screen && window.screen.width)  || window.innerWidth  || 0;
            summary.screen_h = (window.screen && window.screen.height) || window.innerHeight || 0;
            summary.screen_dpr = window.devicePixelRatio || 1;
        } catch (_) {}

        try {
            summary.timezone = (Intl.DateTimeFormat().resolvedOptions().timeZone || '').slice(0, 64);
        } catch (_) {
            summary.timezone = '';
        }
        try {
            summary.locale = (navigator.language || '').slice(0, 16);
        } catch (_) {
            summary.locale = '';
        }

        summary.webgl_renderer = _readWebGLRenderer().slice(0, 64);

        // Battery API: Chrome / Firefox on Android + desktop; never on
        // iOS Safari (intentionally removed in iOS 17 for privacy). So
        // battery_present=false on an iOS device is EXPECTED - the
        // backend detector only fires on this signal combined with at
        // least one other (e.g. claimed-mobile-UA + no-accel-active).
        if (typeof navigator.getBattery === 'function') {
            try {
                var b = await navigator.getBattery();
                summary.battery_present = true;
                summary.battery_charging = !!b.charging;
                // Backend coarsens to 10 % buckets; we send the raw
                // 0-100 value here for transparency in the network
                // tab + because the sanitiser is the gatekeeper.
                summary.battery_level = Math.round((b.level || 0) * 100);
            } catch (_) {
                summary.battery_present = false;
            }
        } else {
            summary.battery_present = false;
        }

        summary.accel_active = await _probeAccel();
        summary.collected_at = new Date().toISOString();

        // AUDIT 2026-05-23 - i18n startup telemetry. Frontend-only (no
        // backend schema change); dropped into the existing `summary`
        // payload which the backend stores as-is. Fields are bounded +
        // contain no PII. Never blocks captureNow if missing - uses
        // optional-chaining + safe defaults.
        try {
            var im = (typeof window !== 'undefined' && window.__crispI18nMetrics) || {};
            summary.i18n = {
                source: im.source || null,               // manual | cached_ctx | browser | fallback_en
                boot_lang: im.lang || null,              // resolved locale code
                dir: im.dir || null,                     // ltr | rtl
                walker: im.walker || null,               // ok | fallback_en | fallback_html | crashed | watchdog | pending
                startup_ms: (typeof im.duration === 'number') ? Math.round(im.duration) : null,
                fallback_fired: (typeof im.fallbackFired === 'number') ? im.fallbackFired : null,
                error: im.error || null,                 // short message if walker crashed
                // Pack version (sha256 prefix of source JSON) - lets the
                // backend correlate sessions to specific builds.
                pack_version: (function () {
                    try {
                        var packs = window.__crispHomeI18nPacks;
                        return (packs && packs[im.lang || 'en'] && packs[im.lang || 'en'].__version) || null;
                    } catch (_) { return null; }
                })(),
                // How many times the user opened the lang picker + picked
                // a different lang this session. Read from a session
                // counter app.js maintains (see _onLangPickerChange).
                user_lang_change_count: (function () {
                    try { return parseInt(sessionStorage.getItem('crisp_lang_picker_changes') || '0', 10) || 0; }
                    catch (_) { return null; }
                })(),
            };
        } catch (_) {
            // i18n telemetry capture failure must never block the rest
            // of the device telemetry payload.
            summary.i18n = null;
        }
        return summary;
    }

    function _shouldSkip() {
        try {
            var last = parseInt(localStorage.getItem(LS_KEY) || '0', 10);
            if (isNaN(last)) last = 0;
            return (Date.now() - last) < MIN_INTERVAL_MS;
        } catch (_) {
            return false;
        }
    }

    function _markCollected() {
        try { localStorage.setItem(LS_KEY, String(Date.now())); } catch (_) {}
    }

    async function captureNow() {
        var deviceHash = _deviceHash();
        if (!deviceHash) {
            // Boot ordering - app.js's device-id generator might not
            // have run yet. Defer and retry once. If still missing,
            // give up; we'll try again next session.
            await new Promise(function (r) { setTimeout(r, 1500); });
            deviceHash = _deviceHash();
            if (!deviceHash) return;
        }
        var summary;
        try {
            summary = await _collectSummary();
        } catch (e) {
            // Capture failure - silently abandon this round.
            return;
        }
        try {
            // HC27 - resolve the absolute backend URL via window.API_BASE.
            // Bail if API_BASE isn't set yet (boot timing) - the next
            // session's BOOT_DELAY_MS tick will retry; no need to risk
            // hitting the static server. Auth header NOT sent - the
            // endpoint is intentionally auth-free.
            var url = _endpoint();
            if (!url) return;
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_hash: deviceHash, summary: summary }),
                keepalive: true,
            });
            _markCollected();
        } catch (_) {
            // Network failure → don't mark collected; retry next session.
        }
    }

    // Expose for explicit invocation (e.g. settings-page "Refresh
    // device fingerprint" debug button if we ever add one).
    window.crispCaptureTelemetry = captureNow;

    document.addEventListener('DOMContentLoaded', function () {
        if (_shouldSkip()) return;
        setTimeout(captureNow, BOOT_DELAY_MS);
    });
})();
