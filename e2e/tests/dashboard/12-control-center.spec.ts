/**
 * Dashboard — Control Center as the MANDATORY root + hash router (CC-IA).
 *
 * After login the Control Center (`#/`) is the root — not the incident feed —
 * and the four cards route to the modules. There is no skip. Under automation
 * the router lands on `#/incidents` by default (so feed-driven specs aren't
 * blocked); these tests opt into the real root behaviour with
 * `crisp_router_force_root`.
 *
 * Routes: #/ (Control Center) · #/incidents · #/users · #/org · #/reporting.
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
    localStorage.setItem('crisp_router_force_root', '1');   // land on the real CC root, not the automation feed default
  }, { t: token, role: opts && opts.role });
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__crispRouter, null, { timeout: 15_000 });
}

test.describe('Dashboard — Control Center mandatory root (CC-IA)', () => {
  test.beforeAll(async ({ request }) => { await ensureAdminAndLogin(request); });

  test('@smoke mandatory root: lands on Control Center (#/), not the feed', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/#\/$|#\/$/);   // hash is '#/'
    await expect(page.locator('.cc-home-hero')).toContainText(/Good (morning|afternoon|evening), Ada/);
    await expect(page.locator('.cc-home-card')).toHaveCount(4);
    // The incident view is hidden behind the root (not the landing surface).
    await expect(page.locator('#view-incidents')).toBeHidden();
    // No skip control any more.
    await expect(page.locator('#cc-home-skip-cb')).toHaveCount(0);
  });

  test('@smoke accessible structure: dialog role, h1 hero, labelled card buttons', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#cc-home-overlay')).toHaveAttribute('role', 'dialog');
    expect(await page.locator('h1.cc-home-hero').count()).toBe(1);
    const cards = page.locator('.cc-home-card');
    for (let i = 0; i < await cards.count(); i++) {
      expect((await cards.nth(i).getAttribute('aria-label')) || '').not.toEqual('');
    }
  });

  test('@smoke Card 1 → routes to #/incidents, reveals the feed, hides the root', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await page.locator('.cc-home-card.cc-home-c1').click();
    await expect(page).toHaveURL(/#\/incidents/);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toHaveCount(0);
    await expect(page.locator('#view-incidents')).toBeVisible();
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 8000 });
  });

  test('@smoke Card 2 → #/users opens Account settings; ✕ returns to root', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await page.locator('.cc-home-card.cc-home-c2').click();
    await expect(page).toHaveURL(/#\/users/);
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#cc-st-title')).toHaveText(/Account Settings/i);
    // Close returns to the Control Center root (not the feed).
    await page.locator('#cc-st-close').click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();
  });

  test('@smoke Card 4 → #/reporting opens the crisis-forms module', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await page.locator('.cc-home-card.cc-home-c4').click();
    await expect(page).toHaveURL(/#\/reporting/);
    await expect(page.locator('#cc-cf-overlay')).toBeVisible({ timeout: 3000 });
  });

  test('@smoke org branding loads into the landing header', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#cc-home-orgname')).toBeVisible();
    await expect(page.locator('#cc-home-orgname')).not.toBeEmpty();
  });

  test('@smoke role gate: ANALYST sees org/reporting cards disabled + #/org redirects to root', async ({ page }) => {
    await bootAuthed(page, { role: 'ANALYST' });
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 5000 });
    // Cards 3 (Org) + 4 (Reporting) disabled for a non-admin.
    await expect(page.locator('.cc-home-card.cc-home-c3')).toBeDisabled();
    await expect(page.locator('.cc-home-card.cc-home-c4')).toBeDisabled();
    // Account (c2) + Monitor (c1) remain enabled.
    await expect(page.locator('.cc-home-card.cc-home-c1')).toBeEnabled();
    await expect(page.locator('.cc-home-card.cc-home-c2')).toBeEnabled();
    // A direct route to an admin module bounces back to the root.
    await page.evaluate(() => (window as any).__crispRouter.navigate('/org'));
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();
  });
});
