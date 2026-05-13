/**
 * PWA — Full crisis-step interaction after Add Another.
 *
 * Operator-reported (May 2026, second time):
 *   "Add another again failed and not activating this Continue at this
 *    stage. This is a repeat problem you confirmed was fixed. e2e test
 *    and regression was also checked. Why this happened?"
 *
 * Screenshot context: classify Step 2 of 3, crisis sub-step (3 of 3),
 * the three group cards (Natural disaster / Technological / Human-made)
 * are visible with NO selection, Continue is disabled.
 *
 * Prior fix (commit c4d2087) reset `_classifyStep` and `_crisisGroup`
 * via the `crisp-capture-state-cleared` event. The shipped spec 49
 * verified the reset to the damage sub-step + that group cards are
 * visible — but it never actually TAPPED a group card and a subtype
 * chip after Add Another to verify the click chain still produces a
 * working Continue gate.
 *
 * This file closes that gap. If these tests pass, the user's
 * frustration is about ambiguous interaction (Continue is disabled
 * by design until a subtype is picked, which is correct). If they
 * fail, there's a real handler-staleness bug to chase.
 */
import { test, expect, Page } from '@playwright/test';

async function bootV4(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        // Force English so locale-based label assertions are stable.
        localStorage.setItem('crisp_lang', 'en');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function'
           && typeof (window as any)._clearCaptureState === 'function',
        null, { timeout: 8000 },
    );
}

test.describe('PWA — full crisis interaction after Add Another (Bug 2 re-verification)', () => {

    test.beforeEach(async ({ page }) => { await bootV4(page); });

    test('@smoke after Add Another, full damage → infra → crisis flow with group + subtype taps enables Continue', async ({ page }) => {
        // 1. Simulate a completed prior report so all classifiers are set.
        await page.evaluate(() => {
            const s = (window as any).state;
            s.damage_classification = 'PARTIAL';
            s.infrastructure_type   = 'ROAD';
            s.crisis_type           = 'EXPLOSION';
        });

        // 2. Navigate to classify, walk to crisis sub-step (proves the
        //    pre-Add-Another path works).
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-classify'));
        await expect(page.locator('#stage-v4-classify.active')).toBeVisible({ timeout: 4000 });
        await page.locator('#btn-v4-classify-next').click();   // damage → infra
        await page.locator('#btn-v4-classify-next').click();   // infra → crisis
        // Use locale-independent "3 of 3" sub-step number assertion
        // rather than the translated label text.
        await expect(page.locator('#v4-substep-label')).toContainText(/3 of 3/i);

        // 3. Add Another (the user's repro path).
        await page.evaluate(() => (window as any)._clearCaptureState());

        // 4. Re-enter classify — should land at damage sub-step.
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-classify'));
        await expect(page.locator('#v4-view-damage')).toBeVisible();
        await expect(page.locator('#btn-v4-classify-next')).toBeDisabled();

        // 5. Tap a damage option (must enable Continue).
        await page.locator('#v4-view-damage .v4-q-opt[data-value="PARTIAL"]').click();
        await expect(page.locator('#btn-v4-classify-next')).toBeEnabled();
        await page.locator('#btn-v4-classify-next').click();

        // 6. Tap an infra tile (must enable Continue).
        await expect(page.locator('#v4-view-infra')).toBeVisible();
        await expect(page.locator('#btn-v4-classify-next')).toBeDisabled();
        await page.locator('#v4-view-infra .v4-hit-tile[data-value="TRANSPORT_COMMUNICATION"]').click();
        await expect(page.locator('#btn-v4-classify-next')).toBeEnabled();
        await page.locator('#btn-v4-classify-next').click();

        // 7. NOW the user sees the flat crisis grid (May 2026 flatten —
        //    drill-down retired). Continue is disabled until a tile is
        //    selected.
        await expect(page.locator('#v4-view-crisis')).toBeVisible();
        await expect(page.locator('#v4-cause-grid'),
            'flat crisis grid must be visible').toBeVisible();
        await expect(page.locator('.v4-cause-tile')).toHaveCount(9);
        await expect(page.locator('#btn-v4-classify-next'),
            'Continue must be disabled before a crisis tile is selected').toBeDisabled();

        // 8 + 9. Tap the Flood tile directly — no drill-down click.
        //    EXPECTATION: state.crisis_type = 'FLOOD', Continue enables.
        await page.locator('.v4-cause-tile[data-value="FLOOD"]').click();

        // 10. THE CRITICAL ASSERTION: Continue must enable.
        await expect(page.locator('#btn-v4-classify-next'),
            'Continue MUST enable after tapping a crisis tile after Add Another').toBeEnabled({ timeout: 2000 });

        // And state must reflect the selection.
        const crisisType = await page.evaluate(() => (window as any).state.crisis_type);
        expect(crisisType, 'state.crisis_type must be set to FLOOD').toBe('FLOOD');
    });

    test('tapping a crisis tile after Add Another sets state + enables Continue (handlers not stale)', async ({ page }) => {
        // Spec 49 already proves the stale-highlight is cleared on
        // Add Another. This proves the click HANDLERS still function
        // — the specific concern the operator raised that led to the
        // c4d2087 / 0a26c7a fixes.
        await page.evaluate(() => {
            const s = (window as any).state;
            s.damage_classification = 'PARTIAL';
            s.infrastructure_type   = 'ROAD';
            s.crisis_type           = 'EXPLOSION';
        });
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-classify'));
        await page.locator('#btn-v4-classify-next').click();
        await page.locator('#btn-v4-classify-next').click();
        // Pre-Add-Another: tap Explosion tile so we have a selection
        // to clear on the next pass.
        await page.locator('.v4-cause-tile[data-value="EXPLOSION"]').click();
        await expect(page.locator('.v4-cause-tile.is-selected')).toHaveCount(1);

        // Add Another.
        await page.evaluate(() => (window as any)._clearCaptureState());

        // Re-enter classify, walk to crisis (set state to skip chip taps).
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-classify'));
        await page.evaluate(() => {
            const s = (window as any).state;
            s.damage_classification = 'PARTIAL';
            s.infrastructure_type   = 'ROAD';
            const refresh = (window as any).__crispV4RefreshClassifyNext;
            if (typeof refresh === 'function') refresh();
        });
        await page.locator('#btn-v4-classify-next').click();
        await page.locator('#btn-v4-classify-next').click();

        // Stale highlight cleared (per spec 49) — and the Earthquake
        // tile is tappable + sets state.crisis_type.
        await expect(page.locator('.v4-cause-tile.is-selected')).toHaveCount(0);
        await page.locator('.v4-cause-tile[data-value="EARTHQUAKE"]').click();
        const crisisType = await page.evaluate(() => (window as any).state.crisis_type);
        expect(crisisType).toBe('EARTHQUAKE');
        await expect(page.locator('#btn-v4-classify-next')).toBeEnabled();
    });
});
