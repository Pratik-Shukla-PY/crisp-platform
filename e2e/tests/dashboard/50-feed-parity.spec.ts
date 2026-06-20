/**
 * Dashboard — Incident Feed parity with the incident workflow (P0–P2).
 *
 * After the detail-page redesign (composite Confidence Score, Notify Responders,
 * verdict-aware status, Global > Operation > Building > Incident hierarchy), the
 * left-hand feed card must mirror that workflow. This spec locks in:
 *   - the card shows the composite Confidence Score + band (not the satellite
 *     sub-score), via the shared _confidenceChip helper;
 *   - the action is "Notify Responders" (not "SEND HELP"), only for OPEN incidents;
 *   - a verdict-aware status pill (Needs review / Accepted / Rejected / Responding
 *     / Resolved / False alarm) drawn from the same _displayStatus as the detail;
 *   - rejected incidents never render a live dispatch CTA;
 *   - building-tagged incidents show the BUILDING name as the title + a Console link.
 *
 * Self-contained: stubs the /reports/ listing + fakes the admin token (no DB).
 */
import { test, expect } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

const DASH_URL = 'index.html';

function _stub(overrides: Record<string, any> = {}) {
    return {
        id: 'ctx-r1', client_report_id: 'ctx-c1', device_id: 'ctx-dev', source: 'APP',
        status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', sync_status: 'SYNCED', severity: 'CRITICAL',
        infrastructure_type: 'ROAD', damage_classification: 'PARTIAL', crisis_type: 'FLOOD',
        description: 'feed parity test', expected_media: 0, received_media: 0,
        server_created_at: new Date().toISOString(), client_created_at: new Date().toISOString(),
        location: { latitude: 12.97, longitude: 77.59, device_latitude: 12.97, device_longitude: 77.59 },
        media: [], submitted_as_anonymous_due_to_expired_token: false,
        crisis_event_id: null, crisis_event_name: null,
        ...overrides,
    };
}

async function stubReports(page: any, reports: any[]) {
    await page.route(/\/api\/v1\/reports\/(\?|$)/, async (route: any) => {
        const url = route.request().url();
        if (/\/api\/v1\/reports\/[A-Za-z0-9-]/.test(url) && !url.includes('?')) { await route.continue(); return; }
        await route.fulfill({
            status: 200,
            headers: {
                'content-type': 'application/json', 'access-control-allow-origin': '*',
                'access-control-expose-headers': 'X-Total-Count, X-Server-Time, ETag',
                'X-Total-Count': String(reports.length),
                'X-Server-Time': new Date().toISOString().replace('+00:00', 'Z'),
                'ETag': `"parity-${Date.now()}"`,
            },
            body: JSON.stringify(reports),
        });
    });
}

let _adminToken: string | null = null;
async function boot(page: any, request: any, reports: any[]) {
    if (!_adminToken) _adminToken = await ensureAdminAndLogin(request);
    await stubReports(page, reports);
    await page.goto(DASH_URL);
    await page.evaluate(({ token, email }: any) => {
        localStorage.setItem('crisp_token', token);
        localStorage.setItem('crisp_user', JSON.stringify({ email, role: 'SUPER_ADMIN', full_name: 'E2E Admin' }));
    }, { token: _adminToken, email: ADMIN.email });
    await page.reload();
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0,
        null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await page.waitForTimeout(400);
}

test.describe('Incident Feed — workflow parity (P0–P2)', () => {
    test('open incident card: Notify Responders CTA + Needs review pill + composite Confidence', async ({ page, request }) => {
        await boot(page, request, [_stub({
            incident_credibility: { score: 51, band: 'MIXED', assessed: true, max_score: 100 },
        })]);
        const card = page.locator('.qrt-card[data-report-id="ctx-r1"]');
        await expect(card).toBeVisible({ timeout: 8000 });
        await expect(card.locator('.qrt-dispatch-btn')).toContainText('Notify Responders');
        await expect(card.locator('.qrt-status-pill.st-needs-review')).toContainText('Needs review');
        const conf = card.locator('.qrt-confidence');
        await expect(conf).toContainText('Mixed');
        await expect(conf).toContainText('51');
        // No stale "SEND HELP" anywhere on the card.
        await expect(card).not.toContainText('SEND HELP');
    });

    test('building-tagged incident: building name is the title + Console link', async ({ page, request }) => {
        await boot(page, request, [_stub({
            building_id: 'osm:way:123', infrastructure_name: 'Govt. Hospital, Shimla',
            infrastructure_type: 'HOSPITAL',
        })]);
        const card = page.locator('.qrt-card[data-report-id="ctx-r1"]');
        await expect(card).toBeVisible({ timeout: 8000 });
        await expect(card.locator('.qrt-infra-name')).toContainText('Govt. Hospital, Shimla');
        await expect(card.locator('.qrt-bldg-link')).toBeVisible();
    });

    test('verdict-aware card helpers: open / accepted / responding / rejected / unrated', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        const out = await page.evaluate(() => {
            const w = window as any;
            return {
                open: w._cardActionEl({ id: 'a', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED' }),
                accepted: w._cardActionEl({ id: 'b', status: 'VERIFIED', reviewer_verdict: 'ACCEPTED' }),
                responding: w._cardActionEl({ id: 'c', status: 'RESPONDING' }),
                rejected: w._cardActionEl({ id: 'd', status: 'PENDING', reviewer_verdict: 'REJECTED' }),
                unrated: w._confidenceChip({ id: 'e', incident_credibility: null }),
                bldgTitle: w._cardTitle({ building_id: 'osm:way:9', infrastructure_name: 'Riverside Apartments', infrastructure_type: 'RESIDENTIAL' }),
            };
        });
        // Open: pill + CTA.
        expect(out.open).toContain('Needs review');
        expect(out.open).toContain('Notify Responders');
        // Accepted: still offers Notify, but pill says Accepted.
        expect(out.accepted).toContain('Accepted');
        expect(out.accepted).toContain('Notify Responders');
        // Responding: pill only, no live dispatch CTA.
        expect(out.responding).toContain('Responding');
        expect(out.responding).not.toContain('Notify Responders');
        // Rejected: pill only, never a dispatch CTA (fixes the rejected-queue bug).
        expect(out.rejected).toContain('Rejected');
        expect(out.rejected).not.toContain('Notify Responders');
        // Confidence suppressed to "Unrated" until assessed.
        expect(out.unrated).toContain('Unrated');
        // Building name wins the title when building-tagged.
        expect(out.bldgTitle).toContain('Riverside Apartments');
    });
});
