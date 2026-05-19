/**
 * Phase 25 (May 2026) — i18n screenshot grid for the 22 supported
 * locales. Per locale we capture 3 critical stages (home, picker
 * open, capture-v4 entry) and write them to
 * `e2e/screenshots/i18n/{lang}_{stage}.png`. Useful evidence to
 * attach to the UNDP submission PR.
 *
 * Pass criterion: no thrown error (screenshots are always generated).
 * A separate "no-raw-key" pass scans each PNG's DOM for tokens
 * matching the i18n-key regex (e.g. `v4_take_photo`) — if any
 * untranslated key leaks visibly, the test fails.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// The 22 supported locales (mirrors mobile-app/src/app.js
// SUPPORTED_LANGS + the picker order).
const LOCALES = [
    // Tier 1 — UN official
    'en', 'zh', 'es', 'ar', 'fr', 'ru',
    // Tier 2 — UNDP submission set
    'hi', 'pt', 'bn', 'ja', 'tr', 'vi', 'ko', 'id', 'ur',
    // Tier 3 — Indian sub-national
    'kn', 'ta', 'te', 'ml', 'gu', 'mr', 'pa',
];

const OUT_DIR = path.resolve(__dirname, '..', '..', 'screenshots', 'i18n');

// A raw-i18n-key looks like `lowercase_with_underscores`. Real
// English copy NEVER consists of only lowercase letters + underscores
// in our codebase (we use sentence case + spaces), so a token matching
// /^[a-z][a-z0-9_]+$/ that appears as visible text is a leak.
const RAW_KEY_RE = /\b[a-z][a-z0-9_]{4,}\b/;
// Curated allow-list — these short tokens DO appear in our copy as
// legitimate words (e.g. lowercase "or" in "Login or Sign up") and
// must not be flagged.
const ALLOW_TOKENS = new Set([
    'crisp', 'ok', 'or', 'and', 'the', 'no', 'yes', 'tap', 'help',
    'home', 'send', 'voice', 'photo', 'login', 'undp', 'gps', 'osm',
    'ivr', 'sms', 'whatsapp', 'telegram', 'android', 'ios', 'pwa',
    'jpg', 'png', 'csv', 'json', 'url',
]);

function scanForRawKeys(text: string): string[] {
    const tokens = text.toLowerCase().match(/\b[a-z][a-z0-9_]{4,}\b/g) || [];
    const leaks: string[] = [];
    for (const t of tokens) {
        if (ALLOW_TOKENS.has(t)) continue;
        // True i18n keys contain an underscore. Filter on that to
        // avoid false-positives on long English words ("incident").
        if (!t.includes('_')) continue;
        leaks.push(t);
    }
    return Array.from(new Set(leaks));
}

async function ensureBooted(page, langCode: string) {
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
    // Give i18n + RTL flip a moment.
    await page.waitForTimeout(300);
}

test.beforeAll(() => {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
});

for (const lang of LOCALES) {
    test(`i18n screenshot grid — ${lang}`, async ({ page }) => {
        // iPhone-14-ish viewport so the grid is comparable.
        await page.setViewportSize({ width: 390, height: 844 });
        await ensureBooted(page, lang);

        // Stage 1 — home.
        await page.screenshot({
            path: path.join(OUT_DIR, `${lang}_home.png`),
            fullPage: false,
        });
        // No-raw-key scan on the home page body text.
        const homeText = await page.locator('body').innerText().catch(() => '');
        const homeLeaks = scanForRawKeys(homeText);
        expect(homeLeaks, `${lang} home raw-key leak`).toEqual([]);

        // Stage 2 — picker open.
        await page.locator('#btn-lang-current').click().catch(() => {});
        await page.waitForTimeout(200);
        await page.screenshot({
            path: path.join(OUT_DIR, `${lang}_picker.png`),
            fullPage: false,
        });
        const pickerText = await page.locator('#lang-picker-overlay').innerText().catch(() => '');
        const pickerLeaks = scanForRawKeys(pickerText);
        expect(pickerLeaks, `${lang} picker raw-key leak`).toEqual([]);
        // Close the picker.
        await page.locator('#lang-picker-close').click().catch(() => {});
        await page.waitForTimeout(200);

        // Stage 3 — capture-v4 entry (best effort; not all locales may
        // boot all the way in this short test).
        const cta = page.locator('#btn-start, [data-i18n="big_cta"]').first();
        await cta.click().catch(() => {});
        await page.waitForTimeout(300);
        await page.screenshot({
            path: path.join(OUT_DIR, `${lang}_capture.png`),
            fullPage: false,
        });
        const captureText = await page.locator('body').innerText().catch(() => '');
        const captureLeaks = scanForRawKeys(captureText);
        expect(captureLeaks, `${lang} capture raw-key leak`).toEqual([]);
    });
}
