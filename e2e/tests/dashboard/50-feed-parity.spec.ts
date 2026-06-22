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
 *   - building-tagged incidents lead with WHAT WAS HIT (the infra label), NOT the
 *     building name (the card sits under its building cluster, which already names it
 *     — feedback_no_redundant_parent_context); the building is reached from the
 *     cluster header, not a per-card link.
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
    // Building-first default: cards live inside collapsed building/ungrouped clusters
    // (the flat All-Incidents view was retired in v111). Expand the clusters so the
    // card-level assertions find the cards directly. Click the meta (not the title
    // button, which opens the building console).
    await page.evaluate(() => {
        document.querySelectorAll('.cc-cluster.collapsed .cc-cluster-meta').forEach((e) => (e as HTMLElement).click());
    });
    await page.waitForTimeout(200);
}

test.describe('Incident Feed — workflow parity (P0–P2)', () => {
    test('open incident card: decluttered (v137) — Confidence kept; status pill + Notify moved off the card', async ({ page, request }) => {
        await boot(page, request, [_stub({
            incident_credibility: { score: 51, band: 'MIXED', assessed: true, max_score: 100 },
        })]);
        const card = page.locator('.qrt-card[data-report-id="ctx-r1"]');
        await expect(card).toBeVisible({ timeout: 8000 });
        // The composite Confidence Score stays on the card (the one card number).
        const conf = card.locator('.qrt-confidence');
        await expect(conf).toContainText('Mixed');
        await expect(conf).toContainText('51');
        // v137 declutter: the "Needs review" status pill (redundant inside a status tab)
        // and the Notify CTA are NO LONGER on the card — they live in the hover preview +
        // detail panel. (The verdict-aware helpers are still unit-tested below.)
        await expect(card.locator('.qrt-status-pill')).toHaveCount(0);
        await expect(card.locator('.qrt-dispatch-btn')).toHaveCount(0);
        // No stale "SEND HELP" anywhere on the card.
        await expect(card).not.toContainText('SEND HELP');
    });

    test('building-tagged card shows WHAT WAS HIT, not the redundant building name', async ({ page, request }) => {
        // The card sits under its building in the feed, so it must NOT echo the
        // building name (feedback_no_redundant_parent_context). It leads with the
        // infra label ("what was hit") and is plain text (no building link on the card).
        await boot(page, request, [_stub({
            building_id: 'osm:way:123', infrastructure_name: 'Govt. Hospital, Shimla',
            infrastructure_name_from_osm: true, infrastructure_type: 'HOSPITAL',
        })]);
        const card = page.locator('.qrt-card[data-report-id="ctx-r1"]');
        await expect(card).toBeVisible({ timeout: 8000 });
        await expect(card.locator('.qrt-infra-name')).toContainText('Schools & hospitals');
        await expect(card.locator('.qrt-infra-name')).not.toContainText('Govt. Hospital');
        await expect(card.locator('.qrt-bldg-link')).toHaveCount(0);
    });

    test('"Other" free-text is the title TEXT, NOT a building link (from_osm=false)', async ({ page, request }) => {
        // Reporter typed free-text in "Other / what was hit"; the backend coords-resolved
        // a building_id but the name is NOT an OSM name (infrastructure_name_from_osm=false).
        // It must show as the title text, never as a clickable building / Console link.
        await boot(page, request, [_stub({
            infrastructure_type: 'OTHER', infrastructure_name: 'ahcvuwhscvuc',
            infrastructure_name_from_osm: false, building_id: 'osm:way:999',
        })]);
        const card = page.locator('.qrt-card[data-report-id="ctx-r1"]');
        await expect(card).toBeVisible({ timeout: 8000 });
        await expect(card.locator('.qrt-infra-name')).toContainText('ahcvuwhscvuc');
        await expect(card.locator('.qrt-bldg-link')).toHaveCount(0);
        const tagged = await page.evaluate(() => (window as any)._taggedBuildingName(
            { building_id: 'osm:way:999', infrastructure_name: 'ahcvuwhscvuc', infrastructure_name_from_osm: false }));
        expect(tagged).toBe(false);
    });

    test('reporter free-text title is attribute-escaped (no quote-breakout XSS)', async ({ page, request }) => {
        // infrastructure_name is anonymous reporter free-text. It lands in both the
        // title="..." attribute and the text node. escapeHtml does NOT escape the
        // double-quote, so the title attribute must use escapeAttr — otherwise a
        // value like `x" onmouseover="..."` breaks out and injects a handler.
        await boot(page, request, [_stub({
            infrastructure_type: 'OTHER',
            infrastructure_name: 'x" onmouseover="window.__xss=1',
            infrastructure_name_from_osm: false,
        })]);
        const card = page.locator('.qrt-card[data-report-id="ctx-r1"]');
        await expect(card).toBeVisible({ timeout: 8000 });
        const name = card.locator('.qrt-infra-name');
        // The injected handler attribute must NOT exist on the span (it would if the
        // quote broke out of title="...").
        const hasHandler = await name.evaluate((el) => el.hasAttribute('onmouseover'));
        expect(hasHandler).toBe(false);
        // The raw quote is stored as the title value (proves it was contained).
        const titleAttr = await name.getAttribute('title');
        expect(titleAttr).toContain('x" onmouseover');
        // Hovering must not have fired any injected handler.
        await name.hover();
        const fired = await page.evaluate(() => (window as any).__xss === 1);
        expect(fired).toBe(false);
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
            };
        });
        // Open: pill + CTA.
        expect(out.open).toContain('Needs review');
        expect(out.open).toContain('Notify');
        // Accepted: still offers Notify, but pill says Accepted.
        expect(out.accepted).toContain('Accepted');
        expect(out.accepted).toContain('Notify');
        // Responding: pill only, no live dispatch CTA.
        expect(out.responding).toContain('Responding');
        expect(out.responding).not.toContain('Notify Responders');
        // Rejected: pill only, never a dispatch CTA (fixes the rejected-queue bug).
        expect(out.rejected).toContain('Rejected');
        expect(out.rejected).not.toContain('Notify Responders');
        // Confidence suppressed to "Unrated" until assessed.
        expect(out.unrated).toContain('Unrated');
    });
});
