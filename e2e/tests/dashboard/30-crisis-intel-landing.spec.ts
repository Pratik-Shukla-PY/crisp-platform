/**
 * Dashboard — Crisis Intelligence landing (cc-home.js) render smoke.
 *
 * node -c proves the file parses; this proves it RUNS: with every backend call
 * stubbed to the real /analytics/summary contract, openControlCenter() must
 * paint the KPI strip, attention queue, operational-impact card (incl. the
 * honest "no fabricated population" placard), and emit zero runtime JS errors.
 *
 * Fully self-contained: fakes the auth token + stubs all /api/v1 calls, so it
 * needs no backend/login (unlike the sibling real-stack dashboard specs).
 */
import { test, expect } from '@playwright/test';

const NOW = new Date().toISOString();

const SUMMARY = {
    generated_at: NOW, window_hours: 24, stale_hours: 24, total_reports: 137,
    counts: {
        active: 42, critical: 7, pending_verification: 18, awaiting_triage: 23,
        open_dispatch: 9, resolved_in_window: 31, active_ops: 5, escalating: 4, stale: 6, sla_at_risk: 3,
        // Home-restructure aggregates (Phase 2): Command Centre tiles + Executive summary.
        reports: 137, incidents: 119, resolved: 31, rejected: 6, needs_review: 23,
        affected_buildings: 28, total_buildings: 44, duplicate_reports: 12, buildings_critical_risk: 3,
    },
    distributions: {
        by_severity: { CRITICAL: 7, SEVERE: 12, MODERATE: 20, MINOR: 8 },
        by_crisis_type: { FLOOD: 18, EARTHQUAKE: 9, WILDFIRE: 5 },
        by_status: { PENDING: 23, RESPONDING: 5, RESOLVED: 31 },
        verified: 40, unverified: 60,
    },
    timings: { avg_verification_seconds: 7600, avg_response_seconds: 5400 },
    impact: { critical_infrastructure: 12, lives_impacted_sum: 140, responders_active: 11, service_disruptions: 8 },
    deltas: { reports_24h: 14, reports_prev_24h: 11, reports_7d: 70, reports_prev_7d: 64 },
};
const REPORTS = [{
    id: 'r1', severity: 'CRITICAL', status: 'PENDING', crisis_type: 'FLOOD',
    infrastructure_type: 'HOSPITAL', reviewer_verdict: 'NOT_REVIEWED', server_created_at: NOW,
    location: { latitude: 25.6, longitude: 85.1, user_location_name: 'Patna, IN' },
}];
// P3 — the global map now consumes GET /reports/markers, which returns the FLAT
// lean shape ({lat,lng,severity,...}) — NOT the rich {location:{…}} report shape.
// Stub it explicitly so the test exercises the real marker contract.
const MARKERS = [
    { id: 'm1', lat: 25.6, lng: 85.1, severity: 'CRITICAL', status: 'PENDING', crisis_type: 'FLOOD', infrastructure_type: 'HOSPITAL', server_created_at: NOW },
    { id: 'm2', lat: 26.1, lng: 91.7, severity: 'MODERATE', status: 'RESPONDING', crisis_type: 'EARTHQUAKE', infrastructure_type: 'ROAD', server_created_at: NOW },
    { id: 'm3', lat: 19.0, lng: 72.8, severity: 'SEVERE', status: 'PENDING', crisis_type: 'FLOOD', infrastructure_type: 'RESIDENTIAL', server_created_at: NOW },
];
// Phase 2 — the /operations rollup feeding the ops-first home rail.
const OPERATIONS = [
    {
        id: 'op-flood-1', name: 'Bihar Floods', crisis_type: 'FLOOD', status: 'LIVE',
        is_active: true, center_lat: 25.6, center_lng: 85.1,
        critical: 5, new_24h: 9, total: 42, last_activity: NOW, is_cluster: false,
    },
    { id: null, name: 'Unassigned critical reports', is_cluster: true, critical: 3, total: 3 },
];
// AI Situational Awareness re-skins this cached /analytics/assess payload. This
// stub mirrors the REAL backend contract (scope_assessment.get_payload): the
// payload carries NO top_operations, and escalation_likelihood is the OBJECT
// {level, rationale} (NOT a string). The "Where" facet therefore derives from the
// live operations the rail already loaded, and the escalation meta must render the
// level — never the literal "[object Object]" (both were pre-deploy review bugs).
const ASSESS = {
    assessed: true, score: 62, band: 'MIXED',
    situation_summary: 'Flooding across Bihar is escalating with hospital access at risk.',
    key_risks: ['Hospital access cut in Patna', 'Rising water near shelters'],
    escalation_likelihood: { level: 'HIGH', rationale: 'Rising water levels near shelters' },
    recommended_actions: [
        { label: 'Dispatch teams to critical buildings', action: 'dispatch', scope: { scope_type: 'global' }, filters: { queue: 'critical' } },
    ],
};

