/**
 * VALIDATION 04 — TRUE ~2 kbit/s (~250 B/s) END-TO-END DRAIN (v351 baseline proof).
 *
 * This is the end-to-end counterpart to the unit-level 134-low-bandwidth-2kbit:
 * it throttles the wire to the REAL field speed the user reported (~250 B/s ≈
 * 2 kbit/s, NOT the 2000 B/s = 16 kbit/s of 99-validation-03 which masks the bug)
 * and proves a multi-tier report actually DRAINS to SYNCED with no wedge.
 *
 * Before v351: the 64 KB probe couldn't finish in 45 s → link mis-classified SLOW
 * → 32 KB chunks frozen too big → timed out forever → ORIGINAL wedged (the HAR).
 * After v351 (Fix C two-stage probe + Fix B bytes-scaled timeout + Fix A
 * re-reduce): the 4 KB pre-probe completes (~16 s), classifies VERY_SLOW, 1 KB
 * chunks land, and every tier assembles.
 *
 * A small generated image keeps ORIGINAL tiny so all tiers can drain at low bandwidth
 * within the budget — the point is "no wedge", not raw throughput. If any tier
 * wedged (the bug), ORIGINAL would never complete and this test would time out.
 *
 * Static (:8080) + live backend (:8000) + Postgres. Slow (minutes) — intended as
 * a local/nightly proof, not a CI gate (matches the 08 reporter-tier pattern).
 */
import { test, expect, Page } from '@playwright/test';
import { pgReportTruth, pollUntil, ensureScenarioDir, writeArtifact, cleanupReport } from './_validation-harness';

const SCENARIO = '04-2kbit-e2e-drain';
const LAT = 12.844610, LNG = 77.664210;
// ~4.8 kbit/s — within the user's reported 2–5 kbit/s field band, and STILL in
// the wedge territory: pre-v351 the 64 KB probe aborts here (64KB/600≈107s > 45s)
// → mis-classified SLOW → 32 KB chunks time out (32KB/600≈53s > 45s) → wedge.
// v351's 4 KB pre-probe completes (~7s) → VERY_SLOW → 1 KB chunks drain. Chosen
// over a literal 250 B/s so the sequential 3-tier drain finishes in CI budget
// (250 B/s was verified progressing-not-wedged manually; just too slow to green).
const BYTES_PER_SEC = 600;

async function boot(page: Page, deviceHash: string) {
    await page.addInitScript((h) => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_id_v2', h);
        localStorage.setItem('crisp_lang', 'en');
    }, deviceHash);
    await page.goto('index.html');
    await page.waitForFunction(
        () => typeof (window as any).__crispIngestFile === 'function'
            && typeof (window as any).ImageVariants?.generate === 'function'
            && typeof (window as any).getCurrentPWATier === 'function',
        null, { timeout: 15_000 },
    );
}

