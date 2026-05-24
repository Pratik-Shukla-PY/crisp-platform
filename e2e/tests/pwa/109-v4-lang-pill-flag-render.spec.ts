/**
 * HC53 (May 2026) — v4-lang-pill flag rendering invariant.
 *
 * Before HC53 the 3 mid-flow language pills (on `#stage-v4-capture`,
 * `#stage-v4-classify`, `#stage-v4-review`) rendered a hard-coded
 * `🌐` globe emoji + the uppercase locale code. The home pill always
 * rendered the matching country-flag SVG. Operator (2026-05-24)
 * reported the inconsistency: "The language flags are not rendering
 * on pages other than the homepage."
 *
 * HC53 fix: the 3 v4 pills now reuse the same `.lps-flag` /
 * `.lps-code` classes as the home pill. `_updateLangSwitcherMode()`
 * in `app.js` mirrors `data-cc` onto each pill's `.lps-flag` span,
 * triggering the CSS background-image SVG swap at
 * `styles.css:3658-3672`. Reuses the existing 15-flag library, so
 * zero new CSS data URIs.
 *
 * This spec pins five locales spread across the matrix:
 *   - en → data-cc="gb"
 *   - fr → data-cc="fr"
 *   - ar → data-cc="sa"  (also exercises RTL)
 *   - zh → data-cc="cn"
 *   - ta → data-cc="in"  (Indic stub sharing the IN flag)
 *
 * For each, after the v4-capture stage is active:
 *   1. `.v4-lang-pill .lps-flag` exists (pre-HC53 the selector
 *      returned null because `.v4-lang-globe` was hard-coded).
 *   2. `data-cc` matches the expected country code.
 *   3. Computed `background-image` is a non-empty data URI (proves
 *      the SVG-flag rule fired, not the bare emoji fallback).
 *   4. `.v4-lang-code` has been replaced by `.lps-code` containing
 *      the uppercase locale code (matches home pill DOM shape).
 */
import { test, expect } from '@playwright/test';

const CASES: Array<{ lang: string; cc: string }> = [
    { lang: 'en', cc: 'gb' },
    { lang: 'fr', cc: 'fr' },
    { lang: 'ar', cc: 'sa' },
    { lang: 'zh', cc: 'cn' },
    { lang: 'ta', cc: 'in' },
];

test.describe('PWA — HC53 v4-lang-pill flag render parity', () => {
    for (const { lang, cc } of CASES) {
        test(`@smoke ${lang} v4-lang-pill renders .lps-flag[data-cc="${cc}"] with non-empty background-image`, async ({ page }) => {
            // Seed consent + skip landing so #btn-start is immediately
            // visible on the home stage.
            await page.addInitScript((seedLang) => {
                localStorage.setItem(
                    'crisp_privacy_consent',
                    JSON.stringify({ accepted: true, ts: Date.now() }),
                );
                localStorage.setItem('crisp_landing_seen', '1');
                // Persist the locale so the boot path picks it up on
                // first paint — bypasses the auto-detect / picker flow.
                // Per 99-locale-no-flicker — the boot path reads this
                // key to bypass geo/UA auto-detect. `crisp_lang` (no
                // suffix) is NOT the seed key.
                localStorage.setItem('crisp_lang_manual', seedLang);
            }, lang);

            await page.goto('index.html');
            await page.waitForLoadState('domcontentloaded');

            // Confirm boot locale settled.
            await page.waitForFunction(
                (expected) => document.documentElement.lang === expected,
                lang,
            );

            // Enter the v4 capture stage. `#btn-start` is the home CTA.
            await page.locator('#btn-start').click();
            await expect(page.locator('#stage-v4-capture.active')).toBeVisible();

            const pillFlag = page.locator('#stage-v4-capture .v4-lang-pill .lps-flag');
            const pillCode = page.locator('#stage-v4-capture .v4-lang-pill .lps-code');

            // 1 + 2. New DOM shape: .lps-flag with the right data-cc.
            await expect(pillFlag, '.v4-lang-pill must contain a .lps-flag span').toHaveCount(1);
            await expect(pillFlag).toHaveAttribute('data-cc', cc);

            // 3. Background-image SVG actually painted.
            const bgImage = await pillFlag.evaluate(
                (el) => getComputedStyle(el).backgroundImage,
            );
            expect(
                bgImage,
                `.lps-flag[data-cc="${cc}"] must have a non-empty background-image`,
            ).not.toBe('none');
            expect(bgImage).toContain('data:image/svg+xml');

            // 4. .lps-code carries the uppercase locale code.
            await expect(pillCode).toHaveText(lang.toUpperCase());

            // Old class names must be gone — regression guard.
            await expect(
                page.locator('#stage-v4-capture .v4-lang-globe'),
                'legacy .v4-lang-globe class must be removed',
            ).toHaveCount(0);
            await expect(
                page.locator('#stage-v4-capture .v4-lang-code'),
                'legacy .v4-lang-code class must be removed',
            ).toHaveCount(0);
        });
    }

    test('@smoke flag mirrors onto every v4 pill after UI-driven lang switch', async ({ page }) => {
        // Boot in EN, mid-capture, then switch via the UI (tap v4 pill
        // → tap French flag in picker) — same path a real user takes.
        // `activateLang` is closure-local in app.js and isn't on window,
        // so the only way to exercise the mirror loop end-to-end is
        // through the picker. This also covers the click handler at
        // app.js:5121 (data-v4-lang-pill → opens overlay).
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

        await page.locator('#btn-start').click();
        await expect(page.locator('#stage-v4-capture.active')).toBeVisible();

        // Sanity: starts at EN / data-cc="gb".
        const captureFlag = page.locator('#stage-v4-capture .v4-lang-pill .lps-flag');
        await expect(captureFlag).toHaveAttribute('data-cc', 'gb');

        // Open picker via the v4 pill, then pick French.
        await page.locator('#stage-v4-capture .v4-lang-pill').click();
        await expect(page.locator('#lang-picker-overlay')).toBeVisible();
        await page.locator('.lang-picker-flag[data-lang="fr"]').click();
        // Picker auto-closes after pick; new locale is active.
        await page.waitForFunction(() => document.documentElement.lang === 'fr');

        // Mirror loop fires inside activateLang → all 3 v4 pills now
        // reflect FR / data-cc="fr". All 3 stages exist in the DOM
        // from page load (just hidden until navigated to), so the
        // mirror updates every pill regardless of which stage is
        // currently active.
        for (const stageId of ['stage-v4-capture', 'stage-v4-classify', 'stage-v4-review']) {
            const flag = page.locator(`#${stageId} .v4-lang-pill .lps-flag`);
            const code = page.locator(`#${stageId} .v4-lang-pill .lps-code`);
            await expect(flag).toHaveAttribute('data-cc', 'fr');
            await expect(code).toHaveText('FR');
        }
    });
});
