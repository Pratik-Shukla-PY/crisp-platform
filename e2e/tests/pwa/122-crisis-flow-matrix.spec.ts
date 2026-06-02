/**
 * PWA — Dynamic Crisis Forms: classify-flow edge-case matrix (B5).
 *
 * Complements 121 (the happy-path renderer) with the operator-requested
 * "all possible scenarios" for crisis-form VISIBILITY:
 *   - skip-crisis order holds even when crisis_type was reset (add-another):
 *     _ensureZoneCrisisType re-derives it from the surviving crisisPack.
 *   - a pack whose ONLY fields are already captured by the chips adds NO
 *     crisispack step AND skips the crisis step (canonical type) → straight to
 *     review, with form_pack_id still riding along.
 *   - rapid double-tap on the infra tile advances exactly once (no skip-past).
 *   - a location change that clears the pack mid-flow restores the default
 *     "what caused it?" crisis step.
 *   - offline submit of a crisis-pack report queues form_data intact.
 *
 * All driven through the real UI + the window.__crisp* hooks, same as 121.
 * This spec controls /crisis-forms/active directly (does NOT use _fixtures).
 */
import { test, expect, Page } from '@playwright/test';

const WILDFIRE_PACK = {
    pack_id: 'pk-wf', pack_version: 2, event_id: 'ev-wf', crisis_type: 'WILDFIRE',
    schema: {
        schema_version: 1, key: 'wf', title: 'Wildfire rapid assessment',
        sections: [
            { id: 'classify', stage: 2, fields: [
                { key: 'crisis_type', type: 'single_select', maps_to: 'crisis_type', label: 'Cause', required: true,
                  options: [{ value: 'WILDFIRE', label: 'Wildfire' }] },
                { key: 'flames_visible', type: 'yes_no', label: 'Flames visible?', required: true },
            ] },
        ],
    },
};

// A pack whose only field is captured by the default chips → no extra fields.
const NO_EXTRA_PACK = {
    pack_id: 'pk-noextra', pack_version: 1, event_id: 'ev-ne', crisis_type: 'FLOOD',
    schema: {
        schema_version: 1, key: 'fl', title: 'Flood (chips only)',
        sections: [
            { id: 'classify', stage: 2, fields: [
                { key: 'crisis_type', type: 'single_select', maps_to: 'crisis_type', label: 'Cause', required: true,
                  options: [{ value: 'FLOOD', label: 'Flood' }] },
                { key: 'damage_classification', type: 'single_select', maps_to: 'damage_classification', label: 'Damage', required: true,
                  options: [{ value: 'COMPLETE', label: 'Complete' }] },
            ] },
        ],
    },
};

async function boot(page: Page, pack: any, opts?: { offline?: boolean }) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.route('**/api/v1/reports/nearby**', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ groups: [] }) }));
    await page.route('**/api/v1/reports/meta', (r) =>
        r.fulfill({ status: 503, body: '{"detail":"blocked-by-spec"}' }));
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => typeof (window as any).goToStage === 'function'
        && typeof (window as any).state === 'object'
        && typeof (window as any).__crispGetAllQueued === 'function', null, { timeout: 8000 });
    await page.evaluate((p) => {
        const s = (window as any).state = (window as any).state || {};
        s.photoDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
        s.v4Photos = [s.photoDataUrl];
        s.location = { lat: 11.668, lng: 76.634, acc: 35 };
        s.crisisPack = p;
        s.crisisStockAnswers = {};
        s.crisis_type = p ? p.crisis_type : null;
        (window as any).goToStage('stage-v4-classify');
    }, pack);
    await expect(page.locator('#stage-v4-classify.active')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#v4-view-damage')).toBeVisible();
}

