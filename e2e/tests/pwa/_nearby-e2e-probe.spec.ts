/**
 * End-to-end probe that ACTUALLY exercises the home stage as a user
 * would see it — no test-only seeds for localStorage, no skipped
 * stages. This is the verification I should have done before asking
 * for deploy approval.
 *
 * Tests three scenarios that match the operator's real machine:
 *   1. Fresh visitor, GPS DENIED (the realistic localhost case where
 *      the user dismisses the browser prompt).
 *   2. Fresh visitor, GPS granted with seeded coords (the success
 *      path the operator should see).
 *   3. Returning visitor, localStorage pre-populated (the cache-hit
 *      path).
 *
 * For each: capture localStorage, the dispatched events, and whether
 * the nearby module's `[hidden]` attribute is removed. The test
 * RUNS the actual app code with no fakes beyond geolocation
 * permission.
 *
 * One-off probe. Delete after the fix is verified.
 */
import { test, expect } from '@playwright/test';

/**
 * Stub the backend's /reports/nearby endpoint with realistic data
 * matching the PROD response shape. This lets us verify the JS path
 * (cache → event → re-boot → fetch → render → unhide) without
 * needing a live backend.
 */
async function stubNearby(page, groups) {
    await page.route(/\/api\/v1\/reports\/nearby/, (route) => {
        route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                user_location: { lat: 12.846, lng: 77.66 },
                radius_km: 5.0,
                as_of: new Date().toISOString(),
                groups,
            }),
        });
    });
}

const SAMPLE_GROUP = {
    id: 'g_building_test',
    kind: 'building',
    label: 'SNN Raj Greenbay',
    summary: 'Flooded',
    summary_key: 'nearby_summary_flood_partial',
    count: 8,
    verified_count: 0,
    pending_count: 15,
    approx_distance_km: 2.22,
    centroid_lat: 12.8526,
    centroid_lng: 77.6793,
    latest_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    earliest_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    crisis_types: ['FLOOD'],
    damage_classes: ['PARTIAL'],
    severity_max: 'MODERATE',
};

async function captureState(page) {
    return await page.evaluate(() => {
        const root = document.querySelector('#home-nearby-intel') as HTMLElement | null;
        return {
            cachedLoc: localStorage.getItem('crisp_last_location_v2'),
            locCtx: localStorage.getItem('crisp_loc_ctx'),
            deviceGps: localStorage.getItem('crisp_device_gps'),
            nearbyHidden: root?.hasAttribute('hidden'),
            nearbyDisplay: root ? getComputedStyle(root).display : null,
            nearbyChildCount: root ? root.children.length : 0,
            eventsFired: (window as any).__crispLocationEvents || [],
        };
    });
}

async function instrumentEvents(page) {
    await page.addInitScript(() => {
        (window as any).__crispLocationEvents = [];
        document.addEventListener('crisp:location-cached', (e: any) => {
            (window as any).__crispLocationEvents.push({
                t: Math.round(performance.now()),
                detail: e.detail,
            });
        });
    });
}

test('SCENARIO 1: GPS denied + NO backend — module should show empty state, not silent-hide', async ({ page, context }) => {
    // Deny geolocation permission at the browser level.
    await context.grantPermissions([]);  // no permissions = denial when asked
    await page.addInitScript(() => {
        // @ts-ignore
        navigator.geolocation = {
            getCurrentPosition: (_ok: any, err: any) => {
                err && err({ code: 1, message: 'User denied geolocation' });
            },
            watchPosition: () => 0,
            clearWatch: () => {},
        };
    });
    // Deliberately NO stubNearby — let the fetch fail (404 from static
    // server) to validate the "show empty state on failure" change.
    await instrumentEvents(page);

    await page.goto('index.html');
    // Wait long enough for the IP-geo cascade (3 tiers × 6 s timeout each
    // in worst case ≈ 18 s, but typically resolves in 1-2 s).
    await page.waitForTimeout(12000);

    const state = await captureState(page);
    console.log('\n=== SCENARIO 1: GPS denied ===');
    console.log('cachedLoc:', state.cachedLoc);
    console.log('deviceGps:', state.deviceGps);
    console.log('nearbyHidden:', state.nearbyHidden, '   display:', state.nearbyDisplay);
    console.log('nearbyChildCount:', state.nearbyChildCount);
    console.log('crisp:location-cached events fired:', state.eventsFired.length);
    state.eventsFired.forEach((e: any, i: number) => {
        console.log(`  [${i}] t=${e.t}ms  detail=${JSON.stringify(e.detail)}`);
    });

    // Post-fix invariant: even when the fetch fails, the module should
    // be visible with the empty-state message, NOT silent-hidden.
    expect(state.nearbyHidden, 'module should be visible (empty state) even when fetch fails — operator preference').toBe(false);
});

test('SCENARIO 2: GPS granted with seeded coords (Bangalore test point)', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 12.846, longitude: 77.660 });
    await stubNearby(page, [SAMPLE_GROUP]);
    await instrumentEvents(page);

    await page.goto('index.html');
    await page.waitForTimeout(6000);

    const state = await captureState(page);
    console.log('\n=== SCENARIO 2: GPS granted (Bangalore) ===');
    console.log('cachedLoc:', state.cachedLoc);
    console.log('deviceGps:', state.deviceGps);
    console.log('nearbyHidden:', state.nearbyHidden, '   display:', state.nearbyDisplay);
    console.log('nearbyChildCount:', state.nearbyChildCount);
    console.log('crisp:location-cached events fired:', state.eventsFired.length);
    state.eventsFired.forEach((e: any, i: number) => {
        console.log(`  [${i}] t=${e.t}ms  detail=${JSON.stringify(e.detail)}`);
    });

    // The key user-visible assertion: with GPS granted, nearby module
    // must NOT be `[hidden]` at the end of the wait window.
    expect(state.nearbyHidden, 'nearby module should be visible when GPS resolves').toBe(false);
});

test('SCENARIO 3: returning visitor with pre-cached coords', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_last_location_v2', JSON.stringify({
            lat: 12.846, lng: 77.660, ts: Date.now(),
        }));
    });
    await stubNearby(page, [SAMPLE_GROUP]);
    await instrumentEvents(page);

    await page.goto('index.html');
    await page.waitForTimeout(4000);

    const state = await captureState(page);
    console.log('\n=== SCENARIO 3: returning visitor (pre-cached) ===');
    console.log('cachedLoc present:', !!state.cachedLoc);
    console.log('nearbyHidden:', state.nearbyHidden, '   display:', state.nearbyDisplay);
    console.log('nearbyChildCount:', state.nearbyChildCount);
    console.log('crisp:location-cached events fired:', state.eventsFired.length);

    // Pre-cached path should make nearby visible WITHOUT needing the event.
    expect(state.nearbyHidden, 'pre-cached visitor should see nearby immediately').toBe(false);
});
