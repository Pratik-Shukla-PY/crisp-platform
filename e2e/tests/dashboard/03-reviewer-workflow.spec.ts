/**
 * Dashboard — Reviewer workflow + tier switcher (Apr 2026 Phases 2 + 5).
 *
 * Seeds a report directly via the API (so we don't depend on the mobile
 * capture flow landing deterministically), opens the detail panel, and
 * exercises the reviewer actions + the image-variant switcher.
 *
 * Tests:
 *   · Detail panel opens when a report is clicked
 *   · "Mark Accepted" sets reviewer_verdict=ACCEPTED + reviewed_at
 *   · "Mark Rejected" requires action_taken text (modal / prompt)
 *   · Dispatched / Arrived timestamp buttons stamp responder_at fields
 *   · response_time_seconds appears when both timestamps are set
 *   · Tier switcher shows 3 buttons (SMALL / MEDIUM / LARGE) when a
 *     photo has 3 variants; buttons update data-current-tier
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
      client_report_id: `e2e-${Date.now()}`,
      source: 'APP',
      severity: 'MODERATE',
      infrastructure_type: 'ROAD',
      crisis_type: 'FLOOD',
      damage_classification: 'PARTIAL',
      description: 'E2E reviewer-workflow test report',
      expected_media: 0,
      location: { latitude: 12.97, longitude: 77.59, accuracy_meters: 10 },
    },
  });
  expect(res.ok(), `seed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  return body.id;
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

test.describe('Reviewer workflow', () => {
  let token: string;
  let deviceHash: string;
  let reportId: string;

  test.beforeEach(async ({ page, request }) => {
    token = await loginAsAdmin(page, request);
    deviceHash = `E2E-DEVICE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    reportId = await seedReport(request, token, deviceHash);
    // Force an immediate fetchReports() via the test-only hook exposed
    // on window.__crispFetchReports (see web-dashboard/src/app.js).
    // Then poll window.allReports (readable getter on the module-scope
    // variable) until the seeded ID shows up.
    await expect.poll(
      async () => {
        await page.evaluate(() =>
          (window as any).__crispFetchReports && (window as any).__crispFetchReports()
        ).catch(() => {});
        return page.evaluate((id) => {
          const arr = (window as any).allReports;
          return Array.isArray(arr) && arr.some((r: any) => r.id === id);
        }, reportId);
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    ).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestReports(request, token);
  });

  // Un-skipped (Jun 2026): /auth/register now HONORS the requested role when the
  // backend runs with CRISP_TESTING=1 (double-gated on non-prod), so
  // ensureAdminAndLogin (which already requests SUPER_ADMIN) yields an admin JWT
  // and /reports/{id}/review no longer 403s. Run the e2e backend with
  // `APP_ENV=dev CRISP_TESTING=1`.
  // Jun 2026: the Actions section was simplified to Notify Response Team +
  // Reject + Delete - the Accept/verdict dropdown + Mark dispatched/on-site chips
  // were dropped from the panel UI for least cognitive load. The /review +
  // /timestamps endpoints remain (used elsewhere), so these now assert the
  // backend behaviour directly.
  test('Accept verdict (API) → reviewer_verdict ACCEPTED + reviewed_at', async ({ page }) => {
    test.skip(!ADMIN_ROLES.includes(roleFromToken(token)), NEEDS_TESTING_FLAG);
    const rev = await page.request.patch(`http://localhost:8000/api/v1/reports/${reportId}/review`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { verdict: 'ACCEPTED' },
    });
    expect(rev.ok(), `review failed: ${rev.status()}`).toBeTruthy();
    const res = await page.request.get('http://localhost:8000/api/v1/reports/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()).find((r: any) => r.id === reportId);
    expect(body, 'report missing from list after accept').toBeTruthy();
    expect(body.reviewer_verdict).toBe('ACCEPTED');
    expect(body.reviewed_at).toBeTruthy();
  });

  test('Dispatched + Arrived (API) → response_time_seconds populates', async ({ page }) => {
    test.skip(!ADMIN_ROLES.includes(roleFromToken(token)), NEEDS_TESTING_FLAG);
    const H = { Authorization: `Bearer ${token}` };
    await page.request.patch(`http://localhost:8000/api/v1/reports/${reportId}/review`, { headers: H, data: { verdict: 'ACCEPTED' } });
    await page.waitForTimeout(1200);   // arrived_at strictly after reviewed_at
    await page.request.patch(`http://localhost:8000/api/v1/reports/${reportId}/timestamps`, { headers: H, data: { stamp_dispatched_now: true } });
    await page.request.patch(`http://localhost:8000/api/v1/reports/${reportId}/timestamps`, { headers: H, data: { stamp_arrived_now: true } });
    const res = await page.request.get('http://localhost:8000/api/v1/reports/', { headers: H });
    const body = (await res.json()).find((r: any) => r.id === reportId);
    expect(body, 'report missing from list after timestamps').toBeTruthy();
    expect(body.help_dispatched_at).toBeTruthy();
    expect(body.help_arrived_at).toBeTruthy();
    expect(body.response_time_seconds).toBeGreaterThanOrEqual(0);
  });
});
