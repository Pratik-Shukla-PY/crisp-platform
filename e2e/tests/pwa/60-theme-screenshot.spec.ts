/**
 * One-off visual verification of the new teal/navy theme.
 *
 * Captures the home page + the language-picker overlay + the My Reports
 * screen as PNGs in `e2e/test-results/theme-screenshots/`. Operator
 * eyeballs these to confirm the color rewrite landed correctly.
 *
 * Not gating any deploy — runs locally on demand. Skipped on CI via the
 * `@theme-visual` tag (only run with `--grep @theme-visual`).
 */
import { test, expect, Page } from '@playwright/test';

async function bootV4(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
        localStorage.setItem('crisp_device_id_v2', 'theme-visual-device-hash');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    // Settle web fonts.
    await page.waitForTimeout(800);
}

test.describe('@theme-visual PWA — color theme rewrite (May 2026)', () => {

    test('home page', async ({ page }) => {
        await bootV4(page);
        await page.screenshot({
            path: 'test-results/theme-screenshots/01-home.png',
            fullPage: true,
        });
        // Sanity assertion — stage-home is the active stage.
        await expect(page.locator('#stage-home.active')).toBeVisible({ timeout: 5000 });
    });

    test('language picker', async ({ page }) => {
        await bootV4(page);
        await page.locator('#btn-lang-current').click();
        await expect(page.locator('#lang-picker-overlay')).toBeVisible();
        await page.waitForTimeout(300);
        await page.screenshot({
            path: 'test-results/theme-screenshots/02-language-picker.png',
            fullPage: true,
        });
    });

    test('My Reports (empty)', async ({ page }) => {
        await bootV4(page);
        // Patch fetch so the status-since call returns 0 reports.
        await page.evaluate(() => {
            const orig = window.fetch.bind(window);
            window.fetch = ((url: any, ...rest: any[]) => {
                if (String(url || '').includes('/status-since')) {
                    return Promise.resolve(new Response('[]', {
                        status: 200, headers: { 'Content-Type': 'application/json' },
                    }));
                }
                return orig(url, ...rest);
            }) as any;
        });
        await page.evaluate(() => (window as any).openMyReports());
        await page.waitForTimeout(500);
        await page.screenshot({
            path: 'test-results/theme-screenshots/03-my-reports-empty.png',
            fullPage: true,
        });
    });
});
