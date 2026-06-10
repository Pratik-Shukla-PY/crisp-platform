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
 *      that operators don't recognise at a glance. Fixed first as
 *      three stacked lines; then two product revisions landed:
 *        • AUDIT 2026-05-23 — the IANA line ("Asia/Kolkata") is
 *          technical noise for citizen reporters, so it paints ONLY
 *          when localStorage.crisp_tech_user === 'on' (blank
 *          otherwise).
 *        • HC60 (May 2026) — the visible time is now a single inline
 *          sub-row under the location name ("±35 m · 2:17 PM");
 *          #v4-meta-time-tz-iana / -label survive as hidden shims
 *          that _paintCaptureTimestamp keeps writing to.
 *      The spec asserts the current contract: human tz label +
 *      12-hour clock always painted (never the legacy GMT±NN
 *      single-liner), IANA gated behind tech mode.
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
        // Pin English so copy assertions don't vary with geo-locale.
        localStorage.setItem('crisp_lang_manual', 'en');
        localStorage.setItem('crisp_lang', 'en');
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

test.describe('PWA v4 — capture timestamp (inline clock + tz shims)', () => {
    test.beforeEach(async ({ page }) => { await bootV4Pwa(page); });

    test('paints human tz label + 12-hour clock; IANA only in tech mode (not GMT±NN)', async ({ page }) => {
        await page.evaluate(() => {
            const fn = (window as any).__crispGoToStage;
            if (typeof fn === 'function') fn('stage-v4-capture');
        });
        await expect(page.locator('#stage-v4-capture.active')).toBeVisible({ timeout: 5000 });

        // Wait for _paintCaptureTimestamp's first paint (it runs on
        // 'stage-entered' for the v4-capture stage, then every 1s).
        // Citizen mode (no crisp_tech_user) intentionally leaves the
        // IANA shim BLANK (AUDIT 2026-05-23), so only the label +
        // clock slots are guaranteed to fill.
        await page.waitForFunction(() => {
            const elLabel = document.getElementById('v4-meta-time-tz-label');
            const elClock = document.getElementById('v4-meta-time-text');
            return !!(elLabel && elClock &&
                   elLabel.textContent && elLabel.textContent !== '—' &&
                   elClock.textContent && elClock.textContent !== '—');
        }, null, { timeout: 10000 });

        const snapshot = await page.evaluate(() => ({
            iana:  document.getElementById('v4-meta-time-tz-iana')!.textContent,
            label: document.getElementById('v4-meta-time-tz-label')!.textContent,
            clock: document.getElementById('v4-meta-time-text')!.textContent,
        }));

        // Citizen default: the IANA slot is deliberately blanked by
        // the painter — "Asia/Kolkata" is operator forensics, noise
        // for a first-time reporter.
        expect(snapshot.iana, 'IANA blank for citizen reporters').toBe('');

        // Human label must be non-empty + must not just be the offset
        // string (that was the pre-fix output). At minimum 5 chars
        // ("Time" / "UTC" / etc.).
        expect(snapshot.label!.length, 'human label non-trivial').toBeGreaterThan(4);
        expect(snapshot.label, 'label not a bare GMT offset').not.toMatch(/^GMT[+-]/);

        // 12-hour clock pattern: "H:MM AM" or "HH:MM PM" (locale-
        // dependent; en-* uses these forms — \s also matches the
        // U+202F narrow space newer ICU inserts before AM/PM).
        expect(snapshot.clock, '12-hour clock format').toMatch(/^\d{1,2}:\d{2}\s?(AM|PM|am|pm)$/);

        // Critically: the clock slot must NOT be the old date-time-tz
        // single-line ("2026-05-12 22:39:35 GMT+5:30"). If it contains
        // a "GMT" or a hyphen in a date prefix, the old painter is
        // still running.
        expect(snapshot.clock, 'no GMT prefix (legacy single-line)').not.toMatch(/GMT/);
        expect(snapshot.clock, 'no YYYY-MM-DD prefix').not.toMatch(/^\d{4}-\d{2}-\d{2}/);

        // HC60 layout contract: the visible clock renders inline in
        // the location sub-row; the verbose tz spans stay hidden shims.
        await expect(page.locator('#v4-meta-loc-sub #v4-meta-time-text'),
            'clock visible inline in the loc sub-row').toBeVisible();
        await expect(page.locator('#v4-meta-time-tz-iana'),
            'IANA shim stays hidden').toBeHidden();
        await expect(page.locator('#v4-meta-time-tz-label'),
            'label shim stays hidden').toBeHidden();

        // Tech mode: flipping crisp_tech_user on is picked up by the
        // 1-second repaint interval — the IANA slot must then fill
        // with a canonical zone name (or the UTC±HH:MM fallback).
        await page.evaluate(() => localStorage.setItem('crisp_tech_user', 'on'));
        await page.waitForFunction(() => {
            const el = document.getElementById('v4-meta-time-tz-iana');
            return !!(el && el.textContent && el.textContent !== '—');
        }, null, { timeout: 5000 });
        const ianaTech = await page.evaluate(
            () => document.getElementById('v4-meta-time-tz-iana')!.textContent);
        expect(ianaTech, 'IANA name format in tech mode')
            .toMatch(/^([A-Z][a-z]+\/[A-Z][A-Za-z_]+|UTC[+-]\d{2}:\d{2})$/);
    });
});
