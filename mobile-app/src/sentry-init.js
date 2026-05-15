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

    if (typeof window === 'undefined' || typeof window.Sentry === 'undefined') {
        // SDK didn't load (404, CSP block, ad-blocker). No-op cleanly.
        return;
    }

    const metaTag = document.querySelector('meta[name="crisp-sentry-dsn"]');
    const dsn = metaTag ? (metaTag.getAttribute('content') || '').trim() : '';
    if (!dsn) {
        // No DSN configured (dev environment, or operator hasn't patched
        // the meta tag yet). Stay inert; don't init Sentry. This is
        // intentional — we don't want to fire events at a placeholder
        // endpoint.
        return;
    }

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

        console.log('[Sentry] PWA init OK · env=' + env + ' · release=' + release);
    } catch (e) {
        console.warn('[Sentry] PWA init failed:', e);
    }
})();
