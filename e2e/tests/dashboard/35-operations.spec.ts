/**
 * Dashboard — Operations workspace (Phase 2: cc-operations.js + routing + context).
 *
 * Proves the operator-facing operations surface RUNS end-to-end with every
 * backend call stubbed to the Phase-2a contract (/operations rollup,
 * scoped /analytics/summary, scoped /reports):
 *   • #/operations lists operations worst-first + the un-operationalised
 *     critical "Launch operation here" CTA; a card opens #/operations/{id}.
 *   • #/operations/{id} is a worklist-first dashboard (banner · 4 vitals ·
 *     worklist · action bar) and lights up the triple-cue context chrome.
 *   • The operation context is ABSENT on global routes (/ and /incidents).
 *   • Nav reads "Operations" (primary) + "Incidents" (the raw global feed).
 *
 * Self-contained: fakes the auth token + stubs all /api/v1 calls — no backend.
 */
import { test, expect } from '@playwright/test';

const NOW = new Date().toISOString();

const OPERATIONS = [
    {
        id: 'op-a', name: 'Bihar Floods', crisis_type: 'FLOOD', status: 'LIVE', is_active: true,
        center_lat: 25.6, center_lng: 85.1, critical: 5, new_24h: 9, total: 42, last_activity: NOW, is_cluster: false,
    },
    {
        id: 'op-b', name: 'Assam Quake', crisis_type: 'EARTHQUAKE', status: 'LIVE', is_active: true,
        center_lat: 26, center_lng: 92, critical: 0, new_24h: 1, total: 8, last_activity: NOW, is_cluster: false,
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
        if (u.includes('/operations')) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/')) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '42' }, json: REPORTS });
        return route.fulfill({ status: 200, json: {} });
    });
}

test.describe('Dashboard — Operations workspace (Phase 2)', () => {
    test('nav reads Operations (primary) + Incidents (global feed)', async ({ page }) => {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(600);
        const nav = page.locator('#cc-nav');
        await expect(nav.locator('button[data-route="/operations"]')).toContainText('Operations');
        await expect(nav.locator('button[data-route="/incidents"]')).toContainText('Incidents');
    });

    test('#/operations lists operations worst-first + cluster CTA; a card opens the detail', async ({ page }) => {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(400);
        await page.evaluate(() => { location.hash = '#/operations'; });
        const list = page.locator('#cc-ops-overlay #cco-list');
        await expect(list).toContainText('Bihar Floods', { timeout: 6000 });
        await expect(list).toContainText('critical, no operation');  // un-operationalised cluster CTA
        // worst-first: Bihar (5 critical) ranks above Assam (0 critical).
        const names = await page.locator('#cco-list .cco-op-name').allTextContents();
        const bihar = names.findIndex((n) => /Bihar/.test(n));
        const assam = names.findIndex((n) => /Assam/.test(n));
        expect(bihar).toBeGreaterThanOrEqual(0);
        expect(assam).toBeGreaterThan(bihar);
        await page.locator('#cco-list [data-op="op-a"]').click();
        await expect.poll(() => page.evaluate(() => location.hash)).toContain('/operations/op-a');
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
    });
});
