/**
 * PWA — K.4.d (Phase K, May 2026): cross-tab IDB version stamp.
 *
 * Pre-fix two tabs (or installed PWA + browser tab) sharing the same
 * IDB could race: tab A reads queue item (chunkProgress=50), tab B
 * writes (now chunkProgress=80), tab A's mid-pass write completes
 * (overwrites with 50). The winning tab's progress is lost.
 *
 * Fix: every `enqueueReport` increments a `_version` counter on the
 * payload. The new `enqueueReportIfVersionMatches(payload, expected)`
 * helper does a check-and-set: if the on-disk `_version` differs from
 * the caller's expected value, the write is aborted. Callers that
 * encounter a stale-snapshot abort should drop their pass — the
 * winning tab is the canonical state-holder.
 *
 * Tests:
 *   - `enqueueReport` increments `_version` monotonically.
 *   - `enqueueReportIfVersionMatches(item, expected)` returns true
 *     when versions agree.
 *   - returns false when versions mismatch (stale snapshot).
 *   - The post-abort on-disk state is unchanged (we didn't half-
 *     overwrite a partial record).
 */
import { test, expect } from '@playwright/test';

const DEVICE_HASH = 'TEST-DEVICE-K4D-VERSION';

async function bootPwa(page) {
    await page.addInitScript((h) => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_id_v2', h);
    }, DEVICE_HASH);
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispEnqueueReport === 'function'
            && typeof (window as any).__crispEnqueueReportIfVersionMatches === 'function',
        null, { timeout: 8000 },
    );
}


test.describe('PWA K.4.d — cross-tab IDB version stamp', () => {
    test('enqueueReport increments _version monotonically', async ({ page }) => {
        await bootPwa(page);

        const cid = 'k4d-monotonic-' + Date.now();
        const versions = await page.evaluate(async (c) => {
            const out: number[] = [];
            await (window as any).__crispEnqueueReport({
                client_report_id: c, stages: { meta: true, text: true, photo: true, audio: true },
                meta: { dummy: true },
            });
            let items = await (window as any).__crispGetAllQueued();
            out.push(items.find((q: any) => q.client_report_id === c)._version);

            const cur = items.find((q: any) => q.client_report_id === c);
            await (window as any).__crispEnqueueReport({ ...cur, anotherField: 'change' });
            items = await (window as any).__crispGetAllQueued();
            out.push(items.find((q: any) => q.client_report_id === c)._version);

            const cur2 = items.find((q: any) => q.client_report_id === c);
            await (window as any).__crispEnqueueReport({ ...cur2, oneMore: 'change' });
            items = await (window as any).__crispGetAllQueued();
            out.push(items.find((q: any) => q.client_report_id === c)._version);
            await (window as any).__crispDequeueReport(c);
            return out;
        }, cid);

        expect(versions).toEqual([1, 2, 3]);
    });

    test('enqueueReportIfVersionMatches succeeds when versions agree', async ({ page }) => {
        await bootPwa(page);

        const cid = 'k4d-match-' + Date.now();
        const result = await page.evaluate(async (c) => {
            await (window as any).__crispEnqueueReport({
                client_report_id: c, stages: { meta: true, text: true, photo: true, audio: true },
                meta: { dummy: true },
            });
            const items = await (window as any).__crispGetAllQueued();
            const item = items.find((q: any) => q.client_report_id === c);
            const ok = await (window as any).__crispEnqueueReportIfVersionMatches(
                { ...item, chunkProgress: 50 }, item._version,
            );
            const after = (await (window as any).__crispGetAllQueued())
                .find((q: any) => q.client_report_id === c);
            await (window as any).__crispDequeueReport(c);
            return { ok, afterChunkProgress: after.chunkProgress, afterVersion: after._version };
        }, cid);

        expect(result.ok).toBe(true);
        expect(result.afterChunkProgress).toBe(50);
        expect(result.afterVersion).toBe(2);  // 1 → 2 on successful CAS write
    });

    test('enqueueReportIfVersionMatches aborts on stale snapshot', async ({ page }) => {
        await bootPwa(page);

        const cid = 'k4d-stale-' + Date.now();
        const result = await page.evaluate(async (c) => {
            // Tab A enqueues at _version=1.
            await (window as any).__crispEnqueueReport({
                client_report_id: c, stages: { meta: true, text: true, photo: true, audio: true },
                meta: { dummy: true },
                chunkProgress: 0,
            });
            const itemReadByA = (await (window as any).__crispGetAllQueued())
                .find((q: any) => q.client_report_id === c);
            const versionSeenByA = itemReadByA._version;  // 1

            // Tab B enqueues (simulating another tab making progress
            // BETWEEN tab A's read and tab A's mid-pass write).
            // _version goes 1 → 2.
            await (window as any).__crispEnqueueReport({
                ...itemReadByA,
                chunkProgress: 80,  // tab B advanced progress
            });

            // Tab A NOW tries to write its stale view (still has
            // versionSeenByA=1 but on-disk is now 2). Must abort.
            const ok = await (window as any).__crispEnqueueReportIfVersionMatches(
                { ...itemReadByA, chunkProgress: 30 },  // tab A's stale progress
                versionSeenByA,
            );

            // On-disk should still be tab B's write, untouched.
            const after = (await (window as any).__crispGetAllQueued())
                .find((q: any) => q.client_report_id === c);
            await (window as any).__crispDequeueReport(c);
            return { ok, afterChunkProgress: after.chunkProgress, afterVersion: after._version };
        }, cid);

        expect(result.ok, 'mid-pass stale write must abort').toBe(false);
        expect(result.afterChunkProgress, 'tab B\'s value preserved').toBe(80);
        expect(result.afterVersion, 'version still at tab B\'s write').toBe(2);
    });
});
