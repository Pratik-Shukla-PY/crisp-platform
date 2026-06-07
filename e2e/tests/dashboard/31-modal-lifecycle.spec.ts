/**
 * Dashboard — modal/overlay lifecycle audit (close paths, no stacking, no leaks).
 *
 * Regression guard for the Crisis Forms "modal won't close" defect: closing
 * routes to '/', and router.hideAll() dismisses each overlay via
 * window.__ccCrisis/__ccSettings/__ccHome. cc-crisis originally omitted
 * closeOverlay from its export, so hideAll's call short-circuited and the
 * overlay stayed pinned on top of the Control Center. These tests exercise
 * EVERY close path for every routed overlay so any overlay that can't close
 * fails here.
 */
import { test, expect, Page } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

async function bootAuthed(page: Page, role = 'SUPER_ADMIN') {
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
    localStorage.setItem('crisp_user', JSON.stringify({ email: 'e2e@crisp.test', role: r, full_name: 'Lifecycle' }));
    localStorage.setItem('crisp_router_force_root', '1');
  }, { t: token, r: role });
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__crispRouter, null, { timeout: 15_000 });
}
const nav = (page: Page, r: string) => page.evaluate((route) => (window as any).__crispRouter.navigate(route), r);

test.describe('Dashboard — modal lifecycle', () => {
  test.beforeAll(async ({ request }) => { await ensureAdminAndLogin(request); });

  // ── Crisis Forms — the reported defect, every close path ──────────────────
  test('@smoke Crisis Forms closes via ✕ button → Control Center shown', async ({ page }) => {
    await bootAuthed(page);
    await nav(page, '/reporting');
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible({ timeout: 5000 });
    await page.locator('#cc-cf-close').click();
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toHaveCount(0);     // CLOSED (regression: stayed open)
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();  // root revealed
    await expect(page).toHaveURL(/#\/$/);
  });

  test('@smoke Crisis Forms closes via ESC', async ({ page }) => {
    await bootAuthed(page);
    await nav(page, '/reporting');
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toHaveCount(0);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();
  });

  test('@smoke Crisis Forms closes via backdrop click', async ({ page }) => {
    await bootAuthed(page);
    await nav(page, '/reporting');
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible({ timeout: 5000 });
    await page.locator('#cc-cf-overlay').click({ position: { x: 6, y: 6 } });   // backdrop, outside the shell
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toHaveCount(0);
  });

  test('@smoke Crisis Forms closes on route change + browser back', async ({ page }) => {
    await bootAuthed(page);
    await nav(page, '/reporting');
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible({ timeout: 5000 });
    await nav(page, '/incidents');                                              // route change
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toHaveCount(0);
    await expect(page.locator('#view-incidents')).toBeVisible();
    await page.goBack();                                                        // browser back → #/reporting
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible();
    await expect(page.locator('#view-incidents')).toBeHidden();                 // incidents not left under it
  });

  // ── No stacking / no leaks across cycles ──────────────────────────────────
  test('@smoke 5 open/close cycles leave exactly one overlay node, none open', async ({ page }) => {
    await bootAuthed(page);
    for (let i = 0; i < 5; i++) {
      await nav(page, '/reporting');
      await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible();
      await page.locator('#cc-cf-close').click();
      await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toHaveCount(0);
    }
    await expect(page.locator('#cc-cf-overlay')).toHaveCount(1);                // ensureOverlay guard: no duplicate nodes
    await expect(page.locator('.cc-cf-open, .cc-st-open')).toHaveCount(0);      // nothing left open
  });

  test('@smoke switching modules never stacks two overlays', async ({ page }) => {
    await bootAuthed(page);
    await nav(page, '/reporting');
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible();
    await nav(page, '/org');                                                    // open settings
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toBeVisible();
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toHaveCount(0);     // crisis auto-closed
    await nav(page, '/');                                                       // back to root
    await expect(page.locator('.cc-cf-open, .cc-st-open')).toHaveCount(0);
    await expect(page.locator('#cc-home-overlay.cc-home-open')).toBeVisible();
  });

  // ── Settings overlay — regression guard for the already-working overlay ───
  test('@smoke Settings closes via ✕ and ESC', async ({ page }) => {
    await bootAuthed(page);
    await nav(page, '/org');
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toBeVisible({ timeout: 5000 });
    await page.locator('#cc-st-close').click();
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toHaveCount(0);
    await nav(page, '/org');
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toHaveCount(0);
  });

  // ── Focus management: opening a modal moves focus into it (a11y) ───────────
  // (Background scroll is already handled platform-wide: body { overflow:hidden }
  // in styles.css + hideAll() display:none's the background view, so no per-modal
  // scroll-lock is needed — validated, not a defect.)
  test('@smoke opening a modal moves focus to its close control (a11y)', async ({ page }) => {
    await bootAuthed(page);
    await nav(page, '/reporting');
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#cc-cf-close')).toBeFocused();
    await nav(page, '/org');
    await expect(page.locator('#cc-st-overlay.cc-st-open')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#cc-st-close')).toBeFocused();
  });

  // ── Full focus-trap: Tab/Shift+Tab cycle inside the dialog, never escape ───
  test('@smoke focus is trapped within an open modal (Tab never escapes)', async ({ page }) => {
    await bootAuthed(page);
    await nav(page, '/reporting');
    await expect(page.locator('#cc-cf-overlay.cc-cf-open')).toBeVisible({ timeout: 5000 });
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const ov = document.getElementById('cc-cf-overlay');
        return !!(ov && document.activeElement && ov.contains(document.activeElement));
      });
      expect(inside, `focus escaped the modal on Tab #${i + 1}`).toBe(true);
    }
    // Shift+Tab also stays inside.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Shift+Tab');
      const inside = await page.evaluate(() => {
        const ov = document.getElementById('cc-cf-overlay');
        return !!(ov && document.activeElement && ov.contains(document.activeElement));
      });
      expect(inside, `focus escaped on Shift+Tab #${i + 1}`).toBe(true);
    }
  });
});
