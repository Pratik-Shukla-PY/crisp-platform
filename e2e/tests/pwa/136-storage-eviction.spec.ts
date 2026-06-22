/**
 * PWA — R6 smart LRU eviction under storage pressure (v352).
 *
 * Indefinite retention (the silent 30-day cap was removed) means the outbox can
 * grow; rather than expiring evidence on a timer OR hard-blocking new submissions,
 * _evictOldOriginalsUnderPressure sheds the OLDEST originals/mediums whose SMALL
 * preview has ALREADY delivered — the analyst keeps a preview, the full-res is
 * given up VISIBLY (deferredReason='storage_evicted'), and space is freed.
 *
 * Unit-level via window hooks (no real upload). We stub navigator.storage.estimate
 * to simulate storage pressure, enqueue rows of varying age + preview state, run
 * eviction, and assert: oldest previewed originals are shed first; a row whose
 * SMALL has NOT delivered is NEVER evicted (the preview isn't safe yet).
 *
 * Static (:8080).
 */
import { test, expect, Page } from '@playwright/test';

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_lang', 'en');
        // Simulate storage pressure: 48 MB used of a 50 MB quota (96% > the 85% budget).
        try {
            (navigator as any).storage.estimate = async () => ({ usage: 48 * 1048576, quota: 50 * 1048576 });
        } catch (_) { /* defineProperty fallback below */ }
    });
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispEvictOldOriginalsUnderPressure === 'function'
            && typeof (window as any).__crispEnqueueReport === 'function'
            && typeof (window as any).__crispGetAllQueued === 'function'
            && typeof (window as any).__crispDequeueReport === 'function',
        null, { timeout: 10_000 },
    );
}

async function clearQueue(page: Page) {
    await page.evaluate(async () => {
        for (const it of await (window as any).__crispGetAllQueued()) {
            try { await (window as any).__crispDequeueReport(it.client_report_id); } catch (_) {}
        }
    });
}

test.describe('PWA — R6 storage-pressure eviction (v352)', () => {
    test.beforeEach(async ({ page }) => { await boot(page); await clearQueue(page); });
    test.afterEach(async ({ page }) => { await clearQueue(page); });

    test('@smoke evicts OLDEST previewed originals first; never evicts a row whose SMALL has not delivered', async ({ page }) => {
        const res = await page.evaluate(async () => {
            const mkRow = (id: string, tsAgeMin: number, smallDelivered: boolean) => ({
                client_report_id: id,
                serverId: null,            // never sent → no backend mark-deferred call
                timestamp: Date.now() - tsAgeMin * 60_000,
                stages: { meta: true, text: true, photo: smallDelivered, audio: true },
                photoGroupId: `g-${id}`,
                photoVariants: {
                    small: { mediaId: `s-${id}`, complete: smallDelivered, dataUrl: 'x'.repeat(2000) },
                    medium: { mediaId: `m-${id}`, complete: false, dataUrl: 'y'.repeat(8000) },
                    original: { mediaId: `o-${id}`, complete: false, blob: new Blob([new Uint8Array(2 * 1048576)], { type: 'image/jpeg' }) },
                },
            });
            // Oldest → newest; the no-preview row is OLD but must be protected.
            await (window as any).__crispEnqueueReport(mkRow('old-A', 120, true));
            await (window as any).__crispEnqueueReport(mkRow('old-noprev', 180, false)); // oldest but SMALL not delivered
            await (window as any).__crispEnqueueReport(mkRow('mid-B', 60, true));

            // Incoming new ~3 MB report that triggers the pressure check.
            const incoming = { client_report_id: 'incoming', photoVariants: { original: { blob: new Blob([new Uint8Array(3 * 1048576)]) } } };
            const freed = await (window as any).__crispEvictOldOriginalsUnderPressure(incoming);

            const all = await (window as any).__crispGetAllQueued();
            const byId: any = {};
            for (const r of all) {
                const o = r.photoVariants?.original || {};
                const m = r.photoVariants?.medium || {};
                byId[r.client_report_id] = {
                    origEvicted: o.deferredReason === 'storage_evicted' && !o.blob,
                    medEvicted: m.deferredReason === 'storage_evicted' && !m.dataUrl,
                    smallStillThere: !!(r.photoVariants?.small?.dataUrl),
                };
            }
            return { freed, byId };
        });

        // Freed real bytes.
        expect(res.freed, 'eviction freed bytes under pressure').toBeGreaterThan(0);
        // Both PREVIEWED rows had their original + medium shed (visible deferral).
        expect(res.byId['old-A'].origEvicted, 'oldest previewed original evicted').toBe(true);
        expect(res.byId['old-A'].medEvicted, 'oldest previewed medium evicted').toBe(true);
        expect(res.byId['mid-B'].origEvicted, 'mid previewed original evicted (pressure not relieved by one row)').toBe(true);
        // The SMALL preview itself is ALWAYS retained (analyst keeps it).
        expect(res.byId['old-A'].smallStillThere, 'SMALL preview retained').toBe(true);
        expect(res.byId['mid-B'].smallStillThere, 'SMALL preview retained').toBe(true);
        // The row whose SMALL has NOT delivered is PROTECTED — never evicted.
        expect(res.byId['old-noprev'].origEvicted, 'no-preview row original NOT evicted').toBe(false);
        expect(res.byId['old-noprev'].smallStillThere, 'no-preview row SMALL retained (still uploading)').toBe(true);
    });

    test('no eviction when storage is NOT under pressure', async ({ page }) => {
        const freed = await page.evaluate(async () => {
            // Override the stub: plenty of free space (1 MB of 50 MB).
            (navigator as any).storage.estimate = async () => ({ usage: 1 * 1048576, quota: 50 * 1048576 });
            await (window as any).__crispEnqueueReport({
                client_report_id: 'calm-1', serverId: null, timestamp: Date.now() - 99 * 60_000,
                stages: { meta: true, text: true, photo: true, audio: true }, photoGroupId: 'g',
                photoVariants: { small: { mediaId: 's', complete: true, dataUrl: 'x'.repeat(2000) },
                                 original: { mediaId: 'o', complete: false, blob: new Blob([new Uint8Array(2 * 1048576)]) } },
            });
            const incoming = { client_report_id: 'inc2', photoVariants: { original: { blob: new Blob([new Uint8Array(1 * 1048576)]) } } };
            const f = await (window as any).__crispEvictOldOriginalsUnderPressure(incoming);
            const all = await (window as any).__crispGetAllQueued();
            const row = all.find((r: any) => r.client_report_id === 'calm-1');
            return { f, stillHasBytes: !!(row?.photoVariants?.original?.blob), reason: row?.photoVariants?.original?.deferredReason || null };
        });
        expect(freed.f, 'nothing evicted when there is headroom').toBe(0);
        expect(freed.stillHasBytes, 'original bytes retained when not under pressure').toBe(true);
        expect(freed.reason, 'not marked evicted').toBeNull();
    });
});
