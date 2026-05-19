/**
 * UI v3: 8-stage capture-flow reorder (Apr 2026, Phase B4).
 *
 * Pins the Apr 2026 reorder from the v2 flow (photo → audio → review) to
 * the v3 flow:
 *
 *   home → where(loc + damage)
 *        → infra(type)
 *        → crisis(crisis + building-name)
 *        → extras(severity + service + needs)
 *        → photo → audio → review+submit → success
 *
 * Feature flag `localStorage.crisp_ui_v3` defaults to `on`; setting it to
 * `off` reverts to the v2 flow where Start lands on stage-photo. Both
 * branches pinned so a flip-flop surfaces in CI before hitting the field.
 *
 * No backend calls — asserts DOM + state via `__crispGoToStage`,
 * `__crispUiV3`, and `window.state`.
 */
import { test, expect } from '@playwright/test';

async function openPwa(page) {
    await page.goto('index.html');
    await page.evaluate(() => {
        // Consent-gate + device pre-seed so the stage machine boots without
        // the modal intercepting clicks.
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');  // Pre-v4 tests target the v3 capture flow.
        localStorage.setItem('crisp_device_hash', 'DEV-E2E-V3FLOW');
    });
    await page.reload();
    const enBtn = page.locator('#btn-lang-en');
    if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
    await page.evaluate(() => {
        const c = document.getElementById('consent-overlay');
        if (c) c.style.display = 'none';
    });
}

