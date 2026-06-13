/**
 * PWA — Edited location is AUTHORITATIVE: re-evaluate crisis-form / operation
 * assignment when the reporter corrects the location.
 *
 * Requirement: when a user edits/corrects the report location, the edited point
 * becomes the source of truth (priority: user-edited > GPS > device-fallback).
 * The PWA must immediately re-run crisis-form matching for the NEW coordinates,
 * show the form for the edited location (NOT the originally captured GPS), and
 * confirm with "Location updated. Applicable crisis form has been refreshed …".
 *
 * The V4 inline location editor (_saveLocEdit) calls the exposed hook
 * window.__crispV4OnLocationReeval(lat, lng), which: nulls the ~110 m jitter
 * guard (so a real edit always re-fetches), clears the previous zone's stock
 * answers, re-fetches /crisis-forms/active for the edited coords, and toasts.
 * _maybeFetchCrisisPack then swaps/clears state.crisisPack and the zone-auto
 * crisis_type (a HAND-PICKED crisis_type is preserved via state._crisisTypeAuto).
 *
 * This spec proves, by exercising the documented integration hook + the submit
 * payload (consistent with spec 121's state-driven style):
 *   1. Edit zone X → zone Y: /active re-fetched with the EDITED coords, the pack
 *      swaps to Y, the previous zone's stock answers are cleared, and the toast
 *      appears.
 *   2. Edit zone X → NO zone: the pack clears AND the zone-auto crisis_type is
 *      dropped (so the "what caused it" chip step returns).
 *   3. A HAND-PICKED crisis_type survives an edit to a no-zone location.
 *   4. The submit payload's location is the EDITED point (latitude/longitude),
 *      is_user_corrected=true, with the raw GPS preserved as device_latitude/…
 *      (edited > GPS in the wire contract).
 */
import { test, expect, Page } from '@playwright/test';

// /crisis-forms/active response shape (active branch reads data.schema_json).
const PACK_Y = {
    active: true,
    pack_id: 'pk-Y-flood',
    pack_version: 2,
    event_id: 'ev-Y',
    crisis_type: 'FLOOD',          // canonical → auto-applied + _crisisTypeAuto=true
    schema_json: {
        schema_version: 1, key: 'y-flood', title: 'Flood — rapid assessment',
        sections: [{ id: 'classify', stage: 2, fields: [
            { key: 'water_depth', type: 'single_select', label: 'Water depth?', required: false,
              options: [{ value: 'KNEE', label: 'Knee' }, { value: 'WAIST', label: 'Waist' }] },
        ] }],
    },
};

// Coordinate → zone mapping for the route stub: lat≈22 is zone Y, anything else
// (e.g. lat≈33) is OUTSIDE every zone.
const Y_LAT = 22.0, Y_LNG = 78.0;
const NO_ZONE_LAT = 33.0, NO_ZONE_LNG = 44.0;
const GPS_LAT = 11.668, GPS_LNG = 76.634;

async function boot(page: Page) {
    const seen: Array<{ lat: number; lng: number }> = [];
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.route('**/api/v1/reports/nearby**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ groups: [] }) }));
    // Block the meta POST so a queued row stays put for inspection.
    await page.route('**/api/v1/reports/meta', (route) =>
        route.fulfill({ status: 503, body: '{"detail":"blocked-by-spec"}' }));
    // Coordinate-aware crisis-forms/active stub: record every re-fetch's coords.
    await page.route('**/api/v1/crisis-forms/active**', (route) => {
        const url = new URL(route.request().url());
        const lat = parseFloat(url.searchParams.get('lat') || '0');
        const lng = parseFloat(url.searchParams.get('lng') || '0');
        seen.push({ lat, lng });
        const body = Math.abs(lat - Y_LAT) < 0.5
            ? JSON.stringify(PACK_Y)
            : JSON.stringify({ active: false });
        route.fulfill({ status: 200, contentType: 'application/json', body });
    });
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).state === 'object'
           && typeof (window as any).__crispV4OnLocationReeval === 'function'
           && typeof (window as any).showToast === 'function',
        null, { timeout: 8000 });
    return { seen };
}

/** Seed state as if the reporter is inside zone X with an auto-applied type + answers. */
async function seedInZoneX(page: Page, opts: { auto: boolean; crisisType: string }) {
    await page.evaluate((o) => {
        const s = (window as any).state = (window as any).state || {};
        s.location = { lat: 11.668, lng: 76.634, acc: 35, is_user_corrected: false };
        s.deviceLocation = { lat: 11.668, lng: 76.634 };
        s.crisisPack = { pack_id: 'pk-X-cyclone', pack_version: 1, event_id: 'ev-X',
                         crisis_type: o.crisisType, schema: { sections: [] } };
        s.crisis_type = o.crisisType;
        s._crisisTypeAuto = o.auto;
        s.crisisStockAnswers = { water_depth_prev: 'WAIST' };  // a previous zone's answer
    }, opts);
}

