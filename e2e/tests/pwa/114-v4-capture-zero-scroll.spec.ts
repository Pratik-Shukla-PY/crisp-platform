/**
 * HC60 (May 2026) — V4 Stage 1 ("Show what you see") zero-scroll
 * redesign.
 *
 * Operator (2026-05-25): "Redesign Stage 1 to fit completely within a
 * single-screen viewport with ZERO vertical scroll across the planned
 * mobile device matrix (especially iPhone SE, small Android devices,
 * installed PWA mode)." Current issues: too much vertical spacing,
 * Helpful Tips eats height, GPS location truncates mid-word, Continue
 * pushes below fold, Voice/Text consume unnecessary space.
 *
 * Pre-HC60 the stage rendered at ~702 px on iPhone SE (375 × 667) —
 * 113 px over the usable budget (589 px after safe-area). Six cuts:
 *   1. Meta card: 3-line timezone stack folded into a single sub-row
 *      under a 2-line clamped location name (96 → 50 px).
 *   2. Title margins tightened (36 → 22 px).
 *   3. Photo card buttons compacted + 0/5 counter hidden pre-capture
 *      (154 → 110 px).
 *   4. Voice/Text 2-chip row replaced by single adaptive row with
 *      icon-only triggers (66 → 48 px).
 *   5. Tips card: eyebrow + impact line dropped, tips compressed to
 *      single-line format with smaller icons, auto-hide when either
 *      secondary input is open OR ≥ 1 photo captured (140 → 76 px).
 *   6. Stage gaps + padding tightened (114 → 84 px).
 * Plus the new pulse-timer recorder UI (no canvas waveform).
 *
 * This spec pins:
 *   1. `#stage-v4-capture` fits without vertical scroll at 375 × 667.
 *   2. Continue button is visible without scrolling.
 *   3. A long location name renders in ≤ 2 lines AND no horizontal
 *      overflow (no mid-word truncation regression).
 *   4. Tapping the mic trigger morphs the panel into the recorder
 *      state row (pulsing dot + label + timer + delete/stop).
 *      Timer advances at least once after a 1.1 s wait.
 *   5. Tapping the text trigger reveals the textarea AND the tips
 *      card auto-hides via the `is-secondary-input-open` rule.
 *   6. Zero-scroll regression also holds for Arabic (RTL) and
 *      Hindi (Devanagari ascenders).
 */
import { test, expect, type Page } from '@playwright/test';

const IPHONE_SE = { width: 375, height: 667 };

async function bootCaptureStage(page: Page, lang = 'en') {
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
    await page.evaluate(() => {
        // Land on the capture stage cleanly — no photos, no audio, no
        // text. This is the IDLE state the operator screenshot showed.
        (window as any).state = (window as any).state || {};
        (window as any).state.v4Photos = [];
        (window as any).state.audioBlob = null;
        (window as any).state.description = '';
        (window as any).state.transcript = '';
        (window as any).state.location = {
            lat: 12.9716, lng: 77.5946, acc: 35,
        };
        (window as any).goToStage('stage-v4-capture');
    });
    await expect(page.locator('#stage-v4-capture.active'))
        .toBeVisible({ timeout: 3000 });
}

