/**
 * V4 Classify "What was hit?" — the "Other / not listed" free-text path now has
 * an explicit ✓ confirm button next to the input (Jun 2026). Preset tiles
 * auto-advance on tap; the free-text path previously only advanced on Enter/blur
 * (invisible → confusing). This pins:
 *   1. Selecting OTHER reveals the input + a ✓ button that starts DISABLED.
 *   2. Typing enables the ✓ button; clearing disables it.
 *   3. The input + button fit on iPhone SE (375px) with no horizontal overflow
 *      (device-matrix responsiveness intact).
 *   4. Tapping ✓ commits infrastructure_name and advances off the infra view.
 */
import { test, expect, type Page } from './_fixtures';

const IPHONE_SE = { width: 375, height: 667 };

async function openInfraView(page: Page) {
    await page.setViewportSize(IPHONE_SE);
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.route('**/api/v1/reports/nearby**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ groups: [] }) }));
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).goToStage === 'function' && typeof (window as any).state === 'object',
        null, { timeout: 8000 });
    await page.evaluate(() => {
        (window as any).state = (window as any).state || {};
        (window as any).state.photoDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
        (window as any).state.v4Photos = [(window as any).state.photoDataUrl];
        (window as any).state.location = { lat: 12.9716, lng: 77.5946, acc: 35 };
        (window as any).goToStage('stage-v4-classify');
    });
    await expect(page.locator('#stage-v4-classify.active')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#v4-view-damage')).toBeVisible();
    await page.locator('#v4-view-damage .v4-q-opt[data-value="PARTIAL"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 2000 });
}

test.describe('PWA — V4 infra "Other" confirm button', () => {
    test('@smoke OTHER reveals input + ✓ button; button gates on text', async ({ page }) => {
        await openInfraView(page);
        await page.locator('#v4-view-infra .v4-hit-tile[data-value="OTHER"]').click();
        await expect(page.locator('#v4-infra-other-prompt')).toBeVisible();
        const btn = page.locator('#v4-infra-other-confirm');
        await expect(btn).toBeVisible();
        await expect(btn).toBeDisabled();                      // nothing to confirm yet
        await page.locator('#v4-infra-other-input').fill('cell tower');
        await expect(btn).toBeEnabled();                       // lights up once there's text
        await page.locator('#v4-infra-other-input').fill('');
        await expect(btn).toBeDisabled();                      // back to muted when cleared
    });

    test('@smoke input + ✓ fit on iPhone SE with no horizontal overflow', async ({ page }) => {
        await openInfraView(page);
        await page.locator('#v4-view-infra .v4-hit-tile[data-value="OTHER"]').click();
        await page.locator('#v4-infra-other-input').fill('religious site by the river');
        const fit = await page.evaluate(() => {
            const row = document.querySelector('.v4-other-prompt-row') as HTMLElement | null;
            const btn = document.getElementById('v4-infra-other-confirm') as HTMLElement | null;
            if (!row || !btn) return null;
            const b = btn.getBoundingClientRect();
            return {
                rowOverflowX: row.scrollWidth - row.clientWidth,
                btnRight: b.right, vw: window.innerWidth,
                btnVisible: b.width > 0 && b.height > 0,
            };
        });
        expect(fit, 'row + button must exist').not.toBeNull();
        expect(fit!.rowOverflowX, 'row must not overflow horizontally').toBeLessThanOrEqual(2);
        expect(fit!.btnRight, 'button must stay within the viewport').toBeLessThanOrEqual(fit!.vw + 1);
        expect(fit!.btnVisible, 'button must have non-zero size').toBe(true);
    });

    test('@smoke tapping ✓ commits infrastructure_name + advances off infra', async ({ page }) => {
        await openInfraView(page);
        await page.locator('#v4-view-infra .v4-hit-tile[data-value="OTHER"]').click();
        await page.locator('#v4-infra-other-input').fill('agricultural shed');
        await page.locator('#v4-infra-other-confirm').click();
        await expect(page.locator('#v4-view-infra')).toBeHidden({ timeout: 2000 });
        const committed = await page.evaluate(() => ({
            type: (window as any).state.infrastructure_type,
            name: (window as any).state.infrastructure_name,
        }));
        expect(committed.type).toBe('OTHER');
        expect(committed.name).toBe('agricultural shed');
    });
});
