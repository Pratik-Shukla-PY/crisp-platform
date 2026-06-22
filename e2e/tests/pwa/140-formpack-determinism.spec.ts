/**
 * Region form-pack deployment — deterministic, no back-and-forth (v353).
 *
 * Bug: the crisis-form fetch is async/fire-and-forget while the classify renderer is
 * synchronous, so reaching the divergent step before the zone resolved showed the
 * wrong/default "What Caused It?" — the reporter had to navigate back-and-forth until
 * it corrected. Fix: a loading view on the divergent step while the zone resolves +
 * 'crisis-pack-resolved' fires on EVERY settle (success OR error) so it repaints to
 * the correct order automatically; offline/error degrades to the default flow.
 */
import { test, expect } from '@playwright/test';

async function bootClassify(page) {
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
           && typeof (window as any).__crispV4ShowSubStep === 'function',
        null, { timeout: 8000 },
    );
    await page.evaluate(() => { (window as any).state.location = { lat: 12.9716, lng: 77.5946 }; });
    await page.evaluate(() => { (window as any).__crispGoToStage('stage-v4-classify'); });
    await page.waitForTimeout(200);
}

test('divergent step shows a loading view while the zone resolves, then the correct form — no retries', async ({ page }) => {
    // The region pack: canonical FLOOD (so the "what caused it" chip is skipped) + an
    // extra field (so a crisis-pack sub-step is added). Delayed so it is in-flight.
    await page.route('**/crisis-forms/active*', async (route) => {
        await new Promise((r) => setTimeout(r, 1200));
        await route.fulfill({ json: {
            active: true, pack_id: 'p1', pack_version: 1, event_id: 'e1', crisis_type: 'FLOOD',
            schema_json: { title: 'Flood details', fields: [
                { key: 'water_level', type: 'single_select', label: 'Water level',
                  options: [{ value: 'knee', label: 'Knee' }, { value: 'waist', label: 'Waist' }] },
            ] },
        } });
    });
    await bootClassify(page);

    // Start the zone resolution, then immediately reach the divergent step.
    await page.evaluate(() => { (window as any).__crispV4OnLocationReeval(12.9716, 77.5946); });
    await page.evaluate(() => { (window as any).__crispV4ShowSubStep('crisis'); });

    // While in-flight: the loading view is shown (NOT the wrong "what caused it" chips).
    await expect(page.locator('#v4-view-pack-loading')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('#v4-view-crisis')).not.toBeVisible();

    // On settle: it auto-repaints to the correct region form (no user navigation),
    // and the loading view is gone.
    await expect.poll(async () => page.evaluate(() => !!((window as any).state || {}).crisisPack),
        { timeout: 4000 }).toBe(true);
    await expect(page.locator('#v4-view-pack-loading')).not.toBeVisible();
    // Canonical FLOOD auto-applied → the "what caused it" chip step stays skipped.
    expect(await page.evaluate(() => (window as any).state.crisis_type)).toBe('FLOOD');
});

test('offline / errored zone fetch degrades to the default flow (no stuck loading)', async ({ page }) => {
    await page.route('**/crisis-forms/active*', (route) => route.abort());
    await bootClassify(page);
    await page.evaluate(() => { (window as any).__crispV4OnLocationReeval(12.9716, 77.5946); });
    await page.evaluate(() => { (window as any).__crispV4ShowSubStep('crisis'); });
    // After the failed fetch settles, the default "what caused it" step is shown -
    // never stranded on the loading spinner.
    await expect(page.locator('#v4-view-crisis')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('#v4-view-pack-loading')).not.toBeVisible();
});
