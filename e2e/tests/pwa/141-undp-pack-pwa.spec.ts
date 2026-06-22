/**
 * UNDP Appendix-1 mandatory questions — PWA delivery (v354).
 *
 * The 3 required multi-select questions (electricity / health / pressing-needs +
 * "Other, please specify") are delivered through the geo-gated crisis-form pack:
 *   - they render in the crisispack classify sub-step as multi-selects;
 *   - the required-gate blocks advancement until all three are answered;
 *   - selecting "Other" on pressing-needs reveals a conditional free-text sibling
 *     (and clearing it hides + clears the field again);
 *   - in a PACK REGION the legacy "additional information" review-page sheet
 *     trigger is HIDDEN (the pack collects it — no double-ask).
 *
 * Self-contained: stubs /crisis-forms/active with a UNDP-shaped schema, no DB.
 */
import { test, expect } from '@playwright/test';

const UNDP_SCHEMA = {
    schema_version: 1, key: 'undp-core-damage-assessment', title: 'UNDP Core Damage Assessment',
    sections: [{
        id: 'details', stage: 3, title: 'Impact assessment', fields: [
            {
                key: 'electricity_condition', type: 'multi_select', required: true,
                channels: ['APP', 'ANDROID', 'WHATSAPP', 'TELEGRAM'],
                label: 'Electricity infrastructure condition?',
                options: [
                    { value: 'NO_DAMAGE', label: 'No damage observed' },
                    { value: 'SEVERE', label: 'Severe damage' },
                    { value: 'DESTROYED', label: 'Completely destroyed' },
                    { value: 'UNKNOWN', label: 'Unknown/cannot be assessed' },
                ],
            },
            {
                key: 'health_services_status', type: 'multi_select', required: true,
                channels: ['APP', 'ANDROID', 'WHATSAPP', 'TELEGRAM'],
                label: 'Functioning of health services?',
                options: [
                    { value: 'FULLY_FUNCTIONAL', label: 'Fully functional' },
                    { value: 'LARGELY_DISRUPTED', label: 'Largely disrupted' },
                    { value: 'UNKNOWN', label: 'Unknown' },
                ],
            },
            {
                key: 'pressing_needs', type: 'multi_select', required: true,
                channels: ['APP', 'ANDROID', 'WHATSAPP', 'TELEGRAM'],
                label: 'Most pressing needs?',
                options: [
                    { value: 'FOOD_WATER', label: 'Food and water' },
                    { value: 'HEALTHCARE', label: 'Healthcare' },
                    { value: 'OTHER', label: 'Other, please specify', other: true },
                ],
            },
            {
                key: 'pressing_needs_other', type: 'short_text', required: false,
                channels: ['APP', 'ANDROID', 'WHATSAPP', 'TELEGRAM'],
                label: 'Please specify the other pressing need',
                validation: { max_length: 200 },
                show_if: { field: 'pressing_needs', includes: 'OTHER' },
            },
        ],
    }],
};

async function bootWithPack(page) {
    await page.route('**/crisis-forms/active*', (route) => route.fulfill({
        json: {
            active: true, pack_id: 'undp-core-damage-assessment', pack_version: 1,
            event_id: 'ev-undp', crisis_type: 'FLOOD', schema_json: UNDP_SCHEMA,
        },
    }));
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang_manual', 'en');
        localStorage.setItem('crisp_lang', 'en');
    });
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function'
            && typeof (window as any).__crispV4OnLocationReeval === 'function'
            && typeof (window as any).__crispV4ShowSubStep === 'function'
            && typeof (window as any).__crispV4CanAdvance === 'function',
        null, { timeout: 8000 },
    );
    await page.evaluate(() => { (window as any).state.location = { lat: 12.9716, lng: 77.5946 }; });
    await page.evaluate(() => { (window as any).__crispGoToStage('stage-v4-classify'); });
    await page.evaluate(() => { (window as any).__crispV4OnLocationReeval(12.9716, 77.5946); });
    // Wait for the pack to resolve, then render the crisispack sub-step.
    await expect.poll(() => page.evaluate(() => !!((window as any).state || {}).crisisPack),
        { timeout: 5000 }).toBe(true);
    await page.evaluate(() => { (window as any).__crispV4ShowSubStep('crisispack'); });
    await expect(page.locator('#v4-view-crisispack')).toBeVisible({ timeout: 4000 });
}

