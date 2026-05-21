/**
 * May 21 2026 — audit Item 6 regression guard.
 *
 * The "version pill" in the home utility footer was previously hidden
 * by a CSS rule at styles.css:10406 (`display: none`) that left the
 * span un-paintable. v247 reversed the CSS rule + v248 also forces
 * the inline `style.display = 'inline-block'` from JS, so cached-CSS
 * iPhones still see the pill on the first reload.
 *
 * This test pins both invariants:
 *  1. `#home-utility-version` is computed as visible (display !== none).
 *  2. The pill's text contains both `pwa@` and `api@` (or starts with
 *     pwa@ and the backend `?` placeholder while the /health fetch
 *     is in flight).
 */
import { test, expect } from '@playwright/test';

test.describe('PWA home — version pill visibility (audit Item 6)', () => {
    test('@smoke pill is visible on first paint and shows pwa@ + api@', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
        });
        await page.goto('index.html');
        await page.waitForLoadState('networkidle');

        const pill = page.locator('#home-utility-version');
        await expect(pill).toBeVisible();

        // computed display must NOT be 'none'
        const display = await pill.evaluate((el) =>
            window.getComputedStyle(el).display,
        );
        expect(display, 'pill must not be display:none').not.toBe('none');

        const text = await pill.textContent();
        expect(text, 'pill should show pwa@... text').toMatch(/pwa@/);
        // backend value may still be `?` while /health is in flight
        // (or the API isn't reachable in the test harness). We only
        // require the `api@` prefix.
        expect(text, 'pill should show api@... segment').toMatch(/api@/);
    });
});
