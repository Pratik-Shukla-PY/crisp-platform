/**
 * Command Center — the shared Command Panel at the OPERATION level.
 *
 * The panel renders breadcrumb + AI Analyze card + metric chips + a SCOPED ACTION
 * BAR. The action bar is the point: a cascade with a blast-radius dry-run confirm
 * that percolates to every incident + report in scope. "Analyze" surfaces the AI
 * narrative + recommended actions (each an executable cascade). All endpoints stubbed.
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const OP = {
    id: 'op-cc', name: 'Bihar Floods', crisis_type: 'FLOOD', status: 'LIVE', is_active: true,
    center_lat: 25.6, center_lng: 85.1, radius_km: 22, place_name: 'Patna, India',
    form_name: 'Flood Assessment v2', started_at: NOW, critical: 5, new_24h: 9, total: 42,
    verified: 10, last_activity: NOW, is_cluster: false, incident_count: 7,
    health: 'RED', health_reason: '5 unattended critical', responders_active: 2,
};
const SUMMARY = {
    generated_at: NOW, counts: { critical: 5, needs_review: 4, needs_response: 2, active_operations: 1 },
    distributions: {}, timings: {}, impact: {}, deltas: {},
};
const ASSESS_SCORED = {
    assessed: true, scope_type: 'operation', scope_id: 'op-cc', score: 72, band: 'LIKELY',
    distribution: { VERIFIED: 1, LIKELY: 2, MIXED: 1, WEAK: 0, UNVERIFIED: 0 },
    coverage: { assessed: 3, total: 4, cached: 3 },
    counts: { critical: 5, unattended_critical: 5, buildings: 4, incidents: 7, reports: 42, responders: 2 },
    situation_summary: 'Five critical reports remain unattended across four buildings; collapse risk rising.',
    key_risks: ['structural collapse at City Hospital', 'responder shortfall'],
    escalation_likelihood: { level: 'HIGH', rationale: 'criticals rising, none dispatched' },
    recommended_actions: [{
        label: 'Dispatch responders to all unattended-critical',
        action: 'dispatch', scope: { scope_type: 'operation', scope_id: 'op-cc' },
        filters: { queue: 'unattended_critical' },
    }],
    priority_score: 88, resource_recommendations: ['2 search-and-rescue teams'],
    model: 'claude-sonnet-4-6', assessed_at: NOW,
};

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        const m = route.request().method();
        if (u.includes('/operations/op-cc/assess')) {
            // GET → not yet assessed (live metrics only); POST → the scored payload.
            if (m === 'POST') return route.fulfill({ json: ASSESS_SCORED });
            return route.fulfill({ json: { ...ASSESS_SCORED, assessed: false, situation_summary: null, recommended_actions: [] } });
        }
        if (u.includes('/operations/op-cc/cascade/')) {
            const body = route.request().postDataJSON?.() || {};
            if (body && body.dry_run) {
                return route.fulfill({ json: { dry_run: true, action: 'dispatch', counts: { reports: 5, incidents: 5, buildings: 4, responders: 2 } } });
            }
            return route.fulfill({ json: { dry_run: false, action: 'dispatch', log_id: 'L-1', counts: { reports: 5, incidents: 5, buildings: 4, responders: 2 } } });
        }
        if (u.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/weather')) return route.fulfill({ json: { available: false } });
        if (u.includes('/operations')) return route.fulfill({ json: [OP] });
        if (u.includes('/buildings-needing-review')) return route.fulfill({ json: { total_buildings: 0 } });
        if (u.includes('/buildings')) return route.fulfill({ json: [] });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/reports/')) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '0' }, json: [] });
        return route.fulfill({ status: 200, json: {} });
    });
}

async function openOp(page: Page) {
    await page.goto('index.html');
    await page.waitForTimeout(300);
    await page.evaluate(() => { location.hash = '#/operations/op-cc'; });
    await expect(page.locator('#cco-command.cc-cmd .cc-cmd-bc')).toBeVisible({ timeout: 8000 });
}

test.describe('Command Center — Operation Command Panel', () => {
    test('@smoke panel renders breadcrumb + Analyze CTA + metric chips + scoped action bar', async ({ page }) => {
        await boot(page);
        await openOp(page);
        const panel = page.locator('#cco-command');
        await expect(panel.locator('.cc-cmd-bc')).toContainText('Bihar Floods');
        await expect(panel.locator('[data-cc-run]')).toContainText('Analyze Operation');
        // metric chips (live roll-up from the GET assess)
        await expect(panel.locator('.cc-cmd-metrics')).toContainText('Critical');
        // scoped action bar — the percolating cascades
        await expect(panel.locator('[data-cc-act="dispatch-uc"]')).toBeVisible();
        await expect(panel.locator('[data-cc-act="resolve-all"]')).toBeVisible();
        await expect(panel.locator('[data-cc-act="reject-noise"]')).toBeVisible();
    });

    test('@smoke Analyze → scored card + executable recommended action', async ({ page }) => {
        await boot(page);
        await openOp(page);
        await page.locator('#cco-command [data-cc-run]').click();
        // scored dial + band + the modal opens with the narrative
        await expect(page.locator('.cc-ov-card')).toContainText('Five critical reports remain unattended');
        await page.locator('.cc-ov-row button[data-cc-ok]').click();   // close modal
        const panel = page.locator('#cco-command');
        await expect(panel.locator('.cc-cmd-dial')).toContainText('72');
        // the recommended action is a one-click cascade
        await expect(panel.locator('.cc-cmd-rec')).toContainText('Dispatch responders to all unattended-critical');
        await expect(panel.locator('[data-cc-rec="0"]')).toContainText('DISPATCH');
    });

    test('@smoke a cascade shows the blast radius, then executes + offers Undo', async ({ page }) => {
        await boot(page);
        await openOp(page);
        await page.locator('#cco-command [data-cc-act="dispatch-uc"]').click();
        // blast-radius confirm (the dry-run counts)
        const ov = page.locator('.cc-ov-card');
        await expect(ov).toContainText('Confirm cascade');
        await expect(ov.locator('.cc-ov-bchip')).toHaveCount(4);   // reports/incidents/buildings/responders
        await expect(ov).toContainText('Apply to 5 reports');
        // execute → Undo affordance appears
        await ov.locator('button[data-cc-ok]').click();
        await expect(page.locator('.cc-ov button', { hasText: 'Undo' })).toBeVisible({ timeout: 4000 });
    });

    test('@smoke reject (destructive) requires a reason in the confirm', async ({ page }) => {
        await boot(page);
        await openOp(page);
        await page.locator('#cco-command [data-cc-act="reject-noise"]').click();
        const ov = page.locator('.cc-ov-card');
        await expect(ov.locator('.cc-ov-rsn')).toBeVisible();          // reason field present
        await ov.locator('button[data-cc-ok]').click();                // no reason → blocked
        await expect(ov).toBeVisible();                                 // modal stays open
        await ov.locator('.cc-ov-rsn').fill('duplicate spam burst');
        await ov.locator('button[data-cc-ok]').click();
        await expect(page.locator('.cc-ov-card')).toHaveCount(0, { timeout: 4000 });   // closed after confirm
    });
});
