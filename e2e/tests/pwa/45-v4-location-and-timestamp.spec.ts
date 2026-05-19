/**
 * PWA v4 — Location suggestions + three-line timestamp regression guards (May 2026).
 *
 * Two operator-reported bugs locked down here:
 *
 *   1. Location suggestion field showed NO results for queries outside
 *      the bundled 700-city set (e.g. "Dudhwa National Park"). Root
 *      cause: v4-flow.js input handler only called placeSearch.search()
 *      (offline-only); never wired placeSearch.searchRemote() to hit
 *      Nominatim. Fix is a debounced remote enrichment + merge.
 *
 *   2. Timestamp footer read like "2026-05-12 22:39:35 GMT+5:30" —
 *      buried timezone label + local clock behind a numeric offset
 *      that operators don't recognise at a glance. Fix is three
 *      stacked lines: IANA timezone name / human-readable label /
 *      local 12-hour clock.
 *
 * Specs drive the v4 flow with placeSearch + Nominatim mocked, so the
 * test runs fast and offline. No live Nominatim dependency.
 */
import { test, expect, Page } from '@playwright/test';

async function bootV4Pwa(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function',
        null, { timeout: 8000 },
    );
    // Patch placeSearch.searchRemote with a deterministic stub. We
    // can't rely on page.route() intercepting the Nominatim fetch
    // because the PWA's service worker takes priority on cached
    // responses and Playwright's network layer doesn't see SW-
    // intercepted requests. Patching the helper directly is the
    // robust way to test the merge + render logic without depending
    // on either the network OR the SW state.
    await page.evaluate(() => {
        const ps = (window as any).placeSearch;
        if (!ps) return;
        (ps as any).searchRemote = (query: string, callback: (results: any[]) => void) => {
            if (/dudhwa/i.test(query)) {
                callback([
                    { name: 'Dudhwa National Park', region: 'Uttar Pradesh', country: 'India', lat: 28.5167, lng: 80.7167 },
                    { name: 'Dudhwa Tiger Reserve', region: 'Uttar Pradesh', country: 'India', lat: 28.5500, lng: 80.7500 },
                ]);
            } else {
                callback([]);
            }
        };
    });
}

test.describe('PWA v4 — location suggestions (Nominatim fallback)', () => {
    test.beforeEach(async ({ page }) => { await bootV4Pwa(page); });

    test('typing a non-bundled query shows Nominatim results via searchRemote', async ({ page }) => {
        // Navigate to capture stage where the location editor lives.
        await page.evaluate(() => {
            const fn = (window as any).__crispGoToStage;
            if (typeof fn === 'function') fn('stage-v4-capture');
        });
        await expect(page.locator('#stage-v4-capture.active')).toBeVisible({ timeout: 5000 });
        // Open the location editor.
        await page.locator('#btn-v4-loc-edit').click();
        await expect(page.locator('#v4-meta-loc-edit')).toBeVisible();

        // Type a query that's NOT in the bundled 700-city list.
        await page.locator('#v4-meta-loc-input').fill('Dudhwa Nat');

        // Debounce is 350ms; allow ~700ms for the mocked Nominatim
        // round-trip to land + render.
        await page.waitForTimeout(700);

        // The suggestion list must render at least one item.
        const items = page.locator('#v4-meta-loc-suggest .v4-meta-loc-suggest-item');
        await expect(items.first(), 'remote results should render').toBeVisible({ timeout: 4000 });
        const count = await items.count();
        expect(count, 'at least 1 Nominatim result should appear').toBeGreaterThanOrEqual(1);

        // The first item should be "Dudhwa National Park" (Nominatim's first hit).
        await expect(items.first().locator('.v4-meta-loc-suggest-name'))
            .toContainText(/Dudhwa/);
    });

    test('clicking a remote suggestion stages lat/lng on save', async ({ page }) => {
        await page.evaluate(() => {
            const fn = (window as any).__crispGoToStage;
            if (typeof fn === 'function') fn('stage-v4-capture');
        });
        await expect(page.locator('#stage-v4-capture.active')).toBeVisible({ timeout: 5000 });
        await page.locator('#btn-v4-loc-edit').click();
        await page.locator('#v4-meta-loc-input').fill('Dudhwa Nat');
        await page.waitForTimeout(700);

        const firstItem = page.locator('#v4-meta-loc-suggest .v4-meta-loc-suggest-item').first();
        await expect(firstItem).toBeVisible({ timeout: 4000 });
        // Pointerdown matches the production code path (v4-flow.js:267).
        await firstItem.dispatchEvent('pointerdown');
        await page.locator('#btn-v4-loc-save').click();

        const stateAfter = await page.evaluate(() => {
            const s = (window as any).state;
            return {
                locationName: s.locationName,
                lat: s.location && s.location.lat,
                lng: s.location && s.location.lng,
                source: s.location && s.location.source,
            };
        });
        expect(stateAfter.locationName, 'locationName saved').toMatch(/Dudhwa/);
        expect(Number.isFinite(stateAfter.lat), 'lat is finite').toBe(true);
        expect(Number.isFinite(stateAfter.lng), 'lng is finite').toBe(true);
        expect(stateAfter.source, 'source marked user-corrected').toBe('user_corrected');
    });

    test('offline mode shows the offline hint and skips Nominatim', async ({ page, context }) => {
        await page.evaluate(() => {
            const fn = (window as any).__crispGoToStage;
            if (typeof fn === 'function') fn('stage-v4-capture');
        });
        await expect(page.locator('#stage-v4-capture.active')).toBeVisible({ timeout: 5000 });
        await page.locator('#btn-v4-loc-edit').click();

        // Force navigator.onLine = false so the input handler takes
        // the offline branch + skips the remote fetch.
        await context.setOffline(true);
        await page.evaluate(() => {
            // The setOffline above flips navigator.onLine but we also
            // need to dispatch the event so any listeners (if added
            // later) react. Belt and suspenders.
            window.dispatchEvent(new Event('offline'));
        });

        await page.locator('#v4-meta-loc-input').fill('Dudhwa Nat');
        await page.waitForTimeout(500);

        // Should show the offline hint, NOT remote suggestions.
        const hint = page.locator('#v4-meta-loc-suggest .v4-meta-loc-suggest-hint-offline');
        await expect(hint).toBeVisible({ timeout: 2000 });
    });

    test('bundled-city query still works instantly without network', async ({ page }) => {
        await page.evaluate(() => {
            const fn = (window as any).__crispGoToStage;
            if (typeof fn === 'function') fn('stage-v4-capture');
        });
        await expect(page.locator('#stage-v4-capture.active')).toBeVisible({ timeout: 5000 });
        await page.locator('#btn-v4-loc-edit').click();

        // "Bangalore" / "Mumbai" / "Delhi" / "Nairobi" — one of the
        // bundled major cities. Renders locally with no network round-
        // trip needed.
        await page.locator('#v4-meta-loc-input').fill('Bangalore');
        // Local hit is INSTANT (no debounce), so 250ms is plenty.
        await page.waitForTimeout(250);

        const items = page.locator('#v4-meta-loc-suggest .v4-meta-loc-suggest-item');
        await expect(items.first(), 'bundled city result renders instantly').toBeVisible();
    });
});