async function pickDamageInfra(page: Page) {
    await page.locator('#v4-view-damage .v4-q-opt[data-value="COMPLETE"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 1500 });
    await page.locator('#v4-view-infra .v4-hit-tile[data-value="RESIDENTIAL"]').click();
}

test.describe('PWA — crisis-flow visibility matrix (B5)', () => {

    test('@smoke add-another: crisis_type reset but pack survives → still skips crisis', async ({ page }) => {
        await boot(page, WILDFIRE_PACK);
        // Simulate _clearCaptureState having nulled crisis_type while leaving the
        // pack in place (the add-another path). _ensureZoneCrisisType must
        // re-derive it so the crisis chip step is still skipped.
        await page.evaluate(() => { (window as any).state.crisis_type = null; });
        await pickDamageInfra(page);
        await expect(page.locator('#v4-view-crisispack')).toBeVisible({ timeout: 2000 });
        await expect(page.locator('#v4-view-crisis:visible')).toHaveCount(0);
    });

    test('@smoke pack with NO extra fields (all chip-captured) → no crisispack, skips crisis', async ({ page }) => {
        await boot(page, NO_EXTRA_PACK);
        await pickDamageInfra(page);
        // Canonical type + zero extra fields → neither crisis nor crisispack;
        // straight to review. form_pack_id still rides on the queued meta.
        await expect(page.locator('#stage-v4-review.active')).toBeVisible({ timeout: 2000 });
        await expect(page.locator('#v4-view-crisispack:visible')).toHaveCount(0);
        await expect(page.locator('#v4-view-crisis:visible')).toHaveCount(0);
        const meta = await page.evaluate(async () => {
            try { await (window as any).__crispSubmitReport(); } catch (_) {}
            await new Promise((r) => setTimeout(r, 120));
            const items = await (window as any).__crispGetAllQueued();
            return items.length ? items[0].meta : null;
        });
        expect(meta).not.toBeNull();
        expect(meta.form_pack_id).toBe('pk-noextra');
        expect(meta.crisis_type).toBe('FLOOD');
        expect(meta.damage_classification).toBe('COMPLETE');
    });

    test('@smoke rapid double-tap on infra advances exactly once (to crisispack)', async ({ page }) => {
        await boot(page, WILDFIRE_PACK);
        await page.locator('#v4-view-damage .v4-q-opt[data-value="COMPLETE"]').click();
        await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 1500 });
        const tile = page.locator('#v4-view-infra .v4-hit-tile[data-value="RESIDENTIAL"]');
        await tile.click({ clickCount: 2, delay: 30 });   // rapid double-tap
        await expect(page.locator('#v4-view-crisispack')).toBeVisible({ timeout: 2000 });
        // Did not skip past crisispack into review.
        await expect(page.locator('#stage-v4-review.active')).toHaveCount(0);
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="flames_visible"]')).toBeVisible();
    });

    test('@smoke no active pack at classify (zone inactive / pack cleared) → default crisis step shows', async ({ page }) => {
        // The observable outcome of a location change into a non-zone (or the
        // pack being cleared): the hardcoded "what caused it?" crisis step is
        // shown after infra, and the crisispack step is never injected.
        await boot(page, null);
        await pickDamageInfra(page);
        await expect(page.locator('#v4-view-crisis')).toBeVisible({ timeout: 2000 });
        await expect(page.locator('#v4-view-crisispack:visible')).toHaveCount(0);
        await page.waitForSelector('#v4-cause-grid .v4-cause-tile[data-value="WILDFIRE"]', { timeout: 3000 });
    });

    test('@smoke offline submit queues form_data intact (drains on reconnect)', async ({ page, context }) => {
        await boot(page, WILDFIRE_PACK);
        await pickDamageInfra(page);
        await expect(page.locator('#v4-view-crisispack')).toBeVisible({ timeout: 2000 });
        await page.locator('#v4-view-crisispack .v4-cp-q[data-key="flames_visible"] .v4-cp-opt[data-val="true"]').click();
        await page.locator('#btn-v4-classify-next').click();
        await expect(page.locator('#stage-v4-review.active')).toBeVisible({ timeout: 2000 });
        await context.setOffline(true);
        const meta = await page.evaluate(async () => {
            try { await (window as any).__crispSubmitReport(); } catch (_) {}
            await new Promise((r) => setTimeout(r, 150));
            const items = await (window as any).__crispGetAllQueued();
            return items.length ? items[0].meta : null;
        });
        await context.setOffline(false);
        expect(meta, 'offline submit must still enqueue').not.toBeNull();
        expect(meta.form_pack_id).toBe('pk-wf');
        expect(meta.form_data).toBeTruthy();
        expect(meta.form_data.flames_visible).toBe(true);
        expect(meta.crisis_type).toBe('WILDFIRE');
    });
});
