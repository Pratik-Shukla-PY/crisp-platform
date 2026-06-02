/**
 * PWA — Dynamic Crisis Forms: geo-gated Stage 2/3 pack renderer.
 *
 * Feature: when a reporter is inside a live crisis zone, the backend's
 * /crisis-forms/active returns a curated question pack (state.crisisPack).
 * The PWA then appends a 4th classify sub-step ('crisispack') that renders
 * the pack's EXTRA questions — the stock (non-maps_to) questions PLUS any
 * maps_to field the default chips don't already capture (e.g.
 * debris_clearing_needed). The hardcoded damage/infra/crisis chips are
 * untouched and keep populating the canonical fields (must-have #1 parity).
 * At submit, form_data = {stock answers} ∪ {maps_to fields sourced from the
 * canonical state}, and form_pack_id / form_pack_version ride along.
 *
 * This spec proves:
 *   1. With an active pack, after the crisis tap the flow lands on the
 *      crisispack sub-step (NOT straight to review), renders exactly the
 *      extra fields (crisis_type / damage are excluded — captured by chips),
 *      gates Continue on the required pack question, and on submit the
 *      queued meta carries form_pack_id + form_pack_version + a form_data
 *      that includes both the chip-sourced maps_to fields AND the answers.
 *   2. NEGATIVE — with NO active pack, the flow auto-advances crisis→review
 *      as before and the meta carries form_pack_id = null (default flow
 *      byte-identical; complements frozen spec 88).
 */
import { test, expect, Page } from '@playwright/test';

const TEST_PACK = {
    pack_id: 'pk-test-wildfire',
    pack_version: 3,
    event_id: 'ev-test-1',
    crisis_type: 'WILDFIRE',
    schema: {
        schema_version: 1,
        key: 'wf-test',
        title: 'Forest Fire — rapid assessment',
        sections: [
            { id: 'classify', stage: 2, fields: [
                // maps_to fields the default chips already capture → NOT rendered in the pack view.
                { key: 'crisis_type', type: 'single_select', maps_to: 'crisis_type', label: 'What caused it?', required: true,
                  options: [{ value: 'WILDFIRE', label: 'Wildfire' }, { value: 'FLOOD', label: 'Flood' }] },
                { key: 'damage_classification', type: 'single_select', maps_to: 'damage_classification', label: 'Damage?', required: true,
                  options: [{ value: 'MINIMAL', label: 'Min' }, { value: 'COMPLETE', label: 'Comp' }] },
                // stock questions → rendered in the crisispack view.
                { key: 'flames_visible', type: 'yes_no', label: 'Flames visible?', required: true },
                { key: 'smoke_density', type: 'single_select', label: 'Smoke density?', required: false,
                  options: [{ value: 'LIGHT', label: 'Light' }, { value: 'HEAVY', label: 'Heavy' }] },
            ] },
            { id: 'details', stage: 3, fields: [
                // maps_to NOT in the default-captured set → rendered + routed to its column.
                { key: 'debris_clearing_needed', type: 'yes_no', maps_to: 'debris_clearing_needed', label: 'Debris clearing needed?', required: false },
                { key: 'notes', type: 'long_text', label: 'Notes', required: false },
            ] },
        ],
    },
};

async function bootClassify(page: Page, opts?: { withPack?: boolean }) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.route('**/api/v1/reports/nearby**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ groups: [] }) }));
    // Block the meta POST so the queue row stays put for inspection.
    await page.route('**/api/v1/reports/meta', (route) =>
        route.fulfill({ status: 503, body: '{"detail":"blocked-by-spec"}' }));
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).goToStage === 'function'
           && typeof (window as any).state === 'object'
           && typeof (window as any).__crispGetAllQueued === 'function',
        null, { timeout: 8000 });
    await page.evaluate((pack) => {
        const s = (window as any).state = (window as any).state || {};
        s.photoDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
        s.v4Photos = [s.photoDataUrl];
        s.location = { lat: 11.668, lng: 76.634, acc: 35 };
        if (pack) s.crisisPack = pack;
        else s.crisisPack = null;
        s.crisisStockAnswers = {};
        (window as any).goToStage('stage-v4-classify');
    }, opts?.withPack ? TEST_PACK : null);
    await expect(page.locator('#stage-v4-classify.active')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#v4-view-damage')).toBeVisible();
}

async function clearQueue(page: Page) {
    await page.evaluate(async () => {
        const items = await (window as any).__crispGetAllQueued();
        for (const it of items) { try { await (window as any).__crispDequeueReport(it.client_report_id); } catch (_) {} }
    });
}

