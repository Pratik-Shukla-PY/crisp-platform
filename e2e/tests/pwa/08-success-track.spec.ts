/**
 * PR 7 (Apr 2026) — Success screen + Track button regression guards.
 *
 *   · The success stage shows a glowing heart (not ✅), new copy, and the
 *     report ID pill.
 *   · Two actions are present: primary [+ Add another report] + secondary
 *     [Track your report].
 *   · Navigating to stage-success via the testability hook is enough to
 *     assert the DOM structure (no real submission needed).
 *   · Track button with no just-submitted report shows a toast and does
 *     NOT navigate (defensive — prevents "Report not found" leaking).
 */
import { test, expect } from '@playwright/test';

async function openHomeInEnglish(page) {
  await page.goto('index.html');
  await page.evaluate(() => {
    localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
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

  test('@smoke success stage shows heart + new copy + both CTAs', async ({ page }) => {
    await page.evaluate(() => (window as any).__crispGoToStage && (window as any).__crispGoToStage('stage-success'));
    await expect(page.locator('#stage-success.active')).toBeVisible();

    // Heart element replaces the old ✅ icon.
    await expect(page.locator('.success-heart')).toBeVisible();
    await expect(page.locator('.success-heart')).toContainText('❤️');
    // Old success-icon must be gone.
    await expect(page.locator('#stage-success .success-icon')).toHaveCount(0);

    // PR 7 warmed copy.
    await expect(page.locator('#stage-success h2')).toContainText(/Thank you/i);
    await expect(page.locator('#stage-success p[data-i18n="sent_sub"]')).toContainText(/save lives/i);

    // Two CTAs.
    await expect(page.locator('#btn-new-report')).toBeVisible();
    await expect(page.locator('#btn-new-report')).toContainText(/Add another report/i);
    await expect(page.locator('#btn-track-report')).toBeVisible();
    await expect(page.locator('#btn-track-report')).toContainText(/Track your report/i);
  });

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
