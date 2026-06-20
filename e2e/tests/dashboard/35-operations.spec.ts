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
        // The route remains fully reachable via deep-link (zero orphaned nav path).
        await page.evaluate(() => { location.hash = '#/operations'; });
        await expect(page.locator('#cc-ops-overlay #cco-list')).toBeVisible({ timeout: 6000 });
    });

    test('Home "Active Operations" rail: heading renamed + Expand opens #/operations', async ({ page }) => {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(600);                  // let app.js boot settle
        await page.evaluate(() => (window as any).openControlCenter && (window as any).openControlCenter());
        // Rename: the section reads "Active Operations" (was "Active Response").
        await expect(page.locator('.cc-zone-response')).toContainText('Active Operations');
        // The Expand control opens the full operations management view.
        const expand = page.locator('#cc-ops-expand');
        await expect(expand).toBeVisible();
        await expand.click();
        await expect(page).toHaveURL(/#\/operations\b/);
        await expect(page.locator('#cc-ops-overlay #cco-list')).toBeVisible({ timeout: 6000 });
    });

    test('#/operations lists operations worst-first + cluster CTA; a card opens the detail', async ({ page }) => {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(400);
        await page.evaluate(() => { location.hash = '#/operations'; });
        const list = page.locator('#cc-ops-overlay #cco-list');
        await expect(list).toContainText('Bihar Floods', { timeout: 6000 });
        await expect(list).toContainText('no operation');           // un-operationalised cluster CTA
        // The unified card renders the new fields: status badge, form name, place,
        // verified count, and an inline-SVG mini-map (no Leaflet per card).
        const card = page.locator('#cco-list [data-op="op-a"]');
        await expect(card.locator('.opc-badge')).toContainText('LIVE');
        await expect(card).toContainText('Flood Assessment v2');
        await expect(card).toContainText('Patna, India');
        await expect(card).toContainText('Verified');
        await expect(card.locator('svg.opc-mm')).toHaveCount(1);
        // worst-first: Bihar (5 critical) ranks above Assam (0 critical).
        const names = await page.locator('#cco-list .opc-name').allTextContents();
        const bihar = names.findIndex((n) => /Bihar/.test(n));
        const assam = names.findIndex((n) => /Assam/.test(n));
        expect(bihar).toBeGreaterThanOrEqual(0);
        expect(assam).toBeGreaterThan(bihar);
        await card.click();
        await expect.poll(() => page.evaluate(() => location.hash)).toContain('/operations/op-a');
    });

    test('M4: deep-link to a deleted/unknown operation shows not-found, not a phantom GREEN dashboard', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations/op-zzz');   // id not in the ops list
        await page.waitForTimeout(800);
        const wrap = page.locator('#cco-wrap');
        await expect(wrap).toContainText('Operation not found', { timeout: 6000 });
        // Must NOT render the live-looking vitals dashboard (the "all clear" illusion).
        await expect(page.locator('#cco-vitals')).toHaveCount(0);
    });

    test('#/operations/{id} is a worklist dashboard with the triple-cue context chrome', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations/op-a');
        await page.waitForTimeout(900);
        // Cue 1+2+3: op-scoped chrome + persistent context banner + breadcrumb.
        await expect(page.locator('body')).toHaveClass(/crisp-op-scoped/);
        const banner = page.locator('#cgn-context-banner');
        await expect(banner).toBeVisible();
        await expect(banner).toContainText('Bihar Floods');
        // Symmetric scope chip flips to OP mode.
        await expect(page.locator('#cgn-scope')).toContainText('OP', { timeout: 4000 });
        // 4 vitals from the scoped summary (Critical = 5).
        await expect(page.locator('.cco-vital.crit')).toContainText('5');
        await expect(page.locator('#cco-vitals')).toContainText('Needs review');
        // worklist from the scoped reports.
        await expect(page.locator('#cco-wl')).toContainText(/Flood/i);
        // action bar present.
        await expect(page.locator('#cco-act-feed')).toBeVisible();
        // Exit to global clears the operation context.
        await banner.locator('.cgn-cb-exit').click();
        await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('/operations');
        await expect(page.locator('body')).not.toHaveClass(/crisp-op-scoped/);
        // The scope chip returns to its affirmative GLOBAL state.
        await expect(page.locator('#cgn-scope')).toContainText('GLOBAL', { timeout: 4000 });
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
        const row = page.locator('#cco-list [data-op="op-a"]');
        await expect(row).toBeVisible({ timeout: 6000 });
        // Redesigned card: the backend health drives the situation PILL (coloured
        // dot + R/A/G label) — the "why" is the pill's title (health_reason).
        const dot = row.locator('.opc-pill-dot');
        await expect(dot).toHaveCSS('background-color', 'rgb(248, 113, 113)');   // RED
        await expect(row.locator('.opc-pill')).toHaveAttribute('title', /unattended critical/);
    });

    test('cluster CTA opens a two-option chooser; "View ungrouped reports" investigates WITHOUT creating an operation', async ({ page }) => {
        await boot(page);
        // No dialog handler: clicking the cluster must NOT fire a window.prompt anymore.
        await page.goto('index.html');
        await page.waitForTimeout(400);
        await page.evaluate(() => { location.hash = '#/operations'; });
        const cta = page.locator('#cco-list [data-cluster]');
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
        const cta = page.locator('#cco-list [data-cluster]');
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

test.describe('Dashboard — operation incident click → Incident Feed (v63)', () => {
    test('@smoke the action button is renamed "Open Incident Feed"', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations/op-a');
        const btn = page.locator('#cco-act-feed');
        await expect(btn).toBeVisible();
        await expect(btn).toHaveText('Open Incident Feed');     // was "Open full incident feed"
        await expect(btn).not.toHaveText(/full/i);
    });

    test('@smoke clicking an operation incident opens the op-scoped Incident Feed with that report selected (list left + detail right)', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations/op-a');

        // Buildings is the default operational worklist now; switch to the Reports tab
        // to click an individual incident.
        await page.locator('.cco-tab[data-wl="reports"]').click();
        const row = page.locator('#cco-wl .cco-wl-row[data-id="r1"]');
        await expect(row).toBeVisible();
        await row.click();

        // 1) Redirected OFF the operation dashboard to the Incident Feed page,
        //    scoped to the operation, with the incident deep-linked.
        await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/incidents;op=op-a?incident=r1');
        await expect(page.locator('#view-incidents')).toBeVisible();

        // 2) The detailed incident report opens on the RIGHT.
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });

        // 3) The feed LIST on the left shows the operation's incidents with the
        //    selected one highlighted (CrispNav.markSelected → .is-selected /
        //    renderFeed → .selected). It stays a LIST (r2 is still shown), not
        //    filtered down to a single incident.
        const card = page.locator('.tree-incident[data-id="r1"], .qrt-card[data-id="r1"]').first();
        await expect(card).toBeVisible({ timeout: 8000 });
        await expect(card).toHaveClass(/is-selected|selected/);
        await expect(page.locator('.tree-incident[data-id="r2"], .qrt-card[data-id="r2"]').first()).toBeVisible();
    });

    test('@smoke keyboard (Enter) on an incident row also opens it in the Incident Feed', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations/op-a');
        // Buildings is the default operational worklist now; switch to the Reports tab.
        await page.locator('.cco-tab[data-wl="reports"]').click();
        const row = page.locator('#cco-wl .cco-wl-row[data-id="r2"]');
        await expect(row).toBeVisible();
        await row.focus();
        await row.press('Enter');
        await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/incidents;op=op-a?incident=r2');
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
    });
});

test.describe('Dashboard — auto-scroll to the selected incident in a long/grouped feed (v64)', () => {
    // A large op-scoped fixture: 60 PENDING (NEEDS HELP) so progressive disclosure
    // (>50) hides the tail, plus one RESPONDING (HELP SENT) + one RESOLVED (CLOSED),
    // both of which start COLLAPSED by default. The deep-linked incident must end up
    // visible + highlighted regardless of which bucket it lands in.
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

    test('@smoke an incident in a default-COLLAPSED section (HELP SENT) auto-expands, scrolls + highlights', async ({ page }) => {
        await bootMany(page);
        await page.goto('index.html#/incidents;op=op-a?incident=dispatched-1');
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
        // Its HELP SENT section is collapsed by default; the reveal must open it.
        await expectRevealed(page, 'dispatched-1');
    });

    test('@smoke a CLOSED-section incident is also revealed + scrolled to', async ({ page }) => {
        await bootMany(page);
        await page.goto('index.html#/incidents;op=op-a?incident=closed-1');
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
        await expectRevealed(page, 'closed-1');
    });
});
