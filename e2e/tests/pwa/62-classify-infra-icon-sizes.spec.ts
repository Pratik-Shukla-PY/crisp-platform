/**
 * PWA — visual + computed-style check for the classify infra-tile
 * icon size bumps (May 2026, operator-reported).
 *
 * Operator: "Increase the size of the icons, keep responsive for
 * multiple screens we decided earlier."
 *
 * HC62 (May 2026) refactored the cascade again: tile height is now
 * driven by the flex-fill grid (`repeat(8, 1fr)`), and only the icon +
 * font sizes scale per breakpoint (see styles.css ~9970):
 *   default (iPhone SE)  → 36×36 / 22 px
 *   ≥ 380 px width       → 40×40 / 24 px
 *   ≥ 700 px height      → 44×44 / 26 px
 *   ≥ 850 px height      → 52×52 / 30 px
 *   ≥ 1000 px height     → 60×60 / 34 px
 */
import { test, expect, Page } from '@playwright/test';

async function bootV4OnInfraStep(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function',
        null, { timeout: 8000 },
    );
    // Jump directly to the infra sub-step via the test hook —
    // v4-flow.js exposes `__crispV4ShowSubStep` so tests can navigate
    // without driving the Continue gate (which requires inter-step
    // listener registration that page.evaluate-seeded state bypasses).
    await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-classify'));
    await page.evaluate(() => {
        if (typeof (window as any).__crispV4ShowSubStep === 'function') {
            (window as any).__crispV4ShowSubStep('infra');
        }
    });
    await page.waitForTimeout(200);
}

test.describe('PWA — classify infra-tile icon sizes (May 2026)', () => {

    test('@smoke default (≤380w) icons are 36×36 with 22px glyph', async ({ page, browserName }) => {
        // The Pixel-7 device profile already has width 412 — that
        // exceeds the 380 breakpoint, so we'd actually hit the
        // ≥380 rule. Force a narrower viewport for the "default" assertion.
        await page.setViewportSize({ width: 360, height: 640 });
        await bootV4OnInfraStep(page);
        const firstTile = page.locator('.v4-hit-tile').first();
        await expect(firstTile).toBeVisible();
        const icon = firstTile.locator('.v4-hit-tile-icon');
        const sizes = await icon.evaluate((el) => {
            const cs = window.getComputedStyle(el);
            return { w: cs.width, h: cs.height, fs: cs.fontSize };
        });
        expect(sizes.w).toBe('36px');
        expect(sizes.h).toBe('36px');
        expect(sizes.fs).toBe('22px');
    });

    test('≥380w breakpoint — icons grow to 40×40 with 24px glyph', async ({ page }) => {
        // Height 690 stays below the 700px tier so only the width
        // breakpoint fires.
        await page.setViewportSize({ width: 412, height: 690 });
        await bootV4OnInfraStep(page);
        const icon = page.locator('.v4-hit-tile').first().locator('.v4-hit-tile-icon');
        const sizes = await icon.evaluate((el) => {
            const cs = window.getComputedStyle(el);
            return { w: cs.width, h: cs.height, fs: cs.fontSize };
        });
        expect(sizes.w).toBe('40px');
        expect(sizes.h).toBe('40px');
        expect(sizes.fs).toBe('24px');
    });

    test('taller viewports — icons step up through the height tiers', async ({ page }) => {
        await page.setViewportSize({ width: 420, height: 740 });
        await bootV4OnInfraStep(page);
        const icon = page.locator('.v4-hit-tile').first().locator('.v4-hit-tile-icon');
        const readSizes = () => icon.evaluate((el) => {
            const cs = window.getComputedStyle(el);
            return { w: cs.width, h: cs.height, fs: cs.fontSize };
        });

        // ≥700h tier (Pixel 7 / Galaxy S22 class).
        let sizes = await readSizes();
        expect(sizes.w).toBe('44px');
        expect(sizes.h).toBe('44px');
        expect(sizes.fs).toBe('26px');

        // ≥850h tier (Pixel 7 Pro / iPhone 14 Pro Max class).
        await page.setViewportSize({ width: 420, height: 900 });
        sizes = await readSizes();
        expect(sizes.w).toBe('52px');
        expect(sizes.h).toBe('52px');
        expect(sizes.fs).toBe('30px');

        // ≥1000h tier (tablets / landscape laptops).
        await page.setViewportSize({ width: 420, height: 1020 });
        sizes = await readSizes();
        expect(sizes.w).toBe('60px');
        expect(sizes.h).toBe('60px');
        expect(sizes.fs).toBe('34px');
    });

    test('@theme-visual screenshot at default Pixel-7 viewport', async ({ page }) => {
        await bootV4OnInfraStep(page);
        await page.screenshot({
            path: 'test-results/theme-screenshots/04-classify-infra-icons.png',
            fullPage: true,
        });
        // Sanity: at least one tile rendered.
        await expect(page.locator('.v4-hit-tile').first()).toBeVisible();
    });
});
