/**
 * Dashboard interaction-audit fixes - regression guards.
 *
 * D2: the incident detail panel now closes on Escape + moves focus into itself.
 * D5: in-page panels (analytics/predictions/deletions/moderation) are torn down on
 *     route change so they can't orphan onto the next route.
 * (D3 - op-map marker retains the operation id in the route - is covered live + by
 *  the shared go('#/incidents;op=…?incident=…') pattern already exercised in 35.)
 */
import { test, expect } from '@playwright/test';

const NOW = new Date().toISOString();
const SUMMARY = { generated_at: NOW, window_hours: 24, total_reports: 2,
    counts: { active: 2, critical: 1, needs_review: 1, needs_response: 0, active_operations: 0 },
    distributions: {}, timings: {}, impact: {}, deltas: {} };
const REPORTS = [
    { id: 'r1', severity: 'CRITICAL', status: 'PENDING', crisis_type: 'FLOOD', server_created_at: NOW,
      location: { latitude: 25.6, longitude: 85.1, device_location_name: 'Patna' } },
    { id: 'r2', severity: 'MODERATE', status: 'PENDING', crisis_type: 'FLOOD', server_created_at: NOW, location: null },
];

async function boot(page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'SUPER_ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/reports/')) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '2' }, json: REPORTS });
        return route.fulfill({ status: 200, json: {} });
    });
}

test.describe.configure({ mode: 'serial' });

test('D2: incident detail panel closes on Escape + focus moves into it', async ({ page }) => {
    await boot(page);
    await page.goto('index.html#/incidents');
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.selectReport && window.selectReport('r1'));
    const panel = page.locator('#detail-panel');
    await expect(panel).toBeVisible({ timeout: 5000 });
    // focus moved into the panel
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id === 'detail-panel')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 4000 });
});

test('D5: an in-page panel is torn down on route change (no orphan)', async ({ page }) => {
    await boot(page);
    await page.goto('index.html#/incidents');
    await page.waitForTimeout(1500);
    // Simulate an open analytics panel, then leave the route.
    await page.evaluate(() => { const p = document.getElementById('analytics-panel'); if (p) p.style.display = 'flex'; });
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('analytics-panel')).display)).not.toBe('none');
    await page.evaluate(() => { window.location.hash = '#/exports'; });
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => {
        const p = document.getElementById('analytics-panel');
        return p ? getComputedStyle(p).display : 'none';
    }), 'analytics panel must be torn down on route change').toBe('none');
});
