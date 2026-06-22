/**
 * Dashboard — Incident Feed redesign (v116).
 *
 * Locks in the flattened, scan-fast feed panel:
 *   - the header is the scope breadcrumb (Global › Operation) + the Switch button;
 *     the old standalone #queue-banner context card is gone;
 *   - the dual total (N incidents · M reports) lives in the status-tab row (#count-dual);
 *   - clicking anywhere on a building card expands its incidents inline AND opens the
 *     Building Console on the right, accordion-style (only one building open at a time);
 *   - Compact density is an opt-in toggle persisted as crisp_feed_density;
 *   - the building list infinite-scrolls (10 at a time) with a sentinel.
 *
 * Self-contained: fake token + stubbed /api/v1/** (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const OPERATIONS = [{ id: 'op-a', name: 'Chennai Flood Response', place_name: 'Chennai', status: 'LIVE', is_active: true, critical: 1 }];

// 30 buildings (one report each) so the 10-per-page window leaves a sentinel even
// after it eagerly fills the first viewport.
const N_BLD = 30;
const REPORTS = Array.from({ length: N_BLD }, (_, i) => {
    const n = i + 1;
    return {
        id: 'r' + n, building_id: 'bld' + n, infrastructure_name: 'Building ' + n,
        infrastructure_name_from_osm: true, infrastructure_type: 'HOSPITAL',
        severity: i < 3 ? 'CRITICAL' : 'MODERATE', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED',
        crisis_type: 'FLOOD', crisis_event_id: 'op-a', server_created_at: NOW, client_created_at: NOW,
        location: { latitude: 13 + n / 1000, longitude: 80 + n / 1000, user_location_name: 'Zone ' + n },
        media: [],
    };
});

function bldDetail(id: string) {
    return {
        id, state: 'ACTIVE', severity_max: 'CRITICAL', report_count: 1,
        verified_report_count: 0, responding_report_count: 0, debris_clearing_needed_count: 0,
        crisis_types_top3: ['FLOOD'], centroid_lat: 13.01, centroid_lng: 80.01, osm_name: 'Building ' + id.replace('bld', ''),
        severity_score: 60, confidence_score: 50, activity_score: 40, escalation_risk: 30, humanitarian_priority: 55,
        first_report_at: NOW, latest_report_at: NOW,
        reports: REPORTS.filter((r) => r.building_id === id), responders: [], monitors: [], notes: [], assessment: null,
    };
}

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'SUPER_ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: { reports: REPORTS.length }, distributions: {}, timings: {}, impact: {}, deltas: {} } });
        if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/reports/buildings-needing-review')) return route.fulfill({ json: { buildings: [], total_buildings: 0, total_pairs: 0 } });
        const bm = u.match(/\/buildings\/(bld\d+)(\?|$)/);
        if (bm) return route.fulfill({ json: bldDetail(bm[1]) });
        if (/\/reports\/?\?/.test(u)) {
            const scoped = /crisis_event_id=op-a/.test(u);
            const list = scoped ? REPORTS.filter((r) => r.crisis_event_id === 'op-a') : REPORTS;
            return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(list.length) }, json: list });
        }
        const single = u.match(/\/reports\/(r\d+)(?:\?|$)/);
        if (single) return route.fulfill({ json: REPORTS.find((r) => r.id === single[1]) || {} });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await page.waitForTimeout(300);
}

const clusterCount = (page: Page) => page.locator('#report-feed-list .cc-cluster').count();

test.describe('Dashboard — Incident Feed redesign (v116)', () => {
    test('@smoke header is the scope breadcrumb + Switch; the standalone banner is gone', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#queue-banner')).toHaveCount(0);
        const bar = page.locator('.feed-panel .feed-header #feed-scope-bar');
        await expect(bar).toBeVisible({ timeout: 8000 });
        await expect(bar.locator('.qb-crumbs')).toContainText('Global');
        await expect(bar.locator('.ctx-switch')).toHaveCount(1);
        // No leftover static "Incident Feed" title in the header.
        await expect(page.locator('.feed-panel .feed-header h2')).toHaveCount(0);
    });

    test('@smoke breadcrumb shows Global › Operation when scoped', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => { location.hash = '#/incidents;op=op-a'; });
        await expect(page.locator('#feed-scope-bar .qb-crumbs')).toContainText('Global', { timeout: 8000 });
        await expect(page.locator('#feed-scope-bar .qb-crumbs')).toContainText('Chennai Flood Response');
        await expect(page.locator('#feed-scope-bar .ctx-switch')).toBeVisible();
    });

    test('@smoke scope total (N reports) is in the header next to the scope crumb — single metric, no "· M" dual', async ({ page }) => {
        await boot(page);
        const dual = page.locator('#feed-scope-bar .qb-total');
        // The header total is REPORTS (the superset), matching the home "Total reports"
        // tile so the two surfaces never disagree.
        await expect(dual).toContainText('report', { timeout: 8000 });
        await expect(dual).toContainText(String(N_BLD));
        // Single metric — no confusing "· M …" dual.
        await expect(dual).not.toContainText('·');
    });

    test('@smoke building NAME opens the console; header toggles incidents (multi-open tree)', async ({ page }) => {
        await boot(page);
        const b1 = page.locator('#report-feed-list .cc-cluster[data-cluster-key="b:bld1"]');
        const b2 = page.locator('#report-feed-list .cc-cluster[data-cluster-key="b:bld2"]');
        // Clicking the building NAME expands it + active ring + opens the console.
        await b1.locator('.cc-cluster-name-link').click();
        await expect(b1).not.toHaveClass(/collapsed/);
        await expect(b1).toHaveClass(/cc-cluster-active/);
        await expect(page.locator('#detail-panel.detail-panel--building')).toBeVisible({ timeout: 8000 });
        // Expanding a SECOND building via its header does NOT collapse the first
        // (multi-open tree, so Expand-all works). The console stays with b1 until b2's
        // NAME is clicked.
        await b2.locator('.qrt-section-header').click();
        await expect(b2).not.toHaveClass(/collapsed/);
        await expect(b1).not.toHaveClass(/collapsed/);
        await expect(b1).toHaveClass(/cc-cluster-active/);
        await b2.locator('.cc-cluster-name-link').click();
        await expect(b2).toHaveClass(/cc-cluster-active/);
        await expect(b1).not.toHaveClass(/cc-cluster-active/);
    });

    test('@smoke Expand all / Collapse all controls every building', async ({ page }) => {
        await boot(page);
        const tb = page.locator('#report-feed-list .opg-toolbar');
        await expect(tb).toBeVisible();
        await tb.locator('[data-cc-all="expand"]').click();
        await expect(page.locator('#report-feed-list .cc-cluster.collapsed')).toHaveCount(0);
        await tb.locator('[data-cc-all="collapse"]').click();
        await expect(page.locator('#report-feed-list .cc-cluster:not(.collapsed)')).toHaveCount(0);
    });

    test('@smoke a force-open scope does NOT leave buildings stuck-expanded in the global feed', async ({ page }) => {
        // Regression: a force-open scope (building/triage/queue) used to write EVERY cluster
        // key into the persistent _expandedClusters Set, so afterwards every building rendered
        // expanded in the global feed (the operator's "clicking one incident expands
        // everything"). Force-open must be render-only — never persisted.
        await boot(page);
        const sel = '#report-feed-list .cc-cluster[data-cluster-key="b:bld1"]';
        await expect(page.locator(sel)).toHaveClass(/collapsed/);   // global feed: collapsed by default
        // Enter a force-open BUILDING scope (bld1 force-expands there)…
        await page.evaluate(() => { location.hash = '#/incidents;bld=bld1'; });
        await page.waitForTimeout(500);
        // …then return to the global feed.
        await page.evaluate(() => { location.hash = '#/incidents'; });
        await page.waitForTimeout(500);
        // bld1 must be COLLAPSED again — the force-open did not pollute the persistent state.
        await expect(page.locator(sel)).toBeVisible({ timeout: 8000 });
        await expect(page.locator(sel)).toHaveClass(/collapsed/);
    });

    test('@smoke a failing building fetch shows a recoverable error, not an endless spinner', async ({ page }) => {
        await boot(page);
        // Make this building's console fetch fail (e.g. a 500 / busy backend).
        await page.route('**/api/v1/buildings/bld1*', (r) => r.fulfill({ status: 500, json: { detail: 'boom' } }));
        await page.locator('#report-feed-list .cc-cluster[data-cluster-key="b:bld1"] .cc-cluster-name-link').click();
        // The console shows an error + Retry, and is NOT stuck on the loading spinner.
        await expect(page.locator('#detail-panel .bc-error')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#detail-panel .bc-retry')).toBeVisible();
        await expect(page.locator('#detail-panel .bc-loading')).toHaveCount(0);
    });

    test('@smoke Compact density toggles + persists across reload', async ({ page }) => {
        await boot(page);
        const list = page.locator('#report-feed-list');
        await expect(list).not.toHaveClass(/feed-compact/);   // Comfortable default
        await page.locator('#feed-density').click();
        await expect(list).toHaveClass(/feed-compact/);
        expect(await page.evaluate(() => localStorage.getItem('crisp_feed_density'))).toBe('compact');
        // Persists: reload keeps Compact.
        await page.reload();
        await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 15000 });
        await page.evaluate(() => { location.hash = '#/incidents'; });
        await page.waitForTimeout(300);
        await expect(page.locator('#report-feed-list')).toHaveClass(/feed-compact/);
    });

    test('@smoke building list infinite-scrolls (windowed, loads the rest on scroll)', async ({ page }) => {
        // Windowing is the FLAT building-list path — the no-operation / scoped view. With
        // operations assigned, the Global feed groups buildings under their op instead (v134),
        // so this test uses an all-unassigned set to exercise the flat windowed path.
        const FLAT = REPORTS.map((r) => ({ ...r, crisis_event_id: null }));
        await page.addInitScript(() => {
            localStorage.setItem('crisp_token', 'e2e-fake-token');
            localStorage.setItem('crisp_user', JSON.stringify({ role: 'SUPER_ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
        });
        await page.route('**/api/v1/**', async (route) => {
            const u = route.request().url();
            if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: { reports: FLAT.length }, distributions: {}, timings: {}, impact: {}, deltas: {} } });
            if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: [] });
            if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
            if (u.includes('/reports/buildings-needing-review')) return route.fulfill({ json: { buildings: [] } });
            if (/\/reports\/?\?/.test(u)) return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(FLAT.length) }, json: FLAT });
            return route.fulfill({ status: 200, json: {} });
        });
        await page.goto('index.html');
        await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 15000 });
        await page.evaluate(() => { location.hash = '#/incidents'; });
        await page.waitForTimeout(300);
        // Windowed: not all 30 building cards render up front, and a sentinel is present.
        await expect(page.locator('#report-feed-list .feed-bld-sentinel')).toBeVisible({ timeout: 8000 });
        const initial = await clusterCount(page);
        expect(initial).toBeGreaterThan(0);
        expect(initial).toBeLessThan(N_BLD);
        await expect(page.locator('#report-feed-list .feed-bld-sentinel')).toContainText('/ ' + N_BLD);
        // Bring the sentinel into view repeatedly → it intersects → the next page
        // renders, until everything is shown and the sentinel disappears.
        await expect.poll(async () => {
            const sent = page.locator('#report-feed-list .feed-bld-sentinel');
            if (await sent.count()) { try { await sent.scrollIntoViewIfNeeded({ timeout: 1000 }); } catch (_e) {} }
            await page.waitForTimeout(150);
            return clusterCount(page);
        }, { timeout: 12000 }).toBe(N_BLD);
        await expect(page.locator('#report-feed-list .feed-bld-sentinel')).toHaveCount(0);
    });
});
