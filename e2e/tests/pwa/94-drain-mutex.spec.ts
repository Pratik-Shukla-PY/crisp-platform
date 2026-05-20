/**
 * PWA — K.4.a (Phase K, May 2026): cross-tab/window drain mutex.
 *
 * Pre-fix the in-process `_retryLoopRunning` flag prevented one tab
 * from starting two concurrent retry loops, but two tabs (or the
 * installed PWA + a browser tab) each had their own initial false
 * value and could both drain the same IDB queue concurrently —
 * stale-snapshot writes could regress `chunkProgress`.
 *
 * Fix: `_acquireDrainLock()` checks a `localStorage.crisp_drain_lock_at`
 * timestamp. Another tab's fresh lock (<120 s old) means skip this
 * drain pass. A stale lock (>120 s) is reclaimable.
 *
 * The spec verifies the lock primitive directly via the test
 * surfaces `__crispAcquireDrainLock` / `__crispReleaseDrainLock`.
 */
import { test, expect } from '@playwright/test';

const DEVICE_HASH = 'TEST-DEVICE-K4A-DRAIN-MUTEX';

async function bootPwa(page) {
    await page.addInitScript((h) => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_id_v2', h);
    }, DEVICE_HASH);
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispAcquireDrainLock === 'function'
            && typeof (window as any).__crispReleaseDrainLock === 'function',
        null, { timeout: 8000 },
    );
}


test.describe('PWA K.4.a — drain-mutex', () => {
    test('first acquire succeeds, second concurrent acquire fails', async ({ page }) => {
        await bootPwa(page);

        // Tab "A" — first acquire.
        const got1 = await page.evaluate(() => (window as any).__crispAcquireDrainLock());
        expect(got1).toBe(true);

        // Tab "B" — second acquire while A still holds the lock.
        const got2 = await page.evaluate(() => (window as any).__crispAcquireDrainLock());
        expect(got2).toBe(false);

        await page.evaluate(() => (window as any).__crispReleaseDrainLock());
    });

    test('release allows a subsequent acquire', async ({ page }) => {
        await bootPwa(page);

        await page.evaluate(() => (window as any).__crispAcquireDrainLock());
        await page.evaluate(() => (window as any).__crispReleaseDrainLock());

        const got = await page.evaluate(() => (window as any).__crispAcquireDrainLock());
        expect(got, 'lock should be available after release').toBe(true);
        await page.evaluate(() => (window as any).__crispReleaseDrainLock());
    });

    test('stale lock (>120s) is reclaimable', async ({ page }) => {
        await bootPwa(page);

        // Plant a stale lock manually.
        await page.evaluate(() => {
            const STALE = String(Date.now() - 200_000);  // 200 s ago
            localStorage.setItem(
                (window as any).__crispDrainLockKey(),
                STALE,
            );
        });

        const got = await page.evaluate(() => (window as any).__crispAcquireDrainLock());
        expect(got, '>120s old lock is stale and reclaimable').toBe(true);
        await page.evaluate(() => (window as any).__crispReleaseDrainLock());
    });

    test('localStorage write is visible to a second tab on same origin', async ({ browser }) => {
        const context = await browser.newContext();
        try {
            const tabA = await context.newPage();
            await tabA.addInitScript((h) => {
                localStorage.setItem('crisp_privacy_consent',
                    JSON.stringify({ accepted: true, ts: Date.now() }));
                localStorage.setItem('crisp_landing_seen', '1');
                localStorage.setItem('crisp_device_id_v2', h);
            }, DEVICE_HASH);
            await tabA.goto('index.html');
            await tabA.waitForFunction(
                () => typeof (window as any).__crispAcquireDrainLock === 'function',
                null, { timeout: 8000 },
            );

            const tabB = await context.newPage();
            await tabB.goto('index.html');
            await tabB.waitForFunction(
                () => typeof (window as any).__crispAcquireDrainLock === 'function',
                null, { timeout: 8000 },
            );

            // Tab A grabs the lock.
            const got1 = await tabA.evaluate(() => (window as any).__crispAcquireDrainLock());
            expect(got1).toBe(true);

            // Tab B tries — must see A's lock in shared localStorage.
            const got2 = await tabB.evaluate(() => (window as any).__crispAcquireDrainLock());
            expect(got2, 'second tab must see the first tab\'s lock').toBe(false);

            await tabA.evaluate(() => (window as any).__crispReleaseDrainLock());
            const got3 = await tabB.evaluate(() => (window as any).__crispAcquireDrainLock());
            expect(got3, 'tab B can acquire after A releases').toBe(true);
            await tabB.evaluate(() => (window as any).__crispReleaseDrainLock());

            await tabA.close();
            await tabB.close();
        } finally {
            await context.close();
        }
    });
});
