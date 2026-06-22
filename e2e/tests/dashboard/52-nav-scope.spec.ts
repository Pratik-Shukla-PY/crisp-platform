/**
 * Dashboard — Global → Operation/Triage → Building → Incident navigation clarity
 * (Jun 2026). Building + Triage are real feed SCOPES (client-side filters on the
 * op/global set); the #feed-scope-bar is a clickable breadcrumb spine; an attention
 * card lands on a feed GROUPED by Operation → Building.
 *
 * Self-contained: fake token + stubbed /api/v1/** (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const OPERATIONS = [
    { id: 'op-a', name: 'Aleppo Quake', place_name: 'Aleppo, SY', status: 'LIVE', is_active: true,
      center_lat: 36.2, center_lng: 37.1, critical: 3, total: 3, health: 'RED' },
];
// 4 CRITICAL open reports: op-a has b1(×2)+b2(×1); one triage (no op, no building).
const loc = { latitude: 36.2, longitude: 37.1 };
const REPORTS = [
    { id: 'r1', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'EARTHQUAKE',
      crisis_event_id: 'op-a', building_id: 'b1', infrastructure_name: 'Al-Razi Hospital', server_created_at: NOW, location: loc },
    { id: 'r2', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'EARTHQUAKE',
      crisis_event_id: 'op-a', building_id: 'b2', infrastructure_name: 'Central School', server_created_at: NOW, location: loc },
    { id: 'r3', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD',
      crisis_event_id: null, building_id: null, server_created_at: NOW, location: loc },
    { id: 'r4', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'EARTHQUAKE',
      crisis_event_id: 'op-a', building_id: 'b1', infrastructure_name: 'Al-Razi Hospital', server_created_at: NOW, location: loc },
];

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: { critical: 4 }, distributions: {}, timings: {}, impact: {}, deltas: {} } });
        if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/reports/buildings-needing-review')) return route.fulfill({ json: { buildings: [], total_buildings: 0, total_pairs: 0 } });
        if (/\/reports\/?\?/.test(u)) {
            // honour the op scope so building/triage filters are exercised honestly
            const scoped = /crisis_event_id=op-a/.test(u);
            const list = scoped ? REPORTS.filter((r) => r.crisis_event_id === 'op-a') : REPORTS;
            return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(list.length) }, json: list });
        }
        const single = u.match(/\/reports\/(r\d)(?:\?|$)/);
        if (single) return route.fulfill({ json: REPORTS.find((r) => r.id === single[1]) || {} });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 15000 });
}

test.describe('Dashboard — scope navigation (Global → Op/Triage → Building)', () => {
    test('attention category lands on a feed grouped by Operation → Building', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => { location.hash = '#/incidents;queue=critical'; });
        // Operation sections appear (op-a + Triage), with building sub-groups.
        await expect(page.locator('.opg-op')).toHaveCount(2, { timeout: 8000 });
        await expect(page.locator('.opg-op-name')).toContainText(['Aleppo Quake', 'Triage']);
        await expect(page.locator('.opg-bldg-name').first()).toContainText('Al-Razi Hospital');
        // All 4 matching cards still render (flat-feed contract preserved).
        await expect(page.locator('#report-feed-list .qrt-card')).toHaveCount(4);
    });

    test('building scope (;bld=) filters the feed + shows the building breadcrumb', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => { location.hash = '#/incidents;op=op-a;bld=b1;queue=critical'; });
        // Only b1's two reports (r1, r4).
        await expect(page.locator('#report-feed-list .qrt-card')).toHaveCount(2, { timeout: 8000 });
        await expect(page.locator('#report-feed-list .qrt-card[data-report-id="r2"]')).toHaveCount(0);
        // Banner breadcrumb shows the full path; the building leaf is named.
        await expect(page.locator('#feed-scope-bar .qb-crumbs')).toContainText('Global');
        await expect(page.locator('#feed-scope-bar .qb-crumbs')).toContainText('Aleppo Quake');
        await expect(page.locator('#feed-scope-bar')).toContainText('Al-Razi Hospital');
    });

    test('triage scope (;op=none) shows only reports not in any operation', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => { location.hash = '#/incidents;op=none;queue=critical'; });
        await expect(page.locator('#report-feed-list .qrt-card[data-report-id="r3"]')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#report-feed-list .qrt-card')).toHaveCount(1);
        // The triage scope reads on the breadcrumb spine (Global › Triage).
        await expect(page.locator('#feed-scope-bar .qb-crumbs')).toContainText('Triage');
    });

    test('building breadcrumb step-up clears the building scope', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => { location.hash = '#/incidents;op=op-a;bld=b1;queue=critical'; });
        await expect(page.locator('#report-feed-list .qrt-card')).toHaveCount(2, { timeout: 8000 });
        // The clickable Operation crumb steps UP — drops the building filter → back to
        // the op feed (its 3 PENDING op-a reports under the default Pending tab).
        await page.locator('#feed-scope-bar .qb-crumbs .qb-crumb-op').click();
        await expect(page.locator('#report-feed-list .qrt-card')).toHaveCount(3, { timeout: 6000 });
        await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('bld=');
    });
});
