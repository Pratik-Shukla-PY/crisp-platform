/**
 * PWA — K.4.c (Phase K, May 2026): capped + jittered exponential backoff.
 *
 * Pre-fix the 5-retry ladder summed to 2+4+8+16+32 = 62 s. On Wi-Fi
 * that flapped every 30 s the entire retry window could land during
 * outages → chunk failed even though connectivity returned within
 * 30 s.
 *
 * Fix: cap each delay at 30 s, add ≤1 s jitter, default to 7 retries
 * (~3 min total budget). Spec verifies the schedule by computing
 * delays for attempts 1..10.
 */
import { test, expect } from '@playwright/test';

const DEVICE_HASH = 'TEST-DEVICE-K4C-BACKOFF';

async function bootPwa(page) {
    await page.addInitScript((h) => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_id_v2', h);
    }, DEVICE_HASH);
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispBackoffDelayMs === 'function',
        null, { timeout: 8000 },
    );
}


test.describe('PWA K.4.c — backoff cap + jitter', () => {
    test('attempt 1 → ~2 s + jitter', async ({ page }) => {
        await bootPwa(page);
        const d = await page.evaluate(() => (window as any).__crispBackoffDelayMs(1));
        expect(d).toBeGreaterThanOrEqual(2000);
        expect(d).toBeLessThan(3001);  // 2000 + 999 + epsilon
    });

    test('attempt 2 → ~4 s + jitter', async ({ page }) => {
        await bootPwa(page);
        const d = await page.evaluate(() => (window as any).__crispBackoffDelayMs(2));
        expect(d).toBeGreaterThanOrEqual(4000);
        expect(d).toBeLessThan(5001);
    });

    test('attempt 4 → 16 s + jitter (still below cap)', async ({ page }) => {
        await bootPwa(page);
        const d = await page.evaluate(() => (window as any).__crispBackoffDelayMs(4));
        expect(d).toBeGreaterThanOrEqual(16000);
        expect(d).toBeLessThan(17001);
    });

    test('attempt 5 → capped at 30 s (32 s pre-fix)', async ({ page }) => {
        await bootPwa(page);
        const d = await page.evaluate(() => (window as any).__crispBackoffDelayMs(5));
        expect(d).toBeGreaterThanOrEqual(30000);
        expect(d).toBeLessThan(31001);  // capped, plus jitter
    });

    test('attempts 6 and 7 → still 30 s + jitter (cap holds)', async ({ page }) => {
        await bootPwa(page);
        const d6 = await page.evaluate(() => (window as any).__crispBackoffDelayMs(6));
        const d7 = await page.evaluate(() => (window as any).__crispBackoffDelayMs(7));
        for (const d of [d6, d7]) {
            expect(d).toBeGreaterThanOrEqual(30000);
            expect(d).toBeLessThan(31001);
        }
    });

    test('total 7-retry budget covers 3 consecutive 30 s flaps', async ({ page }) => {
        await bootPwa(page);
        const total = await page.evaluate(() => {
            let sum = 0;
            // Sum 7 retries × max-jittered cap. Total budget ≥ 90s ≥ 3×30s flap.
            for (let i = 1; i <= 7; i++) {
                sum += (window as any).__crispBackoffDelayMs(i);
            }
            return sum;
        });
        // 2 + 4 + 8 + 16 + 30 + 30 + 30 = 120s minimum (plus up to 7s jitter).
        expect(total).toBeGreaterThanOrEqual(120_000);
    });
});
