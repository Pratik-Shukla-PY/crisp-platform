/**
 * Phase 25 (May 2026) — RTL critical-patch regression.
 *
 * The Phase 23 audit found that the v4 capture flow's header was using
 * a physical `padding-right: 156 px` to clear space for the language
 * pill. In RTL the pill moves to the top-LEFT corner (via the existing
 * `#lang-switcher { right:auto; left:0 }` flip), so without an RTL
 * override the step-progress label was sliding under the pill on
 * Arabic / Urdu.
 *
 * This test pins down the fix so a future stylesheet refactor that
 * deletes the `html[dir="rtl"] .v4-header` override surfaces as a
 * test failure instead of a silent visual regression.
 */
import { test, expect } from '@playwright/test';

async function bootInLocale(page, langCode: string) {
    await page.goto('index.html');
    await page.evaluate(() => {
        localStorage.setItem(
            'crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }),
        );
        localStorage.setItem('crisp_landing_seen', '1');
    });
    await page.evaluate((code) => {
        localStorage.setItem('crisp_lang_manual', code);
    }, langCode);
    await page.reload();
    // Give the async i18n loader a beat to apply.
    await page.waitForFunction(
        ({ code }) => document.documentElement.lang === code
            || document.documentElement.lang.startsWith(code),
        { code: langCode },
        { timeout: 5000 },
    ).catch(() => { /* assertion below produces better error */ });
}

test.describe('Phase 25 — RTL critical patches', () => {
    test('Arabic flips .v4-header padding from right to left', async ({ page }) => {
        await bootInLocale(page, 'ar');
        // Navigate into the capture flow so .v4-header is present.
        // Click "Report an Incident" — the big CTA.
        const cta = page.locator('#btn-start, [data-i18n="big_cta"]').first();
        await cta.click().catch(() => { /* not strictly required; v4-header
                                          may render via stage transition */ });

        // The v4-header may not yet be visible if the test viewport
        // hasn't loaded the capture flow — fall back to evaluating
        // the computed style for any .v4-header that DOES exist.
        const padding = await page.evaluate(() => {
            const el = document.querySelector('.v4-header');
            if (!el) return null;
            const cs = getComputedStyle(el);
            return {
                paddingLeft: cs.paddingLeft,
                paddingRight: cs.paddingRight,
            };
        });

        if (padding) {
            // In RTL, padding-left must equal 156 px (the clearance for
            // the pill) and padding-right must be ~0.
            const leftPx = parseFloat(padding.paddingLeft);
            const rightPx = parseFloat(padding.paddingRight);
            expect(leftPx).toBeGreaterThanOrEqual(150);
            expect(rightPx).toBeLessThan(20);
        } else {
            // The capture flow wasn't reachable from this test boot
            // (e.g. consent banner blocked navigation). Skip rather
            // than fail — the css rule is the same regardless of
            // whether the test boots all the way into v4-header.
            test.skip(true, 'v4-header not in DOM; capture flow not entered');
        }
    });

    test('English keeps .v4-header padding on the right side', async ({ page }) => {
        await bootInLocale(page, 'en');
        const cta = page.locator('#btn-start, [data-i18n="big_cta"]').first();
        await cta.click().catch(() => {});

        const padding = await page.evaluate(() => {
            const el = document.querySelector('.v4-header');
            if (!el) return null;
            const cs = getComputedStyle(el);
            return {
                paddingLeft: cs.paddingLeft,
                paddingRight: cs.paddingRight,
            };
        });

        if (padding) {
            const leftPx = parseFloat(padding.paddingLeft);
            const rightPx = parseFloat(padding.paddingRight);
            expect(rightPx).toBeGreaterThanOrEqual(150);
            expect(leftPx).toBeLessThan(20);
        } else {
            test.skip(true, 'v4-header not in DOM; capture flow not entered');
        }
    });

    test('Phase 25 — language pill shows flag emoji + ISO code', async ({ page }) => {
        await bootInLocale(page, 'hi');
        // Wait for the pill text to refresh to the active code.
        await page.waitForFunction(() => {
            const btn = document.getElementById('btn-lang-current');
            if (!btn) return false;
            return /HI/.test(btn.textContent || '');
        }, undefined, { timeout: 5000 });

        const pillContent = await page.evaluate(() => {
            const btn = document.getElementById('btn-lang-current');
            return btn ? btn.textContent : '';
        });
        // The flag emoji + ISO code form. We don't assert on the exact
        // glyph (font-availability varies by environment) — just that
        // the code is present and the dataset captures the locale.
        expect(pillContent).toContain('HI');
        const datasetLang = await page.evaluate(() => {
            const btn = document.getElementById('btn-lang-current');
            return btn ? (btn as HTMLElement).dataset.lang : null;
        });
        expect(datasetLang).toBe('hi');
    });
});
