/**
 * Dashboard — Operations rail + registry at SCALE (50+ operations).
 *
 * The home "Active Operations" rail used to render EVERY operation as a tall
 * full-width stat card (≈70-80px each) → 50 ops = a ~4,000px scroll wall with
 * no triage. The redesign:
 *   • Home rail = a worst-first TOP-N shortlist (compact one-line rows, no SVG)
 *     + a portfolio summary bar + a "View all N" link to the registry.
 *   • #/operations = the scalable REGISTRY: search · status/health filters ·
 *     sort · density toggle · windowing (show 30, Load more).
 *
 * Fully stubbed (50 synthetic ops), no backend.
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();

function mkOp(i: number) {
    // op-0 worst (30 critical) … descending; 4 RED, 8 AMBER, the rest GREEN.
    const critical = i < 4 ? 30 - i * 5 : (i < 12 ? 6 : 0);
    const health = critical >= 10 ? 'RED' : (critical > 0 ? 'AMBER' : 'GREEN');
    return {
        id: `op-${i}`, name: `Operation ${String(i).padStart(2, '0')} ${['Flood', 'Quake', 'Fire', 'Storm'][i % 4]}`,
        crisis_type: ['FLOOD', 'EARTHQUAKE', 'WILDFIRE', 'HURRICANE'][i % 4], status: 'LIVE', is_active: true,
        center_lat: 10 + i * 0.1, center_lng: 70 + i * 0.1, radius_km: 25, place_name: `City ${i}, Country`,
        started_at: NOW, critical, new_24h: critical, new_prev_24h: 1, total: critical + 10, verified: 2,
        last_activity: NOW, is_cluster: false, health, health_reason: `${critical} critical`,
        responders_active: i % 3 === 0 ? 0 : 2,   // i%3===0 + critical>0 ⇒ unattended
    };
}
const MANY = Array.from({ length: 50 }, (_, i) => mkOp(i));
const OPS = MANY.concat([{ id: null, name: 'Unassigned critical reports', is_cluster: true, critical: 7, total: 7 }]);

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
        try { localStorage.removeItem('crisp_ops_density'); sessionStorage.removeItem('crisp_ops_filter'); } catch (e) {}
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: {}, distributions: {}, timings: {}, impact: {}, deltas: {}, total_reports: 0 } });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/operations')) return route.fulfill({ json: OPS });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/buildings')) return route.fulfill({ json: [] });
        if (u.includes('/reports/')) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '0' }, json: [] });
        return route.fulfill({ status: 200, json: {} });
    });
}


test.describe('Active Operations rail — triage shortlist at 50 ops', () => {
    test('rail shows a portfolio summary + a worst-first TOP-N, not 50 cards', async ({ page }) => {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(500);
        await page.evaluate(() => (window as any).openControlCenter && (window as any).openControlCenter());

        // Portfolio summary bar (the "do I need to act?" line).
        const sum = page.locator('#cc-ops-rail .cc-ops-sum');
        await expect(sum).toBeVisible({ timeout: 6000 });
        await expect(sum).toContainText('50 live');
        await expect(sum).toContainText('critical state');   // RED chip

        // Only the TOP-N compact rows render (NOT all 50) — and they carry no SVG.
        const rows = page.locator('#cc-ops-rail-list .opc-c[data-op]');
        await expect(rows).toHaveCount(6);
        await expect(page.locator('#cc-ops-rail-list svg')).toHaveCount(0);

        // Worst-first: op-0 (30 critical) is the first row.
        await expect(rows.first()).toHaveAttribute('data-op', 'op-0');

        // The long tail routes to the registry, and the orphan-critical CTA is a
        // slim one-line alert (not a full card).
        await expect(page.locator('#cc-ops-more')).toContainText('View all 50');
        await expect(page.locator('#cc-ops-alert')).toContainText('not yet in an operation');
    });

    test('a summary chip deep-links into the filtered registry', async ({ page }) => {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(500);
        await page.evaluate(() => (window as any).openControlCenter && (window as any).openControlCenter());
        await expect(page.locator('#cc-ops-rail .cc-ops-sum')).toBeVisible({ timeout: 6000 });

        await page.locator('.cc-ops-chip.red').click();   // "critical state" → RED filter
        await expect(page).toHaveURL(/#\/operations\b/);
        // The RED health chip is pre-applied → only the 4 RED ops show.
        await expect(page.locator('#cco-list .opc[data-op]')).toHaveCount(4, { timeout: 6000 });
        await expect(page.locator('.cco-fchip.red.active')).toBeVisible();
    });
});


test.describe('Operations registry — search · filter · sort · density · windowing', () => {
    async function openRegistry(page: Page) {
        await boot(page);
        await page.goto('index.html');
        await page.waitForTimeout(300);
        await page.evaluate(() => { location.hash = '#/operations'; });
        await expect(page.locator('#cc-ops-overlay .cco-controls')).toBeVisible({ timeout: 6000 });
    }

    test('windowing: shows the first 30 + a Load-more, not all 50', async ({ page }) => {
        await openRegistry(page);
        await expect(page.locator('#cco-list .opc[data-op]')).toHaveCount(30);
        await expect(page.locator('#cco-more')).toContainText('Load more (20)');
        await page.locator('#cco-more').click();
        await expect(page.locator('#cco-list .opc[data-op]')).toHaveCount(50);
    });

    test('search narrows by name', async ({ page }) => {
        await openRegistry(page);
        await page.locator('#cco-search').fill('Operation 49');
        await expect(page.locator('#cco-list .opc[data-op]')).toHaveCount(1);
        await expect(page.locator('#cco-list')).toContainText('Operation 49');
    });

    test('health filter chip narrows to that band', async ({ page }) => {
        await openRegistry(page);
        await page.locator('.cco-fchip.red').click();
        await expect(page.locator('#cco-list .opc[data-op]')).toHaveCount(4);   // 4 RED ops
        await page.locator('.cco-fchip.red').click();                          // toggle off
        await expect(page.locator('#cco-list .opc[data-op]')).toHaveCount(30);  // back to windowed all
    });

    test('density toggle switches to compact rows with no SVG', async ({ page }) => {
        await openRegistry(page);
        await expect(page.locator('#cco-list .opc-mm').first()).toHaveCount(1);  // comfortable = SVG map present
        await page.locator('#cco-density').click();
        await expect(page.locator('#cco-list .opc-c[data-op]').first()).toBeVisible();
        await expect(page.locator('#cco-list svg')).toHaveCount(0);             // compact = zero SVG
    });

    test('sort by name reorders (overrides worst-first)', async ({ page }) => {
        await openRegistry(page);
        await page.locator('#cco-sort').selectOption('name');
        // Only real ops (exclude the pinned orphan-critical CTA, which has no data-op).
        const names = await page.locator('#cco-list [data-op] .opc-name').allTextContents();
        const sorted = [...names].sort((a, b) => a.localeCompare(b));
        expect(names).toEqual(sorted);
    });
});
