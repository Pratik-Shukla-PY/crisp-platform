/**
 * Dashboard — Incident Feed simplification (v111).
 *
 * The feed panel collapses to two rows + building-grouped status tabs:
 *   · ONE breadcrumb row with the Total folded inline + a single "Switch" button
 *     that toggles between operations & global (its menu lists Global + every op).
 *   · Row 2 = three status TABS (Pending / Responding / Resolved) with inline
 *     counts; clicking a tab shows that status's incidents GROUPED BY BUILDING.
 *   · Critical is a cross-cutting quick-filter chip (not a tab).
 *   · Filters + Sort are two small icons; Filters opens a popover that also holds
 *     the Rejected entry.
 *   · The Buildings/All-Incidents view toggle + the 4-pill KPI strip are retired.
 *
 * Self-contained: fake token + stubbed /api/v1/** (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const loc = { latitude: 13.0, longitude: 80.2 };
const OPERATIONS = [
    { id: 'op-a', name: 'Chennai Flood Response', place_name: 'Chennai, IN', status: 'LIVE', is_active: true, critical: 1 },
];

// status mix: 3 PENDING (bldA×2, bldB×1) · 1 RESPONDING (bldC) · 2 closed
// (bldD: RESOLVED + FALSE_ALARM) · 1 REJECTED (hidden; drives the Rejected entry).
const REPORTS = [
    { id: 'p1', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD',
      building_id: 'bldA', infrastructure_name: 'Apollo Hospital', server_created_at: NOW, location: loc },
    { id: 'p2', severity: 'MODERATE', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD',
      building_id: 'bldA', infrastructure_name: 'Apollo Hospital', server_created_at: NOW, location: loc },
    { id: 'p3', severity: 'SEVERE', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD',
      building_id: 'bldB', infrastructure_name: 'T Nagar Block B', server_created_at: NOW, location: loc },
    { id: 'd1', severity: 'MODERATE', status: 'RESPONDING', reviewer_verdict: 'ACCEPTED', crisis_type: 'FLOOD',
      building_id: 'bldC', infrastructure_name: 'Marina Relief Camp', server_created_at: NOW, location: loc },
    { id: 'x1', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'REJECTED', crisis_type: 'FLOOD',
      building_id: 'bldB', infrastructure_name: 'T Nagar Block B', server_created_at: NOW, location: loc },
    { id: 'rs1', severity: 'MODERATE', status: 'RESOLVED', reviewer_verdict: 'ACCEPTED', crisis_type: 'FLOOD',
      building_id: 'bldD', infrastructure_name: 'Velachery Pump', server_created_at: NOW, location: loc },
    { id: 'fa1', severity: 'MINOR', status: 'FALSE_ALARM', reviewer_verdict: 'ACCEPTED', crisis_type: 'FLOOD',
      building_id: 'bldD', infrastructure_name: 'Velachery Pump', server_created_at: NOW, location: loc },
];

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: { critical: 1 }, distributions: {}, timings: {}, impact: {}, deltas: {} } });
        if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/reports/buildings-needing-review')) return route.fulfill({ json: { buildings: [], total_buildings: 0, total_pairs: 0 } });
        if (/\/reports\/?\?/.test(u)) return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(REPORTS.length) }, json: REPORTS });
        const single = u.match(/\/reports\/([a-z0-9]+)(?:\?|$)/);
        if (single) return route.fulfill({ json: REPORTS.find((r) => r.id === single[1]) || {} });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 8000 });
}

test.describe('Dashboard — Incident Feed simplification (v111)', () => {
    test('@smoke three status tabs render with inline counts; Pending is the default', async ({ page }) => {
        await boot(page);
        await expect(page.locator('.feed-tabs .feed-tab[data-tab="pending"]')).toBeVisible();
        await expect(page.locator('.feed-tabs .feed-tab[data-tab="responding"]')).toBeVisible();
        await expect(page.locator('.feed-tabs .feed-tab[data-tab="resolved"]')).toBeVisible();
        // Counts: pending 3, responding 1, resolved 2 (the rejected report is excluded).
        await expect(page.locator('#count-pending')).toHaveText('3', { timeout: 6000 });
        await expect(page.locator('#count-responding')).toHaveText('1');
        await expect(page.locator('#count-resolved')).toHaveText('2');
        // Pending is active by default.
        await expect(page.locator('.feed-tab[data-tab="pending"]')).toHaveClass(/\bon\b/);
        // The retired controls are gone.
        await expect(page.locator('.view-btn')).toHaveCount(0);
        await expect(page.locator('.feed-kpi')).toHaveCount(0);
    });

    test('@smoke a tab shows that status\'s incidents grouped by building', async ({ page }) => {
        await boot(page);
        // Pending (default): bldA (Apollo, p1+p2) + bldB (T Nagar, p3) — NOT bldC/bldD.
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldA"]')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldB"]')).toBeVisible();
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldC"]')).toHaveCount(0);
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldD"]')).toHaveCount(0);

        // Responding tab → only bldC (Marina).
        await page.locator('.feed-tab[data-tab="responding"]').click();
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldC"]')).toBeVisible({ timeout: 6000 });
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldA"]')).toHaveCount(0);

        // Resolved tab → bldD (Velachery: RESOLVED + FALSE_ALARM).
        await page.locator('.feed-tab[data-tab="resolved"]').click();
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldD"]')).toBeVisible({ timeout: 6000 });
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldC"]')).toHaveCount(0);
    });

    test('@smoke Critical is a cross-cutting quick-filter (not a tab)', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#count-critical')).toHaveText('1', { timeout: 6000 });
        // On the Pending tab, both buildings show; toggling Critical narrows to the
        // one critical pending report (p1 / bldA Apollo).
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldB"]')).toBeVisible({ timeout: 8000 });
        await page.locator('#stat-critical').click();
        await expect(page.locator('#stat-critical')).toHaveClass(/\bon\b/);
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldA"]')).toBeVisible({ timeout: 6000 });
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldB"]')).toHaveCount(0);
        // Toggle off → both buildings return.
        await page.locator('#stat-critical').click();
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldB"]')).toBeVisible({ timeout: 6000 });
    });

    test('@smoke Filters is a popover off the icon; it holds the chips + a Rejected entry', async ({ page }) => {
        await boot(page);
        const row = page.locator('.cmd-filter-row');
        await expect(row).toBeHidden();
        await page.locator('#feed-filter-btn').click();
        await expect(row).toBeVisible();
        await expect(row.locator('.cmd-filter-chip[data-chip="debris"]')).toBeVisible();
        // The Rejected entry lives in the popover (1 rejected report seeded).
        const rej = page.locator('#cmd-filter-rejected');
        await expect(rej).toBeVisible();
        await expect(page.locator('#cmd-rejected-count')).toHaveText('1');
        // Clicking it enters the Rejected view (the only place rejected reports
        // surface) - global + a queue renders the op→building grouped feed, so the
        // rejected report (x1) shows as the only card.
        await rej.click({ force: true, noWaitAfter: true });
        await expect.poll(() => page.evaluate(() => location.hash)).toContain('queue=rejected');
        await expect(page.locator('#report-feed-list .qrt-card[data-report-id="x1"]')).toBeVisible({ timeout: 6000 });
        await expect(page.locator('#report-feed-list .qrt-card')).toHaveCount(1);
    });

    test('@smoke ONE Switch button opens the Global + operations menu', async ({ page }) => {
        await boot(page);
        // Exactly one scope-switch control in the banner (no separate Global/Rejected buttons).
        await expect(page.locator('#feed-scope-bar .qb-actions .ctx-switch')).toHaveCount(1);
        await page.locator('#feed-scope-bar .ctx-switch').click();
        const menu = page.locator('#op-switcher-menu');
        await expect(menu).toBeVisible({ timeout: 6000 });
        await expect(menu).toContainText('Global incidents');
        await expect(menu).toContainText('Chennai Flood Response');
    });

    test('@smoke export query follows the active status tab (must-have #11)', async ({ page }) => {
        await boot(page);
        // Default Pending tab → PENDING,VERIFIED (comma URL-encoded as %2C).
        expect(await page.evaluate(() => (window as any).__crispExportParams())).toContain('status=PENDING%2CVERIFIED');
        await page.locator('.feed-tab[data-tab="responding"]').click();
        expect(await page.evaluate(() => (window as any).__crispExportParams())).toContain('status=RESPONDING');
        await page.locator('.feed-tab[data-tab="resolved"]').click();
        expect(await page.evaluate(() => (window as any).__crispExportParams())).toContain('status=RESOLVED%2CFALSE_ALARM');
    });

    test('@smoke status tabs are neutralized when a queue owns the population', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => { location.hash = '#/incidents;queue=critical'; });
        await expect(page.locator('.feed-tabs.tabs-queue-disabled')).toHaveCount(1, { timeout: 6000 });
        await expect(page.locator('.feed-tab[data-tab="pending"]')).toHaveAttribute('aria-disabled', 'true');
    });
});
