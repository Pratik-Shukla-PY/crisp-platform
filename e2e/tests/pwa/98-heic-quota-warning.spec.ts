/**
 * PWA — K.4.e (Phase K, May 2026): iOS HEIC quota warn.
 *
 * iOS limits each web app to 50 MB of IndexedDB. HEIC capture +
 * variant re-encode (3 tiers per photo × N extras) can exceed that
 * silently. Pre-fix the only signal was the QuotaExceededError
 * surfacing AFTER the enqueue had failed (user already lost their
 * form). K.4.e adds a proactive size check that warns the user
 * BEFORE the enqueue if the projected write would exceed 40 MB.
 *
 * Tests verify the byte-estimator and threshold constants directly.
 * Driving an actual submission to hit the warning toast is covered
 * by manual smoke; this spec keeps the unit-level contract.
 */
import { test, expect } from '@playwright/test';

const DEVICE_HASH = 'TEST-DEVICE-K4E-QUOTA';

async function bootPwa(page) {
    await page.addInitScript((h) => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_id_v2', h);
    }, DEVICE_HASH);
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispEstimateQueueItemBytes === 'function'
            && typeof (window as any).__crispQuotaWarnThresholdBytes === 'function',
        null, { timeout: 8000 },
    );
}


test.describe('PWA K.4.e — quota guard', () => {
    test('threshold is 35 MB (under iOS 50 MB cap, Phase L L.2.d tightening)', async ({ page }) => {
        // Phase L L.2.d (May 2026) dropped the threshold from 40 → 35 MB
        // because ORIGINAL tier is now up to 5 MB per photo (vs ~500 KB
        // pre-Phase-L). 35 MB still leaves 15 MB headroom under iOS's
        // 50 MB IndexedDB cap.
        await bootPwa(page);
        const t = await page.evaluate(() => (window as any).__crispQuotaWarnThresholdBytes());
        expect(t).toBe(35 * 1024 * 1024);
    });

    test('empty queue item ≈ 0 bytes', async ({ page }) => {
        await bootPwa(page);
        const b = await page.evaluate(() =>
            (window as any).__crispEstimateQueueItemBytes({}));
        expect(b).toBe(0);
    });

    test('photoVariants with size hints sums tier bytes (×1.34 b64 overhead)', async ({ page }) => {
        await bootPwa(page);
        const b = await page.evaluate(() => {
            // Phase L (May 2026): variant key is `original`, was `large`.
            const item = {
                photoVariants: {
                    small:    { size: 50_000 },
                    medium:   { size: 250_000 },
                    original: { size: 2_000_000 },
                },
            };
            return (window as any).__crispEstimateQueueItemBytes(item);
        });
        // (50_000 + 250_000 + 2_000_000) * 1.34 ≈ 3_015_000
        expect(b).toBeGreaterThan(3_000_000);
        expect(b).toBeLessThan(3_100_000);
    });

    test('5 photos × 3 tiers (≈2 MB each ORIGINAL) exceeds 35 MB threshold', async ({ page }) => {
        await bootPwa(page);
        const result = await page.evaluate(() => {
            // Realistic worst-case: main + 4 extras, each with 3 variants
            // totaling ~2.5 MB encoded per photo group.
            // Phase L: variant key is `original`, was `large`.
            const item = {
                photoVariants: {
                    small:    { size: 50_000 },
                    medium:   { size: 250_000 },
                    original: { size: 2_500_000 },
                },
                extraPhotosVariants: [
                    { small: { size: 50_000 }, medium: { size: 250_000 }, original: { size: 2_500_000 } },
                    { small: { size: 50_000 }, medium: { size: 250_000 }, original: { size: 2_500_000 } },
                    { small: { size: 50_000 }, medium: { size: 250_000 }, original: { size: 2_500_000 } },
                    { small: { size: 50_000 }, medium: { size: 250_000 }, original: { size: 2_500_000 } },
                ],
            };
            // Pad with a chunky base64 dataUrl in item.photo to push past
            // the 35 MB threshold — simulates worst-case HEIC + re-encode bloat.
            const big = 'A'.repeat(20 * 1024 * 1024);  // 20 MB string
            item.photo = `data:image/jpeg;base64,${big}`;
            const estimate = (window as any).__crispEstimateQueueItemBytes(item);
            const threshold = (window as any).__crispQuotaWarnThresholdBytes();
            return { estimate, threshold, exceeds: estimate > threshold };
        });
        expect(result.exceeds).toBe(true);
    });

    test('typical small submission stays well under threshold', async ({ page }) => {
        await bootPwa(page);
        const result = await page.evaluate(() => {
            // Realistic single-photo submission, ~3 MB total.
            // Phase L: variant key is `original`, was `large`.
            const item = {
                photoVariants: {
                    small:    { size: 50_000 },
                    medium:   { size: 200_000 },
                    original: { size: 1_500_000 },
                },
                audioSize: 100_000,
            };
            const estimate = (window as any).__crispEstimateQueueItemBytes(item);
            const threshold = (window as any).__crispQuotaWarnThresholdBytes();
            return { estimate, threshold, underThreshold: estimate < threshold };
        });
        expect(result.underThreshold).toBe(true);
        // ~2.3 MB rough estimate is well under 35 MB
        expect(result.estimate).toBeLessThan(5_000_000);
    });
});
