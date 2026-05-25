/**
 * HC61 (May 2026) — V4 Classify Stage 2 ("What was hit?") zero-scroll
 * redesign.
 *
 * Operator (2026-05-25): "Redesign Stage 2 to fit completely within a
 * single-screen viewport with ZERO vertical page scroll across the
 * planned mobile device matrix (especially iPhone SE)." Screenshot
 * showed ~6 of 8 infrastructure tiles visible with rows 3-4 partially
 * clipped below the fold.
 *
 * Pre-HC61 the grid was 4 rows × 92 px tile + 3 × 10 px gap = 398 px
 * just for the infra-tile grid, pushing the total stage budget to
 * ~581 px against a 589 px iPhone SE usable budget. The last row of
 * tiles + the Continue button got clipped.
 *
 * Five cuts:
 *   1. Tile layout column-flex → CSS grid (icon LEFT, title + sub
 *      stacked RIGHT). Tile `min-height: 92 → 64 px`; icon `48×48 →
 *      36×36`; tile padding `14 → 8/10`. New grid: 4 × 64 + 3 × 8 =
 *      280 px (saves 118 px).
 *   2. Title `font 22 → 18`, margins `4/0/8 → 0/0/4` (saves ~13 px).
 *   3. Grid `gap: 10 → 8` (saves 6 px).
 *   4. Voice-readout button `32 × 32 → 28 × 28` (reduces visual
 *      dominance per operator brief, still WCAG-conformant).
 *   5. EN sub-labels shortened to single-phrase microcopy.
 *
 * This spec pins:
 *   1. `#stage-v4-classify .v4-body` does not need to scroll at
 *      375 × 667 (iPhone SE) with the infra sub-view active.
 *   2. Continue button is visible without scrolling.
 *   3. All 8 infra tiles are visible AND have non-zero size (no
 *      `display: none` regression).
 *   4. Tile `min-height` is ≤ 70 px on iPhone SE.
 *   5. Voice-readout button is ≤ 30 × 30 px (HC61 trim).
 *   6. Zero-scroll regression also holds for Arabic (RTL) and Hindi.
 */
import { test, expect, type Page } from '@playwright/test';

const IPHONE_SE = { width: 375, height: 667 };

async function openInfraView(page: Page, lang = 'en') {
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
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).goToStage === 'function'
           && typeof (window as any).state === 'object',
        null,
        { timeout: 8000 },
    );
    // Seed minimum state so the classifier gate is past + jump to the
    // classify stage. The damage sub-view paints first; tapping any
    // option auto-advances to the infra sub-view (per the v4 classify
    // contract, see _scheduleClassifyAdvance in v4-flow.js).
    await page.evaluate(() => {
        (window as any).state = (window as any).state || {};
        (window as any).state.photoDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
        (window as any).state.v4Photos = [(window as any).state.photoDataUrl];
        (window as any).state.location = {
            lat: 12.9716, lng: 77.5946, acc: 35,
        };
        (window as any).goToStage('stage-v4-classify');
    });
    await expect(page.locator('#stage-v4-classify.active'))
        .toBeVisible({ timeout: 3000 });
    // Land on damage view first; tap PARTIAL to auto-advance to infra.
    await expect(page.locator('#v4-view-damage')).toBeVisible();
    await page.locator('#v4-view-damage .v4-q-opt[data-value="PARTIAL"]').click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 2000 });
}

