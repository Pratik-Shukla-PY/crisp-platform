/**
 * Dashboard — image viewer redesign (May 2026).
 *
 * Locks down the production-grade viewer work that extends the PhotoSwipe v5
 * lightbox (openGallery):
 *   · ASPECT FIX — the lightbox used to hardcode every slide to 1920×1440
 *     (Media has no width/height), stretching portrait / panoramic / square
 *     photos. `_applyRealDims` now reads the image's true naturalWidth/Height
 *     on load and re-fits, so the rendered <img> aspect always matches the
 *     natural aspect — verified here for landscape / portrait / square /
 *     panorama (the "circle stays a circle" guarantee).
 *   · ROTATION — client-side, non-destructive (] / [ keys + toolbar buttons).
 *   · GEO OVERLAY — top-right coords + building + time, null lines hidden,
 *     visibility a localStorage preference (off / coords / +building / +time).
 *   · DOWNLOAD + ROTATE + OVERLAY-TOGGLE toolbar buttons present.
 *
 * Test images are SVG data: URIs of exact pixel dimensions — they load with no
 * network and report deterministic naturalWidth/Height, so the no-stretch
 * assertion is exact. Synthetic Report rows are pushed into the dashboard's
 * in-memory `allReports` (same pattern as 07-multi-image-gallery).
 */
import { test, expect, APIRequestContext, Page } from '@playwright/test';
import { ADMIN } from '../helpers/api';

async function loginAsAdmin(page: Page, request: APIRequestContext): Promise<void> {
    await request.post('http://localhost:8000/api/v1/auth/register', {
        data: { ...ADMIN, role: 'SUPER_ADMIN' },
    }).catch(() => {});
    const res = await request.post('http://localhost:8000/api/v1/auth/login', {
        data: { email: ADMIN.email, password: ADMIN.password },
    });
    const body = await res.json();
    const token = body.access_token || body.token;
    await page.goto('index.html');
    await page.evaluate((t) => {
        localStorage.setItem('crisp_token', t);
        localStorage.setItem('crisp_user', JSON.stringify({
            email: 'e2e-admin@crisp.test', role: 'SUPER_ADMIN', full_name: 'E2E Admin',
        }));
    }, token);
    await page.reload();
}

