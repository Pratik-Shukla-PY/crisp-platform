/**
 * HC54 (May 2026) — Language picker UX simplification.
 *
 * Operator brief (2026-05-24):
 *   1. Freeze title + region-suggestion + search bar in a sticky
 *      header. X stays as the sole close affordance INSIDE the
 *      sticky header. Drop the bottom "Close" button.
 *   2. Remove the "UN Official Languages" / "Also Supported"
 *      section groupings → single continuous grid of all 21 tiles.
 *      Priority order preserved (en/fr/es/ar/ru/zh first, then 9
 *      UNDP tier-2, then 6 Indian sub-national).
 *
 * Goals: less visual fragmentation, lower cognitive load, cleaner
 * scrolling. CLAUDE.md "Lang picker close" invariant updated to
 * reflect the single-affordance model.
 *
 * This spec pins:
 *   - `.lang-picker-header` exists + uses `position: sticky`
 *   - `#lang-picker-close-x` lives INSIDE the sticky header (the X
 *     scrolls with the header, not the grid)
 *   - `#lang-picker-close` does NOT exist (bottom button removed)
 *   - `.lang-picker-section-title` does NOT exist (section headers
 *     removed)
 *   - Grid has exactly 21 tiles
 *   - First 6 tiles are en, fr, es, ar, ru, zh in that order
 *   - All tiles share the same uniform style — no `.lpf-un` or
 *     `.lpf-scroll` modifier remains (would re-introduce visual
 *     fragmentation)
 *   - Clicking the X closes the picker
 */
import { test, expect } from '@playwright/test';

const PRIORITY_FIRST_6 = ['en', 'fr', 'es', 'ar', 'ru', 'zh'];
const EXPECTED_TILE_COUNT = 21;

async function openPicker(page) {
    await page.addInitScript(() => {
        localStorage.setItem(
            'crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }),
        );
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.goto('index.html');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.locator('#btn-lang-current').click();
    await expect(page.locator('#lang-picker-overlay')).toBeVisible();
}

test.describe('PWA — HC54 lang picker sticky header + single grid', () => {
    test('@smoke .lang-picker-header is position:sticky and contains the X close button', async ({ page }) => {
        await openPicker(page);
        const header = page.locator('#lang-picker-overlay .lang-picker-header');
        await expect(header, '.lang-picker-header element must exist').toHaveCount(1);
        const position = await header.evaluate((el) => getComputedStyle(el).position);
        expect(position, '.lang-picker-header must be position:sticky').toBe('sticky');
        // X button is INSIDE the sticky header — verifies our markup
        // restructure and that the X scrolls with the header.
        const xInsideHeader = page.locator(
            '#lang-picker-overlay .lang-picker-header #lang-picker-close-x',
        );
        await expect(xInsideHeader).toHaveCount(1);
        await expect(xInsideHeader).toBeVisible();
    });

    test('@smoke bottom #lang-picker-close button is gone (single close affordance)', async ({ page }) => {
        await openPicker(page);
        // Hard guard — only the X remains.
        await expect(page.locator('#lang-picker-close')).toHaveCount(0);
        await expect(page.locator('.lang-picker-close')).toHaveCount(0);
    });

    test('@smoke section headers ("UN Official Languages" / "Also Supported") are gone', async ({ page }) => {
        await openPicker(page);
        await expect(page.locator('.lang-picker-section-title')).toHaveCount(0);
        await expect(page.locator('.lang-picker-section')).toHaveCount(0);
    });

    test('@smoke single continuous grid has 21 tiles', async ({ page }) => {
        await openPicker(page);
        const tiles = page.locator('#lang-picker-overlay .lang-picker-flag');
        await expect(tiles).toHaveCount(EXPECTED_TILE_COUNT);
        // Single grid — the legacy split (lpf-un / lpf-scroll classes
        // marked tiles as belonging to one of two sections) is gone.
        await expect(page.locator('.lang-picker-flag.lpf-un')).toHaveCount(0);
        await expect(page.locator('.lang-picker-flag.lpf-scroll')).toHaveCount(0);
    });

    test('@smoke first 6 tiles are en/fr/es/ar/ru/zh in priority order', async ({ page }) => {
        await openPicker(page);
        const first6 = await page.locator(
            '#lang-picker-overlay .lang-picker-flag',
        ).evaluateAll((els) =>
            els.slice(0, 6).map((el) => (el as HTMLElement).dataset.lang),
        );
        expect(first6).toEqual(PRIORITY_FIRST_6);
    });

    test('@smoke clicking X closes the picker', async ({ page }) => {
        await openPicker(page);
        await page.locator('#lang-picker-close-x').click();
        await expect(page.locator('#lang-picker-overlay')).toBeHidden();
    });
});
