/**
 * HC55 (May 2026) — PWA reverse-geocoding network contract.
 *
 * Pre-HC55 the PWA called `https://nominatim.openstreetmap.org/reverse`
 * directly from the browser (3 inline call sites in `app.js`). The
 * operator's 2026-05-24 HAR captured HTTP 429 responses from
 * Nominatim's CDN edge during a "Refresh GPS" tap — so the location
 * pill fell back to raw lat/lng instead of "Koramangala, Bengaluru".
 *
 * HC55 fix: the user-facing reverseGeocode() helper now POSTs lat/lng
 * to the backend's new `/api/v1/reports/geocode/reverse` route. The
 * backend handles Mapbox primary, rate-limited Nominatim fallback,
 * and 7-day persistent cache.
 *
 * This spec pins:
 *   1. The user-facing reverseGeocode() helper NEVER fires a fetch
 *      against `nominatim.openstreetmap.org` for the reverse path
 *      (boot-time language-detection sites are scoped out of HC55 —
 *      tracked separately in the codebase as inline TODOs).
 *   2. When reverseGeocode() is called, it issues a POST against
 *      `${API_BASE}/reports/geocode/reverse` with `{lat, lng, language}`.
 *   3. The response's `location_name` lands in the local cache so a
 *      repeat call within 24 h serves from localStorage (no network).
 *   4. The fallback response shape does NOT poison the local cache —
 *      a follow-up call retries the backend rather than serving the
 *      synthetic "lat°, lng°" name.
 */
import { test, expect } from '@playwright/test';

test.describe('PWA — HC55 reverse-geocode via backend cascade', () => {
    test('@smoke reverseGeocode() POSTs to backend, never hits nominatim.openstreetmap.org', async ({ page }) => {
        const nominatimHits: string[] = [];
        const backendHits: string[] = [];
        page.on('request', (req) => {
            const u = req.url();
            if (u.includes('nominatim.openstreetmap.org/reverse')) {
                nominatimHits.push(u);
            }
            if (u.includes('/api/v1/reports/geocode/reverse')) {
                backendHits.push(u);
            }
        });

        // Stub the backend route so the spec doesn't depend on the
        // live backend having a real Mapbox token.
        await page.route('**/api/v1/reports/geocode/reverse', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    location_name: 'Koramangala, Bengaluru',
                    confidence: 'high',
                    source: 'mapbox',
                    latitude: 12.852765,
                    longitude: 77.679423,
                }),
            });
        });

        await page.addInitScript(() => {
            localStorage.setItem(
                'crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }),
            );
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_lang_manual', 'en');
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.startsWith('crisp_geo:')) localStorage.removeItem(k);
            }
        });
        await page.goto('index.html');
        await page.waitForLoadState('domcontentloaded');

        // Drive the helper directly — it's defined at module scope in
        // app.js so it's reachable on window once the script parses.
        const result = await page.evaluate(async () => {
            const r = (window as any).reverseGeocode;
            if (typeof r !== 'function') return null;
            return r(12.852765, 77.679423);
        });

        expect(result, 'reverseGeocode should return the backend location_name').toBe(
            'Koramangala, Bengaluru',
        );
        expect(
            nominatimHits,
            `reverseGeocode must NEVER hit nominatim.openstreetmap.org directly. Saw: ${JSON.stringify(nominatimHits)}`,
        ).toEqual([]);
        expect(backendHits.length, 'at least one backend hit').toBeGreaterThanOrEqual(1);
    });

    test('@smoke second call within 24h hits the local cache (no backend round-trip)', async ({ page }) => {
        let backendHitCount = 0;
        await page.route('**/api/v1/reports/geocode/reverse', async (route) => {
            backendHitCount++;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    location_name: 'Indiranagar, Bengaluru',
                    confidence: 'high',
                    source: 'mapbox',
                    latitude: 12.9716,
                    longitude: 77.6412,
                }),
            });
        });

        await page.addInitScript(() => {
            localStorage.setItem(
                'crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }),
            );
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_lang_manual', 'en');
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.startsWith('crisp_geo:')) localStorage.removeItem(k);
            }
        });
        await page.goto('index.html');
        await page.waitForLoadState('domcontentloaded');

        // The PWA's boot path fires its own reverseGeocode against
        // the Playwright-default geolocation (Bengaluru 12.9716, 77.5946)
        // BEFORE we drive the test, so the backend hit-counter is
        // non-zero when we start. We measure the DELTA across the two
        // explicit calls below.
        const baselineHits = backendHitCount;

        const first = await page.evaluate(() =>
            (window as any).reverseGeocode(12.9716, 77.6412),
        );
        const hitsAfterFirst = backendHitCount;
        const second = await page.evaluate(() =>
            (window as any).reverseGeocode(12.9716, 77.6412),
        );
        const hitsAfterSecond = backendHitCount;

        expect(first).toBe('Indiranagar, Bengaluru');
        expect(second).toBe('Indiranagar, Bengaluru');
        // First call → cache miss → backend hit (+1).
        expect(
            hitsAfterFirst - baselineHits,
            'first call should hit the backend exactly once',
        ).toBe(1);
        // Second call → cache hit → no backend hit (+0).
        expect(
            hitsAfterSecond - hitsAfterFirst,
            'second call should serve from the local cache (no network)',
        ).toBe(0);
    });

    test('@smoke fallback response shape does not poison the local cache', async ({ page }) => {
        let backendHitCount = 0;
        await page.route('**/api/v1/reports/geocode/reverse', async (route) => {
            backendHitCount++;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    location_name: '13.0000°, 77.0000°',
                    confidence: 'none',
                    source: 'fallback',
                    latitude: 13.0,
                    longitude: 77.0,
                }),
            });
        });

        await page.addInitScript(() => {
            localStorage.setItem(
                'crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }),
            );
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_lang_manual', 'en');
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.startsWith('crisp_geo:')) localStorage.removeItem(k);
            }
        });
        await page.goto('index.html');
        await page.waitForLoadState('domcontentloaded');

        // Measure DELTA across the explicit test calls — the PWA boot
        // path will have already fired its own reverseGeocode against
        // the Playwright-default geolocation (Bengaluru), incrementing
        // the counter before we get here.
        const baselineHits = backendHitCount;

        const first = await page.evaluate(() =>
            (window as any).reverseGeocode(13.0, 77.0),
        );
        const hitsAfterFirst = backendHitCount;
        const second = await page.evaluate(() =>
            (window as any).reverseGeocode(13.0, 77.0),
        );
        const hitsAfterSecond = backendHitCount;

        // Fallback resolves to `null` at the JS API surface so the
        // caller falls back to raw coords (existing UX). BOTH explicit
        // calls hit the backend because the fallback shape is never
        // cached.
        expect(first).toBeNull();
        expect(second).toBeNull();
        expect(
            hitsAfterFirst - baselineHits,
            'first call should hit the backend exactly once',
        ).toBe(1);
        expect(
            hitsAfterSecond - hitsAfterFirst,
            'second call must ALSO hit the backend — fallback shape isn\'t cached',
        ).toBe(1);
    });
});
