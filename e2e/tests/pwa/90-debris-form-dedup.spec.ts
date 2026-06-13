/**
 * No duplicate debris question (Jun 2026).
 *
 * The review surface ("Send to UNDP") carries a REQUIRED debris card
 * (#v4-debris-card). But a DEPLOYED geo-scoped crisis form can also ask the
 * debris question — a field that maps_to 'debris_clearing_needed'. When it does,
 * the standalone card is a duplicate: the form's answer already becomes
 * report.debris_clearing_needed at submit. This pins that the review-page card is
 * suppressed (and its submit gate skipped) exactly when the deployed form asks it.
 */
import { test, expect } from '@playwright/test';

async function bootReview(page) {
    await page.goto('index.html');
    await page.evaluate(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_lang_manual', 'en');
        localStorage.setItem('crisp_lang', 'en');
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
        const fn = (window as any).__crispGoToStage;
        if (typeof fn === 'function') fn('stage-v4-review');
    });
    await page.waitForTimeout(450);
}

const PACK_WITH_DEBRIS = {
    pack_id: 'p1', pack_version: 1, event_id: 'e1', crisis_type: 'EARTHQUAKE',
    schema: { key: 'eq', title: 'Quake', sections: [{ id: 's1', stage: 2, fields: [
        { key: 'debris_q', type: 'yes_no', label: 'Debris blocking the area?', maps_to: 'debris_clearing_needed' },
        { key: 'note', type: 'short_text', label: 'Note' },
    ] }] },
};
const PACK_NO_DEBRIS = {
    pack_id: 'p2', pack_version: 1, event_id: 'e2', crisis_type: 'FLOOD',
    schema: { key: 'fl', title: 'Flood', sections: [{ id: 's1', stage: 2, fields: [
        { key: 'water_depth', type: 'integer', label: 'Water depth (cm)' },
    ] }] },
};

function applyPack(page, pack) {
    return page.evaluate((p) => {
        (window as any).state.crisisPack = p;
        (window as any).__crispV4RenderDebrisCard();
    }, pack);
}

test.describe('Debris card — no duplicate when the deployed form asks it', () => {
    test('default flow (no crisis pack): the review debris card is shown + required', async ({ page }) => {
        await bootReview(page);
        await page.evaluate(() => { (window as any).__crispV4RenderDebrisCard(); });
        expect(await page.evaluate(() => (window as any).__crispV4PackCollectsDebris())).toBe(false);
        await expect(page.locator('#v4-debris-card')).toBeVisible();
    });

    test('deployed form HAS a debris field → the review debris card is suppressed', async ({ page }) => {
        await bootReview(page);
        await applyPack(page, PACK_WITH_DEBRIS);
        expect(await page.evaluate(() => (window as any).__crispV4PackCollectsDebris())).toBe(true);
        await expect(page.locator('#v4-debris-card')).toBeHidden();
    });

    test('deployed form WITHOUT a debris field → the review debris card still shows', async ({ page }) => {
        await bootReview(page);
        await applyPack(page, PACK_NO_DEBRIS);
        expect(await page.evaluate(() => (window as any).__crispV4PackCollectsDebris())).toBe(false);
        await expect(page.locator('#v4-debris-card')).toBeVisible();
    });
});
