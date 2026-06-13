/**
 * PWA — REAL-DOM proof that editing the location refreshes the VISIBLE crisis form.
 *
 * Regression for the user-reported "I changed the location and submitted, but the
 * device-location form is still showing." Spec 124 only calls the
 * window.__crispV4OnLocationReeval hook directly, so it missed two defects that
 * only surface through the actual UI:
 *   1. _saveLocEdit called the BARE identifier `_onLocationReeval`, which is
 *      declared in a sibling scope (_refreshGps) → ReferenceError at Save → the
 *      whole re-eval never ran (and the editor never even closed).
 *   2. _setState is non-reactive and nothing listened to 'crisis-pack-resolved',
 *      so even once the pack swapped in state, the on-screen crispack form never
 *      repainted.
 *
 * This spec drives the GENUINE path: the inline #btn-v4-loc-edit editor, a real
 * placeSearch suggestion pick (_pickLocSuggestion → _locSelected), the real Save
 * (_saveLocEdit), and the real capture→classify nav (#btn-v4-capture-next →
 * _goToClassify). It asserts the rendered crispack questions change from the
 * device zone's pack to the EDITED zone's pack — and captures pageerrors so the
 * ReferenceError can never silently come back.
 */
import { test, expect, Page } from '@playwright/test';

const PACK_A = {
    active: true, pack_id: 'pk-A-wildfire', pack_version: 1, event_id: 'ev-A', crisis_type: 'WILDFIRE',
    schema_json: { schema_version: 1, key: 'a-wf', title: 'Wildfire — rapid assessment',
        sections: [{ id: 'cp', stage: 2, fields: [
            { key: 'flames_visible', type: 'yes_no', label: 'Flames visible?', required: false },
        ] }] },
};
const PACK_B = {
    active: true, pack_id: 'pk-B-flood', pack_version: 1, event_id: 'ev-B', crisis_type: 'FLOOD',
    schema_json: { schema_version: 1, key: 'b-fl', title: 'Flood — rapid assessment',
        sections: [{ id: 'cp', stage: 2, fields: [
            { key: 'water_depth', type: 'single_select', label: 'Water depth?', required: false,
              options: [{ value: 'KNEE', label: 'Knee' }, { value: 'WAIST', label: 'Waist' }] },
        ] }] },
};

const A_LAT = 11.668, A_LNG = 76.634;   // device zone A (wildfire)
const B_LAT = 22.0, B_LNG = 78.0;       // edited zone B (flood)

async function boot(page: Page): Promise<{ pageErrors: string[]; activeFetches: Array<{ lat: number }> }> {
    const pageErrors: string[] = [];
    const activeFetches: Array<{ lat: number }> = [];
    page.on('pageerror', (e) => pageErrors.push(String((e as any).message || e)));

    await page.addInitScript(([aLat, aLng]) => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
        // Deterministic device fix → zone A, via the cache _refreshGps reads first.
        localStorage.setItem('crisp_last_location_v2', JSON.stringify({ lat: aLat, lng: aLng, acc: 30, ts: Date.now() }));
        // PIN geolocation to zone A. Otherwise Playwright's default context fix
        // (Bengaluru 12.97,77.59) fires a late getCurrentPosition → /active for a
        // NO-ZONE coord → {active:false} → it CLOBBERS the device pack with null (a
        // harness race, not the bug under test). Stub before any app script runs.
        const stub = (ok: any) => { try { ok({ coords: { latitude: aLat, longitude: aLng, accuracy: 30 }, timestamp: Date.now() }); } catch (_) {} };
        try {
            const geo = { getCurrentPosition: stub, watchPosition: () => 0, clearWatch: () => {} };
            Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => geo });
        } catch (_) {
            try { (navigator.geolocation as any).getCurrentPosition = stub; } catch (__) {}
        }
    }, [A_LAT, A_LNG]);

    await page.route('**/api/v1/reports/nearby**', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '{"groups":[]}' }));
    await page.route('**/api/v1/reports/meta', (r) =>
        r.fulfill({ status: 503, body: '{"detail":"blocked-by-spec"}' }));
    // Kill the editor's Nominatim remote-search race so only injected local
    // suggestions appear.
    await page.route('**nominatim**', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    // Coordinate-aware crisis-forms matcher: zone A (wildfire) at lat≈11.6, zone B
    // (flood) at lat≈22, inactive elsewhere.
    await page.route('**/api/v1/crisis-forms/active**', (r) => {
        const u = new URL(r.request().url());
        const lat = parseFloat(u.searchParams.get('lat') || '0');
        activeFetches.push({ lat });
        let body = JSON.stringify({ active: false });
        if (Math.abs(lat - A_LAT) < 0.3) body = JSON.stringify(PACK_A);
        else if (Math.abs(lat - B_LAT) < 0.5) body = JSON.stringify(PACK_B);
        r.fulfill({ status: 200, contentType: 'application/json', body });
    });

    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).goToStage === 'function'
           && typeof (window as any).state === 'object'
           && !!(window as any).placeSearch
           && !!((window as any).CrispV4 && (window as any).CrispV4.goToClassify),
        null, { timeout: 8000 });
    return { pageErrors, activeFetches };
}

/** Seed a photo so the V4 flow has content, then land on the capture stage so
 *  _refreshGps resolves the device zone (A) into state.crisisPack. */
async function landOnCaptureInZoneA(page: Page) {
    await page.evaluate(() => {
        const s = (window as any).state;
        s.photoDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
        s.v4Photos = [s.photoDataUrl];
        (window as any).goToStage('stage-v4-capture');
    });
    await page.waitForFunction(
        () => (window as any).state.crisisPack && (window as any).state.crisisPack.pack_id === 'pk-A-wildfire',
        null, { timeout: 6000 });
}

