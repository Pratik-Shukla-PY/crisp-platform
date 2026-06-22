/**
 * Dashboard — Phase-0 C1 scale hardening (truncation honesty + decoupled aggregates).
 *
 * At scale the dashboard holds only the newest-N working set. This verifies:
 *   C1-a  the truncation banner fires on ANY shortfall and shows the REAL numbers
 *         (newest N of TOTAL), not the unreachable 10K ceiling.
 *   C1-b  the headline KPI strip + context-banner total come from the scope-aware
 *         /analytics/summary + X-Total-Count, so they reflect ALL reports.
 *   C1-c  the main map plots the full lean /reports/markers set, not the 500 slice.
 *
 * Self-contained: stubs /reports/ (with a big X-Total-Count), /analytics/summary,
 * and /reports/markers; fakes the admin token (no DB).
 */
import { test, expect } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

const DASH_URL = 'index.html';
const TOTAL = 4200;            // true scope size (X-Total-Count)
const RETURNED = 3;            // backend page cap shipped only this many

function _stub(i: number) {
    return {
        id: `sc-r${i}`, client_report_id: `sc-c${i}`, device_id: 'sc-dev', source: 'APP',
        status: 'PENDING', sync_status: 'SYNCED', severity: 'CRITICAL',
        infrastructure_type: 'ROAD', damage_classification: 'PARTIAL', crisis_type: 'FLOOD',
        description: `scale test ${i}`, expected_media: 0, received_media: 0,
        server_created_at: new Date().toISOString(), client_created_at: new Date().toISOString(),
        location: { latitude: 12.97 + i * 0.01, longitude: 77.59, device_latitude: 12.97, device_longitude: 77.59 },
        media: [], submitted_as_anonymous_due_to_expired_token: false,
        crisis_event_id: null, crisis_event_name: null,
    };
}

// Server summary: authoritative scope counts (deliberately different from what
// the 3 returned rows would compute) so we can prove the strip uses the server.
const SUMMARY = {
    generated_at: new Date().toISOString(), window_hours: 24, stale_hours: 24,
    total_reports: TOTAL,
    counts: {
        active: 400, critical: 95, active_ops: 30, needs_review: 250, needs_response: 120,
        active_operations: 30, pending_verification: 250, awaiting_triage: 200,
        open_dispatch: 10, resolved_in_window: 12, escalating: 4, stale: 5, sla_at_risk: 7,
        critical_incidents: 88, escalating_reports: 9,
    },
    distributions: { by_severity: {}, by_crisis_type: {}, by_status: {}, verified: 0, unverified: 0 },
    timings: {}, impact: {}, deltas: {},
};

let _adminToken: string | null = null;
let _markersHit = false;

async function boot(page, request) {
    if (!_adminToken) _adminToken = await ensureAdminAndLogin(request);
    _markersHit = false;

    // /reports/markers — lean COP points (12). Record that it was requested.
    await page.route(/\/api\/v1\/reports\/markers/, async (route) => {
        _markersHit = true;
        const markers = Array.from({ length: 12 }, (_, i) => ({
            id: `mk-${i}`, lat: 12.5 + i * 0.02, lng: 77.5, severity: 'CRITICAL',
            status: 'PENDING', crisis_type: 'FLOOD', infrastructure_type: 'ROAD',
            server_created_at: new Date().toISOString(),
        }));
        await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
            body: JSON.stringify(markers),
        });
    });
    // /analytics/summary — authoritative scope counts.
    await page.route(/\/api\/v1\/analytics\/summary/, async (route) => {
        await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
            body: JSON.stringify(SUMMARY),
        });
    });
    // /reports/ listing — only RETURNED rows, but X-Total-Count says TOTAL (truncated).
    await page.route(/\/api\/v1\/reports\/(\?|$)/, async (route) => {
        const url = route.request().url();
        if (/\/api\/v1\/reports\/[A-Za-z0-9-]/.test(url) && !url.includes('?')) { await route.continue(); return; }
        const rows = Array.from({ length: RETURNED }, (_, i) => _stub(i));
        await route.fulfill({
            status: 200,
            headers: {
                'content-type': 'application/json', 'access-control-allow-origin': '*',
                'access-control-expose-headers': 'X-Total-Count, X-Server-Time, ETag',
                'X-Total-Count': String(TOTAL),
                'X-Server-Time': new Date().toISOString().replace('+00:00', 'Z'),
                'ETag': `"sc-${Date.now()}"`,
            },
            body: JSON.stringify(rows),
        });
    });

    await page.goto(DASH_URL);
    await page.evaluate(({ token, email }) => {
        localStorage.setItem('crisp_token', token);
        localStorage.setItem('crisp_user', JSON.stringify({ email, role: 'SUPER_ADMIN', full_name: 'E2E Admin' }));
    }, { token: _adminToken, email: ADMIN.email });
    await page.reload();
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0,
        null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await page.waitForTimeout(500);
}

test.describe('Incidents page — scale truncation honesty (Phase-0 C1)', () => {
    test('C1-a: truncation banner shows the REAL newest-N of TOTAL (not silent, not 10K)', async ({ page, request }) => {
        await boot(page, request);
        const banner = page.locator('#truncation-banner');
        await expect(banner).toBeVisible({ timeout: 6000 });
        await expect(banner).toContainText('4,200');     // true total, locale-formatted
        await expect(banner).toContainText(String(RETURNED));
    });

    test('C1-b: KPI strip + context-banner total reflect the SERVER scope counts', async ({ page, request }) => {
        await boot(page, request);
        // Critical comes from the server summary (95), NOT the 3 loaded rows.
        await expect.poll(async () => (await page.locator('#count-critical').textContent())?.trim(),
            { timeout: 6000 }).toBe('95');
        // The scope total now lives in the header next to the scope crumb (.qb-total);
        // moved out of the status-tab row (#count-dual) in the Jun 2026 header-total change.
        await expect(page.locator('#feed-scope-bar .qb-total')).toContainText('4200');
    });

    test('C1-c: main map plots the full lean /reports/markers set', async ({ page, request }) => {
        await boot(page, request);
        await expect.poll(() => _markersHit, { timeout: 6000 }).toBe(true);
        // The COP plots the full 12-point lean set, not the 3-row working slice.
        // Asserted via the marker registry (cluster-collapse independent).
        await expect.poll(async () => page.evaluate(
            () => (window as any).__crispMapMarkerCount && (window as any).__crispMapMarkerCount()),
            { timeout: 6000 }).toBe(12);
    });
});
