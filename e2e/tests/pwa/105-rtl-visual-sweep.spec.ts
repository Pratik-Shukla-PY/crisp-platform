/**
 * RTL visual sweep — AUDIT 2026-05-23.
 *
 * Captures every stage at the three RTL test locales (AR + UR + HE-
 * fallback) for visual review. NOT a pixel-diff gate; the screenshots
 * land in e2e/screenshots/audit/rtl-deep/ for manual operator review.
 *
 * Run when:
 *   - A new RTL-affecting layout change lands (anything touching
 *     directional CSS / icons / modals / map overlays)
 *   - Adding a new locale to SUPPORTED_LANGS
 *   - Investigating an RTL bug report
 *
 * AR + UR are the supported RTL locales. HE is included as a
 * family-fallback canary — verifies the head IIFE's FAMILY map sends
 * HE → 'en' (LTR) so users in unsupported RTL locales still get a
 * coherent (if English) UI.
 */
import { test, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const OUT = path.resolve(__dirname, '..', '..', 'screenshots', 'audit', 'rtl-deep');

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

const LOCALES_FOR_SWEEP = [
    { code: 'ar', expectedDir: 'rtl', label: 'Arabic' },
    { code: 'ur', expectedDir: 'rtl', label: 'Urdu' },
    { code: 'he', expectedDir: 'ltr', label: 'Hebrew (family-fallback to en)' },
];

test.use({
    viewport: { width: 375, height: 667 },  // iPhone SE
});

test.beforeAll(() => {
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
});

for (const loc of LOCALES_FOR_SWEEP) {
    test(`RTL sweep — ${loc.code} (${loc.label})`, async ({ page }) => {
        await page.addInitScript((lang) => {
            localStorage.setItem('crisp_lang_manual', lang);
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_ui_v4', 'on');
        }, loc.code);
        await page.goto('index.html?ui=v4');
        await page.waitForFunction(
            () => typeof (window as any).__crispGoToStage === 'function',
            null, { timeout: 8000 },
        );

        for (const stage of STAGES) {
            try {
                await page.evaluate((s) => (window as any).__crispGoToStage(s), stage);
                // history needs explicit renderer calls (per _audit_matrix
                // pattern — openMyReports normally triggers them).
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
                    path: path.join(OUT, `${loc.code}_iphone_se_${stage}.png`),
                    fullPage: false,
                });
            } catch (e) {
                console.warn(`${loc.code}/${stage} failed: ${e}`);
            }
        }
    });
}
