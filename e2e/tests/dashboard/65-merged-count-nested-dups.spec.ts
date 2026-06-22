/**
 * Dashboard — clean 3-colour hierarchy + single incident/duplicate metric (v132).
 *
 * Operator brief (two complaints):
 *   1. The Operation→Building→Incident tree had too many borders/backgrounds.
 *      Operations & Buildings must read as lightweight HEADER ROWS (no card surface);
 *      only the Incident card keeps a background+border.
 *   2. "incidents" vs "reports" was a confusing dual. Now ONE metric: the building
 *      header shows the MERGED incident count + a neutral "N duplicates" chip (no
 *      "· M reports"), and the per-card "N duplicates" badge EXPANDS the merged
 *      reports as dimmed rows NESTED under the primary (list shows all incl.
 *      duplicates; the roll-up stays merged).
 *
 * Self-contained: fake admin token + stubbed /api/v1 (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const BLD = 'osm:way:1001';
const rep = (id: string, o: Record<string, any> = {}) => ({
    id, client_report_id: id, device_id: 'dev', source: 'APP', status: 'PENDING',
    reviewer_verdict: 'NOT_REVIEWED', sync_status: 'SYNCED', severity: 'CRITICAL',
    infrastructure_type: 'RESIDENTIAL', crisis_type: 'FLOOD', damage_classification: 'PARTIAL',
    description: 'feed', expected_media: 0, received_media: 0, media: [],
    server_created_at: NOW, client_created_at: NOW,
    location: { latitude: 12.97, longitude: 77.59, user_location_name: 'Electronic City' },
    crisis_event_id: null, crisis_event_name: null, building_id: BLD, incident_id: null,
    infrastructure_name: 'Prestige Apartments', infrastructure_name_from_osm: true, duplicate_count: 0, ...o,
});
// One building: 3 visible incidents, the primary carries 2 merged duplicates.
const LIST = [
    rep('r-primary', { duplicate_count: 2 }),
    rep('r-2', { infrastructure_type: 'COMMERCIAL' }),
    rep('r-3', { infrastructure_type: 'COMMERCIAL', severity: 'MODERATE' }),
];
const DUPS = { report_id: 'r-primary', cluster_key: 'b:' + BLD, primary_report_id: 'r-primary', candidates: [
    { report_id: 'd-1', confidence: 'HIGH', score: 95, confirmed: true, severity: 'CRITICAL', status: 'PENDING',
      crisis_type: 'FLOOD', infrastructure_type: 'RESIDENTIAL', server_created_at: NOW, location_name: 'Electronic City' },
    { report_id: 'd-2', confidence: 'HIGH', score: 92, confirmed: true, severity: 'SEVERE', status: 'PENDING',
      crisis_type: 'FLOOD', infrastructure_type: 'RESIDENTIAL', server_created_at: NOW, location_name: 'Electronic City' },
]};

async function boot(page: Page, hash = '#/incidents', ops: any[] = []) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: { reports: 5, incidents: 3 }, distributions: {}, timings: {}, impact: {}, deltas: {}, total_reports: 5 } });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/buildings-needing-review')) return route.fulfill({ json: { buildings: [{ building_id: BLD, candidate_pairs: 3, high: 1 }] } });
        if (/\/reports\/[^/?]+\/duplicates/.test(u)) return route.fulfill({ json: DUPS });
        if (u.includes('/operations')) return route.fulfill({ json: ops });
        if (u.includes('/buildings')) return route.fulfill({ json: [] });
        if (/\/reports\/?\?/.test(u) || /\/reports\/?$/.test(u)) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '3', 'access-control-expose-headers': 'X-Total-Count' }, json: LIST });
        if (/\/reports\/[^/?]+$/.test(u)) { const id = u.split('/').pop()!.split('?')[0]; return route.fulfill({ json: LIST.find((r) => r.id === id) || LIST[0] }); }
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports), null, { timeout: 15000 });
    await page.evaluate((h) => { location.hash = h; }, hash);
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(800);   // let the load sequence settle (avoids re-render races)
}

test.describe('Dashboard — clean hierarchy + single metric (v132)', () => {
    test('@smoke building header shows a single clean incident count (no "· M reports/duplicates" dual)', async ({ page }) => {
        await boot(page);
        // 3 reports, none sharing an incident_id → 3 distinct incidents.
        const meta = page.locator('#report-feed-list .cc-cluster .cc-cluster-meta').first();
        await expect(meta).toContainText('3 incidents');
        await expect(meta).not.toContainText('duplicate');
        await expect(meta).not.toContainText('reports');   // no competing report number
    });

    test('@smoke Buildings are header ROWS (no card chrome); only the Incident is a card', async ({ page }) => {
        await boot(page);
        await page.locator('#report-feed-list .cc-cluster .qrt-section-header').first().click();
        await page.waitForTimeout(300);
        // Building header row: no inherited bottom border.
        const hdrBorder = await page.locator('#report-feed-list .cc-cluster .qrt-section-header').first()
            .evaluate((el) => getComputedStyle(el).borderBottomStyle);
        expect(hdrBorder).toBe('none');
        // The incident card IS the only bordered/backed surface.
        const card = page.locator('#report-feed-list .qrt-card').first();
        const cardStyle = await card.evaluate((el) => {
            const s = getComputedStyle(el);
            return { bg: s.backgroundColor, bw: parseFloat(s.borderTopWidth) };
        });
        expect(cardStyle.bg).not.toBe('rgba(0, 0, 0, 0)');   // has a surface
        expect(cardStyle.bw).toBeGreaterThan(0);             // has a border
    });

    test('@smoke an incident-less report keeps the "N duplicates" expander (nested members)', async ({ page }) => {
        await boot(page);
        await page.locator('#report-feed-list .cc-cluster .qrt-section-header').first().click();
        await page.waitForTimeout(400);
        // r-primary: incident_id NULL + duplicate_count 2 → the v132 duplicate path.
        const badge = page.locator('#report-feed-list .qrt-dup-merged[role="button"]').first();
        await expect(badge).toContainText('2 duplicates');
        await expect(badge).toHaveAttribute('aria-expanded', 'false');
        await badge.click();
        await expect(page.locator('.qrt-dup-children .qrt-dup-child')).toHaveCount(2, { timeout: 8000 });
        await expect(badge).toHaveAttribute('aria-expanded', 'true');
        // a second click collapses
        await badge.click();
        await expect(page.locator('.qrt-dup-children .qrt-dup-child')).toHaveCount(0);
    });

    test('@smoke Operations are header ROWS in the registry tree (no card background/border)', async ({ page }) => {
        await boot(page, '#/operations', [
            { id: 'op-1', name: 'Bangalore Floods', crisis_type: 'FLOOD', status: 'LIVE', is_active: true,
              center_lat: 12.9, center_lng: 77.6, radius_km: 25, place_name: 'Bangalore', started_at: NOW,
              critical: 4, total: 10, health: 'RED', health_reason: '4 critical', responders_active: 2, is_cluster: false },
        ]);
        const op = page.locator('#report-feed-list .opg-op').first();
        await expect(op).toBeVisible({ timeout: 8000 });
        const opStyle = await op.evaluate((el) => {
            const s = getComputedStyle(el);
            return { bg: s.backgroundColor, bw: parseFloat(s.borderTopWidth) };
        });
        expect(opStyle.bg).toBe('rgba(0, 0, 0, 0)');   // header row, not a card
        expect(opStyle.bw).toBe(0);
        // Hierarchy is conveyed by FONT COLOUR (purple for Operations), NOT a
        // card border/accent: the operator asked to drop coloured borders on
        // parent nodes and distinguish levels by text colour instead.
        const accent = await page.locator('#report-feed-list .opg-op-head').first()
            .evaluate((el) => parseFloat(getComputedStyle(el).borderLeftWidth));
        expect(accent).toBe(0);   // no left accent — removed by design
        const nameColor = await page.locator('#report-feed-list .opg-op-name').first()
            .evaluate((el) => getComputedStyle(el).color);
        expect(nameColor).toBe('rgb(167, 139, 250)');   // purple = Operation level
    });
});
