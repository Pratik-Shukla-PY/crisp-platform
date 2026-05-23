/**
 * HC27 (May 2026) — API_BASE frame-0 invariant regression guard.
 *
 * The PWA loads three core scripts with `defer` in this HTML order:
 *
 *   <script defer src="home-screen.js?v=1"></script>
 *   <script defer src="nearby.js?v=1"></script>
 *   <script defer src="app.js?v=1039"></script>
 *
 * `defer` runs scripts in document order, so `home-screen.js` initialises
 * BEFORE `app.js` had a chance to assign `window.API_BASE`. Until HC27,
 * four early painters in `home-screen.js` (rewards / badge / version /
 * recent-reports) and one in `device-telemetry.js` captured a module-
 * scoped `apiBase = window.API_BASE || '/api/v1'`. The undefined check
 * routed all of them to the bare relative `/api/v1`, which the browser
 * anchored to the current origin (`http://localhost:8080`). The
 * Python `SimpleHTTP/0.6` static server has no `/api/v1` mount, so
 * each fetch returned 404. The May 23 HAR (`api-log-1.har`) showed
 * 124 such 404s in 2.7 minutes — across `/health`,
 * `/reports/profile/{hash}`, `/reports/device/{hash}/status-since`,
 * and `/devices/telemetry`.
 *
 * HC27 fix: a synchronous head-inline IIFE in `index.html` sets
 * `window.API_BASE` from `window.location` BEFORE any `defer` script
 * parses (mirrors the `__crispBootLang` i18n pattern). All five
 * relative-fallback call sites in `home-screen.js` were tightened to
 * REQUIRE `window.API_BASE` and bail rather than silently fall back.
 * `device-telemetry.js`'s `ENDPOINT` constant was refactored into a
 * runtime `_endpoint()` helper that reads `window.API_BASE` lazily.
 *
 * This spec pins both invariants:
 *  1. `window.API_BASE` is the absolute backend URL at `domcontentloaded`.
 *  2. No PWA fetch lands on `:8080/api/v1/*` within 3 s of load.
 */
import { test, expect } from '@playwright/test';

test.describe('PWA — HC27 API_BASE frame-zero invariants', () => {
    test('@smoke window.API_BASE resolves to absolute backend URL at DCL', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
        });
        await page.goto('index.html');
        await page.waitForLoadState('domcontentloaded');
        const apiBase = await page.evaluate(() => (window as any).API_BASE);
        // Absolute http(s)://hostname:port/api/v1 form — never the
        // bare '/api/v1' relative fallback.
        expect(apiBase, `API_BASE must be absolute at frame 0`).toMatch(/^https?:\/\/[^/]+(:\d+)?\/api\/v1$/);
    });

    test('@smoke no PWA fetch hits :8080/api/v1/* within 3 s of load', async ({ page }) => {
        const badUrls: string[] = [];
        page.on('request', (req) => {
            const u = req.url();
            // The pre-HC27 bug: any /api/v1/... fetch landing on
            // :8080 (the static dev server) instead of :8000 (backend).
            if (/^https?:\/\/[^/]*:8080\/api\/v1\//.test(u)) badUrls.push(u);
        });
        await page.addInitScript(() => {
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
        });
        await page.goto('index.html');
        await page.waitForLoadState('domcontentloaded');
        // Give the home painters (rewards, badge, version, recent
        // reports) + the telemetry BOOT_DELAY (1200 ms) plenty of
        // time to fire any racy fetches.
        await page.waitForTimeout(3000);
        expect(
            badUrls,
            `no fetch should land on :8080/api/v1/* — observed ${badUrls.length}: ${JSON.stringify(badUrls.slice(0, 5))}`
        ).toEqual([]);
    });
});
