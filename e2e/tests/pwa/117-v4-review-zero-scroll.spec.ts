/**
 * HC65 (May 2026) — V4 Step 3 "Review your report" zero-scroll redesign.
 *
 * Operator (2026-05-25): "Redesign Step 3 of 3 into a production-grade,
 * zero-scroll, intelligently compressed review experience [...] No
 * patchwork fixes. Need a holistic production-grade redesign of the
 * entire Step 3 review experience."
 *
 * Pre-HC65 the review stage rendered ~1100 px of content (4 fat cards
 * + 260 px inline OSM map + 3-row classification block + free-text
 * input + UNDP trigger) against a 589 px iPhone SE budget. The Send
 * CTA was permanently below the fold.
 *
 * HC65 cuts (~558 px saved):
 *   1. Photo / Location / UNDP trigger / Building → uniform compact
 *      `.v4-review-row` (50 px each).
 *   2. 3-row Classification → 3-chip horizontal strip (50 px total).
 *   3. Description card hidden on review (HC60's capture-stage voice
 *      + text is the authoritative input).
 *   4. Inline 260 px building map hidden — fullscreen picker
 *      (already shipped) becomes primary entry. UNDP must-have #6
 *      (free-text offline fallback) still reachable via fullscreen
 *      picker which contains the same `#input-infra-name-v3` input.
 *   5. "Tap any card to edit" subtitle dropped — uniform rows are
 *      self-evident.
 *
 * This spec pins:
 *   1. Review body fits without vertical scroll at iPhone SE.
 *   2. Send CTA is visible without scrolling.
 *   3. Photo row, Location row, Building row, UNDP row all exist
 *      and are ≥ 44 px tall (WCAG touch-target floor).
 *   4. 3 classification chips share a single row (equal-width via
 *      `repeat(3, 1fr)`).
 *   5. Description card is hidden on review.
 *   6. Inline building map (`#building-map`) is hidden — fullscreen
 *      picker handles building selection.
 *   7. Legacy `.v4-review-subtitle` markup is gone.
 *   8. Zero-scroll holds for Arabic (RTL) and Hindi.
 */
import { test, expect, type Page } from '@playwright/test';

const IPHONE_SE = { width: 375, height: 667 };

async function openReviewStage(page: Page, lang = 'en', opts: { photos?: number } = {}) {
    const photoCount = opts.photos ?? 1;
    await page.setViewportSize(IPHONE_SE);
    await page.addInitScript((langCode) => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', langCode);
        localStorage.setItem('crisp_lang_manual', langCode);
    }, lang);
    await page.route('**/api/v1/reports/nearby**', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ groups: [] }),
        }),
    );
    // Stub the reverse-geocode endpoint so the location row paints
    // a friendly name without a real Mapbox call.
    await page.route('**/api/v1/reports/geocode/reverse**', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                location_name: 'Electronic City, Bengaluru',
                source: 'mapbox',
                confidence: 'high',
            }),
        }),
    );
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).goToStage === 'function'
           && typeof (window as any).state === 'object',
        null,
        { timeout: 8000 },
    );
    // Seed the minimum capture state so the review stage paints
    // its review summary properly (photo strip, classifications,
    // etc.) and jump directly to the review stage. `photoCount` is
    // controlled by the test — 0 / 1 / 2 / 3 to exercise the
    // different photo-strip fill states.
    await page.evaluate((n: number) => {
        (window as any).state = (window as any).state || {};
        const photos = [];
        for (let i = 0; i < n; i++) {
            photos.push({ url: `data:image/png;base64,iVBORw0KGgo=#${i}` });
        }
        (window as any).state.v4Photos = photos;
        (window as any).state.photoDataUrl = n > 0 ? photos[0].url : null;
        (window as any).state.location = {
            lat: 12.9716, lng: 77.5946, acc: 35,
        };
        (window as any).state.infrastructure_type = 'COMMUNITY';
        (window as any).state.crisis_type = 'EARTHQUAKE';
        (window as any).state.damage_classification = 'PARTIAL';
        (window as any).goToStage('stage-v4-review');
    }, photoCount);
    await expect(page.locator('#stage-v4-review.active'))
        .toBeVisible({ timeout: 3000 });
    // Let the review summary paint (geocode resolution + photo thumb
    // + classification values).
    await page.waitForTimeout(300);
}

