/**
 * PWA — REAL-DOM coverage for the three edited-location re-eval EDGE paths
 * (follow-up to spec 125 / commit b59c646):
 *
 *   1. FREE-TEXT edit — the reporter types a place but does NOT tap a suggestion.
 *      _saveLocEdit now resolves coordinates from the rendered suggestions / the
 *      bundled+cached DB (and, online, Nominatim) and re-homes the report.
 *   2. UNRESOLVABLE free-text — no coords can be found (offline, gibberish): the
 *      name is saved but coords stay on device GPS (never {0,0}) and a hint toast
 *      tells the user to pick a suggestion.
 *   3. GPS-RETRY material move — tapping the GPS-refresh button after physically
 *      moving into a new zone re-runs the authoritative re-eval (swaps the pack +
 *      clears the previous zone's stock answers); a same-spot refresh would not.
 */
import { test, expect, Page } from '@playwright/test';

const PACK_A = {
    active: true, pack_id: 'pk-A-wildfire', pack_version: 1, event_id: 'ev-A', crisis_type: 'WILDFIRE',
    schema_json: { schema_version: 1, key: 'a-wf', title: 'Wildfire — rapid assessment',
        sections: [{ id: 'cp', stage: 2, fields: [{ key: 'flames_visible', type: 'yes_no', label: 'Flames visible?', required: false }] }] },
};
const PACK_B = {
    active: true, pack_id: 'pk-B-flood', pack_version: 1, event_id: 'ev-B', crisis_type: 'FLOOD',
    schema_json: { schema_version: 1, key: 'b-fl', title: 'Flood — rapid assessment',
        sections: [{ id: 'cp', stage: 2, fields: [{ key: 'water_depth', type: 'single_select', label: 'Water depth?', required: false,
            options: [{ value: 'KNEE', label: 'Knee' }, { value: 'WAIST', label: 'Waist' }] }] }] },
};

const A_LAT = 11.668, A_LNG = 76.634;
const B_LAT = 22.0, B_LNG = 78.0;

async function boot(page: Page): Promise<{ pageErrors: string[] }> {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String((e as any).message || e)));
    await page.addInitScript(([aLat, aLng]) => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
        localStorage.setItem('crisp_last_location_v2', JSON.stringify({ lat: aLat, lng: aLng, acc: 30, ts: Date.now() }));
        // Mutable GPS source so a test can simulate a physical move before tapping
        // the GPS-refresh button. Pin to zone A so the default Bengaluru fix can't
        // clobber the device pack with a no-zone /active.
        (window as any).__gpsCoords = { latitude: aLat, longitude: aLng, accuracy: 30 };
        const stub = (ok: any) => { try { ok({ coords: (window as any).__gpsCoords, timestamp: Date.now() }); } catch (_) {} };
        try {
            const geo = { getCurrentPosition: stub, watchPosition: () => 0, clearWatch: () => {} };
            Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => geo });
        } catch (_) { try { (navigator.geolocation as any).getCurrentPosition = stub; } catch (__) {} }
    }, [A_LAT, A_LNG]);
    await page.route('**/api/v1/reports/nearby**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"groups":[]}' }));
    await page.route('**/api/v1/reports/meta', (r) => r.fulfill({ status: 503, body: '{"detail":"blocked"}' }));
    await page.route('**nominatim**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/v1/crisis-forms/active**', (r) => {
        const u = new URL(r.request().url());
        const lat = parseFloat(u.searchParams.get('lat') || '0');
        let body = JSON.stringify({ active: false });
        if (Math.abs(lat - A_LAT) < 0.3) body = JSON.stringify(PACK_A);
        else if (Math.abs(lat - B_LAT) < 0.5) body = JSON.stringify(PACK_B);
        r.fulfill({ status: 200, contentType: 'application/json', body });
    });
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).goToStage === 'function' && (window as any).state && !!(window as any).placeSearch,
        null, { timeout: 8000 });
    return { pageErrors };
}

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

