/**
 * Dashboard — role-gated navigation (CC-IA permission matrix).
 *
 * The router's ROUTE_ROLES is the single client-side allowlist (the backend
 * 403 stays the real boundary). Matrix:
 *
 *   route         SUPER_ADMIN  ADMIN  ANALYST  VIEWER
 *   /             ✓            ✓      ✓        ✓
 *   /incidents    ✓            ✓      ✓        ✓
 *   /users        ✓            ✓      ✓        ✓   (account self-service)
 *   /org          ✓            ✓      ✗        ✗
 *   /reporting    ✓            ✓      ✗        ✗
 *
 * On the Crisis Intelligence root the Org + Crisis Forms command-bar items are
 * disabled for non-admins (an "admin" badge); a direct navigate() to a
 * disallowed route bounces back to the root. Admins see them enabled and the
 * admin routes open their module overlays.
 *
 * NOTE: the e2e login is a single SUPER_ADMIN backend user; the client role is
 * what gates the UI, so we vary localStorage.crisp_user.role to exercise the
 * matrix (the same approach 12-control-center uses for its ANALYST case).
 */
import { test, expect, Page } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

async function bootAuthed(page: Page, role: string) {
  const token = await (async () => {
    const req = await page.request.post('http://localhost:8000/api/v1/auth/login', {
      data: { email: ADMIN.email, password: ADMIN.password },
    });
    const body = await req.json();
    return body.access_token || body.token;
  })();
  await page.goto('index.html');
  await page.evaluate(({ t, r }) => {
    localStorage.setItem('crisp_token', t);
    localStorage.setItem('crisp_user', JSON.stringify({
      email: 'e2e-admin@crisp.test', role: r, full_name: 'Role Test',
    }));
    localStorage.setItem('crisp_router_force_root', '1');   // real CC root, not the automation feed default
  }, { t: token, r: role });
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__crispRouter, null, { timeout: 15_000 });
}

const qa = (page: Page) => page.locator('#cc-nav button');

test.describe('Dashboard — role-gated navigation (CC-IA)', () => {
  test.beforeAll(async ({ request }) => { await ensureAdminAndLogin(request); });

  // ── canRoute() allowlist is the single source of truth (unit-level). ──────────
  for (const tc of [
    { role: 'SUPER_ADMIN', org: true,  reporting: true  },
    { role: 'ADMIN',       org: true,  reporting: true  },
    { role: 'ANALYST',     org: false, reporting: false },
    { role: 'VIEWER',      org: false, reporting: false },
  ]) {
    test(`@smoke canRoute(${tc.role}): /org=${tc.org} /reporting=${tc.reporting}; base routes always allowed`, async ({ page }) => {
      await bootAuthed(page, tc.role);
      const res = await page.evaluate(() => {
        const r = (window as any).__crispRouter;
        return {
          root: r.canRoute('/'), incidents: r.canRoute('/incidents'), users: r.canRoute('/users'),
          org: r.canRoute('/org'), reporting: r.canRoute('/reporting'),
          operations: r.canRoute('/operations'), exports: r.canRoute('/exports'),
        };
      });
      expect(res.root).toBe(true);
      expect(res.incidents).toBe(true);
      expect(res.users).toBe(true);
      expect(res.org).toBe(tc.org);
      expect(res.reporting).toBe(tc.reporting);
      // The two routes the global/operation split is built on — allowed for ALL
      // four roles (every role can run + export operations).
      expect(res.operations).toBe(true);
      expect(res.exports).toBe(true);
    });
  }

  // ── Non-admins: admin command-bar items disabled + admin routes bounce to root. ──
  for (const role of ['ANALYST', 'VIEWER']) {
    test(`@smoke ${role}: Org+Reporting actions disabled; direct admin routes bounce to root`, async ({ page }) => {
      await bootAuthed(page, role);
      await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });

      // Org + Crisis Forms command-bar items disabled with an "admin" badge.
      await expect(page.locator('#cc-nav button[data-route="/org"]')).toBeDisabled();
      await expect(page.locator('#cc-nav button[data-route="/reporting"]')).toBeDisabled();
      await expect(page.locator('#cc-nav button[data-route="/org"]')).toContainText(/admin/i);
      await expect(page.locator('#cc-nav button[data-route="/reporting"]')).toContainText(/admin/i);

      // Operations + Account remain enabled.
      await expect(qa(page).filter({ hasText: 'Operations' }).first()).toBeEnabled();
      await expect(qa(page).filter({ hasText: 'Account' }).first()).toBeEnabled();

      // Direct navigation to an admin module bounces back to the root.
      await page.evaluate(() => (window as any).__crispRouter.navigate('/org'));
      await expect(page).toHaveURL(/#\/$/);
      await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();

      await page.evaluate(() => (window as any).__crispRouter.navigate('/reporting'));
      await expect(page).toHaveURL(/#\/$/);
      await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();

      // A base route (Account self-service) stays reachable.
      await page.evaluate(() => (window as any).__crispRouter.navigate('/users'));
      await expect(page).toHaveURL(/#\/users/);
      await expect(page.locator('#cc-st-overlay.cc-st-open')).toBeVisible({ timeout: 3000 });
    });
  }

  // ── Admin: admin command-bar items enabled + admin routes open their overlays. ───
  test('@smoke ADMIN: Org+Reporting actions enabled; /org + /reporting open their modules', async ({ page }) => {
    await bootAuthed(page, 'ADMIN');
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#cc-nav button[data-route="/org"]')).toBeEnabled();
    await expect(page.locator('#cc-nav button[data-route="/reporting"]')).toBeEnabled();
    await expect(qa(page).filter({ hasText: 'Operations' }).first()).toBeEnabled();

    // /org opens the Organisation settings overlay (cc-settings).
    await page.evaluate(() => (window as any).__crispRouter.navigate('/org'));
    await expect(page).toHaveURL(/#\/org/);
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toBeVisible({ timeout: 3000 });

    // /reporting opens the Crisis-Forms overlay (cc-crisis).
    await page.evaluate(() => (window as any).__crispRouter.navigate('/reporting'));
    await expect(page).toHaveURL(/#\/reporting/);
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible({ timeout: 3000 });
  });
});
