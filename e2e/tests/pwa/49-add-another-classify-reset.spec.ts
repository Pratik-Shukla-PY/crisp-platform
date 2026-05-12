/**
 * PWA — "Add Another Report" classify-step reset (May 2026).
 *
 * Operator-reported bug:
 *   "On clicking Add Another, the v4 classify stage 'Continue' button
 *   never activates even after selecting a crisis cause."
 *
 * Root cause:
 *   v4-flow.js carries module-scoped `_classifyStep` (cursor pointing
 *   at the active sub-step: 'damage' | 'infra' | 'crisis') and
 *   `_crisisGroup` (cursor for the crisis drill-down). Neither was
 *   reset on _clearCaptureState — so after Add Another the user
 *   re-entered classify with stale cursors. The DOM kept showing the
 *   crisis sub-step ("WHAT CAUSED IT · 3 of 3") from the prior submit,
 *   _refreshClassifyNext was reading the stale step, and the gate
 *   behaved unpredictably across the navigation.
 *
 * Fix:
 *   _clearCaptureState dispatches a `crisp-capture-state-cleared`
 *   custom event. v4-flow.js listens + resets _classifyStep='damage',
 *   _crisisGroup=null, re-runs _showSubStep('damage'), repaints the
 *   drill-down to the group-cards layer, re-evaluates the Continue
 *   gate against the now-empty state.
 *
 * Companion fix (Bug 1):
 *   The "N queued" pill at the top of the capture screen had a silent
 *   `syncQueueManual()` onclick — no visual feedback when tapped.
 *   syncQueueManual now shows toasts on entry + completion
 *   ("Retrying N queued reports…" → "All synced!" / "X synced, Y still
 *   queued").
 */
import { test, expect, Page } from '@playwright/test';

async function bootV4(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function'
           && typeof (window as any)._clearCaptureState === 'function',
        null, { timeout: 8000 },
    );
}

