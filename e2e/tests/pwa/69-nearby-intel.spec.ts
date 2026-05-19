/**
 * PWA — "Verified Reports Nearby" intelligence module (May 2026).
 *
 * Pins the 5 essential behaviours from the design plan:
 *
 *   ① online + GPS + fixture → block renders with rows
 *   ② offline → block HIDDEN, no errors
 *   ③ online + GPS + empty 200 → "All clear" empty state
 *   ④ cached fresh + offline → renders cached + "Last seen X" caption
 *   ⑤ row tap dispatches `crisp:nearby-row-click` event
 *
 * Phase 2 additions (RTL + reduced-motion + bottom-sheet detail
 * modal) go into spec 69b in a follow-up commit.
 */
import { test, expect, Page } from '@playwright/test';

const CACHED_LAT = 12.972;
const CACHED_LNG = 77.594;

const FIXTURE_PAYLOAD = {
    user_location: { lat: CACHED_LAT, lng: CACHED_LNG },
    radius_km: 5,
    as_of: new Date().toISOString(),
    groups: [
        {
            id: 'g_building_osm:way:1',
            kind: 'building',
            label: 'Green Valley Apartments',
            summary: 'Flooded',
            summary_key: 'nearby_summary_flood_partial',
            count: 12,
            verified_count: 8,
            pending_count: 4,
            approx_distance_km: 0.4,
            centroid_lat: 12.972, centroid_lng: 77.595,
            latest_at: new Date(Date.now() - 5 * 60_000).toISOString(),
            earliest_at: new Date(Date.now() - 60 * 60_000).toISOString(),
            crisis_types: ['FLOOD'],
            damage_classes: ['PARTIAL'],
            severity_max: 'HIGH',
        },
        {
            id: 'g_building_osm:way:2',
            kind: 'building',
            label: 'MG Road area',
            summary: 'Damaged',
            summary_key: 'nearby_summary_quake_partial',
            count: 5,
            verified_count: 5,
            pending_count: 0,
            approx_distance_km: 1.2,
            centroid_lat: 12.974, centroid_lng: 77.596,
            latest_at: new Date(Date.now() - 18 * 60_000).toISOString(),
            earliest_at: new Date(Date.now() - 30 * 60_000).toISOString(),
            crisis_types: ['EARTHQUAKE'],
            damage_classes: ['PARTIAL'],
            severity_max: 'MODERATE',
        },
        {
            id: 'g_building_osm:way:3',
            kind: 'building',
            label: 'Sector 7',
            summary: 'Fire Spreading',
            summary_key: 'nearby_summary_fire_partial',
            count: 3,
            verified_count: 0,
            pending_count: 3,
            approx_distance_km: 2.1,
            centroid_lat: 12.978, centroid_lng: 77.598,
            latest_at: new Date(Date.now() - 60 * 60_000).toISOString(),
            earliest_at: new Date(Date.now() - 120 * 60_000).toISOString(),
            crisis_types: ['WILDFIRE'],
            damage_classes: ['PARTIAL'],
            severity_max: 'HIGH',
        },
    ],
    total_groups: 3,
    total_reports: 20,
};

async function bootHome(page: Page, fixture: any | 'empty' | 'error') {
    await page.addInitScript(([lat, lng, fixt]: any) => {
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
        // Seed cached GPS so nearby.js has something to send.
        localStorage.setItem('crisp_last_location_v2', JSON.stringify({
            lat, lng, ts: Date.now(),
        }));
        // Stash the fixture for the fetch interceptor below.
        (window as any).__nearbyFixture = fixt;
    }, [CACHED_LAT, CACHED_LNG, fixture]);

    // Intercept /nearby calls and return the chosen fixture.
    await page.route('**/api/v1/reports/nearby*', async (route) => {
        const stash = await page.evaluate(() => (window as any).__nearbyFixture);
        if (stash === 'error') {
            return route.fulfill({ status: 503, body: 'down' });
        }
        if (stash === 'empty') {
            return route.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    ...FIXTURE_PAYLOAD,
                    groups: [], total_groups: 0, total_reports: 0,
                }),
            });
        }
        return route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(stash),
        });
    });

    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
}

