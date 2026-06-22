/**
 * Command Centre metric tiles → deep-linked queues (Jun 2026 home restructure).
 *
 * Section 1's Command Centre tiles (#cc-att .cc-tile) deep-link into the incident
 * feed at the right scope/filter. The two tiles that carry a bookmarkable queue
 * segment ('#/incidents;queue=<key>') are Critical and Rejected; the queue
 * predicates in app.js (QUEUES) mirror the backend count definitions, so this spec
 * seeds a report set with a KNOWN distinct membership per queue and asserts the
 * clicked tile shows exactly that population (verification requirement: counts match).
 *
 * Fully stubbed (no backend) like 30-crisis-intel-landing.
 */
import { test, expect, Page } from '@playwright/test';

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const H = 3600e3;

// Crafted membership for the two queue-deep-linking Command Centre tiles:
//   critical:  r_crit (CRITICAL, open)        → 1
//   rejected:  r_rej  (reviewer_verdict=REJECTED) → 1
const REPORTS = [
    { id: 'r_crit', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED',
      crisis_type: 'EARTHQUAKE', infrastructure_type: 'HOSPITAL', description: 'QCRIT collapsed ward',
      server_created_at: iso(0.5 * H), location: { latitude: 12.9, longitude: 77.5 } },
    { id: 'r_sla', severity: 'SEVERE', status: 'PENDING', reviewer_verdict: 'ACCEPTED',
      crisis_type: 'FLOOD', infrastructure_type: 'ROAD', description: 'QSLA flooded road',
      server_created_at: iso(5 * H), location: { latitude: 12.91, longitude: 77.51 } },
    { id: 'r_disp', severity: 'MODERATE', status: 'RESPONDING', reviewer_verdict: 'ACCEPTED',
      crisis_type: 'FLOOD', infrastructure_type: 'HOUSE', description: 'QDISP team en route',
      help_dispatched_at: iso(2 * H), help_arrived_at: null,
      server_created_at: iso(3 * H), location: { latitude: 12.92, longitude: 77.52 } },
    { id: 'r_stale', severity: 'MINOR', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED',
      crisis_type: 'WILDFIRE', infrastructure_type: 'SCHOOL', description: 'QSTALE old unreviewed',
      server_created_at: iso(30 * H), location: { latitude: 12.93, longitude: 77.53 } },
    { id: 'r_esc', severity: 'MODERATE', status: 'VERIFIED', reviewer_verdict: 'ACCEPTED',
      crisis_type: 'EARTHQUAKE', infrastructure_type: 'COMMERCIAL', description: 'QESC hot building',
      building_id: 'b1',
      server_created_at: iso(1 * H), location: { latitude: 12.94, longitude: 77.54 } },
    { id: 'r_rej', severity: 'MINOR', status: 'PENDING', reviewer_verdict: 'REJECTED',
      crisis_type: 'FLOOD', infrastructure_type: 'OTHER', description: 'QREJ rejected as spam',
      server_created_at: iso(4 * H), location: { latitude: 12.95, longitude: 77.55 } },
];
const SUMMARY = {
    generated_at: new Date(now).toISOString(), window_hours: 24, stale_hours: 24, total_reports: 5,
    counts: { active: 5, critical: 1, pending_verification: 2, awaiting_triage: 2,
              open_dispatch: 1, resolved_in_window: 0, active_ops: 1, escalating: 1, stale: 1, sla_at_risk: 2,
              needs_review: 2, needs_response: 2, active_operations: 1, critical_incidents: 1, escalating_reports: 1 },
    distributions: { by_severity: { CRITICAL: 1 }, by_crisis_type: { FLOOD: 2 }, by_status: {}, verified: 1, unverified: 4 },
    timings: { avg_verification_seconds: null, avg_response_seconds: null },
    impact: { critical_infrastructure: 1, lives_impacted_sum: 0, responders_active: 1, service_disruptions: 0 },
    deltas: { reports_24h: 4, reports_prev_24h: 1, reports_7d: 5, reports_prev_7d: 0 },
};

