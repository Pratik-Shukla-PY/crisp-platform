/**
 * Success screen secondary-CTA regression guards (originally PR 7,
 * Apr 2026; trimmed May 2026; realigned Jun 2026 to the HC79/v323
 * success-stage redesign).
 *
 * History of the surface this spec protects:
 *   · PR 7 (Apr 2026) shipped `#btn-track-report` ("Track your report")
 *     which opened `stage-report-detail` for the just-submitted report,
 *     plus a defensive no-op path when nothing had been submitted yet
 *     (prevented a "Report not found" toast/detail from leaking).
 *   · v323 (May 2026, HC79) redesigned stage-success into the live
 *     "mission control" layout. The Track button was REMOVED. Its
 *     navigation role moved to `#btn-success-my-reports`, which calls
 *     openMyReports() — that both switches to `stage-history` AND
 *     renders the in-flight + submitted lists (a bare
 *     goToStage('stage-history') used to leave the just-submitted
 *     report invisible until a full refresh; see setupSendStage()).
 *   · `#btn-new-report` ("Report another incident") now routes to the
 *     v4 CAPTURE stage, not home: resetApp() (clears capture state)
 *     followed by goToStage('stage-v4-capture') so the user starts a
 *     fresh capture without an extra tap (HC79 comment in app.js).
 *
 * What this spec still guards (same protective intent, current UI):
 *   · My Reports from success with NOTHING submitted → lands on the
 *     history screen's empty state; never a broken report-detail view.
 *   · resetApp via #btn-new-report — the success → next-report reset
 *     doesn't strand the user on stage-success, and every capture
 *     field is back to its _freshReportState() default.
 *   · My Reports from success after a submit → openMyReports() RENDERS
 *     the history screen (submitted section unhidden), not a bare
 *     stage swap.
 */
import { test, expect } from './_fixtures';

async function openAppInEnglish(page) {
  await page.addInitScript(() => {
    localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
    localStorage.setItem('crisp_landing_seen', '1');
    localStorage.setItem('crisp_ui_v4', 'on');
    // Pin English BEFORE first paint — both keys are required: the
    // manual pin defeats GPS-based auto-detect (Bengaluru fixture → kn).
    localStorage.setItem('crisp_lang', 'en');
    localStorage.setItem('crisp_lang_manual', 'en');
  });
  await page.goto('index.html?ui=v4');
  // Wait for FULL boot, not just script parse. `__crispGoToStage` +
  // `state` are top-level exports (available at parse time), but the
  // success-stage button listeners attach inside the async
  // DOMContentLoaded handler (setupSendStage). `crisp_device_id_v2` is
  // generated in that handler immediately BEFORE the synchronous setup
  // block, so observing it from a later polling task guarantees the
  // listeners are wired — clicking earlier was a silent no-op (flake).
  await page.waitForFunction(
    () => typeof (window as any).__crispGoToStage === 'function'
       && typeof (window as any).state === 'object'
       && !!localStorage.getItem('crisp_device_id_v2'),
    null, { timeout: 8000 },
  );
}