test.describe('PWA — edited-location edge paths (real DOM)', () => {

    test('@smoke free-text edit (no suggestion tapped) still resolves coords + re-homes the pack', async ({ page }) => {
        const { pageErrors } = await boot(page);
        await landOnCaptureInZoneA(page);

        await page.locator('#btn-v4-loc-edit').click();
        await expect(page.locator('#v4-meta-loc-edit')).toBeVisible();
        // Zone-B place is searchable, but the user will NOT tap the suggestion.
        await page.evaluate(([name, lat, lng]) => {
            (window as any).placeSearch.cacheResult(name as string, [{ name, region: 'Goa', country: 'India', lat, lng }]);
        }, ['Panaji', B_LAT, B_LNG] as any);
        await page.locator('#v4-meta-loc-input').fill('Panaji');
        await page.locator('#v4-meta-loc-input').dispatchEvent('input');
        await expect(page.locator('#v4-meta-loc-suggest .v4-meta-loc-suggest-item').first()).toBeVisible({ timeout: 3000 });
        // Save WITHOUT tapping the suggestion (_locSelected stays null).
        await page.locator('#btn-v4-loc-save').click();

        expect(pageErrors).toEqual([]);
        // Coordinates were resolved from the rendered suggestion → pack re-homed.
        await page.waitForFunction(
            () => (window as any).state.crisisPack && (window as any).state.crisisPack.pack_id === 'pk-B-flood',
            null, { timeout: 5000 });
        const loc = await page.evaluate(() => (window as any).state.location);
        expect(loc.lat).toBeCloseTo(B_LAT, 3);
        expect(loc.is_user_corrected).toBe(true);
        await expect(page.locator('#toast-notification')).toContainText('refreshed', { timeout: 2000 });
    });

    test('@smoke unresolvable free-text → name saved, coords stay on device, hint toast', async ({ page }) => {
        await boot(page);
        await landOnCaptureInZoneA(page);
        const before = await page.evaluate(() => (window as any).state.location);

        // Force offline so no remote resolve fires; type a place that matches
        // nothing local.
        await page.evaluate(() => { try { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); } catch (_) {} });
        await page.locator('#btn-v4-loc-edit').click();
        await expect(page.locator('#v4-meta-loc-edit')).toBeVisible();
        await page.locator('#v4-meta-loc-input').fill('Zzxqunknownplace');
        await page.locator('#v4-meta-loc-input').dispatchEvent('input');
        await page.locator('#btn-v4-loc-save').click();

        // The hint toast appears; coords are UNCHANGED (no {0,0}); name is saved.
        await expect(page.locator('#toast-notification')).toContainText('Saved the name only', { timeout: 3000 });
        const after = await page.evaluate(() => ({ loc: (window as any).state.location, name: (window as any).state.userLocationName, pack: (window as any).state.crisisPack?.pack_id }));
        expect(after.loc.lat).toBeCloseTo(before.lat, 4);   // device coords kept
        expect(after.loc.lng).toBeCloseTo(before.lng, 4);
        expect(after.name).toBe('Zzxqunknownplace');
        expect(after.pack).toBe('pk-A-wildfire');           // device pack unchanged
    });

    test('@smoke GPS-retry into a new zone re-evals (swaps pack + clears stale answers)', async ({ page }) => {
        const { pageErrors } = await boot(page);
        await landOnCaptureInZoneA(page);
        // Simulate the reporter having answered the device zone's pack.
        await page.evaluate(() => { (window as any).state.crisisStockAnswers = { flames_visible: true }; });

        // Physically move into zone B, then tap the GPS-refresh button.
        await page.evaluate(([bLat, bLng]) => { (window as any).__gpsCoords = { latitude: bLat, longitude: bLng, accuracy: 30 }; }, [B_LAT, B_LNG]);
        await page.locator('#btn-v4-retry-gps').click();

        expect(pageErrors).toEqual([]);
        await page.waitForFunction(
            () => (window as any).state.crisisPack && (window as any).state.crisisPack.pack_id === 'pk-B-flood',
            null, { timeout: 6000 });
        const s = await page.evaluate(() => ({ answers: (window as any).state.crisisStockAnswers, loc: (window as any).state.location }));
        expect(s.answers).toEqual({});                       // previous zone's answers cleared
        expect(s.loc.lat).toBeCloseTo(B_LAT, 3);
        await expect(page.locator('#toast-notification')).toContainText('refreshed', { timeout: 2000 });
    });
});