const EXPECTED: Record<string, { count: number, member: string }> = {
    'critical': { count: 1, member: 'r_crit' },
    'rejected': { count: 1, member: 'r_rej' },
};

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY });
        if (u.includes('/buildings')) {
            return route.fulfill({ json: [
                { id: 'b1', escalation_risk: 80, state: 'ACTIVE' },
                { id: 'b2', escalation_risk: 30, state: 'ACTIVE' },
            ] });
        }
        if (u.includes('/reports/nearby')) return route.fulfill({ json: { groups: [] } });
        if (u.includes('/reports/')) {
            return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(REPORTS.length) }, json: REPORTS });
        }
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForTimeout(700);
    await page.evaluate(() => {
        const r = (window as any).__crispRouter;
        if (r) r.navigate('/');
    });
    await expect(page.locator('#cc-att .cc-tile').first()).toBeVisible({ timeout: 8000 });
}

test.describe('Command Centre tiles → dedicated operational queues', () => {
    for (const [key, exp] of Object.entries(EXPECTED)) {
        test(`tile "${key}" deep-links to its filtered queue (count + membership match)`, async ({ page }) => {
            await boot(page);
            await page.locator(`#cc-att .cc-tile[data-tile="${key}"]`).click();
            // Deep link in the URL (bookmarkable / sharable).
            await expect(page).toHaveURL(new RegExp(`#/incidents;queue=${key}`));
            // Queue banner with the live filtered count — matches the crafted
            // membership (same predicate the badge count definition uses).
            await expect(page.locator('#feed-scope-bar')).toBeVisible({ timeout: 6000 });
            // The total incidents for the active scope now sit in the header next to
            // the scope crumb (.qb-total), e.g. "Critical incidents · 1 incident".
            await expect(page.locator('#feed-scope-bar .qb-total'))
                .toContainText(new RegExp(`${exp.count} incident`), { timeout: 6000 });
            // A known member of this queue is on screen, with no manual
            // filtering — and the visible card count is EXACTLY the queue
            // membership (cards expose data-report-id, app.js:2400).
            await expect(page.locator(`#report-feed-list .qrt-card[data-report-id="${exp.member}"]`))
                .toBeVisible({ timeout: 6000 });
            await expect(page.locator('#report-feed-list .qrt-card')).toHaveCount(exp.count, { timeout: 6000 });
        });
    }

    test('clear-queue button exits the queue and cleans the URL segment', async ({ page }) => {
        await boot(page);
        await page.locator('#cc-att .cc-tile[data-tile="critical"]').click();
        await expect(page.locator('#feed-scope-bar')).toContainText('CRITICAL INCIDENTS', { timeout: 10000 });
        // The active category is a clearable chip beside the Switch button. It clears
        // the queue and synchronously re-renders the banner (removing itself), so
        // dispatchEvent fires the handler directly without racing the self-detach.
        await page.locator('#feed-scope-bar .ctx-qchip').dispatchEvent('click');
        // Durable signal: the URL drops the queue segment + the banner falls back to
        // the GLOBAL breadcrumb (always visible, never hidden).
        await expect.poll(() => page.evaluate(() => location.hash), { timeout: 8000 }).not.toContain('queue=');
        await expect(page.locator('#feed-scope-bar .qb-crumbs')).toContainText('Global', { timeout: 6000 });
    });

    test('browser refresh preserves queue state (deep link is the state)', async ({ page }) => {
        await boot(page);
        await page.locator('#cc-att .cc-tile[data-tile="rejected"]').click();
        await expect(page.locator('#feed-scope-bar')).toBeVisible({ timeout: 6000 });
        await page.reload();
        await page.waitForTimeout(800);
        await expect(page).toHaveURL(/#\/incidents;queue=rejected/);
        await expect(page.locator('#feed-scope-bar')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#feed-scope-bar')).toContainText('REJECTED');
    });

    test('browser back returns to the landing; navigating home drops the queue segment', async ({ page }) => {
        await boot(page);
        await page.locator('#cc-att .cc-tile[data-tile="critical"]').click();
        await expect(page.locator('#feed-scope-bar')).toBeVisible({ timeout: 6000 });
        // Back → landing restored.
        await page.goBack();
        await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 6000 });
        // Forward into the queue again, then navigate home via the command
        // bar: the router must DROP the queue segment (clean URL, no stale
        // queue re-applying later).
        await page.goForward();
        await expect(page.locator('#feed-scope-bar')).toBeVisible({ timeout: 6000 });
        await page.evaluate(() => (window as any).__crispRouter.navigate('/'));
        await expect(page).toHaveURL(/#\/$/);
        await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();
    });
});
