/**
 * PWA — low-bandwidth (2 kbit/s) upload fix (v351). Unit-level guards via the
 * window test-hooks for the three code-level fixes that broke the sub-~5.8 kbit/s
 * upload wedge diagnosed from a real HAR (Chrome throttle ~2 kbit/s ≈ 250 B/s):
 *
 *   FIX C — adaptTierViaProbe: a probe that ABORTS/network-errors (the 64 KB
 *           probe can't complete in 45 s at 250 B/s) now assumes VERY_SLOW
 *           (1 KB chunks), NOT the optimistic NavigatorConnection SLOW guess
 *           (32 KB chunks) that wedged every chunk. A probe ENDPOINT error
 *           (HTTP 4xx, e.g. 404 not-deployed) still defers to the browser hint.
 *   FIX B — computeChunkTimeout: scales off the bytes being sent (with a
 *           conservative ~250 B/s floor) and is capped — no fixed 45 s wall.
 *   FIX A — _maybeReduceFrozenChunk: after K consecutive timeouts on one frozen
 *           chunk size, halve it toward the 1 KB floor with a fresh media_id so
 *           an oversized frozen tier self-heals instead of retrying forever.
 *
 * Companion to 99-validation-03 (disaster drain at 2000 B/s — which MASKED this
 * bug: at 2000 B/s the 64 KB probe completes in ~33 s, under the 45 s timeout).
 * Static (:8080) + live backend (:8000).
 */
import { test, expect, Page } from '@playwright/test';

const TIERS = ['FAST', 'MEDIUM', 'SLOW', 'VERY_SLOW'];

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_lang', 'en');
    });
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).adaptTierViaProbe === 'function'
            && typeof (window as any).computeChunkTimeout === 'function'
            && typeof (window as any).__crispMaybeReduceFrozenChunk === 'function',
        null, { timeout: 10_000 },
    );
}

test.describe('PWA — low-bandwidth 2 kbit/s upload fix (v351)', () => {
    test.beforeEach(async ({ page }) => { await boot(page); });

    test('@smoke FIX C: a probe that ABORTS → VERY_SLOW (not the optimistic SLOW guess)', async ({ page }) => {
        const tier = await page.evaluate(async () => {
            const orig = window.fetch;
            // Simulate the 64 KB probe failing to complete on a ~250 B/s link:
            // a network/abort error carrying NO HTTP status.
            (window as any).fetch = () => Promise.reject(new Error('The user aborted a request.'));
            try {
                return await (window as any).adaptTierViaProbe({ force: true });
            } finally { window.fetch = orig; }
        });
        // Before the fix this returned SLOW (32 KB chunks → every chunk timed
        // out at 2 kbit/s). It MUST now be the pessimistic VERY_SLOW.
        expect(tier).toBe('VERY_SLOW');
    });

    test('FIX C: a probe ENDPOINT error (HTTP 404) still defers to the browser hint (valid tier, no throw)', async ({ page }) => {
        const tier = await page.evaluate(async () => {
            const orig = window.fetch;
            (window as any).fetch = () => Promise.resolve(new Response('not found', { status: 404 }));
            try {
                return await (window as any).adaptTierViaProbe({ force: true });
            } finally { window.fetch = orig; }
        });
        // A 404 is "endpoint not deployed", not a link signal → browser-hint
        // tier. We don't pin the exact value (depends on the test browser's
        // NavigatorConnection), only that it's a valid tier and didn't throw.
        expect(TIERS).toContain(tier);
    });

    test('FIX B: computeChunkTimeout scales with chunk size + caps (no fixed 45 s wall)', async ({ page }) => {
        const r = await page.evaluate(() => {
            const f = (window as any).computeChunkTimeout;
            return {
                verySlow1k: f(1024, 250),        // 1 KB @ 250 B/s
                slow32k: f(32768, 250),          // 32 KB @ 250 B/s (the wedge size)
                fast512k: f(524288, 1_000_000),  // 512 KB @ 1 MB/s (fast link)
                unmeasured1k: f(1024, null),     // no measurement → floor-scaled
                ceil: 120_000,
            };
        });
        // 1 KB @ 250 B/s ≈ 3×4096+5000 = 17288 ms — a comfortable window, NOT the
        // old static 45 s/60 s tier value.
        expect(r.verySlow1k).toBeGreaterThanOrEqual(10_000);
        expect(r.verySlow1k).toBeLessThan(30_000);
        // 32 KB @ 250 B/s would need ~131 s → the formula exceeds the cap, so it
        // is clamped to the ceiling (and Fix A re-reduces such a chunk anyway).
        expect(r.slow32k).toBe(r.ceil);
        // Fast link: small, bounded timeout.
        expect(r.fast512k).toBeGreaterThanOrEqual(10_000);
        expect(r.fast512k).toBeLessThanOrEqual(r.ceil);
        // Unmeasured still produces a scaled numeric timeout (never NaN / 0).
        expect(r.unmeasured1k).toBeGreaterThanOrEqual(10_000);
    });

    test('FIX A: a frozen-too-big chunk re-reduces toward 1 KB after K timeouts (the wedge fix)', async ({ page }) => {
        const r = await page.evaluate(async () => {
            const reduce = (window as any).__crispMaybeReduceFrozenChunk;
            // A variant frozen at 32 KB (the SLOW tier size that wedged at 2 kbit/s).
            const variant: any = { mediaId: 'm-wedge-0', frozenChunkSize: 32768, frozenTotalChunks: 80, chunkProgress: 40 };
            const item: any = { client_report_id: 'lowbw-A', photoVariants: { original: variant } };
            const unit = { tier: 'original', groupId: 'g1', variant, label: 'main/original' };

            const sizes: Array<number | null> = [];
            const ids: string[] = [variant.mediaId];
            // Drive ~16 timeouts: K=2 per reduction → ~8 reductions attempted, but
            // it must FLOOR at 1024 and then stop churning media ids.
            for (let i = 0; i < 16; i++) {
                await reduce(item, null, unit, variant.chunkProgress || 0);
                sizes.push(variant.maxChunkSize ?? null);
                if (variant.mediaId !== ids[ids.length - 1]) ids.push(variant.mediaId);
            }
            return {
                finalCap: variant.maxChunkSize,
                frozenAfter: variant.frozenChunkSize,   // nulled on each reduce so the freeze block recomputes
                reduces: variant.chunkReduces,
                distinctMediaIds: ids.length,
                capProgression: sizes.filter((v, i, a) => a.indexOf(v) === i),
            };
        });
        // It halved 32768 → 16384 → … → floored at 1024.
        expect(r.finalCap).toBe(1024);
        // Each reduce nulls frozenChunkSize so the freeze block re-derives total
        // against the smaller cap (no stale oversized total).
        expect(r.frozenAfter).toBeNull();
        // Re-reductions are bounded (no infinite media-id churn).
        expect(r.reduces).toBeLessThanOrEqual(6);
        expect(r.distinctMediaIds).toBeGreaterThan(1);   // fresh media_id on each reduce
        // The cap strictly descended through the halving ladder down to 1024.
        expect(r.capProgression[r.capProgression.length - 1]).toBe(1024);
        expect(Math.max(...(r.capProgression.filter((v: any) => v != null)))).toBeLessThanOrEqual(16384);
    });
});
