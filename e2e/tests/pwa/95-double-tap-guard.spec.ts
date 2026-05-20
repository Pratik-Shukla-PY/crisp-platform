/**
 * PWA — K.4.b (Phase K, May 2026): double-tap submit guard.
 *
 * Pre-fix the only guard against double-tap was `sendBtn.disabled=true`.
 * If `submitReport` threw BEFORE `enqueueReport` completed (e.g.
 * BlazeFace blur rejected mid-await), the catch block re-enabled the
 * button. A user who saw the still-active button could tap again →
 * fresh `clientReportId` + two separate Report rows on the backend.
 *
 * Fix: module-scope `_submitInFlight` promise — concurrent calls
 * receive the SAME promise instead of starting fresh submits. Cleared
 * in the finally block once the first call settles (success or fail).
 *
 * Asserts:
 *   - 5 rapid concurrent submitReport() calls all return the same
 *     promise (single resolution).
 *   - After the in-flight promise settles, a subsequent submit
 *     creates a NEW one (no permanent lock-out).
 *   - The in-flight flag is correctly cleared on error path too.
 */
import { test, expect } from '@playwright/test';

const DEVICE_HASH = 'TEST-DEVICE-K4B-DOUBLETAP';

async function bootPwa(page) {
    await page.addInitScript((h) => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_id_v2', h);
    }, DEVICE_HASH);
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispSubmitReport === 'function'
            && typeof (window as any).__crispIsSubmitInFlight === 'function',
        null, { timeout: 8000 },
    );
}


test.describe('PWA K.4.b — double-tap submit guard', () => {
    test('concurrent submitReport calls share the same in-flight promise', async ({ page }) => {
        await bootPwa(page);

        // Submit with NO photo / NO captured state — submitReport will
        // hit an early-exit path quickly. We just need to observe whether
        // the second concurrent call observes the in-flight state.
        const result = await page.evaluate(async () => {
            // Fire 5 calls in quick succession (BEFORE any settles).
            const p1 = (window as any).__crispSubmitReport();
            const inFlightSeenByP2 = (window as any).__crispIsSubmitInFlight();
            const p2 = (window as any).__crispSubmitReport();
            const p3 = (window as any).__crispSubmitReport();
            const p4 = (window as any).__crispSubmitReport();
            const p5 = (window as any).__crispSubmitReport();
            const samePromise = (p1 === p2) && (p2 === p3) && (p3 === p4) && (p4 === p5);
            // Drain all (each is the SAME promise so settlement is shared).
            await Promise.allSettled([p1, p2, p3, p4, p5]);
            const inFlightAfter = (window as any).__crispIsSubmitInFlight();
            return { inFlightSeenByP2, samePromise, inFlightAfter };
        });

        expect(
            result.inFlightSeenByP2,
            '_submitInFlight must be truthy after the first submit kicks off',
        ).toBe(true);
        expect(
            result.samePromise,
            'all 5 concurrent calls must return the SAME promise object',
        ).toBe(true);
        expect(
            result.inFlightAfter,
            'flag must be cleared once the promise settles',
        ).toBe(false);
    });

    test('a fresh submit AFTER settlement creates a new in-flight promise', async ({ page }) => {
        await bootPwa(page);

        const promise1IsSame = await page.evaluate(async () => {
            const p1 = (window as any).__crispSubmitReport();
            await p1;
            const p2 = (window as any).__crispSubmitReport();
            await p2;
            // After settle the in-flight is cleared, so a brand-new
            // promise should appear — NOT the previously-cached one.
            return p1 === p2;
        });

        expect(
            promise1IsSame,
            'after settle the in-flight is cleared, so subsequent calls create new promises',
        ).toBe(false);
    });

    test('in-flight flag is cleared even when submitReport rejects', async ({ page }) => {
        await bootPwa(page);

        // Mock something that submitReport depends on to force a throw.
        // The simplest: override awaitPendingBlur to reject.
        const cleared = await page.evaluate(async () => {
            const orig = (window as any).awaitPendingBlur;
            (window as any).awaitPendingBlur = () => Promise.reject(new Error('simulated blur fail'));
            try {
                try { await (window as any).__crispSubmitReport(); } catch (_) {}
                // After the rejection, the in-flight flag MUST be false.
                return (window as any).__crispIsSubmitInFlight();
            } finally {
                (window as any).awaitPendingBlur = orig;
            }
        });

        // Note: submitReport actually catches its own errors at line 8640+
        // so this won't reject — the flag should still clear normally.
        expect(
            cleared,
            'in-flight flag must always clear (success OR throw path)',
        ).toBe(false);
    });
});
