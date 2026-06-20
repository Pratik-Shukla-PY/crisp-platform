/**
 * Dashboard — irreversible-purge step-up ("sudo") auth.
 *
 * The Pending-Deletions hard-purge ("Purge all" / "Purge expired") used to
 * prompt for a shared static admin key via window.prompt() and send it as
 * X-Admin-Key. It now re-confirms the OPERATOR'S identity once via an in-app
 * modal (authenticator TOTP code, or account password when no MFA is enrolled),
 * exchanges it at POST /auth/step-up for a short-lived token, and sends that
 * token as X-Step-Up on the purge call. The token is cached for its window so
 * the operator is asked only ONCE per ~10 min.
 *
 * These run against the REAL backend so the password→token exchange is exercised
 * end-to-end, but the destructive purge request itself is intercepted + stubbed
 * (200 {purged:0}) so no dev-DB rows are hard-deleted as a side effect — we only
 * assert the request CARRIES a valid X-Step-Up header.
 */
import { test, expect, Page } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

async function bootAuthed(page: Page) {
  const req = await page.request.post('http://localhost:8000/api/v1/auth/login', {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  const body = await req.json();
  const token = body.access_token || body.token;
  await page.goto('index.html');
  await page.evaluate(({ t }) => {
    localStorage.setItem('crisp_token', t);
    localStorage.setItem('crisp_user', JSON.stringify({ email: 'e2e@crisp.test', role: 'SUPER_ADMIN', full_name: 'Purge' }));
    localStorage.setItem('crisp_router_force_root', '1');
  }, { t: token });
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__crispRouter, null, { timeout: 15_000 });
}

test.describe('Dashboard — purge step-up auth', () => {
  test.beforeAll(async ({ request }) => { await ensureAdminAndLogin(request); });

  test('@smoke purge shows the in-app step-up modal (not a native prompt) and sends X-Step-Up after password confirm', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.type()); await d.accept(); });

    // Intercept the destructive call so we assert the header without touching data.
    let purgeStepUpHeader: string | undefined;
    let purgeCount = 0;
    await page.route('**/reports/purge-expired', async (route) => {
      purgeCount += 1;
      purgeStepUpHeader = route.request().headers()['x-step-up'];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ purged: 0 }) });
    });

    await bootAuthed(page);

    // Fire the purge (don't await — it blocks on the step-up modal).
    await page.evaluate(() => { (window as any).purgeExpiredOnly(); });

    // In-app modal appears (the whole point — no window.prompt).
    await expect(page.locator('#stepup-overlay')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#stepup-overlay .stepup-card')).toContainText(/authenticator code/i);

    // Confirm with the operator's account password (admin has no MFA enrolled).
    await page.locator('#stepup-input').fill(ADMIN.password);
    await page.locator('#stepup-ok').click();

    // The real /auth/step-up issues a token; the purge then fires WITH it.
    await expect.poll(() => purgeCount, { timeout: 8000 }).toBeGreaterThan(0);
    expect(purgeStepUpHeader, 'purge request must carry a non-empty X-Step-Up token').toBeTruthy();
    expect((purgeStepUpHeader || '').split('.').length).toBe(3);              // looks like a JWT

    // Modal dismissed; token cached; the ONLY native dialog was the confirm() (never a prompt).
    await expect(page.locator('#stepup-overlay')).toHaveCount(0);
    expect(dialogs).not.toContain('prompt');
    expect(dialogs).toContain('confirm');
    const cached = await page.evaluate(() => sessionStorage.getItem('crisp_stepup_token'));
    expect(cached, 'step-up token cached in sessionStorage').toBeTruthy();
  });

  test('@smoke within the window the operator is asked only ONCE — a second purge reuses the cached token', async ({ page }) => {
    page.on('dialog', async (d) => { await d.accept(); });
    let purgeCount = 0;
    const headers: (string | undefined)[] = [];
    await page.route('**/reports/purge-expired', async (route) => {
      purgeCount += 1;
      headers.push(route.request().headers()['x-step-up']);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ purged: 0 }) });
    });

    await bootAuthed(page);

    // First purge — confirm via the modal.
    await page.evaluate(() => { (window as any).purgeExpiredOnly(); });
    await expect(page.locator('#stepup-overlay')).toBeVisible({ timeout: 5000 });
    await page.locator('#stepup-input').fill(ADMIN.password);
    await page.locator('#stepup-ok').click();
    await expect.poll(() => purgeCount, { timeout: 8000 }).toBe(1);

    // Second purge — token still fresh ⇒ NO modal, fires straight through.
    await page.evaluate(() => { (window as any).purgeExpiredOnly(); });
    await expect.poll(() => purgeCount, { timeout: 8000 }).toBe(2);
    // The modal must not have re-appeared for the second call.
    await expect(page.locator('#stepup-overlay')).toHaveCount(0);
    expect(headers[1], 'second purge reused the cached token').toBeTruthy();
    expect(headers[1]).toBe(headers[0]);
  });

  test('@smoke a wrong code re-prompts in place and does NOT log the operator out', async ({ page }) => {
    page.on('dialog', async (d) => { await d.accept(); });
    // Stub so a wrong code never reaches a real purge (it shouldn't get that far anyway).
    await page.route('**/reports/purge-expired', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ purged: 0 }) }));

    await bootAuthed(page);
    await page.evaluate(() => { (window as any).purgeExpiredOnly(); });
    await expect(page.locator('#stepup-overlay')).toBeVisible({ timeout: 5000 });

    await page.locator('#stepup-input').fill('definitely-not-the-password');
    await page.locator('#stepup-ok').click();

    // The /auth/step-up 401 must NOT trip the global force-logout interceptor;
    // instead the modal re-prompts in place with an inline error.
    await expect(page.locator('#stepup-err')).toContainText(/incorrect/i, { timeout: 8000 });
    await expect(page.locator('#stepup-overlay')).toBeVisible();
    await expect(page).not.toHaveURL(/login\.html/);                          // still on the dashboard

    await page.locator('#stepup-cancel').click();                            // bail out cleanly
    await expect(page.locator('#stepup-overlay')).toHaveCount(0);
  });
});