test.describe('PWA success screen (PR 7, realigned to v323 redesign)', () => {
  test.beforeEach(async ({ page }) => { await openAppInEnglish(page); });

  test('My Reports from success with no submitted report shows the history empty state (no broken detail)', async ({ page }) => {
    // No device id is seeded, so _renderSubmittedReports takes the
    // no-deviceHash branch → first-time empty state. The PR 7 intent
    // survives: tapping the secondary CTA with nothing submitted must
    // never surface a "Report not found" detail view.
    await page.evaluate(() => (window as any).__crispGoToStage('stage-success'));
    await page.locator('#btn-success-my-reports').click();
    // openMyReports() navigates to the history screen…
    await expect(page.locator('#stage-history.active')).toBeVisible({ timeout: 5000 });
    // …and never to the report-detail stage.
    await expect(page.locator('#stage-report-detail.active')).toHaveCount(0);
    // The submitted list renders the guided empty state, not stale rows.
    await expect(page.locator('#history-synced-list .history-empty')).toBeVisible({ timeout: 5000 });
  });

  test('@smoke Add another report resets state and starts a fresh capture', async ({ page }) => {
    // Drive to success stage via the testability hook, then click the
    // primary CTA. Regression guard for a bug where a stale DOM lookup
    // (#photo-skip-link, removed in Phase 2) threw inside resetApp() and
    // stranded the user on stage-success — the click appeared to do
    // nothing because the exception short-circuited the stage change.
    await page.evaluate(() => {
      const s = (window as any).state;
      // Seed some "previous report" state that resetApp must clear.
      // Snake_case fields are the v4 authoritative names; the legacy
      // camelCase crisisType survives only as a nullable fallback.
      s.photoDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';
      s.description = 'Previous report description';
      s.crisis_type = 'WILDFIRE';
      s.crisisType = 'WILDFIRE';
      (window as any).__crispGoToStage('stage-success');
    });
    await expect(page.locator('#stage-success.active')).toBeVisible();

    // Tap the primary CTA.
    await page.locator('#btn-new-report').click();

    // HC79 — "Report another" routes to the v4 CAPTURE stage (not home)
    // so the user can immediately start a fresh flow. We must NOT stay
    // stranded on success.
    await expect(page.locator('#stage-v4-capture.active')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#stage-success.active')).toBeHidden();

    // State is cleaned — description, photo, crisis reset to defaults.
    const cleared = await page.evaluate(() => {
      const s = (window as any).state;
      return {
        photoDataUrl: s.photoDataUrl,
        description: s.description,
        crisis_type: s.crisis_type,
        crisisType: s.crisisType,
        extraPhotoCount: s.extraPhotos?.length,
        v4PhotoCount: s.v4Photos?.length,
      };
    });
    expect(cleared.photoDataUrl).toBeNull();
    expect(cleared.description).toBe('');
    // v6.7 reporter-blocking-fix (CLAUDE.md "Classifier-state field
    // naming") — reset is null-only for BOTH the snake_case v4 field
    // and the legacy camelCase fallback. Never a hardcoded 'FLOOD'-
    // style default (that was the root cause of misclassification on
    // every report). The 88-classifier-pick-roundtrip spec guards the
    // hardcoded-default regression specifically; the crisis-forms stub
    // in _fixtures keeps any active crisis-zone pack from re-applying
    // a crisis_type after the reset.
    expect(cleared.crisis_type).toBeNull();
    expect(cleared.crisisType).toBeNull();
    expect(cleared.extraPhotoCount).toBe(0);
    expect(cleared.v4PhotoCount).toBe(0);
  });

  test('My Reports from success after a submit renders the history screen (not a bare stage swap)', async ({ page }) => {
    // Seed the cache + last-submitted pointer via the testability hook. The
    // production path calls _synthesizeSubmittedReport() inside submitReport()
    // after the upload overlay flips to success; tests shortcut that so we
    // don't need a real network submission. (_synthesizeSubmittedReport
    // reads the legacy camelCase fields by design — it backfills rows for
    // pre-v6.7 queue entries.)
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
    await page.locator('#btn-success-my-reports').click();

    // v323 — the success-stage My Reports link calls openMyReports(),
    // which navigates to stage-history…
    await expect(page.locator('#stage-history.active')).toBeVisible({ timeout: 5000 });

    // …AND actually renders the lists. #history-submitted-section ships
    // hidden (display:none in index.html); every commit path through
    // _renderSubmittedReports unhides it. If a future refactor downgrades
    // the button to a bare goToStage('stage-history'), the section stays
    // hidden and this assertion fails — that's the PR 7 "must RENDER,
    // not just switch stages" intent, preserved.
    await expect(page.locator('#history-submitted-section')).toBeVisible({ timeout: 5000 });
  });
});
