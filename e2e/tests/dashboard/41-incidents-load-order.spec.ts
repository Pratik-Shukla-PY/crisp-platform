/**
 * Dashboard — Incidents load-order / operation-context integrity.
 *
 * Root-cause guard for the "flash of GLOBAL incidents" bug on Operation → Incident
 * navigation. The required flow is: read route → determine context → fetch the
 * CORRECT dataset → render ONCE. The page must NEVER paint the global feed first.
 *
 * The flash is transient, so we catch it deterministically: a MutationObserver
 * (installed via addInitScript) records the data-id of EVERY incident card that
 * ever appears in #report-feed-list. With distinct global vs operation-scoped
 * datasets + a delayed scoped response, we assert no global-only id is ever
 * painted while navigating into an operation.
 *
 * Self-contained: fakes auth + stubs all /api/v1 calls (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();

const OPERATIONS = [
    { id: 'op-a', name: 'Bihar Floods', crisis_type: 'FLOOD', status: 'LIVE', is_active: true,
      center_lat: 25.6, center_lng: 85.1, radius_km: 22, place_name: 'Patna, India',
      critical: 1, new_24h: 2, total: 2, verified: 0, last_activity: NOW, is_cluster: false,
      health: 'RED', health_reason: '1 critical', responders_active: 0 },
];

const SUMMARY = {
    generated_at: NOW, window_hours: 24, stale_hours: 24, total_reports: 2,
    counts: { active: 2, critical: 1, needs_review: 2, needs_response: 0, active_operations: 1,
        critical_incidents: 1, pending_verification: 2, awaiting_triage: 2, open_dispatch: 0,
        resolved_in_window: 0, active_ops: 1, escalating: 0, stale: 0, sla_at_risk: 0 },
    distributions: { by_severity: {}, by_crisis_type: {}, by_status: {}, verified: 0, unverified: 2 },
    timings: {}, impact: {}, deltas: {},
};

const loc = (name: string) => ({ latitude: 25.6, longitude: 85.1, device_location_name: name });
// GLOBAL feed (no operation) — these ids must NEVER appear when scoped to op-a.
const GLOBAL_REPORTS = [
    { id: 'g1', severity: 'CRITICAL', status: 'PENDING', crisis_type: 'EARTHQUAKE', infrastructure_type: 'HOSPITAL', crisis_event_id: null, server_created_at: NOW, location: loc('Delhi') },
    { id: 'g2', severity: 'MODERATE', status: 'PENDING', crisis_type: 'FIRE', crisis_event_id: null, server_created_at: NOW, location: loc('Mumbai') },
];
// OPERATION op-a feed.
const OP_REPORTS = [
    { id: 'r1', severity: 'CRITICAL', status: 'PENDING', crisis_type: 'FLOOD', infrastructure_type: 'HOSPITAL', crisis_event_id: 'op-a', server_created_at: NOW, location: loc('Patna') },
    { id: 'r2', severity: 'MODERATE', status: 'PENDING', crisis_type: 'FLOOD', crisis_event_id: 'op-a', server_created_at: NOW, location: loc('Gaya') },
];

// Records every incident-card id ever painted into the feed (catches a 1-frame flash).
async function installFlashDetector(page: Page) {
    await page.addInitScript(() => {
        (window as any).__seenFeedIds = [];
        const seen = new Set<string>();
        const rec = (root: any) => {
            if (!root || !root.querySelectorAll) return;
            const sel = '.qrt-card[data-id],.tree-incident[data-id]';
            const add = (el: any) => { const id = el.getAttribute && el.getAttribute('data-id'); if (id && !seen.has(id)) { seen.add(id); (window as any).__seenFeedIds.push(id); } };
            if (root.matches && root.matches(sel)) add(root);
            root.querySelectorAll(sel).forEach(add);
        };
        const obs = new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n: any) => { if (n.nodeType === 1) rec(n); })));
        const start = () => {
            const feed = document.getElementById('report-feed-list');
            if (feed) { rec(feed); obs.observe(feed, { childList: true, subtree: true }); }
            else setTimeout(start, 30);
        };
        start();
    });
}

async function boot(page: Page, delayScopedMs = 350) {
    await installFlashDetector(page);
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
    });
    const reportListReqs: string[] = [];
    (page as any).__reportListReqs = reportListReqs;
    page.on('request', (r) => {
        const u = r.url();
        // Only the FEED list endpoint - exclude the always-global pending-deletions
        // probe (?pending_deletion=true) and the lean markers endpoint.
        if (/\/api\/v1\/reports\/?\?/.test(u) && !/pending_deletion/.test(u) && !/\/reports\/markers/.test(u)) reportListReqs.push(u);
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        const single = u.match(/\/reports\/(g1|g2|r1|r2)(?:\?|$)/);
        if (single) {
            const rep = [...GLOBAL_REPORTS, ...OP_REPORTS].find((x) => x.id === single[1]);
            return route.fulfill({ status: rep ? 200 : 404, json: rep || {} });
        }
        if (u.includes('/operations')) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/')) {
            const scoped = /crisis_event_id=op-a/.test(u);
            if (scoped && delayScopedMs) await new Promise((r) => setTimeout(r, delayScopedMs));
            const list = scoped ? OP_REPORTS : GLOBAL_REPORTS;
            return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(list.length) }, json: list });
        }
        return route.fulfill({ status: 200, json: {} });
    });
}

const seenIds = (page: Page) => page.evaluate(() => (window as any).__seenFeedIds.slice());

test.describe('Dashboard — Incidents load-order / operation-context integrity', () => {
    test('@smoke Operation → Incident: NEVER flashes the global feed; loads scoped once + auto-opens', async ({ page }) => {
        await boot(page);
        // First land on the GLOBAL feed so the feed DOM holds global cards (the
        // stale state that used to flash on the next navigation).
        await page.goto('index.html#/incidents');
        // These reports have no building_id → collapsed Ungrouped in buildings-default.
        // Switch to flat queue so the load-order guard can see individual cards.
        await page.evaluate(() => (window as any).setViewMode && (window as any).setViewMode('queue'));
        await expect(page.locator('.qrt-card[data-id="g1"]')).toHaveCount(1, { timeout: 8000 });   // present in the DOM (collapsed Ungrouped cluster; flat queue retired v111)

        // From here, navigate to the operation-scoped incident (what the operation
        // worklist click / deep-link produces). Reset the flash recorder first so
        // we only judge what paints DURING this navigation.
        await page.evaluate(() => { (window as any).__seenFeedIds.length = 0; });
        await page.evaluate(() => { location.hash = '#/incidents;op=op-a?incident=r1'; });

        // While the scoped fetch is in flight, a scope-named LOADING state shows -
        // NOT the global list. (Pre-fix: no loading state existed AND the stale
        // global cards lingered in the revealed DOM → this assertion fails.)
        await expect(page.locator('#report-feed-list .feed-loading-state')).toBeVisible({ timeout: 3000 });
        // The stale global cards were REMOVED (innerHTML replaced), not merely
        // hidden behind the reveal - so nothing global is on screen for a frame.
        await expect(page.locator('#report-feed-list .qrt-card[data-id="g1"]')).toHaveCount(0);
        await expect(page.locator('#report-feed-list .qrt-card[data-id="g2"]')).toHaveCount(0);

        // Then the operation incident opens (detail on the right) + scoped list left.
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('.qrt-card[data-id="r1"]')).toHaveCount(1, { timeout: 8000 });   // scoped card present (in its building/Ungrouped cluster); detail auto-opens separately
        await expect(page.locator('.qrt-card[data-id="r2"]')).toHaveCount(1);

        // THE GUARD: no global-only card was ever painted during the navigation.
        const seen = await seenIds(page);
        expect(seen, `feed painted global ids during op nav: ${JSON.stringify(seen)}`).not.toContain('g1');
        expect(seen).not.toContain('g2');
        expect(seen).toContain('r1');

        // The scope-bar header names the OPERATION (v116: breadcrumb shows the op name
        // + carries the ctx-op scope class) before the list, so the scope is unambiguous.
        await expect(page.locator('#feed-scope-bar')).toHaveClass(/ctx-op/);
    });

    test('@smoke cold refresh of an operation-incident URL: no global request, loading state, auto-open', async ({ page }) => {
        await boot(page);
        // Land DIRECTLY on the deep link (refresh scenario).
        await page.goto('index.html#/incidents;op=op-a?incident=r1');

        // The operation incident loads + auto-opens. (The scope-named loading state
        // is asserted deterministically in the in-session test above; on a cold
        // boot its visibility window races world-data load, so here we assert the
        // stronger, deterministic invariants below: no global fetch, no global card
        // ever painted.)
        await expect(page.locator('.qrt-card[data-id="r1"]')).toHaveCount(1, { timeout: 8000 });   // scoped card present (in its building/Ungrouped cluster); detail auto-opens separately
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });

        // No global card EVER painted.
        const seen = await seenIds(page);
        expect(seen).not.toContain('g1');
        expect(seen).not.toContain('g2');

        // Network proof of "single, correct load": every reports-LIST request was
        // operation-scoped - the global feed was never fetched first.
        const reqs: string[] = (page as any).__reportListReqs;
        expect(reqs.length, 'expected at least one reports request').toBeGreaterThan(0);
        for (const u of reqs) {
            expect(u, `a NON-scoped (global) reports request was issued: ${u}`).toMatch(/crisis_event_id=op-a/);
        }
    });

    test('@smoke cold load with a STALE GLOBAL cache present never flashes the cached global incidents', async ({ page }) => {
        await boot(page);
        // Seed the report cache with GLOBAL data, as if a prior global session left
        // it behind (the path that used to paint instantly via _loadCachedReports).
        await page.addInitScript((payload) => {
            try { localStorage.setItem('crisp_reports_v1', payload as string); } catch (_e) {}
        }, JSON.stringify({ ts: Date.now(), data: GLOBAL_REPORTS }));

        await page.goto('index.html#/incidents;op=op-a?incident=r1');
        await expect(page.locator('.qrt-card[data-id="r1"]')).toHaveCount(1, { timeout: 8000 });   // scoped card present (in its building/Ungrouped cluster); detail auto-opens separately

        // The stale GLOBAL cache (g1/g2) must NEVER paint - the scoped boot skips the
        // cache and the loading state masks it until the operation dataset arrives.
        const seen = await seenIds(page);
        expect(seen, `stale global cache flashed: ${JSON.stringify(seen)}`).not.toContain('g1');
        expect(seen).not.toContain('g2');
        expect(seen).toContain('r1');
    });

    test('@smoke Back/Forward keeps the correct context (op ↔ global) with no cross-scope flash', async ({ page }) => {
        await boot(page, 0);   // no artificial delay for the history walk
        await page.goto('index.html#/incidents');
        // Reports have no building_id → collapsed Ungrouped in buildings-default.
        // One setViewMode call persists across hash-only SPA navigations (no page reload).
        await page.evaluate(() => (window as any).setViewMode && (window as any).setViewMode('queue'));
        await expect(page.locator('.qrt-card[data-id="g1"]')).toHaveCount(1, { timeout: 8000 });   // present in the DOM (collapsed Ungrouped cluster; flat queue retired v111)

        await page.evaluate(() => { location.hash = '#/incidents;op=op-a'; });
        await expect(page.locator('.qrt-card[data-id="r1"]')).toHaveCount(1, { timeout: 8000 });   // scoped card present (in its building/Ungrouped cluster); detail auto-opens separately
        await expect(page.locator('.qrt-card[data-id="g1"]')).toHaveCount(0);   // global gone

        // Back → global feed restored.
        await page.evaluate(() => { (window as any).__seenFeedIds.length = 0; });
        await page.goBack();
        await expect(page.locator('.qrt-card[data-id="g1"]')).toHaveCount(1, { timeout: 8000 });   // present in the DOM (collapsed Ungrouped cluster; flat queue retired v111)
        await expect(page.locator('.qrt-card[data-id="r1"]')).toHaveCount(0);

        // Forward → operation feed restored, and no global id painted on the way.
        await page.evaluate(() => { (window as any).__seenFeedIds.length = 0; });
        await page.goForward();
        await expect(page.locator('.qrt-card[data-id="r1"]')).toHaveCount(1, { timeout: 8000 });   // scoped card present (in its building/Ungrouped cluster); detail auto-opens separately
        const seen = await seenIds(page);
        expect(seen).not.toContain('g1');
        expect(seen).not.toContain('g2');
    });
});
