/**
 * Audio / onboarding guidance integrity.
 *
 * Spoken audio = the live i18n string (voice-readout.js reads it via
 * SpeechSynthesis). A regression once shipped "tap the ORANGE button" in 21
 * locales after the CTA turned teal. This spec taps the home voice button per
 * language, captures the text that WOULD be spoken, and asserts it (a) names no
 * colour/appearance and (b) actually contains the localized hint - so a future
 * stale translation or an un-backfilled English edit fails here, not in the field.
 */
import { test, expect } from '@playwright/test';

// Orange/green tokens across the shipped scripts (the regression class).
const COLOUR = /orange|naranja|laranja|turuncu|оранжев|नारंगी|केशरी|संतरी|નારંગી|નారింజ|నారింజ|ஆரஞ்சு|ഓറഞ്ച്|ಕಿತ್ತಳೆ|برتقال|نارنجی|オレンジ|주황|橙|\bgreen\b|verde|\bvert\b|зелен|зелён|हरा|हरे|绿|பச்ச|പച്ച|ಹಸಿರು|سبز|أخضر|초록|녹색|yeşil|hijau|\bxanh\b|\bcam\b|jeruk/i;

async function captureSpoken(page, lang) {
    await page.addInitScript((lc) => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_lang_manual', lc);
    }, lang);
    await page.goto('index.html');
    await page.evaluate(() => { const c = document.getElementById('consent-overlay'); if (c) c.style.display = 'none'; });
    await page.waitForSelector('#btn-home-voice', { timeout: 8000 });
    await page.waitForTimeout(600);
    // Intercept what _wireHomeVoice would speak.
    await page.evaluate(() => {
        (window as any).__spoken = null;
        (window as any).VoiceReadout = (window as any).VoiceReadout || {};
        (window as any).VoiceReadout.speak = (t) => { (window as any).__spoken = t; };
    });
    await page.locator('#btn-home-voice').click();
    const spoken = await page.evaluate(() => (window as any).__spoken || '');
    const hint = await page.evaluate(() => (window as any).t && (window as any).t('home_voice_hint'));
    return { spoken, hint };
}

for (const lang of ['en', 'hi', 'fr', 'ar', 'te']) {
    test(`audio guidance [${lang}]: spoken hint is colour-free + matches the live i18n`, async ({ page }) => {
        const { spoken, hint } = await captureSpoken(page, lang);
        expect(spoken, 'the home voice button must produce spoken text').toBeTruthy();
        expect(spoken, `spoken guidance must not name a colour (got: ${spoken})`).not.toMatch(COLOUR);
        expect(hint).toBeTruthy();
        expect(spoken).toContain(hint); // spoken text uses the current localized hint
    });
}
