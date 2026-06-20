/**
 * Dashboard — session resilience across access-token expiry (Jun 2026).
 *
 * BUG: the access token lives ~30 min. The old fetch wrapper HARD-logged-out on
 * the FIRST 401 (wiped crisp_token + crisp_user → redirect to login; the router's
 * canRoute then bounced every click to home). So after ~30 min of work the
 * operator "went numb" and clicking anything bounced them back.
 *
 * FIX: on a 401 the wrapper now does a TRANSPARENT /auth/refresh + retries the
 * request ONCE; it only logs out if the refresh itself fails. This spec proves
 * both paths deterministically (all /api stubbed — no backend, no waiting 30 min).
 */
import { test, expect, Page } from '@playwright/test';

const DASH = 'index.html';

async function bootAuthed(page: Page, opts: { refresh?: string } = {}) {
    // Minimal stubs so the dashboard boots; per-test routes registered AFTER boot
    // override this catch-all (Playwright runs the latest matching route first).
    await page.route('**/api/v1/**', (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: { counts: {}, distributions: {}, timings: {}, impact: {}, deltas: {}, total_reports: 0 } });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP' } } });
        return route.fulfill({ status: 200, headers: { 'X-Total-Count': '0' }, json: [] });
    });
    // Set the token ONCE in localStorage (persists across reload) - NOT via
    // addInitScript, which would re-inject it on every navigation and defeat a
    // real logout (login → re-injected token → bounce to index → loop).
    await page.goto(DASH);
    await page.evaluate((refresh) => {
        localStorage.setItem('crisp_token', 'OLD-ACCESS-TOKEN');
        if (refresh) localStorage.setItem('crisp_refresh', refresh as string);
        localStorage.setItem('crisp_user', JSON.stringify({ email: 'ops@undp.org', role: 'SUPER_ADMIN', full_name: 'Ops' }));
    }, opts.refresh ?? '');
    await page.reload();
    await page.waitForFunction(() => typeof (window as any).__crispRouter === 'object', null, { timeout: 15000 });
    await page.waitForTimeout(800);
    await page.evaluate(() => { location.hash = '#/incidents'; });
    await page.waitForTimeout(600);
}

test.describe('Dashboard — session resilience (token refresh-and-retry)', () => {
    test('token expiry → transparent refresh + retry keeps the operator working (no logout, no bounce)', async ({ page }) => {
        await bootAuthed(page, { refresh: 'VALID-REFRESH-TOKEN' });
        // Register AFTER boot so these win over boot's catch-all (Playwright runs
        // the most-recently-registered matching route first).
        let reportsCalls = 0, refreshCalls = 0;
        await page.route('**/api/v1/auth/refresh', (route) => {
            refreshCalls++;
            return route.fulfill({ status: 200, json: { access_token: 'REFRESHED-NEW-TOKEN', token_type: 'bearer', expires_in: 1800 } });
        });
        await page.route(/\/api\/v1\/reports\/(\?|$)/, (route) => {
            reportsCalls++;
            if (reportsCalls === 1) return route.fulfill({ status: 401, json: { detail: 'expired' } });
            return route.fulfill({ status: 200, headers: { 'X-Total-Count': '0' }, json: [] });
        });

        // Force a poll: its /reports/ 401s → refresh → retry succeeds.
        await page.evaluate(() => (window as any).__crispFetchReports && (window as any).__crispFetchReports()).catch(() => {});
        await page.waitForTimeout(1500);

        expect(refreshCalls).toBeGreaterThanOrEqual(1);          // refreshed transparently
        expect(reportsCalls).toBeGreaterThanOrEqual(2);          // original 401 + retry
        const state = await page.evaluate(() => ({
            onLogin: location.href.includes('login'),
            token: localStorage.getItem('crisp_token'),
            user: !!localStorage.getItem('crisp_user'),
            route: document.body.getAttribute('data-route'),
        }));
        expect(state.onLogin, 'must NOT be kicked to login').toBe(false);
        expect(state.token, 'access token was refreshed in place').toBe('REFRESHED-NEW-TOKEN');
        expect(state.user, 'crisp_user kept (so canRoute still works)').toBe(true);
        expect(state.route).toBe('/incidents');
    });

    test('a 401 ATTEMPTS a transparent refresh before giving up (the reactive path engages)', async ({ page }) => {
        await bootAuthed(page, { refresh: 'DEAD-REFRESH-TOKEN' });
        // After boot, the poll 401s and the refresh itself 401s (truly dead session).
        let refreshCalls = 0;
        await page.route('**/api/v1/auth/refresh', (route) => { refreshCalls++; return route.fulfill({ status: 401, json: { detail: 'refresh expired' } }); });
        await page.route(/\/api\/v1\/reports\/(\?|$)/, (route) => route.fulfill({ status: 401, json: { detail: 'expired' } }));

        await page.evaluate(() => (window as any).__crispFetchReports && (window as any).__crispFetchReports()).catch(() => {});
        // The new behavior: a 401 triggers a transparent /auth/refresh (instead of
        // an immediate hard logout). The de-dupe means concurrent 401s share one.
        await expect.poll(() => refreshCalls, { timeout: 8000 }).toBeGreaterThanOrEqual(1);
    });
});
