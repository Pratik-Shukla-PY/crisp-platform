/**
 * PWA — home "region affected" banner (B5, for the B1 feature).
 *
 * On the home stage, if the reporter's CACHED location (no GPS prompt) falls
 * inside an active crisis zone, a fixed dismissible banner announces it
 * ("⚠ Flood · Active crisis form for your area"). The banner is a position:fixed
 * overlay, so it never counts against the #87 zero-scroll home budget.
 *
 * Controls /crisis-forms/active directly (does NOT use _fixtures).
 */
import { test, expect, Page } from '@playwright/test';

async function bootHome(page: Page, activeBody: any) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
        // Cached location → the banner reads this, never prompts for GPS.
        localStorage.setItem('crisp_last_location_v2', JSON.stringify({ lat: 11.668, lng: 76.634 }));
    });
    await page.route('**/api/v1/reports/nearby**', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ groups: [] }) }));
    await page.route('**/crisis-forms/active**', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeBody) }));
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#stage-home.active, #stage-home')).toBeVisible({ timeout: 8000 });
}

const FLOOD_ACTIVE = {
    active: true, crisis_type: 'FLOOD', event_name: 'Bangalore Floods',
    pack_id: 'pk-flood', pack_version: 1,
};

test.describe('PWA — home crisis-zone banner (B5)', () => {

    test('@smoke active zone → banner renders with type + note', async ({ page }) => {
        await bootHome(page, FLOOD_ACTIVE);
        const banner = page.locator('#home-crisis-banner');
        await expect(banner).toBeVisible({ timeout: 6000 });
        await expect(banner.locator('.hcb-type')).toHaveText(/flood/i);
        await expect(banner.locator('.hcb-note')).toHaveText(/active crisis form for your area/i);
        // window cache is set so the capture-stage geo-gate can reuse it.
        const zone = await page.evaluate(() => (window as any).__crispZone || null);
        expect(zone && zone.crisis_type).toBe('FLOOD');
    });

    test('@smoke banner is a fixed overlay (does not push home content / zero-scroll safe)', async ({ page }) => {
        await bootHome(page, FLOOD_ACTIVE);
        await expect(page.locator('#home-crisis-banner')).toBeVisible({ timeout: 6000 });
        const pos = await page.locator('#home-crisis-banner').evaluate(
            (el) => getComputedStyle(el).position);
        expect(pos).toBe('fixed');
    });

    test('@smoke dismiss removes the banner + persists for the session', async ({ page }) => {
        await bootHome(page, FLOOD_ACTIVE);
        const banner = page.locator('#home-crisis-banner');
        await expect(banner).toBeVisible({ timeout: 6000 });
        await banner.locator('.hcb-close').click();
        await expect(banner).toHaveCount(0);
        const dismissed = await page.evaluate(() => sessionStorage.getItem('crisp_zone_banner_dismissed'));
        expect(dismissed).toBe('pk-flood');
    });

    test('@smoke inactive zone → no banner', async ({ page }) => {
        await bootHome(page, { active: false });
        // Give the async fetch a beat; banner must never appear.
        await page.waitForTimeout(800);
        await expect(page.locator('#home-crisis-banner')).toHaveCount(0);
    });
});
