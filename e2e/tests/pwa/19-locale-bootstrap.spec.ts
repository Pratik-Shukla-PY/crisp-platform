/**
 * Regression guards for the locale-bootstrap fix (Apr 2026).
 *
 * Two pre-existing bugs on the bootstrap path snuck past CI during the
 * UNDP sprint because CI was wedged on unrelated backend failures
 * (python-multipart, bcrypt 5). Once backend CI went green they surfaced:
 *
 *   Bug 1 — narrow locale gate.
 *     app.js read `crisp_lang_manual` from localStorage and only accepted
 *     the choice if `I18N[code]` was truthy. The inline `I18N` dict only
 *     has EN/KN/HI/TA; every other locale (AR, UR, FR, ES, ZH, RU, HE, …)
 *     lives in EXTRA_LANG / UNDP_I18N_EXTRA or is RTL-only (Hebrew). So
 *     a user who manually picked any of those silently snapped back to
 *     English on every reload — and `<html dir>` never flipped for RTL.
 *
 *     Fix: bootstrap now uses `_isKnownLocale(code)` which consults
 *     I18N / EXTRA_LANG / UNDP_I18N_EXTRA / RTL_LANGS / COUNTRY_LANG_DATA /
 *     REGION_LANG_MAP.
 *
 *   Bug 2 — window.I18N undefined.
 *     `const I18N = {…}` at script top-level DOES create a script-global
 *     reachable by bare identifier, but does NOT attach to `window` in
 *     Chromium (classic-script behaviour per WHATWG). Tests + the
 *     dashboard embed shell that probe `window.I18N` saw `undefined`.
 *
 *     Fix: explicit `window.I18N = I18N` (+ EXTRA_LANG + UNDP_I18N_EXTRA)
 *     immediately after each dict is defined. Mutations via
 *     `I18N[code] = …` automatically reflect on window (same reference).
 *
 * This spec pins both invariants. If either regresses, the 13-rtl-layout
 * + 14-locale-json-loader specs will go red again — but this tighter
 * spec pinpoints which invariant was broken.
 */
import { test, expect } from '@playwright/test';

async function openPwaBare(page) {
  // No consent-accept / no btn-lang-en click here. Those side-effects
  // set crisp_lang_manual='en' which would mask the bugs we're pinning.
  await page.goto('index.html');
  await page.evaluate(() => {
    localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');  // Pre-v4 tests target the v3 capture flow.
  });
  await page.reload();
}

