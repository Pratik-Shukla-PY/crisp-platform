/**
 * Dashboard — Building as a first-class operational entity (v113).
 *
 * Building Console gains: a Building Assessment card + workspace (Run Building
 * Assessment → consolidated confidence + per-incident list), a state-machine
 * ACTIONS group that CASCADES to the building's incidents (Resolve / False Alarm /
 * Notify / Reject / Reopen), and a standalone Assessment Report PDF. Mirrors the
 * incident-level UX; no incident-level regression.
 *
 * Self-contained: fake token + stubbed /api/v1/** (no backend). Mutable closure
 * state simulates the building's evolving assessment + state across calls.
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const OPERATIONS = [{ id: 'op-a', name: 'Chennai Flood Response', place_name: 'Chennai', status: 'LIVE', is_active: true, critical: 1 }];

// Two reports in bldA across two operations (so op-scope is testable).
const REPORTS = [
    { id: 'r1', building_id: 'bldA', infrastructure_name: 'Apollo Hospital', severity: 'SEVERE', status: 'PENDING',
      reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD', crisis_event_id: 'op-a', server_created_at: NOW,
      location: { latitude: 12.93, longitude: 77.62, user_location_name: 'Koramangala' } },
    { id: 'r2', building_id: 'bldA', infrastructure_name: 'Apollo Hospital', severity: 'MODERATE', status: 'PENDING',
      reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD', crisis_event_id: 'op-b', server_created_at: NOW,
      location: { latitude: 12.93, longitude: 77.62, user_location_name: 'Koramangala' } },
];

function bldDetail(state: string, assessment: any) {
    return {
        id: 'bldA', state, severity_max: 'SEVERE', report_count: 2,
        verified_report_count: 0, responding_report_count: 0, debris_clearing_needed_count: 0,
        crisis_types_top3: ['FLOOD'], centroid_lat: 12.93, centroid_lng: 77.62, osm_name: 'Apollo Hospital',
        severity_score: 60, confidence_score: 50, activity_score: 40, escalation_risk: 30, humanitarian_priority: 55,
        first_report_at: NOW, latest_report_at: NOW,
        reports: REPORTS, responders: [], monitors: [], notes: [], assessment,
    };
}

const RISK = {
    score: 78, band: 'HIGH', assessed: true, coverage: { assessed: 1, total: 1 },
    factors: [
        { key: 'severity', label: 'Severity & damage', max: 30, ran: true, awarded: 24, reason: 'Worst severity SEVERE across 1 incident(s).' },
        { key: 'incidents', label: 'Incident assessments', max: 25, ran: true, awarded: 18, reason: 'Severity-weighted mean incident confidence 74/100 across 1 assessed incident(s).' },
        { key: 'corroboration', label: 'Corroboration & volume', max: 20, ran: true, awarded: 9, reason: '1 incident(s) · 2 report(s) · 1 independent source channel(s).' },
        { key: 'evidence', label: 'Evidence verification', max: 15, ran: true, awarded: 5, reason: 'No satellite verdicts yet; 0% carry photo evidence.' },
        { key: 'recency', label: 'Recency & escalation', max: 10, ran: true, awarded: 7, reason: 'Latest report 0h ago; 1 report(s) in the last 24h.' },
    ],
};
const ASSESSMENT = {
    risk: RISK,
    incidents: [{ incident_id: 'i1', report_id: 'r1', title: 'Apollo Hospital', severity: 'SEVERE', score: 74, band: 'LIKELY', cached: false }],
    counts: { incident_count: 1, assessed: 1, cached: 0, queued: 0 },
    recommendation: 'Dispatch responders', assessed_at: NOW,
};

async function boot(page: Page) {
    const st = { state: 'ACTIVE', assessed: false };
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'SUPER_ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        const m = route.request().method();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: {}, distributions: {}, timings: {}, impact: {}, deltas: {} } });
        if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/reports/buildings-needing-review')) return route.fulfill({ json: { buildings: [], total_buildings: 0, total_pairs: 0 } });
        // Building assessment orchestration.
        if (/\/buildings\/bldA\/assess/.test(u) && m === 'POST') {
            st.assessed = true;
            return route.fulfill({ json: { building_id: 'bldA', risk: RISK, incidents: ASSESSMENT.incidents, counts: ASSESSMENT.counts, recommendation: ASSESSMENT.recommendation, legacy_fallback: false, assessed_at: NOW } });
        }
        // Cascade actions.
        const cm = u.match(/\/buildings\/bldA\/cascade\/([a-z-]+)/);
        if (cm && m === 'POST') {
            const action = cm[1];
            st.state = { resolve: 'RESOLVED', 'false-alarm': 'FALSE_ALARM', notify: 'RESPONDING', reopen: 'ACTIVE', reject: st.state }[action] || st.state;
            return route.fulfill({ json: { action, building_state: st.state, counts: { reports_changed: 2, skipped: 0, incidents_changed: 1 }, reason: null } });
        }
        if (/\/buildings\/bldA\/assessment\.pdf/.test(u)) {
            return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 stub' });
        }
        // Building Console incidents list. The server builds inc.title as
        // "{Crisis} - {building name}", so the row MUST lead with the crisis label,
        // not the building-name-bearing title (feedback_no_redundant_parent_context).
        if (/\/incidents\?.*building_id=bldA/.test(u)) {
            return route.fulfill({ json: [
                { id: 'i1', title: 'Flood - Apollo Hospital', incident_type: 'FLOOD',
                  severity: 'SEVERE', status: 'OPEN', report_count: 2 },
            ] });
        }
        if (/\/buildings\/bldA(\?|$)/.test(u)) {
            return route.fulfill({ json: bldDetail(st.state, st.assessed ? ASSESSMENT : null) });
        }
        if (/\/reports\/?\?/.test(u)) {
            const scoped = /crisis_event_id=op-a/.test(u);
            const list = scoped ? REPORTS.filter((r) => r.crisis_event_id === 'op-a') : REPORTS;
            return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(list.length) }, json: list });
        }
        const single = u.match(/\/reports\/([a-z0-9]+)(?:\?|$)/);
        if (single) return route.fulfill({ json: REPORTS.find((r) => r.id === single[1]) || {} });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports), null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await page.waitForTimeout(300);
    return st;
}

async function openConsole(page: Page) {
    await page.evaluate(() => (window as any).openBuildingConsole('bldA'));
    await expect(page.locator('#detail-panel.detail-panel--building')).toBeVisible({ timeout: 8000 });
}

test.describe('Dashboard — Building operational entity (v113)', () => {
    test('@smoke Building Risk card: CTA → run → scored (.dp-assess) + breakdown workspace', async ({ page }) => {
        await boot(page);
        await openConsole(page);
        // ONE consolidated Building Risk Score card, reusing the incident .dp-assess UX.
        const cta = page.locator('#detail-panel .dp-assess-cta');
        await expect(cta).toBeVisible({ timeout: 8000 });
        await cta.click();
        // After the POST, the card re-renders to the scored row (risk score = 78 HIGH).
        await expect(page.locator('#detail-panel .dp-assess-scored')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#detail-panel .dp-assess-num')).toContainText('78');
        await expect(page.locator('#detail-panel .dp-assess-band')).toContainText('High priority');
        // ONE score only — the old competing Intelligence-scores 5-grid is GONE.
        await expect(page.locator('#detail-panel .bc-scores')).toHaveCount(0);
        // Open the breakdown → 5 weighted factor bars + the contributing incident.
        await page.locator('#detail-panel .dp-assess-scorerow').click();
        await expect(page.locator('#bldg-assess-modal')).toBeVisible({ timeout: 6000 });
        await expect(page.locator('#bldg-assess-modal .assess-factor')).toHaveCount(5);
        await expect(page.locator('#bldg-assess-modal .bldg-inc-row')).toHaveCount(1);
        await expect(page.locator('#bldg-assess-modal')).toContainText('Apollo Hospital');
        await expect(page.locator('#bldg-assess-modal')).toContainText('Dispatch responders');
    });

    test('@smoke cascade Resolve confirms scope then resolves the building', async ({ page }) => {
        await boot(page);
        await openConsole(page);
        // ACTIVE building → Notify primary. Notify → RESPONDING, then Resolve → RESOLVED.
        await page.evaluate(() => (window as any).buildingNotify('bldA'));
        await page.locator('.crisp-action-confirm').click();
        await expect(page.locator('#detail-panel .bc-state')).toContainText('RESPONDING', { timeout: 6000 });
        await page.evaluate(() => (window as any).buildingResolve('bldA'));
        await expect(page.locator('.crisp-action-modal')).toContainText('open incident');
        await page.locator('.crisp-action-confirm').click();
        await expect(page.locator('#detail-panel .bc-state')).toContainText('RESOLVED', { timeout: 6000 });
        // RESOLVED → only Reopen is offered.
        await expect(page.locator('.bc-act-group .dp-act-revert')).toBeVisible({ timeout: 6000 });
    });

    test('@smoke cascade Reject requires a reason then cascades', async ({ page }) => {
        await boot(page);
        await openConsole(page);
        await page.evaluate(() => (window as any).buildingReject('bldA'));
        await expect(page.locator('.crisp-action-modal.crisp-action-danger')).toBeVisible();
        await page.locator('.crisp-action-confirm').click();   // empty reason blocked
        await expect(page.locator('#crisp-bldg-rej-reason.crisp-action-invalid')).toBeVisible();
        await page.locator('#crisp-bldg-rej-reason').fill('bogus cluster');
        const [req] = await Promise.all([
            page.waitForRequest((r) => /\/buildings\/bldA\/cascade\/reject/.test(r.url()) && r.method() === 'POST'),
            page.locator('.crisp-action-confirm').click(),
        ]);
        expect(req).toBeTruthy();
    });

    test('@smoke Assessment Report PDF button hits the endpoint', async ({ page }) => {
        await boot(page);
        await openConsole(page);
        await page.locator('#detail-panel .dp-assess-cta').click();
        const report = page.locator('#detail-panel .bc-risk-actions button', { hasText: 'Report' });
        await expect(report).toBeVisible({ timeout: 8000 });
        const [req] = await Promise.all([
            page.waitForRequest((r) => /\/buildings\/bldA\/assessment\.pdf/.test(r.url())),
            report.click(),
        ]);
        expect(req).toBeTruthy();
    });

    test('@smoke op-scope survives an in-console action (v112 regression guard)', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => { location.hash = '#/incidents;op=op-a'; });
        await page.waitForTimeout(300);
        await openConsole(page);
        // Op-scoped: only op-a's report (r1) listed; the title note shows the op.
        await expect(page.locator('#detail-title .bc-opscope')).toBeVisible({ timeout: 8000 });
        // Fire a cascade action → console re-renders; op-scope must persist.
        await page.evaluate(() => (window as any).buildingNotify('bldA'));
        await page.locator('.crisp-action-confirm').click();
        await page.waitForTimeout(400);
        await expect(page.locator('#detail-title .bc-opscope')).toBeVisible();
        // The op-scoped view still reflects 1 of 2 reports.
        await expect(page.locator('#detail-title .bc-opscope')).toContainText('1/2');
    });

    test('@smoke incident row leads with the crisis type, NOT the redundant building name', async ({ page }) => {
        // The Building Console header already names the building (Apollo Hospital); the
        // per-incident rows below it must lead with the incident's own identity (crisis
        // type) and must NOT repeat the building name (feedback_no_redundant_parent_context).
        await boot(page);
        await openConsole(page);
        const row = page.locator('#detail-panel .bc-r-crisis').first();
        await expect(row).toBeVisible({ timeout: 8000 });
        await expect(row).toContainText('Flood');
        await expect(row).not.toContainText('Apollo Hospital');
    });

    test('@smoke building card header is a keyboard-accessible control (a11y)', async ({ page }) => {
        // v116: the whole card header (not a separate name button) is the click target
        // that expands incidents + opens the console - so it carries the a11y role.
        await boot(page);
        const header = page.locator('.cc-cluster[data-cluster-key="b:bldA"] .qrt-section-header');
        await expect(header).toBeVisible({ timeout: 8000 });
        expect(await header.getAttribute('role')).toBe('button');
        expect(await header.getAttribute('tabindex')).toBe('0');
        // Enter key expands it (and opens the console).
        await header.focus();
        await header.press('Enter');
        await expect(page.locator('.cc-cluster[data-cluster-key="b:bldA"]')).not.toHaveClass(/collapsed/);
    });
});
