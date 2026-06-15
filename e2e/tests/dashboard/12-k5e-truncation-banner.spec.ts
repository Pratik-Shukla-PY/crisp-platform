/**
 * Dashboard — truncation banner (K.5.e, hardened by Phase-0 C1-a).
 *
 * The backend caps a listing page at 500 rows, so at scale the feed list is the
 * newest N of a larger scope. The banner makes that explicit. C1-a fixed the
 * pre-existing SILENT range: the banner used to fire only when X-Total-Count
 * exceeded the unreachable 10K client ceiling, so any scope of 501–10000 reports
 * was truncated with ZERO signal. It now fires on ANY shortfall (X-Total-Count >
 * rows actually returned) and shows the real "newest N of TOTAL".
 */
import { test, expect } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

const DASH_URL = 'index.html';

let _adminToken: string | null = null;

function _row(i: number) {
    return {
        id: `k5e-r${i}`, client_report_id: `k5e-c${i}`, device_id: 'k5e-dev', source: 'APP',
        status: 'PENDING', sync_status: 'SYNCED', severity: 'CRITICAL',
        infrastructure_type: 'ROAD', damage_classification: 'PARTIAL', crisis_type: 'FLOOD',
        description: `truncation test ${i}`, expected_media: 0, received_media: 0,
        server_created_at: new Date().toISOString(), client_created_at: new Date().toISOString(),
        location: { latitude: 12.97 + i * 0.01, longitude: 77.59, device_latitude: 12.97, device_longitude: 77.59 },
        media: [], submitted_as_anonymous_due_to_expired_token: false,
        crisis_event_id: null, crisis_event_name: null,
    };
}

// Return `returned` real rows while the X-Total-Count header advertises `total`.
// A shortfall (returned < total) is what now drives the banner. /analytics/summary
// + /reports/markers are stubbed so the C1-b/c scale paths don't hit the network.
async function stubReportsListWithTotal(page, total, returned = 0) {
    await page.route(/\/api\/v1\/analytics\/summary/, (route) => route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify({ total_reports: total, counts: { active: 0, critical: 0, active_ops: 0 },
            distributions: {}, timings: {}, impact: {}, deltas: {} }),
    }));
    await page.route(/\/api\/v1\/reports\/markers/, (route) => route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: '[]',
    }));
    await page.route(/\/api\/v1\/reports\/(\?|$)/, async (route) => {
        const url = route.request().url();
        if (/\/api\/v1\/reports\/[A-Za-z0-9-]/.test(url) && !url.includes('?')) { await route.continue(); return; }
        const rows = Array.from({ length: returned }, (_, i) => _row(i));
        await route.fulfill({
            status: 200,
            headers: {
                'content-type': 'application/json', 'access-control-allow-origin': '*',
                'access-control-expose-headers': 'X-Total-Count, X-Server-Time, ETag',
                'X-Total-Count': String(total),
                'X-Server-Time': new Date().toISOString().replace('+00:00', 'Z'),
                'ETag': `"k5e-${total}-${Date.now()}"`,
            },
            body: JSON.stringify(rows),
        });
    });
}

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
        () => typeof (window as any).__crispNotifDebug === 'function'
            && (window as any).__crispNotifDebug().initialLoadDone === true,
        null, { timeout: 15000 },
    );
}


test.describe('Dashboard — truncation banner (C1-a)', () => {
    test('banner appears when the feed is truncated (returned < total)', async ({ page, request }) => {
        await stubReportsListWithTotal(page, 15000, 3);   // 3 of 15,000
        await bootDashboard(page, request);

        await page.waitForSelector('#truncation-banner', { state: 'visible', timeout: 5000 });
        const text = await page.locator('#truncation-banner').textContent();
        expect(text).toContain('15,000');   // true total
        expect(text).toContain('3');        // newest N actually returned
    });

    test('banner does NOT appear when every row is present (returned == total)', async ({ page, request }) => {
        await stubReportsListWithTotal(page, 5, 5);   // all 5 rows shipped
        await bootDashboard(page, request);

        await page.waitForTimeout(500);
        const visible = await page.locator('#truncation-banner').isVisible().catch(() => false);
        expect(visible, 'no banner when nothing is hidden').toBe(false);
    });

    test('C1-a: banner fires in the previously-SILENT 501–10000 range', async ({ page, request }) => {
        // Pre-fix this range was truncated to 500 with ZERO operator signal
        // (the banner only fired past the unreachable 10K ceiling). It must now show.
        await stubReportsListWithTotal(page, 4200, 3);
        await bootDashboard(page, request);

        await page.waitForSelector('#truncation-banner', { state: 'visible', timeout: 5000 });
        const text = await page.locator('#truncation-banner').textContent();
        expect(text).toContain('4,200');
    });

    test('banner can be dismissed via the close button', async ({ page, request }) => {
        await stubReportsListWithTotal(page, 12000, 3);
        await bootDashboard(page, request);

        await page.waitForSelector('#truncation-banner', { state: 'visible', timeout: 5000 });
        await page.locator('.truncation-banner-close').click();
        await page.waitForTimeout(200);

        const visible = await page.locator('#truncation-banner').isVisible().catch(() => false);
        expect(visible).toBe(false);
    });
});
