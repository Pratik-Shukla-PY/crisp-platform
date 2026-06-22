/**
 * Dashboard — Operations redesign v2: two-group listing + Start-New-Operation wizard.
 *
 * Self-contained (stubs every /api/v1 call, fakes the auth token — no backend):
 *   • #/operations splits LIVE (first) vs ENDED (collapsed <details>) and shows
 *     the "Start New Operation" card.
 *   • The 4-step wizard opens, reuses the form kit, previews, and POSTs a single
 *     /operations/launch-with-form on launch, then closes + routes to the new op.
 */
import { test, expect } from '@playwright/test';

const NOW = new Date().toISOString();

const OPERATIONS = [
    {
        id: 'op-live', name: 'Bihar Floods', crisis_type: 'FLOOD', status: 'LIVE', is_active: true,
        center_lat: 25.6, center_lng: 85.1, radius_km: 22, place_name: 'Patna, India',
        critical: 5, new_24h: 9, total: 42, verified: 7, last_activity: NOW, is_cluster: false,
        health: 'RED', health_reason: '5 unattended critical', responders_active: 2, ended_at: null,
    },
    {
        id: 'op-ended', name: 'Old Cyclone Op', crisis_type: 'CYCLONE', status: 'ENDED', is_active: false,
        center_lat: 19, center_lng: 85, radius_km: 30, critical: 0, new_24h: 0, total: 12,
        verified: 12, last_activity: NOW, is_cluster: false, health: 'GREEN', health_reason: 'closed',
        responders_active: 0, ended_at: '2026-05-01T00:00:00Z',
    },
    { id: null, name: 'Unassigned critical reports', is_cluster: true, critical: 3, total: 3 },
];

const TEMPLATES = [
    { id: 'pk-1', key: 'flood-rapid', title: 'Flood Rapid Assessment', crisis_type: 'FLOOD',
      schema_json: { schema_version: 1, sections: [{ id: 'classify', stage: 2, title: 'Assessment',
        fields: [{ key: 'water_rising', type: 'yes_no', label: 'Is the water still rising?', required: false }] }] } },
];

let launchBody: any = null;

async function boot(page) {
    launchBody = null;
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const req = route.request();
        const u = req.url();
        // order matters — the more specific /operations/* paths first
        if (u.includes('/operations/form-templates')) return route.fulfill({ json: TEMPLATES });
        if (u.includes('/operations/launch-with-form')) {
            launchBody = JSON.parse(req.postData() || '{}');
            return route.fulfill({ status: 201, json: { operation_id: 'op-new', operation_name: launchBody.name, claimed_count: 0 } });
        }
        if (u.includes('/operations/launch')) return route.fulfill({ status: 201, json: { operation_id: 'op-new' } });
        if (u.includes('/operations')) return route.fulfill({ json: OPERATIONS });
        if (u.includes('/packs/validate')) return route.fulfill({ json: { valid: true, errors: [] } });
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { generated_at: NOW, counts: {}, distributions: { by_severity: {}, by_crisis_type: {}, by_status: {} }, timings: {}, impact: {}, deltas: {} } });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/reports/')) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '0' }, json: [] });
        return route.fulfill({ status: 200, json: {} });
    });
}

test.describe('Operations redesign v2 — listing + wizard', () => {
    test('#/operations registry: Start-New button + status filter (live default, ended on demand)', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations');
        await page.waitForTimeout(800);
        const list = page.locator('#report-feed-list');
        // Start-New moved off a list card into the controls bar (scalable registry).
        await expect(page.locator('#cco-newop')).toBeVisible();
        await expect(page.locator('#cco-newop')).toContainText('New operation');
        // Default = LIVE: the live op shows, the ended op is filtered out (was a
        // collapsed <details> group; now the status segment owns that).
        await expect(list).toContainText('Bihar Floods');
        await expect(list).not.toContainText('Old Cyclone Op');
        // Switching the status segment to Ended surfaces the ended op.
        await page.locator('.opg-reg-segbtn[data-status="ended"]').click();
        await expect(list).toContainText('Old Cyclone Op');
        await expect(list).not.toContainText('Bihar Floods');
    });

    test('Start New Operation → 4-step wizard → single launch-with-form POST', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations');
        await page.waitForTimeout(800);

        // open the wizard
        await page.locator('#cco-newop').click();
        await expect(page.locator('#cc-wiz-overlay.open')).toBeVisible();

        // Step 1: a curated starter + the published template are offered
        await expect(page.locator('.cc-wiz-tpl[data-stock="FLOOD"]')).toBeVisible();
        await expect(page.locator('.cc-wiz-tpl[data-tpl="pk-1"]')).toContainText('Flood Rapid Assessment');
        await page.locator('.cc-wiz-tpl[data-stock="FLOOD"]').click();

        // Step 2: builder renders blocks + live preview
        await expect(page.locator('.cc-wiz-blk').first()).toBeVisible();
        await expect(page.locator('#cc-wiz-prev2 .cc-wiz-q').first()).toBeVisible();
        await page.locator('#cc-wiz-next').click();           // → Preview

        // Step 3: mobile preview
        await expect(page.locator('#cc-wiz-prev3 .cc-wiz-q').first()).toBeVisible();
        await page.locator('#cc-wiz-next').click();           // → Launch

        // Step 4: fill + launch
        await page.fill('#cc-wiz-name', 'Wizard E2E Op');
        await page.fill('#cc-wiz-lat', '28.61');
        await page.fill('#cc-wiz-lng', '77.21');
        await page.fill('#cc-wiz-rad', '18');
        const [resp] = await Promise.all([
            page.waitForResponse((r) => r.url().includes('/operations/launch-with-form') && r.request().method() === 'POST'),
            page.locator('#cc-wiz-launch').click(),
        ]);
        expect(resp.status()).toBe(201);

        // exactly the shape the atomic endpoint expects
        expect(launchBody.name).toBe('Wizard E2E Op');
        expect(launchBody.center_lat).toBeCloseTo(28.61, 2);
        expect(launchBody.radius_km).toBeCloseTo(18, 2);
        expect(Array.isArray(launchBody.schema_json.sections)).toBeTruthy();
        expect(launchBody.schema_json.sections.length).toBeGreaterThan(0);

        // modal closes + routes to the new operation
        await expect(page.locator('#cc-wiz-overlay.open')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => location.hash)).toContain('/operations/op-new');
    });

    test('closing the wizard before launch writes nothing (no POST)', async ({ page }) => {
        await boot(page);
        await page.goto('index.html#/operations');
        await page.waitForTimeout(800);
        await page.locator('#cco-newop').click();
        await page.locator('.cc-wiz-tpl[data-stock="WILDFIRE"]').click();
        await expect(page.locator('.cc-wiz-blk').first()).toBeVisible();
        // Escape discards everything
        await page.keyboard.press('Escape');
        await expect(page.locator('#cc-wiz-overlay.open')).toHaveCount(0);
        expect(launchBody).toBeNull();   // never published → no-draft-persistence
    });
});
