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
        // iPhone 14 viewport — the layout that previously hid the pill
        // because of overflow:hidden in .home-utility-footer.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.addInitScript(() => {
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
        });
        await page.goto('index.html');
        await page.waitForLoadState('networkidle');

        // v250: target the NEW dedicated row element. Lives outside
        // the clipped utility-footer.
        const row = page.locator('#home-version-row');
        await expect(row).toBeVisible();

        // Also assert the bounding box is inside the viewport — not
        // just "exists in DOM" but "actually painted within the
        // visible page area." This is the assertion the prior version
        // of this test missed.
        const rect = await row.evaluate((el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        expect(rect.w, `pill width must be > 0 (got ${rect.w})`).toBeGreaterThan(20);
        expect(rect.h, `pill height must be > 0 (got ${rect.h})`).toBeGreaterThan(0);
        expect(rect.y, `pill y must be inside iPhone 14 viewport (got ${rect.y})`).toBeLessThan(844);

        const text = await row.textContent();
        expect(text, 'pill should show pwa@... text').toMatch(/pwa@/);
        // backend value may still be `?` while /health is in flight
        // (or the API isn't reachable in the test harness). We only
        // require the `api@` prefix.
        expect(text, 'pill should show api@... segment').toMatch(/api@/);
    });
});