/** Damage → infra (the first two hardcoded chips). */
async function pickDamageInfra(page: Page) {
    await page.locator('#v4-view-damage .v4-q-opt[data-value="COMPLETE"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 1500 });
    await page.locator('#v4-view-infra .v4-hit-tile[data-value="RESIDENTIAL"]').click();
}
/** Click the crisis tile (default flow only — skipped inside a canonical zone). */
async function pickCrisis(page: Page) {
    await expect(page.locator('#v4-view-crisis')).toBeVisible({ timeout: 1500 });
    await page.waitForSelector('#v4-cause-grid .v4-cause-tile[data-value="WILDFIRE"]', { timeout: 3000 });
    await page.locator('#v4-cause-grid .v4-cause-tile[data-value="WILDFIRE"]').click();
}

async function submitAndReadMeta(page: Page): Promise<any> {
    return await page.evaluate(async () => {
        try { await (window as any).__crispSubmitReport(); } catch (_) {}
        await new Promise((r) => setTimeout(r, 120));
        const items = await (window as any).__crispGetAllQueued();
        return items.length ? (items[0].meta || null) : null;
    });
}

test.describe('PWA — Dynamic Crisis Forms renderer (geo-gated)', () => {

    test('@smoke active pack → crisispack sub-step renders + answers reach meta.form_data', async ({ page }) => {
        await bootClassify(page, { withPack: true });
        await clearQueue(page);
        await pickDamageInfra(page);

        // Pack crisis_type is canonical (WILDFIRE) → the "what caused it" step is
        // SKIPPED: infra auto-advances straight to the crisispack sub-step. The
        // crisis chip view is never shown.
        await expect(page.locator('#v4-view-crisispack')).toBeVisible({ timeout: 2000 });
        await expect(page.locator('#v4-view-crisis:visible')).toHaveCount(0);
        await expect(page.locator('#stage-v4-review.active')).toHaveCount(0);

        // It renders ONLY the extra fields (stock + non-chip maps_to), NOT the
        // crisis_type / damage_classification chips already captured upstream.
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="flames_visible"]')).toBeVisible();
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="smoke_density"]')).toBeVisible();
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="debris_clearing_needed"]')).toBeVisible();
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="notes"]')).toBeVisible();
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="crisis_type"]')).toHaveCount(0);
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="damage_classification"]')).toHaveCount(0);

        // Continue is gated until the required pack question (flames_visible) is answered.
        await expect(page.locator('#btn-v4-classify-next')).toBeDisabled();
        await page.locator('#v4-view-crisispack .v4-cp-q[data-key="flames_visible"] .v4-cp-opt[data-val="true"]').click();
        await page.locator('#v4-view-crisispack .v4-cp-q[data-key="debris_clearing_needed"] .v4-cp-opt[data-val="false"]').click();
        await page.locator('#v4-view-crisispack .v4-cp-q[data-key="smoke_density"] .v4-cp-opt[data-val="HEAVY"]').click();
        await expect(page.locator('#btn-v4-classify-next')).toBeEnabled();

        // Continue → review → submit.
        await page.locator('#btn-v4-classify-next').click();
        await expect(page.locator('#stage-v4-review.active')).toBeVisible({ timeout: 2000 });

        const meta = await submitAndReadMeta(page);
        expect(meta, 'a queue item should exist').not.toBeNull();
        expect(meta.form_pack_id).toBe('pk-test-wildfire');
        expect(meta.form_pack_version).toBe(3);
        expect(meta.form_data, 'form_data must be present').toBeTruthy();
        // Stock answers (from the crisispack view).
        expect(meta.form_data.flames_visible).toBe(true);
        expect(meta.form_data.smoke_density).toBe('HEAVY');
        // maps_to NOT captured by chips → sourced from the pack view, keyed by field.key.
        expect(meta.form_data.debris_clearing_needed).toBe(false);
        // maps_to captured by the default chips → sourced from canonical state.
        expect(meta.form_data.crisis_type).toBe('WILDFIRE');
        expect(meta.form_data.damage_classification).toBe('COMPLETE');
        // The canonical columns are STILL populated for parity (must-have #1).
        expect(meta.crisis_type).toBe('WILDFIRE');
        expect(meta.damage_classification).toBe('COMPLETE');
        expect(meta.infrastructure_type).toBe('RESIDENTIAL');
    });

    test('@smoke no pack → crisis auto-advances to review + meta.form_pack_id is null', async ({ page }) => {
        await bootClassify(page, { withPack: false });
        await clearQueue(page);
        await pickDamageInfra(page);
        await pickCrisis(page);

        // Default flow: crisis tap auto-advances straight to review (no extra step).
        await expect(page.locator('#stage-v4-review.active')).toBeVisible({ timeout: 2000 });
        await expect(page.locator('#v4-view-crisispack:visible')).toHaveCount(0);

        const meta = await submitAndReadMeta(page);
        expect(meta).not.toBeNull();
        expect(meta.form_pack_id ?? null).toBeNull();
        expect(meta.form_data ?? null).toBeNull();
        // Default chips still round-trip (parity).
        expect(meta.crisis_type).toBe('WILDFIRE');
        expect(meta.damage_classification).toBe('COMPLETE');
        expect(meta.infrastructure_type).toBe('RESIDENTIAL');
    });
});
