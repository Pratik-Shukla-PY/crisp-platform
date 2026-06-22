/**
 * Dashboard — hierarchy + building-name consistency (v118).
 *
 *  - The incident-detail breadcrumb ALWAYS shows the 4-level spine
 *    Global › Operation › Building › Incident; absent levels render as muted,
 *    non-clickable placeholders (.dp-bc-absent "No operation" / "Unmapped building"),
 *    never silently dropped (the "Global › Incident › #id" bug).
 *  - When operation + building are present they render as real links.
 *  - A building NAME shown anywhere comes from the OSM record only — a reporter's
 *    free-text "What Was Hit?" (infrastructure_name_from_osm === false) is never
 *    presented as the building (shows the "Unmapped building" placeholder instead).
 *
 * Self-contained: fake admin token + stubbed /reports/ list & by-id (no DB).
 */
import { test, expect } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

function _stub(o: Record<string, any> = {}) {
    return {
        id: 'hier-r1', client_report_id: 'hc1', device_id: 'dev', source: 'APP',
        status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', sync_status: 'SYNCED', severity: 'MODERATE',
        infrastructure_type: 'ROAD', crisis_type: 'FLOOD', damage_classification: 'PARTIAL',
        description: 'hierarchy test', expected_media: 0, received_media: 0, media: [],
        server_created_at: new Date().toISOString(), client_created_at: new Date().toISOString(),
        location: { latitude: 12.97, longitude: 77.59 },
        crisis_event_id: null, crisis_event_name: null, building_id: null, incident_id: null,
        infrastructure_name: null, infrastructure_name_from_osm: null,
        ...o,
    };
}

let _tok: string | null = null;
async function openDetail(page: any, request: any, rep: any) {
    if (!_tok) _tok = await ensureAdminAndLogin(request);
    await page.route(/\/api\/v1\/reports\//, async (route: any) => {
        const u = route.request().url();
        const byId = /\/api\/v1\/reports\/[A-Za-z0-9-]+(\?|$)/.test(u) && !/\/reports\/\?/.test(u);
        await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*',
                'access-control-expose-headers': 'X-Total-Count', 'X-Total-Count': '1' },
            body: JSON.stringify(byId ? rep : [rep]),
        });
    });
    await page.goto('index.html');
    await page.evaluate(({ token, email }: any) => {
        localStorage.setItem('crisp_token', token);
        localStorage.setItem('crisp_user', JSON.stringify({ email, role: 'SUPER_ADMIN', full_name: 'E2E' }));
    }, { token: _tok, email: ADMIN.email });
    await page.reload();
    await page.waitForFunction(() => Array.isArray((window as any).allReports), null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await page.waitForTimeout(300);
    await page.evaluate((id) => (window as any).openIncident(id), rep.id);
    await expect(page.locator('#detail-panel .dp-breadcrumb')).toBeVisible({ timeout: 8000 });
}

test.describe('Dashboard — hierarchy & building-name consistency (v118)', () => {
    test('no operation + no building → muted placeholders, spine never collapses', async ({ page, request }) => {
        await openDetail(page, request, _stub());
        const bc = page.locator('#detail-panel .dp-breadcrumb');
        await expect(bc).toContainText('Global');
        await expect(bc).toContainText('No operation');
        await expect(bc).toContainText('Unmapped building');
        // placeholders are muted, non-link
        await expect(bc.locator('.dp-bc-absent')).toHaveCount(2);
    });

    test('operation + OSM building present → real links, no placeholders', async ({ page, request }) => {
        await openDetail(page, request, _stub({
            crisis_event_id: 'op-7', crisis_event_name: 'Chennai Flood Response',
            building_id: 'osm:way:42', infrastructure_name: 'Apollo Hospital', infrastructure_name_from_osm: true,
        }));
        const bc = page.locator('#detail-panel .dp-breadcrumb');
        await expect(bc).toContainText('Chennai Flood Response');
        await expect(bc).toContainText('Apollo Hospital');
        await expect(bc.locator('.dp-bc-absent')).toHaveCount(0);
        await expect(bc.locator('.dp-bc-op')).toHaveCount(1);
        await expect(bc.locator('.dp-bc-bldg')).toHaveCount(1);
    });

    test('free-text "What Was Hit?" is NEVER shown as the building name', async ({ page, request }) => {
        await openDetail(page, request, _stub({
            building_id: 'osm:way:99', infrastructure_name: 'the blue shop near the river',
            infrastructure_name_from_osm: false,   // reporter free-text, not an OSM footprint
        }));
        const bc = page.locator('#detail-panel .dp-breadcrumb');
        await expect(bc).not.toContainText('the blue shop near the river');
        await expect(bc).toContainText('Unmapped building');
    });
});
