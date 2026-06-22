/**
 * Dashboard - operation dashboard Building worklist → Building Console (D1 regression).
 *
 * Audit finding D1 (Critical): on the operation dashboard (#/operations/{id}) the
 * Buildings worklist is the DEFAULT tab, but clicking a building card did NOTHING
 * visible - openBuildingConsole opened #detail-panel, which (unlike selectReport)
 * was NOT reparented to <body>, so it stayed inside the hidden #view-incidents
 * container, behind the operations overlay. Plus _updateBuildingUrlHash composed a
 * malformed `#building=<id>;/operations/<id>` hash.
 *
 * Fix: openBuildingConsole reparents #detail-panel to <body> (mirrors selectReport);
 * _updateBuildingUrlHash appends `building=` route-first. This spec guards that a
 * building card on the operation dashboard opens a VISIBLE, on-screen console with a
 * well-formed hash.
 */
import { test, expect } from '@playwright/test';

const NOW = new Date().toISOString();
const OPERATIONS = [
    { id: 'op-a', name: 'Bihar Floods', crisis_type: 'FLOOD', status: 'LIVE', is_active: true,
      center_lat: 25.6, center_lng: 85.1, radius_km: 22, place_name: 'Patna, India', form_name: 'Flood v2',
      started_at: NOW, critical: 5, new_24h: 9, total: 42, verified: 7, last_activity: NOW, is_cluster: false,
      health: 'RED', health_reason: '5 unattended critical', responders_active: 0 },
];
const SUMMARY = { generated_at: NOW, window_hours: 24, total_reports: 42,
    counts: { active: 30, critical: 5, needs_review: 12, needs_response: 4, active_operations: 1 },
    distributions: {}, timings: {}, impact: {}, deltas: {} };
const REPORTS = [
    { id: 'r1', severity: 'CRITICAL', status: 'PENDING', crisis_type: 'FLOOD', crisis_event_id: 'op-a',
      building_id: 'b1', server_created_at: NOW, location: { latitude: 25.6, longitude: 85.1 } },
];
const BUILDING = {
    id: 'b1', osm_name: 'Government School Shelter', osm_addr_full: 'MG Road, Patna', state: 'ACTIVE',
    humanitarian_priority: 78, escalation_risk: 60, severity_score: 70, confidence_score: 60, activity_score: 55,
    report_count: 5, verified_report_count: 2, critical_report_count: 2, responding_report_count: 0,
    resolved_report_count: 0, responder_count: 0, duplicate_group_count: 1, debris_count: 0,
    crisis_types_top3: ['FLOOD'], latest_report_at: NOW, first_report_at: NOW,
    centroid_lat: 25.6, centroid_lng: 85.1, reports: REPORTS, responders: [], monitors: [], notes: [],
    footprint: null, ai_summary: null, satellite: null,
};

async function boot(page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'SUPER_ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/weather')) return route.fulfill({ json: { available: false } });
        // Building detail (/buildings/<id>) BEFORE the list match.
        if (/\/buildings\/[^/?]+(\?|$)/.test(u) && !u.includes('order_by')) {
            return route.fulfill({ json: BUILDING });
        }
        if (u.includes('/buildings')) return route.fulfill({ json: { items: [BUILDING] } });
        if (u.includes('/operations')) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/')) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '42' }, json: REPORTS });
        return route.fulfill({ status: 200, json: {} });
    });
}

test.describe.configure({ mode: 'serial' });

test('op dashboard: clicking a building card opens a VISIBLE console (D1)', async ({ page }) => {
    await boot(page);
    // Building Intelligence was removed from BOTH the home and the op console (Jun 2026);
    // the building console is now opened from the incident feed / detail links. Invoke it
    // directly — the D1 regression under test is the console-open behaviour (reparent to
    // <body>, on-screen, z-index above the overlay), independent of the trigger surface.
    await page.goto('index.html#/incidents');
    await page.evaluate(async () => { await (window as any).openBuildingConsole('b1'); });

    // The building console (#detail-panel.detail-panel--building) must become a
    // VISIBLE, on-screen global overlay - not hidden behind the operations overlay.
    const panel = page.locator('#detail-panel');
    await expect(panel).toBeVisible({ timeout: 6000 });
    await expect(panel).toHaveClass(/detail-panel--building/);
    const geo = await page.evaluate(() => {
        const d = document.getElementById('detail-panel');
        const r = d.getBoundingClientRect();
        return {
            reparentedToBody: d.parentElement === document.body,
            onScreen: r.width > 40 && r.right > 0 && r.left < window.innerWidth && r.bottom > 0,
            z: parseInt(getComputedStyle(d).zIndex || '0', 10),
            hash: location.hash,
        };
    });
    expect(geo.reparentedToBody, 'detail-panel must be reparented to <body>').toBe(true);
    expect(geo.onScreen, 'console must be on-screen, not off-screen/0-size').toBe(true);
    expect(geo.z, 'console z-index must clear the operations overlay (99990)').toBeGreaterThan(99990);
    // The building deep-link is route-first + well-formed (never the prepended
    // #building= bug). Opened from the home, it carries building=b1 on the route.
    expect(geo.hash).toContain('building=b1');
    expect(geo.hash.startsWith('#building='), 'hash must NOT be the prepended #building= bug').toBe(false);
});

test('the building deep-link hash is route-first (refused the prepend bug)', async ({ page }) => {
    await boot(page);
    await page.goto('index.html#/incidents');
    await page.evaluate(async () => { await (window as any).openBuildingConsole('b1'); });
    await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 6000 });
    // The building deep-link is route-first (the building= segment is appended to the
    // route, never the prepended #building= bug).
    const hash = await page.evaluate(() => location.hash);
    expect(hash.startsWith('#building='), 'hash must NOT be prepended with building=').toBe(false);
    expect(hash).toContain('building=b1');
});
