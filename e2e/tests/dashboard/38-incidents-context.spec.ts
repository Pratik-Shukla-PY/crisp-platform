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
        const banner = page.locator('#feed-scope-bar');
        await expect(banner).toBeVisible();
        // The banner is now a breadcrumb spine; the global leaf is the "Global" crumb.
        await expect(banner.locator('.qb-crumbs')).toContainText('Global');
    });

    test('queue deep-link shows the matching context banner (CRITICAL)', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        await page.evaluate(() => { location.hash = '#/incidents;queue=critical'; });
        await expect(page.locator('#feed-scope-bar')).toContainText('CRITICAL INCIDENTS', { timeout: 6000 });
    });

    test('status TABS + Critical filter are in the feed panel; the old KPI strip + view toggle are gone (v111)', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        // Row 2 of the feed panel: the three status tabs + the Critical quick-filter.
        await expect(page.locator('.feed-panel .feed-tabs .feed-tab[data-tab="pending"]')).toBeVisible();
        await expect(page.locator('.feed-panel .feed-tabs .feed-tab[data-tab="responding"]')).toBeVisible();
        await expect(page.locator('.feed-panel .feed-tabs .feed-tab[data-tab="resolved"]')).toBeVisible();
        await expect(page.locator('.feed-panel .feed-tabs #stat-critical')).toBeVisible();
        // The old top segmented strip, the 4-pill KPI strip, and the view toggle are gone.
        await expect(page.locator('.command-bar .cmd-status-seg')).toHaveCount(0);
        await expect(page.locator('.feed-kpi')).toHaveCount(0);
        await expect(page.locator('.view-btn')).toHaveCount(0);
        await expect(page.locator('#count-avg-response')).toHaveCount(0);
    });

    test('feed card carries the composite Confidence Score, not the satellite sub-score', async ({ page, request }) => {
        await boot(page, request, [_stub({
            verification: { total_score: 82, verdict: 'STRONG_MATCH' },
            incident_credibility: { score: 72, band: 'LIKELY', assessed: true, max_score: 100 },
        })]);
        // Asserts CARD rendering. The feed is always building-grouped now; this
        // building-less report sits in the collapsed "Ungrouped" bucket - expand it.
        await page.locator('.cc-cluster[data-cluster-key="ungrouped"] .cc-cluster-main').click();
        const card = page.locator('.qrt-card[data-report-id="ctx-r1"]');
        await expect(card).toBeVisible({ timeout: 8000 });
        await expect(card.locator('.qrt-data-progress')).toHaveCount(0);
        await expect(card.locator('.qrt-ai-badge')).toHaveCount(0);
        await expect(card.locator('.qrt-infra-icon')).toHaveCount(0);
        // The card now shows the composite Confidence Score + band (72 / Likely),
        // NOT the raw satellite truth-score (82). The old evidence chip is gone.
        const conf = card.locator('.qrt-confidence');
        await expect(conf).toContainText('72');
        await expect(conf).toContainText('Likely');
        await expect(card.locator('.qrt-evidence')).toHaveCount(0);
    });

    test('detail breadcrumb shows GLOBAL context for an unassigned incident', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        await page.evaluate(() => (window as any).openIncident('ctx-r1'));
        const bc = page.locator('#detail-body .dp-breadcrumb');
        await expect(bc).toBeVisible({ timeout: 6000 });
        await expect(bc).toContainText('Global');
        // breadcrumb ends with the incident's short report id, not the word "Incident"
        await expect(bc).toContainText('#ctx-r1');
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
        // "Global › {Operation name} › #{id}" - the redundant standalone "Operations"
        // segment is gone; the operation NAME + the report id carry the context.
        await expect(bc).toContainText('Bengaluru Wildfire');
        await expect(bc).toContainText('#ctx-op');
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
        await expect(page.locator('#feed-scope-bar .ctx-switch')).toBeVisible();
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
        const banner = page.locator('#feed-scope-bar');
        // Op scope reads on the breadcrumb spine: Global › {operation name}.
        await expect(banner.locator('.qb-crumbs')).toContainText('Bengaluru Wildfire', { timeout: 6000 });
        // The redundant shell breadcrumb bar ("CRISP / Operations / …") is hidden
        // on the Incidents page - the in-feed banner above already carries the op.
        await expect(page.locator('#cgn-context-banner')).toBeHidden();
        // The clickable "Global" crumb steps back out to the global feed.
        await banner.locator('.qb-crumbs .qb-crumb-global').click();
        await expect(banner.locator('.qb-crumbs')).not.toContainText('Bengaluru', { timeout: 6000 });
        // Returning to global must drop the op= state segment from the hash.
        await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('op=op-xyz');
    });

    test('secondary filters wrap (all visible) instead of hidden horizontal scroll (v58)', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        // Filters are a popover off the filter icon now; open it, then assert it
        // wraps (all chips visible, no hidden horizontal scroll).
        await page.locator('#feed-filter-btn').click();
        const row = page.locator('.cmd-filter-row');
        await expect(row).toBeVisible();
        const fw = await row.evaluate((e) => getComputedStyle(e).flexWrap);
        expect(fw).toBe('wrap');
    });

    test('FILTERS are a popover: hidden by default, the filter icon opens the chips (v111)', async ({ page, request }) => {
        await boot(page, request, [_stub()]);
        const row = page.locator('.cmd-filter-row');
        const chip = row.locator('.cmd-filter-chip[data-chip="debris"]');
        // Default closed: the popover (and its chips) are hidden so the incident
        // cards get the vertical space.
        await expect(row).toBeHidden();
        // Clicking the filter icon opens the popover.
        await page.locator('#feed-filter-btn').click();
        await expect(row).toBeVisible();
        await expect(chip).toBeVisible();
        // Clicking the icon again closes it.
        await page.locator('#feed-filter-btn').click();
        await expect(row).toBeHidden();
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

    test('ROUTE-01b: opening an OP incident on the GLOBAL feed STAYS on /incidents (op-scopes in place, never ejects to the op dashboard)', async ({ page, request }) => {
        await page.route(/\/api\/v1\/operations(\?|$)/, (route) => route.fulfill({
            status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
            body: JSON.stringify([{ id: 'op-xyz', name: 'Bengaluru Wildfire', place_name: 'Bengaluru', status: 'LIVE' }]),
        }));
        // Land on the GLOBAL feed; the visible report belongs to op-xyz.
        await boot(page, request, [_stub({ crisis_event_id: 'op-xyz', crisis_event_name: 'Bengaluru Wildfire' })]);
        await page.evaluate(() => { location.hash = '#/incidents'; });
        await expect(page.locator('#feed-scope-bar .qb-crumbs')).toContainText('Global', { timeout: 6000 });

        // Click the op-owned incident from the GLOBAL feed (no explicit operationId,
        // so the op is resolved from the report's crisis_event_id).
        await page.evaluate(() => (window as any).openIncident('ctx-r1'));

        // THE FIX: it stays on /incidents and op-scopes IN PLACE - it must NOT
        // navigate to the operation dashboard (/operations/op-xyz).
        await expect.poll(() => page.evaluate(() => location.hash), { timeout: 6000 }).toContain('/incidents;op=op-xyz');
        const h = await page.evaluate(() => location.hash);
        expect(h).not.toContain('/operations/');
        expect(h).toContain('incident=ctx-r1');
        // The feed header now NAMES the operation (breadcrumb crumb), and the detail is open.
        await expect(page.locator('#feed-scope-bar .qb-crumbs')).toContainText('Bengaluru Wildfire', { timeout: 6000 });
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
