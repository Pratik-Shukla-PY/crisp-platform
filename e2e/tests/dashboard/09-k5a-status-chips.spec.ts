/**
 * Dashboard — K.5.a (Phase K, May 2026): operator-visible status chips
 * on the feed card.
 *
 * Each chip surfaces one of the new state signals from Phase K
 * backend work. The chip-row in `createIncidentCard`
 * (web-dashboard/src/app.js ~line 2113) renders the FIRST applicable
 * chip in severity order:
 *   1. Media corrupt            (abandon_reason = 'checksum_mismatch')   RED
 *   2. Upload abandoned         (abandon_reason = 'chunks_never_arrived' OR
 *                                                 'assembly_worker_lost')  RED
 *   3. Redaction failed        (pii_blur_status = 'failed')              RED
 *   4. Original (slow network)  (abandon_reason = 'bandwidth_tier_deferred') AMBER
 *   5. Attribution lost         (submitted_as_anonymous_due_to_expired_token) GREY
 *   6. Uploading…               (sync_status=PARTIAL + media pending)     AMBER
 *
 * The spec uses Playwright route interception to inject a controlled
 * /reports/ payload so each chip variant can be exercised
 * deterministically, without needing to seed N reports in the live
 * DB with the right combination of fields.
 */
import { test, expect } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

const DASH_URL = 'index.html';

/** Generate a minimal Report-shape stub that the dashboard's feed
 *  renderer will accept. Overrides allow per-test customisation of
 *  the specific Phase K fields under test. */
function _stubReport(overrides) {
    return {
        id: 'k5a-report-1',
        client_report_id: 'k5a-client-1',
        device_id: 'k5a-device',
        source: 'APP',
        status: 'PENDING',
        sync_status: 'SYNCED',
        severity: 'MODERATE',
        infrastructure_type: 'ROAD',
        damage_classification: 'PARTIAL',
        crisis_type: 'FLOOD',
        description: 'k5a chip test',
        expected_media: 1,
        received_media: 1,
        server_created_at: new Date().toISOString(),
        client_created_at: new Date().toISOString(),
        location: { latitude: 12.97, longitude: 77.59, device_latitude: 12.97, device_longitude: 77.59 },
        media: [],
        submitted_as_anonymous_due_to_expired_token: false,
        ...overrides,
    };
}

async function stubReportsList(page, reports) {
    await page.route(/\/api\/v1\/reports\/(\?|$)/, async (route) => {
        const url = route.request().url();
        // Only intercept the listing endpoint (not /reports/<id>/*).
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
                'ETag': `"k5a-test-${Date.now()}"`,
            },
            body: JSON.stringify(reports),
        });
    });
}

// Resolved once per worker — real admin token, idempotent register-or-login.
let _adminToken: string | null = null;

async function bootDashboard(page, request) {
    if (!_adminToken) {
        _adminToken = await ensureAdminAndLogin(request);
    }
    // Mirror the pattern from 06-satellite-verification.spec.ts: goto
    // first (may redirect to login), seed localStorage, reload — after
    // reload the dashboard sees valid tokens and stays on index.html.
    await page.goto(DASH_URL);
    await page.evaluate(({ token, email }) => {
        localStorage.setItem('crisp_token', token);
        localStorage.setItem('crisp_user', JSON.stringify({
            email, role: 'SUPER_ADMIN', full_name: 'E2E Admin',
        }));
    }, { token: _adminToken, email: ADMIN.email });
    await page.reload();
    // Wait for the feed renderer to populate allReports from the
    // stubbed list endpoint (the dashboard auto-fetches on boot).
    await page.waitForFunction(
        () => Array.isArray((window as any).allReports)
            && (window as any).allReports.length > 0,
        null, { timeout: 15000 },
    );
}


