/**
 * Dashboard — Incident Feed Operation → Building → Incident TREE.
 *
 * The attention-category feed (global scope + a queue) renders a collapsible tree:
 *   Operation (violet) → Building (teal) → Incident (slate leaf)
 * with connector rails, a small per-level indent, a sticky Expand-all/Collapse-all
 * toolbar + live summary, and per-node chevrons. This spec exercises the structure,
 * the collapse controls, and the preserved drill/navigation affordances.
 *
 * Self-contained: fake token + stubbed /api/v1/** (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const OPERATIONS = [
    { id: 'op-a', name: 'Aleppo Quake', place_name: 'Aleppo, SY', status: 'LIVE', is_active: true,
      center_lat: 36.2, center_lng: 37.1, critical: 3, total: 4, health: 'RED' },
    { id: 'op-b', name: 'Idlib Floods', place_name: 'Idlib, SY', status: 'LIVE', is_active: true,
      center_lat: 35.9, center_lng: 36.6, critical: 1, total: 2, health: 'AMBER' },
];
const loc = { latitude: 36.2, longitude: 37.1 };
// op-a: bldg b1 (Al-Razi Hospital ×2) + b2 (Central School ×1) + no-building ×1
// op-b: bldg b3 (Idlib Bridge ×2)
// triage: 1 report, no op / no building
const REPORTS = [
    { id: 'r1', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'EARTHQUAKE',
      crisis_event_id: 'op-a', building_id: 'b1', infrastructure_name: 'Al-Razi Hospital', server_created_at: NOW, location: loc },
    { id: 'r2', severity: 'SEVERE', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'EARTHQUAKE',
      crisis_event_id: 'op-a', building_id: 'b1', infrastructure_name: 'Al-Razi Hospital', server_created_at: NOW, location: loc },
    { id: 'r3', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'EARTHQUAKE',
      crisis_event_id: 'op-a', building_id: 'b2', infrastructure_name: 'Central School', server_created_at: NOW, location: loc },
    { id: 'r4', severity: 'MODERATE', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'EARTHQUAKE',
      crisis_event_id: 'op-a', building_id: null, server_created_at: NOW, location: loc },
    { id: 'r5', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD',
      crisis_event_id: 'op-b', building_id: 'b3', infrastructure_name: 'Idlib Bridge', server_created_at: NOW, location: loc },
    { id: 'r6', severity: 'SEVERE', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD',
      crisis_event_id: 'op-b', building_id: 'b3', infrastructure_name: 'Idlib Bridge', server_created_at: NOW, location: loc },
    { id: 'r7', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD',
      crisis_event_id: null, building_id: null, server_created_at: NOW, location: loc },
];

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: { critical: 6 }, distributions: {}, timings: {}, impact: {}, deltas: {} } });
        if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/reports/buildings-needing-review')) return route.fulfill({ json: { buildings: [], total_buildings: 0, total_pairs: 0 } });
        if (/\/reports\/?\?/.test(u)) {
            return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(REPORTS.length) }, json: REPORTS });
        }
        const single = u.match(/\/reports\/(r\d)(?:\?|$)/);
        if (single) return route.fulfill({ json: REPORTS.find((r) => r.id === single[1]) || {} });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents;queue=critical'; });
    // operation names resolve from _opsCache (lazily loaded) — wait for the real names.
    await expect(page.locator('.opg-op-name').first()).toContainText('Aleppo Quake', { timeout: 8000 });
}

test.describe('Dashboard — Op → Building → Incident tree', () => {
    test('renders a 3-level tree with toolbar, per-level nodes and connector rails', async ({ page }) => {
        await boot(page);
        // Toolbar: live summary + Expand all / Collapse all
        await expect(page.locator('.opg-toolbar')).toBeVisible();
        await expect(page.locator('.opg-tb-sum')).toContainText('2 operations');
        await expect(page.locator('.opg-tb-sum')).toContainText('incident');
        await expect(page.locator('.opg-tb-btn[data-opg-all="expand"]')).toBeVisible();
        await expect(page.locator('.opg-tb-btn[data-opg-all="collapse"]')).toBeVisible();
        // Level A: 2 real operations + the triage section = 3 op nodes
        await expect(page.locator('.opg-op')).toHaveCount(3);
        // Level B: building sub-groups exist with names
        await expect(page.locator('.opg-bldg-name').filter({ hasText: 'Al-Razi Hospital' })).toHaveCount(1);
        await expect(page.locator('.opg-bldg-name').filter({ hasText: 'Idlib Bridge' })).toHaveCount(1);
        // Level C: each incident card renders inside an .opg-inc leaf. queue=critical
        // narrows to the 4 CRITICAL reports (r1, r3, r5, r7) across the three sections.
        await expect(page.locator('#report-feed-list .opg-inc .qrt-card')).toHaveCount(4);
        // Each node carries a chevron + level icon (the visual hierarchy cues)
        await expect(page.locator('.opg-op-head .opg-twist').first()).toBeVisible();
        await expect(page.locator('.opg-op-ic').first()).toBeVisible();
        await expect(page.locator('.opg-bldg-ic').first()).toBeVisible();
        await page.screenshot({ path: 'test-results/op-tree-expanded.png', fullPage: false });
    });

    test('Collapse all hides incident bodies; Expand all restores them', async ({ page }) => {
        await boot(page);
        const firstCard = page.locator('#report-feed-list .opg-inc .qrt-card').first();
        await expect(firstCard).toBeVisible();
        // Collapse all → operation bodies hidden (cards no longer visible)
        await page.locator('.opg-tb-btn[data-opg-all="collapse"]').click();
        await expect(page.locator('.opg-op.opg-collapsed')).toHaveCount(3);
        await expect(firstCard).toBeHidden();
        await page.screenshot({ path: 'test-results/op-tree-collapsed.png', fullPage: false });
        // Expand all → everything open again
        await page.locator('.opg-tb-btn[data-opg-all="expand"]').click();
        await expect(page.locator('.opg-op.opg-collapsed')).toHaveCount(0);
        await expect(firstCard).toBeVisible();
    });

    test('clicking an operation header toggles just that operation', async ({ page }) => {
        await boot(page);
        const opA = page.locator('.opg-op').filter({ hasText: 'Aleppo Quake' });
        const opACard = opA.locator('.opg-inc .qrt-card').first();
        await expect(opACard).toBeVisible();
        await opA.locator('.opg-op-head').click();
        await expect(opA).toHaveClass(/opg-collapsed/);
        await expect(opACard).toBeHidden();
        // other operations stay open
        await expect(page.locator('.opg-op').filter({ hasText: 'Idlib Floods' })).not.toHaveClass(/opg-collapsed/);
        // the View → drill still navigates (does not toggle)
        await opA.locator('.opg-op-head').click(); // re-open
        await opA.locator('.opg-op-drill').click();
        await expect.poll(() => page.evaluate(() => location.hash)).toContain('op=op-a');
    });

    test('building name navigates to the building scope', async ({ page }) => {
        await boot(page);
        await page.locator('.opg-bldg-name').filter({ hasText: 'Al-Razi Hospital' }).click();
        await expect.poll(() => page.evaluate(() => location.hash)).toContain('bld=b1');
    });
});
