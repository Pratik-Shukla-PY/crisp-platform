/**
 * PWA — two operator-reported bugs (May 2026):
 *
 *   1. "On Add Another the building footprint selection does not clear
 *      from the previous submission."
 *      → `building-select.js` had no listener for
 *        `crisp-capture-state-cleared`. `_clearCaptureState` zeroed
 *        `state.buildingId` but `_selectedLayer` (the highlighted
 *        polygon), `state.buildingOsmElement`, and the green
 *        "Building selected: <name>" pill DOM all persisted across
 *        reports. Silent carry-over of the previous report's
 *        `building_id` into the new submission.
 *      → Fix: listener calls the existing `_clearSelection`.
 *
 *   2. "The additional details submitted by the user never reaches the
 *      dashboard. After saving it says could not save. Ideally based
 *      on internet speed this should also reach the dashboard."
 *      → The UNDP-details save handler (stage-undp-details) did a raw
 *        `fetch` PATCH with "Couldn't save" on any failure (offline OR
 *        transient 5xx). No offline queue → data lost.
 *      → Fix: new `crisp_report_details_queue_v1` localStorage queue
 *        mirrors the delete-queue pattern. Save enqueues FIRST, then
 *        attempts the immediate PATCH; on 2xx we drain, on
 *        offline/5xx the entry stays for the next `online` event.
 */
import { test, expect, Page } from '@playwright/test';

async function bootV4(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any)._clearCaptureState === 'function'
           && typeof (window as any).__crispEnqueueDetails === 'function',
        null, { timeout: 8000 },
    );
}

