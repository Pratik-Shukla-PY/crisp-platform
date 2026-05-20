/**
 * Dashboard — K.5.e (Phase K, May 2026): truncation banner.
 *
 * When the backend's `X-Total-Count` exceeds `DASHBOARD_PAGE_LIMIT`
 * (10K), the dashboard's fetch is silently truncated server-side.
 * Pre-fix the only signal was a console.warn — operators didn't know
 * reports past row 10K were hidden. K.5.e surfaces a top-of-page
 * banner.
 */
import { test, expect } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

const DASH_URL = 'index.html';

let _adminToken: string | null = null;

async function stubReportsListWithTotal(page, total) {
    await page.route(/\/api\/v1\/reports\/(\?|$)/, async (route) => {
        const url = route.request().url();
        if (/\/api\/v1\/reports\/[A-Za-z0-9-]/.test(url) && !url.includes('?')) {
            await route.continue();
            return;
        }
        await route.fulfill({
            status: 200,
            headers: {
                'content-type': 'application/json',
                'access-control-allow-origin': '*',
                'access-control-expose-headers': 'X-Total-Count, X-Server-Time, ETag',
                'X-Total-Count': String(total),
                'X-Server-Time': new Date().toISOString().replace('+00:00', 'Z'),
                'ETag': `"k5e-${total}-${Date.now()}"`,
            },
            body: '[]',
        });
    });
}

async function bootDashboard(page, request) {
    if (!_adminToken) _adminToken = await ensureAdminAndLogin(request);
    await page.goto(DASH_URL);
    await page.evaluate(({ token, email }) => {
        localStorage.setItem('crisp_token', token);
        localStorage.setItem('crisp_user', JSON.stringify({
            email, role: 'SUPER_ADMIN', full_name: 'E2E Admin',
        }));
    }, { token: _adminToken, email: ADMIN.email });
    await page.reload();
    await page.waitForFunction(
        () => typeof (window as any).__crispNotifDebug === 'function'
            && (window as any).__crispNotifDebug().initialLoadDone === true,
        null, { timeout: 15000 },
    );
}


test.describe('Dashboard K.5.e — truncation banner', () => {
    test('banner appears when X-Total-Count exceeds the page limit', async ({ page, request }) => {
        await stubReportsListWithTotal(page, 15000);  // > 10K limit
        await bootDashboard(page, request);

        // Wait for the banner to render after initial fetch.
        await page.waitForSelector('#truncation-banner', { state: 'visible', timeout: 5000 });

        const text = await page.locator('#truncation-banner').textContent();
        expect(text).toContain('10,000');  // limit
        expect(text).toContain('15,000');  // total
        expect(text?.toLowerCase()).toContain('pagination');
    });

    test('banner does NOT appear when count is within limit', async ({ page, request }) => {
        await stubReportsListWithTotal(page, 500);  // well under
        await bootDashboard(page, request);

        // Give the dashboard a moment to settle.
        await page.waitForTimeout(500);

        const visible = await page.locator('#truncation-banner').isVisible().catch(() => false);
        expect(visible, 'no banner when total < limit').toBe(false);
    });

    test('banner can be dismissed via the close button', async ({ page, request }) => {
        await stubReportsListWithTotal(page, 12000);
        await bootDashboard(page, request);

        await page.waitForSelector('#truncation-banner', { state: 'visible', timeout: 5000 });

        // Click the × close.
        await page.locator('.truncation-banner-close').click();
        await page.waitForTimeout(200);

        const visible = await page.locator('#truncation-banner').isVisible().catch(() => false);
        expect(visible).toBe(false);
    });

    test('exact-equal count (10000) does NOT trigger banner (off-by-one safety)', async ({ page, request }) => {
        await stubReportsListWithTotal(page, 10000);  // exactly at limit
        await bootDashboard(page, request);

        await page.waitForTimeout(500);

        const visible = await page.locator('#truncation-banner').isVisible().catch(() => false);
        expect(visible, 'banner uses strict > comparison; exact-equal is fine').toBe(false);
    });
});
