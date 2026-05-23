/**
 * <html lang dir> frame-0 guarantee — AUDIT 2026-05-23.
 *
 * Asserts the head IIFE has set documentElement.lang AND .dir before
 * any visible content paints — catching regressions where the IIFE
 * gets moved, deleted, or executes late.
 *
 * Why important:
 *   - Screen readers pronounce the first paragraph using the lang at
 *     load time. Setting lang AFTER first paint means AR users hear
 *     English VoiceOver for that first sentence.
 *   - CSS bidi rules apply based on dir. Setting dir AFTER first paint
 *     makes RTL users see a brief LTR layout that then flips — visible
 *     content jump.
 *
 * We can't directly hook "before first paint" in Playwright, but we
 * CAN assert the lang/dir is correct by the time DCL fires. The head
 * IIFE runs synchronously during head parsing, so DCL is always after.
 * If DCL sees the wrong lang/dir, frame-0 must have been wrong too.
 */
import { test, expect } from '@playwright/test';

const TARGETS = [
    { code: 'en', expectedDir: 'ltr' },
    { code: 'ar', expectedDir: 'rtl' },
    { code: 'ur', expectedDir: 'rtl' },
    { code: 'zh', expectedDir: 'ltr' },
    { code: 'fr', expectedDir: 'ltr' },
];

for (const t of TARGETS) {
    test(`@smoke <html lang="${t.code}" dir="${t.expectedDir}"> set before DCL`, async ({ page }) => {
        await page.addInitScript((lang) => {
            localStorage.setItem('crisp_lang_manual', lang);
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
        }, t.code);
        await page.goto('index.html');
        // DCL fires AFTER head IIFE has run (head is parsed and executed
        // before body parsing completes).
        await page.waitForLoadState('domcontentloaded');

        const [lang, dir] = await page.evaluate(() => [
            document.documentElement.lang,
            document.documentElement.dir,
        ]);
        expect(lang).toBe(t.code);
        expect(dir).toBe(t.expectedDir);
    });
}

test('@smoke unsupported locale (eg de) falls back via family map', async ({ page }) => {
    // German is not in the supported 22; family-fallback should pick 'en'.
    await page.addInitScript(() => {
        localStorage.setItem('crisp_lang_manual', 'de');
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
    });
    await page.goto('index.html');
    await page.waitForLoadState('domcontentloaded');
    const lang = await page.evaluate(() => document.documentElement.lang);
    // FAMILY map sends 'de' → 'en'.
    expect(lang).toBe('en');
});

test('@smoke malformed crisp_lang_manual falls back to en', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_lang_manual', 'klingon-fake-xxx');
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
    });
    await page.goto('index.html');
    await page.waitForLoadState('domcontentloaded');
    const lang = await page.evaluate(() => document.documentElement.lang);
    expect(lang).toBe('en');
});
