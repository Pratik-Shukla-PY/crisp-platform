/**
 * Building selection — a manually typed name enables Continue (v353).
 *
 * Bug: the fullscreen picker's Continue/confirm enabled ONLY when an OSM footprint
 * was tapped (state.buildingOsmElement). OSM has no nearby footprint everywhere, so
 * a reporter who typed a name was stuck. Now a valid manual name (must-have #6
 * free-text fallback) enables Continue and commits infrastructure_name +
 * infrastructure_name_from_osm=false.
 */
import { test, expect } from '@playwright/test';

async function bootReview(page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang_manual', 'en');
        localStorage.setItem('crisp_lang', 'en');
    });
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function' && typeof (window as any).state === 'object',
        null, { timeout: 8000 },
    );
    // A location lets the picker mount its map without a real Overpass call.
    await page.evaluate(() => { (window as any).state.location = { lat: 12.9716, lng: 77.5946 }; });
    await page.evaluate(() => { (window as any).__crispGoToStage('stage-v4-review'); });
    await page.waitForTimeout(450);
}

test('typing a building name enables Continue; clearing it disables again', async ({ page }) => {
    await bootReview(page);
    // Clean building state - a fresh report has none (jumping straight to review via
    // the test hook skips the normal capture-flow reset, so do it explicitly).
    await page.evaluate(() => {
        const s = (window as any).state;
        s.infraName = ''; s.infraNameFromOsm = false; s.buildingId = null; s.buildingOsmElement = null;
    });
    // Open the fullscreen building picker.
    await page.locator('#btn-building-fs-open').click();
    await expect(page.locator('#building-fs-overlay')).toHaveClass(/is-open/, { timeout: 6000 });

    const confirm = page.locator('#btn-building-fs-confirm');
    const input = page.locator('#input-infra-name-v3');
    // No selection yet (clean state, no OSM tap) → Continue disabled.
    await expect(confirm).toBeDisabled();

    // Type a building name into the (reparented) free-text field.
    await input.fill('Riverside Apartments');
    // Continue is now enabled — manual entry is a valid selection (THE fix).
    await expect(confirm).toBeEnabled();

    // State carries the free-text name + the not-from-OSM flag (must-have #6).
    const st = await page.evaluate(() => ({
        name: (window as any).state.infraName,
        fromOsm: (window as any).state.infraNameFromOsm,
    }));
    expect(st.name).toBe('Riverside Apartments');
    expect(st.fromOsm).toBe(false);

    // Clearing the name disables Continue again (empty is not valid).
    await input.fill('');
    await expect(confirm).toBeDisabled();
});
