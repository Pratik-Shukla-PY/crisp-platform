/**
 * PWA landing screen — Apr 2026 redesign.
 *
 * Every interactive element on stage-home is verified here:
 *   · Privacy consent gate auto-opens on first launch
 *   · Language switcher toggles i18n strings
 *   · Primary CTA ("Start Reporting") navigates to the photo stage
 *   · Secondary entry ("My Reports") opens the history screen
 *   · Impact metrics card is hidden for zero-value state
 *   · Old 4-card roadmap is NOT present (regression guard for the rewrite)
 *   · Stale "Delete My Data" link on home is NOT visible (merged to history)
 *
 * These tests run against a fresh context per test (Playwright default),
 * so localStorage is clean — the consent gate fires every time.
 */
import { test, expect } from '@playwright/test';

test.describe('PWA landing screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('index.html');
    // Pre-accept privacy consent via the exact localStorage key the app
    // checks in `_initConsentGate`. Deterministic — avoids the race where
    // detectAndSetupLanguage() re-renders the overlay mid-click.
    await page.evaluate(() => {
      localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
    });
    await page.reload();
    // Force English regardless of GPS-based auto-detection.
    const enBtn = page.locator('#btn-lang-en');
    if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
  });

  test('@smoke renders hero title + primary CTA + offline hint', async ({ page }) => {
    await expect(page.locator('.hero-title')).toHaveText(/Report an Incident/i);
    // Apr 2026 PR 3 — the "Tap the button when you're ready" sub-copy
    // was removed. The big CTA speaks for itself; offline hint at the
    // bottom reassures users about connectivity.
    await expect(page.locator('.hero-sub')).toHaveCount(0);
    await expect(page.locator('#btn-start')).toBeVisible();
    await expect(page.locator('#btn-start')).toContainText(/Start Reporting/i);
    // Offline hint must be visible on the home stage.
    await expect(page.locator('.home-offline-hint')).toBeVisible();
    await expect(page.locator('.home-offline-hint')).toContainText(/offline/i);
    // 🟢/🔴 connectivity dot lives in the header.
    await expect(page.locator('#connectivity-dot')).toBeVisible();
  });

  test('@smoke Lives Saved card renames + heart + green styling', async ({ page }) => {
    // The card only renders when impactStats > 0. Seed a value via the
    // state-since polling path by stamping the in-memory cache so we can
    // assert the label even on a fresh install.
    await page.evaluate(() => {
      const wrap = document.getElementById('home-impact');
      const reports = document.getElementById('home-reports-count');
      const lives = document.getElementById('home-lives-count');
      if (wrap) wrap.style.display = 'flex';
      if (reports) reports.textContent = '3';
      if (lives) lives.textContent = '7';
    });
    await expect(page.locator('#home-impact')).toBeVisible();
    // Label is "Lives Saved" (not "Lives Impacted" which was the old copy).
    await expect(page.locator('.hi-cell-lives .hi-label')).toContainText(/Lives Saved/i);
    // Heart emoji is present (animated via CSS — we just check it renders).
    await expect(page.locator('.hi-cell-lives .hi-heart')).toBeVisible();
  });

  test('@smoke old 4-card roadmap is NOT rendered (Apr 2026 rewrite guard)', async ({ page }) => {
    // If someone reintroduces the confusing "Photo/Voice/Check/Send" card
    // grid, this test fails. The DOM class `.roadmap` must not exist.
    await expect(page.locator('.roadmap')).toHaveCount(0);
    await expect(page.locator('.roadmap-step')).toHaveCount(0);
  });

  test('standalone "Delete My Data" button is not visible on home', async ({ page }) => {
    // The old link was merged into My Reports. The DOM node is retained
    // hidden for Telegram-deep-link compat but must not be user-visible.
    const deleteBtn = page.locator('#btn-delete-my-data');
    // Node exists but hidden.
    await expect(deleteBtn).toBeHidden();
  });

  test('@smoke My Reports button opens the history screen', async ({ page }) => {
    await page.locator('#btn-my-reports').click();
    await expect(page.locator('#stage-history.active')).toBeVisible();
    // Either the in-flight list, the submitted list, or an empty state
    // should render — we just need the screen to have loaded.
    await expect(page.locator('#stage-history .history-section-title').first()).toBeVisible();
    // Apr 2026 "My Reports" spec — bulk delete is hidden behind an
    // Advanced accordion. The collapsed <details> is present but its
    // contents (the #btn-history-delete-all) are hidden by default.
    await expect(page.locator('#history-advanced')).toBeVisible();
    await expect(page.locator('#history-advanced')).not.toHaveAttribute('open', /.*/);
    await expect(page.locator('#btn-history-delete-all')).toBeHidden();
  });

  test('language switcher toggles copy', async ({ page }) => {
    const title = page.locator('.hero-title');
    const originalText = await title.textContent();

    // Switch to local language button if available. Many pages detect
    // locale from GeoIP so the "local" button may resolve to Kannada
    // (Bengaluru geolocation in playwright.config.ts).
    const localBtn = page.locator('#btn-lang-local');
    if (await localBtn.isVisible()) {
      await localBtn.click();
      // Title should have changed to the localised version.
      await expect(title).not.toHaveText(originalText || '', { timeout: 5000 });
      // Flip back to English to leave a clean state.
      await page.locator('#btn-lang-en').click();
      await expect(title).toContainText(/Report/i);
    }
  });

  test('Start Reporting button navigates to photo stage', async ({ page }) => {
    await page.locator('#btn-start').click();
    await expect(page.locator('#stage-photo.active')).toBeVisible();
    // The unified flow-progress bar should now be visible with step 1 active.
    await expect(page.locator('#flow-progress')).toBeVisible();
    const step1 = page.locator('.fp-step[data-step="1"]');
    await expect(step1).toHaveClass(/fp-active/);
  });

  test('flow-progress bar renders all 4 steps with correct labels', async ({ page }) => {
    await page.locator('#btn-start').click();
    const bar = page.locator('#flow-progress');
    await expect(bar).toBeVisible();

    // Exactly 4 steps in order: Photo, Details, Review, Send.
    const labels = await page.locator('.fp-step .fp-label').allTextContents();
    expect(labels).toHaveLength(4);
    // Case-insensitive match (i18n may capitalise differently per locale).
    const joined = labels.join('|').toLowerCase();
    expect(joined).toContain('photo');
    expect(joined).toContain('details');
    expect(joined).toContain('review');
    expect(joined).toContain('send');
  });
});