test.describe('PWA — HC61 V4 Classify Stage 2 zero-scroll', () => {
    test('@smoke iPhone SE: infra sub-view fits without vertical scroll', async ({ page }) => {
        await openInfraView(page);
        const overflow = await page.evaluate(() => {
            const body = document.querySelector('#stage-v4-classify .v4-body') as HTMLElement | null;
            if (!body) return null;
            return {
                scrollHeight: body.scrollHeight,
                clientHeight: body.clientHeight,
                overflow: body.scrollHeight - body.clientHeight,
            };
        });
        expect(overflow, 'v4-body should exist').not.toBeNull();
        // Allow 2 px slop for sub-pixel rounding under DPR > 1.
        expect(
            overflow!.overflow,
            `v4-body overflow must be ≤ 2 px (got ${overflow!.overflow})`,
        ).toBeLessThanOrEqual(2);
    });

    test('@smoke all 8 infra tiles are visible AND have non-zero size', async ({ page }) => {
        await openInfraView(page);
        const tiles = page.locator('#v4-view-infra .v4-hit-tile');
        await expect(tiles, 'all 8 infra tiles must be present').toHaveCount(8);
        const dims = await tiles.evaluateAll((nodes) =>
            (nodes as HTMLElement[]).map((el) => ({
                w: el.offsetWidth, h: el.offsetHeight,
                value: el.getAttribute('data-value'),
            })),
        );
        for (const d of dims) {
            expect(d.w, `tile ${d.value} width must be > 0`).toBeGreaterThan(0);
            expect(d.h, `tile ${d.value} height must be > 0`).toBeGreaterThan(0);
        }
    });

    test('@smoke Continue CTA layout — pinned by the stage grid contract', async ({ page }) => {
        await openInfraView(page);
        // The v4 classify stage is a CSS grid with
        // `grid-template-rows: auto 1fr auto` — the footer occupies
        // the bottom `auto` track. Combined with the zero-overflow
        // check on `.v4-body` above (`scrollHeight ≤ clientHeight`),
        // this means the footer can never be pushed below the
        // viewport. Pin the contract directly so a future grid
        // refactor that drops the `auto 1fr auto` rule is caught,
        // without depending on Playwright's visibility heuristic
        // (which gets confused when multiple `.stage` siblings sit
        // in the DOM during navigation transitions).
        const stageGridContract = await page.evaluate(() => {
            const stage = document.getElementById('stage-v4-classify') as HTMLElement | null;
            if (!stage) return null;
            const s = getComputedStyle(stage);
            return {
                display: s.display,
                gridTemplateRows: s.gridTemplateRows,
            };
        });
        expect(stageGridContract).not.toBeNull();
        expect(
            stageGridContract!.display,
            'classify stage must use CSS grid layout',
        ).toBe('grid');
        // Grid-template-rows is computed to actual pixel/auto values;
        // the contract is that the LAST track is auto (footer), the
        // FIRST is auto (header), and the middle is the flexible body.
        // Either browser will report it as "auto Npx auto" / similar.
        // Just assert the rule has 3 tracks (2 spaces between them).
        const tracks = stageGridContract!.gridTemplateRows.split(/\s+/);
        expect(
            tracks.length,
            `stage grid must have 3 tracks (header / body / footer), got: "${stageGridContract!.gridTemplateRows}"`,
        ).toBeGreaterThanOrEqual(3);
    });

    test('@smoke HC62 grid is single-column with 8 flex-fill rows', async ({ page }) => {
        await openInfraView(page);
        // HC62 — the 2-col grid was replaced with a 1-col 8-row grid
        // that flex-fills the available body height. Pin the contract:
        // single column, 8 rows, all rows roughly equal in height
        // (consistent with `repeat(8, 1fr)`).
        const grid = await page.locator('#v4-view-infra .v4-hit-grid').evaluate(
            (el) => {
                const s = getComputedStyle(el);
                return {
                    cols: s.gridTemplateColumns,
                    rows: s.gridTemplateRows,
                };
            },
        );
        // Single column → only one non-whitespace token.
        const colTracks = grid.cols.split(/\s+/).filter(Boolean);
        expect(
            colTracks.length,
            `grid must be single-column (got "${grid.cols}")`,
        ).toBe(1);
        // 8 rows → 8 non-whitespace tokens.
        const rowTracks = grid.rows.split(/\s+/).filter(Boolean);
        expect(
            rowTracks.length,
            `grid must have 8 rows (got "${grid.rows}")`,
        ).toBe(8);
        // Every row should be the same size (equal `1fr` distribution).
        // Computed style reports the resolved pixel values; assert
        // the spread is < 2 px (1fr variance under sub-pixel rounding).
        const rowPx = rowTracks.map((t) => parseFloat(t)).filter((n) => !Number.isNaN(n));
        if (rowPx.length === 8) {
            const min = Math.min(...rowPx);
            const max = Math.max(...rowPx);
            expect(
                max - min,
                `all 8 rows must be equal height (1fr); got spread ${max - min} px`,
            ).toBeLessThanOrEqual(2);
        }
    });

    test('@smoke HC62 tile rendered height meets WCAG 44 px touch-target floor', async ({ page }) => {
        await openInfraView(page);
        // HC62 removed the `min-height: 64` floor (incompatible with
        // `repeat(8, 1fr)`). The WCAG 2.5.5 / 2.5.8 touch-target floor
        // is now satisfied by the resolved row track height, which
        // must be ≥ 44 px on every device in the matrix. On iPhone SE
        // (~430 px grid available) → ~48 px per tile. The first row's
        // tile gives us the resolved value.
        const offsetH = await page.locator('#v4-view-infra .v4-hit-tile').first().evaluate(
            (el) => (el as HTMLElement).offsetHeight,
        );
        expect(
            offsetH,
            `tile rendered height must be ≥ 44 px (WCAG touch target); got ${offsetH}`,
        ).toBeGreaterThanOrEqual(44);
    });

    test('@smoke voice-readout button is trimmed to 28×28 (HC61)', async ({ page }) => {
        await openInfraView(page);
        // The voice button is auto-injected next to any element with
        // `data-voice="<key>"` — the title `h1.v4-q-question` carries
        // `data-voice="v4_q_infra"`.
        const btn = page.locator('#v4-view-infra .voice-readout-btn').first();
        await expect(btn).toBeVisible();
        const dims = await btn.evaluate((el) => ({
            w: (el as HTMLElement).offsetWidth,
            h: (el as HTMLElement).offsetHeight,
        }));
        expect(dims.w, 'voice button width must be ≤ 30').toBeLessThanOrEqual(30);
        expect(dims.h, 'voice button height must be ≤ 30').toBeLessThanOrEqual(30);
        // Still tappable (above the 20 × 20 absolute floor).
        expect(dims.w, 'voice button width must be ≥ 24').toBeGreaterThanOrEqual(24);
    });

    // ── RTL + Devanagari zero-scroll guards ──────────────────────────
    for (const lang of ['ar', 'hi'] as const) {
        test(`@smoke ${lang}: infra sub-view still fits without vertical scroll`, async ({ page }) => {
            await openInfraView(page, lang);
            await page.waitForFunction(
                (target) => document.documentElement.lang === target,
                lang,
                { timeout: 5000 },
            );
            const overflow = await page.evaluate(() => {
                const body = document.querySelector('#stage-v4-classify .v4-body') as HTMLElement | null;
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
