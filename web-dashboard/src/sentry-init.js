/**
 * CRISP — Sentry initialization (May 2026 audit fix — Dashboard observability).
 *
 * Mirrors mobile-app/src/sentry-init.js but tagged `surface: dashboard`
 * so events split cleanly between reporter PWA and analyst dashboard
 * in the Sentry project. Operators see field errors here too — if
 * an analyst can't dispatch a report because the dashboard JS broke,
 * that lands in Sentry instead of silently failing.
 *
 * DSN config: same `<meta name="crisp-sentry-dsn">` pattern.
 * Privacy filter: dashboard handles less raw user-content (no
 * description-typing, no photo-blob in the analyst path) but the
 * same beforeSend strip is applied as defense-in-depth.
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || typeof window.Sentry === 'undefined') return;

    const dsnTag = document.querySelector('meta[name="crisp-sentry-dsn"]');
    const dsn = dsnTag ? (dsnTag.getAttribute('content') || '').trim() : '';
    if (!dsn) return;

    const relTag = document.querySelector('meta[name="crisp-release"]');
    const release = relTag ? (relTag.getAttribute('content') || '').trim() : 'crisp-dashboard@unknown';

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
            tracesSampleRate: 0.1,        // dashboard has fewer users + better network → higher sample
            replaysSessionSampleRate: 0,
            replaysOnErrorSampleRate: 0,
            beforeSend(event) {
                try {
                    if (event.request && event.request.url) {
                        event.request.url = event.request.url.split('?')[0];
                    }
                    const stripKeys = [
                        'description', 'transcript',
                        'lat', 'lng', 'latitude', 'longitude',
                        'access_token', 'refresh_token', 'jwt',
                    ];
                    if (event.extra) {
                        for (const k of stripKeys) {
                            if (k in event.extra) delete event.extra[k];
                        }
                    }
                } catch (_) { /* never let the filter break Sentry */ }
                return event;
            },
            ignoreErrors: [
                /ResizeObserver loop limit exceeded/,
                /ResizeObserver loop completed with undelivered notifications/,
                /Non-Error promise rejection captured/,
            ],
            denyUrls: [
                /^chrome-extension:\/\//,
                /^moz-extension:\/\//,
                /^safari-extension:\/\//,
            ],
        });

        // Dashboard tags — distinguish from PWA in the Sentry UI.
        window.Sentry.setTag('surface', 'dashboard');
        window.Sentry.setTag('viewport',
            window.innerWidth >= 1024 ? 'desktop' : 'tablet');

        // Phase 3.2 mirror (Gap C, May 2026) — triage parity with
        // the PWA sentry-init: locale / online / network tags +
        // breadcrumb on every online↔offline flip. Even though
        // dashboard users are typically on stable office networks,
        // operator-reported "the dashboard froze when wifi blipped"
        // bugs benefit from the same context the PWA gets.
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

        // Tag with analyst email if available (no PII risk — analysts
        // are CRISP-internal staff, not field reporters).
        try {
            const authStore = window.AuthStore || null;
            const userEmail = authStore && typeof authStore.getCurrentUserEmail === 'function'
                ? authStore.getCurrentUserEmail() : null;
            if (userEmail) {
                window.Sentry.setUser({ email: userEmail });
            }
        } catch (_) { /* AuthStore not ready or unavailable */ }

        // Phase 3.2 mirror — breadcrumb on every offline↔online flip.
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

        console.log('[Sentry] Dashboard init OK · env=' + env + ' · release=' + release);
    } catch (e) {
        console.warn('[Sentry] Dashboard init failed:', e);
    }
})();