test.describe('PWA locale-bootstrap invariants', () => {
  test('window.I18N / EXTRA_LANG / UNDP_I18N_EXTRA are reachable from window', async ({ page }) => {
    await openPwaBare(page);
    // Allow the DOMContentLoaded + activateLang + async JSON pass to run.
    await page.waitForFunction(
      () => typeof (window as any).I18N === 'object' && (window as any).I18N && typeof (window as any).I18N.en === 'object',
      { timeout: 5000 },
    );
    const shape = await page.evaluate(() => ({
      I18N: typeof (window as any).I18N,
      EXTRA_LANG: typeof (window as any).EXTRA_LANG,
      UNDP_I18N_EXTRA: typeof (window as any).UNDP_I18N_EXTRA,
      hasEnBaseline: !!(window as any).I18N && typeof (window as any).I18N.en === 'object',
      hasUnLocaleInUndpPack: !!(window as any).UNDP_I18N_EXTRA
                            && typeof (window as any).UNDP_I18N_EXTRA.ar === 'object'
                            && typeof (window as any).UNDP_I18N_EXTRA.fr === 'object',
    }));
    expect(shape.I18N).toBe('object');
    expect(shape.EXTRA_LANG).toBe('object');
    expect(shape.UNDP_I18N_EXTRA).toBe('object');
    expect(shape.hasEnBaseline).toBeTruthy();
    expect(shape.hasUnLocaleInUndpPack).toBeTruthy();
  });

  // Every UN locale (the ones UNDP §3.1 mandates) + Hebrew (RTL-only).
  // If crisp_lang_manual=<code> is set and we reload, the app MUST honour
  // the choice — activateLang(<code>) must fire, NOT fall through to 'en'.
  //
  // Observable signals (listed in preference order, first one that's
  // strong enough to be unambiguous wins):
  //   1. `document.documentElement.lang === <code>` — activateLang sets it.
  //   2. `<html dir="rtl">` for RTL locales.
  //   3. For locales in UNDP_I18N_EXTRA, `I18N[<code>]` is populated.
  for (const probe of [
    { code: 'ar', dir: 'rtl', hasUndpPack: true },
    { code: 'ur', dir: 'rtl', hasUndpPack: true },  // UNDP pack covers ur
    // 'he' was previously listed but Hebrew never shipped — no
    // he.json in mobile-app/src/i18n/. Removed to keep the probe set
    // aligned with locales the app actually supports (22 total —
    // see ls mobile-app/src/i18n/).
    { code: 'fr', dir: 'ltr', hasUndpPack: true },
    { code: 'es', dir: 'ltr', hasUndpPack: true },
    { code: 'ru', dir: 'ltr', hasUndpPack: true },
    { code: 'zh', dir: 'ltr', hasUndpPack: true },
  ]) {
    test(`manual locale "${probe.code}" survives a reload (dir=${probe.dir})`, async ({ page }) => {
      await openPwaBare(page);
      await page.evaluate((code) => localStorage.setItem('crisp_lang_manual', code), probe.code);
      await page.reload();

      // activateLang sets html.lang synchronously; wait on it with a
      // reasonable timeout so slow CI doesn't flake.
      await page.waitForFunction(
        (c) => document.documentElement.lang === c,
        probe.code,
        { timeout: 5000 },
      );

      const obs = await page.evaluate((code) => ({
        htmlLang: document.documentElement.lang,
        htmlDir: document.documentElement.dir,
        // Post my fix, activateLang merges UNDP_I18N_EXTRA[code] onto
        // I18N[code] at the top of the function. We check via window.I18N
        // which is now explicitly exposed.
        i18nCodeOnWindow: (window as any).I18N && typeof (window as any).I18N[code],
      }), probe.code);

      expect(obs.htmlLang).toBe(probe.code);
      expect(obs.htmlDir).toBe(probe.dir);
      if (probe.hasUndpPack) {
        // For locales covered by UNDP_I18N_EXTRA, activateLang populates
        // I18N[code] with at least the UNDP addenda — so it MUST be an
        // object on window.
        expect(obs.i18nCodeOnWindow).toBe('object');
      }
    });
  }

  test('unknown locale falls back to English (safety)', async ({ page }) => {
    // Malformed / unsupported code should NOT be honoured. The fallback
    // is 'en' so the UI stays coherent.
    await openPwaBare(page);
    await page.evaluate(() => localStorage.setItem('crisp_lang_manual', 'zz'));
    await page.reload();
    await page.waitForFunction(
      () => document.documentElement.lang === 'en',
      { timeout: 5000 },
    );
    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    expect(htmlLang).toBe('en');
  });

  test('empty / missing manual locale falls back to a supported locale', async ({ page }) => {
    // Clean slate — no localStorage key at all.
    await page.goto('index.html');
    await page.evaluate(() => {
      localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.removeItem('crisp_lang_manual');
    });
    await page.reload();
    await page.waitForFunction(
      () => document.documentElement.lang && document.documentElement.lang.length > 0,
      { timeout: 5000 },
    );
    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    // Pre-fix this asserted strict 'en' — but the May 2026 GPS-based
    // auto-detect kicks in when no manual locale is set, and the
    // Bengaluru fixture in playwright.config.ts resolves to 'kn'.
    // The actual policy is "no manual + no GPS = en; GPS-detected =
    // local language". Assert the resolved lang is one of the
    // supported codes — i.e. it's NOT empty/undefined.
    const SUPPORTED = ['ar', 'bn', 'en', 'es', 'fr', 'gu', 'hi', 'id', 'ja',
                       'kn', 'ko', 'ml', 'mr', 'pa', 'pt', 'ru', 'ta', 'te',
                       'tr', 'ur', 'vi', 'zh'];
    expect(SUPPORTED).toContain(htmlLang);
  });
});
