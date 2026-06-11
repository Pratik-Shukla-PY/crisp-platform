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
        if (u.includes('/reports/')) {
            return route.fulfill({ status: 200, headers: { 'X-Total-Count': '137' }, json: REPORTS });
        }
        return route.fulfill({ status: 200, json: {} });
    });

    await page.goto('index.html');
    await page.waitForTimeout(600);        // let app.js boot settle
    errors.length = 0;                      // isolate: only capture LANDING-induced errors
    await page.evaluate(() => (window as any).openControlCenter && (window as any).openControlCenter());

    // §1 KPI strip from the summary contract.
    await expect(page.locator('#cc-kpis')).toContainText('Active incidents', { timeout: 6000 });
    await expect(page.locator('#cc-kpis')).toContainText('42');
    await expect(page.locator('#cc-kpis')).toContainText('Critical');
    // §3 attention queue (incl. Phase-2 SLA-at-risk row).
    await expect(page.locator('#cc-att')).toContainText('Critical incidents');
    await expect(page.locator('#cc-att')).toContainText('SLA at-risk');
    await expect(page.locator('#cc-att')).toContainText('Escalating');
    // §2 Phase-2 client-side countries-impacted caption (Turf over world.json).
    await expect(page.locator('#cc-map-geo')).toContainText(/countries impacted/i, { timeout: 8000 });
    // §4 distributions rendered.
    await expect(page.locator('#cc-dist-sev')).toContainText('Critical');
    // §5 impact + the honest no-fabrication placard (the guardrail, in the UI).
    await expect(page.locator('#cc-impact')).toContainText('Critical infrastructure');
    await expect(page.locator('#cc-impact')).toContainText('data integration');
    // §6 rule-based briefing sourced from real endpoints.
    await expect(page.locator('#cc-brief')).toContainText('source:');
    // §7 activity table.
    await expect(page.locator('#cc-activity')).toContainText('Patna');

    await page.waitForTimeout(400);
    const runtimeErrors = errors.filter((e) => !/net::ERR|Failed to load resource|favicon|ERR_/i.test(e));
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
        if (u.includes('/reports/nearby')) return route.fulfill({ json: { groups: [] } });
        if (u.includes('/reports/')) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '1' }, json: REPORTS });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForTimeout(600);
    await page.evaluate(() => (window as any).openControlCenter && (window as any).openControlCenter());
    await expect(page.locator('#cc-nav')).toBeVisible({ timeout: 6000 });
}

test('command bar is pinned: stays visible after scrolling to the bottom', async ({ page }) => {
    await openLanding(page);
    // The old bottom Quick Actions section must be gone, and so must the
    // duplicate header Operations button.
    expect(await page.locator('#cc-qa').count(), 'bottom Quick Actions must be removed').toBe(0);
    expect(await page.locator('#cc-go-ops').count(), 'duplicate Operations → button must be removed').toBe(0);

    // Scroll the overlay to the very bottom — the nav must remain on-screen
    // at the top (position: sticky), not scroll away with the content.
    await page.evaluate(() => {
        const ov = document.getElementById('cc-home-overlay')!;
        ov.scrollTop = ov.scrollHeight;
    });
    await page.waitForTimeout(250);
    const box = await page.locator('#cc-stick').boundingBox();
    expect(box, 'sticky block must have a box').toBeTruthy();
    expect(box!.y, 'sticky block must be pinned at the viewport top').toBeLessThanOrEqual(2);
    await expect(page.locator('#cc-nav')).toBeVisible();
    // And it must be ABOVE the Leaflet map in the stacking order: the element
    // at the bar's center must live inside the sticky block, not the map.
    const onTop = await page.evaluate(() => {
        const bar = document.getElementById('cc-stick')!;
        const r = bar.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!(hit && bar.contains(hit));
    });
    expect(onTop, 'sticky bar must stack above the map while scrolled').toBe(true);
});

test('Users deep-link opens Account Settings ON the Users tab (admin)', async ({ page }) => {
    await openLanding(page, 'ADMIN');
    await page.locator('#cc-nav button[data-intent="users"]').click();
    await expect(page.locator('#cc-st-overlay')).toBeVisible({ timeout: 6000 });
    await expect(page.locator('.cc-st-tab.on')).toHaveText(/Users/i);
});

test('Exports deep-link opens the ops Tools → Export… menu', async ({ page }) => {
    await openLanding(page, 'ADMIN');
    await page.locator('#cc-nav button[data-intent="export"]').click();
    await page.waitForTimeout(400);
    // Landing closed (routed to /incidents) and the export affordance is open.
    await expect(page.locator('#cmd-tools-dropdown')).toHaveClass(/open/);
    await expect(page.locator('#cmd-tools-dropdown .tools-menu-submenu')).toHaveClass(/open/);
    await expect(page.locator('#cmd-tools-dropdown .tools-menu-subitem').first()).toBeVisible();
});

test('admin-gated nav items render disabled with the admin chip for viewers', async ({ page }) => {
    await openLanding(page, 'VIEWER');
    for (const intentOrRoute of ['/reporting', '/org']) {
        const btn = page.locator(`#cc-nav button[data-route="${intentOrRoute}"]`);
        await expect(btn).toBeDisabled();
        await expect(btn.locator('.ad')).toHaveText(/admin/i);
    }
    const usersBtn = page.locator('#cc-nav button[data-intent="users"]');
    await expect(usersBtn).toBeDisabled();
    // Account (self-service) stays enabled for every role.
    await expect(page.locator('#cc-nav button[data-route="/users"]:not([data-intent])')).toBeEnabled();
});
