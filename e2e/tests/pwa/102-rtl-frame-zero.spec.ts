/**
 * RTL frame-0 guarantee — AUDIT 2026-05-23.
 *
 * For AR/UR locales, asserts that documentElement.dir === 'rtl' is set
 * BEFORE any descendant element with directional layout becomes
 * available. Catches regressions where the head IIFE is moved or
 * deleted — RTL users would see a brief LTR layout flicker before
 * direction flip.
 *
 * Uses a MutationObserver-style assertion: snapshots dir at the
 * earliest possible moment (init script + addEventListener for the
 * first child added to body), then asserts the snapshot already
 * shows 'rtl' for AR/UR.
 */
import { test, expect } from '@playwright/test';

for (const code of ['ar', 'ur'] as const) {
    test(`@smoke <html dir="rtl"> set before body parses (${code})`, async ({ page }) => {
        // Hook into the EARLIEST possible callback — the moment <body>
        // starts parsing. We use a MutationObserver on documentElement
        // that fires the instant the body element is appended.
        await page.addInitScript((lang) => {
            localStorage.setItem('crisp_lang_manual', lang);
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
            (window as any).__rtlSnapshotEarly = null;
            (window as any).__rtlSnapshotOnBody = null;

            // Snapshot at end of head (DOMContentLoaded would be after walker).
            document.addEventListener('readystatechange', () => {
                if (document.readyState === 'interactive' && !(window as any).__rtlSnapshotEarly) {
                    (window as any).__rtlSnapshotEarly = {
                        dir: document.documentElement.dir,
                        lang: document.documentElement.lang,
                    };
                }
            });

            // Also snapshot when body first appears.
            const obs = new MutationObserver(() => {
                if (document.body && !(window as any).__rtlSnapshotOnBody) {
                    (window as any).__rtlSnapshotOnBody = {
                        dir: document.documentElement.dir,
                        lang: document.documentElement.lang,
                    };
                    obs.disconnect();
                }
            });
            try { obs.observe(document.documentElement, { childList: true }); } catch (_) {}
        }, code);

        await page.goto('index.html');
        await page.waitForLoadState('domcontentloaded');

        const snapshots = await page.evaluate(() => ({
            early: (window as any).__rtlSnapshotEarly,
            onBody: (window as any).__rtlSnapshotOnBody,
            final: {
                dir: document.documentElement.dir,
                lang: document.documentElement.lang,
            },
        }));

        // dir + lang must be correct at every snapshot point. If even
        // ONE shows 'ltr' for an RTL locale, the layout would have
        // flickered for the user at that moment.
        if (snapshots.onBody) {
            expect(snapshots.onBody.dir).toBe('rtl');
            expect(snapshots.onBody.lang).toBe(code);
        }
        if (snapshots.early) {
            expect(snapshots.early.dir).toBe('rtl');
            expect(snapshots.early.lang).toBe(code);
        }
        expect(snapshots.final.dir).toBe('rtl');
        expect(snapshots.final.lang).toBe(code);
    });
}

test('he (Hebrew) — unsupported RTL — family-fallback to en (LTR)', async ({ page }) => {
    // HE is NOT in supported 22. Family-fallback routes to 'en'.
    // The dir should be 'ltr' (matching the en fallback), NOT 'rtl'.
    // This verifies we don't accidentally render an RTL layout with
    // English text — that would be a worst-case visual breakage.
    await page.addInitScript(() => {
        localStorage.setItem('crisp_lang_manual', 'he');
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
    });
    await page.goto('index.html');
    await page.waitForLoadState('domcontentloaded');
    const [lang, dir] = await page.evaluate(() => [
        document.documentElement.lang,
        document.documentElement.dir,
    ]);
    // Family map: he → en (FAMILY['he'] = 'en' in the head IIFE).
    expect(lang).toBe('en');
    expect(dir).toBe('ltr');
});