// `.home-nearby-row` not found. Per the v6.8 DOM map the row class
// still ships (rendered by nearby.js:291), so the failure is a
// fixture/setup issue — likely the nearby module's seed-on-boot
// pathway isn't engaging in the test environment OR the home stage
// isn't reached in a state where the nearby section is populated.
// Each of the 10 tests needs per-test investigation against the
// new v6.8 home stage rendering. Deferred to a focused triage
// session in 69a-nearby-intel-v6.8-rewrite.spec.ts.
//
// The nearby intel FEATURE works in operator-smoke against PROD
// (verified PWA captures still show the "Verified Nearby Incidents"
// chip on home). Only the e2e fixture path is broken.
test.describe('PWA — "Verified Reports Nearby" intel module', () => {

    test('@smoke online + GPS + fixture → block renders with rows', async ({ page }) => {
        await bootHome(page, FIXTURE_PAYLOAD);
        const block = page.locator('#home-nearby-intel');
        await expect(block).toBeVisible();
        // Eyebrow text
        const eyebrow = block.locator('.home-nearby-eyebrow');
        await expect(eyebrow).toBeVisible();
        // 3 rows in collapsed view
        const rows = block.locator('.home-nearby-row');
        await expect(rows).toHaveCount(3);
    });

    test('offline → block HIDDEN, no errors', async ({ page, context }) => {
        // Phase F triage (May 2026) — pre-fix `setOffline(true)` ran
        // BEFORE `bootHome` whose `page.goto` then failed with
        // ERR_INTERNET_DISCONNECTED (Playwright's offline mode blocks
        // ALL navigations, not just /api calls). Boot online, THEN
        // flip offline + reload so the PWA loads from SW cache + the
        // /nearby fetch correctly fails. Block stays hidden because
        // nearby.js's catch-path sets root.hidden=true on fetch error.
        await bootHome(page, FIXTURE_PAYLOAD);
        await context.setOffline(true);
        await page.reload();
        const block = page.locator('#home-nearby-intel');
        // Hidden via [hidden] attribute (CSS display:none)
        await expect(block).toBeHidden();
    });

    test('online + empty 200 → "All clear" empty state', async ({ page }) => {
        await bootHome(page, 'empty');
        const block = page.locator('#home-nearby-intel');
        await expect(block).toBeVisible();
        const empty = block.locator('.home-nearby-empty');
        await expect(empty).toBeVisible();
        const title = (await empty.locator('.home-nearby-empty-title').textContent() || '').toLowerCase();
        expect(title).toMatch(/all clear|all-clear/);
    });

    test('online + 503 API error → block HIDDEN (silent fail)', async ({ page }) => {
        await bootHome(page, 'error');
        const block = page.locator('#home-nearby-intel');
        await expect(block).toBeHidden();
    });

    test('row tap dispatches crisp:nearby-row-click event', async ({ page }) => {
        await bootHome(page, FIXTURE_PAYLOAD);
        const row1 = page.locator('.home-nearby-row').first();
        await expect(row1).toBeVisible();

        // Listen for the custom event before tapping.
        await page.evaluate(() => {
            (window as any).__lastEvent = null;
            window.addEventListener('crisp:nearby-row-click', (e: any) => {
                (window as any).__lastEvent = e.detail;
            });
        });
        await row1.click();
        const detail = await page.evaluate(() => (window as any).__lastEvent);
        expect(detail).toBeTruthy();
        expect(typeof detail.groupId).toBe('string');
    });

    // ── Phase 2 — bottom-sheet detail modal ──────────────────────

    test('row tap opens the bottom-sheet detail modal', async ({ page }) => {
        await bootHome(page, FIXTURE_PAYLOAD);
        await page.locator('.home-nearby-row').first().click();
        const sheet = page.locator('#nearby-sheet');
        await expect(sheet).toBeVisible();
        // Title binds to the group label
        const title = await sheet.locator('#nearby-sheet-label').textContent();
        expect((title || '').toLowerCase()).toContain('green valley');
        // Count + verified tiles populated
        expect(await sheet.locator('#nearby-sheet-count').textContent()).toBe('12');
        expect(await sheet.locator('#nearby-sheet-verified').textContent()).toBe('8');
        // CTA button present
        await expect(sheet.locator('#nearby-sheet-cta')).toBeVisible();
    });

    test('detail sheet dismisses via close button + backdrop + Escape', async ({ page }) => {
        await bootHome(page, FIXTURE_PAYLOAD);
        const sheet = page.locator('#nearby-sheet');

        // Open via row, close via ✕
        await page.locator('.home-nearby-row').first().click();
        await expect(sheet).toBeVisible();
        await page.locator('#nearby-sheet-close').click();
        await page.waitForTimeout(300);    // wait for transition
        await expect(sheet).toBeHidden();

        // Open again, close via backdrop click
        await page.locator('.home-nearby-row').first().click();
        await expect(sheet).toBeVisible();
        await page.locator('#nearby-sheet-backdrop').click();
        await page.waitForTimeout(300);
        await expect(sheet).toBeHidden();

        // Open again, close via Escape
        await page.locator('.home-nearby-row').first().click();
        await expect(sheet).toBeVisible();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await expect(sheet).toBeHidden();
    });

    test('detail sheet body contains no PII tokens', async ({ page }) => {
        // Privacy invariant — the sheet must not surface device_id /
        // user_id / description / per-report ids. Project this here
        // (the backend already does at the schema; this guards the
        // client never adding back).
        await bootHome(page, FIXTURE_PAYLOAD);
        await page.locator('.home-nearby-row').first().click();
        const sheet = page.locator('#nearby-sheet');
        await expect(sheet).toBeVisible();
        const sheetText = (await sheet.textContent() || '').toLowerCase();
        const FORBIDDEN = ['device_id', 'user_id', 'reporter_badge', 'reviewer_verdict'];
        for (const tok of FORBIDDEN) {
            expect(sheetText.includes(tok), `Privacy leak: '${tok}' in sheet`).toBe(false);
        }
    });

    test('RTL — module mirrors row layout under dir="rtl"', async ({ page }) => {
        await bootHome(page, FIXTURE_PAYLOAD);
        // Force RTL via the html dir attribute (Arabic locales do
        // this on lang switch; we apply it directly here).
        await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
        const row1 = page.locator('.home-nearby-row').first();
        await expect(row1).toBeVisible();
        const flexDir = await row1.evaluate((el) =>
            getComputedStyle(el as HTMLElement).flexDirection,
        );
        expect(flexDir).toBe('row-reverse');
    });

    test('reduced-motion — sheet slide animation is disabled', async ({ page, context }) => {
        await context.emulateMedia({ reducedMotion: 'reduce' });
        await bootHome(page, FIXTURE_PAYLOAD);
        await page.locator('.home-nearby-row').first().click();
        const sheet = page.locator('#nearby-sheet');
        await expect(sheet).toBeVisible();
        // Card transition-duration should be reduced/none in
        // reduced-motion mode.
        const cardTransition = await sheet.locator('.nearby-sheet-card').evaluate((el) =>
            getComputedStyle(el as HTMLElement).transitionDuration,
        );
        // Browser may report "0s" or "none" or "0s, 0s" depending on
        // engine. Accept any zero-ish form.
        expect(cardTransition).toMatch(/^0(s|ms)?$|^none$|^0(\.0)?s$/);
    });
});
