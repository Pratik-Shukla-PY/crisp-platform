/**
 * Dashboard — building-name consistency (v135). Guards the "Unnamed Building" bug.
 *
 * An explicitly tagged OSM building (infrastructure_name_from_osm=true) must show its
 * name IDENTICALLY in the Incident Feed cluster header AND the Building Console header.
 * A free-text "what was hit" answer (from_osm=false) must be suppressed as the building
 * name in BOTH surfaces (must-have #6) — previously the Console header showed the raw
 * free-text while the feed showed "Unnamed building" (the per-surface inconsistency).
 * A legacy row with the flag OMITTED (undefined) still shows its name (back-compat).
 *
 * Self-contained: fake admin token + stubbed /api/v1 (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const base = (o: Record<string, any>) => ({
    status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', sync_status: 'SYNCED', severity: 'CRITICAL',
    crisis_type: 'FLOOD', damage_classification: 'PARTIAL', infrastructure_type: 'RESIDENTIAL',
    expected_media: 0, received_media: 0, media: [], server_created_at: NOW, client_created_at: NOW,
    crisis_event_id: null, incident_id: null, ...o,
});
// bU: explicit OSM tag (from_osm TRUE), name "University", building has NO osm_name yet.
// bF: free-text "what was hit" (from_osm FALSE), name "the blue shop near the river".
const REPORTS = [
    base({ id: 'ru', building_id: 'osm:way:1', infrastructure_name: 'University', infrastructure_name_from_osm: true,
        location: { latitude: 12.97, longitude: 77.59, user_location_name: 'Jayanagar, Bangalore' } }),
    base({ id: 'rf', building_id: 'osm:way:2', infrastructure_name: 'the blue shop near the river', infrastructure_name_from_osm: false,
        severity: 'MODERATE', location: { latitude: 13.01, longitude: 80.22, device_location_name: 'River Road' } }),
];
const bldDetail = (id: string, osm: string | null) => ({
    id, state: 'ACTIVE', severity_max: 'CRITICAL', report_count: 1, verified_report_count: 0,
    responding_report_count: 0, debris_clearing_needed_count: 0, crisis_types_top3: ['FLOOD'],
    centroid_lat: 12.97, centroid_lng: 77.59, osm_name: osm, severity_score: 60, confidence_score: 50,
    activity_score: 40, escalation_risk: 30, humanitarian_priority: 55, first_report_at: NOW, latest_report_at: NOW,
    reports: REPORTS.filter((r) => r.building_id === id),
});

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: {}, distributions: {}, timings: {}, impact: {}, deltas: {} } });
        if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: [] });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/buildings-needing-review')) return route.fulfill({ json: { buildings: [] } });
        const bm = u.match(/\/buildings\/([^/?]+)(?:\?|$)/);
        if (bm) { const id = decodeURIComponent(bm[1]); return route.fulfill({ json: bldDetail(id, null) }); }
        if (/\/reports\/?\?/.test(u) || /\/reports\/?$/.test(u)) return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(REPORTS.length) }, json: REPORTS });
        const single = u.match(/\/reports\/([^/?]+)(?:\?|$)/);
        if (single) return route.fulfill({ json: REPORTS.find((r) => r.id === single[1]) || {} });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 8000 });
}

test.describe('Dashboard — building-name consistency (v135)', () => {
    test('@smoke an OSM-tagged building shows its name in BOTH the feed and the Console', async ({ page }) => {
        await boot(page);
        // Feed cluster header (building has no osm_name → name comes from the from_osm report).
        const title = page.locator('.cc-cluster[data-cluster-key="b:osm:way:1"] .cc-cluster-title');
        await expect(title).toContainText('University', { timeout: 8000 });
        await expect(title).not.toContainText(/unnamed/i);
        // Building Console header — SAME canonical name (not "Unnamed/Unmapped").
        await page.locator('.cc-cluster[data-cluster-key="b:osm:way:1"] .cc-cluster-name-link').click();
        await expect(page.locator('#detail-panel.detail-panel--building')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#detail-title')).toContainText('University', { timeout: 8000 });
    });

    test('@smoke a free-text "what was hit" answer is NOT shown as the building name in EITHER surface', async ({ page }) => {
        await boot(page);
        // Feed: suppressed → falls through to the area, never the free-text descriptor.
        const title = page.locator('.cc-cluster[data-cluster-key="b:osm:way:2"] .cc-cluster-title');
        await expect(title).toContainText('River Road', { timeout: 8000 });
        await expect(title).not.toContainText(/blue shop/i);
        // Building Console header: the consistency fix — gated, so NOT the free-text;
        // the empty fallback is the single "Unmapped building" label.
        await page.locator('.cc-cluster[data-cluster-key="b:osm:way:2"] .cc-cluster-name-link').click();
        await expect(page.locator('#detail-panel.detail-panel--building')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#detail-title')).not.toContainText(/blue shop/i);
        await expect(page.locator('#detail-title')).toContainText(/unmapped building/i);
    });
});
