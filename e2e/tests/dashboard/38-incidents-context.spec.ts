/**
 * Dashboard — Incidents page "crisis command center" (v55).
 *
 * Verifies the context-awareness redesign: the analyst always knows WHERE they
 * are (the always-on Incident Context Banner), WHAT they're looking at (the
 * relocated KPI strip in the feed panel), and the Global-vs-Operation context
 * (the detail-panel breadcrumb). Also: feed-card simplification (technical chips
 * moved to the detail panel) and the reverse map↔feed marker highlight.
 *
 * Self-contained: stubs the /reports/ listing + fakes the admin token (no DB).
 */
import { test, expect } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

const DASH_URL = 'index.html';

function _stub(overrides = {}) {
    return {
        id: 'ctx-r1', client_report_id: 'ctx-c1', device_id: 'ctx-dev', source: 'APP',
        status: 'PENDING', sync_status: 'SYNCED', severity: 'CRITICAL',
        infrastructure_type: 'ROAD', damage_classification: 'PARTIAL', crisis_type: 'FLOOD',
        description: 'context banner test', expected_media: 0, received_media: 0,
        server_created_at: new Date().toISOString(), client_created_at: new Date().toISOString(),
        location: { latitude: 12.97, longitude: 77.59, device_latitude: 12.97, device_longitude: 77.59 },
        media: [], submitted_as_anonymous_due_to_expired_token: false,
        crisis_event_id: null, crisis_event_name: null,
        ...overrides,
    };
}

async function stubReports(page, reports) {
    await page.route(/\/api\/v1\/reports\/(\?|$)/, async (route) => {
        const url = route.request().url();
        if (/\/api\/v1\/reports\/[A-Za-z0-9-]/.test(url) && !url.includes('?')) { await route.continue(); return; }
        await route.fulfill({
            status: 200,
            headers: {
                'content-type': 'application/json', 'access-control-allow-origin': '*',
                'access-control-expose-headers': 'X-Total-Count, X-Server-Time, ETag',
                'X-Total-Count': String(reports.length),
                'X-Server-Time': new Date().toISOString().replace('+00:00', 'Z'),
                'ETag': `"ctx-${Date.now()}"`,
            },
            body: JSON.stringify(reports),
        });
    });
}

let _adminToken: string | null = null;
async function boot(page, request, reports) {
    if (!_adminToken) _adminToken = await ensureAdminAndLogin(request);
    await stubReports(page, reports);
    await page.goto(DASH_URL);
    await page.evaluate(({ token, email }) => {
        localStorage.setItem('crisp_token', token);
        localStorage.setItem('crisp_user', JSON.stringify({ email, role: 'SUPER_ADMIN', full_name: 'E2E Admin' }));
    }, { token: _adminToken, email: ADMIN.email });
    await page.reload();
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0,
        null, { timeout: 15000 });
    // Land on the global incidents feed.
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await page.waitForTimeout(400);
}

