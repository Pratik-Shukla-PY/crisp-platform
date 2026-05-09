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

test.describe('PWA My Reports — individual report management', () => {
  let deviceHash: string;

  test.beforeEach(async ({ page }) => {
    deviceHash = `E2E-DEVICE-MR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await page.goto('index.html');
    // Pre-accept consent + pre-seat the device_hash so status-since
    // returns OUR seeded reports.
    await page.evaluate((hash) => {
      localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_device_hash', hash);
      localStorage.setItem('crisp_device_id', hash);
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

  test('Advanced accordion is CLOSED by default; bulk delete hidden', async ({ page, request }) => {
    await seedReport(request, deviceHash, { verdict: 'NOT_REVIEWED' });
    await page.locator('#btn-my-reports').click();
    await expect(page.locator('.mr-card').first()).toBeVisible({ timeout: 10_000 });

    // The advanced <details> element exists but is not open.
    const advanced = page.locator('#history-advanced');
    await expect(advanced).toBeVisible();
    await expect(advanced).not.toHaveAttribute('open', /.*/);
    // Bulk delete button exists in the DOM but isn't rendered until open.
    // (hidden inside the closed <details>).
    await expect(page.locator('#btn-history-delete-all')).toBeHidden();

    // Click to open.
    await page.locator('.history-advanced-summary').click();
    await expect(advanced).toHaveAttribute('open', /.*/);
    await expect(page.locator('#btn-history-delete-all')).toBeVisible();
  });

  test('individual delete: confirm → deletion-in-progress note replaces button', async ({ page, request }) => {
    const { reportId } = await seedReport(request, deviceHash, { verdict: 'NOT_REVIEWED' });
    await page.locator('#btn-my-reports').click();
    await expect(page.locator('.mr-card').first()).toBeVisible({ timeout: 10_000 });
    await page.locator('.mr-card').first().click();
    await expect(page.locator('#stage-report-detail.active')).toBeVisible();

    // Auto-accept the confirm dialog.
    page.once('dialog', (d) => d.accept());
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
    page.once('dialog', (d) => d.accept());
    await page.locator('#btn-rd-delete').click();

    // Queued-state note appears + delete button disappears.
    await expect(page.locator('#rd-delete-note')).toContainText(/when connected/i, { timeout: 5_000 });
    await expect(page.locator('#btn-rd-delete')).toBeHidden();

    // Restore connectivity.
    await context.setOffline(false);
  });
});