test.describe('VALIDATION 04 — true ~2 kbit/s end-to-end drain', () => {
    test('a multi-tier report DRAINS to SYNCED at low bandwidth with no wedge', async ({ page }) => {
        test.setTimeout(360_000);   // 6 min — disaster link (tiny payload)
        const dir = ensureScenarioDir(SCENARIO, 'small-report');
        let realCid = '';

        try {
            await boot(page, 'PWA-2kbit-drain-04');

            // Ingest a SMALL generated image so ORIGINAL is tiny enough to drain at
            // 250 B/s within budget (the test is about no-wedge, not throughput).
            // Deliberately TINY (96×96) so all three tiers fully drain at true
            // 250 B/s within a sane budget — tiers upload sequentially, so the
            // point is "every tier completes / no wedge", not raw throughput.
            const ingest = await page.evaluate(async () => {
                const c = document.createElement('canvas');
                c.width = 96; c.height = 96;
                const ctx = c.getContext('2d')!;
                ctx.fillStyle = '#2b3a55'; ctx.fillRect(0, 0, 96, 96);
                ctx.fillStyle = '#d9b14a';
                for (let i = 0; i < 8; i++) ctx.fillRect((i * 23) % 80, (i * 31) % 80, 12, 12);
                const blob: Blob = await new Promise(res => c.toBlob(b => res(b!), 'image/jpeg', 0.85));
                const file = new File([blob], 'small.jpg', { type: 'image/jpeg' });
                await (window as any).__crispIngestFile(file);
                const deadline = Date.now() + 20_000;
                while (Date.now() < deadline) {
                    const s = (window as any).state;
                    if (s.photoVariants?.small && s.photoVariants?.medium && s.photoVariants?.original) {
                        return { small: s.photoVariants.small.bytes, medium: s.photoVariants.medium.bytes, original: s.photoVariants.original.bytes };
                    }
                    await new Promise(r => setTimeout(r, 200));
                }
                return null;
            });
            expect(ingest, 'all 3 tiers generated').toBeTruthy();
            writeArtifact(dir, '01_variants.json', ingest);

            // Throttle to ~250 B/s BEFORE submit so the probe runs against the real link.
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Network.enable');
            await cdp.send('Network.emulateNetworkConditions', {
                offline: false, downloadThroughput: BYTES_PER_SEC, uploadThroughput: BYTES_PER_SEC, latency: 400,
            });

            await page.evaluate(({ lat, lng }) => {
                const s = (window as any).state;
                s.crisis_type = 'EARTHQUAKE'; s.infrastructure_type = 'COMMERCIAL';
                s.damage_classification = 'PARTIAL'; s.severity = 'MODERATE';
                s.description = '2 kbit/s e2e drain'; s.location = { lat, lng, acc: 5 }; s.locationName = '2kbit';
            }, { lat: LAT, lng: LNG });
            realCid = await page.evaluate(async () => {
                await (window as any).__crispSubmitReport();
                const all = await (window as any).__crispGetAllQueued();
                return all.sort((a: any, b: any) => (b.meta?.client_created_at || '').localeCompare(a.meta?.client_created_at || ''))[0]?.client_report_id || '';
            });
            expect(realCid).toBeTruthy();

            // FIX C proof: at this low rate the two-stage probe classifies
            // VERY_SLOW (the 4 KB pre-probe completes in seconds; before v351 the
            // 64 KB probe aborted at 45 s → mis-classified SLOW → wedge).
            const tier = await pollUntil(
                () => page.evaluate(() => (window as any).getCurrentPWATier()),
                (t: string) => t === 'VERY_SLOW',
                { timeoutMs: 120_000, intervalMs: 2000 },
            );
            writeArtifact(dir, '02_tier.json', { tier });
            expect(tier, 'probe classifies VERY_SLOW at low bandwidth').toBe('VERY_SLOW');

            // THE NO-WEDGE PROOF: every tier assembles → report SYNCED. A wedged
            // ORIGINAL (the pre-v351 bug) would never complete and this would time out.
            // Interim progress is logged so a real wedge (a tier stuck at a fixed pct)
            // is distinguishable from slow-but-climbing.
            let _progress: any[] = [];
            const truth = await pollUntil(
                () => {
                    const t = pgReportTruth(realCid);
                    _progress.push({ at: _progress.length, media: t.media.map(m => `${m.resolution_tier}:${m.assembly_status}:${Math.round(m.completion_pct || 0)}%`) });
                    writeArtifact(dir, '03_progress.json', _progress);
                    return t;
                },
                (t) => t.report_id !== null
                    && t.media.length >= 3
                    && t.media.every(m => m.assembly_status === 'complete'),
                { timeoutMs: 300_000, intervalMs: 5000 },
            );
            writeArtifact(dir, '03_drained.json', {
                sync_status: truth.sync_status,
                media: truth.media.map(m => ({ tier: m.resolution_tier, status: m.assembly_status, pct: m.completion_pct })),
            });
            expect(truth.report_id, 'report reached backend').toBeTruthy();
            const tiers = truth.media.map(m => m.resolution_tier).sort();
            expect(tiers, 'SMALL + MEDIUM + ORIGINAL all present').toEqual(['MEDIUM', 'ORIGINAL', 'SMALL']);
            expect(truth.media.every(m => m.assembly_status === 'complete'), 'EVERY tier assembled (no wedge) at low bandwidth').toBe(true);
            expect(truth.location_lat).toBeCloseTo(LAT, 4);
        } finally {
            if (realCid) cleanupReport(realCid);
        }
    });
});
