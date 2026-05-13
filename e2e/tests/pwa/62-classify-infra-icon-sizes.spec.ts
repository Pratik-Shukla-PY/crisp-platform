/**
 * PWA — visual + computed-style check for the classify infra-tile
 * icon size bumps (May 2026, operator-reported).
 *
 * Operator: "Increase the size of the icons, keep responsive for
 * multiple screens we decided earlier."
 *
 * New sizes (matches the home-stage CTA responsive cascade):
 *   default          → 48×48 / 28 px
 *   ≥ 380 px width   → 56×56 / 32 px
 *   ≥ 700 px height  → 60×60 / 34 px
 *   ≥ 800 px height  → 64×64 / 36 px
 *   ≥ 900 px height  → 68×68 / 38 px
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
    // Seed damage so the Continue gate lets us advance to infra.
    await page.evaluate(() => {
        const s = (window as any).state;
        s.damage_classification = 'PARTIAL';
    });
    await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-classify'));
    // Advance to the infra sub-step (the one with the .v4-hit-tile cards).
    await page.locator('#btn-v4-classify-next').click();
    await page.waitForTimeout(200);
}

test.describe('PWA — classify infra-tile icon sizes (May 2026)', () => {

    test('@smoke default (≤380w) icons are 48×48 with 28px glyph', async ({ page, browserName }) => {
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
        expect(sizes.w).toBe('48px');
        expect(sizes.h).toBe('48px');
        expect(sizes.fs).toBe('28px');
    });

    test('≥380w breakpoint — icons grow to 56×56 with 32px glyph', async ({ page }) => {
        await page.setViewportSize({ width: 412, height: 690 });
        await bootV4OnInfraStep(page);
        const icon = page.locator('.v4-hit-tile').first().locator('.v4-hit-tile-icon');
        const sizes = await icon.evaluate((el) => {
            const cs = window.getComputedStyle(el);
            return { w: cs.width, h: cs.height, fs: cs.fontSize };
        });
        expect(sizes.w).toBe('56px');
        expect(sizes.h).toBe('56px');
        expect(sizes.fs).toBe('32px');
    });

    test('≥800h breakpoint — icons grow to 64×64 with 36px glyph', async ({ page }) => {
        await page.setViewportSize({ width: 420, height: 820 });
        await bootV4OnInfraStep(page);
        const icon = page.locator('.v4-hit-tile').first().locator('.v4-hit-tile-icon');
        const sizes = await icon.evaluate((el) => {
            const cs = window.getComputedStyle(el);
            return { w: cs.width, h: cs.height, fs: cs.fontSize };
        });
        expect(sizes.w).toBe('64px');
        expect(sizes.h).toBe('64px');
        expect(sizes.fs).toBe('36px');
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
