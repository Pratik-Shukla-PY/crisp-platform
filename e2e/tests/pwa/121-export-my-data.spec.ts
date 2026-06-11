/**
 * PWA "Export my data" — UNDP Privacy Policy Annex 2 (f) data-subject access
 * right (Jun 2026). Settings → Export my data downloads every report this
 * device submitted as a JSON file, fetched from the public
 * GET /reports/device/{hash} endpoint (no account needed).
 *
 * Seeds a report via the API on a known device hash, pre-seats that hash in
 * localStorage, opens Settings, taps Export, and asserts the downloaded JSON
 * envelope contains the seeded report.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { ensureAdminAndLogin } from '../helpers/api';

const BACKEND = process.env.CRISP_BACKEND_URL || 'http://localhost:8000';

async function seedReport(request: APIRequestContext, deviceHash: string, description: string) {
  const token = await ensureAdminAndLogin(request);
  const meta = await request.post(`${BACKEND}/api/v1/reports/meta`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      device_hash: deviceHash,
      client_report_id: `e2e-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'APP', severity: 'MODERATE',
      infrastructure_type: 'ROAD', crisis_type: 'FLOOD',
      damage_classification: 'PARTIAL', debris_clearing_needed: true,
      description, expected_media: 0,
      location: { latitude: 12.9716, longitude: 77.5946, accuracy_meters: 10, user_location_name: 'Bengaluru' },
    },
  });
  expect(meta.status(), `meta failed: ${await meta.text()}`).toBe(201);
  return (await meta.json()).id as string;
}

test.describe('PWA — Export my data (data-subject access right)', () => {
  let deviceHash: string;

  test.beforeEach(async ({ page }) => {
    deviceHash = `E2E-DEVICE-EXPORT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await page.goto('index.html');
    await page.evaluate((hash) => {
      localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_lang', 'en');
      localStorage.setItem('crisp_lang_manual', 'en');
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_device_id_v2', hash);
      localStorage.setItem('crisp_device_hash', hash);
      localStorage.setItem('crisp_device_id', hash);
    }, deviceHash);
    await page.reload();
    await page.waitForFunction(
      () => typeof (window as any).__crispGoToStage === 'function',
      null, { timeout: 8000 },
    );
  });

  test.afterEach(async ({ request }) => {
    if (deviceHash) await request.delete(`${BACKEND}/api/v1/reports/device/${deviceHash}`).catch(() => {});
  });

  test('downloads a JSON file containing the device reports', async ({ page, request }) => {
    const reportId = await seedReport(request, deviceHash, 'E2E export — road flooded.');

    await page.evaluate(() => (window as any).__crispGoToStage('stage-settings'));
    const exportBtn = page.locator('#btn-settings-export');
    await expect(exportBtn).toBeVisible();

    // Tap Export → capture the triggered download.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      exportBtn.click(),
    ]);

    // Filename is crisp-my-data-<date>.json.
    expect(download.suggestedFilename()).toMatch(/^crisp-my-data-\d{4}-\d{2}-\d{2}\.json$/);

    // Read + parse the downloaded JSON.
    const path = await download.path();
    expect(path).toBeTruthy();
    const fs = require('fs');
    const payload = JSON.parse(fs.readFileSync(path, 'utf8'));

    expect(payload.export_kind).toBe('crisp-my-data');
    expect(payload.device_hash).toBe(deviceHash);
    expect(payload.report_count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(payload.reports)).toBe(true);
    const ids = payload.reports.map((r: any) => r.id);
    expect(ids, 'seeded report must appear in the export').toContain(reportId);
  });

  test('shows an empty-state toast when the device has no reports', async ({ page }) => {
    // No seed — the device has nothing to export.
    await page.evaluate(() => (window as any).__crispGoToStage('stage-settings'));
    await page.locator('#btn-settings-export').click();
    // The empty-state toast surfaces (#toast-notification); no download.
    await expect(page.locator('#toast-notification')).toBeVisible({ timeout: 5000 });
  });
});
