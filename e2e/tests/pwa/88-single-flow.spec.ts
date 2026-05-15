/**
 * Single-flow invariant (May 2026, operator-mandated).
 *
 * The V3 capture flow (stage-photo → audio → where → infra → crisis →
 * extras → review) lived as an insurance fallback during the V4
 * rollout. Now that V4 is stable, V3 is GONE — DOM blocks deleted,
 * `?ui=v3` URL param removed, `crisp_ui_v4='off'` localStorage
 * escape hatch removed, UI_V3_ENABLED hardcoded false.
 *
 * This spec pins the contract so a regression PR can't bring V3
 * back accidentally. It would have caught:
 *   · A future commit re-adding `<div id="stage-photo">` etc.
 *   · A revert of the `_v4Enabled()` toggle.
 *   · The STAGES array sprouting V3 IDs back.
 *   · A `?ui=v3` URL navigating somewhere other than V4.
 */
import { test, expect } from '@playwright/test';

const V3_STAGE_IDS = [
    'stage-photo',
    'stage-audio',
    'stage-where',
    'stage-infra',
    'stage-crisis',
    'stage-extras',
    'stage-review',
];

test.describe('Single capture flow — V3 is gone', () => {

    test('no V3 stage <div id="..."> exists in the DOM', async ({ page }) => {
        await page.goto('index.html');
        for (const id of V3_STAGE_IDS) {
            const present = await page.locator(`#${id}`).count();
            expect(present, `${id} should not exist`).toBe(0);
        }
    });

    test('?ui=v3 URL param does NOT route to V3 (V3 is gone, V4 always wins)', async ({ page }) => {
        await page.goto('index.html?ui=v3');
        await page.evaluate(() => {
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
        });
        await page.reload();
        // V4 has its own `__crispUiV4 = true` flag set unconditionally
        // at module init.
        const v4Flag = await page.evaluate(() => (window as any).__crispUiV4);
        expect(v4Flag).toBe(true);
        // And the V3 flag should be hard-locked to false.
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

    test('STAGES array contains V4 stages but no V3 IDs', async ({ page }) => {
        await page.goto('index.html');
        // STAGES is module-scoped in app.js; expose via a probe.
        const stages = await page.evaluate(() => {
            // No public accessor — assert against the DOM instead,
            // which is the user-visible contract anyway.
            return Array.from(document.querySelectorAll('.stage'))
                        .map((el) => el.id);
        });
        // V4 stages present.
        expect(stages).toEqual(expect.arrayContaining([
            'stage-home', 'stage-v4-capture', 'stage-v4-classify',
            'stage-v4-review', 'stage-success',
        ]));
        // No V3 IDs.
        for (const v3 of V3_STAGE_IDS) {
            expect(stages).not.toContain(v3);
        }
    });
});