test.describe('Incidents page — context awareness (v55)', () => {
    test('GLOBAL context banner is always shown on /incidents', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        const banner = page.locator('#queue-banner');
        await expect(banner).toBeVisible();
        await expect(banner).toContainText('GLOBAL INCIDENTS');
        await expect(banner).toContainText('worldwide');
    });

    test('queue deep-link shows the matching context banner (CRITICAL)', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        await page.evaluate(() => { location.hash = '#/incidents;queue=critical'; });
        await expect(page.locator('#queue-banner')).toContainText('CRITICAL INCIDENTS', { timeout: 6000 });
    });

    test('KPI strip is in the feed panel + the top command-stats strip is gone', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        // Relocated, still click-to-filter, inside the feed panel.
        await expect(page.locator('.feed-panel .feed-kpi #stat-critical')).toBeVisible();
        await expect(page.locator('.feed-panel .feed-kpi #stat-total')).toBeVisible();
        // The old top segmented strip + Closed/Avg-Wait are gone.
        await expect(page.locator('.command-bar .cmd-status-seg')).toHaveCount(0);
        await expect(page.locator('#count-resolved')).toHaveCount(0);
        await expect(page.locator('#count-avg-response')).toHaveCount(0);
    });

    test('feed card is simplified — no data-progress icons / AI badge on the card', async ({ page, request }) => {
        await boot(page, request, [_stub({ verification: { total_score: 82, verdict: 'STRONG_MATCH' } })]);
        const card = page.locator('.qrt-card[data-report-id="ctx-r1"]');
        await expect(card).toBeVisible({ timeout: 8000 });
        await expect(card.locator('.qrt-data-progress')).toHaveCount(0);
        await expect(card.locator('.qrt-ai-badge')).toHaveCount(0);
        await expect(card.locator('.qrt-infra-icon')).toHaveCount(0);
        // ONE consolidated evidence chip carries the verification verdict.
        await expect(card.locator('.qrt-evidence')).toContainText('82');
    });

    test('detail breadcrumb shows GLOBAL context for an unassigned incident', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        await page.evaluate(() => (window as any).openIncident('ctx-r1'));
        const bc = page.locator('#detail-body .dp-breadcrumb');
        await expect(bc).toBeVisible({ timeout: 6000 });
        await expect(bc).toContainText('Global');
        await expect(bc).toContainText('Incident');
        await expect(bc).not.toContainText('Operations');
        // v57 regression guard: the detail panel (reparented to <body>) must sit
        // BELOW the fixed shell bar so its header + ✕ close are reachable - not
        // hidden behind the shell (the v56 top:16px bug).
        const dp = await page.locator('#detail-panel').boundingBox();
        const shellH = await page.locator('#crisp-globalnav').evaluate((e) => e.getBoundingClientRect().height);
        expect(dp && dp.y).toBeGreaterThanOrEqual(shellH);
        await expect(page.locator('#detail-panel .close-btn')).toBeVisible();
    });

    test('detail breadcrumb shows OPERATION context for an operation incident', async ({ page, request }) => {
        await boot(page, request, [_stub({ id: 'ctx-op', crisis_event_id: 'op-xyz', crisis_event_name: 'Bengaluru Wildfire' })]);
        await page.evaluate(() => (window as any).openIncident('ctx-op'));
        const bc = page.locator('#detail-body .dp-breadcrumb');
        await expect(bc).toBeVisible({ timeout: 6000 });
        await expect(bc).toContainText('Global');
        await expect(bc).toContainText('Operations');
        await expect(bc).toContainText('Bengaluru Wildfire');
    });

    test('reverse sync — selecting a feed incident highlights its map marker', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        await page.evaluate(() => (window as any).openIncident('ctx-r1'));
        // The single stubbed report's marker is un-clustered, so its pin gets the
        // selected-highlight class (the camera also flies, but we assert the pin).
        await expect(page.locator('.crisp-marker-sel')).toHaveCount(1, { timeout: 6000 });
    });

    // ── v58: operation switcher + op-scopable global feed + filter discoverability ──

    test('context banner exposes an always-on Operation switcher (v58)', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        // The GLOBAL banner carries a switcher CTA so analysts can scope into any
        // operation directly from the Incidents page.
        await expect(page.locator('#queue-banner .ctx-switch')).toBeVisible();
    });

    test('operation-scoped feed (#/incidents;op=X) shows OPERATION context + Global exit (v58)', async ({ page, request }) => {
        // Stub the operations list so the switcher / banner can resolve the op name.
        await page.route(/\/api\/v1\/operations(\?|$)/, async (route) => {
            await route.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
                body: JSON.stringify([
                    { id: 'op-xyz', name: 'Bengaluru Wildfire', place_name: 'Bengaluru', status: 'LIVE', critical_count: 3 },
                ]),
            });
        });
        await boot(page, request, [_stub({ crisis_event_id: 'op-xyz', crisis_event_name: 'Bengaluru Wildfire' })]);
        await page.evaluate(() => { location.hash = '#/incidents;op=op-xyz'; });
        const banner = page.locator('#queue-banner');
        await expect(banner).toContainText('OPERATION INCIDENTS', { timeout: 6000 });
        await expect(banner).toContainText('Bengaluru');
        // The op-scoped banner offers a one-click return to the global feed.
        await banner.locator('.qb-clear').click();
        await expect(banner).toContainText('GLOBAL INCIDENTS', { timeout: 6000 });
        // Returning to global must drop the op= state segment from the hash.
        await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('op=op-xyz');
    });

    test('secondary filters wrap (all visible) instead of hidden horizontal scroll (v58)', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        const row = page.locator('.cmd-filter-row');
        await expect(row).toBeVisible();
        const fw = await row.evaluate((e) => getComputedStyle(e).flexWrap);
        expect(fw).toBe('wrap');
    });

    test('ROUTE-01: opening an incident on the op-scoped feed stays in place (no eject to the op dashboard)', async ({ page, request }) => {
        await page.route(/\/api\/v1\/operations(\?|$)/, (route) => route.fulfill({
            status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
            body: JSON.stringify([{ id: 'op-xyz', name: 'Bengaluru Wildfire', place_name: 'Bengaluru', status: 'LIVE' }]),
        }));
        await boot(page, request, [_stub({ crisis_event_id: 'op-xyz', crisis_event_name: 'Bengaluru Wildfire' })]);
        await page.evaluate(() => { location.hash = '#/incidents;op=op-xyz'; });
        await page.waitForTimeout(400);
        // Click the op's own incident from within its scoped feed.
        await page.evaluate(() => (window as any).openIncident('ctx-r1', { operationId: 'op-xyz' }));
        // It must open IN PLACE: hash keeps /incidents;op=op-xyz (+ ?incident),
        // NOT navigate to the operation dashboard (/operations/op-xyz).
        await expect.poll(() => page.evaluate(() => location.hash), { timeout: 6000 })
            .toContain('/incidents;op=op-xyz');
        expect(await page.evaluate(() => location.hash)).not.toContain('/operations/');
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 6000 });
    });

    test('ROUTE-09: incident search survives a refresh (sessionStorage)', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        // Simulate typing: set the box value + fire its oninput (→ _onIncidentSearch).
        await page.evaluate(() => {
            const i = document.getElementById('tree-search') as HTMLInputElement;
            i.value = 'flood';
            i.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await expect(page.locator('#tree-search')).toHaveValue('flood');
        // Refresh — the term must be restored into the box (was dropped pre-fix).
        await page.reload();
        await page.waitForFunction(
            () => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0,
            null, { timeout: 15000 });
        await expect(page.locator('#tree-search')).toHaveValue('flood', { timeout: 6000 });
    });
});