test('Crisis Intelligence landing renders from the real summary contract, no runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
    });

    // Single handler routes every /api/v1 call to a deterministic stub.
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY });
        if (u.includes('/analytics/assess')) return route.fulfill({ json: ASSESS });
        if (u.includes('/analytics/damage-rate-24h')) {
            return route.fulfill({ json: {
                bucket_size_minutes: 60, total_reports: 14,
                buckets: Array.from({ length: 24 }, (_v, i) => ({
                    bucket_start: new Date(Date.now() - (23 - i) * 3600e3).toISOString(), report_count: i % 5,
                })),
            } });
        }
        if (u.includes('/reports/nearby')) {
            return route.fulfill({ json: { groups: [{ report_count: 12, label: 'Patna', is_acute: true }] } });
        }
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/operations')) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/markers')) {           // the global map's lean source (flat shape)
            return route.fulfill({ status: 200, json: MARKERS });
        }
        if (u.includes('/reports/')) {
            return route.fulfill({ status: 200, headers: { 'X-Total-Count': '137' }, json: REPORTS });
        }
        return route.fulfill({ status: 200, json: {} });
    });

    await page.goto('index.html');
    await page.waitForTimeout(600);        // let app.js boot settle
    errors.length = 0;                      // isolate: only capture LANDING-induced errors
    await page.evaluate(() => (window as any).openControlCenter && (window as any).openControlCenter());

    // §1 Section 1 · Global Overview (Jun 2026 home restructure): a 3-column row —
    // global map | Command Centre metric tiles | AI Assessment & Actions. Then
    // Situational Awareness, then Section 2 Active Operations, Building Intelligence,
    // and Section 3 Global Summary. The old map-header badge + the 8-tile Executive
    // KPI strip are both gone.
    await expect(page.locator('#cc-home-overlay')).toContainText('Global Overview');
    await expect(page.locator('#cc-home-overlay')).toContainText('Active Operations');
    await expect(page.locator('#cc-ops-rail')).toContainText('Bihar Floods', { timeout: 6000 });
    // The ops rail leads with a "+ New Operation" card (startNew), then recent ops.
    await expect(page.locator('#cc-ops-rail .opc-newop')).toBeVisible();
    // Cluster CTA is a slim one-line alert (was a full card) that opens the
    // chooser (offers a choice, never forces creation). It now lives in the
    // operations summary column (right of the recent-ops cards).
    await expect(page.locator('#cc-ops-summary')).toContainText('not yet in an operation');
    await expect(page.locator('#cc-map-badge')).toHaveCount(0);   // de-duped: no map badge echoing the rail
    await expect(page.locator('#cc-kpis')).toHaveCount(0);
    // §3 Command Centre metric tiles (#cc-att) — portfolio counts that deep-link
    // into the incident feed. Colour discipline: Critical = red, Resolved = green.
    await expect(page.locator('#cc-att')).toContainText('Total reports');
    await expect(page.locator('#cc-att')).toContainText('Critical');
    await expect(page.locator('#cc-att')).toContainText('Resolved');
    await expect(page.locator('#cc-att')).toContainText('Rejected');
    await expect(page.locator('#cc-att')).toContainText('Review pending');
    await expect(page.locator('#cc-att')).toContainText('Affected buildings');
    // Units are coherent: the headline (Total reports) is the superset, never
    // smaller than the verdict/status buckets.
    await expect(page.locator('#cc-att .cc-tile[data-tile="total"] .cc-tile-n')).not.toHaveText('0');
    // The critical tile carries its count and deep-links to the critical queue.
    await expect(page.locator('#cc-att .cc-tile[data-tile="critical"] .cc-tile-n')).toHaveText('7');
    await expect(page.locator('#cc-att .cc-tile[data-tile="resolved"] .cc-tile-n')).toHaveText('31');
    // §2 Phase-2 client-side countries-impacted caption (Turf over world.json).
    await expect(page.locator('#cc-map-geo')).toContainText(/countries impacted/i, { timeout: 8000 });
    // The global map actually PLOTS markers from the lean /reports/markers feed
    // (flat {lat,lng} shape). Leaflet renders circle markers as SVG paths /
    // markercluster icons — at least one must paint (regression guard: the map
    // showing the "Map data unavailable" fallback instead).
    await expect.poll(
        () => page.locator('#cc-map path.leaflet-interactive, #cc-map .leaflet-marker-icon').count(),
        { timeout: 8000 },
    ).toBeGreaterThan(0);
    await expect(page.locator('#cc-map .cc-map-fallback')).toHaveCount(0);
    // §4 distributions rendered — and the bar FILLS actually paint (Jun 2026
    // regression: .cc-bar-fill was an inline <span>, so width/height were
    // ignored and every bar rendered as an empty track with no color).
    await expect(page.locator('#cc-dist-sev')).toContainText('Critical');
    const fillBox = await page.locator('#cc-dist-sev .cc-bar-fill').first().boundingBox();
    expect(fillBox, 'bar fill must have a box').toBeTruthy();
    expect(fillBox!.width, 'bar fill must have non-zero painted width').toBeGreaterThan(4);
    expect(fillBox!.height, 'bar fill must have non-zero painted height').toBeGreaterThan(2);
    // §4b intake sparkline renders bars regardless of fetch-completion order
    // (Jun 2026 race: #cc-spark is created by the summary renderer AFTER the
    // sparkline fetch usually resolves — cached-bucket repaint fixes it).
    await expect(page.locator('#cc-spark i').first()).toBeVisible({ timeout: 6000 });
    // §5 impact + the honest no-fabrication placard (the guardrail, in the UI).
    await expect(page.locator('#cc-impact')).toContainText('Critical infrastructure');
    await expect(page.locator('#cc-impact')).toContainText('data integration');
    // §5b Executive summary (Section 3, right) — portfolio totals from the aggregates.
    await expect(page.locator('#cc-exec')).toContainText('Total buildings');
    await expect(page.locator('#cc-exec')).toContainText('Duplicate reports');
    // §6 AI Situational Awareness re-skins the cached /analytics/assess payload.
    await expect(page.locator('#cc-sitaware')).toContainText("What's happening", { timeout: 8000 });
    await expect(page.locator('#cc-sitaware')).toContainText('Flooding across Bihar');
    await expect(page.locator('#cc-sitaware')).toContainText('Recommended actions');
    // escalation_likelihood is the {level,rationale} OBJECT — the meta line must show
    // the level, never the literal "[object Object]" (pre-deploy review fix).
    await expect(page.locator('#cc-sitaware')).toContainText('escalation HIGH');
    await expect(page.locator('#cc-sitaware')).not.toContainText('[object Object]');
    // "Where" facet derives from the live ops the rail loaded (payload has no
    // top_operations) — it must name the operation carrying the critical load.
    await expect(page.locator('#cc-sitaware')).toContainText('Where');
    await expect(page.locator('#cc-sitaware')).toContainText('Bihar Floods', { timeout: 8000 });
    // §7 activity table.
    await expect(page.locator('#cc-activity')).toContainText('Patna');

    await page.waitForTimeout(400);
    // nominatim/CORS: the ops view's reverse-geocoder calls an EXTERNAL
    // service this stubbed harness doesn't intercept — its CORS rejection is
    // environment noise, not a landing runtime error.
    const runtimeErrors = errors.filter((e) => !/net::ERR|Failed to load resource|favicon|ERR_|nominatim|CORS policy/i.test(e));
    expect(runtimeErrors, 'landing runtime errors: ' + JSON.stringify(runtimeErrors)).toEqual([]);
});

