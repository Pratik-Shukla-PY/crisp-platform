/**
 * Dashboard — Control Center landing (B7).
 *
 * cc-home.js shows a post-login landing overlay with a greeting hero + exactly
 * four primary cards. It is purely additive: Card 1 dismisses it to reveal the
 * (untouched) incident feed; Cards 2-4 open the existing settings / crisis-forms
 * overlays. Reachable again via window.openControlCenter().
 */
import { test, expect, Page } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

async function bootAuthed(page: Page, opts?: { skip?: boolean }) {
  const token = await (async () => {
    const req = await page.request.post('http://localhost:8000/api/v1/auth/login', {
      data: { email: ADMIN.email, password: ADMIN.password },
    });
    const body = await req.json();
    return body.access_token || body.token;
  })();
  await page.goto('index.html');
  await page.evaluate(({ t, skip }) => {
    localStorage.setItem('crisp_token', t);
    localStorage.setItem('crisp_user', JSON.stringify({
      email: 'e2e-admin@crisp.test', role: 'SUPER_ADMIN', full_name: 'Ada Ops',
    }));
    // Force auto-show even under Playwright (navigator.webdriver suppresses it
    // by default so the feed-driven specs aren't blocked). Skip-pref overrides.
    localStorage.setItem('crisp_cc_force_landing', '1');
    if (skip) localStorage.setItem('crisp_cc_skip_landing', '1');
    else localStorage.removeItem('crisp_cc_skip_landing');
  }, { t: token, skip: !!(opts && opts.skip) });
  await page.reload();
  await page.waitForFunction(() => typeof (window as any).openControlCenter === 'function', null, { timeout: 15_000 });
}

test.describe('Dashboard — Control Center landing (B7)', () => {
  test.beforeAll(async ({ request }) => { await ensureAdminAndLogin(request); });

  test('@smoke auto-shows after login with greeting + exactly 4 cards', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('.cc-home-hero')).toContainText(/Good (morning|afternoon|evening), Ada/);
    await expect(page.locator('.cc-home-card')).toHaveCount(4);
    await expect(page.locator('#cc-home-overlay')).toHaveText(/Monitor & Respond/);
    await expect(page.locator('#cc-home-overlay')).toHaveText(/Account Settings/);
    await expect(page.locator('#cc-home-overlay')).toHaveText(/Organisation Settings/);
    await expect(page.locator('#cc-home-overlay')).toHaveText(/Crisis Forms/);
  });

  test('@smoke accessible structure: dialog role, h1 hero, labelled card buttons', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('#cc-home-overlay')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#cc-home-overlay')).toHaveAttribute('aria-modal', 'true');
    expect(await page.locator('h1.cc-home-hero').count()).toBe(1);
    // every card is a real <button> with an aria-label
    const cards = page.locator('.cc-home-card');
    for (let i = 0; i < await cards.count(); i++) {
      expect((await cards.nth(i).getAttribute('aria-label')) || '').not.toEqual('');
    }
  });

  test('@smoke Card 1 (Monitor) dismisses landing → incident feed revealed', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 4000 });
    await page.locator('.cc-home-card.cc-home-c1').click();
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toHaveCount(0);
    // The existing feed is right there underneath — untouched, fully reachable.
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 8000 });
  });

  test('@smoke re-openable via window.openControlCenter()', async ({ page }) => {
    await bootAuthed(page);
    await page.locator('.cc-home-card.cc-home-c1').click();
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toHaveCount(0);
    await page.evaluate(() => (window as any).openControlCenter());
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();
  });

  test('@smoke Card 2 (Account) → closes landing + opens Account settings overlay', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 4000 });
    await page.locator('.cc-home-card.cc-home-c2').click();
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toHaveCount(0);
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#cc-st-title')).toHaveText(/Account Settings/i);
  });

  test('@smoke Card 4 (Crisis Forms) → opens the crisis-forms overlay', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 4000 });
    await page.locator('.cc-home-card.cc-home-c4').click();
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toHaveCount(0);
    await expect(page.locator('#cc-cf-overlay')).toBeVisible({ timeout: 3000 });
  });

  test('@smoke skip preference suppresses auto-show (feed shows directly); still re-openable', async ({ page }) => {
    await bootAuthed(page, { skip: true });
    // Give the auto-show timer a beat — it must NOT open with skip set.
    await page.waitForTimeout(900);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toHaveCount(0);
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 8000 });
    // Still reachable on demand.
    await page.evaluate(() => (window as any).openControlCenter());
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();
  });

  test('@smoke org branding loads into the landing header', async ({ page }) => {
    await bootAuthed(page);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible({ timeout: 4000 });
    // loadOrg() resolves the public org name into the header (non-empty).
    await expect(page.locator('#cc-home-orgname')).toBeVisible();
    await expect(page.locator('#cc-home-orgname')).not.toBeEmpty();
  });
});
