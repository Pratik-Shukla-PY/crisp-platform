/**
 * Initial-language precedence (Option B, Jun 2026):
 *   manual in-app pick  >  explicit non-English device locale  >  GPS location
 *   >  English / unsupported / none.
 *
 * Root cause this guards: the PWA used to rank `navigator.language` ABOVE GPS
 * location, so a phone left in English (the global default) never honored the
 * user's physical location - the detected local language only showed as a
 * "Your region" suggestion chip, never the active UI. Operator decision: a
 * phone in English standing in Dhaka should open in Bengali, while a phone
 * EXPLICITLY set to a supported non-English language (fr/es/ar/zh/...) keeps
 * that choice. Manual in-app picks always win and persist.
 *
 * Deterministic by construction: device locale is overridden via init script,
 * GPS via the context geolocation, and the Nominatim reverse-geocode is mocked
 * so resolution never depends on the live network or a real fix.
 */
import { test, expect } from '@playwright/test';

// COUNTRY_LANG_DATA / REGION_LANG_MAP fixtures (verified in app.js):
//   country_code 'bd' -> bn,  'in' + state 'Karnataka' -> kn,  'fr' -> fr.
const ADDR_DHAKA = { country_code: 'bd', city: 'Dhaka', country: 'Bangladesh' };
const ADDR_BENGALURU = { country_code: 'in', state: 'Karnataka', city: 'Bengaluru', country: 'India' };
const GEO_DHAKA = { latitude: 23.8103, longitude: 90.4125 };
const GEO_BENGALURU = { latitude: 12.9716, longitude: 77.5946 };

/** Force the device's declared locale BEFORE any page script runs. */
async function setDeviceLocale(page, locale) {
  await page.addInitScript((loc) => {
    Object.defineProperty(navigator, 'language', { get: () => loc, configurable: true });
    Object.defineProperty(navigator, 'languages', { get: () => [loc], configurable: true });
  }, locale);
}

/** Seed consent/landing so the home stage paints, plus optional extra storage. */
async function seedStorage(page, extra = {}) {
  await page.addInitScript((kv) => {
    try {
      localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');
      localStorage.removeItem('crisp_lang_manual');
      localStorage.removeItem('crisp_loc_ctx');
      for (const k of Object.keys(kv)) localStorage.setItem(k, kv[k]);
    } catch (_) {}
  }, extra);
}

/** Mock (or fail) the reverse-geocode so language resolution is deterministic. */
async function mockReverseGeocode(page, address /* or null to fail */) {
  await page.route(/nominatim\.openstreetmap\.org\/reverse/, (route) => {
    if (!address) return route.abort();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ address }) });
  });
}

async function gotoHome(page) {
  await page.goto('index.html');
  await page.evaluate(() => { const c = document.getElementById('consent-overlay'); if (c) c.style.display = 'none'; });
}

test.describe('PWA initial-language precedence (Option B)', () => {
  test('English phone + GPS in Dhaka -> auto-switches to Bengali (location wins over English)', async ({ page, context }) => {
    await setDeviceLocale(page, 'en-US');
    await seedStorage(page);
    await mockReverseGeocode(page, ADDR_DHAKA);
    await context.setGeolocation(GEO_DHAKA);
    await gotoHome(page);
    // Boot paints English (soft default, no location yet).
    expect(await page.evaluate(() => (window as any).__crispBootLang)).toBe('en');
    expect(await page.evaluate(() => (window as any).__crispI18nMetrics?.source)).toBe('browser_soft');
    // The deferred home-stage GPS detect then upgrades to the location language.
    await page.waitForFunction(() => (window as any).state?.lang === 'bn', null, { timeout: 12_000 });
    expect(await page.evaluate(() => (window as any).state?.lang)).toBe('bn');
  });

  test('Explicit French phone + GPS in Bengaluru -> STAYS French (explicit locale outranks location)', async ({ page, context }) => {
    await setDeviceLocale(page, 'fr-FR');
    await seedStorage(page);
    await mockReverseGeocode(page, ADDR_BENGALURU);
    await context.setGeolocation(GEO_BENGALURU);
    await gotoHome(page);
    // Boot lands in French via the explicit-locale branch.
    expect(await page.evaluate(() => (window as any).__crispBootLang)).toBe('fr');
    expect(await page.evaluate(() => (window as any).__crispI18nMetrics?.source)).toBe('browser');
    // Give the deferred GPS detect time to run; it must NOT override French,
    // but it should still populate the "Your region" suggestion (kn).
    await page.waitForFunction(() => (window as any).state?.detectedLang === 'kn', null, { timeout: 12_000 });
    expect(await page.evaluate(() => (window as any).state?.lang)).toBe('fr');
    expect(await page.evaluate(() => (window as any).state?.detectedLang)).toBe('kn');
  });

  test('Manual in-app pick wins over both locale and location', async ({ page, context }) => {
    await setDeviceLocale(page, 'en-US');
    await seedStorage(page, { crisp_lang_manual: 'hi' });
    await mockReverseGeocode(page, ADDR_BENGALURU); // would be kn if applied
    await context.setGeolocation(GEO_BENGALURU);
    await gotoHome(page);
    expect(await page.evaluate(() => (window as any).__crispBootLang)).toBe('hi');
    expect(await page.evaluate(() => (window as any).__crispI18nMetrics?.source)).toBe('manual');
    // Detection must not move us off the manual pick.
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => (window as any).state?.lang)).toBe('hi');
  });

  test('Cached location context beats an English locale at first paint (no GPS wait)', async ({ page }) => {
    await setDeviceLocale(page, 'en-US');
    await seedStorage(page, {
      crisp_loc_ctx: JSON.stringify({ lat: 23.81, lng: 90.41, lang: 'bn', langLabel: 'বাংলা', ts: Date.now() }),
    });
    await gotoHome(page);
    // Resolved synchronously from cache - Bengali at frame 0, source cached_ctx.
    expect(await page.evaluate(() => (window as any).__crispBootLang)).toBe('bn');
    expect(await page.evaluate(() => (window as any).__crispI18nMetrics?.source)).toBe('cached_ctx');
    expect(await page.evaluate(() => (window as any).state?.lang)).toBe('bn');
  });

  test('English phone with no resolvable location stays English', async ({ page, context }) => {
    await setDeviceLocale(page, 'en-US');
    await seedStorage(page);
    await mockReverseGeocode(page, null); // reverse-geocode fails -> no detection
    await context.setGeolocation(GEO_BENGALURU);
    await gotoHome(page);
    expect(await page.evaluate(() => (window as any).__crispBootLang)).toBe('en');
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => (window as any).state?.lang)).toBe('en');
  });
});
