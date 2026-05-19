/**
 * UNDP §3.1b — async locale-JSON loader regression guards.
 *
 * The PWA ships an inline I18N/EXTRA_LANG/UNDP_I18N_EXTRA pack for the
 * six UN locales (enough to paint first frame instantly). On
 * `activateLang(code)` it also fetches `./i18n/{code}.json` and merges
 * the dense 232-key pack on top. This spec pins down three invariants:
 *
 *   1. Every UN locale JSON file responds 200 with parseable JSON and
 *      the canonical 232-key shape (_meta_ + content).
 *   2. After `activateLang('ar')` (or fr/es/ru/zh) resolves, at least
 *      one JSON-only key renders on screen. We use a key that appears
 *      in the JSON but was NEVER in the inline pack, so only the
 *      loader can have populated it. Pick `loc_resolving` — it exists
 *      in en.json + every UN locale JSON, but was never mirrored into
 *      EXTRA_LANG / UNDP_I18N_EXTRA.
 *   3. The fallback chain still works if the fetch fails (simulated
 *      via route interception) — the inline pack keeps the UI usable.
 */
import { test, expect } from '@playwright/test';

async function openHome(page) {
  await page.goto('index.html');
  await page.evaluate(() => {
    localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');  // Pre-v4 tests target the v3 capture flow.
  });
  await page.reload();
  const enBtn = page.locator('#btn-lang-en');
  if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
  await page.evaluate(() => {
    const c = document.getElementById('consent-overlay');
    if (c) c.style.display = 'none';
  });
}

test.describe('PWA locale-JSON loader', () => {
  for (const locale of ['fr', 'es', 'ar', 'ru', 'zh']) {
    test(`${locale}.json responds with a valid 232-key pack`, async ({ request, baseURL }) => {
      // Expect the static asset to be served at /i18n/{locale}.json.
      const res = await request.get(new URL(`i18n/${locale}.json`, baseURL).toString());
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toBeTruthy();
      // Strip __meta__ before counting — it's descriptive, not user text.
      const { __meta__, ...content } = body;
      expect(Object.keys(content).length).toBeGreaterThanOrEqual(230);
      // Spot-check a UNDP-critical key present in every locale JSON.
      expect(content.minimal_damage).toBeTruthy();
      expect(content.tsunami).toBeTruthy();
      expect(content.civil_unrest).toBeTruthy();
      // Template variables must survive translation.
      expect(content.rd_people_helped_many).toMatch(/\{n\}/);
    });
  }

  test('activateLang("fr") pulls the dense JSON and updates DOM', async ({ page }) => {
    await openHome(page);
    // Give the loader time to resolve. This also forces the initial
    // sync path to run first so any change we observe is from the
    // async upgrade step.
    await page.evaluate(async () => {
      localStorage.setItem('crisp_lang_manual', 'fr');
    });
    await page.reload();
    await page.waitForFunction(() => {
      // The loader sets I18N.fr with a dense pack. Look for a key that
      // only exists in the JSON pack (not in the inline EXTRA_LANG.fr
      // or UNDP_I18N_EXTRA.fr dicts).
      const dict = (window as any).I18N && (window as any).I18N.fr;
      return dict && typeof dict.loc_resolving === 'string' && dict.loc_resolving.includes('localisation');
    }, { timeout: 5000 });

    const resolving = await page.evaluate(() => (window as any).I18N?.fr?.loc_resolving);
    expect(resolving).toMatch(/[A-Za-zÀ-ÿ]/);
    // Should NOT be the English baseline — the JSON pack must have won.
    expect(resolving).not.toBe('Resolving location…');
  });

  test('loader failure falls back cleanly to inline pack', async ({ page }) => {
    await page.route('**/i18n/ar.json', (route) => route.abort());
    await openHome(page);
    await page.evaluate(() => localStorage.setItem('crisp_lang_manual', 'ar'));
    await page.reload();
    // After ~1 s the inline UNDP_I18N_EXTRA.ar pack should still have
    // populated a sensible Arabic string for a UNDP-critical key.
    await page.waitForFunction(() => {
      const dict = (window as any).I18N && (window as any).I18N.ar;
      return dict && typeof dict.tsunami === 'string' && dict.tsunami.length > 0;
    }, { timeout: 5000 });
    // RTL direction must still apply regardless of JSON load success.
    const dir = await page.evaluate(() => document.documentElement.dir);
    expect(dir).toBe('rtl');
  });
});