test.describe('Dashboard K.5.a — status chip-row', () => {
    test('checksum_mismatch → "Media corrupt" red chip', async ({ page, request }) => {
        await stubReportsList(page, [_stubReport({
            id: 'k5a-corrupt',
            media: [{ id: 'm1', type: 'IMAGE', resolution_tier: 'LOW',
                      assembly_status: 'failed',
                      abandon_reason: 'checksum_mismatch',
                      abandoned_at: new Date().toISOString(),
                      completion_pct: 100 }],
        })]);
        await bootDashboard(page, request);
        await page.waitForSelector('.qrt-card[data-report-id="k5a-corrupt"]', { timeout: 10000 });
        const chipText = await page.locator(
            '.qrt-card[data-report-id="k5a-corrupt"] .k5a-chip-red'
        ).first().textContent();
        expect(chipText).toContain('Media corrupt');
    });

    test('chunks_never_arrived → "Upload abandoned" red chip', async ({ page, request }) => {
        await stubReportsList(page, [_stubReport({
            id: 'k5a-abandoned',
            media: [{ id: 'm1', type: 'IMAGE', resolution_tier: 'LOW',
                      assembly_status: 'failed',
                      abandon_reason: 'chunks_never_arrived',
                      abandoned_at: new Date().toISOString() }],
        })]);
        await bootDashboard(page, request);
        await page.waitForSelector('.qrt-card[data-report-id="k5a-abandoned"]', { timeout: 10000 });
        const chipText = await page.locator(
            '.qrt-card[data-report-id="k5a-abandoned"] .k5a-chip-red'
        ).first().textContent();
        expect(chipText).toContain('Upload abandoned');
    });

    test('pii_blur_status=failed → "Redaction failed" red chip', async ({ page, request }) => {
        await stubReportsList(page, [_stubReport({
            id: 'k5a-pii',
            media: [{ id: 'm1', type: 'IMAGE', resolution_tier: 'LOW',
                      assembly_status: 'complete', pii_blur_status: 'failed' }],
        })]);
        await bootDashboard(page, request);
        await page.waitForSelector('.qrt-card[data-report-id="k5a-pii"]', { timeout: 10000 });
        const chipText = await page.locator(
            '.qrt-card[data-report-id="k5a-pii"] .k5a-chip-red'
        ).first().textContent();
        expect(chipText).toContain('Redaction failed');
    });

    test('bandwidth_tier_deferred → "Original (slow network)" amber chip', async ({ page, request }) => {
        await stubReportsList(page, [_stubReport({
            id: 'k5a-slownet',
            media: [
                { id: 'm1', type: 'IMAGE', resolution_tier: 'LOW',
                  assembly_status: 'complete' },
                { id: 'm2', type: 'IMAGE', resolution_tier: 'HIGH',
                  assembly_status: 'failed',
                  abandon_reason: 'bandwidth_tier_deferred',
                  abandoned_at: new Date().toISOString() },
            ],
        })]);
        await bootDashboard(page, request);
        await page.waitForSelector('.qrt-card[data-report-id="k5a-slownet"]', { timeout: 10000 });
        // v55: non-blocking chips moved off the card into the detail panel.
        await page.evaluate(() => (window as any).openIncident('k5a-slownet'));
        const chipText = await page.locator(
            '#detail-body .dp-status-chips .k5a-chip-amber'
        ).first().textContent();
        expect(chipText).toContain('Original (slow network)');
    });

    test('submitted_as_anonymous_due_to_expired_token → "Attribution lost" grey chip', async ({ page, request }) => {
        await stubReportsList(page, [_stubReport({
            id: 'k5a-anon',
            submitted_as_anonymous_due_to_expired_token: true,
        })]);
        await bootDashboard(page, request);
        await page.waitForSelector('.qrt-card[data-report-id="k5a-anon"]', { timeout: 10000 });
        // v55: non-blocking chips moved off the card into the detail panel.
        await page.evaluate(() => (window as any).openIncident('k5a-anon'));
        const chipText = await page.locator(
            '#detail-body .dp-status-chips .k5a-chip-grey'
        ).first().textContent();
        expect(chipText).toContain('Attribution lost');
    });

    test('PARTIAL + pending media → "Uploading…" amber chip', async ({ page, request }) => {
        await stubReportsList(page, [_stubReport({
            id: 'k5a-uploading',
            sync_status: 'PARTIAL',
            expected_media: 3,
            received_media: 1,
            media: [{ id: 'm1', type: 'IMAGE', resolution_tier: 'LOW',
                      assembly_status: 'pending', completion_pct: 33 }],
        })]);
        await bootDashboard(page, request);
        await page.waitForSelector('.qrt-card[data-report-id="k5a-uploading"]', { timeout: 10000 });
        // v55: non-blocking chips moved off the card into the detail panel.
        await page.evaluate(() => (window as any).openIncident('k5a-uploading'));
        const chipText = await page.locator(
            '#detail-body .dp-status-chips .k5a-chip-amber'
        ).first().textContent();
        expect(chipText).toContain('Uploading');
    });

    test('clean SYNCED report → no K.5.a chip', async ({ page, request }) => {
        await stubReportsList(page, [_stubReport({
            id: 'k5a-clean',
            sync_status: 'SYNCED',
            media: [{ id: 'm1', type: 'IMAGE', resolution_tier: 'LOW',
                      assembly_status: 'complete' }],
        })]);
        await bootDashboard(page, request);
        await page.waitForSelector('.qrt-card[data-report-id="k5a-clean"]', { timeout: 10000 });
        const count = await page.locator(
            '.qrt-card[data-report-id="k5a-clean"] .k5a-chip'
        ).count();
        expect(count, 'clean SYNCED report should render no K.5.a chip').toBe(0);
    });

    test('checksum_mismatch wins over Uploading (severity ordering)', async ({ page, request }) => {
        // Mix multiple signals; checksum_mismatch must take priority.
        await stubReportsList(page, [_stubReport({
            id: 'k5a-priority',
            sync_status: 'PARTIAL',
            media: [
                { id: 'm1', type: 'IMAGE', resolution_tier: 'LOW',
                  assembly_status: 'failed',
                  abandon_reason: 'checksum_mismatch',
                  abandoned_at: new Date().toISOString() },
                { id: 'm2', type: 'IMAGE', resolution_tier: 'MEDIUM',
                  assembly_status: 'pending', completion_pct: 40 },
            ],
        })]);
        await bootDashboard(page, request);
        await page.waitForSelector('.qrt-card[data-report-id="k5a-priority"]', { timeout: 10000 });

        const redCount = await page.locator(
            '.qrt-card[data-report-id="k5a-priority"] .k5a-chip-red'
        ).count();
        const amberCount = await page.locator(
            '.qrt-card[data-report-id="k5a-priority"] .k5a-chip-amber'
        ).count();
        expect(redCount, 'red chip (Media corrupt) must win').toBe(1);
        expect(amberCount, 'amber chip (Uploading) must NOT also appear').toBe(0);
    });
});