// ── Pinned command bar (Jun 2026 UX rework) ─────────────────────────────────
// Quick Actions moved from the bottom of the page into a sticky two-row
// header block. These tests pin: the bar stays visible after scroll (incl.
// above the Leaflet map), the bottom section is gone, the old duplicate
// "Operations →" header button is gone, and the two deep-links land on the
// real target (Users tab; ops Export… menu) instead of generic screens.

async function openLanding(page, role = 'ADMIN') {
    await page.addInitScript((r) => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: r, email: 'ops@undp.org', full_name: 'Ops Lead' }));
    }, role);
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY });
        if (u.includes('/analytics/assess')) return route.fulfill({ json: ASSESS });
        if (u.includes('/reports/nearby')) return route.fulfill({ json: { groups: [] } });
        if (u.includes('/operations')) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/')) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '1' }, json: REPORTS });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForTimeout(600);
    // Enter the landing THROUGH the router (real-user path) so
    // _currentRoute is '/' — the Export Center's close-returns-to-origin
    // contract depends on the route the user actually came from. Direct
    // openControlCenter() calls leave the route at the automation default
    // (/incidents) and made the close-step assert the wrong origin.
    await page.evaluate(() => {
        const r = (window as any).__crispRouter;
        if (r) r.navigate('/');
        else (window as any).openControlCenter && (window as any).openControlCenter();
    });
    await expect(page.locator('#cc-nav')).toBeVisible({ timeout: 6000 });
}

