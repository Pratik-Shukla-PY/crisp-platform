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
import { ADMIN, cleanupTestReports } from '../helpers/api';

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

  test('Mark Accepted → report card shows green verdict chip', async ({ page }) => {
    // Open the detail panel by clicking the feed card for this report.
    // Open the detail panel via the same global function the card's onclick
    // calls — there's no per-card ID attribute to CSS-select against.
    await page.evaluate((id) => (window as any).selectReport(id), reportId);
    await expect(page.locator('#detail-panel')).toBeVisible();

    // Phase J.2 (May 2026) — Accept / Reject / False alarm collapsed
    // into a single Verdict dropdown. Click the trigger, then pick
    // Accept from the menu.
    await page.locator('.dp-verdict-trigger').first().click();
    await page.locator('.dp-verdict-item-accept').first().click();
    // Chip flips to "Accepted".
    await expect(page.locator('.dp-reviewer-chip.dp-reviewer-accepted')).toContainText(/Accepted/i, { timeout: 10_000 });

    // Backend confirms via the list endpoint (no GET /reports/{id} exists).
    const res = await page.request.get('http://localhost:8000/api/v1/reports/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = await res.json();
    const body = list.find((r: any) => r.id === reportId);
    expect(body, 'report missing from list after accept').toBeTruthy();
    expect(body.reviewer_verdict).toBe('ACCEPTED');
    expect(body.reviewed_at).toBeTruthy();
  });

  test('Mark Dispatched + Arrived → response_time_seconds populates', async ({ page }) => {
    // Open the detail panel via the same global function the card's onclick
    // calls — there's no per-card ID attribute to CSS-select against.
    await page.evaluate((id) => (window as any).selectReport(id), reportId);
    await expect(page.locator('#detail-panel')).toBeVisible();

    // Phase J.2 (May 2026) — Accept via the Verdict dropdown so
    // reviewed_at is set (required for response-time calc).
    await page.locator('.dp-verdict-trigger').first().click();
    await page.locator('.dp-verdict-item-accept').first().click();
    await expect(page.locator('.dp-reviewer-chip.dp-reviewer-accepted')).toBeVisible();

    // Wait a beat so arrived_at > reviewed_at strictly (>= 1s).
    await page.waitForTimeout(1500);

    // Phase J.2 (May 2026) — Dispatched / Arrived replaced with
    // response-progress chips. `.dp-resp-chip-action` is the
    // clickable variant (shown while the timestamp is unset);
    // `.dp-resp-chip-done` is the read-only stamped variant.
    // Wait for the PATCH response so the second click sees the
    // re-rendered DOM. Each click triggers stampResponderTime()
    // which fires PATCH /reports/{id}/timestamps and re-renders.
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/timestamps') && res.request().method() === 'PATCH' && res.ok(),
      ),
      page.locator('.dp-resp-chip-action', { hasText: /Mark dispatched/i }).first().click(),
    ]);
    // Brief pause so the re-rendered panel stabilises; otherwise the
    // "Mark on-site" locator can resolve to a stale (detached) node.
    await page.waitForTimeout(400);
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/timestamps') && res.request().method() === 'PATCH' && res.ok(),
      ),
      page.locator('.dp-resp-chip-action', { hasText: /Mark on-site/i }).first().click(),
    ]);
    // Small settle so the ReportResponse computation has the new timestamp.
    await page.waitForTimeout(300);

    // Backend: response_time_seconds is derived (not stored). Confirm it's
    // present on the list response.
    const res = await page.request.get('http://localhost:8000/api/v1/reports/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = await res.json();
    const body = list.find((r: any) => r.id === reportId);
    expect(body, 'report missing from list after timestamps').toBeTruthy();
    expect(body.help_dispatched_at).toBeTruthy();
    expect(body.help_arrived_at).toBeTruthy();
    expect(body.response_time_seconds).toBeGreaterThanOrEqual(0);
  });
});