test.describe('PWA — HC60 V4 Stage 1 zero-scroll', () => {
    test('@smoke iPhone SE: #stage-v4-capture has no vertical scroll', async ({ page }) => {
        await bootCaptureStage(page);
        // The stage is a CSS grid (`auto 1fr auto`). Its own height is
        // the .mobile-screen height; the inner `.v4-body` is the only
        // scrollable region. The invariant we pin is that `.v4-body`'s
        // content fits within its allocated space (no inner scroll).
        const overflow = await page.evaluate(() => {
            const body = document.querySelector('#stage-v4-capture .v4-body') as HTMLElement | null;
            if (!body) return null;
            return {
                scrollHeight: body.scrollHeight,
                clientHeight: body.clientHeight,
                overflow: body.scrollHeight - body.clientHeight,
            };
        });
        expect(overflow, 'v4-body should exist').not.toBeNull();
        // Allow up to 2 px slop for sub-pixel rounding under DPR > 1.
        expect(
            overflow!.overflow,
            `v4-body overflow must be ≤ 2 px (got ${overflow!.overflow})`,
        ).toBeLessThanOrEqual(2);
    });

    test('@smoke Continue CTA is visible without scrolling', async ({ page }) => {
        await bootCaptureStage(page);
        const continueBtn = page.locator('#btn-v4-capture-next');
        await expect(continueBtn).toBeVisible();
        const box = await continueBtn.boundingBox();
        const viewport = page.viewportSize();
        expect(box, 'Continue button must have layout').not.toBeNull();
        expect(viewport).not.toBeNull();
        // Bottom edge must fall within the viewport (no scrolling needed).
        expect(
            box!.y + box!.height,
            `Continue bottom (${box!.y + box!.height}) must be ≤ viewport.height (${viewport!.height})`,
        ).toBeLessThanOrEqual(viewport!.height);
        // Top edge must be within the viewport too (not pushed below by
        // a runaway tips card).
        expect(box!.y, 'Continue top must be in viewport').toBeLessThan(viewport!.height);
    });

    test('@smoke long location name clamps to 2 lines without horizontal overflow', async ({ page }) => {
        await bootCaptureStage(page);
        // Paint a long, realistic location name (matches operator's
        // truncated screenshot: "Electronic City, Bangalore South Zone…").
        const longName = 'Electronic City, Bangalore South Zone, Karnataka, India';
        await page.evaluate((name) => {
            const el = document.getElementById('v4-meta-location-text');
            if (el) el.textContent = name;
        }, longName);
        const el = page.locator('#v4-meta-location-text');
        await expect(el).toBeVisible();
        const dims = await el.evaluate((node) => {
            const styles = getComputedStyle(node);
            const lh = parseFloat(styles.lineHeight) || 18;
            return {
                offsetHeight: (node as HTMLElement).offsetHeight,
                offsetWidth: (node as HTMLElement).offsetWidth,
                scrollWidth: (node as HTMLElement).scrollWidth,
                lineHeight: lh,
            };
        });
        // 2-line clamp: offsetHeight must be ≤ ~ 2 × line-height + a few
        // px of internal padding/leading slop.
        expect(
            dims.offsetHeight,
            `location name must fit in 2 lines (got ${dims.offsetHeight} px, line-height ${dims.lineHeight})`,
        ).toBeLessThanOrEqual(Math.ceil(dims.lineHeight * 2) + 6);
        // No horizontal overflow — the long name should ellipsize via
        // the 2-line clamp, not push past the card's right edge.
        expect(
            dims.scrollWidth - dims.offsetWidth,
            'location name must not overflow its container horizontally',
        ).toBeLessThanOrEqual(1);
    });

    test('@smoke tapping the mic trigger reveals the recorder state row + timer advances', async ({ page }) => {
        await bootCaptureStage(page);
        // Grant mic permission so the MediaRecorder lifecycle reaches
        // recording state without prompting.
        await page.context().grantPermissions(['microphone'], { origin: page.url() });
        const micTrigger = page.locator('#v4-cap-chip-voice');
        await micTrigger.click();
        // Voice panel opens.
        await expect(page.locator('#v4-cap-voice-panel')).toBeVisible();
        // Tap the big mic CTA to start recording.
        const micCta = page.locator('#btn-v4-cap-mic');
        await micCta.click();
        // Recorder state row should be visible; timer starts at 0:00.
        const stateRow = page.locator('#v4-cap-recorder-state');
        await expect(stateRow).toBeVisible({ timeout: 2000 });
        const timerEl = page.locator('#v4-cap-recorder-timer');
        const t0 = (await timerEl.textContent())?.trim() || '';
        expect(t0, 'timer starts at 0:00').toBe('0:00');
        // Wait > 1 s for the setInterval(1000) to tick.
        await page.waitForTimeout(1200);
        const t1 = (await timerEl.textContent())?.trim() || '';
        expect(
            t1,
            `timer must advance after 1.2 s (got "${t1}")`,
        ).not.toBe('0:00');
        // Pulse animation: the red dot must be present + visible.
        await expect(page.locator('.v4-cap-recorder-dot')).toBeVisible();
        // Cleanup: tap stop so the test doesn't leave a recorder spinning.
        await page.locator('#btn-v4-cap-recorder-stop').click();
    });

    test('@smoke tapping the text trigger reveals textarea + tips auto-hide', async ({ page }) => {
        await bootCaptureStage(page);
        // Pre-condition: tips card visible in idle state.
        const tips = page.locator('#v4-cap-tips');
        await expect(tips).toBeVisible();

        await page.locator('#v4-cap-chip-text').click();
        // Text panel opens.
        await expect(page.locator('#v4-cap-text-panel')).toBeVisible();
        await expect(page.locator('#v4-cap-text-area')).toBeVisible();
        // The stage must carry the auto-hide class.
        const stageHasClass = await page.evaluate(() =>
            document.getElementById('stage-v4-capture')!
                .classList.contains('is-secondary-input-open'),
        );
        expect(stageHasClass, 'stage must carry is-secondary-input-open').toBe(true);
        // Tips card must be hidden via CSS (display: none).
        const tipsDisplay = await tips.evaluate(
            (el) => getComputedStyle(el).display,
        );
        expect(tipsDisplay, 'tips card must be display:none when text panel open').toBe('none');

        // Toggling the text trigger off must restore tips visibility.
        await page.locator('#v4-cap-chip-text').click();
        await expect(tips).toBeVisible();
        const tipsDisplay2 = await tips.evaluate(
            (el) => getComputedStyle(el).display,
        );
        expect(tipsDisplay2, 'tips card must re-display after collapse').not.toBe('none');
    });

    // ── RTL + Devanagari zero-scroll guards ──────────────────────────
    //
    // Hindi (शिरोरेखा top-bar) and Arabic (RTL + slightly taller
    // ascenders) are the two scripts most likely to push the stage
    // back into overflow. Re-running the iPhone SE zero-scroll check
    // in each locale catches the regression at gate time.

    for (const lang of ['ar', 'hi'] as const) {
        test(`@smoke ${lang}: stage still fits without vertical scroll`, async ({ page }) => {
            await bootCaptureStage(page, lang);
            // Wait for the boot-time i18n walker to settle (otherwise
            // we'd measure mid-paint English placeholders).
            await page.waitForFunction(
                (target) => document.documentElement.lang === target,
                lang,
                { timeout: 5000 },
            );
            const overflow = await page.evaluate(() => {
                const body = document.querySelector('#stage-v4-capture .v4-body') as HTMLElement | null;
                if (!body) return -1;
                return body.scrollHeight - body.clientHeight;
            });
            expect(
                overflow,
                `${lang}: v4-body overflow must be ≤ 2 px (got ${overflow})`,
            ).toBeLessThanOrEqual(2);
        });
    }

    // ── HC68 (May 2026) — flex-fill on tall viewports ────────────────
    //
    // Operator screenshot 2026-05-26 (Pixel 7 / Android Chrome): the
    // capture body left ~300 px of empty space below the tips card.
    // HC68 makes `.v4-cap-actions` (the Camera + Gallery grid)
    // flex-grow inside `.v4-cap-section-photo` inside `.v4-cap-
    // sections`, so the action buttons stretch to consume leftover
    // body height on bigger devices. iPhone SE baseline is unchanged
    // because content height = `min-height: 96` floor of the grid
    // (no surplus to redistribute).

    test('@smoke HC68 Pixel 7 viewport: action buttons grow to fill body', async ({ page }) => {
        // Pixel 7 viewport (412 × 915) — meaningfully taller than iPhone SE.
        await page.setViewportSize({ width: 412, height: 915 });
        await bootCaptureStage(page);
        // Don't re-set viewport (bootCaptureStage will overwrite ours).
        // Set it AGAIN after boot so the layout settles at the bigger size.
        await page.setViewportSize({ width: 412, height: 915 });
        await page.waitForTimeout(200);
        // Body must still NOT overflow.
        const overflow = await page.evaluate(() => {
            const body = document.querySelector('#stage-v4-capture .v4-body') as HTMLElement | null;
            if (!body) return -1;
            return body.scrollHeight - body.clientHeight;
        });
        expect(
            overflow,
            `Pixel 7: v4-body overflow must be ≤ 4 px (got ${overflow})`,
        ).toBeLessThanOrEqual(4);
        // The Camera + Gallery action buttons should be visibly taller
        // than the iPhone SE baseline (~52 px). On a 915-tall viewport
        // there's ~250+ px of surplus body height — buttons should
        // grow to absorb most of it.
        const cameraHeight = await page.locator('#btn-v4-camera').evaluate(
            (el) => (el as HTMLElement).offsetHeight,
        );
        expect(
            cameraHeight,
            `Pixel 7: Camera button should grow ≥ 80 px (got ${cameraHeight})`,
        ).toBeGreaterThanOrEqual(80);
        // Gallery button should match Camera's height (both share the
        // grid track via `align-items: stretch`).
        const galleryHeight = await page.locator('#btn-v4-browse').evaluate(
            (el) => (el as HTMLElement).offsetHeight,
        );
        expect(
            Math.abs(cameraHeight - galleryHeight),
            `Camera + Gallery should share equal height (got ${cameraHeight} vs ${galleryHeight})`,
        ).toBeLessThanOrEqual(2);
    });

    test('@smoke HC68 Pixel 7 viewport: Continue CTA still pinned in stage grid', async ({ page }) => {
        await page.setViewportSize({ width: 412, height: 915 });
        await bootCaptureStage(page);
        await page.setViewportSize({ width: 412, height: 915 });
        await page.waitForTimeout(200);
        // The stage grid `auto 1fr auto` should still pin the footer.
        const continueBtn = page.locator('#btn-v4-capture-next');
        await expect(continueBtn).toBeVisible();
        const rect = await continueBtn.evaluate((el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return { y: r.y, h: r.height };
        });
        // Bottom edge within viewport (915 px tall).
        expect(rect.y + rect.h, 'Continue bottom within Pixel 7 viewport').toBeLessThanOrEqual(915);
    });
});
