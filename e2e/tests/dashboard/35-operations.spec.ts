/**
 * Dashboard — Operations workspace (Phase 2: cc-operations.js + routing + context).
 *
 * Proves the operator-facing operations surface RUNS end-to-end with every
 * backend call stubbed to the Phase-2a contract (/operations rollup,
 * scoped /analytics/summary, scoped /reports):
 *   • #/operations lists operations worst-first + the un-operationalised
 *     critical cluster CTA (a two-option chooser); a card opens #/operations/{id}.
 *   • #/operations/{id} is a worklist-first dashboard (banner · 4 vitals ·
 *     worklist · action bar) and lights up the triple-cue context chrome.
 *   • The operation context is ABSENT on global routes (/ and /incidents).
 *   • Operations has NO nav button: it is reached from the Home "Active
 *     Operations" rail + its Expand control + deep-links. Nav shows "Incidents".
 *
 * Self-contained: fakes the auth token + stubs all /api/v1 calls — no backend.
 */
import { test, expect } from '@playwright/test';

const NOW = new Date().toISOString();

const OPERATIONS = [
    {
        id: 'op-a', name: 'Bihar Floods', crisis_type: 'FLOOD', status: 'LIVE', is_active: true,
        center_lat: 25.6, center_lng: 85.1, radius_km: 22, place_name: 'Patna, India',
        form_name: 'Flood Assessment v2', started_at: NOW, critical: 5, new_24h: 9, total: 42,
        verified: 7, last_activity: NOW, is_cluster: false,
        health: 'RED', health_reason: '5 unattended critical', responders_active: 2,
    },
    {
        id: 'op-b', name: 'Assam Quake', crisis_type: 'EARTHQUAKE', status: 'LIVE', is_active: true,
        center_lat: 26, center_lng: 92, critical: 0, new_24h: 1, total: 8, last_activity: NOW, is_cluster: false,
        health: 'GREEN', health_reason: 'all clear', responders_active: 0,
    },
    { id: null, name: 'Unassigned critical reports', is_cluster: true, critical: 3, total: 3 },
];

const SUMMARY_SCOPED = {
    generated_at: NOW, window_hours: 24, stale_hours: 24, total_reports: 42,
    counts: {
        active: 30, critical: 5, needs_review: 12, needs_response: 4, active_operations: 6,
        critical_incidents: 5, pending_verification: 8, awaiting_triage: 12, open_dispatch: 4,
        resolved_in_window: 3, active_ops: 6, escalating: 0, stale: 2, sla_at_risk: 1,
    },
    distributions: { by_severity: {}, by_crisis_type: {}, by_status: {}, verified: 10, unverified: 20 },
    timings: {}, impact: {}, deltas: {},
};

const REPORTS = [
    {
        id: 'r1', severity: 'CRITICAL', status: 'PENDING', crisis_type: 'FLOOD', infrastructure_type: 'HOSPITAL',
        crisis_event_id: 'op-a', server_created_at: NOW, location: { latitude: 25.6, longitude: 85.1, device_location_name: 'Patna' },
    },
    { id: 'r2', severity: 'MODERATE', status: 'PENDING', crisis_type: 'FLOOD', crisis_event_id: 'op-a', server_created_at: NOW, location: null },
];

async function boot(page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY_SCOPED });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/operations/launch')) return route.fulfill({ status: 201, json: { operation_id: 'op-new', operation_name: 'Launched', claimed_count: 3, merged_into_existing: false } });
        if (u.includes('/unclaim')) return route.fulfill({ status: 200, json: { operation_id: 'op-a', operation_name: 'Bihar Floods', unclaimed_count: 3 } });
        if (u.includes('/weather')) return route.fulfill({ json: {
            available: true,
            weather: { temperature_c: 31, summary: 'Thunderstorm', humidity_pct: 70, precipitation_mm: 2,
                       wind_kmh: 12, daily: [{ date: '2026-06-14', t_max_c: 33, t_min_c: 26, summary: 'Storm' }],
                       attribution: 'Weather by Open-Meteo.com (CC BY 4.0)' },
            alerts: [{ type: 'FL', name: 'Bihar flood', alert_level: 'Orange', distance_km: 12, country: 'India' }],
        } });
        if (u.includes('/operations')) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/')) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '42' }, json: REPORTS });
        return route.fulfill({ status: 200, json: {} });
    });
}

