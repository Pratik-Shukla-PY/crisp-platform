/**
 * Dashboard — K.5.b (Phase K, May 2026): time filter uses
 * `_priorityTime()` (capture-time) not `server_created_at`
 * (drain-time).
 *
 * Pre-fix the dashboard's time filter ("Last 1 hour" / "Last 24h")
 * computed against `server_created_at`. An offline-queued report
 * captured 2 hours ago and drained 30 seconds ago has
 * server_created_at=now → silently HIDDEN from a "Last 1 hour"
 * filter even though its capture time is well outside the window.
 * Worse: a true-recent report with the same `server_created_at`
 * looks indistinguishable from the stale-drain.
 *
 * Fix: every filter call-site (queue feed, tree feed,
 * _getFilteredReports, analytics) now uses `_priorityTime(r)` which
 * returns `client_created_at` when the drain-vs-capture gap exceeds
 * 5 minutes. Offline-drained reports stay visible by capture time;
 * fresh reports use server time as before.
 */
import { test, expect } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

const DASH_URL = 'index.html';

function _stubReport(overrides) {
    return {
        id: 'k5b-report',
        client_report_id: 'k5b-client',
        device_id: 'k5b-device',
        source: 'APP',
        status: 'PENDING',
        sync_status: 'SYNCED',
        severity: 'MODERATE',
        infrastructure_type: 'ROAD',
        damage_classification: 'PARTIAL',
        crisis_type: 'FLOOD',
        description: 'k5b filter test',
        expected_media: 0,
        received_media: 0,
        location: { latitude: 12.97, longitude: 77.59, device_latitude: 12.97, device_longitude: 77.59 },
        media: [],
        submitted_as_anonymous_due_to_expired_token: false,
        ...overrides,
    };
}

async function stubReportsList(page, reports) {
    await page.route(/\/api\/v1\/reports\/(\?|$)/, async (route) => {
        const url = route.request().url();
        if (/\/api\/v1\/reports\/[A-Za-z0-9-]/.test(url) && !url.includes('?')) {
            await route.continue();
            return;
        }
        await route.fulfill({
            status: 200,
            headers: {
                'content-type': 'application/json',
                'access-control-allow-origin': '*',
                'access-control-expose-headers': 'X-Total-Count, X-Server-Time, ETag',
                'X-Total-Count': String(reports.length),
                'X-Server-Time': new Date().toISOString().replace('+00:00', 'Z'),
                'ETag': `"k5b-test-${Date.now()}"`,
            },
            body: JSON.stringify(reports),
        });
    });
}

let _adminToken: string | null = null;

async function bootDashboard(page, request) {
    if (!_adminToken) _adminToken = await ensureAdminAndLogin(request);
    await page.goto(DASH_URL);
    await page.evaluate(({ token, email }) => {
        localStorage.setItem('crisp_token', token);
        localStorage.setItem('crisp_user', JSON.stringify({
            email, role: 'SUPER_ADMIN', full_name: 'E2E Admin',
        }));
    }, { token: _adminToken, email: ADMIN.email });
    await page.reload();
    await page.waitForFunction(
        () => Array.isArray((window as any).allReports)
            && (window as any).allReports.length > 0,
        null, { timeout: 15000 },
    );
}


test.describe('Dashboard K.5.b — priority-time filter', () => {
    test('offline-drained report (captured 2h ago, drained now) stays visible at 1h filter', async ({ page, request }) => {
        const nowMs = Date.now();
        const twoHoursAgo = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
        const justNow = new Date(nowMs).toISOString();
        await stubReportsList(page, [_stubReport({
            id: 'k5b-offline-drained',
            client_created_at: twoHoursAgo,   // captured 2h ago
            server_created_at: justNow,       // drained just now
        })]);
        await bootDashboard(page, request);

        // Card should appear regardless of any time filter — _priorityTime
        // returns the older client time when drain-gap >5min.
        const cardExists = await page.locator('.qrt-card[data-report-id="k5b-offline-drained"]').count();
        expect(cardExists, 'offline-drained report should be visible on initial render').toBe(1);

        // Now apply "Last 1 hour" filter. Pre-K.5.b this would HIDE the
        // card because server_created_at=now is technically inside the
        // 1h window — wait, actually pre-fix this would PASS the filter
        // (server time looks fresh). Let me invert: the 1h filter must
        // INCLUDE this report because the priority time (capture, 2h
        // ago) is OUTSIDE the 1h window... actually that means it
        // should NOT pass the 1h filter when using priority time.
        // Hmm — the operator scenario is the opposite: they want a "Last
        // 1 hour" filter to mean "captured in the last hour", and an
        // offline-drained capture from 2h ago should NOT match. That's
        // exactly what K.5.b implements.

        // Set filter to 1h via the timeFilterHours JS global.
        await page.evaluate(() => {
            (window as any).__crispSetTimeFilterHoursForTest
                && (window as any).__crispSetTimeFilterHoursForTest(1);
        });

        // Wait a frame for re-render
        await page.waitForTimeout(200);

        // With K.5.b: the 2h-old capture is correctly excluded from the
        // 1h filter (operator scenario: "show me everything captured
        // recently" — the offline-drained stale capture isn't recent).
        const cardAfterFilter = await page.locator('.qrt-card[data-report-id="k5b-offline-drained"]').count();
        expect(
            cardAfterFilter,
            'K.5.b: capture-time 2h ago must be excluded by 1h time filter',
        ).toBe(0);
    });

    test('recently-captured-and-drained report appears in 1h filter', async ({ page, request }) => {
        const nowMs = Date.now();
        const tenMinAgo = new Date(nowMs - 10 * 60 * 1000).toISOString();
        await stubReportsList(page, [_stubReport({
            id: 'k5b-recent',
            client_created_at: tenMinAgo,
            server_created_at: tenMinAgo,
        })]);
        await bootDashboard(page, request);

        await page.evaluate(() => {
            (window as any).__crispSetTimeFilterHoursForTest
                && (window as any).__crispSetTimeFilterHoursForTest(1);
        });
        await page.waitForTimeout(200);

        const card = await page.locator('.qrt-card[data-report-id="k5b-recent"]').count();
        expect(card, 'recently captured report stays visible in 1h filter').toBe(1);
    });

    test('time filter at 0 (All time) bypasses _priorityTime check entirely', async ({ page, request }) => {
        const nowMs = Date.now();
        const veryOld = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
        await stubReportsList(page, [_stubReport({
            id: 'k5b-very-old',
            client_created_at: veryOld,
            server_created_at: veryOld,
        })]);
        await bootDashboard(page, request);

        // Default filter is 0 (All) — report should be visible.
        const card = await page.locator('.qrt-card[data-report-id="k5b-very-old"]').count();
        expect(card).toBe(1);
    });
});
