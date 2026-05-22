/**
 * AUDIT (2026-05-23) — viewport-matrix + modal-overlay probe.
 *
 * Captures every PWA stage at 4 viewports and every overlay at default
 * viewport, in EN and AR (RTL). Outputs to e2e/screenshots/audit/.
 * Not gated; outputs are evidence only.
 */
import { test, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const OUT = path.resolve(__dirname, '..', '..', 'screenshots', 'audit');

const VIEWPORTS: Record<string, { width: number; height: number }> = {
    iphone_se: { width: 375, height: 667 },
    iphone_14: { width: 390, height: 844 },
    galaxy_s: { width: 360, height: 640 },
    ipad:     { width: 768, height: 1024 },
};

const STAGES = [
    'stage-home',
    'stage-v4-capture',
    'stage-v4-classify',
    'stage-v4-review',
    'stage-history',
    'stage-success',
    'stage-settings',
    'stage-rewards',
];

const LOCALES = ['en', 'ar'];

async function boot(page, lang: string) {
    await page.addInitScript((code) => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang_manual', code);
    }, lang);
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function',
        null, { timeout: 8000 });
    await page.waitForTimeout(600);
}

test.beforeAll(() => {
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
});

for (const lang of LOCALES) {
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
        test(`audit matrix — ${lang} @ ${vpName}`, async ({ page }) => {
            await page.setViewportSize(vp);
            await boot(page, lang);
            for (const stage of STAGES) {
                try {
                    await page.evaluate((s) => (window as any).__crispGoToStage(s), stage);
                    // Some stages defer content rendering to a separate entry
                    // function (e.g. openMyReports() fires _renderPartialReports
                    // + _renderSubmittedReports). Direct __crispGoToStage skips
                    // that, leaving the stage in its initial (often blank) state.
                    // Trigger the renderers explicitly to capture user-perceived UI.
                    if (stage === 'stage-history') {
                        await page.evaluate(async () => {
                            const w: any = window;
                            if (typeof w._renderPartialReports === 'function') {
                                try { await w._renderPartialReports(); } catch {}
                            }
                            if (typeof w._renderSubmittedReports === 'function') {
                                try { await w._renderSubmittedReports(); } catch {}
                            }
                        });
                        await page.waitForTimeout(800);
                    } else {
                        await page.waitForTimeout(350);
                    }
                    await page.screenshot({
                        path: path.join(OUT, `${lang}_${vpName}_${stage}.png`),
                        fullPage: false,
                    });
                } catch (e) {
                    console.warn(`stage ${stage} failed: ${e}`);
                }
            }
        });
    }
}

// Modal/overlay probe — one viewport (iphone_14), EN only
test('audit overlays — en @ iphone_14', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.iphone_14);
    await boot(page, 'en');

    // 1. Lang picker
    await page.evaluate(() => (window as any).__crispGoToStage('stage-home'));
    await page.waitForTimeout(300);
    const langPicker = page.locator('#lang-picker-overlay');
    await page.evaluate(() => {
        const o = document.getElementById('lang-picker-overlay');
        if (o) { o.hidden = false; o.style.display = 'flex'; }
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'overlay_lang-picker.png') });
    await page.evaluate(() => {
        const o = document.getElementById('lang-picker-overlay');
        if (o) { o.hidden = true; o.style.display = 'none'; }
    });

    // 2. Channels sheet
    await page.evaluate(() => {
        const o = document.getElementById('channels-sheet');
        const bd = document.getElementById('channels-sheet-backdrop');
        if (o) { o.hidden = false; o.style.display = 'flex'; }
        if (bd) { bd.hidden = false; bd.style.display = 'block'; }
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'overlay_channels-sheet.png') });
    await page.evaluate(() => {
        const o = document.getElementById('channels-sheet');
        const bd = document.getElementById('channels-sheet-backdrop');
        if (o) { o.hidden = true; o.style.display = 'none'; }
        if (bd) { bd.hidden = true; bd.style.display = 'none'; }
    });

    // 3. Building footprint overlay
    await page.evaluate(() => {
        const o = document.getElementById('building-fs-overlay');
        if (o) { o.hidden = false; o.style.display = 'flex'; }
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'overlay_building-fs.png') });
    await page.evaluate(() => {
        const o = document.getElementById('building-fs-overlay');
        if (o) { o.hidden = true; o.style.display = 'none'; }
    });

    // 4. Image viewer overlay
    await page.evaluate(() => {
        const o = document.getElementById('image-viewer-overlay');
        if (o) { o.hidden = false; o.style.display = 'flex'; }
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'overlay_image-viewer.png') });
    await page.evaluate(() => {
        const o = document.getElementById('image-viewer-overlay');
        if (o) { o.hidden = true; o.style.display = 'none'; }
    });

    // 5. v4 UNDP sheet
    await page.evaluate(() => {
        const o = document.getElementById('v4-undp-sheet');
        const bd = document.getElementById('v4-undp-sheet-backdrop');
        if (o) { o.hidden = false; o.style.display = 'flex'; }
        if (bd) { bd.hidden = false; bd.style.display = 'block'; }
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'overlay_v4-undp-sheet.png') });
    await page.evaluate(() => {
        const o = document.getElementById('v4-undp-sheet');
        const bd = document.getElementById('v4-undp-sheet-backdrop');
        if (o) { o.hidden = true; o.style.display = 'none'; }
        if (bd) { bd.hidden = true; bd.style.display = 'none'; }
    });

    // 6. Upload overlay
    await page.evaluate(() => {
        const o = document.getElementById('upload-overlay');
        if (o) { o.hidden = false; o.style.display = 'flex'; }
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'overlay_upload.png') });
    await page.evaluate(() => {
        const o = document.getElementById('upload-overlay');
        if (o) { o.hidden = true; o.style.display = 'none'; }
    });

    // 7. Photo consent overlay
    await page.evaluate(() => {
        const o = document.getElementById('photo-consent-overlay');
        if (o) { o.hidden = false; o.style.display = 'flex'; }
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'overlay_photo-consent.png') });
});
