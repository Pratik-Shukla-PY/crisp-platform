/**
 * Dashboard — Leaflet map render smoke tests (Apr 2026 Phase 2.8).
 *
 * The dashboard's Leaflet map is the most-looked-at surface on first
 * paint; a regression that leaves it blank or missing markers means a
 * silent field-response outage. The existing 01-login-feed smoke only
 * covers the feed list. These three tests pin:
 *
 *   1. `#crisis-map` becomes visible + Leaflet bootstraps (at least one
 *      tile-layer `img` paints — guards against "map div exists but
 *      Leaflet import broke").
 *   2. The cluster group + layer switcher bootstrap — confirms both
 *      `L.markerClusterGroup` and the Dark/Satellite/Street control
 *      loaded. Lean check since those ship via separate <script> CDN
 *      tags that can 404 in isolation.
 *   3. Seeding a report with a `location` lands as a marker inside
 *      clusterGroup — the core data-flow contract from
 *      `fetchReports()` → `updateMapMarkers()` → `clusterGroup.addLayer`.
 *
 * Relies on the `window.__crispMap` / `window.__crispClusterGroup`
 * read-only debug hooks wired in the "Testability + debug hooks"
 * block at the bottom of web-dashboard/src/app.js. If those hooks
 * disappear this spec goes red first — which is the intended guard.
 *
 * Uses the same ADMIN fixture + loginAsAdmin pattern as the sibling
 * dashboard specs (see 03-reviewer-workflow.spec.ts).
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { ADMIN, cleanupTestReports } from '../helpers/api';

async function seedReport(
    request: APIRequestContext,
    token: string,
    deviceHash: string,
    lat = 12.97,
    lng = 77.59,
): Promise<string> {
    const res = await request.post('http://localhost:8000/api/v1/reports/meta', {
        headers: { Authorization: `Bearer ${token}` },
        data: {
            device_hash: deviceHash,
            client_report_id: `e2e-map-${Date.now()}`,
            source: 'APP',
            severity: 'SEVERE',
            infrastructure_type: 'ROAD',
            crisis_type: 'FLOOD',
            damage_classification: 'PARTIAL',
            description: 'E2E map-render test report',
            expected_media: 0,
            location: { latitude: lat, longitude: lng, accuracy_meters: 10 },
        },
    });
    expect(res.ok(), `seed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    return body.id;
}

async function loginAsAdmin(page, request: APIRequestContext): Promise<string> {
    const res = await request.post('http://localhost:8000/api/v1/auth/login', {
        data: { email: ADMIN.email, password: ADMIN.password },
    });
    const body = await res.json();
    const token = body.access_token || body.token;
    await page.goto('index.html');
    await page.evaluate((t) => {
        localStorage.setItem('crisp_token', t);
        localStorage.setItem('crisp_user', JSON.stringify({
            email: 'e2e-admin@crisp.test', role: 'SUPER_ADMIN', full_name: 'E2E Admin',
        }));
    }, token);
    await page.reload();
    return token;
}

test.describe('Dashboard map render', () => {
    let token: string;

    test.beforeEach(async ({ page, request }) => {
        token = await loginAsAdmin(page, request);
    });

    test.afterAll(async ({ request }) => {
        // Scrub any E2E-DEVICE-* rows we added so later runs start clean.
        const res = await request.post('http://localhost:8000/api/v1/auth/login', {
            data: { email: ADMIN.email, password: ADMIN.password },
        });
        if (res.ok()) {
            const body = await res.json();
            await cleanupTestReports(request, body.access_token || body.token);
        }
    });

    test('@smoke map div visible + Leaflet tiles paint', async ({ page }) => {
        await expect(page.locator('#crisis-map')).toBeVisible({ timeout: 10_000 });

        // Leaflet's tile layer injects `<img>` nodes with class
        // `leaflet-tile`. If the bundle failed to load OR the global `L`
        // wasn't found, there will be zero of them. Waiting for >0
        // confirms the map actually has a render; CartoDB usually
        // resolves in under a second over the test network, but we
        // allow 15 s for slow CI.
        await expect.poll(
            async () => page.evaluate(() => document.querySelectorAll('img.leaflet-tile').length),
            { timeout: 15_000, intervals: [250, 500, 1000, 2000] },
        ).toBeGreaterThan(0);

        // The attribution control is Leaflet's own DOM — another robust
        // positive-signal that Leaflet booted (survives tile-server
        // flakiness since it renders before tiles resolve).
        await expect(page.locator('.leaflet-control-attribution')).toBeVisible();

        // The debug hook must return a live Leaflet.Map instance —
        // this is what the other tests in this file depend on.
        const mapOk = await page.evaluate(() => {
            const m = (window as any).__crispMap;
            return !!m && typeof m.getZoom === 'function' && typeof m.getCenter === 'function';
        });
        expect(mapOk, '__crispMap hook missing or not a Leaflet.Map').toBeTruthy();
    });

    test('@smoke marker cluster plugin + layer switcher bootstrap', async ({ page }) => {
        await expect(page.locator('#crisis-map')).toBeVisible({ timeout: 10_000 });

        // L.markerClusterGroup is the most common "missing plugin" failure
        // — the CDN <script> 404s or the plugin name changes in a minor
        // version bump. Verify BOTH the plugin globals and that initMap()
        // actually instantiated a cluster group (via the __crispClusterGroup
        // debug hook).
        const pluginOk = await page.evaluate(() => {
            // @ts-ignore
            const L = (window as any).L;
            if (!L || typeof L.markerClusterGroup !== 'function') return false;
            if (typeof L.MarkerClusterGroup !== 'function') return false;
            const cg = (window as any).__crispClusterGroup;
            // cluster groups are FeatureGroups — getLayers is the duck-typed
            // contract.
            return !!cg && typeof cg.getLayers === 'function';
        });
        expect(pluginOk, 'marker-cluster plugin or __crispClusterGroup not live').toBeTruthy();

        // Leaflet's layer-switcher UI — configured in initMap() with
        // Dark / Satellite / Street options. Exists even with zero data.
        await expect(page.locator('.leaflet-control-layers')).toBeVisible({ timeout: 10_000 });
    });

    test('seeded report with location shows as a marker on the map', async ({ page, request }) => {
        const deviceHash = `E2E-DEVICE-MAP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        // Distinctive coordinates so we can pinpoint OUR marker vs any
        // other seed row surviving from a dirty DB.
        const seedLat = 13.12345;
        const seedLng = 77.67890;
        const reportId = await seedReport(request, token, deviceHash, seedLat, seedLng);

        // Force a fresh fetch + wait for the ID to appear in window.allReports
        // (same pattern as 03-reviewer-workflow.spec.ts). Without this, the
        // test can race the poll timer and see a stale marker set.
        await expect.poll(
            async () => {
                await page.evaluate(() =>
                    (window as any).__crispFetchReports && (window as any).__crispFetchReports()
                ).catch(() => {});
                return page.evaluate((id) => {
                    const arr = (window as any).allReports;
                    return Array.isArray(arr) && arr.some((r: any) => r.id === id);
                }, reportId);
            },
            { timeout: 20_000, intervals: [500, 1000, 2000] },
        ).toBe(true);

        // updateMapMarkers() runs on the next tick of the poll cycle
        // after fetchReports resolves. Poll the cluster group for the
        // marker we care about — identity via `marker._crispReport.id`.
        const seedAsEvaluateArg = { id: reportId, lat: seedLat, lng: seedLng };
        await expect.poll(
            async () =>
                page.evaluate(({ id, lat, lng }) => {
                    const cg = (window as any).__crispClusterGroup;
                    if (!cg || typeof cg.getLayers !== 'function') return null;
                    const layers = cg.getLayers();
                    for (const m of layers) {
                        if (m && m._crispReport && m._crispReport.id === id) {
                            // Confirm geometry round-tripped too — a
                            // regression that plotted markers at (0,0)
                            // would still satisfy the ID check.
                            const ll = m.getLatLng ? m.getLatLng() : null;
                            if (!ll) return 'found-but-no-latlng';
                            if (Math.abs(ll.lat - lat) > 0.001) return `bad-lat:${ll.lat}`;
                            if (Math.abs(ll.lng - lng) > 0.001) return `bad-lng:${ll.lng}`;
                            return 'found';
                        }
                    }
                    return 'not-found';
                }, seedAsEvaluateArg),
            { timeout: 15_000, intervals: [500, 1000, 2000] },
        ).toBe('found');
    });
});