const Q = (k: string) => `#v4-view-crisispack .v4-cp-q[data-key="${k}"]`;

test.describe('UNDP mandatory questions — PWA pack delivery (v354)', () => {
    test('the 3 required multi-selects render in the crisispack sub-step', async ({ page }) => {
        await bootWithPack(page);
        await expect(page.locator(Q('electricity_condition'))).toBeVisible();
        await expect(page.locator(Q('health_services_status'))).toBeVisible();
        await expect(page.locator(Q('pressing_needs'))).toBeVisible();
        // electricity offers its 4 multi-select options.
        await expect(page.locator(`${Q('electricity_condition')} .v4-cp-opt`)).toHaveCount(4);
    });

    test('required-gate blocks advancement until all 3 are answered', async ({ page }) => {
        await bootWithPack(page);
        expect(await page.evaluate(() => (window as any).__crispV4CanAdvance('crisispack'))).toBe(false);
        await page.locator(`${Q('electricity_condition')} .v4-cp-opt`).first().click();
        await page.locator(`${Q('health_services_status')} .v4-cp-opt`).first().click();
        expect(await page.evaluate(() => (window as any).__crispV4CanAdvance('crisispack'))).toBe(false);
        await page.locator(`${Q('pressing_needs')} .v4-cp-opt`).first().click();
        expect(await page.evaluate(() => (window as any).__crispV4CanAdvance('crisispack'))).toBe(true);
    });

    test('selecting "Other" reveals a conditional free-text; clearing hides + clears it', async ({ page }) => {
        await bootWithPack(page);
        const cond = page.locator('#v4-view-crisispack .v4-cp-cond[data-key="pressing_needs_other"]');
        await expect(cond).toBeHidden();
        // Click the OTHER option (last option of pressing_needs).
        await page.locator(`${Q('pressing_needs')} .v4-cp-opt[data-val="OTHER"]`).click();
        await expect(cond).toBeVisible();
        await cond.locator('.v4-cp-input').fill('fuel for generators');
        expect(await page.evaluate(() => ((window as any).state.crisisStockAnswers || {}).pressing_needs_other)).toBe('fuel for generators');
        // Deselect OTHER → conditional hides AND its stored value is cleared.
        await page.locator(`${Q('pressing_needs')} .v4-cp-opt[data-val="OTHER"]`).click();
        await expect(cond).toBeHidden();
        expect(await page.evaluate(() => ((window as any).state.crisisStockAnswers || {}).pressing_needs_other)).toBeFalsy();
    });

    test('legacy "additional information" sheet trigger is hidden in a pack region', async ({ page }) => {
        await bootWithPack(page);
        await page.evaluate(() => { (window as any).__crispV4SyncUndpTrigger(); });
        // The trigger exists in the review DOM but is display:none when a pack is active.
        await expect(page.locator('#btn-v4-open-undp')).toBeHidden();
    });

    test('offline-first: a cached pack still renders the mandatory questions with no network', async ({ page }) => {
        // 1) Online: resolve + cache the pack for this spot.
        await bootWithPack(page);
        expect(await page.evaluate(() => !!localStorage.getItem('crisp_active_pack_v1'))).toBe(true);
        // 2) Go offline: /crisis-forms/active now fails, and we clear the in-memory pack.
        await page.unroute('**/crisis-forms/active*');
        await page.route('**/crisis-forms/active*', (route) => route.abort());
        await page.evaluate(() => { (window as any).state.crisisPack = null; });
        // 3) Re-evaluate at the SAME spot → the cached pack is restored (must-have #3).
        await page.evaluate(() => { (window as any).__crispV4OnLocationReeval(12.9716, 77.5946); });
        await expect.poll(() => page.evaluate(() => !!((window as any).state || {}).crisisPack),
            { timeout: 5000 }).toBe(true);
        await page.evaluate(() => { (window as any).__crispV4ShowSubStep('crisispack'); });
        await expect(page.locator(Q('electricity_condition'))).toBeVisible({ timeout: 4000 });
        await expect(page.locator(Q('pressing_needs'))).toBeVisible();
    });
});
