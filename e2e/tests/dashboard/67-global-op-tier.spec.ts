/**
 * Dashboard — GLOBAL feed shows the full Operation → Building → Incident hierarchy. v134.
 *
 * At Global (#/incidents, no scope), when real operations exist the rich building cards
 * are grouped under their Operation (.opg-op section → .cc-cluster building cards →
 * incidents). Unassigned reports (no crisis_event_id) fall into a single "no operation"
 * section. When NOTHING is assigned to an operation, the feed stays the flat building
 * list (nothing to group by). Op/building-scoped views are unchanged.
 *
 * Self-contained: fake admin token + stubbed /api/v1 (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const rep = (id: string, bld: string, op: string | null, name: string, o: Record<string, any> = {}) => ({
    id, client_report_id: id, device_id: 'dev', source: 'APP', status: 'PENDING',
    reviewer_verdict: 'NOT_REVIEWED', sync_status: 'SYNCED', severity: 'CRITICAL',
    infrastructure_type: 'RESIDENTIAL', crisis_type: 'FLOOD', damage_classification: 'PARTIAL',
    description: 'feed', expected_media: 0, received_media: 0, media: [],
    server_created_at: NOW, client_created_at: NOW,
    location: { latitude: 12.97, longitude: 77.59, user_location_name: 'Bangalore' },
    crisis_event_id: op, crisis_event_name: null, building_id: bld, incident_id: null,
    infrastructure_name: name, infrastructure_name_from_osm: true, duplicate_count: 0, ...o,
});
const OPS = [{ id: 'op-1', name: 'Bangalore Floods', crisis_type: 'FLOOD', status: 'LIVE', is_active: true },
             { id: 'op-2', name: 'Chennai Floods', crisis_type: 'FLOOD', status: 'LIVE', is_active: true }];

async function boot(page: Page, list: any[]) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: { incidents: list.length, reports: list.length }, distributions: {}, timings: {}, impact: {}, deltas: {}, total_reports: list.length } });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/buildings-needing-review')) return route.fulfill({ json: { buildings: [] } });
        if (u.includes('/operations')) return route.fulfill({ json: OPS });
        if (u.includes('/buildings')) return route.fulfill({ json: [] });
        if (/\/reports\/?\?/.test(u) || /\/reports\/?$/.test(u)) return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(list.length), 'access-control-expose-headers': 'X-Total-Count' }, json: list });
        if (/\/reports\/[^/?]+$/.test(u)) { const id = u.split('/').pop()!.split('?')[0]; return route.fulfill({ json: list.find((r) => r.id === id) || list[0] }); }
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports), null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(800);
}

// op-1: 2 buildings (b1,b2); op-2: 1 building (b3); unassigned: 1 building (b4).
const WITH_OPS = [
    rep('r-a1', 'b1', 'op-1', 'Tower A'),
    rep('r-b1', 'b2', 'op-1', 'Tower B', { infrastructure_type: 'COMMERCIAL' }),
    rep('r-c1', 'b3', 'op-2', 'Tower C', { severity: 'MODERATE' }),
    rep('r-d1', 'b4', null, 'Tower D', { severity: 'MODERATE' }),
];

test.describe('Dashboard — Global Operation → Building → Incident hierarchy (v134)', () => {
    test('@smoke Global groups building cards under their Operation', async ({ page }) => {
        await boot(page, WITH_OPS);
        // op section headers resolve to real names (after the lazy /operations load + re-render).
        await expect(page.locator('.opg-op-name', { hasText: 'Bangalore Floods' })).toBeVisible({ timeout: 8000 });
        // 3 op sections: op-1, op-2, and the unassigned ("no operation") section.
        await expect(page.locator('#report-feed-list .opg-op[data-opg-key]')).toHaveCount(3);
        // op-1 contains its 2 rich building cards; op-2 contains 1.
        await expect(page.locator('#report-feed-list .opg-op[data-opg-key="op:op-1"] .cc-cluster')).toHaveCount(2);
        await expect(page.locator('#report-feed-list .opg-op[data-opg-key="op:op-2"] .cc-cluster')).toHaveCount(1);
        // the unassigned building lands in the "no operation" (triage-styled) section.
        const unassigned = page.locator('#report-feed-list .opg-op.opg-triage');
        await expect(unassigned).toHaveCount(1);
        await expect(unassigned.locator('.cc-cluster')).toHaveCount(1);
        // toolbar summarises the 3-level hierarchy.
        await expect(page.locator('#report-feed-list .opg-tb-sum')).toContainText('2 operations');
    });

    test('@smoke a building card under an operation still expands to its incidents', async ({ page }) => {
        await boot(page, WITH_OPS);
        await expect(page.locator('.opg-op-name', { hasText: 'Bangalore Floods' })).toBeVisible({ timeout: 8000 });
        const card = page.locator('#report-feed-list .opg-op[data-opg-key="op:op-1"] .cc-cluster').first();
        await card.locator('.cc-cluster-meta').click();
        await expect(card.locator('.qrt-card')).toHaveCount(1, { timeout: 8000 });
    });

    test('@smoke "View →" on an operation header opens its summary panel', async ({ page }) => {
        await boot(page, WITH_OPS);
        await expect(page.locator('.opg-op-name', { hasText: 'Bangalore Floods' })).toBeVisible({ timeout: 8000 });
        await page.locator('#report-feed-list .opg-op[data-opg-key="op:op-1"] .opg-op-drill').click();
        await expect(page.locator('#detail-panel.detail-panel--operation')).toBeVisible({ timeout: 8000 });
    });

    test('@smoke with NO operations assigned, Global stays the flat building list', async ({ page }) => {
        await boot(page, [rep('r-x', 'bx', null, 'Lone Tower'), rep('r-y', 'by', null, 'Other Tower')]);
        // no op sections; building cards render flat (direct, not nested under .opg-op).
        await expect(page.locator('#report-feed-list .opg-op[data-opg-key]')).toHaveCount(0);
        await expect(page.locator('#report-feed-list .cc-cluster')).toHaveCount(2);
    });

    test('@smoke Collapse all closes the operation sections; Expand all re-opens them', async ({ page }) => {
        // Regression: in the op-grouped feed the building cards are already collapsed
        // rows, so Collapse-all has to close the OPERATION sections (.opg-op) — earlier
        // it only toggled the building cards and so was a visible no-op.
        await boot(page, WITH_OPS);
        await expect(page.locator('.opg-op-name', { hasText: 'Bangalore Floods' })).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#report-feed-list .opg-op[data-opg-key]')).toHaveCount(3);
        // Operations start expanded.
        await expect(page.locator('#report-feed-list .opg-op.opg-collapsed')).toHaveCount(0);
        // Collapse all → every operation section collapses to its header.
        await page.locator('#report-feed-list .opg-toolbar [data-cc-all="collapse"]').click();
        await expect(page.locator('#report-feed-list .opg-op.opg-collapsed')).toHaveCount(3);
        // Expand all → every operation section re-opens.
        await page.locator('#report-feed-list .opg-toolbar [data-cc-all="expand"]').click();
        await expect(page.locator('#report-feed-list .opg-op.opg-collapsed')).toHaveCount(0);
    });
});