test.describe('Dashboard — Operations workspace (Phase 2)', () => {
    test('Operations has NO nav button; Incidents stays; the route is still reachable', async ({ page }) => {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(600);
        const nav = page.locator('#cc-nav');
        // The standalone Operations button was removed - operations live on Home.
        await expect(nav.locator('button[data-route="/operations"]')).toHaveCount(0);
        await expect(nav.locator('button[data-route="/incidents"]')).toContainText('Incidents');
        // P2: #/operations is now the operations REGISTRY rendered as the Console's left
        // tree (no separate overlay).
        await page.evaluate(() => { location.hash = '#/operations'; });
        await expect(page.locator('#report-feed-list .opg-reg-toolbar')).toBeVisible({ timeout: 6000 });
        await expect(page.locator('#cc-ops-overlay.cc-ops-open')).toHaveCount(0);
    });

    test('Home "Active Operations" rail: heading renamed + Expand opens the operations registry', async ({ page }) => {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(600);                  // let app.js boot settle
        await page.evaluate(() => (window as any).openControlCenter && (window as any).openControlCenter());
        await expect(page.locator('#cc-home-overlay')).toContainText('Active Operations');
        const expand = page.locator('#cc-ops-expand');
        await expect(expand).toBeVisible();
        await expand.click();
        await expect(page).toHaveURL(/#\/operations\b/);
        // P2: the registry renders in the Console (left tree), not a full-page overlay.
        await expect(page.locator('#report-feed-list .opg-reg-toolbar')).toBeVisible({ timeout: 6000 });
    });

    test('#/operations registry tree: worst-first operations; name opens the panel', async ({ page }) => {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(400);
        await page.evaluate(() => { location.hash = '#/operations'; });
        const reg = page.locator('#report-feed-list');
        await expect(reg.locator('.opg-reg-toolbar')).toBeVisible({ timeout: 6000 });
        await expect(reg.locator('.opg-op').filter({ hasText: 'Bihar Floods' })).toHaveCount(1);
        await expect(reg.locator('.opg-op').filter({ hasText: 'Patna, India' })).toHaveCount(1);
        // worst-first: Bihar (5 critical) ranks above Assam (0 critical).
        const names = await reg.locator('.opg-reg-opname').allTextContents();
        const bihar = names.findIndex((n) => /Bihar/.test(n));
        const assam = names.findIndex((n) => /Assam/.test(n));
        expect(bihar).toBeGreaterThanOrEqual(0);
        expect(assam).toBeGreaterThan(bihar);
        // Search narrows the registry.
        await page.locator('.opg-reg-search').fill('bihar');
        await expect(reg.locator('.opg-op')).toHaveCount(1);
        await page.locator('.opg-reg-search').fill('');
        // Clicking an operation NAME opens it in the right panel (single-page console).
        await reg.locator('.opg-op').filter({ hasText: 'Bihar Floods' }).locator('.opg-reg-opname').click();
        await expect(page.locator('#detail-panel.detail-panel--operation')).toBeVisible({ timeout: 8000 });
        // The registry tree stays visible on the left (active op highlighted).
        await expect(reg.locator('.opg-reg-toolbar')).toBeVisible();
        await expect(reg.locator('.opg-op.cc-cluster-active')).toHaveCount(1);
    });

    test('M4: deep-link to a deleted/unknown operation shows not-found, not a phantom GREEN dashboard', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations/op-zzz');   // id not in the ops list
        await page.waitForTimeout(800);
        // The not-found state renders in the right panel (operations open in-panel now).
        await expect(page.locator('#detail-panel')).toContainText('Operation not found', { timeout: 8000 });
        // Must NOT render the live-looking vitals dashboard (the "all clear" illusion).
        await expect(page.locator('.cco-vital')).toHaveCount(0);
    });

    test('#/operations/{id} opens the operation in the console right-panel (single-page) with context', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations/op-a');
        // Single-page consolidation: the operation opens in the right #detail-panel —
        // NOT a full-page route. The feed (left) stays the incidents view, scoped to op-a.
        const panel = page.locator('#detail-panel.detail-panel--operation');
        await expect(panel).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#view-incidents')).toBeVisible();
        // Context: the command-panel breadcrumb names the operation (always know which op).
        await expect(panel.locator('#cco-command')).toContainText('Bihar Floods', { timeout: 8000 });
        // Redesigned console (Jun 2026): AI command panel + op-scoped duplicate review +
        // local conditions + export action. The vitals / operation map / buildings-reports
        // worklist / Open-Incident-Feed / Exit-to-global row are all REMOVED.
        await expect(panel.locator('#cco-command')).toBeVisible();
        await expect(panel.locator('#cco-dupcheck')).toBeVisible();
        await expect(panel.locator('#cco-weather')).toBeVisible();
        await expect(panel.locator('#cco-act-export')).toBeVisible();
        await expect(panel.locator('.cco-vital')).toHaveCount(0);
        await expect(panel.locator('#cco-map')).toHaveCount(0);
        await expect(panel.locator('#cco-act-feed')).toHaveCount(0);
        await expect(panel.locator('#cco-exit')).toHaveCount(0);
    });

    test('operation context is ABSENT on global routes', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations/op-a');
        await page.waitForTimeout(700);
        await expect(page.locator('body')).toHaveClass(/crisp-op-scoped/);
        await page.evaluate(() => { location.hash = '#/incidents'; });
        await page.waitForTimeout(500);
        await expect(page.locator('body')).not.toHaveClass(/crisp-op-scoped/);
        await expect(page.locator('#cgn-context-banner')).toBeHidden();
        await expect(page.locator('#cgn-scope')).toContainText('GLOBAL');
    });

    test('Phase 3 — health dot + "why" come from the backend (no client heuristic)', async ({ page }) => {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(400);
        await page.evaluate(() => { location.hash = '#/operations'; });
        await expect(page.locator('#report-feed-list .opg-reg-toolbar')).toBeVisible({ timeout: 6000 });
        // P2 registry: the backend health drives each op's coloured dot (RED/AMBER/GREEN);
        // the "why" is the dot's title (health_reason). op-a (Patna) is RED.
        const dot = page.locator('#report-feed-list .opg-op').filter({ hasText: 'Patna' }).locator('.opg-reg-health');
        await expect(dot).toHaveClass(/hc-RED/);
        await expect(dot).toHaveAttribute('title', /unattended critical/);
    });

    test('cluster CTA opens a two-option chooser; "View ungrouped reports" investigates WITHOUT creating an operation', async ({ page }) => {
        await boot(page);
        // No dialog handler: clicking the cluster must NOT fire a window.prompt anymore.
        await page.goto('index.html');
        await page.waitForTimeout(400);
        await page.evaluate(() => { location.hash = '#/operations'; });
        const cta = page.locator('#report-feed-list [data-cluster]');
        await expect(cta).toBeVisible({ timeout: 6000 });
        await cta.click();
        // A deliberate chooser appears with BOTH options - creation is not forced.
        const chooser = page.locator('#cluster-chooser[role="dialog"]');
        await expect(chooser).toBeVisible();
        await expect(chooser.locator('#ccx-view')).toBeVisible();
        await expect(chooser.locator('#ccx-create')).toBeVisible();
        // Option A: View ungrouped reports → global feed + ungrouped queue, no op created.
        await chooser.locator('#ccx-view').click();
        await expect(chooser).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => location.hash)).toContain('/incidents;queue=ungrouped');
        expect(await page.evaluate(() => location.hash)).not.toContain('/operations/');
    });

    test('cluster chooser "Create new operation" opens the wizard (operation creation stays available)', async ({ page }) => {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(400);
        await page.evaluate(() => { location.hash = '#/operations'; });
        const cta = page.locator('#report-feed-list [data-cluster]');
        await expect(cta).toBeVisible({ timeout: 6000 });
        await cta.click();
        await page.locator('#cluster-chooser #ccx-create').click();
        // The deliberate 4-step wizard opens (fromCluster). No forced auto-claim prompt.
        await expect(page.locator('#cc-wiz-overlay.open')).toBeVisible({ timeout: 4000 });
    });

    test('@smoke Export from an operation is SCOPED to that operation (crisis_event_id)', async ({ page }) => {
        await boot(page);
        const exportReqs: string[] = [];
        page.on('request', (r) => { if (r.url().includes('/api/v1/exports/')) exportReqs.push(r.url()); });
        await page.goto('index.html#/operations/op-a');
        await page.waitForTimeout(900);
        await page.locator('#cco-act-export').click();              // → opens the Export Center
        await expect(page.locator('#cc-ex-overlay.cc-ex-open')).toBeVisible({ timeout: 4000 });
        // The "this operation" indicator shows + every export request carries the op id.
        await expect(page.locator('.cc-ex-opscope')).toBeVisible();
        await expect.poll(() => exportReqs.some((u) => /crisis_event_id=op-a/.test(u)), { timeout: 4000 })
            .toBe(true);
        // Every DATA request (count/csv/…) carries the scope — none exports globally.
        // (/exports/recent lists past export JOBS, not report data, so it's unscoped.)
        const dataReqs = exportReqs.filter((u) => !/\/exports\/recent/.test(u));
        expect(dataReqs.length).toBeGreaterThan(0);
        expect(dataReqs.every((u) => /crisis_event_id=op-a/.test(u))).toBe(true);
    });

    test('@smoke operation dashboard shows Local conditions (weather + GDACS alerts)', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations/op-a');
        await page.waitForTimeout(900);
        const wx = page.locator('#cco-weather');
        await expect(wx).toContainText('Thunderstorm', { timeout: 4000 });   // Open-Meteo weather
        await expect(wx).toContainText('Open-Meteo');                        // CC BY 4.0 attribution
        await expect(wx).toContainText('Bihar flood');                      // GDACS hazard alert
    });

    test('@smoke operation scope does NOT leak into the global feed after leaving', async ({ page }) => {
        await boot(page);
        const reportReqs: string[] = [];
        page.on('request', (r) => { const u = r.url(); if (/\/api\/v1\/reports\/?\?/.test(u)) reportReqs.push(u); });
        await page.goto('index.html#/operations/op-a');
        await page.waitForTimeout(900);
        // In the operation, the scope is set + the feed is filtered to it.
        expect(await page.evaluate(() => (window as any).getOperationScope())).toBe('op-a');
        reportReqs.length = 0;
        await page.evaluate(() => { location.hash = '#/incidents'; });
        await page.waitForTimeout(900);
        // Scope is cleared, and any subsequent global feed fetch is NOT scoped.
        expect(await page.evaluate(() => (window as any).getOperationScope())).toBeNull();
        expect(reportReqs.some((u) => /crisis_event_id/.test(u))).toBe(false);
    });
});

