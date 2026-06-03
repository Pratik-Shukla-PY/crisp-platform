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
    // Apr 2026 lockdown (commit 98d3341): the dashboard added a
    // mandatory TOTP step after the password form. The Login button
    // takes the user to a "Enter the 6-digit authenticator code"
    // gate — there's no completing this flow without a real TOTP
    // secret the e2e fixture doesn't provision.
    //
    // This smoke test originally proved "the login form is wired
    // end-to-end → index.html lands". With TOTP-mandatory, the
    // achievable equivalent is: "the form accepts credentials +
    // advances to the TOTP step". That IS the wiring proof. Don't
    // assert on the index.html redirect — that path is now gated
    // by the second factor.
    await page.getByRole('button', { name: /Login(\s+with\s+Password)?/i }).click();

    // Either:
    //   (a) the dashboard's single-admin TOTP gate appears (the
    //       current shipping behaviour — Apr 2026 lockdown), OR
    //   (b) a deploy where TOTP isn't enforced lands the user at
    //       index.html directly.
    // Accept either outcome — this is a UI-wiring smoke test, not
    // a TOTP-bypass test.
    await Promise.race([
      page.waitForURL(/index\.html|\/$/, { timeout: 20_000 }),
      // The TOTP step renders an <input id="login-totp"> alongside an
      // "Enter the 6-digit authenticator code" prompt. Wait for the
      // input — that's the deterministic signal that the form
      // advanced. Either condition resolving counts as a pass.
      page.locator('#login-totp').waitFor({ state: 'visible', timeout: 20_000 }),
    ]);
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

  test('admin user-menu no longer carries Regions (relocated to Reporting — CC-IA)', async ({ page }) => {
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

    // CC-IA P2 (2026-06) — "Auto-Submit Regions" was moved OUT of the user-chip
    // dropdown into the Reporting module (#/reporting → cc-crisis "Auto-submit
    // regions" tab; see 02-regions-admin.spec.ts). Under automation the router
    // lands on #/incidents (the feed), so the header user-menu is visible here.
    // Opening it must NOT show the old regions launcher anymore.
    await page.locator('.user-menu-trigger').click();
    await expect(page.locator('.user-menu-logout')).toBeVisible({ timeout: 10_000 });  // menu actually opened
    await expect(page.locator('#btn-auto-regions')).toHaveCount(0);                    // regions launcher gone
  });
});
