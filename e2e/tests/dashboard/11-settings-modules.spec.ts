/**
 * Dashboard — Account + Organisation Settings modules (B6).
 *
 * cc-settings.js mounts two self-contained overlays launched from the user
 * menu (and from the B7 Control-Center cards) via window.openAccountSettings /
 * window.openOrgSettings. These tests authenticate, open each overlay, and
 * exercise the real flows against the live backend (profile load, org branding
 * round-trip, channels, sessions, users).
 */
import { test, expect, Page } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

async function bootAuthed(page: Page) {
  const token = await (async () => {
    const req = await page.request.post('http://localhost:8000/api/v1/auth/login', {
      data: { email: ADMIN.email, password: ADMIN.password },
    });
    const body = await req.json();
    return body.access_token || body.token;
  })();
  await page.goto('index.html');
  await page.evaluate((t) => {
    localStorage.setItem('crisp_token', t);
    localStorage.setItem('crisp_user', JSON.stringify({
      email: 'e2e-admin@crisp.test', role: 'SUPER_ADMIN', full_name: 'E2E Admin',
    }));
  }, token);
  await page.reload();
  await page.waitForFunction(
    () => typeof (window as any).openAccountSettings === 'function'
       && typeof (window as any).openOrgSettings === 'function',
    null, { timeout: 15_000 });
}

test.describe('Dashboard — settings modules (B6)', () => {
  test.beforeAll(async ({ request }) => { await ensureAdminAndLogin(request); });

  test('@smoke Account settings: opens, profile loads, tabs present', async ({ page }) => {
    await bootAuthed(page);
    await page.evaluate(() => (window as any).openAccountSettings());
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#cc-st-title')).toHaveText(/Account Settings/i);
    // Profile tab loads the current user's name into the editable field.
    await expect(page.locator('#cc-st-name')).toBeVisible({ timeout: 4000 });
    // Admin sees all five tabs.
    const tabs = await page.locator('#cc-st-tabs .cc-st-tab').allTextContents();
    expect(tabs.join('|')).toMatch(/Profile/);
    expect(tabs.join('|')).toMatch(/Security/);
    expect(tabs.join('|')).toMatch(/Sessions/);
    expect(tabs.join('|')).toMatch(/Audit/);
    expect(tabs.join('|')).toMatch(/Users/);
  });

  test('@smoke Account: Security tab shows password form + MFA status', async ({ page }) => {
    await bootAuthed(page);
    await page.evaluate(() => (window as any).openAccountSettings());
    await page.locator('#cc-st-tabs .cc-st-tab[data-tab="security"]').click();
    await expect(page.locator('#cc-st-cur-pw')).toBeVisible();
    await expect(page.locator('#cc-st-new-pw')).toBeVisible();
    await expect(page.locator('#cc-st-body')).toContainText(/Two-factor/i);
  });

  test('@smoke Account: Sessions tab renders the session table', async ({ page }) => {
    await bootAuthed(page);
    await page.evaluate(() => (window as any).openAccountSettings());
    await page.locator('#cc-st-tabs .cc-st-tab[data-tab="sessions"]').click();
    await expect(page.locator('#cc-st-body')).toContainText(/Active sessions/i, { timeout: 4000 });
  });

  test('@smoke Account: Users tab lists users (admin) incl. the signed-in admin', async ({ page }) => {
    await bootAuthed(page);
    await page.evaluate(() => (window as any).openAccountSettings());
    await page.locator('#cc-st-tabs .cc-st-tab[data-tab="users"]').click();
    await expect(page.locator('#cc-st-body')).toContainText(/Users & roles/i, { timeout: 4000 });
    await expect(page.locator('#cc-st-body')).toContainText(ADMIN.email);
    // Role selectors render.
    await expect(page.locator('.cc-st-role').first()).toBeVisible();
  });

  test('@smoke Organisation: branding loads + saves + round-trips publicly', async ({ page }) => {
    await bootAuthed(page);
    await page.evaluate(() => (window as any).openOrgSettings());
    await expect(page.locator('#cc-st-title')).toHaveText(/Organisation Settings/i);
    await expect(page.locator('#cc-st-org-public')).toBeVisible({ timeout: 4000 });
    const stamp = 'E2E Org ' + Date.now();
    await page.locator('#cc-st-org-public').fill(stamp);
    await page.locator('#cc-st-org-color-hex').fill('#1a2b3c');
    await page.locator('#cc-st-org-save').click();
    await expect(page.locator('#cc-st-toast.cc-st-show')).toContainText(/saved/i, { timeout: 4000 });
    // The public GET /config now reflects the change.
    const pub = await page.request.get('http://localhost:8000/api/v1/config/');
    const org = (await pub.json()).org;
    expect(org.org_public_name).toBe(stamp);
    expect(org.org_primary_color).toBe('#1a2b3c');
  });

  test('@smoke Organisation: Channels tab shows the channel cards', async ({ page }) => {
    await bootAuthed(page);
    await page.evaluate(() => (window as any).openOrgSettings());
    await page.locator('#cc-st-tabs .cc-st-tab[data-tab="channels"]').click();
    await expect(page.locator('#cc-st-body')).toContainText(/Channels/i, { timeout: 4000 });
    await expect(page.locator('.cc-st-ch-card')).toHaveCount(6);
    await expect(page.locator('#cc-st-body')).toContainText(/PWA/);
    await expect(page.locator('#cc-st-body')).toContainText(/Telegram/);
  });

  test('@smoke overlay closes on ✕', async ({ page }) => {
    await bootAuthed(page);
    await page.evaluate(() => (window as any).openAccountSettings());
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toBeVisible();
    await page.locator('#cc-st-close').click();
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toHaveCount(0);
  });
});