test.describe('PWA v4 — three-line timestamp footer', () => {
    test.beforeEach(async ({ page }) => { await bootV4Pwa(page); });

    test('renders IANA + human label + 12-hour clock (not GMT±NN)', async ({ page }) => {
        await page.evaluate(() => {
            const fn = (window as any).__crispGoToStage;
            if (typeof fn === 'function') fn('stage-v4-capture');
        });
        await expect(page.locator('#stage-v4-capture.active')).toBeVisible({ timeout: 5000 });

        // Wait for _paintCaptureTimestamp's first paint (it runs on
        // 'stage-entered' for the v4-capture stage).
        await page.waitForFunction(() => {
            const elIana  = document.getElementById('v4-meta-time-tz-iana');
            const elLabel = document.getElementById('v4-meta-time-tz-label');
            const elClock = document.getElementById('v4-meta-time-text');
            return elIana && elLabel && elClock &&
                   elIana.textContent && elIana.textContent !== '—' &&
                   elLabel.textContent && elLabel.textContent !== '—' &&
                   elClock.textContent && elClock.textContent !== '—';
        }, null, { timeout: 4000 });

        const snapshot = await page.evaluate(() => ({
            iana:  document.getElementById('v4-meta-time-tz-iana')!.textContent,
            label: document.getElementById('v4-meta-time-tz-label')!.textContent,
            clock: document.getElementById('v4-meta-time-text')!.textContent,
        }));

        // IANA names look like "Continent/City" or "UTC+HH:MM" fallback.
        expect(snapshot.iana, 'IANA name format').toMatch(/^([A-Z][a-z]+\/[A-Z][A-Za-z_]+|UTC[+-]\d{2}:\d{2})$/);

        // Human label must be non-empty + must not just be the offset
        // string (that was the pre-fix output). At minimum 5 chars
        // ("Time" / "UTC" / etc.).
        expect(snapshot.label!.length, 'human label non-trivial').toBeGreaterThan(4);

        // 12-hour clock pattern: "H:MM AM" or "HH:MM PM" (locale-
        // dependent; en-* uses these forms).
        expect(snapshot.clock, '12-hour clock format').toMatch(/^\d{1,2}:\d{2}\s?(AM|PM|am|pm)$/);

        // Critically: the clock slot must NOT be the old date-time-tz
        // single-line ("2026-05-12 22:39:35 GMT+5:30"). If it contains
        // a "GMT" or a hyphen in a date prefix, the old painter is
        // still running.
        expect(snapshot.clock, 'no GMT prefix (legacy single-line)').not.toMatch(/GMT/);
        expect(snapshot.clock, 'no YYYY-MM-DD prefix').not.toMatch(/^\d{4}-\d{2}-\d{2}/);
    });
});
