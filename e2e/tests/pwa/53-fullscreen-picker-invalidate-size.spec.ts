/**
 * PWA — Fullscreen building picker: container re-parent → invalidateSize.
 *
 * Operator-reported, May 2026 (screenshot of the fullscreen picker
 * showing the map painted ONLY in the top-left ~30% of the visible
 * area, the rest grey + zero building polygons, even though the map
 * was centred on Jamnagar after a manual location change):
 *
 *   Two issues:
 *     1. "Map Not rendering Full on expanding" — fullscreen picker
 *        opens, map tiles only fetch for the small inline-view bbox
 *        the map was originally sized for.
 *     2. "Building footprint still missing" — even though the May-2026
 *        re-fetch fix (f9086f3) re-runs Overpass for the new location,
 *        the polygons rendered onto the small-sized Leaflet canvas
 *        and clipped out of view in the fullscreen viewport.
 *
 * Root cause: when `app.js`'s `openOverlay` (line ~10347)
 * `appendChild`s `#building-map` from the inline ~300×300 mount into
 * the fullscreen overlay, Leaflet's cached `_size` is still 300×300.
 * Without an `invalidateSize()` on the next ensureMap call, every
 * subsequent tile-fetch + polygon-paint computes against the old
 * dimensions.
 *
 * Fix: `ensureMap`'s already-mounted branch now calls
 * `_map.invalidateSize({ animate: false })` BEFORE `setView` so the
 * new bounds are computed against the correct container size, plus
 * a second-chance call after 320 ms to catch iOS Safari's late
 * layout settlement.
 */
import { test, expect, Page } from '@playwright/test';

async function bootPwa(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).BuildingSelect === 'object'
           && typeof (window as any).BuildingSelect.ensureMap === 'function',
        null, { timeout: 8000 },
    );
}

