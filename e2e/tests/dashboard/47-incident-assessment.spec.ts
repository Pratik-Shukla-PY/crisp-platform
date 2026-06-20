/**
 * Dashboard — Report Assessment redesign (Jun 2026).
 *
 * The Report Assessment section is now a SINGLE, system-only Confidence Score:
 *   · Before assessment → one primary CTA ("AI-Assisted Report Assessment"),
 *     no fabricated number, no scattered per-check buttons.
 *   · The score is the SYSTEM's automated assessment only — a human accept/reject
 *     verdict deliberately does NOT change it (that is the operational status).
 *   · Once scored, the Confidence Score is clickable → a per-check breakdown modal
 *     (each check: ran?, points awarded / max, evidence) + the exact calculation
 *     and the methodology — fully explainable / auditable.
 *
 * Seeds reports via the API (same approach as 03-reviewer-workflow) and opens
 * the panel via the global selectReport() the card onclick calls.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { ADMIN, cleanupTestReports, roleFromToken, ADMIN_ROLES } from '../helpers/api';

const NEEDS_TESTING_FLAG =
  'Backend not in CRISP_TESTING mode — /auth/register did not honor the admin role. '
  + 'Run the e2e backend with `APP_ENV=dev CRISP_TESTING=1`.';

async function seedReport(request: APIRequestContext, token: string, deviceHash: string): Promise<string> {
  const res = await request.post('http://localhost:8000/api/v1/reports/meta', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      device_hash: deviceHash,
      client_report_id: `e2e-assess-${Date.now()}`,
      source: 'TELEGRAM',
      severity: 'MODERATE',
      infrastructure_type: 'ROAD',
      crisis_type: 'FLOOD',
      damage_classification: 'PARTIAL',
      description: 'E2E report-assessment test report',
      expected_media: 0,
      location: { latitude: 12.97, longitude: 77.59, accuracy_meters: 10 },
    },
  });
  expect(res.ok(), `seed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()).id;
}

async function loginAsAdmin(page, request: APIRequestContext): Promise<string> {
  const res = await request.post('http://localhost:8000/api/v1/auth/login', {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  const body = await res.json();
  const token = body.access_token || body.token;
  await page.goto('index.html');
  await page.evaluate((t) => {
    localStorage.setItem('crisp_token', t);
    localStorage.setItem('crisp_user', JSON.stringify({
      email: 'e2e-admin@crisp.test', role: 'SUPER_ADMIN', full_name: 'E2E Admin',
    }));
  }, token);
  await page.reload();
  return token;
}

test.describe('Report Assessment — single system-only Confidence Score', () => {
  let token: string;
  let reportId: string;

  test.beforeEach(async ({ page, request }) => {
    token = await loginAsAdmin(page, request);
    const deviceHash = `E2E-ASSESS-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    reportId = await seedReport(request, token, deviceHash);
    await expect.poll(async () => {
      await page.evaluate(() =>
        (window as any).__crispFetchReports && (window as any).__crispFetchReports()).catch(() => {});
      return page.evaluate((id) => {
        const arr = (window as any).allReports;
        return Array.isArray(arr) && arr.some((r: any) => r.id === id);
      }, reportId);
    }, { timeout: 20_000, intervals: [500, 1000, 2000] }).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestReports(request, token);
  });

  test('one Assessment + the single AI-Assisted CTA; no old credibility button; ONE status pill; identity-only header', async ({ page }) => {
    await page.evaluate((id) => (window as any).selectReport(id), reportId);
    await expect(page.locator('#detail-panel')).toBeVisible();

    // Exactly ONE assessment section — credibility has one home.
    await expect(page.locator('.dp-assess')).toHaveCount(1);
    // The old scattered "Credibility Check" / per-check run buttons are gone.
    await expect(page.locator('.dp-run-ai-btn')).toHaveCount(0);
    await expect(page.locator('.dp-assess-run-btn')).toHaveCount(0);
    // One primary CTA runs every automated check.
    await expect(page.locator('.dp-assess .dp-assess-cta')).toHaveText(/AI-Assisted Report Assessment/i);

    // ONE combined status pill — the operational status and the review verdict
    // are merged (the old "PENDING" + "Not reviewed" dual pills are gone).
    await expect(page.locator('#detail-panel .dp-display-status')).toHaveCount(1);
    await expect(page.locator('#detail-panel .dp-display-status')).toContainText(/Needs review/i);
    await expect(page.locator('#detail-panel .dp-verdict-badge')).toHaveCount(0);

    // Dedup pass: the duplicate headline is GONE entirely; coords live once in the
    // single Location & Building section.
    await expect(page.locator('#detail-panel .dp-headline')).toHaveCount(0);
    await expect(page.locator('#detail-panel .dp-loc-card .dp-loc-coordval')).toBeVisible();
  });

  test('unchecked report is UNVERIFIED — the CTA, never a fabricated number', async ({ page }) => {
    await page.evaluate((id) => (window as any).selectReport(id), reportId);
    await expect(page.locator('#detail-panel')).toBeVisible();

    // Backend confirms the computed field suppresses the score.
    const res = await page.request.get('http://localhost:8000/api/v1/reports/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()).find((r: any) => r.id === reportId);
    expect(body.incident_credibility).toBeTruthy();
    expect(body.incident_credibility.band).toBe('UNVERIFIED');
    expect(body.incident_credibility.score).toBeNull();
    expect(body.incident_credibility.assessed).toBe(false);

    // The card shows the CTA, not a score dial — no fake number anywhere.
    await expect(page.locator('.dp-assess.dp-assess-cta-state')).toBeVisible();
    await expect(page.locator('.dp-assess .dp-assess-num')).toHaveCount(0);
  });

  test('a human ACCEPTED verdict does NOT change the system Confidence Score', async ({ page }) => {
    test.skip(!ADMIN_ROLES.includes(roleFromToken(token)), NEEDS_TESTING_FLAG);

    const rev = await page.request.patch(`http://localhost:8000/api/v1/reports/${reportId}/review`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { verdict: 'ACCEPTED' },
    });
    expect(rev.ok(), `review failed: ${rev.status()} ${await rev.text()}`).toBeTruthy();
    const reviewed = await rev.json();
    // The Confidence Score is the system's automated assessment ONLY — a human
    // verdict must leave it untouched (still unverified, since no AI/satellite ran).
    expect(reviewed.incident_credibility.band).toBe('UNVERIFIED');
    expect(reviewed.incident_credibility.score).toBeNull();
    expect(reviewed.incident_credibility.assessed).toBe(false);
    // The verdict shape must NOT leak a score override field any more.
    expect(reviewed.incident_credibility.override).toBeUndefined();
    // Reviewer identity is persisted.
    expect(reviewed.reviewed_by).toBeTruthy();

    // Re-open the panel: still the CTA (no number), while the status pill reads Accepted.
    await page.evaluate(() =>
      (window as any).__crispFetchReports && (window as any).__crispFetchReports()).catch(() => {});
    await page.evaluate((id) => (window as any).selectReport(id), reportId);
    await expect(page.locator('.dp-assess.dp-assess-cta-state')).toBeVisible();
    await expect(page.locator('.dp-assess .dp-assess-num')).toHaveCount(0);
    await expect(page.locator('#detail-panel .dp-display-status')).toContainText(/Accepted/i);
  });

  test('a scored report shows a clickable Confidence Score → explainable breakdown modal', async ({ page }) => {
    // Drive the render with a synthetic assessed `incident_credibility` (the
    // additive shape the backend produces). This exercises the score display +
    // breakdown modal deterministically, without a live AI/satellite call.
    await page.evaluate((id) => {
      const arr = (window as any).allReports;
      const r = arr.find((x: any) => x.id === id);
      r.incident_credibility = {
        score: 76, band: 'LIKELY', assessed: true, max_score: 100,
        ran_count: 4, total_checks: 5,
        reasons: ['AI content analysis +24', 'Location & metadata +15', 'Satellite imagery correlation +15'],
        factors: [
          { key: 'ai', label: 'AI content analysis', max: 30, ran: true, awarded: 24, reason: 'AI confidence 80/100 — debris consistent with the report.' },
          { key: 'satellite', label: 'Satellite imagery correlation', max: 25, ran: true, awarded: 15, reason: 'Satellite score 60/100 — recent imagery cross-checked.' },
          { key: 'location', label: 'Location & metadata', max: 15, ran: true, awarded: 15, reason: 'Precise GPS fix (±10 m).' },
          { key: 'corroboration', label: 'Corroboration & duplicate detection', max: 15, ran: true, awarded: 12, reason: '2 corroborating reports confirmed nearby.' },
          { key: 'reporter', label: 'Reporter credibility', max: 15, ran: false, awarded: 0, reason: 'No reporter history yet.' },
        ],
      };
      (window as any).selectReport(id);
    }, reportId);

    // Score dial renders the number + band, in the LIKELY colour band.
    await expect(page.locator('.dp-assess.dp-assess-scored')).toBeVisible();
    await expect(page.locator('.dp-assess .dp-assess-num')).toHaveText('76');
    await expect(page.locator('.dp-assess')).toHaveClass(/dp-cred-likely/);
    // Card shows a contributor checklist (one chip per check, 4 ran-with-points).
    await expect(page.locator('.dp-assess-contribs .dp-contrib')).toHaveCount(5);
    await expect(page.locator('.dp-assess-contribs .dp-contrib-ok')).toHaveCount(4);
    // Re-run lives in the breakdown workspace, not on the card.
    await expect(page.locator('.dp-assess .dp-assess-rerun')).toHaveCount(0);

    // Click the score → the investigative workspace opens (5 sections).
    await page.locator('.dp-assess-scorerow').click();
    await expect(page.locator('.assess-modal.assess-workspace')).toBeVisible();
    await expect(page.locator('.assess-head-num')).toHaveText('76');
    // The modal's sticky header carries the "Re-run assessment" action.
    await expect(page.locator('.assess-modal .assess-rerun-top')).toBeVisible();
    await expect(page.locator('.assess-modal .assess-sec')).toHaveCount(5);
    // Section 1 - all five checks listed (one skipped) + the exact equation.
    await expect(page.locator('.assess-factor')).toHaveCount(5);
    await expect(page.locator('.assess-factor-skip')).toHaveCount(1);
    await expect(page.locator('.assess-eq-total')).toHaveText('76');
    await expect(page.locator('.assess-method')).toContainText(/automated assessment only/i);

    // Escape closes it.
    await page.keyboard.press('Escape');
    await expect(page.locator('.assess-modal')).toHaveCount(0);
  });

  test('reopening the breakdown reuses the cached result — never asks to re-run (cache-reopen bug)', async ({ page }) => {
    // Assess (synthetic), open the breakdown once (populates the cache), close it.
    await page.evaluate((id) => {
      const r = (window as any).allReports.find((x: any) => x.id === id);
      r.incident_credibility = {
        score: 82, band: 'VERIFIED', assessed: true, max_score: 100, ran_count: 4, total_checks: 5,
        reasons: [], factors: [
          { key: 'ai', label: 'AI content analysis', max: 30, ran: true, awarded: 26, reason: 'x' },
          { key: 'satellite', label: 'Satellite imagery correlation', max: 25, ran: true, awarded: 20, reason: 'x' },
          { key: 'location', label: 'Location & metadata', max: 15, ran: true, awarded: 15, reason: 'x' },
          { key: 'corroboration', label: 'Corroboration & duplicate detection', max: 15, ran: true, awarded: 15, reason: 'x' },
          { key: 'reporter', label: 'Reporter credibility', max: 15, ran: false, awarded: 0, reason: 'x' },
        ],
      };
      (window as any).selectReport(id);
    }, reportId);
    await page.locator('.dp-assess-scorerow').click();
    await expect(page.locator('.assess-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.assess-modal')).toHaveCount(0);

    // Simulate a background poll that serialized incident_credibility as null
    // (the exact bug trigger), then re-render the card from the now-null object.
    await page.evaluate((id) => {
      const r = (window as any).allReports.find((x: any) => x.id === id);
      r.incident_credibility = null;
      (window as any).selectReport(id);
    }, reportId);

    // The card still shows the cached score (NOT the "run it again" CTA).
    await expect(page.locator('.dp-assess.dp-assess-scored')).toBeVisible();
    await expect(page.locator('.dp-assess .dp-assess-num')).toHaveText('82');
    await expect(page.locator('.dp-assess-cta')).toHaveCount(0);

    // Reopening the breakdown reuses the cached result — it opens, no info-toast.
    await page.locator('.dp-assess-scorerow').click();
    await expect(page.locator('.assess-modal')).toBeVisible();
    await expect(page.locator('.assess-head-num')).toHaveText('82');
  });

  test('satellite analysis lives in the breakdown workspace, not the Evidence section', async ({ page }) => {
    await page.evaluate((id) => {
      const r = (window as any).allReports.find((x: any) => x.id === id);
      r.verification = {
        total_score: 60, verdict: 'PARTIALLY_VERIFIED',
        scores: { location_authenticity: 15, damage_corroboration: 12, description_coherence: 18, data_quality: 15 },
        reasoning: 'Overhead imagery is consistent with the reported flooding.',
        satellite_acquisition_date: '2026-06-18', satellite_days_gap: -2,
      };
      r.incident_credibility = {
        score: 70, band: 'LIKELY', assessed: true, max_score: 100, ran_count: 4, total_checks: 5,
        reasons: [], factors: [
          { key: 'ai', label: 'AI content analysis', max: 30, ran: true, awarded: 21, reason: 'x' },
          { key: 'satellite', label: 'Satellite imagery correlation', max: 25, ran: true, awarded: 15, reason: 'x' },
          { key: 'location', label: 'Location & metadata', max: 15, ran: true, awarded: 15, reason: 'x' },
          { key: 'corroboration', label: 'Corroboration & duplicate detection', max: 15, ran: true, awarded: 6, reason: 'x' },
          { key: 'reporter', label: 'Reporter credibility', max: 15, ran: false, awarded: 0, reason: 'x' },
        ],
      };
      (window as any).selectReport(id);
    }, reportId);

    // The Evidence/detail panel no longer renders the satellite gauge or toggle.
    await expect(page.locator('#detail-panel .dp-sat-result')).toHaveCount(0);
    await expect(page.locator('#detail-panel .dp-view-toggle')).toHaveCount(0);

    // The satellite analysis is embedded in the breakdown workspace instead.
    await page.locator('.dp-assess-scorerow').click();
    await expect(page.locator('.assess-modal')).toBeVisible();
    await expect(page.locator('.assess-sat-head')).toBeVisible();
    await expect(page.locator('.assess-sat-head .assess-sat-score')).toContainText('60');
    await expect(page.locator('.assess-subscores .assess-subscore')).toHaveCount(4);
  });
});
