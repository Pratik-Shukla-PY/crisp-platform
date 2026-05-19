/**
 * PWA My Reports — Apr 2026 "individual report management" spec.
 *
 * Covers:
 *   · List card rendering: thumbnail / location / date / color-coded status
 *   · Status mapping (Submitted / Under Review / Accepted / Rejected)
 *   · Detail view opens on card tap
 *   · Timeline shows 4 steps with correct done/upcoming state
 *   · Individual delete flow: confirmation → soft-delete → "Deletion in progress"
 *   · Offline delete queue: simulate offline → delete → "Will be deleted when connected"
 *   · Advanced accordion: bulk "Delete all my reports" is hidden by default
 *
 * Uses the same seed-via-API approach as the dashboard specs so tests are
 * deterministic + don't depend on the capture flow succeeding.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

const BACKEND = process.env.CRISP_BACKEND_URL || 'http://localhost:8000';

async function seedReport(request: APIRequestContext, deviceHash: string, opts: {
  verdict?: 'NOT_REVIEWED' | 'ACCEPTED' | 'REJECTED',
  actionTaken?: string,
  description?: string,
} = {}) {
  const token = await ensureAdminAndLogin(request);
  const meta = await request.post(`${BACKEND}/api/v1/reports/meta`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      device_hash: deviceHash,
      client_report_id: `e2e-mr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'APP',
      severity: 'MODERATE',
      infrastructure_type: 'ROAD',
      crisis_type: 'FLOOD',
      damage_classification: 'PARTIAL',
      description: opts.description || 'E2E My Reports test — road flooded, 2 injured.',
      expected_media: 0,
      location: { latitude: 12.9716, longitude: 77.5946, accuracy_meters: 10, user_location_name: 'Bengaluru' },
    },
  });
  expect(meta.status(), `meta failed: ${await meta.text()}`).toBe(201);
  const reportId = (await meta.json()).id;
  if (opts.verdict && opts.verdict !== 'NOT_REVIEWED') {
    const payload: any = { verdict: opts.verdict };
    if (opts.actionTaken) payload.action_taken = opts.actionTaken;
    else if (opts.verdict === 'REJECTED') payload.action_taken = 'Duplicate report.';
    await request.patch(`${BACKEND}/api/v1/reports/${reportId}/review`, {
      headers: { Authorization: `Bearer ${token}` },
      data: payload,
    });
  }
  return { reportId, token };
}

async function cleanup(request: APIRequestContext, deviceHash: string) {
  await request.delete(`${BACKEND}/api/v1/reports/device/${deviceHash}`).catch(() => {});
}

// not found after `#btn-my-reports` click. Root cause is more complex
// than a selector rename: the page snapshot at failure time shows both
// home stage AND stage-v4-capture banner stacked, which means the
// stage-machine transition isn't completing cleanly. The seeded device
// (E2E-DEVICE-MR-*) is set in localStorage as crisp_device_id_v2 but
// the my-reports `status-since` fetch returns 0 cards — possibly because
// of v6.8's navigation-stack changes or the new `<details>` accordion
// renderer waiting for a bucket toggle.
//
// Each of the 6 tests needs per-test investigation (state setup +
// timing + fetch reconciliation). Deferred to a focused triage session.
// Unskip when 03a-my-reports-v6.8-rewrite.spec.ts ships OR when the
// underlying state-machine issue is identified.
//
// The my-reports FEATURE works in operator-smoke testing (proven via
// the user's real PWA submission earlier this session — submitted
// report 32bb7e58 landed on dashboard correctly). Only the e2e
// fixture path is broken.
test.describe('PWA My Reports — individual report management', () => {
  let deviceHash: string;

  test.beforeEach(async ({ page }) => {
    deviceHash = `E2E-DEVICE-MR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await page.goto('index.html');
    // Pre-accept consent + pre-seat the device_hash so status-since
    // returns OUR seeded reports.
    // Phase F triage (May 2026) — Batch B's device-id refactor uses
    // `crisp_device_id_v2` as the PRIMARY key (mobile-app/src/app.js:318,
    // 355, 7943, 9294). The legacy `crisp_device_hash` / `crisp_device_id`
    // are only read by ONE function as defensive fallbacks (app.js:3603-
    // 3605); my-reports' status-since fetch reads ONLY v2. Pre-fix the
    // test set the legacy keys → my-reports got a different (auto-
    // generated) device_hash → 0 cards rendered → `.mr-card` not found.
    // Set v2 too so my-reports queries match the seeded report.
    // The `crisp_ui_v4='off'` line is now a no-op (UI_V3_ENABLED is
    // hardcoded false at app.js:39) but harmless; left for legibility.
    await page.evaluate((hash) => {
      localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      // Force English so status-chip + label assertions match — the
      // Bengaluru GPS fixture in playwright.config.ts otherwise auto-
      // detects Kannada and "Submitted" renders as "ಸಲ್ಲಿಸಲಾಗಿದೆ".
      localStorage.setItem('crisp_lang', 'en');
      localStorage.setItem('crisp_lang_manual', 'en');
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');
      localStorage.setItem('crisp_device_id_v2', hash);  // PRIMARY (v6.8+)
      localStorage.setItem('crisp_device_hash', hash);   // legacy fallback
      localStorage.setItem('crisp_device_id', hash);     // legacy fallback
    }, deviceHash);
    await page.reload();
    const enBtn = page.locator('#btn-lang-en');
    if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
  });

  test.afterEach(async ({ request }) => {
    if (deviceHash) await cleanup(request, deviceHash);
  });

  test('list card shows thumbnail placeholder + location + date + status chip', async ({ page, request }) => {
    await seedReport(request, deviceHash, { verdict: 'NOT_REVIEWED' });
    await page.locator('#btn-my-reports').click();
    await expect(page.locator('#stage-history.active')).toBeVisible();

    // Card renders with our seeded report (may need a moment for the fetch).
    const card = page.locator('.mr-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    // Location shows "Bengaluru" (seeded).
    await expect(card).toContainText(/Bengaluru/i);
    // Status chip is "Submitted" (grey) since verdict=NOT_REVIEWED.
    await expect(card.locator('.mr-status-chip')).toContainText(/Submitted/i);
    await expect(card.locator('.mr-status-submitted')).toBeVisible();
  });

  test('ACCEPTED report shows green chip and opens detail with feedback block', async ({ page, request }) => {
    await seedReport(request, deviceHash, { verdict: 'ACCEPTED' });
    await page.locator('#btn-my-reports').click();
    const card = page.locator('.mr-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('.mr-status-accepted')).toBeVisible();
    await expect(card).toContainText(/Accepted/i);

    // Tap card → detail stage.
    await card.click();
    await expect(page.locator('#stage-report-detail.active')).toBeVisible();
    // Feedback block renders green.
    await expect(page.locator('#rd-feedback')).toBeVisible();
    await expect(page.locator('#rd-feedback-title')).toContainText(/helped respond/i);
    // Timeline: Submitted + Under Review + Accepted all done.
    await expect(page.locator('.rd-tl-step.rd-tl-done')).toHaveCount(3, { timeout: 5_000 });
  });

  test('REJECTED report shows red chip, rejection reason visible, no Help Sent step', async ({ page, request }) => {
    await seedReport(request, deviceHash, { verdict: 'REJECTED', actionTaken: 'Possible duplicate submission.' });
    await page.locator('#btn-my-reports').click();
    const card = page.locator('.mr-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('.mr-status-rejected')).toBeVisible();
    await card.click();
    await expect(page.locator('#stage-report-detail.active')).toBeVisible();
    await expect(page.locator('#rd-rejection')).toBeVisible();
    await expect(page.locator('#rd-rejection-text')).toContainText(/duplicate/i);
    // Feedback (green) is hidden for rejected reports.
    await expect(page.locator('#rd-feedback')).toBeHidden();
  });

  // Phase F triage (May 2026) — #history-advanced accordion deleted.
  // Bulk "Delete all my reports" relocated to the Settings stage (see
  // index.html:2772) — same #btn-history-delete-all id so the existing
  // app.js handler still works. New assertion: from stage-history the
  // button is NOT directly visible; it lives behind the Settings entry.
  test('bulk delete moved to Settings (not on stage-history)', async ({ page, request }) => {
    await seedReport(request, deviceHash, { verdict: 'NOT_REVIEWED' });
    await page.locator('#btn-my-reports').click();
    await expect(page.locator('.mr-card').first()).toBeVisible({ timeout: 10_000 });

    // Bulk delete is NOT inside stage-history; it sits in stage-settings.
    const stageHistory = page.locator('#stage-history');
    await expect(stageHistory.locator('#btn-history-delete-all')).toHaveCount(0);

    // But the button DOES exist somewhere in the document (settings stage).
    await expect(page.locator('#btn-history-delete-all')).toHaveCount(1);
  });

  test('individual delete: confirm → deletion-in-progress note replaces button', async ({ page, request }) => {
    const { reportId } = await seedReport(request, deviceHash, { verdict: 'NOT_REVIEWED' });
    await page.locator('#btn-my-reports').click();
    await expect(page.locator('.mr-card').first()).toBeVisible({ timeout: 10_000 });
    await page.locator('.mr-card').first().click();
    await expect(page.locator('#stage-report-detail.active')).toBeVisible();

    // PWA uses crispConfirm (custom modal), not window.confirm. The
    // `page.on('dialog', ...)` handler only catches browser-native
    // dialogs; mock the custom helper to auto-accept instead.
    await page.evaluate(() => {
      (window as any).crispConfirm = async () => true;
    });
    await page.locator('#btn-rd-delete').click();

    // Button flips to the "Deletion in progress" note.
    await expect(page.locator('#rd-delete-note')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#btn-rd-delete')).toBeHidden();

    // The backend side-effect is covered by the backend-lifecycle spec;
    // here we just need to prove the UI flipped to the expected state.
  });

  test('offline delete queues + renders "Will be deleted when connected"', async ({ page, request, context }) => {
    await seedReport(request, deviceHash, { verdict: 'NOT_REVIEWED' });
    await page.locator('#btn-my-reports').click();
    await expect(page.locator('.mr-card').first()).toBeVisible({ timeout: 10_000 });
    await page.locator('.mr-card').first().click();
    await expect(page.locator('#stage-report-detail.active')).toBeVisible();

    // Simulate offline: toggle the browser context before tapping Delete.
    await context.setOffline(true);
    // PWA uses crispConfirm (custom modal), not window.confirm — see prior test.
    await page.evaluate(() => {
      (window as any).crispConfirm = async () => true;
    });
    await page.locator('#btn-rd-delete').click();

    // Queued-state note appears + delete button disappears.
    await expect(page.locator('#rd-delete-note')).toContainText(/when connected/i, { timeout: 5_000 });
    await expect(page.locator('#btn-rd-delete')).toBeHidden();

    // Restore connectivity.
    await context.setOffline(false);
  });
});
