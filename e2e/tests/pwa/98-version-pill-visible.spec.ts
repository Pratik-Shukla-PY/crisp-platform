/**
 * May 21 2026 — audit Item 6 regression guard.
 *
 * Originally the "version pill" in the home utility footer was a
 * dedicated row painting `pwa@v259 · api@1.0.0`. HC25 (May 23) folded
 * the version into the Privacy/Help/Open-source nav as a 4th utility
 * item with consumer-grade copy: "Build 259". The technical detail
 * (API version, build timestamp) is exposed on click + via the title
 * attribute for native long-press tooltips, but not in the default
 * visible text.
 *
 * This test pins both updated invariants:
 *  1. `#home-utility-version` is computed as visible (display !== none).
 *  2. The visible text reads "Build N" where N is a positive integer.
 *  3. The title attribute carries the long-form "Build N · API …"
 *     detail (or at least the Build N segment while /health is in
 *     flight).
 */
import { test, expect } from '@playwright/test';

test.describe('PWA home — version pill visibility (audit Item 6, post-HC25)', () => {
    test('@smoke build chip is visible on first paint and reads "Build N"', async ({ page }) => {
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

        // HC25: the canonical visible surface is the build-info button
        // inside the .home-utility-footer nav.
        const btn = page.locator('#home-utility-version');
        await expect(btn).toBeVisible();

        // Bounding box must be inside the visible page area.
        const rect = await btn.evaluate((el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        expect(rect.w, `chip width must be > 0 (got ${rect.w})`).toBeGreaterThan(20);
        expect(rect.h, `chip height must be > 0 (got ${rect.h})`).toBeGreaterThan(0);
        expect(rect.y, `chip y must be inside iPhone 14 viewport (got ${rect.y})`).toBeLessThan(844);

        // Visible label reads "Build N" where N is a positive integer.
        const text = ((await btn.textContent()) || '').trim();
        expect(text, 'chip should show consumer-grade "Build N" text').toMatch(/^Build\s+\d+$/);

        // Title attribute carries the long-form detail. While the
        // /health fetch is in flight the title may still be just
        // "Build N" — so we accept either "Build N" or
        // "Build N · API …".
        const title = (await btn.getAttribute('title')) || '';
        expect(title, 'title attribute should at minimum start with "Build N"').toMatch(/^Build\s+\d+/);
    });
});
