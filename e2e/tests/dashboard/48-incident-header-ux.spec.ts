/**
 * Dashboard — Incident header UX dedup-2 (Jun 2026).
 *
 *  · UX-A: the status pill carries the age ("Needs review · {ago}"); the separate
 *    header time badge AND the "Waiting Xm" urgency chip are gone (one fact, once).
 *  · UX-B: the channel badge is the source entry-point — clicking it opens a popover
 *    (channel / Report ID / media / submitted); the standalone "Source Details"
 *    section is removed.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { ADMIN, cleanupTestReports } from '../helpers/api';

async function loginAsAdmin(page, request: APIRequestContext): Promise<string> {
  const res = await request.post('http://localhost:8000/api/v1/auth/login', { data: { email: ADMIN.email, password: ADMIN.password } });
  const token = (await res.json()).access_token;
  await page.goto('index.html');
  await page.evaluate((t) => { localStorage.setItem('crisp_token', t); localStorage.setItem('crisp_user', JSON.stringify({ email: 'e2e@crisp.test', role: 'SUPER_ADMIN', full_name: 'E2E' })); }, token);
  await page.reload();
  return token;
}

test.describe('Incident header UX (dedup-2)', () => {
  let token: string;
  let id: string;

  test.beforeEach(async ({ page, request }) => {
    token = await loginAsAdmin(page, request);
    const res = await request.post('http://localhost:8000/api/v1/reports/meta', {
      headers: { Authorization: `Bearer ${token}` },
      data: { device_hash: `E2E-UX-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, client_report_id: `e2e-ux-${Date.now()}`,
        source: 'TELEGRAM', severity: 'SEVERE', infrastructure_type: 'COMMERCIAL', crisis_type: 'FLOOD',
        damage_classification: 'COMPLETE', description: 'header ux test', expected_media: 0,
        location: { latitude: 12.85, longitude: 77.67, accuracy_meters: 12 } },
    });
    id = (await res.json()).id;
    await expect.poll(async () => { await page.evaluate(() => (window as any).__crispFetchReports && (window as any).__crispFetchReports()).catch(() => {}); return page.evaluate((rid) => Array.isArray((window as any).allReports) && (window as any).allReports.some((r: any) => r.id === rid), id); }, { timeout: 20_000, intervals: [500, 1000, 2000] }).toBe(true);
    await page.evaluate((rid) => (window as any).selectReport(rid), id);
    await expect(page.locator('#detail-panel')).toBeVisible();
  });

  test.afterEach(async ({ request }) => { await cleanupTestReports(request, token); });

  test('UX-A: status pill carries the age; no separate time badge or Waiting chip', async ({ page }) => {
    await expect(page.locator('#detail-panel .dp-display-status')).toContainText(/Needs review ·/);
    await expect(page.locator('#detail-panel .dp-time-badge')).toHaveCount(0);
    // the "Waiting Xm" urgency chip no longer exists anywhere in the panel
    await expect(page.locator('#detail-panel')).not.toContainText(/Waiting \d/);
  });

  test('UX-B: channel badge opens the source popover; no standalone Source Details', async ({ page }) => {
    await expect(page.locator('#detail-panel .dp-source-details')).toHaveCount(0);
    await expect(page.locator('#detail-panel .dp-src-pop.open')).toHaveCount(0);
    await page.locator('#detail-panel .dp-source-badge').click();
    await expect(page.locator('#detail-panel .dp-src-pop.open')).toBeVisible();
    await expect(page.locator('#detail-panel .dp-src-pop.open')).toContainText(/Channel/);
    await expect(page.locator('#detail-panel .dp-src-pop.open')).toContainText(/Report ID/);
  });
});
