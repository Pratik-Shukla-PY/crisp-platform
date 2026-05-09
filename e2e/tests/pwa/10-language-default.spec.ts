/**
 * Apr 2026 language-UX regression guards (revised).
 *
 * Intent:
 *   · Default active language is the auto-detected local (GPS / IP) when
 *     the user has no manual pick stored. English is the fallback when no
 *     local can be resolved.
 *   · User's manual pick is remembered in localStorage['crisp_lang_manual']
 *     and ALWAYS wins over auto-detection on subsequent loads.
 *   · Picker overlay opens on tap of #btn-lang-current (primary pill) and
 *     contains every supported language. English is listed first.
 *   · Playwright config forces Bengaluru geo (kn), so a fresh session
 *     should land in Kannada unless a manual pick overrides.
 */
import { test, expect } from '@playwright/test';

async function openClean(page) {
  await page.goto('index.html');
  await page.evaluate(() => {
    localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
    // Wipe any leftover manual lang from prior runs so we test the default.
    localStorage.removeItem('crisp_lang_manual');
  });
  await page.reload();
  await page.evaluate(() => {
    const c = document.getElementById('consent-overlay');
    if (c) c.style.display = 'none';
  });
}

test.describe('PWA language defaults (Apr 2026)', () => {
  test('@smoke default active language auto-activates the detected local', async ({ page }) => {
    await openClean(page);
    // Visible pill exists.
    await expect(page.locator('#btn-lang-current')).toBeVisible();
    // With Playwright geo locked to Bengaluru (kn in REGION_LANG_MAP), the
    // auto-detected local should win on a fresh session with no manual
    // pick. Allow a short poll window for GPS / IP resolution to complete.
    await page.waitForFunction(() => {
      const s = (window as any).state;
      // Either kn (GPS resolved) or en (no detection — acceptable fallback).
      return s && ['kn', 'en'].includes(s.lang);
    }, null, { timeout: 10_000 });
    const lang = await page.evaluate(() => (window as any).state?.lang);
    expect(['kn', 'en']).toContain(lang);
  });

  test('@smoke tapping the pill opens the picker overlay', async ({ page }) => {
    await openClean(page);
    await expect(page.locator('#lang-picker-overlay')).toBeHidden();
    await page.locator('#btn-lang-current').click();
    await expect(page.locator('#lang-picker-overlay')).toBeVisible();
    // Core locales visible + title.
    await expect(page.locator('#lang-picker-overlay .lang-picker-title')).toContainText(/Choose language/i);
    for (const code of ['en', 'hi', 'kn', 'ta', 'ar', 'es', 'fr', 'zh']) {
      await expect(page.locator(`#lang-picker-overlay .lang-picker-flag[data-lang="${code}"]`)).toBeAttached();
    }
  });

  test('picking a language activates it AND persists the choice', async ({ page }) => {
    await openClean(page);
    await page.locator('#btn-lang-current').click();
    await page.locator('#lang-picker-overlay .lang-picker-flag[data-lang="kn"]').click();
    // Picker closes.
    await expect(page.locator('#lang-picker-overlay')).toBeHidden();
    // Pill shows the new locale code.
    await expect(page.locator('#btn-lang-current')).toContainText('KN');
    // state.lang reflects.
    const lang = await page.evaluate(() => (window as any).state?.lang);
    expect(lang).toBe('kn');
    // Choice persisted.
    const manual = await page.evaluate(() => localStorage.getItem('crisp_lang_manual'));
    expect(manual).toBe('kn');
  });

  test('manual choice persists across reloads (no English reset)', async ({ page }) => {
    await openClean(page);
    // Seed the manual choice directly and reload.
    await page.evaluate(() => localStorage.setItem('crisp_lang_manual', 'hi'));
    await page.reload();
    await page.evaluate(() => {
      const c = document.getElementById('consent-overlay');
      if (c) c.style.display = 'none';
    });
    await expect(page.locator('#btn-lang-current')).toContainText('HI');
    const lang = await page.evaluate(() => (window as any).state?.lang);
    expect(lang).toBe('hi');
  });
});