// Phase F triage (May 2026) — UI v3 is RETIRED. Source declares
// `const UI_V3_ENABLED = false;` at mobile-app/src/app.js:39 and the
// dead `if (UI_V3_ENABLED)` branches were stripped at parse time
// (companion comments at app.js:36, app.js:3092). The 8 failures in
// this file were testing dead code paths after Batch B's v4-flow
// rollout removed v3 entirely. Skipped wholesale; if v3 ever gets
// resurrected (UNDP rubric review wants it back, etc.) flip skip
// → describe and the assertions still document the legacy contract.
test.describe.skip('UI v3 — 8-stage capture-flow reorder', () => {

    test('@smoke feature flag defaults ON + 4 new stages present in DOM', async ({ page }) => {
        await openPwa(page);
        const flags = await page.evaluate(() => ({
            uiV3: (window as any).__crispUiV3,
            where: !!document.getElementById('stage-where'),
            infra: !!document.getElementById('stage-infra'),
            crisis: !!document.getElementById('stage-crisis'),
            extras: !!document.getElementById('stage-extras'),
        }));
        expect(flags.uiV3).toBe(true);
        expect(flags.where).toBe(true);
        expect(flags.infra).toBe(true);
        expect(flags.crisis).toBe(true);
        expect(flags.extras).toBe(true);
    });

    test('@smoke v3 blocks migrated out of stage-review by DOMContentLoaded', async ({ page }) => {
        await openPwa(page);
        // After migrateV3Blocks runs, the location block + crisis chips + service
        // details + infra chips should no longer live inside stage-review.
        const migratedOut = await page.evaluate(() => {
            const review = document.getElementById('stage-review');
            if (!review) return { ok: false, msg: 'no stage-review' };
            // Blocks tagged data-v3-slot should have been re-parented.
            const stillInside = review.querySelectorAll('[data-v3-slot]').length;
            // Their destinations:
            const slots = {
                where: document.getElementById('v3-slot-where'),
                infra: document.getElementById('v3-slot-infra'),
                crisis: document.getElementById('v3-slot-crisis'),
                extras: document.getElementById('v3-slot-extras'),
            };
            const filledSlots = Object.values(slots).filter((s) => s && s.children.length > 0).length;
            return { ok: stillInside === 0 && filledSlots >= 3, stillInside, filledSlots };
        });
        expect(migratedOut.stillInside).toBe(0);
        expect(migratedOut.filledSlots).toBeGreaterThanOrEqual(3);
    });

    test('@smoke start button lands on stage-where (not stage-photo) when v3 on', async ({ page }) => {
        await openPwa(page);
        // Start from home, click the Start button, assert the next stage.
        await page.evaluate(() => (window as any).__crispGoToStage('stage-home'));
        await page.locator('#btn-start').click();
        await expect(page.locator('#stage-where')).toHaveClass(/active/);
    });

    test('v3 flow walks where → infra → crisis → extras → photo', async ({ page }) => {
        await openPwa(page);
        // Kick off the flow.
        await page.evaluate(() => (window as any).__crispGoToStage('stage-home'));
        await page.locator('#btn-start').click();
        await expect(page.locator('#stage-where')).toHaveClass(/active/);

        // Damage chip pre-selected PARTIAL; Continue should be valid out of the box.
        await page.locator('#btn-where-next').click();
        await expect(page.locator('#stage-infra')).toHaveClass(/active/);

        // Infra chip (default ROAD) — tap Continue.
        await page.locator('#btn-infra-next').click();
        await expect(page.locator('#stage-crisis')).toHaveClass(/active/);

        // Crisis (default FLOOD) — tap Continue.
        await page.locator('#btn-crisis-next').click();
        await expect(page.locator('#stage-extras')).toHaveClass(/active/);

        // Extras — all optional — tap Continue. Should land on photo.
        await page.locator('#btn-extras-next').click();
        await expect(page.locator('#stage-photo')).toHaveClass(/active/);

        // State sanity: damage/infra/crisis all populated.
        const state = await page.evaluate(() => ({
            damage: (window as any).state?.damageClass,
            infra: (window as any).state?.infraType,
            crisis: (window as any).state?.crisisType,
        }));
        expect(state.damage).toBeTruthy();
        expect(state.infra).toBeTruthy();
        expect(state.crisis).toBeTruthy();
    });

    test('back button from stage-where returns to home', async ({ page }) => {
        await openPwa(page);
        await page.evaluate(() => (window as any).__crispGoToStage('stage-where'));
        await page.locator('#btn-where-back').click();
        await expect(page.locator('#stage-home')).toHaveClass(/active/);
    });

    test('stage-review in v3 mode shows summary + submit (no input blocks)', async ({ page }) => {
        await openPwa(page);
        await page.evaluate(() => (window as any).__crispGoToStage('stage-review'));
        await expect(page.locator('#stage-v4-review')).toHaveClass(/active/);
        // The v3 migration moves chip/input blocks out; the summary should be
        // rendered (it lives in the "page 2" wrapper). Submit should be visible.
        const flags = await page.evaluate(() => {
            const summary = document.getElementById('review-summary');
            const submit = document.getElementById('btn-review-submit');
            const next = document.getElementById('btn-review-next');
            return {
                summaryVisible: !!(summary && summary.innerHTML.trim().length > 0),
                submitVisible: !!(submit && submit.style.display !== 'none'),
                nextHidden: !!(next && next.style.display === 'none'),
            };
        });
        expect(flags.submitVisible).toBe(true);
        expect(flags.nextHidden).toBe(true);
    });

    test('7-segment progress overlay rendered when v3 is on', async ({ page }) => {
        await openPwa(page);
        await page.evaluate(() => (window as any).__crispGoToStage('stage-where'));
        const segs = await page.locator('.fp-v3-overlay .fp-v3-seg').count();
        expect(segs).toBe(7);
        // Stage-where is step 1 — first segment active, rest upcoming.
        const firstActive = await page.locator('.fp-v3-overlay .fp-v3-seg[data-v3-step="1"]').evaluate(
            (el) => el.classList.contains('active'),
        );
        expect(firstActive).toBe(true);
    });

    test('v3 flag OFF falls back to legacy v2 flow (start → photo)', async ({ page }) => {
        await page.goto('index.html');
        await page.evaluate(() => {
            localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');  // Pre-v4 tests target the v3 capture flow.
            localStorage.setItem('crisp_device_hash', 'DEV-E2E-V3OFF');
            localStorage.setItem('crisp_ui_v3', 'off');
        });
        await page.reload();
        const enBtn = page.locator('#btn-lang-en');
        if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
        await page.evaluate(() => {
            const c = document.getElementById('consent-overlay');
            if (c) c.style.display = 'none';
        });
        await page.evaluate(() => (window as any).__crispGoToStage('stage-home'));
        await page.locator('#btn-start').click();
        // Back to the legacy jump-to-photo behaviour.
        await expect(page.locator('#stage-photo')).toHaveClass(/active/);
    });
});