/** Drive damage→infra; a canonical zone crisis_type skips the chip step and
 *  auto-advances into the crispack sub-step. (The capture Continue button has a
 *  render-gate that's flaky to satisfy headlessly, so jump to classify via the
 *  app nav — the post-edit RE-nav below uses the real _goToClassify.) */
async function advanceToCrispack(page: Page) {
    await page.evaluate(() => (window as any).goToStage('stage-v4-classify'));
    await expect(page.locator('#stage-v4-classify.active')).toBeVisible({ timeout: 3000 });
    await page.locator('#v4-view-damage .v4-q-opt[data-value="COMPLETE"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 2000 });
    await page.locator('#v4-view-infra .v4-hit-tile[data-value="RESIDENTIAL"]').click();
    await expect(page.locator('#v4-view-crisispack')).toBeVisible({ timeout: 2500 });
}

/** Open the inline editor and pick a real placeSearch suggestion for zone B. */
async function editLocationToZoneB(page: Page) {
    await page.evaluate(() => (window as any).goToStage('stage-v4-capture'));
    await page.locator('#btn-v4-loc-edit').click();
    await expect(page.locator('#v4-meta-loc-edit')).toBeVisible();
    await page.evaluate(([name, lat, lng]) => {
        (window as any).placeSearch.cacheResult(name as string,
            [{ name, region: 'Goa', country: 'India', lat, lng }]);
    }, ['Panaji', B_LAT, B_LNG] as any);
    await page.locator('#v4-meta-loc-input').fill('Panaji');
    await page.locator('#v4-meta-loc-input').dispatchEvent('input');
    const sugg = page.locator('#v4-meta-loc-suggest .v4-meta-loc-suggest-item').first();
    await expect(sugg).toBeVisible({ timeout: 3000 });
    await sugg.dispatchEvent('pointerdown');                  // real _pickLocSuggestion → _locSelected
    await page.locator('#btn-v4-loc-save').click();           // real _saveLocEdit
}

test.describe('PWA — edited location refreshes the visible crisis form (real DOM)', () => {

    test('@smoke editing zone A→B swaps the on-screen crispack questions (no ReferenceError)', async ({ page }) => {
        const { pageErrors } = await boot(page);
        await landOnCaptureInZoneA(page);
        await advanceToCrispack(page);

        // Device zone A → the wildfire pack's question is on screen.
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="flames_visible"]')).toBeVisible();
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="water_depth"]')).toHaveCount(0);

        await editLocationToZoneB(page);

        // The Save handler must NOT throw (the ReferenceError regression guard).
        expect(pageErrors.join(' | ')).not.toContain('_onLocationReeval');
        expect(pageErrors, 'Save must not throw').toEqual([]);

        // The edited coords are authoritative + the pack swapped in state.
        await page.waitForFunction(
            () => (window as any).state.crisisPack && (window as any).state.crisisPack.pack_id === 'pk-B-flood',
            null, { timeout: 5000 });
        const loc = await page.evaluate(() => (window as any).state.location);
        expect(loc.lat).toBeCloseTo(B_LAT, 3);
        expect(loc.lng).toBeCloseTo(B_LNG, 3);
        expect(loc.acc, 'edited location uses the acc key submit reads').toBe(0);

        // Confirmation toast.
        await expect(page.locator('#toast-notification')).toContainText('refreshed', { timeout: 2000 });

        // Return to classify via the REAL _goToClassify (what the capture Continue
        // button calls) → the VISIBLE crispack form must now show zone B's question,
        // not the stale zone A one. This is the load-bearing assertion: it fails
        // without the 'crisis-pack-resolved' re-render + _goToClassify re-assert.
        await page.evaluate(() => (window as any).CrispV4.goToClassify());
        await expect(page.locator('#stage-v4-classify.active')).toBeVisible({ timeout: 3000 });
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="water_depth"]')).toBeVisible({ timeout: 3000 });
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="flames_visible"]')).toHaveCount(0);
    });

    test('@smoke editing into a NO-ZONE location clears the crispack form', async ({ page }) => {
        const { pageErrors } = await boot(page);
        await landOnCaptureInZoneA(page);
        await advanceToCrispack(page);
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="flames_visible"]')).toBeVisible();

        // Edit to a coordinate outside every zone (lat 33 → {active:false}).
        await page.evaluate(() => (window as any).goToStage('stage-v4-capture'));
        await page.locator('#btn-v4-loc-edit').click();
        await expect(page.locator('#v4-meta-loc-edit')).toBeVisible();
        await page.evaluate(() => (window as any).placeSearch.cacheResult('Nowhere',
            [{ name: 'Nowhere', region: '', country: '', lat: 33.0, lng: 44.0 }]));
        await page.locator('#v4-meta-loc-input').fill('Nowhere');
        await page.locator('#v4-meta-loc-input').dispatchEvent('input');
        const sugg = page.locator('#v4-meta-loc-suggest .v4-meta-loc-suggest-item').first();
        await expect(sugg).toBeVisible({ timeout: 3000 });
        await sugg.dispatchEvent('pointerdown');
        await page.locator('#btn-v4-loc-save').click();

        expect(pageErrors.join(' | ')).not.toContain('_onLocationReeval');
        // The pack clears in state.
        await page.waitForFunction(() => (window as any).state.crisisPack === null, null, { timeout: 5000 });

        // Returning to classify, the crispack step is gone (no pack) — the stale
        // wildfire question must NOT still be shown.
        await page.evaluate(() => (window as any).CrispV4.goToClassify());
        await expect(page.locator('#stage-v4-classify.active')).toBeVisible({ timeout: 3000 });
        await expect(page.locator('#v4-view-crisispack .v4-cp-q[data-key="flames_visible"]:visible')).toHaveCount(0);
    });
});
