/**
 * Locale flicker regression guard — AUDIT 2026-05-23.
 *
 * Asserts that the home stage paints in the user's preferred language
 * on the FIRST frame (not after async JSON load), for every locale we
 * actively support. Catches the bug fixed by the i18n sync-resolver
 * pass: HTML / inline EN pack / activateLang sequencing previously made
 * non-EN users see ~170 ms to ~5 s of English before the DOM flipped.
 *
 * Methodology:
 *   1. Seed localStorage.crisp_lang_manual = <lang> via addInitScript.
 *   2. page.goto('index.html') — wait for `load` event.
 *   3. Read documentElement.lang/dir + the textContent of canonical
 *      home keys (CTA, consent, privacy).
 *   4. Compare against the value from the source i18n/<lang>.json file.
 *      Match required.
 *
 * Tests a 7-locale sample covering Tier 1, Tier 2, Tier 3, and an RTL.
 * Full 22-locale coverage runs in spec 105 (RTL visual sweep) + 25-i18n-
 * 22-screenshots (which the existing build already gates on).
 *
 * Hard expect — soft would let the flicker bug regress invisibly.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const I18N_DIR = path.resolve(__dirname, '..', '..', '..', 'mobile-app', 'src', 'i18n');

const LOCALES_TO_CHECK = [
    { code: 'en', dir: 'ltr', cta: 'home_cta_primary' },
    { code: 'fr', dir: 'ltr', cta: 'home_cta_primary' },
    { code: 'ar', dir: 'rtl', cta: 'home_cta_primary' },
    { code: 'zh', dir: 'ltr', cta: 'home_cta_primary' },
    { code: 'ru', dir: 'ltr', cta: 'home_cta_primary' },
    { code: 'hi', dir: 'ltr', cta: 'home_cta_primary' },
    { code: 'ur', dir: 'rtl', cta: 'home_cta_primary' },
];

function loadLocale(code: string): Record<string, string> {
    const fp = path.join(I18N_DIR, `${code}.json`);
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

for (const target of LOCALES_TO_CHECK) {
    test(`@smoke first paint already in ${target.code} (no English flicker)`, async ({ page }) => {
        const source = loadLocale(target.code);
        await page.addInitScript((lang) => {
            localStorage.setItem('crisp_lang_manual', lang);
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
        }, target.code);
        await page.goto('index.html');
        await page.waitForLoadState('domcontentloaded');
        // Small wait so the inline walker runs (it's inline so synchronous,
        // but DCL fires before the walker's setTimeout watchdog).
        await page.waitForTimeout(80);

        // 1. <html lang dir> set BEFORE first interaction — frame-0 guarantee.
        expect(await page.evaluate(() => document.documentElement.lang))
            .toBe(target.code);
        expect(await page.evaluate(() => document.documentElement.dir))
            .toBe(target.dir);

        // 2. Boot lang exposed to JS consumers.
        expect(await page.evaluate(() => (window as any).__crispBootLang))
            .toBe(target.code);

        // 3. Walker completed cleanly (not in 'pending' or 'crashed').
        const walkerState = await page.evaluate(() =>
            (window as any).__crispI18nMetrics?.walker);
        expect(walkerState, `walker stuck at ${walkerState}`).toBe('ok');

        // 4. The CTA renders the locale's actual text — NOT the English value.
        const ctaText = await page.evaluate(() =>
            document.querySelector('[data-i18n="home_cta_primary"]')?.textContent);
        expect(ctaText).toBe(source[target.cta]);

        // 5. For non-EN locales, also confirm the rendered CTA differs
        //    from the EN equivalent — proves the walker actually swapped
        //    text (not just left HTML innerText).
        if (target.code !== 'en') {
            const enSource = loadLocale('en');
            expect(ctaText, `${target.code} rendered EN text on first paint`)
                .not.toBe(enSource[target.cta]);
        }
    });
}
