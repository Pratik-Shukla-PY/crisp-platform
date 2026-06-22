/**
 * Dashboard — Rejected status tab.
 *
 * A 4th status tab (Pending / Responding / Resolved / Rejected) surfaces analyst-
 * rejected reports (reviewer_verdict === REJECTED) — the one in-feed place they appear
 * (every other view strips them). The rejection reason (report.action_taken) is shown
 * on the card AND, on click, in the detail panel's Rejected banner. Exports from the
 * tab carry reviewer_verdict=REJECTED (must-have #11).
 *
 * Self-contained: fake token + stubbed /api/v1/** (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const loc = { latitude: 13.08, longitude: 80.27, user_location_name: 'Koramangala, Chennai' };
const REASON = 'Duplicate of an existing report — spam';
const REPORTS = [
    { id: 'p1', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD',
      crisis_event_id: null, building_id: 'b1', infrastructure_name: 'Apollo Hospital', infrastructure_name_from_osm: true,
      infrastructure_type: 'HOSPITAL', source: 'APP', server_created_at: NOW, location: { ...loc }, media: [] },
    { id: 'x1', severity: 'SEVERE', status: 'PENDING', reviewer_verdict: 'REJECTED', action_taken: REASON, crisis_type: 'FLOOD',
      crisis_event_id: null, building_id: 'b2', infrastructure_name: 'Marina Bridge', infrastructure_name_from_osm: true,
      infrastructure_type: 'ROAD', source: 'WHATSAPP', server_created_at: NOW, location: { ...loc }, media: [] },
];

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
        localStorage.removeItem('crisp_feed_density');
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: {}, distributions: {}, timings: {}, impact: {}, deltas: {} } });
        if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: [] });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/reports/buildings-needing-review')) return route.fulfill({ json: { buildings: [], total_buildings: 0, total_pairs: 0 } });
        if (/\/reports\/?\?/.test(u)) return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(REPORTS.length) }, json: REPORTS });
        const s = u.match(/\/reports\/([px]\d)(?:\?|$)/); if (s) return route.fulfill({ json: REPORTS.find((r) => r.id === s[1]) || {} });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await expect(page.locator('#report-feed-list .cc-cluster').first()).toBeVisible({ timeout: 8000 });
}

test.describe('Dashboard — Rejected status tab', () => {
    test('a 4th Rejected tab renders with a count, separate from the live tabs', async ({ page }) => {
        await boot(page);
        const tab = page.locator('.feed-tab[data-tab="rejected"]');
        await expect(tab).toBeVisible();
        await expect(tab.locator('.ft-count')).toHaveText('1');
        // The rejected report is NOT in the default Pending tab.
        await page.locator('.cc-cluster[data-cluster-key="b:b1"] .qrt-section-header').click();
        await expect(page.locator('#report-feed-list .qrt-card[data-id="x1"]')).toHaveCount(0);
    });

    test('the Rejected tab shows rejected reports with the reason on the card', async ({ page }) => {
        await boot(page);
        await page.locator('.feed-tab[data-tab="rejected"]').click();
        // Only the rejected report shows; the pending one is gone.
        await expect(page.locator('#report-feed-list .qrt-card[data-id="p1"]')).toHaveCount(0);
        const bld = page.locator('.cc-cluster[data-cluster-key="b:b2"]');
        await bld.locator('.qrt-section-header').click();
        const card = page.locator('#report-feed-list .qrt-card[data-id="x1"]');
        await expect(card).toBeVisible({ timeout: 8000 });
        await expect(card.locator('.qrt-reject-reason')).toContainText('spam');
    });

    test('clicking a rejected report shows the rejection reason in the detail panel', async ({ page }) => {
        await boot(page);
        await page.locator('.feed-tab[data-tab="rejected"]').click();
        await page.locator('.cc-cluster[data-cluster-key="b:b2"] .qrt-section-header').click();
        await page.locator('#report-feed-list .qrt-card[data-id="x1"]').click();
        const banner = page.locator('#detail-panel .dp-act-banner-rejected');
        await expect(banner).toBeVisible({ timeout: 8000 });
        await expect(banner).toContainText('Rejected');
        await expect(page.locator('#detail-panel .dp-act-reason')).toContainText('spam');
    });

    test('export from the Rejected tab carries reviewer_verdict=REJECTED (must-have #11)', async ({ page }) => {
        await boot(page);
        await page.locator('.feed-tab[data-tab="rejected"]').click();
        const params = await page.evaluate(() => (window as any).__crispExportParams());
        expect(params).toContain('reviewer_verdict=REJECTED');
        expect(params).not.toContain('status=');
    });
});
