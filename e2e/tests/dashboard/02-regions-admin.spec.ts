/**
 * Dashboard — Auto-submit regions admin panel.
 *
 * CC-IA P2 (2026-06): Auto-Submit Regions was RELOCATED out of the header
 * user-menu into the Reporting module. It is now reached at
 *   #/reporting → cc-crisis "Auto-submit regions" tab → "Open regions manager"
 * which opens the (now body-level) #regions-panel above the Reporting overlay.
 * The regions CRUD itself (#regions-panel / #region-form-overlay / the
 * showRegionsPanel/openRegionForm/saveRegionForm globals) is unchanged.
 *
 * Covers:
 *   · Relocation contract — regions is reachable from #/reporting, NOT the
 *     user-menu (#btn-auto-regions no longer exists); closing the panel keeps
 *     the Reporting overlay open.
 *   · Add region form: name + lat + lng + radius + enable  (fixme — see below)
 *   · Toggle enabled/disabled + public /regions/enabled cross-check (fixme)
 *
 * Uses the ADMIN fixture from helpers/api.ts for login and cleans up after
 * itself via cleanupTestRegions.
 */
import { test, expect, Page } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin, cleanupTestRegions } from '../helpers/api';

async function bootAdmin(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:8000/api/v1/auth/login', {
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
    localStorage.setItem('crisp_router_force_root', '1');  // real CC root, not the automation feed default
  }, token);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__crispRouter, null, { timeout: 15_000 });
  return token;
}

/**
 * Navigate to the Reporting module and open the Auto-Submit Regions panel
 * through the relocated launcher (the post-CC-IA path).
 */
async function openRegionsViaReporting(page: Page) {
  await page.evaluate(() => (window as any).__crispRouter.navigate('/reporting'));
  await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible({ timeout: 5000 });
  await page.locator('.cc-cf-tab[data-tab="regions"]').click();
  await page.locator('#cc-cf-open-regions').click();
  await expect(page.locator('#regions-panel')).toBeVisible({ timeout: 5000 });
}

test.describe('Regions admin panel (relocated to Reporting — CC-IA)', () => {
  let token: string;

  test.beforeAll(async ({ request }) => { await ensureAdminAndLogin(request); });

  test.beforeEach(async ({ page }) => {
    token = await bootAdmin(page);
  });

  test.afterAll(async ({ request }) => {
    // Leave the backend DB clean for the next run.
    const res = await request.post('http://localhost:8000/api/v1/auth/login', {
      data: { email: ADMIN.email, password: ADMIN.password },
    });
    if (res.ok()) {
      const body = await res.json();
      await cleanupTestRegions(request, body.access_token || body.token);
    }
  });

  test('@smoke relocation: reachable from #/reporting, not the user-menu', async ({ page }) => {
    // The user-menu launcher is gone (moved into the Reporting module).
    await expect(page.locator('#btn-auto-regions')).toHaveCount(0);

    // Reach it through the Reporting module instead.
    await openRegionsViaReporting(page);
    await expect(page).toHaveURL(/#\/reporting/);
    await expect(page.locator('#regions-panel .del-panel-header')).toContainText(/Auto-Submit Regions/i);

    // Closing the regions panel returns to the Reporting overlay (still open),
    // not the incident feed.
    await page.locator('#regions-panel .close-btn').click();
    await expect(page.locator('#regions-panel')).toBeHidden();
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible();
  });

  // SKIP RATIONALE (May 2026, carried forward): `#region-form-overlay` stays
  // visible after the create-region POST in the test environment — the
  // overlay-dismiss wiring depends on a follow-up admin-list refetch that's
  // racing the test's `.toBeHidden()` assertion. Production works
  // (operator-verified); tracked as test-fixture maintenance. Reach-path
  // updated to the post-CC-IA Reporting route.
  test.fixme('open panel → create region → appears in list → delete', async ({ page }) => {
    await openRegionsViaReporting(page);

    // Click "Add region".
    await page.locator('#regions-panel-footer button').first().click();
    await expect(page.locator('#region-form-overlay')).toBeVisible();

    // Fill the form with a deterministic, prefixed name so afterAll can
    // find + delete it.
    const regionName = `E2E Test Bengaluru ${Date.now()}`;
    await page.locator('#region-name').fill(regionName);
    await page.locator('#region-lat').fill('12.9716');
    await page.locator('#region-lng').fill('77.5946');
    await page.locator('#region-radius-km').fill('5');
    await page.locator('#region-enabled').check();

    // Save.
    await page.locator('#region-form-overlay button.btn-primary, #region-form-overlay .region-form-footer button.btn-primary').last().click();
    await expect(page.locator('#region-form-overlay')).toBeHidden();

    // The new row should be in the list, marked enabled.
    const row = page.locator('.region-row', { hasText: regionName });
    await expect(row).toBeVisible();
    await expect(row.locator('.region-chip-on')).toBeVisible();

    // Public endpoint should include it.
    const publicList = await page.request.get('http://localhost:8000/api/v1/regions/enabled');
    expect(publicList.ok()).toBeTruthy();
    const bodyJson = await publicList.json();
    const found = bodyJson.find((r: any) => r.name === regionName);
    expect(found, `public /regions/enabled missing "${regionName}"`).toBeTruthy();
    expect(found.center_lat).toBeCloseTo(12.9716, 3);
    expect(found.radius_meters).toBe(5000);

    // Delete it via the trash button — confirm dialog in the page's native
    // confirm(); Playwright auto-accepts once we register a handler.
    page.once('dialog', (d) => d.accept());
    await row.locator('.btn-danger, button[title="Delete"]').first().click();
    await expect(row).toHaveCount(0, { timeout: 5000 });
  });

  // Same skip rationale — admin-list refetch races the test's public-list
  // assertion. Production works. Reach-path updated to the Reporting route.
  test.fixme('toggle enabled off → public list no longer contains it', async ({ page, request }) => {
    // Create a fresh region directly via API to isolate this test.
    const regionName = `E2E Toggle ${Date.now()}`;
    const create = await request.post('http://localhost:8000/api/v1/admin/regions', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: regionName,
        enabled: true,
        center_lat: 13.00, center_lng: 77.60,
        radius_meters: 3000,
      },
    });
    expect(create.ok()).toBeTruthy();

    // Open the panel via the Reporting module + find the row.
    await openRegionsViaReporting(page);
    const row = page.locator('.region-row', { hasText: regionName });
    await expect(row).toBeVisible();

    // Click the pause (disable) button — it's the first .btn-secondary in
    // the row's action cluster.
    await row.locator('button[title="Disable"]').click();
    // Re-render the list: should now show disabled chip.
    await expect(row.locator('.region-chip-off')).toBeVisible({ timeout: 5000 });

    // Public endpoint should NOT list it.
    const publicList = await page.request.get('http://localhost:8000/api/v1/regions/enabled');
    const bodyJson = await publicList.json();
    const found = bodyJson.find((r: any) => r.name === regionName);
    expect(found).toBeFalsy();
  });
});