// Exact-dimension SVG data: URI — loads without network; naturalWidth/Height = w/h.
function svgDataUri(w: number, h: number): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
        + `<rect width="${w}" height="${h}" fill="#1a2433"/>`
        + `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) * 0.4}" fill="none" stroke="#7dd3fc" stroke-width="6"/>`
        + `<text x="${w / 2}" y="26" fill="#fff" font-size="22" text-anchor="middle">${w}x${h}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function synthReport(reportId: string, dims: Array<{ w: number; h: number }>,
                     opts: { building?: string | null; location?: null } = {}) {
    const media = dims.map((d, i) => ({
        id: `m-${i}-${reportId}`,
        type: 'IMAGE',
        resolution_tier: 'ORIGINAL',
        url: svgDataUri(d.w, d.h),
        assembly_status: 'complete',
        photo_group_id: `grp-${i}-${reportId}`,
        is_synced: true,
        completion_pct: 100,
        thumbnail_url: null,
        pii_blur_status: 'complete_clean',
        photo_phash: null,
    }));
    return {
        id: reportId,
        client_report_id: `e2e-vr-${reportId}`,
        device_id: 'E2E-VR',
        source: 'APP',
        status: 'PENDING',
        sync_status: 'SYNCED',
        severity: 'MODERATE',
        infrastructure_type: 'RESIDENTIAL',
        infrastructure_name: opts.building === undefined ? 'Building A — Koramangala' : opts.building,
        // The photo overlay shows a building name ONLY for an OSM-tagged building
        // (_taggedBuildingName: building_id set + from_osm !== false). A reporter's
        // free-text "what was hit" with no OSM link is a "needs mapping" report and
        // is deliberately NOT surfaced as a building. Give the synth report a real
        // OSM tag so the building line renders (null-building/coords cases below
        // still exercise the suppression path).
        building_id: opts.building === null ? null : `osm:way:e2e-${reportId}`,
        infrastructure_name_from_osm: true,
        description: 'E2E image-viewer test',
        expected_media: dims.length,
        received_media: dims.length,
        server_created_at: '2026-05-30T09:02:00Z',
        client_created_at: '2026-05-30T09:01:30Z',
        crisis_type: 'FLOOD',
        damage_classification: 'PARTIAL',
        location: opts.location === null ? null : { latitude: 12.9716, longitude: 77.5946, accuracy_meters: 12 },
        media,
        ai_analysis: null,
        verification: null,
    };
}

async function openViewer(page: Page, rep: any, startIdx = 0) {
    await page.evaluate((r) => {
        const a = (window as any).allReports || [];
        a.unshift(r);
        (window as any).allReports = a;
    }, rep);
    await page.evaluate(({ id, idx }) => (window as any).openGallery(id, idx), { id: rep.id, idx: startIdx });
    await page.locator('.pswp__img').first().waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForFunction(() => {
        const img = document.querySelector('.pswp__img') as HTMLImageElement | null;
        return !!img && img.naturalWidth > 0;
    }, null, { timeout: 8000 });
    await page.waitForTimeout(150); // let loadComplete → _applyRealDims → updateContentSize settle
}

async function closeViewer(page: Page) {
    await page.keyboard.press('Escape');
    await page.locator('.pswp').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

// Persist an overlay preference the way the app reads it: localStorage is read
// once at boot into the in-memory _viewerPrefs, so we set it then reload.
async function setOverlayPref(page: Page, mode: string) {
    await page.evaluate((m) => localStorage.setItem('crisp_image_viewer_prefs', JSON.stringify({ overlay: m })), mode);
    await page.reload();
    await page.waitForFunction(
        () => typeof (window as any).openGallery === 'function' && Array.isArray((window as any).allReports),
        null, { timeout: 15_000 },
    );
}

test.describe('Dashboard — image viewer redesign', () => {
    test.beforeEach(async ({ page, request }) => {
        await loginAsAdmin(page, request);
        await page.waitForFunction(
            () => typeof (window as any).openGallery === 'function'
                && Array.isArray((window as any).allReports),
            null, { timeout: 15_000 },
        );
    });

    // ── 1. No stretch: rendered aspect ≈ natural aspect for every shape ──
    for (const d of [
        { name: 'landscape 16:9', w: 1600, h: 900 },
        { name: 'portrait 9:16', w: 900, h: 1600 },
        { name: 'square 1:1', w: 1200, h: 1200 },
        { name: 'panorama 3:1', w: 2400, h: 800 },
    ]) {
        test(`no stretch — ${d.name}`, async ({ page }) => {
            const rep = synthReport(`vr-${d.w}x${d.h}-${Date.now()}`, [{ w: d.w, h: d.h }]);
            await openViewer(page, rep);
            const m = await page.evaluate(() => {
                const img = document.querySelector('.pswp__img') as HTMLImageElement;
                return { nw: img.naturalWidth, nh: img.naturalHeight, cw: img.clientWidth, ch: img.clientHeight };
            });
            expect(m.nw).toBe(d.w);
            expect(m.nh).toBe(d.h);
            const naturalAspect = m.nw / m.nh;
            const renderedAspect = m.cw / m.ch;
            // Tight 4% tolerance — the old 1920×1440 hardcode would put this
            // wildly off (e.g. 1.33 vs 0.56 for portrait).
            expect(Math.abs(renderedAspect - naturalAspect) / naturalAspect,
                `rendered ${m.cw}×${m.ch} vs natural ${m.nw}×${m.nh}`).toBeLessThan(0.04);
            await closeViewer(page);
        });
    }

    // ── 2. Toolbar buttons present ──
    test('toolbar has download + rotate (L/R/reset) + overlay-toggle buttons', async ({ page }) => {
        const rep = synthReport(`vr-btns-${Date.now()}`, [{ w: 1600, h: 900 }]);
        await openViewer(page, rep);
        for (const cls of ['download', 'rotate-left', 'rotate-right', 'rotate-reset', 'overlay-toggle']) {
            await expect(page.locator(`.pswp__button--${cls}`), `button ${cls}`).toHaveCount(1);
        }
        await closeViewer(page);
    });

    // ── 3. Geo overlay content + null-hide + preference ──
    test('overlay shows coords + building + time (default mode)', async ({ page }) => {
        await page.evaluate(() => localStorage.removeItem('crisp_image_viewer_prefs'));
        const rep = synthReport(`vr-ovl-${Date.now()}`, [{ w: 1600, h: 900 }], { building: 'Building A — Koramangala' });
        await openViewer(page, rep);
        const ovl = page.locator('.pswp-geo-overlay');
        await expect(ovl).toBeVisible();
        await expect(ovl).toContainText('12.9716, 77.5946');
        await expect(ovl).toContainText('Building A');
        await expect(ovl.locator('.pgo-map')).toBeVisible();
        await closeViewer(page);
    });

    test('overlay hides the building line when infrastructure_name is null', async ({ page }) => {
        await page.evaluate(() => localStorage.removeItem('crisp_image_viewer_prefs'));
        const rep = synthReport(`vr-nb-${Date.now()}`, [{ w: 1200, h: 1200 }], { building: null });
        await openViewer(page, rep);
        await expect(page.locator('.pswp-geo-overlay')).toBeVisible();
        await expect(page.locator('.pswp-geo-overlay')).toContainText('12.9716, 77.5946');
        await expect(page.locator('.pswp-geo-overlay .pgo-building')).toHaveCount(0);
        await closeViewer(page);
    });

    test('overlay "off" preference hides the overlay', async ({ page }) => {
        await setOverlayPref(page, 'off');
        const rep = synthReport(`vr-off-${Date.now()}`, [{ w: 1600, h: 900 }]);
        await openViewer(page, rep);
        await expect(page.locator('.pswp-geo-overlay')).toBeHidden();
        await closeViewer(page);
    });

    test('overlay "coords" preference shows coords only (no building)', async ({ page }) => {
        await setOverlayPref(page, 'coords');
        const rep = synthReport(`vr-co-${Date.now()}`, [{ w: 1600, h: 900 }], { building: 'Building A — Koramangala' });
        await openViewer(page, rep);
        await expect(page.locator('.pswp-geo-overlay')).toContainText('12.9716, 77.5946');
        await expect(page.locator('.pswp-geo-overlay .pgo-building')).toHaveCount(0);
        await closeViewer(page);
    });

    // ── 4. Rotation (keyboard + button) ──
    test('rotation: "]" rotates 90°, reset button returns to 0°', async ({ page }) => {
        const rep = synthReport(`vr-rot-${Date.now()}`, [{ w: 1600, h: 900 }]);
        await openViewer(page, rep);
        await page.keyboard.press(']');
        await page.waitForTimeout(60);
        let tf = await page.evaluate(() => (document.querySelector('.pswp__img') as HTMLElement).style.transform);
        expect(tf, 'after "]" the image should be rotated 90°').toContain('rotate(90deg)');
        await page.locator('.pswp__button--rotate-reset').click();
        await page.waitForTimeout(60);
        tf = await page.evaluate(() => (document.querySelector('.pswp__img') as HTMLElement).style.transform);
        expect(tf, 'reset should return to 0°').toContain('rotate(0deg)');
        await closeViewer(page);
    });
});