test.describe('PWA — edited location re-evaluates crisis-form assignment', () => {

    test('@smoke edit zone X → zone Y: re-fetches edited coords, swaps pack, clears answers, toasts', async ({ page }) => {
        const { seen } = await boot(page);
        await seedInZoneX(page, { auto: true, crisisType: 'CYCLONE' });

        // Simulate the inline editor saving a corrected place inside zone Y.
        await page.evaluate(([lat, lng]) => (window as any).__crispV4OnLocationReeval(lat, lng), [Y_LAT, Y_LNG]);

        // The pack swaps to Y, sourced from a /active fetch keyed on the EDITED coords.
        await page.waitForFunction(
            () => (window as any).state.crisisPack && (window as any).state.crisisPack.pack_id === 'pk-Y-flood',
            null, { timeout: 4000 });
        const s = await page.evaluate(() => ({
            packId: (window as any).state.crisisPack.pack_id,
            crisisType: (window as any).state.crisis_type,
            auto: (window as any).state._crisisTypeAuto,
            stock: (window as any).state.crisisStockAnswers,
        }));
        expect(s.packId).toBe('pk-Y-flood');
        expect(s.crisisType).toBe('FLOOD');            // zone Y's canonical type
        expect(s.auto).toBe(true);                     // still zone-derived
        expect(s.stock).toEqual({});                   // previous zone's answers cleared

        // The /active re-fetch used the EDITED coordinates, not the original GPS.
        const last = seen[seen.length - 1];
        expect(last.lat).toBeCloseTo(Y_LAT, 1);
        expect(last.lng).toBeCloseTo(Y_LNG, 1);
        expect(last.lat).not.toBeCloseTo(GPS_LAT, 1);

        // Confirmation toast (the exact requirement copy, EN).
        await expect(page.locator('#toast-notification')).toContainText(
            'Applicable crisis form has been refreshed', { timeout: 2000 });
    });

    test('@smoke edit zone X → NO zone: pack clears AND zone-auto crisis_type is dropped', async ({ page }) => {
        await boot(page);
        await seedInZoneX(page, { auto: true, crisisType: 'CYCLONE' });

        await page.evaluate(([lat, lng]) => (window as any).__crispV4OnLocationReeval(lat, lng), [NO_ZONE_LAT, NO_ZONE_LNG]);

        await page.waitForFunction(() => (window as any).state.crisisPack === null, null, { timeout: 4000 });
        const s = await page.evaluate(() => ({
            crisisType: (window as any).state.crisis_type,
            auto: (window as any).state._crisisTypeAuto,
        }));
        expect(s.crisisType).toBeNull();   // auto-applied type cleared → crisis chip returns
        expect(s.auto).toBe(false);
    });

    test('@smoke a HAND-PICKED crisis_type survives an edit to a no-zone location', async ({ page }) => {
        await boot(page);
        // _crisisTypeAuto=false → the reporter chose this themselves; never clobber it.
        await seedInZoneX(page, { auto: false, crisisType: 'EARTHQUAKE' });

        await page.evaluate(([lat, lng]) => (window as any).__crispV4OnLocationReeval(lat, lng), [NO_ZONE_LAT, NO_ZONE_LNG]);

        await page.waitForFunction(() => (window as any).state.crisisPack === null, null, { timeout: 4000 });
        const crisisType = await page.evaluate(() => (window as any).state.crisis_type);
        expect(crisisType).toBe('EARTHQUAKE');   // preserved — it was hand-picked, not zone-auto
    });

    test('@smoke submit payload uses the EDITED point (edited > GPS) with is_user_corrected', async ({ page }) => {
        await boot(page);
        // Reporter's raw GPS is the device location; they corrected to the edited point.
        await page.evaluate((c) => {
            const s = (window as any).state = (window as any).state || {};
            s.photoDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
            s.v4Photos = [s.photoDataUrl];
            s.damage_classification = 'COMPLETE';
            s.infrastructure_type = 'RESIDENTIAL';
            s.crisis_type = 'FLOOD';
            s.severity = 'CRITICAL';
            s.debris_present = false;
            s.deviceLocation = { lat: c.gpsLat, lng: c.gpsLng };          // raw GPS (audit)
            s.location = { lat: c.editLat, lng: c.editLng, acc: 0, is_user_corrected: true }; // edited = authoritative
            s.userLocationName = 'Corrected Place';
        }, { gpsLat: GPS_LAT, gpsLng: GPS_LNG, editLat: Y_LAT, editLng: Y_LNG });

        const meta = await page.evaluate(async () => {
            try { await (window as any).__crispSubmitReport(); } catch (_) {}
            await new Promise((r) => setTimeout(r, 150));
            const items = await (window as any).__crispGetAllQueued();
            return items.length ? (items[0].meta || null) : null;
        });
        expect(meta, 'a queue item should exist').not.toBeNull();
        expect(meta.location, 'location must be present').toBeTruthy();
        // Authoritative coords = the EDITED point.
        expect(meta.location.latitude).toBeCloseTo(Y_LAT, 4);
        expect(meta.location.longitude).toBeCloseTo(Y_LNG, 4);
        expect(meta.location.is_user_corrected).toBe(true);
        // Raw GPS preserved separately for audit (never used for matching once corrected).
        expect(meta.location.device_latitude).toBeCloseTo(GPS_LAT, 4);
        expect(meta.location.device_longitude).toBeCloseTo(GPS_LNG, 4);
    });
});