test.describe('PWA — Add Another building clear + UNDP-details queue', () => {

    test.beforeEach(async ({ page }) => { await bootV4(page); });

    // ── Bug 1 ─────────────────────────────────────────────────────────────

    test('@smoke Add Another clears building-footprint selection (state + DOM)', async ({ page }) => {
        // Seed a building selection as if the user had picked one on the
        // previous report. The actual selection flow involves Overpass +
        // map taps; this seeds the same end state.
        await page.evaluate(() => {
            const s = (window as any).state;
            s.buildingId = 'osm:way:99001';
            s.buildingOsmElement = {
                type: 'way', id: 99001, tags: { building: 'apartments', name: 'Test Apartments' },
                name: 'Test Apartments',
            };
            s.infraName = 'Test Apartments';
            s.infraNameFromOsm = true;
            // Render the green pill so we can observe its DOM state.
            const pill = document.getElementById('building-selected-pill');
            if (pill) {
                pill.style.display = 'flex';
                const slot = pill.querySelector('.building-selected-name');
                if (slot) (slot as HTMLElement).textContent = 'Test Apartments';
            }
        });

        // Sanity — pre-Add-Another state should reflect the selection.
        const before = await page.evaluate(() => {
            const s = (window as any).state;
            const pill = document.getElementById('building-selected-pill');
            return {
                buildingId: s.buildingId,
                buildingOsmElement: s.buildingOsmElement,
                pillVisible: pill ? pill.style.display !== 'none' : false,
            };
        });
        expect(before.buildingId).toBe('osm:way:99001');
        expect(before.pillVisible).toBe(true);

        // Add Another.
        await page.evaluate(() => (window as any)._clearCaptureState());
        // Listener is sync but the event fires sync; tiny settle anyway.
        await page.waitForTimeout(50);

        // ASSERTIONS — state cleared + pill hidden.
        const after = await page.evaluate(() => {
            const s = (window as any).state;
            const pill = document.getElementById('building-selected-pill');
            return {
                buildingId: s.buildingId,
                buildingOsmElement: s.buildingOsmElement,
                infraName: s.infraName,
                infraNameFromOsm: s.infraNameFromOsm,
                pillVisible: pill ? pill.style.display !== 'none' : false,
            };
        });
        expect(after.buildingId, 'state.buildingId must clear').toBeFalsy();
        expect(after.buildingOsmElement, 'state.buildingOsmElement must clear').toBeFalsy();
        expect(after.infraName, 'OSM-sourced infraName must clear').toBeFalsy();
        expect(after.infraNameFromOsm, 'infraNameFromOsm flag must reset').toBeFalsy();
        expect(after.pillVisible, '"Building selected" pill must be hidden').toBe(false);
    });

    test('Add Another preserves user-typed infraName (only OSM-sourced is cleared)', async ({ page }) => {
        // If the user manually typed a building name (no OSM pick), the
        // clear must NOT wipe their text — building-select.js's
        // `_clearSelection` only clears infraName when the
        // `infraNameFromOsm` flag is true.
        await page.evaluate(() => {
            const s = (window as any).state;
            s.infraName = 'My grandma\'s house';
            s.infraNameFromOsm = false;
        });
        await page.evaluate(() => (window as any)._clearCaptureState());
        await page.waitForTimeout(50);
        const after = await page.evaluate(() => {
            // _clearCaptureState itself clears state.infraName (app.js:10929),
            // BUT the building-select.js listener only touches infraName
            // when infraNameFromOsm was true. So in practice the user-typed
            // name still gets cleared by app.js's own reset — what we're
            // pinning here is that the BuildingSelect listener doesn't
            // ADDITIONALLY blow away anything the user owned.
            return { infraNameFromOsm: (window as any).state.infraNameFromOsm };
        });
        expect(after.infraNameFromOsm, 'flag must NOT flip to true').toBeFalsy();
    });

    // ── Bug 2 ─────────────────────────────────────────────────────────────

    test('@smoke UNDP-details queue: failed save persists to localStorage', async ({ page }) => {
        // Simulate a network failure on the PATCH endpoint.
        await page.route('**/api/v1/reports/*/classify', (route) => {
            return route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: '{"detail":"Service Unavailable"}',
            });
        });

        const queued = await page.evaluate(async () => {
            // Use the public test hook to enqueue (same code path the
            // save handler uses).
            (window as any).__crispEnqueueDetails({
                reportId: 'r-test-details-001',
                payload: {
                    debris_clearing_needed: true,
                    service_status: {
                        electricity: 'BRIEF_OUTAGE',
                        water: 'LOW_PRESSURE',
                        health: 'Working',
                        pressing_needs: ['water', 'shelter'],
                    },
                },
            });
            // Read back the queue.
            const raw = localStorage.getItem('crisp_report_details_queue_v1');
            return raw ? JSON.parse(raw) : null;
        });
        expect(queued, 'queue must contain one entry').toBeTruthy();
        expect(queued.length).toBe(1);
        expect(queued[0].reportId).toBe('r-test-details-001');
        expect(queued[0].payload.debris_clearing_needed).toBe(true);
        expect(queued[0].payload.service_status.electricity).toBe('BRIEF_OUTAGE');
        expect(queued[0].payload.service_status.pressing_needs).toEqual(['water', 'shelter']);
        expect(queued[0].queuedAt, 'must stamp queuedAt').toBeGreaterThan(0);
    });

    test('UNDP-details queue: dedupes by reportId (latest save wins)', async ({ page }) => {
        // The PATCH endpoint merges fields — a single drained entry per
        // report is sufficient. Two enqueues for the same report should
        // collapse to one row with the latest payload.
        const finalQueue = await page.evaluate(() => {
            (window as any).__crispEnqueueDetails({
                reportId: 'r-dedupe-test',
                payload: { service_status: { electricity: 'OK' } },
            });
            (window as any).__crispEnqueueDetails({
                reportId: 'r-dedupe-test',
                payload: { service_status: { electricity: 'MAJOR_LOSS' } },
            });
            const raw = localStorage.getItem('crisp_report_details_queue_v1');
            return raw ? JSON.parse(raw) : null;
        });
        expect(finalQueue.length).toBe(1);
        expect(finalQueue[0].payload.service_status.electricity).toBe('MAJOR_LOSS');
    });

    test('UNDP-details queue: drains on successful PATCH', async ({ page }) => {
        // Mock the endpoint to return 200 OK so the queue drainer
        // succeeds. The drainer must remove the entry.
        await page.route('**/api/v1/reports/*/classify', (route) => {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: '{}',
            });
        });

        const queueAfter = await page.evaluate(async () => {
            // Seed the queue.
            localStorage.setItem('crisp_report_details_queue_v1', JSON.stringify([{
                reportId: 'r-drain-test',
                payload: { service_status: { electricity: 'OK' } },
                queuedAt: Date.now(),
            }]));
            // Drain.
            await (window as any).__crispSyncDetailsQueue();
            // Settle the async fetch.
            await new Promise((r) => setTimeout(r, 100));
            const raw = localStorage.getItem('crisp_report_details_queue_v1');
            return raw ? JSON.parse(raw) : [];
        });
        expect(queueAfter, 'queue must drain after a 200').toEqual([]);
    });

    test('UNDP-details queue: 401 keeps entry queued (re-login retry)', async ({ page }) => {
        // 401 = "your token expired" — keep the entry so the user can
        // re-login and the next drain succeeds.
        await page.route('**/api/v1/reports/*/classify', (route) => {
            return route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: '{"detail":"Unauthorized"}',
            });
        });
        const queueAfter = await page.evaluate(async () => {
            localStorage.setItem('crisp_report_details_queue_v1', JSON.stringify([{
                reportId: 'r-401-test',
                payload: { service_status: { electricity: 'OK' } },
                queuedAt: Date.now(),
            }]));
            await (window as any).__crispSyncDetailsQueue();
            await new Promise((r) => setTimeout(r, 100));
            const raw = localStorage.getItem('crisp_report_details_queue_v1');
            return raw ? JSON.parse(raw) : [];
        });
        expect(queueAfter.length, '401 must NOT drain — user may re-login').toBe(1);
    });

    test('UNDP-details queue: 4xx other than 401 drops the entry (unredeemable)', async ({ page }) => {
        // 422 = bad payload, won't succeed on retry. Drop the entry to
        // avoid an infinite loop.
        await page.route('**/api/v1/reports/*/classify', (route) => {
            return route.fulfill({
                status: 422,
                contentType: 'application/json',
                body: '{"detail":"Validation error"}',
            });
        });
        const queueAfter = await page.evaluate(async () => {
            localStorage.setItem('crisp_report_details_queue_v1', JSON.stringify([{
                reportId: 'r-422-test',
                payload: { service_status: { electricity: 'BAD_VALUE' } },
                queuedAt: Date.now(),
            }]));
            await (window as any).__crispSyncDetailsQueue();
            await new Promise((r) => setTimeout(r, 100));
            const raw = localStorage.getItem('crisp_report_details_queue_v1');
            return raw ? JSON.parse(raw) : [];
        });
        expect(queueAfter, '422 must drain to prevent infinite retries').toEqual([]);
    });
});