test('map re-initialises when returning to Home from Operations', async ({ page }) => {
    await openLanding(page);                                   // first Home visit — map inits
    await expect.poll(() => page.locator('#cc-map .leaflet-pane').count(), { timeout: 6000 }).toBeGreaterThan(0);
    // Operations → Home again. openLanding() rebuilds the overlay HTML (a fresh
    // #cc-map), so the singleton Leaflet map must re-attach to the new node —
    // regression guard for "Operations → Home → blank map".
    await page.evaluate(() => (window as any).__crispRouter.navigate('/incidents'));
    await expect(page.locator('#view-incidents')).toBeVisible();
    await page.evaluate(() => (window as any).__crispRouter.navigate('/'));
    await expect(page.locator('#cc-nav')).toBeVisible({ timeout: 6000 });
    await expect.poll(() => page.locator('#cc-map .leaflet-pane').count(), { timeout: 6000 }).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.getElementById('cc-map')?.classList.contains('leaflet-container'))).toBe(true);
});

test('global shell bar is pinned: stays visible after scrolling to the bottom', async ({ page }) => {
    await openLanding(page);
    // The old bottom Quick Actions section must be gone, and so must the
    // duplicate header Operations button.
    expect(await page.locator('#cc-qa').count(), 'bottom Quick Actions must be removed').toBe(0);
    expect(await page.locator('#cc-go-ops').count(), 'duplicate Operations → button must be removed').toBe(0);

    // The primary nav now lives in the unified Command Center shell
    // (#crisp-globalnav, crisp-shell.js) — one persistent bar on every surface.
    // Scroll the landing to the very bottom: the fixed shell bar must remain
    // on-screen at the very top, not scroll away with the content.
    await page.evaluate(() => {
        const ov = document.getElementById('cc-home-overlay')!;
        ov.scrollTop = ov.scrollHeight;
    });
    await page.waitForTimeout(250);
    const box = await page.locator('#crisp-globalnav').boundingBox();
    expect(box, 'shell bar must have a box').toBeTruthy();
    expect(box!.y, 'shell bar must be pinned at the viewport top').toBeLessThanOrEqual(2);
    await expect(page.locator('#crisp-globalnav #cc-nav')).toBeVisible();
    // And it must stack ABOVE the page (incl. the Leaflet map): the element at
    // the bar's centre must live inside the shell bar, not whatever is beneath.
    const onTop = await page.evaluate(() => {
        const bar = document.getElementById('crisp-globalnav')!;
        const r = bar.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!(hit && bar.contains(hit));
    });
    expect(onTop, 'shell bar must stack above the page while scrolled').toBe(true);
});

test('User Management (account dropdown) opens Account Settings ON the Users tab (admin)', async ({ page }) => {
    await openLanding(page, 'ADMIN');
    // Users moved out of the nav into the account-chip dropdown (sets the Users tab).
    await page.evaluate(() => (window as any)._toggleUserMenu && (window as any)._toggleUserMenu(true));
    await page.locator('#btn-user-mgmt').click();
    await expect(page.locator('#cc-st-overlay')).toBeVisible({ timeout: 6000 });
    await expect(page.locator('.cc-st-tab.on')).toHaveText(/Users/i);
});

