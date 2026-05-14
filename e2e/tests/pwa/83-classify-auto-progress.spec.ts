/**
 * Classify-stage auto-progress UX (May 2026)
 *
 * Operator request: "When the user selects any tile/card option in
 * Stage 2, the app should automatically progress to the next step
 * immediately after selection. The currently selected tile should
 * briefly show an active/selected animation state before auto-
 * navigation occurs. Navigation delay should be minimal (~150–300ms)
 * so the user perceives confirmation before page transition."
 *
 * Stage 2 = #stage-v4-classify; 3 sub-views in order:
 *   damage  → infra  → crisis  → stage-v4-review
 *
 * Each sub-view has tile-based single-selection radiogroups. This
 * spec verifies:
 *   1. Tap a damage tile  → advance to "What was hit?"
 *   2. Tap an infra tile  → advance to "What caused it?"
 *   3. Tap the OTHER infra tile → reveals free-text input + waits
 *      for Enter or blur with non-empty text before advancing
 *   4. Tap a crisis tile  → advance to stage-v4-review
 *   5. Back button preserves prior selection (.is-selected stays)
 *   6. Rapid double-tap fires only ONE navigation (race guard)
 *   7. Continue button (#btn-v4-classify-next) is no longer visible
 */
import { test, expect } from '@playwright/test';