// The op-console "Open Incident Feed" button + the Buildings/Reports worklist were
// REMOVED in the Jun 2026 console redesign: the scoped feed is already the left pane,
// so incidents are clicked there directly (no second worklist). The incident-click →
// op-scoped-feed + list-left/detail-right behaviour is covered by the feed's own specs;
// the auto-scroll case below still exercises the deep-link path on the feed.

test.describe('Dashboard — auto-scroll to the selected incident in a long/grouped feed (v64)', () => {
    // A large op-scoped fixture: 60 PENDING (the default tab) so progressive
    // disclosure (>50) hides the tail, plus one RESPONDING + one RESOLVED, which
    // live in the OTHER lifecycle tabs (Responding / Resolved) and so are filtered
    // out of the default view. The deep-linked incident must end up visible +
    // highlighted regardless of which bucket/tab it lands in (selectReport switches
    // to its tab so the card renders, then CrispNav scrolls to it).
    const NOW2 = new Date().toISOString();
    function manyReports() {
        const arr = [];
        for (let i = 0; i < 59; i++) {
            arr.push({ id: 'p' + i, severity: 'MODERATE', status: 'PENDING', crisis_type: 'WILDFIRE',
                infrastructure_type: 'HOUSE', crisis_event_id: 'op-a', server_created_at: NOW2,
                location: { latitude: 12.9, longitude: 77.6, device_location_name: 'Electronic City' } });
        }
        // Lowest severity ⇒ sorts to the BOTTOM of NEEDS HELP (index ~59, past the 50 cutoff).
        arr.push({ id: 'p-target', severity: 'MINOR', status: 'PENDING', crisis_type: 'WILDFIRE',
            infrastructure_type: 'HOUSE', crisis_event_id: 'op-a', server_created_at: NOW2,
            location: { latitude: 12.9, longitude: 77.6, device_location_name: 'Electronic City' } });
        // RESPONDING ⇒ HELP SENT (collapsed by default); RESOLVED ⇒ CLOSED (collapsed).
        arr.push({ id: 'dispatched-1', severity: 'SEVERE', status: 'RESPONDING', crisis_type: 'WILDFIRE',
            infrastructure_type: 'GOVERNMENT', crisis_event_id: 'op-a', server_created_at: NOW2,
            location: { latitude: 12.9, longitude: 77.6, device_location_name: 'Electronic City' } });
        arr.push({ id: 'closed-1', severity: 'MODERATE', status: 'RESOLVED', crisis_type: 'WILDFIRE',
            crisis_event_id: 'op-a', server_created_at: NOW2, location: null });
        return arr;
    }
    const REPORTS_MANY = manyReports();

    async function bootMany(page) {
        await page.addInitScript(() => {
            localStorage.setItem('crisp_token', 'e2e-fake-token');
            localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
        });
        await page.route('**/api/v1/**', async (route) => {
            const u = route.request().url();
            if (u.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY_SCOPED });
            if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
            if (u.includes('/weather')) return route.fulfill({ json: { available: false } });
            if (u.includes('/operations')) return route.fulfill({ json: OPERATIONS });
            if (u.includes('/reports/')) return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(REPORTS_MANY.length) }, json: REPORTS_MANY });
            return route.fulfill({ status: 200, json: {} });
        });
    }

    // "Visible on the screen" = in the browser viewport. toBeInViewport is a
    // web-first assertion (auto-retries until the smooth scroll settles) and is
    // agnostic to WHICH element scrolls, so it's robust where hand-rolled rect
    // math against #report-feed-list was flaky.
    async function expectRevealed(page, id) {
        const card = page.locator(`.qrt-card[data-id="${id}"]`);
        await expect(card).toBeVisible({ timeout: 8000 });            // not display:none (progressive) / collapsed
        await expect(card).toBeInViewport({ ratio: 0.5, timeout: 8000 });  // scrolled onto the screen
        await expect(card).toHaveClass(/(^|\s)(is-selected|selected)(\s|$)/);   // clearly highlighted
    }

    test('@smoke a far-down incident (progressive-hidden past 50) is revealed, scrolled to + highlighted', async ({ page }) => {
        await bootMany(page);
        await page.goto('index.html#/incidents;op=op-a?incident=p-target');
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
        await expectRevealed(page, 'p-target');
    });

    test('@smoke a RESPONDING incident (other tab) auto-switches tab, scrolls + highlights', async ({ page }) => {
        await bootMany(page);
        await page.goto('index.html#/incidents;op=op-a?incident=dispatched-1');
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
        // It lives in the Responding tab (filtered out of the default Pending view);
        // the reveal must switch to that tab so the card renders + scrolls into view.
        await expectRevealed(page, 'dispatched-1');
    });

    test('@smoke a RESOLVED incident (other tab) is also revealed + scrolled to', async ({ page }) => {
        await bootMany(page);
        await page.goto('index.html#/incidents;op=op-a?incident=closed-1');
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
        await expectRevealed(page, 'closed-1');
    });
});
