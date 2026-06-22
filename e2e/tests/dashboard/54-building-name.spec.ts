/**
 * Dashboard — building naming + console CTA dedup + op-scoped summary (v112).
 *
 * - A building is named by its TAG (the OSM footprint name) disambiguated with the
 *   area, e.g. "DoubleTree Hotel · Koramangala". It is NEVER named by the
 *   infrastructure_type ("what was hit" — Commercial/Government/…). A building with
 *   no tag name falls back to the area alone (not the infra type).
 * - Clicking the building NAME opens the summary console; the separate open-icon
 *   (.cc-cluster-open) is removed (duplicate CTA).
 * - Opening the console from inside an operation scopes the incident LIST to that
 *   operation (global → all reports); the header carries an op-scope note.
 *
 * Self-contained: fake token + stubbed /api/v1/** (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const OPERATIONS = [{ id: 'op-a', name: 'Chennai Flood Response', place_name: 'Chennai, IN', status: 'LIVE', is_active: true, critical: 0 }];

// bldX: a NAMED building (DoubleTree Hotel) in Koramangala, 2 reports across 2 ops.
// bldY: an UNNAMED OSM footprint (infrastructure_name null) whose area is Marina
//       Beach and whose "what was hit" is GOVERNMENT — must show "Marina Beach", NOT
//       "Government".
const REPORTS = [
    { id: 'bx1', building_id: 'bldX', infrastructure_name: 'DoubleTree Hotel', infrastructure_type: 'COMMERCIAL',
      severity: 'SEVERE', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD', crisis_event_id: 'op-a',
      server_created_at: NOW, location: { latitude: 12.93, longitude: 77.62, user_location_name: 'Koramangala, Bangalore' } },
    { id: 'bx2', building_id: 'bldX', infrastructure_name: 'DoubleTree Hotel', infrastructure_type: 'COMMERCIAL',
      severity: 'MODERATE', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD', crisis_event_id: 'op-b',
      server_created_at: NOW, location: { latitude: 12.93, longitude: 77.62, user_location_name: 'Koramangala, Bangalore' } },
    { id: 'by1', building_id: 'bldY', infrastructure_name: null, infrastructure_type: 'GOVERNMENT',
      severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD', crisis_event_id: 'op-a',
      server_created_at: NOW, location: { latitude: 13.05, longitude: 80.28, device_location_name: 'Marina Beach' } },
];

const bldDetail = (id, osmName, reps) => ({
    id, state: 'ACTIVE', severity_max: 'SEVERE', report_count: reps.length,
    verified_report_count: 0, responding_report_count: 0, debris_clearing_needed_count: 0,
    crisis_types_top3: ['FLOOD'], centroid_lat: reps[0].location.latitude, centroid_lng: reps[0].location.longitude,
    osm_name: osmName, severity_score: 60, confidence_score: 50, activity_score: 40, escalation_risk: 30, humanitarian_priority: 55,
    first_report_at: NOW, latest_report_at: NOW, reports: reps,
});

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: {}, distributions: {}, timings: {}, impact: {}, deltas: {} } });
        if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/reports/buildings-needing-review')) return route.fulfill({ json: { buildings: [], total_buildings: 0, total_pairs: 0 } });
        const bm = u.match(/\/buildings\/(bld[A-Z])(?:\?|$)/);
        if (bm) {
            const id = bm[1];
            return route.fulfill({ json: id === 'bldX'
                ? bldDetail('bldX', 'DoubleTree Hotel', REPORTS.filter((r) => r.building_id === 'bldX'))
                : bldDetail('bldY', null, REPORTS.filter((r) => r.building_id === 'bldY')) });
        }
        if (/\/reports\/?\?/.test(u)) {
            const scoped = /crisis_event_id=op-a/.test(u);
            const list = scoped ? REPORTS.filter((r) => r.crisis_event_id === 'op-a') : REPORTS;
            return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(list.length) }, json: list });
        }
        const single = u.match(/\/reports\/([a-z0-9]+)(?:\?|$)/);
        if (single) return route.fulfill({ json: REPORTS.find((r) => r.id === single[1]) || {} });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 8000 });
}

test.describe('Dashboard — building naming + console (v112)', () => {
    test('@smoke a building is named by its tag · area, never the infrastructure type', async ({ page }) => {
        await boot(page);
        // Named building: "DoubleTree Hotel · Koramangala, Bangalore".
        const x = page.locator('.cc-cluster[data-cluster-key="b:bldX"] .cc-cluster-title');
        await expect(x).toContainText('DoubleTree Hotel', { timeout: 8000 });
        await expect(x).toContainText('Koramangala');
        // Unnamed footprint → the AREA (Marina Beach), NOT the infra type "Government".
        const y = page.locator('.cc-cluster[data-cluster-key="b:bldY"] .cc-cluster-title');
        await expect(y).toHaveText('Marina Beach');
        await expect(y).not.toContainText(/government/i);
    });

    test('@smoke the duplicate open-icon is gone; clicking the building name opens the summary console', async ({ page }) => {
        await boot(page);
        await expect(page.locator('.cc-cluster-open')).toHaveCount(0);
        await page.locator('.cc-cluster[data-cluster-key="b:bldX"] .cc-cluster-name-link').click();
        await expect(page.locator('#detail-panel.detail-panel--building')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#detail-title')).toContainText('DoubleTree Hotel', { timeout: 8000 });
        // Global scope → all reports, no op-scope note.
        await expect(page.locator('#detail-title .bc-opscope')).toHaveCount(0);
    });

    test('@smoke opening the console inside an operation scopes the incident list to that op', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => { location.hash = '#/incidents;op=op-a'; });
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldX"]')).toBeVisible({ timeout: 8000 });
        await page.locator('.cc-cluster[data-cluster-key="b:bldX"] .cc-cluster-name-link').click();
        await expect(page.locator('#detail-panel.detail-panel--building')).toBeVisible({ timeout: 8000 });
        // The op-scope note shows the operation + the scoped/total count (1 of 2).
        const note = page.locator('#detail-title .bc-opscope');
        await expect(note).toBeVisible({ timeout: 8000 });
        await expect(note).toContainText('Chennai Flood Response');
        await expect(note).toContainText('(1/2)');
    });
});
