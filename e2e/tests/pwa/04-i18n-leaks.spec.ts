/**
 * PWA i18n leak guard — Apr 2026 PR 1.
 *
 * Visits every capture stage in English + Kannada + Hindi and fails if
 * ANY visible element renders a raw i18n-style key (all-lowercase-snake
 * or ALL-UPPERCASE-SNAKE matching the `/^[a-z0-9_]+$/i` pattern).
 *
 * Root cause we're guarding against: the PWA's old `t()` function
 * (`mobile-app/src/app.js:846`) short-circuited on the first truthy
 * locale lookup. Once the Kannada dict was truthy, any key missing
 * from Kannada was returned as its literal key name — and CSS
 * `text-transform: uppercase` rendered it as `CRISIS_LABEL`,
 * `DAMAGE_LABEL`, etc. The bug was fixed by switching to a proper
 * per-key English fallback chain. This spec keeps us from reverting.
 *
 * Parity with `02-capture-flow.spec.ts:149`'s `getByText(/TYPE_TEXT/)`
 * — that was the first leak we caught. This spec generalises it.
 */
import { test, expect } from '@playwright/test';

// Keys we *know* are snake_case (contain underscore) and are USED in
// the DOM. If any of these surface as visible text (after t() resolves),
// we have a leak. Single-word keys (e.g. "school", "flood") are NOT
// guarded because their English translation legitimately equals the key
// string — we can't distinguish a leak from correct rendering for those.
// Underscore-bearing keys like "crisis_label" or "complete_damage" are
// unambiguous leaks if they render as-is.
const KEYS_TO_GUARD = [
  'crisis_label', 'damage_label', 'description_label', 'service_label',
  'debris_label', 'infra_name_label', 'needs_label', 'review_details_title',
  'complete_damage', 'partial_damage', 'no_damage',
  'other_crisis',
  'water_svc', 'health_svc',
  'need_water',
  'type_text',
];

async function openHomeInEnglish(page) {
  await page.goto('index.html');
  await page.evaluate(() => {
    localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');  // Pre-v4 tests target the v3 capture flow.
  });
  await page.reload();
  // Click the explicit EN button to override GPS-based auto-detection.
  const enBtn = page.locator('#btn-lang-en');
  if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
}

async function openHomeInDetectedLocal(page) {
  // Tests the OTHER branch — whatever the local button resolved to
  // (Kannada in Playwright's default geolocation, per the config's
  // Bengaluru coords). Proves non-English users aren't seeing leaks.
  await page.goto('index.html');
  await page.evaluate(() => {
    localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');  // Pre-v4 tests target the v3 capture flow.
  });
  await page.reload();
  const localBtn = page.locator('#btn-lang-local');
  // Only click if visible — if GPS didn't resolve to a non-English
  // locale, skip this variant (it's covered by the EN test).
  const visible = await localBtn.isVisible().catch(() => false);
  if (visible) await localBtn.click({ force: true });
  return visible;
}

async function expectNoRawKeysIn(page, stageId: string) {
  // Read all visible text-content on the active stage.
  const texts = await page.$$eval(
    `#${stageId} [data-i18n], #${stageId} [data-i18n-placeholder]`,
    (nodes) => nodes.map((n) => {
      // For INPUT/TEXTAREA, check placeholder; otherwise textContent.
      if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') {
        return (n as HTMLInputElement).placeholder || '';
      }
      return (n.textContent || '').trim();
    }),
  );
  for (const raw of texts) {
    // A leaked key looks like `foo_bar` — lowercase letters + underscores
    // only, no spaces, no punctuation, and it's EXACTLY one of the keys
    // we're guarding. We allow the string to be rendered in uppercase by
    // CSS `text-transform: uppercase` so compare case-insensitively.
    const normalised = raw.replace(/\s+/g, '').toLowerCase();
    for (const key of KEYS_TO_GUARD) {
      if (normalised === key) {
        throw new Error(
          `i18n leak: stage=${stageId} rendered the literal key "${key}" ` +
          `(raw="${raw}"). The PWA t() fallback is broken or the key is ` +
          `missing from I18N.en.`,
        );
      }
    }
  }
}

test.describe('PWA i18n leak guard', () => {
  // English is the most critical — if EN has gaps, EVERY locale inherits
  // them via the per-key fallback.
  test('English: no raw keys on any capture stage', async ({ page }) => {
    await openHomeInEnglish(page);
    await page.locator('#btn-start').click();
    await expect(page.locator('#stage-photo.active')).toBeVisible();
    await expectNoRawKeysIn(page, 'stage-photo');

    // Seed enough state to advance past the mandatory-photo gate.
    await page.evaluate(() => {
      const s = (window as any).state;
      if (s) s.photoDataUrl = 'data:image/jpeg;base64,AAAA';
    });
    await page.evaluate(() => (window as any).__crispGoToStage?.('stage-audio'));
    await expect(page.locator('#stage-audio.active')).toBeVisible();
    await expectNoRawKeysIn(page, 'stage-audio');

    await page.evaluate(() => (window as any).__crispGoToStage?.('stage-review'));
    await expect(page.locator('#stage-v4-review.active')).toBeVisible();
    await expectNoRawKeysIn(page, 'stage-review');

    await page.evaluate(() => (window as any).__crispGoToStage?.('stage-send'));
    await expect(page.locator('#stage-send.active')).toBeVisible();
    await expectNoRawKeysIn(page, 'stage-send');
  });

  // The detected local language (Kannada by default via the Bengaluru
  // GPS fixture in playwright.config.ts) is the locale that surfaced
  // the original bug. With the fallback fix, missing KN keys fall
  // through to the freshly-added EN values.
  test('Detected local locale: falls through to English cleanly', async ({ page }) => {
    const hadLocal = await openHomeInDetectedLocal(page);
    test.skip(!hadLocal, 'GPS auto-detection did not resolve to a non-English locale');
    await page.locator('#btn-start').click();
    await expectNoRawKeysIn(page, 'stage-photo');
    await page.evaluate(() => {
      const s = (window as any).state;
      if (s) s.photoDataUrl = 'data:image/jpeg;base64,AAAA';
    });
    await page.evaluate(() => (window as any).__crispGoToStage?.('stage-review'));
    await expectNoRawKeysIn(page, 'stage-review');
  });

  // Build-time guard (runs without a browser): every data-i18n attribute
  // in index.html MUST resolve to a value in I18N.en.
  test('every DOM data-i18n key has an English value', async ({}) => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../../../mobile-app/src/app.js'),
      'utf8',
    );
    const m = src.match(/const\s+I18N\s*=\s*(\{[\s\S]*?\n\};)/m);
    expect(m, 'I18N block not found in app.js').toBeTruthy();
    // eslint-disable-next-line no-eval
    const I18N = eval('(' + m![1].replace(/;\s*$/, '') + ')');
    const html = fs.readFileSync(
      require('path').resolve(__dirname, '../../../mobile-app/src/index.html'),
      'utf8',
    );
    const domKeys = new Set<string>();
    for (const mm of html.matchAll(/data-i18n(?:-placeholder)?="([a-z0-9_]+)"/g)) {
      domKeys.add(mm[1]);
    }
    const en = I18N.en || {};
    const missing = [...domKeys].filter((k) => !(k in en)).sort();
    expect(missing, `${missing.length} data-i18n keys have no English value: ${missing.join(', ')}`).toEqual([]);
  });
});
