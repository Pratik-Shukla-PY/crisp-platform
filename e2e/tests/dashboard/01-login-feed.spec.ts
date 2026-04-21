/**
 * Dashboard login + feed — core smoke tests.
 *
 * Seeds an admin user via the API, logs in through the real login page,
 * then asserts the feed renders reports (or empty state). Every flow
 * beyond this depends on login working, so this file is @smoke.
 */
import { test, expect } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

test.describe('Dashboard login + feed', () => {
  test.beforeAll(async ({ request }) => {
    // Seed admin before any test runs. If login fails we surface it here
    // rather than letting every test time out.
    await ensureAdminAndLogin(request);
  });

  test('@smoke login page renders + form accepts credentials', async ({ page }) => {
    // Clear any persisted token to force the login flow.
    await page.context().clearCookies();
    await page.goto('login.html');
    // The login page has BOTH a login and a register form stacked in DOM;
    // scope to the login form's specific IDs to avoid strict-mode matches.
    await expect(page.locator('#login-email')).toBeVisible();
    await expect(page.locator('#login-password')).toBeVisible();

    await page.locator('#login-email').fill(ADMIN.email);
    await page.locator('#login-password').fill(ADMIN.password);
    // The login page offers OTP (primary) and password (secondary). For E2E
    // we use the password path — no mailbox access needed. The button isn't
    // a form submit; it's `onclick=loginWithPassword()` so we match on its
    // accessible text.
    await page.getByRole('button', { name: /Login with Password/i }).click();

    // Login success → redirect to index.html.
    await page.waitForURL(/index\.html|\/$/, { timeout: 20_000 });
  });

  test('@smoke feed renders after login', async ({ page }) => {
    // Fast-path: set the JWT directly via localStorage instead of clicking
    // through the login form on every test. Login form is covered above.
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

    // The main feed container should render within the standard poll window.
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 15_000 });

    // The LIVE/CACHED badge should show LIVE since backend is up.
    await expect(page.locator('#cache-freshness-badge')).toContainText(/LIVE/);

    // Regression: the "Offline — showing cached data" banner must NOT
    // be visible on a healthy stack (Apr 2026 fix for stuck navigator.onLine).
    const banner = page.locator('#offline-banner');
    // Banner DOM exists but should be hidden.
    await expect(banner).toBeHidden();
  });

  test('admin sees the Regions button in the header', async ({ page }) => {
    await page.goto('index.html');
    const token = await (async () => {
      const req = await page.request.post('http://localhost:8000/api/v1/auth/login', {
        data: { email: ADMIN.email, password: ADMIN.password },
      });
      const body = await req.json();
      return body.access_token || body.token;
    })();
    await page.evaluate((t) => {
      localStorage.setItem('crisp_token', t);
      localStorage.setItem('crisp_user', JSON.stringify({
        email: 'e2e-admin@crisp.test', role: 'SUPER_ADMIN', full_name: 'E2E Admin',
      }));
    }, token);
    await page.reload();

    // Apr 2026 — region auto-submit admin panel button is role-gated.
    await expect(page.locator('#btn-auto-regions')).toBeVisible({ timeout: 10_000 });
  });
});