test.describe('PWA — Add Another Report classify reset (Bug 2 follow-up)', () => {

    test.beforeEach(async ({ page }) => { await bootV4(page); });

    test('crisp-capture-state-cleared event fires from _clearCaptureState', async ({ page }) => {
        // Listen for the new event on the page side, then trigger
        // _clearCaptureState, and verify the event fired exactly once.
        const fired = await page.evaluate(async () => {
            let count = 0;
            const handler = () => { count++; };
            document.addEventListener('crisp-capture-state-cleared', handler);
            try {
                (window as any)._clearCaptureState();
            } finally {
                // Tiny settle window — the dispatchEvent is sync but
                // the listener may schedule async work.
                await new Promise((r) => setTimeout(r, 50));
                document.removeEventListener('crisp-capture-state-cleared', handler);
            }
            return count;
        });
        expect(fired, 'crisp-capture-state-cleared must fire exactly once').toBe(1);
    });

    test('after Add Another, re-entering classify lands on damage sub-step (not stale crisis)', async ({ page }) => {
        // Seed the state to simulate a completed prior report — damage,
        // infra, crisis all set; _classifyStep stale at 'crisis'.
        await page.evaluate(() => {
            const s = (window as any).state;
            s.damage_classification = 'PARTIAL';
            s.infrastructure_type   = 'ROAD';
            s.crisis_type           = 'EXPLOSION';
        });

        // Navigate to classify + walk the cursor to the crisis sub-step
        // (the v4 flow tracks this via the module-scoped _classifyStep
        // let; calling __crispV4RefreshClassifyNext requires the cursor
        // to be set — easier to just call __crispGoToStage + click
        // through the Continue button twice).
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-classify'));
        await expect(page.locator('#stage-v4-classify.active')).toBeVisible({ timeout: 4000 });

        // Walk to crisis sub-step via Continue clicks. The button is
        // already enabled because state is pre-seeded.
        await page.locator('#btn-v4-classify-next').click();
        await page.locator('#btn-v4-classify-next').click();
        // Now on crisis sub-step. Confirm via the label text.
        await expect(page.locator('#v4-substep-label')).toContainText(/WHAT CAUSED|caused/i, { timeout: 2000 });

        // ── Simulate "Add Another Report" — _clearCaptureState fires
        //    the new event; v4-flow.js's listener resets the cursor.
        await page.evaluate(() => (window as any)._clearCaptureState());

        // Re-enter classify.
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-classify'));
        await expect(page.locator('#stage-v4-classify.active')).toBeVisible();

        // ── ASSERTION: the DOM must show the DAMAGE sub-step (1 of 3)
        //    AND the Continue button must be DISABLED (state empty).
        await expect(page.locator('#v4-substep-label'),
            'must land on damage sub-step (1 of 3) after Add Another')
            .toContainText(/HOW BAD|bad/i, { timeout: 2000 });
        await expect(page.locator('#v4-view-damage'),
            'damage view must be visible (not hidden)').toBeVisible();
        await expect(page.locator('#v4-view-crisis'),
            'crisis view must be hidden after reset').toBeHidden();

        // Continue gate must reflect emptiness (no damage selected yet).
        const nextDisabled = await page.locator('#btn-v4-classify-next').isDisabled();
        expect(nextDisabled, 'Continue must be disabled when state is fresh').toBe(true);
    });

    test('after Add Another, crisis drill-down opens at group-cards layer (not stale subtypes)', async ({ page }) => {
        // Drive into the crisis subtypes list, then Add Another, then
        // re-enter crisis sub-step and verify the GROUP cards are
        // visible again (not the previously-rendered subtype list).
        await page.evaluate(() => {
            const s = (window as any).state;
            s.damage_classification = 'PARTIAL';
            s.infrastructure_type   = 'ROAD';
        });
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-classify'));
        await page.locator('#btn-v4-classify-next').click();  // damage → infra
        await page.locator('#btn-v4-classify-next').click();  // infra → crisis

        // Open the Technological drill-down.
        await page.locator('.v4-cause-card[data-group="tech"]').click();
        await expect(page.locator('#v4-cause-subtypes')).toBeVisible({ timeout: 2000 });

        // Add Another.
        await page.evaluate(() => (window as any)._clearCaptureState());

        // Re-enter classify + walk to crisis.
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-classify'));
        // After the reset, _classifyStep is 'damage'. Set state so we can
        // Continue twice without manually picking chips.
        await page.evaluate(() => {
            const s = (window as any).state;
            s.damage_classification = 'PARTIAL';
            s.infrastructure_type   = 'ROAD';
            const refresh = (window as any).__crispV4RefreshClassifyNext;
            if (typeof refresh === 'function') refresh();
        });
        await page.locator('#btn-v4-classify-next').click();
        await page.locator('#btn-v4-classify-next').click();

        // Crisis sub-step now visible. Group cards MUST be the visible
        // layer (not the stale subtype list from before Add Another).
        await expect(page.locator('#v4-cause-cards'),
            'crisis drill-down must show group cards after reset').toBeVisible();
        await expect(page.locator('#v4-cause-subtypes'),
            'subtype list must be hidden after reset').toBeHidden();
    });

    test('Bug 1: tapping the queued pill shows a toast (no silent no-op)', async ({ page }) => {
        // Capture all toasts shown during the interaction.
        const toasts: string[] = [];
        await page.exposeFunction('__captureToast', (msg: string) => { toasts.push(msg); });
        await page.evaluate(() => {
            // Wrap window.showToast so we can observe what gets shown.
            const orig = (window as any).showToast;
            (window as any).showToast = (msg: string, kind?: string) => {
                try { (window as any).__captureToast(String(msg)); } catch (_) {}
                if (typeof orig === 'function') return orig(msg, kind);
            };
            // Seed a queue entry so syncQueueManual has something to retry.
            (window as any).__crispEnqueueReport({
                client_report_id: 'queued-pill-toast-test',
                meta: {
                    client_report_id: 'queued-pill-toast-test',
                    device_hash: 'PILL-TOAST',
                    source: 'APP',
                    severity: 'MODERATE',
                    infrastructure_type: 'ROAD',
                    expected_media: 0,
                    location: { latitude: 12.97, longitude: 77.59 },
                },
                stages: { meta: false, text: true, photo: true, audio: true },
            });
        });

        // The badge updates on enqueue; refresh it explicitly.
        await page.evaluate(() => {
            if (typeof (window as any).updateSyncBadge === 'function') {
                (window as any).updateSyncBadge();
            }
        });
        await expect(page.locator('#sync-badge')).toBeVisible({ timeout: 3000 });

        // Tap the badge.
        await page.locator('#sync-badge').click();
        // Settle for the entry toast + the async sync attempt.
        await page.waitForTimeout(500);

        // Cleanup queue (don't pollute next tests).
        await page.evaluate(async () => {
            const fn = (window as any).__crispDequeueReport;
            if (typeof fn === 'function') {
                try { await fn('queued-pill-toast-test'); } catch (_) {}
            }
        });

        // At minimum the entry "Retrying N queued report(s)…" toast must fire.
        const retryToast = toasts.find((m) => /retry|queued/i.test(m));
        expect(retryToast, `must show a feedback toast on tap; observed: ${JSON.stringify(toasts)}`)
            .toBeTruthy();
    });
});