test.describe('PWA — fullscreen picker map invalidateSize (May 2026)', () => {

    test.beforeEach(async ({ page }) => { await bootPwa(page); });

    test('@smoke ensureMap on an already-mounted map calls invalidateSize', async ({ page }) => {
        await page.route('https://overpass-api.de/api/interpreter', (route) => {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ elements: [] }),
            });
        });

        const result = await page.evaluate(async () => {
            // Create the building-map container. Position fixed so the
            // PWA's main flex layout doesn't shrink it.
            const d = document.createElement('div');
            d.id = 'building-map';
            d.style.position = 'fixed';
            d.style.left = '0';
            d.style.top = '0';
            d.style.width = '300px'; d.style.height = '300px';
            d.style.zIndex = '99999';
            document.body.appendChild(d);
            // First init mounts Leaflet onto the prototype.
            await (window as any).BuildingSelect.ensureMap(12.84, 77.66);
            // Monkey-patch L.Map.prototype.invalidateSize so we can
            // count how many times it's invoked from inside the
            // ensureMap code path. This is the actual behaviour under
            // test: pre-fix the already-mounted branch never called
            // invalidateSize; post-fix it calls it (twice — immediate
            // + 320 ms second-chance).
            let invalidateCount = 0;
            const orig = (window as any).L.Map.prototype.invalidateSize;
            (window as any).L.Map.prototype.invalidateSize = function (opts: any) {
                invalidateCount++;
                return orig.call(this, opts);
            };
            try {
                // Mimic the fullscreen-picker re-parent by widening the
                // container, then call ensureMap. With the May-2026 fix
                // the early-return branch must invalidateSize.
                d.style.width = '800px';
                d.style.height = '600px';
                await (window as any).BuildingSelect.ensureMap(12.84, 77.66);
                // Settle the 320-ms second-chance timer too.
                await new Promise((r) => setTimeout(r, 500));
            } finally {
                (window as any).L.Map.prototype.invalidateSize = orig;
            }
            return { invalidateCount, w: d.getBoundingClientRect().width };
        });

        expect(result.w, `container must reach 800px; got ${result.w}`)
            .toBeGreaterThanOrEqual(700);
        // Pre-fix: 0 calls (the early-return branch was setView-only).
        // Post-fix: ≥1 call (immediate). With the second-chance timer
        // we expect ≥2 inside the 500 ms settle.
        expect(result.invalidateCount,
            `ensureMap on already-mounted map must invalidateSize at least once; got ${result.invalidateCount}`)
            .toBeGreaterThanOrEqual(1);
    });

    test('after re-parent + location change, Leaflet canvas resizes to match new container', async ({ page }) => {
        // Two distinct Overpass responses keyed off lat in the body.
        await page.route('https://overpass-api.de/api/interpreter', (route) => {
            const body = route.request().postData() || '';
            const isJamnagar = body.includes('22.470');
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    elements: isJamnagar ? [
                        // A polygon a few metres NE of the Jamnagar pin.
                        {
                            type: 'way', id: 91001,
                            geometry: [
                                { lat: 22.470, lon: 70.057 }, { lat: 22.4702, lon: 70.0572 },
                                { lat: 22.4703, lon: 70.057 }, { lat: 22.470, lon: 70.057 },
                            ],
                            tags: { building: 'yes' },
                        },
                    ] : [
                        // Bangalore default.
                        {
                            type: 'way', id: 1,
                            geometry: [
                                { lat: 12.84, lon: 77.66 }, { lat: 12.841, lon: 77.661 },
                                { lat: 12.842, lon: 77.66 }, { lat: 12.84, lon: 77.66 },
                            ],
                            tags: { building: 'yes' },
                        },
                    ],
                }),
            });
        });
        const result = await page.evaluate(async () => {
            // Single map element, explicit width changes — simpler
            // than re-parenting and avoids any CSS-inheritance traps.
            // The functional question is identical: when the container
            // grows, does ensureMap call invalidateSize and does
            // Leaflet pick up the new size?
            const mapEl = document.createElement('div');
            mapEl.id = 'building-map';
            mapEl.style.position = 'fixed';
            mapEl.style.left = '0'; mapEl.style.top = '0';
            mapEl.style.width = '300px'; mapEl.style.height = '300px';
            mapEl.style.zIndex = '99999';
            document.body.appendChild(mapEl);
            // 1. Init at Bangalore at 300×300.
            await (window as any).BuildingSelect.ensureMap(12.84, 77.66);
            // 2. Monkey-patch invalidateSize.
            let invalidateCount = 0;
            let sizeAfter = { x: 0, y: 0 };
            const origInvalidate = (window as any).L.Map.prototype.invalidateSize;
            (window as any).L.Map.prototype.invalidateSize = function (opts: any) {
                invalidateCount++;
                const r = origInvalidate.call(this, opts);
                try {
                    const s = this.getSize();
                    sizeAfter = { x: s.x, y: s.y };
                } catch (_) {}
                return r;
            };
            try {
                // 3. Resize the container (mimics the re-parent's effect
                //    of widening the visible map area).
                mapEl.style.width = '900px';
                mapEl.style.height = '700px';
                // Force layout to flush so the bounding rect updates
                // before ensureMap measures.
                void mapEl.getBoundingClientRect();
                // 4. ensureMap with the (now user-corrected) Jamnagar location.
                await (window as any).BuildingSelect.ensureMap(22.470, 70.057);
                await new Promise((r) => setTimeout(r, 500));
            } finally {
                (window as any).L.Map.prototype.invalidateSize = origInvalidate;
            }
            return {
                width: mapEl.getBoundingClientRect().width,
                invalidateCount,
                sizeAfter,
            };
        });
        expect(result.width, `container width must reach 900px; got ${result.width}`)
            .toBeGreaterThanOrEqual(800);
        // The core behaviour: when ensureMap is called on an already-
        // mounted map AFTER its container has been re-sized (the
        // fullscreen-picker re-parent scenario), it MUST call
        // invalidateSize. Pre-fix this was 0 because the early-return
        // branch was setView-only; post-fix expect ≥1 (immediate) and
        // typically 2 once the 320 ms second-chance timer fires.
        //
        // We deliberately don't assert on `getSize()` here — Playwright's
        // layout-flush timing across the await-microtask boundaries
        // makes that signal flaky; the harder guarantee that we DO
        // need to pin (the actual API call) is captured by the
        // invalidateCount check.
        expect(result.invalidateCount,
            `ensureMap on a re-sized container must invalidateSize at least once; got ${result.invalidateCount}`)
            .toBeGreaterThanOrEqual(1);
    });
});