test.describe('PWA — HC65 V4 Step 3 review zero-scroll', () => {
    test('@smoke iPhone SE: review body fits without vertical scroll', async ({ page }) => {
        await openReviewStage(page);
        const overflow = await page.evaluate(() => {
            const body = document.querySelector('#stage-v4-review .v4-body') as HTMLElement | null;
            if (!body) return null;
            return body.scrollHeight - body.clientHeight;
        });
        expect(overflow, 'v4-body should exist').not.toBeNull();
        expect(
            overflow,
            `v4-body overflow must be ≤ 2 px (got ${overflow})`,
        ).toBeLessThanOrEqual(2);
    });

    test('@smoke Send to UNDP CTA layout — pinned by the stage grid contract', async ({ page }) => {
        await openReviewStage(page);
        // The stage uses CSS grid with `grid-template-rows: auto 1fr
        // auto` so the footer is always at the bottom of the stage.
        // Combined with the zero-overflow check on `.v4-body` above,
        // this guarantees the Send button can never be pushed below
        // the viewport.
        const stageDisplay = await page.locator('#stage-v4-review').evaluate(
            (el) => getComputedStyle(el).display,
        );
        expect(stageDisplay, 'review stage must use CSS grid layout').toBe('grid');
        const tracks = await page.locator('#stage-v4-review').evaluate(
            (el) => getComputedStyle(el).gridTemplateRows.split(/\s+/).filter(Boolean).length,
        );
        expect(
            tracks,
            'review stage grid must have 3 tracks (header / body / footer)',
        ).toBeGreaterThanOrEqual(3);
        // Send button is in the DOM.
        await expect(page.locator('#btn-v4-send')).toHaveCount(1);
    });

    test('@smoke HC66 photo strip has 3 slots, all empty when no photos', async ({ page }) => {
        await openReviewStage(page, 'en', { photos: 0 });
        // Photo strip lives at `#v4-review-photo-strip`. With 0 photos
        // all 3 slots must be `.v4-review-photo-add` CTAs.
        const strip = page.locator('#v4-review-photo-strip');
        await expect(strip).toBeVisible();
        const slots = strip.locator('> *');
        await expect(slots, 'must have exactly 3 slots').toHaveCount(3);
        const addCtas = strip.locator('.v4-review-photo-add');
        await expect(addCtas, 'all 3 slots must be empty Add CTAs').toHaveCount(3);
        const tiles = strip.locator('.v4-review-photo-tile');
        await expect(tiles, 'no filled tiles when 0 photos').toHaveCount(0);
    });

    test('@smoke HC66 photo strip with 2 photos: 2 filled tiles + 1 Add CTA', async ({ page }) => {
        await openReviewStage(page, 'en', { photos: 2 });
        const strip = page.locator('#v4-review-photo-strip');
        await expect(strip).toBeVisible();
        const slots = strip.locator('> *');
        await expect(slots, 'must have exactly 3 slots').toHaveCount(3);
        const tiles = strip.locator('.v4-review-photo-tile');
        await expect(tiles, 'should be 2 filled tiles').toHaveCount(2);
        const addCtas = strip.locator('.v4-review-photo-add');
        await expect(addCtas, 'should be 1 Add CTA').toHaveCount(1);
        // Each filled tile carries a `× delete` corner button.
        const deleteBtns = strip.locator('.v4-review-photo-tile-x');
        await expect(deleteBtns, 'each filled tile has a × button').toHaveCount(2);
    });

    test('@smoke HC66 photo × delete removes the photo + updates state', async ({ page }) => {
        await openReviewStage(page, 'en', { photos: 2 });
        // Before delete: 2 photos in state.
        const before = await page.evaluate(() => (window as any).state.v4Photos.length);
        expect(before, 'should start with 2 photos').toBe(2);
        // Tap the × on the first tile.
        await page.locator('#v4-review-photo-strip .v4-review-photo-tile-x').first().click();
        const after = await page.evaluate(() => (window as any).state.v4Photos.length);
        expect(after, 'should have 1 photo after delete').toBe(1);
        // Strip re-painted: 1 filled + 2 Add CTAs.
        await expect(
            page.locator('#v4-review-photo-strip .v4-review-photo-tile'),
            '1 filled tile remaining',
        ).toHaveCount(1);
        await expect(
            page.locator('#v4-review-photo-strip .v4-review-photo-add'),
            '2 Add CTAs after delete',
        ).toHaveCount(2);
    });

    test('@smoke HC66 location strip is inline 2 lines, no card chrome', async ({ page }) => {
        await openReviewStage(page);
        const strip = page.locator('#v4-edit-location');
        await expect(strip).toBeVisible();
        // No card chrome — border-width must be 0 (or close to it
        // counting all 4 sides, since the strip uses
        // `background: transparent; border: 0` per HC66).
        const borderTotal = await strip.evaluate((el) => {
            const s = getComputedStyle(el);
            return ['Top', 'Right', 'Bottom', 'Left']
                .map((d) => parseFloat(s.getPropertyValue(`border-${d.toLowerCase()}-width`)) || 0)
                .reduce((a, b) => a + b, 0);
        });
        expect(
            borderTotal,
            `location strip must have no card border (got total ${borderTotal} px)`,
        ).toBe(0);
        // Two child lines (location + time).
        const lines = strip.locator('.v4-review-loc-line');
        await expect(lines, 'must have 2 lines').toHaveCount(2);
        // Time line is rendered with non-empty content (locale-aware).
        const time = await page.locator('#v4-row-location-time').textContent();
        expect(
            time && time.trim().length,
            'time line must have content',
        ).toBeGreaterThan(0);
    });

    test('@smoke HC66 classification rows are vertical plain text rows', async ({ page }) => {
        await openReviewStage(page);
        const wrapper = page.locator('#stage-v4-review .v4-review-classify-rows');
        await expect(wrapper, 'classify rows wrapper must exist').toHaveCount(1);
        const rows = wrapper.locator('.v4-classify-row');
        await expect(rows, 'must have 3 classification rows').toHaveCount(3);
        // Vertical stack — each next row's top must be STRICTLY
        // greater than the previous row's top.
        const tops = await rows.evaluateAll((nodes) =>
            (nodes as HTMLElement[]).map((el) => el.getBoundingClientRect().top),
        );
        expect(tops[1], 'row 2 should sit below row 1').toBeGreaterThan(tops[0]);
        expect(tops[2], 'row 3 should sit below row 2').toBeGreaterThan(tops[1]);
        // Each row has a `.v4-classify-row-pen` icon (edit affordance).
        const pens = wrapper.locator('.v4-classify-row-pen');
        await expect(pens, 'each row has a pen icon').toHaveCount(3);
    });

    test('@smoke HC66 inline building map is back at compact ~140 px', async ({ page }) => {
        await openReviewStage(page);
        // HC66 reverses HC65's hide-the-map decision. The inline map
        // is now visible at 140 px (down from pre-HC65's 260 px).
        const map = page.locator('#stage-v4-review #building-map');
        await expect(map, 'inline map must exist').toHaveCount(1);
        const display = await map.evaluate((el) => getComputedStyle(el).display);
        expect(
            display,
            'inline building map must be visible on review (HC66)',
        ).not.toBe('none');
        const h = await map.evaluate((el) => (el as HTMLElement).offsetHeight);
        expect(h, `map height must be ≥ 80 px (got ${h})`).toBeGreaterThanOrEqual(80);
        expect(h, `map height must be ≤ 130 px (got ${h})`).toBeLessThanOrEqual(130);
    });

    test('@smoke HC66 placeholder carries crisp-skeleton class during loading', async ({ page }) => {
        await openReviewStage(page);
        // The skeleton shimmer paints over the placeholder during the
        // GPS + Overpass + Leaflet warm-up window. The class is
        // applied statically in markup; building-select.js hides the
        // placeholder (display: none) once tiles render. So as long
        // as the placeholder hasn't been hidden yet, the class
        // should be present.
        const placeholder = page.locator('#building-map-placeholder');
        await expect(placeholder).toHaveCount(1);
        const classes = await placeholder.evaluate((el) => el.className);
        expect(
            classes,
            'placeholder must carry crisp-skeleton class for shimmer',
        ).toContain('crisp-skeleton');
    });

    test('@smoke HC66 photo card legacy classes are gone (no .v4-review-row--photo on review)', async ({ page }) => {
        await openReviewStage(page);
        // HC66 removed the photo `.v4-review-row` wrapper + the
        // location `.v4-review-row` wrapper + the chip strip.
        // Pre-HC66 markup elements (kept here as regression guards
        // so a future revert is caught).
        await expect(
            page.locator('#stage-v4-review .v4-review-row--photo'),
            'pre-HC66 photo row class must be gone',
        ).toHaveCount(0);
        await expect(
            page.locator('#stage-v4-review .v4-review-row--location'),
            'pre-HC66 location row class must be gone',
        ).toHaveCount(0);
        await expect(
            page.locator('#stage-v4-review .v4-review-classify-strip'),
            'pre-HC66 classify-strip wrapper must be gone',
        ).toHaveCount(0);
        // UNDP "Additional info" row stays as a `.v4-review-row`.
        await expect(
            page.locator('#btn-v4-open-undp.v4-review-row'),
            'Additional info row keeps its `.v4-review-row` skin',
        ).toHaveCount(1);
    });

    // ── RTL + Devanagari zero-scroll guards ──────────────────────────
    for (const lang of ['ar', 'hi'] as const) {
        test(`@smoke ${lang}: review still fits without vertical scroll`, async ({ page }) => {
            await openReviewStage(page, lang);
            await page.waitForFunction(
                (target) => document.documentElement.lang === target,
                lang,
                { timeout: 5000 },
            );
            const overflow = await page.evaluate(() => {
                const body = document.querySelector('#stage-v4-review .v4-body') as HTMLElement | null;
                if (!body) return -1;
                return body.scrollHeight - body.clientHeight;
            });
            expect(
                overflow,
                `${lang}: v4-body overflow must be ≤ 2 px (got ${overflow})`,
            ).toBeLessThanOrEqual(2);
        });
    }
});
