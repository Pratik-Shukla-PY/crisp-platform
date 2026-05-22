/**
 * R3.a (May 2026) — PWA recovery chip predicate.
 *
 * `_mapReportStatus(r)` is responsible for converting a backend Report
 * shape into the chip {state, color, icon, label} the My Reports list
 * renders. R3.a extended it so upload-lifecycle states (paused,
 * recovering, failed_permanent) take priority over the review-lifecycle
 * states (submitted, under_review, accepted, rejected). The new
 * priority is read directly from media[].abandon_reason and
 * media[].recovered_at exposed in MediaResponse (R1).
 *
 * This spec drives the function directly via window.__crispMapReportStatus
 * with synthetic report shapes — no backend round-trip needed. Pinning
 * the predicate at the unit level catches regressions in chip text /
 * priority ordering / online-vs-offline branching without depending on
 * the full upload flow.
 */
import { test, expect } from '@playwright/test';

async function openPwa(page) {
    await page.goto('index.html?ui=v4');
    await page.evaluate(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
    });
    await page.reload();
    await page.waitForFunction(
        () => typeof (window as any)._mapReportStatus === 'function'
              || typeof (window as any).__crispGoToStage === 'function',
        null, { timeout: 8000 },
    );
    // Expose the helper if not already on the window. (_mapReportStatus
    // is module-private; the tests below rely on a deliberate test hook.)
    await page.evaluate(() => {
        const w = window as any;
        if (!w.__crispMapReportStatus) {
            // The function name is _mapReportStatus in app.js. We probe
            // for it on the global; some builds may attach it
            // explicitly. Otherwise we walk the bundle.
            const fn = (window as any)._mapReportStatus;
            if (typeof fn === 'function') w.__crispMapReportStatus = fn;
        }
    });
}

test.describe('PWA R3.a — _mapReportStatus chip predicate (recovery states)', () => {
    test.beforeEach(async ({ page }) => { await openPwa(page); });

    test('hard-abandoned media → FAILED_PERMANENT chip', async ({ page }) => {
        const st = await page.evaluate(() => {
            const fn = (window as any)._mapReportStatus
                    || (window as any).__crispMapReportStatus;
            if (typeof fn !== 'function') return null;
            return fn({
                status: 'PENDING',
                reviewer_verdict: 'NOT_REVIEWED',
                media: [
                    { abandon_reason: 'checksum_mismatch', recovered_at: null },
                ],
            });
        });
        expect(st).not.toBeNull();
        expect(st.state).toBe('FAILED_PERMANENT');
    });

    test('soft-abandoned media + online → RECOVERING chip', async ({ page }) => {
        const st = await page.evaluate(() => {
            // Force online for the predicate's navigator.onLine check.
            Object.defineProperty(window.navigator, 'onLine', {
                configurable: true, get() { return true; },
            });
            const fn = (window as any)._mapReportStatus
                    || (window as any).__crispMapReportStatus;
            if (typeof fn !== 'function') return null;
            return fn({
                status: 'PENDING',
                reviewer_verdict: 'NOT_REVIEWED',
                media: [
                    { abandon_reason: 'chunks_never_arrived', recovered_at: null },
                ],
            });
        });
        expect(st).not.toBeNull();
        expect(st.state).toBe('RECOVERING');
    });

    test('soft-abandoned media + offline → PAUSED chip', async ({ page }) => {
        const st = await page.evaluate(() => {
            Object.defineProperty(window.navigator, 'onLine', {
                configurable: true, get() { return false; },
            });
            const fn = (window as any)._mapReportStatus
                    || (window as any).__crispMapReportStatus;
            if (typeof fn !== 'function') return null;
            return fn({
                status: 'PENDING',
                reviewer_verdict: 'NOT_REVIEWED',
                media: [
                    { abandon_reason: 'assembly_worker_lost', recovered_at: null },
                ],
            });
        });
        expect(st).not.toBeNull();
        expect(st.state).toBe('PAUSED');
    });

    test('soft-abandoned but recovered_at set → falls back to verdict states (NOT recovery)', async ({ page }) => {
        const st = await page.evaluate(() => {
            const fn = (window as any)._mapReportStatus
                    || (window as any).__crispMapReportStatus;
            if (typeof fn !== 'function') return null;
            return fn({
                status: 'PENDING',
                reviewer_verdict: 'NOT_REVIEWED',
                media: [{
                    abandon_reason: 'chunks_never_arrived',
                    recovered_at: '2026-05-22T10:00:00Z',
                }],
            });
        });
        expect(st).not.toBeNull();
        // Recovery completed → chip falls back to the review-lifecycle
        // states. SUBMITTED is what a PENDING + NOT_REVIEWED report shows.
        expect(st.state).toBe('SUBMITTED');
    });

    test('no media → unchanged behaviour for verdict states', async ({ page }) => {
        const st = await page.evaluate(() => {
            const fn = (window as any)._mapReportStatus
                    || (window as any).__crispMapReportStatus;
            if (typeof fn !== 'function') return null;
            return fn({
                status: 'PENDING',
                reviewer_verdict: 'ACCEPTED',
                media: [],
            });
        });
        expect(st).not.toBeNull();
        expect(st.state).toBe('ACCEPTED');
    });
});