test('Exports pill opens the Export Center; closing returns to the landing', async ({ page }) => {
    await openLanding(page, 'ADMIN');
    await page.locator('#cc-nav button[data-route="/exports"]').click();
    // Route-level overlay (#/exports) — scope panel + format cards + count.
    await expect(page).toHaveURL(/#\/exports/);
    await expect(page.locator('#cc-ex-overlay.cc-ex-open')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#cc-ex-dataset .cc-ex-card')).toHaveCount(5);
    await expect(page.locator('#cc-ex-briefing .cc-ex-card')).toHaveCount(3);
    // Live scope count from the stubbed /exports/count.
    await expect(page.locator('#cc-ex-count .n')).not.toHaveText('…', { timeout: 5000 });
    // Recent-exports audit panel renders.
    await expect(page.locator('#cc-ex-recent-body')).not.toContainText('Loading', { timeout: 5000 });
    // ✕ returns EXACTLY where the user came from: the landing.
    await page.locator('#cc-ex-close').click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();
    await expect(page.locator('#cc-ex-overlay.cc-ex-open')).toHaveCount(0);
});

test('Export Center downloads a CSV through the authenticated backend route', async ({ page }) => {
    await openLanding(page, 'ADMIN');
    let sawAuthHeader = false;
    await page.route('**/api/v1/exports/csv**', async (route) => {
        sawAuthHeader = !!route.request().headers()['authorization'];
        return route.fulfill({
            status: 200,
            headers: {
                'content-disposition': 'attachment; filename=crisp_reports_20260612.csv',
                // Mirrors the backend CORS config — Content-Disposition is not
                // CORS-safelisted, so without exposing it the client cannot
                // read the server filename on cross-origin dev (a real bug
                // this test caught and main.py now fixes).
                'access-control-expose-headers': 'Content-Disposition',
            },
            contentType: 'text/csv',
            body: 'id,source\n#meta+id,#meta+channel\nr1,APP\n',
        });
    });
    await page.locator('#cc-nav button[data-route="/exports"]').click();
    await expect(page.locator('#cc-ex-overlay.cc-ex-open')).toBeVisible({ timeout: 5000 });
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 8000 }),
        page.locator('#cc-ex-dataset .cc-ex-card[data-path="csv"]').click(),
    ]);
    expect(download.suggestedFilename()).toBe('crisp_reports_20260612.csv');
    expect(sawAuthHeader, 'export fetch must carry the Authorization header').toBe(true);
});

test('Export Center scope change refreshes the count with the right params', async ({ page }) => {
    const countCalls: string[] = [];
    await openLanding(page, 'ADMIN');
    await page.route('**/api/v1/exports/count**', async (route) => {
        countCalls.push(route.request().url());
        return route.fulfill({ json: { count: 7, filters: {} } });
    });
    await page.locator('#cc-nav button[data-route="/exports"]').click();
    await expect(page.locator('#cc-ex-overlay.cc-ex-open')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#cc-ex-count .n')).toHaveText('7', { timeout: 5000 });
    await page.locator('.cc-ex-radio[data-scope="24h"]').click();
    await expect.poll(() => countCalls.some((u) => u.includes('since=')), {
        timeout: 5000,
    }).toBe(true);
});

test('admin-gated nav items render disabled with the admin chip for viewers', async ({ page }) => {
    await openLanding(page, 'VIEWER');
    // Crisis Forms is the only admin NAV button now (Organisation / Users /
    // Account moved into the account-chip dropdown).
    const cf = page.locator('#cc-nav button[data-route="/reporting"]');
    await expect(cf).toBeDisabled();
    await expect(cf.locator('.ad')).toHaveText(/admin/i);
    await expect(page.locator('#cc-nav button[data-route="/org"]')).toHaveCount(0);
    await expect(page.locator('#cc-nav button[data-intent="users"]')).toHaveCount(0);
    // "Account settings" is available to every role in the dropdown; the admin
    // config items stay hidden for a viewer.
    await expect(page.locator('#btn-account-settings')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => document.getElementById('btn-org-settings')?.style.display)).toBe('none');
});
