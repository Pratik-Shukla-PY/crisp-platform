/**
 * Dashboard — Incident card density + hover stability.
 *
 * The card is a dense two-row layout (≈half the old height): row 1 = the triage line
 * (what · severity · source · status), row 2 (.qrt-meta) = where · when · confidence ·
 * Notify. Compact view shows row 1 only (≈80% shorter). The rich hover preview opens
 * only after a short DWELL (hover-intent) so a quick pass-over no longer flashes it.
 *
 * Self-contained: fake token + stubbed /api/v1/** (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const loc = { latitude: 13.08, longitude: 80.27, user_location_name: 'Koramangala, Chennai' };
const REPORTS = [
    { id: 'r1', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD',
      damage_classification: 'PARTIAL', crisis_event_id: null, building_id: 'b1', infrastructure_name: 'Apollo Hospital',
      infrastructure_name_from_osm: true, infrastructure_type: 'HOSPITAL', source: 'APP', server_created_at: NOW,
      location: { ...loc }, incident_credibility: { assessed: true, score: 84, band: 'VERIFIED' },
      media: [{ id: 'm1', type: 'IMAGE', assembly_status: 'complete' }], description: 'Flooded ground floor' },
    { id: 'r2', severity: 'SEVERE', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'FLOOD',
      damage_classification: 'PARTIAL', crisis_event_id: null, building_id: 'b1', infrastructure_name: 'Apollo Hospital',
      infrastructure_name_from_osm: true, infrastructure_type: 'HOSPITAL', source: 'WHATSAPP', server_created_at: NOW,
      location: { ...loc }, media: [] },
];

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
        localStorage.removeItem('crisp_feed_density');
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: {}, distributions: {}, timings: {}, impact: {}, deltas: {} } });
        if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: [] });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/reports/buildings-needing-review')) return route.fulfill({ json: { buildings: [], total_buildings: 0, total_pairs: 0 } });
        if (/\/reports\/?\?/.test(u)) return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(REPORTS.length) }, json: REPORTS });
        const s = u.match(/\/reports\/(r\d)(?:\?|$)/); if (s) return route.fulfill({ json: REPORTS.find((r) => r.id === s[1]) || {} });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/incidents'; });
    const bld = page.locator('#report-feed-list .cc-cluster[data-cluster-key="b:b1"]');
    await expect(bld).toBeVisible({ timeout: 8000 });
    await bld.locator('.qrt-section-header').click();   // expand to reveal cards
    await expect(page.locator('#report-feed-list .qrt-card[data-id="r1"]')).toBeVisible({ timeout: 8000 });
}

test.describe('Dashboard — incident card density + hover', () => {
    test('standard card is two compact rows and ≈half the old height', async ({ page }) => {
        await boot(page);
        const card = page.locator('#report-feed-list .qrt-card[data-id="r1"]');
        // Row 1 = title + channel icon only; row 2 = location + time + confidence.
        // v137 declutter: the severity TEXT badge, the status pill ("Needs review",
        // redundant inside a status tab), and the Notify button are NO LONGER on the card.
        await expect(card.locator('.qrt-what .qrt-infra-name')).toBeVisible();
        await expect(card.locator('.qrt-what .qrt-source-badge')).toBeVisible();   // channel icon kept
        await expect(card.locator('.qrt-meta .qrt-where-text')).toContainText('Koramangala');
        await expect(card.locator('.qrt-meta .qrt-confidence')).toBeVisible();
        await expect(card.locator('.qrt-sev-badge')).toHaveCount(0);        // severity text badge dropped
        await expect(card.locator('.qrt-status-pill')).toHaveCount(0);      // status pill dropped
        await expect(card.locator('.qrt-dispatch-btn')).toHaveCount(0);     // Notify dropped (hover/detail only)
        const h = await card.evaluate((el) => el.getBoundingClientRect().height);
        expect(h).toBeLessThan(96);   // old card was ~115px; location may wrap to a 2nd meta line
    });

    test('compact view collapses to one line (row 1 only)', async ({ page }) => {
        await boot(page);
        const card = page.locator('#report-feed-list .qrt-card[data-id="r1"]');
        await page.evaluate(() => (window as any).setFeedDensity('compact'));
        await expect(card.locator('.qrt-meta')).toBeHidden();
        await expect(card.locator('.qrt-what .qrt-infra-name')).toBeVisible();   // still scannable
        const h = await card.evaluate((el) => el.getBoundingClientRect().height);
        expect(h).toBeLessThan(40);
    });

    test('hover-intent: a quick pass-over does NOT flash the preview; a dwell shows it', async ({ page }) => {
        await boot(page);
        const card = page.locator('#report-feed-list .qrt-card[data-id="r1"]');
        // Quick pass-over: enter then immediately leave → the pending show is cancelled.
        await card.dispatchEvent('mouseenter');
        await card.dispatchEvent('mouseleave');
        await page.waitForTimeout(350);
        await expect(page.locator('#fast-preview')).toBeHidden();
        // Dwell: hover and wait past the ~220ms intent delay → the rich preview opens.
        await card.hover();
        await expect(page.locator('#fast-preview')).toBeVisible({ timeout: 2000 });
        // Full details on hover: crisis + damage (moved off the card) appear here.
        await expect(page.locator('#fast-preview')).toContainText('Flood');
        await expect(page.locator('#fast-preview')).toContainText('PARTIAL');
    });
});
