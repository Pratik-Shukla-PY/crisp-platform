/**
 * UNDP §3.1 — RTL layout regression guards.
 *
 *   Arabic / Urdu / Hebrew reporters must see the app mirrored
 *   (`<html dir="rtl">` + flex-direction flip on the capture flow).
 *   The presence of RTL-localised text is covered by the i18n-leaks
 *   spec; this file pins down the layout direction specifically so a
 *   future refactor that deletes `_applyTextDirection` fails the build.
 */
import { test, expect } from '@playwright/test';

async function openLangAndAssertDir(page, langCode, expectedDir) {
  await page.goto('index.html');
  await page.evaluate(() => {
    localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');  // Pre-v4 tests target the v3 capture flow.
  });
  await page.reload();
  // Programmatically flip to the target locale (we don't assume the
  // picker UI is open). The app exposes `activateLang` via window scope
  // inside an IIFE — fall back to setting localStorage + reload.
  await page.evaluate((code) => {
    localStorage.setItem('crisp_lang_manual', code);
  }, langCode);
  await page.reload();

  // Wait for the lang class / dir attribute to apply.
  await page.waitForFunction(
    ({ dir }) => document.documentElement.dir === dir,
    { dir: expectedDir },
    { timeout: 5000 },
  ).catch(() => { /* let the assertion below produce a better error */ });

  const dir = await page.evaluate(() => document.documentElement.dir);
  expect(dir).toBe(expectedDir);
}

test.describe('PWA text direction', () => {
  test('Arabic flips html dir=rtl', async ({ page }) => {
    await openLangAndAssertDir(page, 'ar', 'rtl');
  });

  test('Urdu flips html dir=rtl', async ({ page }) => {
    await openLangAndAssertDir(page, 'ur', 'rtl');
  });

  // Phase 25 (May 2026) — Hebrew was removed from the 22-locale
  // SUPPORTED_LANGS set. activateLang('he') now warns and falls back
  // to English (LTR). The test below documents that behavior so a
  // future re-introduction of Hebrew is a deliberate update, not a
  // silent regression.
  test('Hebrew is unsupported in Phase 25 — falls back to ltr', async ({ page }) => {
    await openLangAndAssertDir(page, 'he', 'ltr');
  });

  test('English stays dir=ltr', async ({ page }) => {
    await openLangAndAssertDir(page, 'en', 'ltr');
  });

  test('French stays dir=ltr', async ({ page }) => {
    await openLangAndAssertDir(page, 'fr', 'ltr');
  });
});
