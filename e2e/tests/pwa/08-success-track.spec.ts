/**
 * Success screen + Track button regression guards (originally PR 7,
 * Apr 2026; trimmed May 2026).
 *
 * The original spec had a "@smoke success stage shows heart + new copy
 * + both CTAs" test that asserted the V3-era markup: `.success-heart`
 * with a hardcoded ❤️, `<p data-i18n="sent_sub">` containing /save lives/i,
 * `#btn-new-report` containing "Add another report", `#btn-track-report`
 * containing "Track your report". The Apr 2026 → May 2026 success-stage
 * redesign (heart + ripple + CRISP brand at top-left, secondary CTAs in
 * a sticky-footer row) reshaped all of those selectors. The new
 * responsive spec 87 + the resetApp + track navigation tests below
 * cover the same surface.
 *
 * What stays:
 *   · The defensive "Track button without a submitted report is a
 *     no-op" guard — prevents "Report not found" leaking.
 *   · resetApp via #btn-new-report — verifies the success → home
 *     reset flow doesn't strand the user on success stage.
 *   · Track button + synthesised report → report-detail navigation.
 */
import { test, expect } from '@playwright/test';

async function openHomeInEnglish(page) {
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

test.describe('PWA success screen (PR 7)', () => {
  test.beforeEach(async ({ page }) => { await openHomeInEnglish(page); });

  test('Track button with no submitted report is a no-op (toast only)', async ({ page }) => {
    await page.evaluate(() => (window as any).__crispGoToStage && (window as any).__crispGoToStage('stage-success'));
    await page.locator('#btn-track-report').click();
    // We stayed on stage-success — the toast path doesn't navigate away.
    await expect(page.locator('#stage-success.active')).toBeVisible();
  });

  test('@smoke Add another report resets state and returns to home', async ({ page }) => {
    // Drive to success stage via the testability hook, then click the
    // primary CTA. Regression guard for a bug where a stale DOM lookup
    // (#photo-skip-link, removed in Phase 2) threw inside resetApp() and
    // stranded the user on stage-success — the click appeared to do
    // nothing because the exception short-circuited goToStage('stage-home').
    await page.evaluate(() => {
      const s = (window as any).state;
      // Seed some "previous report" state that resetApp must clear.
      s.photoDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';
      s.description = 'Previous report description';
      s.crisisType = 'WILDFIRE';
      (window as any).__crispGoToStage('stage-success');
    });
    await expect(page.locator('#stage-success.active')).toBeVisible();

    // Tap the primary CTA.
    await page.locator('#btn-new-report').click();

    // We must land on home, not stay on success.
    await expect(page.locator('#stage-home.active')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#stage-success.active')).toBeHidden();

    // State is cleaned — descriptions, photo, crisis reset to defaults.
    const cleared = await page.evaluate(() => {
      const s = (window as any).state;
      return {
        photoDataUrl: s.photoDataUrl,
        description: s.description,
        crisisType: s.crisisType,
        extraPhotoCount: s.extraPhotos?.length,
      };
    });
    expect(cleared.photoDataUrl).toBeNull();
    expect(cleared.description).toBe('');
    expect(cleared.crisisType).toBe('FLOOD');
    expect(cleared.extraPhotoCount).toBe(0);
  });

  test('Track button navigates to report-detail when a report was just submitted', async ({ page }) => {
    // Seed the cache + last-submitted pointer via the testability hook. The
    // production path calls _synthesizeSubmittedReport() inside submitReport()
    // after the upload overlay flips to success; tests shortcut that so we
    // don't need a real network submission.
    const cid = 'test-client-' + Date.now();
    await page.evaluate((clientId) => {
      const s = (window as any).state;
      s.infraType = 'ROAD';
      s.crisisType = 'FLOOD';
      s.severity = 'MODERATE';
      s.damageClass = 'PARTIAL';
      s.description = 'PR 7 test row';
      (window as any).__crispSynthesizeSubmittedReport(clientId, {});
    }, cid);

    await page.evaluate(() => (window as any).__crispGoToStage('stage-success'));
    await page.locator('#btn-track-report').click();
    await expect(page.locator('#stage-report-detail.active')).toBeVisible({ timeout: 5000 });
  });
});