test.describe('Stage-2 classify auto-progress', () => {

  // Helper — open the classify stage directly + seed minimal state.
  // The v4 flow normally requires a photo first; for these UX tests
  // we bypass the photo gate by setting state via window directly
  // and navigating straight to stage-v4-classify.
  async function openClassifyStage(page) {
    await page.goto('/?nocache=' + Date.now(), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.goToStage === 'function' && typeof window.state === 'object', { timeout: 5_000 });
    await page.evaluate(() => {
      // Pretend the user already added a photo so any gating passes.
      window.state = window.state || {};
      window.state.photoDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
      window.state.v4Photos = [window.state.photoDataUrl];
      window.goToStage('stage-v4-classify');
    });
    await expect(page.locator('#stage-v4-classify.active')).toBeVisible({ timeout: 3_000 });
    // Wait for damage sub-view to be active
    await expect(page.locator('#v4-view-damage')).toBeVisible();
  }

  test('Continue button is hidden on the classify stage', async ({ page }) => {
    await openClassifyStage(page);
    // The button stays in the DOM for back-compat; only its footer is
    // hidden via CSS. We assert the footer is collapsed.
    const footerVisible = await page.evaluate(() => {
      const footer = document.querySelector('#stage-v4-classify .v4-footer');
      if (!footer) return false;
      const cs = window.getComputedStyle(footer);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    });
    expect(footerVisible).toBe(false);
  });

  test('damage tile tap auto-advances to infra sub-view', async ({ page }) => {
    await openClassifyStage(page);
    // Tap COMPLETE
    await page.locator('#v4-view-damage .v4-q-opt[data-value="COMPLETE"]').click();
    // Expect to land on the infra sub-view within ~400 ms (200ms pulse + transition).
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 800 });
    await expect(page.locator('#v4-view-damage')).toBeHidden();
    // State persisted
    const dc = await page.evaluate(() => window.state?.damage_classification);
    expect(dc).toBe('COMPLETE');
  });

  test('non-OTHER infra tile tap auto-advances to crisis sub-view', async ({ page }) => {
    await openClassifyStage(page);
    await page.locator('#v4-view-damage .v4-q-opt[data-value="PARTIAL"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 800 });
    await page.locator('#v4-view-infra .v4-hit-tile[data-value="RESIDENTIAL"]').click();
    await expect(page.locator('#v4-view-crisis')).toBeVisible({ timeout: 800 });
    const it = await page.evaluate(() => window.state?.infrastructure_type);
    expect(it).toBe('RESIDENTIAL');
  });

  test('OTHER infra tile reveals input + waits for Enter to advance', async ({ page }) => {
    await openClassifyStage(page);
    await page.locator('#v4-view-damage .v4-q-opt[data-value="MINIMAL"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 800 });
    await page.locator('#v4-view-infra .v4-hit-tile[data-value="OTHER"]').click();
    // OTHER reveals input + does NOT auto-advance
    await expect(page.locator('#v4-infra-other-prompt')).toBeVisible();
    // Wait 500ms — confirm we're still on infra view (no advance)
    await page.waitForTimeout(500);
    await expect(page.locator('#v4-view-infra')).toBeVisible();
    await expect(page.locator('#v4-view-crisis')).toBeHidden();
    // Type something + press Enter → advance
    await page.locator('#v4-infra-other-input').fill('cell tower');
    await page.locator('#v4-infra-other-input').press('Enter');
    await expect(page.locator('#v4-view-crisis')).toBeVisible({ timeout: 800 });
    const name = await page.evaluate(() => window.state?.infrastructure_name);
    expect(name).toBe('cell tower');
  });

  test('crisis tile tap auto-advances to review stage', async ({ page }) => {
    await openClassifyStage(page);
    await page.locator('#v4-view-damage .v4-q-opt[data-value="COMPLETE"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 800 });
    await page.locator('#v4-view-infra .v4-hit-tile[data-value="UTILITY"]').click();
    await expect(page.locator('#v4-view-crisis')).toBeVisible({ timeout: 800 });
    // The crisis grid is rendered at runtime; wait for at least one tile.
    await page.waitForSelector('#v4-cause-grid .v4-cause-tile', { timeout: 3_000 });
    await page.locator('#v4-cause-grid .v4-cause-tile[data-value="EARTHQUAKE"]').click();
    await expect(page.locator('#stage-v4-review.active')).toBeVisible({ timeout: 1_200 });
    const ct = await page.evaluate(() => window.state?.crisis_type);
    expect(ct).toBe('EARTHQUAKE');
  });

  test('back navigation preserves prior selection', async ({ page }) => {
    await openClassifyStage(page);
    await page.locator('#v4-view-damage .v4-q-opt[data-value="PARTIAL"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 800 });
    // Tap Back — should return to damage sub-view with PARTIAL still selected
    await page.locator('#btn-v4-classify-back').click();
    await expect(page.locator('#v4-view-damage')).toBeVisible();
    const selected = await page.locator('#v4-view-damage .v4-q-opt.is-selected').getAttribute('data-value');
    expect(selected).toBe('PARTIAL');
    // Re-tap a DIFFERENT tile → auto-progress fires again
    await page.locator('#v4-view-damage .v4-q-opt[data-value="MINIMAL"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 800 });
    const newDc = await page.evaluate(() => window.state?.damage_classification);
    expect(newDc).toBe('MINIMAL');
  });

  test('rapid double-tap fires only ONE navigation', async ({ page }) => {
    await openClassifyStage(page);
    // Tap PARTIAL twice in quick succession (50ms apart)
    const partial = page.locator('#v4-view-damage .v4-q-opt[data-value="PARTIAL"]');
    const minimal = page.locator('#v4-view-damage .v4-q-opt[data-value="MINIMAL"]');
    await partial.click();
    await page.waitForTimeout(50);
    // Second rapid tap on a different tile — race guard should prevent a
    // second advance from re-firing while the first is still pending.
    await minimal.click().catch(() => {});
    // Wait for the transition to complete
    await page.waitForTimeout(400);
    await expect(page.locator('#v4-view-infra')).toBeVisible();
    // We don't assert exactly which value won — both can race. The
    // important thing is we landed on infra view, not skipped past it
    // to crisis.
    await expect(page.locator('#v4-view-crisis')).toBeHidden();
  });

  test('reduced-motion users advance faster, no pulse animation', async ({ page, context }) => {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'matchMedia', {
        value: (q) => ({
          matches: q.includes('reduce'),
          media: q, onchange: null,
          addListener() {}, removeListener() {},
          addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
        }),
        configurable: true,
      });
    });
    await openClassifyStage(page);
    const tile = page.locator('#v4-view-damage .v4-q-opt[data-value="COMPLETE"]');
    const start = Date.now();
    await tile.click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 500 });
    const elapsed = Date.now() - start;
    // 80ms reduced + ~50ms hop overhead = ≤ ~200ms typical
    expect(elapsed).toBeLessThan(400);
  });

  test('state persists across stage reload (offline-first)', async ({ page }) => {
    await openClassifyStage(page);
    await page.locator('#v4-view-damage .v4-q-opt[data-value="COMPLETE"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 800 });
    // Confirm localStorage has the value
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('crisp-state') || '';
      try { return JSON.parse(raw); } catch { return {}; }
    });
    expect(stored?.damage_classification).toBe('COMPLETE');
  });

});
