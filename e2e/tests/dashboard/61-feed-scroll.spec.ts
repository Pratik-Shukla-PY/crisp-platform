import { test, expect, Page } from '@playwright/test';
const NOW = new Date().toISOString();
const loc = { latitude: 13.08, longitude: 80.27, user_location_name: 'Area' };
const OPS = [
    { id: 'op-a', name: 'Shimla Landslide Response', status: 'LIVE', is_active: true, center_lat: 31.1, center_lng: 77.1 },
    { id: 'op-b', name: 'Chennai Flood Response', status: 'LIVE', is_active: true, center_lat: 13.0, center_lng: 80.2 },
    { id: 'op-c', name: 'Bangalore Slides', status: 'LIVE', is_active: true, center_lat: 12.9, center_lng: 77.6 },
];
const REPORTS: any[] = [];
for (let i = 0; i < 42; i++) {
    const op = ['op-a','op-b','op-c', null][i % 4];
    REPORTS.push({ id: 'r'+i, severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD',
        crisis_event_id: op, building_id: 'b'+(i%14), infrastructure_name: 'Building '+(i%14), infrastructure_name_from_osm: true,
        infrastructure_type: 'OTHER', source: 'APP', server_created_at: NOW, location: { ...loc }, media: [] });
}
async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: { critical: 42 }, distributions: {}, timings: {}, impact: {}, deltas: {} } });
        if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: OPS });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/reports/buildings-needing-review')) return route.fulfill({ json: { buildings: [], total_buildings: 0, total_pairs: 0 } });
        if (/\/reports\/?\?/.test(u)) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '42' }, json: REPORTS });
        const s = u.match(/\/reports\/(r\d+)(?:\?|$)/); if (s) return route.fulfill({ json: REPORTS.find((r) => r.id === s[1]) || {} });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents;queue=critical'; });
    await expect(page.locator('.opg-op').first()).toBeVisible({ timeout: 8000 });
}
test.describe('Dashboard — Incident Feed scrolls (tall Op→Building→Incident tree)', () => {
    test('the feed panel scrolls when the tree is taller than the panel', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await boot(page);
        await page.locator('.opg-toolbar [data-opg-all="expand"]').click();
        await page.waitForTimeout(300);
        const m = await page.evaluate(() => {
            const list = document.getElementById('report-feed-list')!;
            return { scrollH: list.scrollHeight, clientH: list.clientHeight, nCards: list.querySelectorAll('.qrt-card').length };
        });
        // 42 expanded cards must overflow the panel (NOT be compressed into it).
        expect(m.nCards).toBe(42);
        expect(m.scrollH).toBeGreaterThan(m.clientH + 200);   // genuinely overflowing → scrollable
        // And the list actually scrolls (scrollTop moves).
        await page.locator('#report-feed-list').evaluate((el) => { el.scrollTop = 600; });
        const top = await page.locator('#report-feed-list').evaluate((el) => el.scrollTop);
        expect(top).toBeGreaterThan(100);
        // The sticky toolbar stays pinned at the top of the scroll area while content scrolls.
        const tbTop = await page.locator('#report-feed-list .opg-toolbar').evaluate((el) => Math.round(el.getBoundingClientRect().top));
        const listTop = await page.locator('#report-feed-list').evaluate((el) => Math.round(el.getBoundingClientRect().top));
        expect(Math.abs(tbTop - listTop)).toBeLessThan(8);
    });
});
