/**
 * Dashboard — Crisis Intelligence Center as the MANDATORY root + hash router.
 *
 * After login the Crisis Intelligence landing (`#/`) is the root — not the
 * incident feed. It shows a situational-awareness dashboard (KPIs, map,
 * attention queue, intelligence, impact, briefing, activity) and a compact
 * pinned command bar (#cc-nav, Jun 2026 — was the bottom #cc-qa Quick Actions row) that routes into the modules. Under automation the router
 * lands on `#/incidents` by default (so feed-driven specs aren't blocked);
 * these tests opt into the real root via `crisp_router_force_root`.
 *
 * Routes: #/ (Crisis Intelligence) · #/incidents · #/users · #/org · #/reporting.
 */
import { test, expect, Page } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

async function bootAuthed(page: Page, opts?: { role?: string }) {
  const token = await (async () => {
    const req = await page.request.post('http://localhost:8000/api/v1/auth/login', {
      data: { email: ADMIN.email, password: ADMIN.password },
    });
    const body = await req.json();
    return body.access_token || body.token;
  })();
  await page.goto('index.html');
  await page.evaluate(({ t, role }) => {
    localStorage.setItem('crisp_token', t);
    localStorage.setItem('crisp_user', JSON.stringify({
      email: 'e2e-admin@crisp.test', role: role || 'SUPER_ADMIN', full_name: 'Ada Ops',
    }));
    localStorage.setItem('crisp_router_force_root', '1');   // real CC root, not the automation feed default
  }, { t: token, role: opts && opts.role });
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__crispRouter, null, { timeout: 15_000 });
}

const qa = (page: Page) => page.locator('#cc-nav button');

test.describe('Dashboard — Crisis Intelligence mandatory root', () => {
  test.beforeAll(async ({ request }) => { await ensureAdminAndLogin(request); });

  test('@smoke mandatory root: lands on the Crisis Intelligence Center (#/), not the feed', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/#\/$/);
    // The situational-awareness dashboard renders (KPI strip + command bar).
    await expect(page.locator('#cc-kpis')).toBeVisible();
    await expect(page.locator('#cc-kpis')).toContainText('Active incidents', { timeout: 8000 });
    await expect(qa(page).first()).toBeVisible();
    // The incident view is hidden behind the root (not the landing surface).
    await expect(page.locator('#view-incidents')).toBeHidden();
  });

  test('@smoke accessible structure: labelled region, single h1, named action buttons', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#cc-home-overlay')).toHaveAttribute('role', 'region');
    await expect(page.locator('#cc-home-overlay')).toHaveAttribute('aria-label', /Crisis Intelligence/i);
    expect(await page.locator('#cc-home-overlay h1').count()).toBe(1);
    const buttons = qa(page);
    const n = await buttons.count();
    expect(n).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < n; i++) {
      expect(((await buttons.nth(i).innerText()) || '').trim()).not.toEqual('');
    }
  });

  test('@smoke Operations → routes to #/incidents, reveals the feed, hides the root', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await qa(page).filter({ hasText: 'Operations' }).first().click();
    await expect(page).toHaveURL(/#\/incidents/);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toHaveCount(0);
    await expect(page.locator('#view-incidents')).toBeVisible();
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 8000 });
  });

  test('@smoke Account → #/users opens Account settings; ✕ returns to root', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await qa(page).filter({ hasText: 'Account' }).first().click();
    await expect(page).toHaveURL(/#\/users/);
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#cc-st-title')).toHaveText(/Account Settings/i);
    await page.locator('#cc-st-close').click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();
  });

  test('@smoke Crisis Forms → #/reporting opens the crisis-forms module', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await page.locator('#cc-nav button[data-route="/reporting"]').click();
    await expect(page).toHaveURL(/#\/reporting/);
    await expect(page.locator('#cc-cf-overlay')).toBeVisible({ timeout: 3000 });
  });

  test('@smoke org branding loads into the landing header', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#cc-home-orgname')).toBeVisible();
    await expect(page.locator('#cc-home-orgname')).not.toBeEmpty();
  });

  test('@smoke role gate: ANALYST sees Org/Reporting actions disabled + #/org redirects to root', async ({ page }) => {
    await bootAuthed(page, { role: 'ANALYST' });
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#cc-nav button[data-route="/org"]')).toBeDisabled();
    await expect(page.locator('#cc-nav button[data-route="/reporting"]')).toBeDisabled();
    await expect(qa(page).filter({ hasText: 'Operations' }).first()).toBeEnabled();
    await expect(qa(page).filter({ hasText: 'Account' }).first()).toBeEnabled();
    // A direct route to an admin module bounces back to the root.
    await page.evaluate(() => (window as any).__crispRouter.navigate('/org'));
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();
  });
});
