/**
 * PWA — offline durability remediation (v350): I0 + I2 + I1 regression guards.
 *
 * Companion to 99-validation-03 (disaster drain) and 121 (stuck-at-N% wedge).
 * Verifies the v350 audit fixes at the unit level via the window test-hooks:
 *   - I0: the non-SMALL media retention cap moved 24 h → 30 DAYS. A report
 *         older than 30 days drops its non-SMALL tier with the new
 *         `30d_timeout` label; a 24 h-old report (the prod-incident case)
 *         no longer matches the cap.
 *   - I2: getStorageQuotaInfo() returns a real budget shape from
 *         navigator.storage.estimate() (drives the hard pre-enqueue block).
 *   - I1/I2: the new i18n keys (sync_queued_nudge, storage_full_hard_limit)
 *         resolve in-app (not the raw key) and preserve the {n} placeholder.
 *
 * Static (:8080) + live backend (:8000). The I0 hook passes reportId=null so
 * the cap returns before any chunk upload / backend signal.
 */
import { test, expect, Page } from '@playwright/test';

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispUploadVariantTier === 'function'
           && typeof (window as any).__crispGetStorageQuotaInfo === 'function'
           && typeof (window as any).__crispGetAllQueued === 'function'
           && typeof (window as any).__crispDequeueReport === 'function'
           && typeof (window as any).t === 'function',
        null, { timeout: 8000 },
    );
}

async function clearQueue(page: Page) {
    await page.evaluate(async () => {
        const items = await (window as any).__crispGetAllQueued();
        for (const it of items) {
            try { await (window as any).__crispDequeueReport(it.client_report_id); } catch (_) {}
        }
    });
}

test.describe('PWA — offline durability (v350: I0/I2/I1)', () => {
    test.beforeEach(async ({ page }) => { await boot(page); await clearQueue(page); });
    test.afterEach(async ({ page }) => { await clearQueue(page); });

    test('@smoke R6: a >30-day-old non-SMALL tier is NO LONGER time-dropped (indefinite retention)', async ({ page }) => {
        // v352 (R6): the silent 30-day wall-clock cap was REMOVED — critical
        // evidence must never expire on a timer. Even a 31-day-old tier keeps
        // retrying; it is NEVER marked deferredReason='30d_timeout' (that path is
        // gone). The only client give-up is now storage-pressure eviction
        // (deferredReason='storage_evicted', covered by 136-storage-eviction).
        const res = await page.evaluate(async () => {
            const variant: any = {
                mediaId: 'm-orig-31d', complete: false, chunkProgress: 0,
                blob: new Blob([new Uint8Array(2048)], { type: 'image/jpeg' }),
            };
            const item: any = {
                client_report_id: 'dur-31d',
                timestamp: Date.now() - 31 * 24 * 60 * 60 * 1000,   // 31 days old
                photoGroupId: 'g1', photoVariants: { original: variant },
            };
            const unit = { tier: 'original', groupId: 'g1', variant, label: 'main/original' };
            // Stub fetch so the (no-longer-capped) upload attempt fails fast — no
            // real network. With the cap gone the tier proceeds to upload instead
            // of returning early; we settle ~600 ms and inspect the label.
            const _origFetch = window.fetch;
            (window as any).fetch = () => Promise.reject(new Error('test-stub-no-network'));
            const p = (window as any).__crispUploadVariantTier(item, '', unit);
            if (p && typeof p.catch === 'function') p.catch(() => {});
            await new Promise((r) => setTimeout(r, 600));
            window.fetch = _origFetch;
            return { reason: variant.deferredReason || null };
        });
        expect(res.reason).not.toBe('30d_timeout');   // R6: the 30-day cap is gone — no time-based drop
    });

    test('I0: a 24-hour-old non-SMALL tier is NOT dropped by the cap', async ({ page }) => {
        // The prod-incident case: under the OLD 24 h cap this dropped on first
        // reconnect; under the 30-day cap it must NOT. We assert the tier is not
        // labelled a timeout-drop (it proceeds to upload instead). reportId=''
        // (falsy) keeps the backend signal off; SMALL-exempt logic is unrelated.
        const res = await page.evaluate(async () => {
            const variant: any = {
                mediaId: 'm-orig-24h', complete: false, chunkProgress: 0,
                blob: new Blob([new Uint8Array(2048)], { type: 'image/jpeg' }),
            };
            const item: any = {
                client_report_id: 'dur-24h',
                timestamp: Date.now() - 25 * 60 * 60 * 1000,   // 25 h old (> old 24 h cap, < 30 d)
                photoGroupId: 'g2', photoVariants: { original: variant },
            };
            const unit = { tier: 'original', groupId: 'g2', variant, label: 'main/original' };
            // Stub fetch so the probe + (non-dropped) upload fail fast - no real
            // network. The 30-day cap decision is synchronous right after the
            // probe, so we DON'T await the full upload (its retry/backoff would
            // run ~60 s); we settle ~600 ms (enough for the probe+cap decision)
            // and inspect the label. The dangling upload promise is swallowed.
            const _origFetch = window.fetch;
            (window as any).fetch = () => Promise.reject(new Error('test-stub-no-network'));
            const p = (window as any).__crispUploadVariantTier(item, '', unit);
            if (p && typeof p.catch === 'function') p.catch(() => {});
            await new Promise((r) => setTimeout(r, 600));
            window.fetch = _origFetch;
            return { reason: variant.deferredReason || null };
        });
        expect(res.reason).not.toBe('30d_timeout');   // the 30-day cap must NOT have fired at 25 h
    });

    test('I2: getStorageQuotaInfo() returns a sane budget shape', async ({ page }) => {
        const q = await page.evaluate(async () => await (window as any).__crispGetStorageQuotaInfo());
        expect(typeof q.quota).toBe('number');
        expect(q.quota).toBeGreaterThan(0);
        expect(typeof q.usage).toBe('number');
        expect(q.usage).toBeGreaterThanOrEqual(0);
        expect(typeof q.available).toBe('number');
        expect(typeof q.supported).toBe('boolean');
    });

    test('I1/I2: new i18n keys resolve (not the raw key) + nudge keeps {n}', async ({ page }) => {
        await page.waitForFunction(
            () => (window as any).t && (window as any).t('sync_queued_nudge') !== 'sync_queued_nudge'
               && (window as any).t('storage_full_hard_limit') !== 'storage_full_hard_limit',
            null, { timeout: 8000 },
        );
        const r = await page.evaluate(() => ({
            nudge: (window as any).t('sync_queued_nudge'),
            hard: (window as any).t('storage_full_hard_limit'),
        }));
        expect(r.nudge).toBeTruthy();
        expect(r.nudge).toContain('{n}');            // interpolation placeholder preserved
        expect(r.hard).toBeTruthy();
    });
});
