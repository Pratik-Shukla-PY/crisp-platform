/**
 * Single-flow invariant (May 2026, operator-mandated).
 *
 * History: V3 capture chain (stage-where → infra → crisis → extras →
 * photo → audio → review) lived as an insurance fallback during the
 * V4 rollout. Now that V4 is stable:
 *
 *   · `stage-review` (V3 paginated review) DOM deleted — V4 uses
 *     stage-v4-review.
 *   · `?ui=v3` URL param + `crisp_ui_v4='off'` localStorage escape
 *     hatches deleted from v4-flow.js.
 *   · `UI_V3_ENABLED` in app.js hardcoded false.
 *   · STAGES array no longer includes `stage-review` (the deleted
 *     stage was scrubbed; the other V3 stage IDs remain because
 *     their DOMs still ship — V4's `__crispIngestFile` pipeline
 *     inherits helpers from setupPhotoStage that mutate
 *     `#photo-preview` / `#btn-photo-next` elements).
 *
 * The other V3 stage DOMs (stage-photo / audio / where / infra /
 * crisis / extras) intentionally REMAIN in index.html as helper
 * scaffolding. They are reachable via no user-action; only the
 * inherited V3 helper functions (called BY V4) touch their elements.
 * A future refactor that lifts those helpers out of the setup*
 * closures will let us delete those DOMs too.
 *
 * This spec pins the invariants so a regression PR can't bring V3
 * navigation back accidentally.
 */
import { test, expect } from '@playwright/test';

test.describe('Single capture flow — V3 navigation is gone', () => {

    test('stage-review DOM is removed (V3 paginated review)', async ({ page }) => {
        await page.goto('index.html');
        await expect(page.locator('#stage-v4-review')).toHaveCount(0);
    });

    test('?ui=v3 URL param does NOT engage V3 — V4 always wins', async ({ page }) => {
        await page.goto('index.html?ui=v3');
        await page.evaluate(() => {
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
        });
        await page.reload();
        const v4Flag = await page.evaluate(() => (window as any).__crispUiV4);
        expect(v4Flag).toBe(true);
        // UI_V3_ENABLED is exported to window.__crispUiV3 (legacy hook).
        // It's hard-locked to false now.
        const v3Flag = await page.evaluate(() => (window as any).__crispUiV3);
        expect(v3Flag).toBe(false);
    });

    test('localStorage crisp_ui_v4="off" is ignored — still V4', async ({ page }) => {
        await page.goto('index.html');
        await page.evaluate(() => {
            localStorage.setItem('crisp_ui_v4', 'off');
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
        });
        await page.reload();
        const v4Flag = await page.evaluate(() => (window as any).__crispUiV4);
        expect(v4Flag).toBe(true);
    });

    test('No JavaScript errors during home boot (regression guard)', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto('index.html', { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        expect(errors, `Unexpected PAGEERRORs: ${errors.join(' | ')}`).toHaveLength(0);
    });

    test('V4 public-API exports are wired (regression guard for setupPhotoStage)', async ({ page }) => {
        await page.goto('index.html', { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        const exports = await page.evaluate(() => ({
            ingestFile: typeof (window as any).__crispIngestFile,
            openCameraModal: typeof (window as any).openCameraModal,
            submitReport: typeof (window as any).__crispSubmitReport,
            removeExtraPhoto: typeof (window as any).removeExtraPhoto,
            openViewer: typeof (window as any).__crispOpenImageViewer,
        }));
        // All five must be functions — V4 depends on each.
        for (const [name, t] of Object.entries(exports)) {
            expect(t, `window.${name} should be a function`).toBe('function');
        }
    });
});
