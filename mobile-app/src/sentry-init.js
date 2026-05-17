/**
 * CRISP — Sentry initialization (May 2026 audit fix — PWA observability).
 *
 * The May 2026 product-readiness audit flagged "no Sentry on PWA"
 * as a CRITICAL ops gap. Field reporters in disaster zones hit JS
 * errors that the team never sees because there's no client-side
 * error aggregation. This script wires the Sentry browser SDK so
 * production errors land in our dashboard.
 *
 * The Sentry SDK itself is VENDORED locally (vendor/sentry.min.js)
 * — no third-party CDN dependency, consistent with the Sprint 2
 * "self-host everything" directive.
 *
 * DSN configuration:
 *   The DSN comes from a `<meta name="crisp-sentry-dsn">` tag in
 *   index.html. The tag's `content` is empty in source so Sentry
 *   stays inert by default; the deploy pipeline patches the
 *   content with the real DSN value before serving from PROD.
 *   To enable Sentry locally, edit the meta tag's content
 *   attribute (DSN is a public-safe identifier — write-only key,
 *   no secrets exposed).
 *
 * Why a meta tag (vs env var, vs inline script):
 *   · No build step needed (PWA is vanilla JS).
 *   · Plain HTML edit at deploy time — no JS templating.
 *   · Stays out of CSP `unsafe-inline` territory.
 *   · Same pattern works for the dashboard (parallel file there).
 *
 * Privacy posture:
 *   `beforeSend` strips known-PII keys from the event payload
 *   (description text, transcript, location coordinates). UNDP
 *   must-have #7 (PII protection) explicitly says faces blur
 *   client-side; we extend the same caution to error-report
 *   metadata so a stack trace can't leak the reporter's input.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    const metaTag = document.querySelector('meta[name="crisp-sentry-dsn"]');
    const dsn = metaTag ? (metaTag.getAttribute('content') || '').trim() : '';
    if (!dsn) {
        // No DSN configured (dev environment, or operator hasn't patched
        // the meta tag yet). Stay inert; don't init Sentry. This is
        // intentional — we don't want to fire events at a placeholder
        // endpoint AND don't want to fetch the SDK at all when it'd
        // be a no-op.
        return;
    }

    // May 2026 (perf Sprint A.2) — defer the entire Sentry SDK to
    // browser idle so it never blocks first paint, first input, or
    // the home-stage critical path. Previously the SDK loaded
    // synchronously via `<script defer src="vendor/sentry.min.js">`
    // in the head and Sentry.init ran inside this IIFE — adding
    // ~80 ms TBT and ~25 KB to the critical-render network bill.
    //
    // New flow:
    //   1. The static <script defer src="vendor/sentry.min.js"> tag
    //      has been removed from index.html.
    //   2. This script runs on idle (requestIdleCallback with a
    //      2-second setTimeout fallback for Safari < 17).
    //   3. We inject the SDK <script> dynamically, then init Sentry
    //      after the SDK's onload fires.
    //
    // Cost of delay: errors fired in the first ~2 seconds aren't
    // captured. Acceptable — most JS errors surface after user
    // interaction, which is well past idle.
    function _idle(cb) {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(cb, { timeout: 2500 });
        } else {
            setTimeout(cb, 2000);
        }
    }

    _idle(function loadSentryWhenIdle() {
        // Already loaded? (e.g. dev with the SDK in head). Init directly.
        if (typeof window.Sentry !== 'undefined') {
            _initSentry();
            return;
        }
        // Dynamically inject the vendored SDK.
        const s = document.createElement('script');
        s.src = 'vendor/sentry.min.js?v=8.30.0';
        s.async = true;
        s.onload = _initSentry;
        s.onerror = function () { /* ad-blocker / network — silent no-op */ };
        document.head.appendChild(s);
    });

    function _initSentry() {
        if (typeof window.Sentry === 'undefined') return;

    // Resolve a release tag for deduping events per build. The PWA's
    // service worker carries its own version (`CACHE_NAME = 'crisp-v195'`
    // or similar); read it from the meta tag too so the deploy pipeline
    // doesn't need to patch this file.
    const releaseMeta = document.querySelector('meta[name="crisp-release"]');
    const release = releaseMeta ? (releaseMeta.getAttribute('content') || '').trim() : 'crisp-pwa@unknown';

    const env = (function () {
        const h = window.location.hostname || '';
        if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return 'dev';
        if (h.startsWith('staging.') || h.includes('-staging')) return 'staging';
        return 'prod';
    })();

    try {
        window.Sentry.init({
            dsn,
            release,
            environment: env,
            // Low sample rate by default — disaster zones have spotty
            // bandwidth and we don't want Sentry traces eating user data.
            // The deploy pipeline can override via `?sentry_trace=1.0`
            // for canary investigations.
            tracesSampleRate: 0.05,
            // No session replay yet (heavier payload + privacy
            // implications for reporter content). Re-evaluate post-
            // submission.
            replaysSessionSampleRate: 0,
            replaysOnErrorSampleRate: 0,

            // Privacy filter — strip user-input + GPS coords from the
            // event payload before transmit. UNDP §2.9 says the server
            // never receives raw faces; we extend that to never let
            // a stack trace's extra-context leak the description or
            // exact location either.
            beforeSend(event) {
                try {
                    if (event.request && event.request.url) {
                        // Strip query strings that could contain tokens
                        // (e.g. ?token=abc, ?signed_url=…).
                        event.request.url = event.request.url.split('?')[0];
                    }
                    // Drop any extra context keys whose name suggests
                    // user content.
                    const stripKeys = [
                        'description', 'transcript', 'audio',
                        'photo_data_url', 'photoDataUrl', 'photoVariants',
                        'building_free_text', 'location',
                        'lat', 'lng', 'latitude', 'longitude',
                        'phone', 'email', 'access_token', 'refresh_token',
                    ];
                    if (event.extra) {
                        for (const k of stripKeys) {
                            if (k in event.extra) delete event.extra[k];
                        }
                    }
                    if (event.contexts && event.contexts.state) {
                        for (const k of stripKeys) {
                            if (k in event.contexts.state) {
                                event.contexts.state[k] = '[stripped]';
                            }
                        }
                    }
                } catch (_) { /* never let the filter itself break Sentry */ }
                return event;
            },

            // Ignore noisy errors that aren't actionable: third-party
            // browser-extension stack traces, ResizeObserver loop spam,
            // service-worker-precache misses.
            ignoreErrors: [
                /ResizeObserver loop limit exceeded/,
                /ResizeObserver loop completed with undelivered notifications/,
                /Non-Error promise rejection captured/,
                // Safari's autofill triggers this during form fills.
                /Object Not Found Matching Id/,
                // Service-worker registration retries.
                /The script has an unsupported MIME type/,
            ],
            denyUrls: [
                // Skip events originating from browser extensions.
                /^chrome-extension:\/\//,
                /^moz-extension:\/\//,
                /^safari-extension:\/\//,
            ],
        });

        // Tag every event with the device hash (anonymous ID) so we
        // can debug user-specific issues without seeing PII. The hash
        // is opaque to anyone outside the CRISP backend.
        try {
            const deviceHash = localStorage.getItem('crisp_device_hash_v1') ||
                               localStorage.getItem('crisp_device_id_v2') ||
                               null;
            if (deviceHash) {
                window.Sentry.setUser({ id: deviceHash });
            }
        } catch (_) { /* localStorage unavailable in some contexts */ }

        // Tag the surface (pwa / standalone PWA install / web).
        const displayMode = window.matchMedia('(display-mode: standalone)').matches
            ? 'standalone'
            : 'browser';
        window.Sentry.setTag('display_mode', displayMode);
        window.Sentry.setTag('surface', 'pwa');

        // Phase 3.2 (May 2026) — additional tags for triage:
        //   * `locale` — which UI language was active when the error
        //     fired. Crucial for RTL-specific bugs (Arabic).
        //   * `online` — was the user online? (offline-queue bugs
        //     look very different from live-network bugs.)
        //   * `network` — Connection API hint (4g / 3g / 2g / slow-2g).
        //     Disaster-zone bandwidth is the typical CRISP failure
        //     mode; tagging the connection type lets us filter
        //     "errors from spotty links" specifically.
        try {
            const locale =
                document.documentElement.getAttribute('lang') ||
                localStorage.getItem('crisp_lang') ||
                'unknown';
            window.Sentry.setTag('locale', locale);
        } catch (_) { /* ignore */ }
        try {
            window.Sentry.setTag(
                'online',
                navigator.onLine === false ? 'offline' : 'online',
            );
            const conn = navigator.connection || navigator.mozConnection ||
                         navigator.webkitConnection;
            if (conn && conn.effectiveType) {
                window.Sentry.setTag('network', String(conn.effectiveType));
            }
        } catch (_) { /* Connection API not available on iOS Safari */ }

        // Breadcrumb on every stage transition so error reports include
        // the user's recent navigation history.
        document.addEventListener('stage-entered', (e) => {
            const stage = typeof e.detail === 'string'
                ? e.detail
                : (e.detail?.stage || 'unknown');
            window.Sentry.addBreadcrumb({
                category: 'navigation',
                message: `→ ${stage}`,
                level: 'info',
            });
        });

        // Phase 3.2 — breadcrumb on every offline ↔ online flip.
        // Critical context for diagnosing the offline-queue retry
        // bugs that hit disaster-zone reporters.
        for (const evt of ['online', 'offline']) {
            window.addEventListener(evt, () => {
                window.Sentry.addBreadcrumb({
                    category: 'network',
                    message: `network ${evt}`,
                    level: 'info',
                });
                window.Sentry.setTag(
                    'online',
                    evt === 'offline' ? 'offline' : 'online',
                );
            });
        }

        console.log('[Sentry] PWA init OK · env=' + env + ' · release=' + release);
    } catch (e) {
        console.warn('[Sentry] PWA init failed:', e);
    }
    }   // end _initSentry
})();
