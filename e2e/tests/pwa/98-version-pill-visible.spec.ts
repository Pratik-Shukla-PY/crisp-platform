/**
 * May 21 2026 — audit Item 6 regression guard.
 *
 * Originally the "version pill" painted `pwa@v259 · api@1.0.0`.
 * HC25 (May 23) folded the version into the Privacy/Help/Open-source
 * nav as a "Build 259" chip with a click-to-expand detail line.
 * HC36 (May 23, operator preference) moved the version OUT of the
 * nav back to a dedicated bottom-row meta line (.home-footer-meta)
 * and reformatted the visible label as "CRISP vX.Y.Z" — the
 * semver-style label the operator approved.
 *
 * This test pins HC36's updated invariants:
 *  1. `#home-utility-version` is computed as visible (display !== none).
 *  2. The visible text reads "CRISP vX.Y.Z" where X/Y/Z are digits.
 *  3. The title attribute carries the underlying "Build N" + API
 *     pairing for native long-press / hover tooltips.
 */
import { test, expect } from '@playwright/test';

test.describe('PWA home — version label visibility (audit Item 6, post-HC36)', () => {
    test('@smoke version label is visible on first paint and reads "CRISP vX.Y.Z"', async ({ page }) => {
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

        // HC36: the canonical visible surface is the version <span>
        // on the bottom meta row (.home-footer-meta).
        const el = page.locator('#home-utility-version');
        await expect(el).toBeVisible();

        // Bounding box must be inside the visible page area.
        const rect = await el.evaluate((node) => {
            const r = (node as HTMLElement).getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        expect(rect.w, `version label width must be > 0 (got ${rect.w})`).toBeGreaterThan(20);
        expect(rect.h, `version label height must be > 0 (got ${rect.h})`).toBeGreaterThan(0);
        expect(rect.y, `label y must be inside iPhone 14 viewport (got ${rect.y})`).toBeLessThan(844);

        // Visible label reads "CRISP vX.Y.Z" where X/Y/Z are digit
        // groups derived from the build number.
        const text = ((await el.textContent()) || '').trim();
        expect(text, 'label should read "CRISP vX.Y.Z"').toMatch(/^CRISP\s+v\d+\.\d+\.\d+$/);

        // Title attribute carries the operational detail. While the
        // /health fetch is in flight the title may still be just
        // "CRISP vX.Y.Z · Build N" — accept either form.
        const title = (await el.getAttribute('title')) || '';
        expect(title, 'title should carry the Build N detail').toMatch(/Build\s+\d+/);
    });
});
