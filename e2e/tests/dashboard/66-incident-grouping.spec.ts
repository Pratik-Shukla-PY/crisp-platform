/**
 * Dashboard — Incident Feed graduation: the feed consumes the real `incidents`
 * entity (Building → Incident → Report). v133.
 *
 * Reports are still fetched from GET /reports/ (so map/search/filters/export/status
 * are untouched) but grouped by the server-assigned r.incident_id:
 *   - reports sharing an incident_id collapse into ONE incident card (the others are
 *     NOT separate top-level cards) — led by the first member;
 *   - that card wears a neutral "N reports" expander → GET /incidents/{id} members,
 *     rendered as dimmed nested rows;
 *   - building "N incidents" = distinct incident units (not report count);
 *   - clicking a multi-report incident card opens the Incident Detail overlay.
 *
 * Self-contained: fake admin token + stubbed /api/v1 (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const BLD = 'osm:way:2001';

const rep = (id: string, incidentId: string | null, msAgo: number, o: Record<string, any> = {}) => ({
    id, client_report_id: id, device_id: 'dev', source: 'APP', status: 'PENDING',
    reviewer_verdict: 'NOT_REVIEWED', sync_status: 'SYNCED', severity: 'CRITICAL',
    infrastructure_type: 'RESIDENTIAL', crisis_type: 'FLOOD', damage_classification: 'PARTIAL',
    description: 'feed', expected_media: 0, received_media: 0, media: [],
    server_created_at: iso(msAgo), client_created_at: iso(msAgo),
    location: { latitude: 12.97, longitude: 77.59, user_location_name: 'Electronic City' },
    crisis_event_id: null, crisis_event_name: null, building_id: BLD, incident_id: incidentId,
    infrastructure_name: 'Prestige Apartments', infrastructure_name_from_osm: true, duplicate_count: 0, ...o,
});
// One building, 3 reports → 2 incidents: inc-1 = {r-a, r-b}, inc-2 = {r-c}.
const LIST = [
    rep('r-a', 'inc-1', 0),
    rep('r-c', 'inc-2', 5 * 60000),
    rep('r-b', 'inc-1', 10 * 60000),
];
const mem = (id: string, isLead: boolean) => ({
    id, severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED',
    crisis_type: 'FLOOD', infrastructure_type: 'RESIDENTIAL', source: 'APP',
    server_created_at: iso(0), description: 'member', is_lead: isLead,
});
const INC1 = { id: 'inc-1', building_id: BLD, crisis_event_id: null, incident_type: 'FLOOD',
    severity: 'CRITICAL', severity_overridden: false, status: 'OPEN', title: 'Flooding · Prestige Apartments',
    lead_report_id: 'r-a', report_count: 2, created_at: iso(0), updated_at: iso(0),
    reports: [mem('r-a', true), mem('r-b', false)] };

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: { incidents: 2, reports: 3 }, distributions: {}, timings: {}, impact: {}, deltas: {}, total_reports: 3 } });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/buildings-needing-review')) return route.fulfill({ json: { buildings: [] } });
        if (/\/incidents\/inc-1(\?|$)/.test(u)) return route.fulfill({ json: INC1 });
        if (u.includes('/operations')) return route.fulfill({ json: [] });
        if (u.includes('/buildings')) return route.fulfill({ json: [] });
        if (/\/reports\/?\?/.test(u) || /\/reports\/?$/.test(u)) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '3', 'access-control-expose-headers': 'X-Total-Count' }, json: LIST });
        if (/\/reports\/[^/?]+$/.test(u)) { const id = u.split('/').pop()!.split('?')[0]; return route.fulfill({ json: LIST.find((r) => r.id === id) || LIST[0] }); }
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports), null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(800);
    // expand the building
    await page.locator('#report-feed-list .cc-cluster .qrt-section-header').first().click();
    await page.waitForTimeout(400);
}

test.describe('Dashboard — Incident Feed graduation to the real incidents entity (v133)', () => {
    test('@smoke reports sharing an incident_id collapse into ONE incident card', async ({ page }) => {
        await boot(page);
        // 3 reports → 2 incidents → 2 top-level cards (NOT 3).
        await expect(page.locator('#report-feed-list .qrt-section-body .qrt-card')).toHaveCount(2);
        await expect(page.locator('#report-feed-list .qrt-card[data-id="r-a"]')).toHaveCount(1);   // inc-1 lead
        await expect(page.locator('#report-feed-list .qrt-card[data-id="r-c"]')).toHaveCount(1);   // inc-2 singleton
        await expect(page.locator('#report-feed-list .qrt-card[data-id="r-b"]')).toHaveCount(0);   // folded into inc-1
    });

    test('@smoke building header counts distinct INCIDENTS (2), not reports (3)', async ({ page }) => {
        await boot(page);
        const meta = page.locator('#report-feed-list .cc-cluster .cc-cluster-meta').first();
        await expect(meta).toContainText('2 incidents');
        const badge = page.locator('#report-feed-list .cc-cluster .qrt-section-count').first();
        await expect(badge).toHaveText('2');
    });

    test('@smoke the incident card "N reports" expander reveals members from GET /incidents/{id}', async ({ page }) => {
        await boot(page);
        // the inc-1 card is the one carrying the expander.
        const exp = page.locator('#report-feed-list .qrt-dup-merged[role="button"]');
        await expect(exp).toHaveCount(1);
        await expect(exp).toContainText('2 reports');
        await exp.click();
        // members from /incidents/inc-1 minus the lead (r-a) → 1 nested row (r-b).
        await expect(page.locator('.qrt-dup-children .qrt-dup-child')).toHaveCount(1, { timeout: 8000 });
        await expect(exp).toHaveAttribute('aria-expanded', 'true');
    });

    test('@smoke clicking a multi-report incident card opens the Incident Detail overlay', async ({ page }) => {
        await boot(page);
        await page.locator('#report-feed-list .qrt-card[data-id="r-a"] .qrt-what').click();
        await expect(page.locator('#detail-panel[data-mode="incident"]')).toBeVisible({ timeout: 8000 });
    });
});
