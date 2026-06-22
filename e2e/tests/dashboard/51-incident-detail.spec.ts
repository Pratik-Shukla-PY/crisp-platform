/**
 * Dashboard — Incident Detail (Building-centric Incident-Feed redesign Phase 2E).
 *
 * The first-class Incident view (window.openIncidentDetail) renders incident info +
 * member reports + the analyst merge/split/status controls, backed by the Phase-2D
 * /api/v1/incidents endpoints. It is DELIBERATELY separate from selectReport (the
 * per-report detail) - both share #detail-panel but render independently.
 *
 * Fully stubbed (no backend): fake token + stubbed /api/v1/** like 41-load-order.
 */
import { test, expect, Page } from '@playwright/test';

const INCIDENT = {
    id: 'inc-1', title: 'Earthquake - Riverside Tower', status: 'OPEN', severity: 'CRITICAL',
    severity_overridden: false, incident_type: 'EARTHQUAKE', building_id: 'bldg-1',
    lead_report_id: 'r1', report_count: 2,
    reports: [
        { id: 'r1', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED',
          crisis_type: 'EARTHQUAKE', infrastructure_type: 'HOSPITAL', source: 'APP',
          description: 'Tower collapsed, people trapped', is_lead: true },
        { id: 'r2', severity: 'MODERATE', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED',
          crisis_type: 'EARTHQUAKE', infrastructure_type: 'HOSPITAL', source: 'WHATSAPP',
          description: 'Cracks on the 3rd floor', is_lead: false },
    ],
};
const SIBLINGS = [
    INCIDENT,
    { id: 'inc-2', title: 'Earthquake - Annex', status: 'OPEN', severity: 'SEVERE',
      building_id: 'bldg-1', report_count: 1, lead_report_id: 'r9' },
];

const calls: { method: string, url: string, body: any }[] = [];

async function boot(page: Page) {
    calls.length = 0;
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const req = route.request();
        const u = req.url();
        const m = req.method();
        let body: any = null;
        try { body = m === 'POST' || m === 'PATCH' ? req.postDataJSON() : null; } catch (_e) {}
        calls.push({ method: m, url: u, body });

        const json = (j: any) => route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(j) });

        if (/\/incidents\/split-report/.test(u)) return json({ split: true, incident: { ...INCIDENT, id: 'inc-new', report_count: 1 } });
        if (/\/incidents\/move-report/.test(u)) return json({ moved: true, incident: INCIDENT });
        if (/\/incidents\/[^/?]+\/merge/.test(u)) return json({ merged: true, incident: SIBLINGS[1] });
        if (/\/incidents\?|\/incidents$/.test(u)) return json(SIBLINGS);              // list
        if (/\/incidents\/inc-1$/.test(u) && m === 'PATCH') return json({ ...INCIDENT, status: (body && body.status) || INCIDENT.status, severity: (body && body.severity) || INCIDENT.severity });
        if (/\/incidents\/[^/?]+$/.test(u)) return json(INCIDENT);                    // detail
        if (/\/analytics\/summary/.test(u)) return json({ counts: {}, distributions: {}, timings: {}, impact: {}, deltas: {} });
        if (/\/reports\//.test(u)) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '0' }, json: [] });
        return json({});
    });
    await page.goto('index.html');
    await page.waitForFunction(() => typeof (window as any).openIncidentDetail === 'function', null, { timeout: 10000 });
}

test.describe('Dashboard — Incident Detail (Phase 2E)', () => {
    test('renders incident info + member reports', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => (window as any).openIncidentDetail('inc-1'));
        const panel = page.locator('#detail-panel');
        await expect(panel).toBeVisible({ timeout: 8000 });
        await expect(panel.locator('.incd-title')).toContainText('Riverside Tower');
        await expect(panel.locator('[data-incd-statuspill]')).toContainText('OPEN');
        // Both member reports render; the lead is flagged.
        await expect(panel.locator('[data-incd-open]')).toHaveCount(2);
        await expect(panel.locator('.incd-mem-lead')).toHaveCount(1);
    });

    test('status change PATCHes the incident', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => (window as any).openIncidentDetail('inc-1'));
        await expect(page.locator('#detail-panel [data-incd-set-status]')).toBeVisible({ timeout: 8000 });
        await page.selectOption('#detail-panel [data-incd-set-status]', 'RESPONDING');
        await expect.poll(() => calls.some((c) => c.method === 'PATCH' && /\/incidents\/inc-1$/.test(c.url) && c.body?.status === 'RESPONDING')).toBeTruthy();
    });

    test('split posts split-report for a member', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => (window as any).openIncidentDetail('inc-1'));
        const splitBtn = page.locator('#detail-panel [data-incd-split="r2"]');
        await expect(splitBtn).toBeVisible({ timeout: 8000 });
        await splitBtn.click();
        await expect.poll(() => calls.some((c) => c.method === 'POST' && /\/incidents\/split-report/.test(c.url) && c.body?.report_id === 'r2')).toBeTruthy();
    });

    test('merge lists siblings and posts a merge', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => (window as any).openIncidentDetail('inc-1'));
        await page.locator('#detail-panel [data-incd-merge]').click();
        const into = page.locator('#detail-panel [data-incd-merge-into="inc-2"]');
        await expect(into).toBeVisible({ timeout: 8000 });
        await into.click();
        // The TARGET (inc-2) absorbs THIS incident (inc-1) as the source.
        await expect.poll(() => calls.some((c) => c.method === 'POST' && /\/incidents\/inc-2\/merge/.test(c.url) && c.body?.source_incident_id === 'inc-1')).toBeTruthy();
    });

    test('?incidentDetail= deep-link opens the incident overlay', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => { location.hash = '#/incidents?incidentDetail=inc-1'; });
        const panel = page.locator('#detail-panel');
        await expect(panel.locator('.incd-title')).toContainText('Riverside Tower', { timeout: 8000 });
    });
});
