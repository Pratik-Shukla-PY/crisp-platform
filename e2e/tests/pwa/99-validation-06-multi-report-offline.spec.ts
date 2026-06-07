/**
 * Validation Scenario 06 — Multi-report offline queue drain.
 *
 * Capture 4 reports back-to-back while OFFLINE, then reconnect. All 4 must
 * drain to SYNCED on the dashboard with no swapped IDs, no duplicates, and
 * each report's geotag preserved.
 *
 * Also exercises the report-lifecycle reset under the offline queue path (the
 * recurring "stale state leaks into the next report" guard): after each offline
 * submit the capture state is fully cleared AND the IDB queue grows by exactly
 * one — reset clears in-memory state + DOM but NEVER drains the queue (UNDP
 * must-have #3, offline-first).
 *
 * Pass criteria:
 *   · queue depth grows by exactly 1 per offline submit (reset never shrinks it)
 *   · capture state clean between offline submits (description / audio /
 *     crisis-pack answers do NOT carry to the next report)
 *   · 4 distinct queue items in IDB while offline
 *   · On reconnect, all 4 reach SYNCED within 120 s
 *   · Each report's lat/lng matches its respective fixture (no cross-talk)
 *   · No duplicate Report rows
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
    FIXTURES_DIR, ensureScenarioDir, pgReportTruth, pollUntil,
    writeArtifact, cleanupReport, PG_DSN,
} from './_validation-harness';

const FIXTURES = [
    { name: 'IMG_5718',   file: 'IMG_5718.jpg',   lat: 12.93488, lng: 77.61173 },
    { name: 'IMG_5785',   file: 'IMG_5785.jpg',   lat: 25.46743, lng: 81.78442 },
    { name: 'IMG_5832',   file: 'IMG_5832.jpg',   lat: 25.16453, lng: 82.50972 },
    { name: 'IMG_5931',   file: 'IMG_5931.jpg',   lat: 19.07283, lng: 72.88261 },
];
const SCENARIO = '06-multi-report-offline';
const DEVICE_HASH = 'PWA-validation-multi-report-offline-06';

test.describe('VALIDATION 06 — 4 reports captured offline → drain all on reconnect', () => {
    test('4 offline captures → reconnect → all 4 SYNCED with correct geotags', async ({ page }) => {
        test.setTimeout(300_000);
        const resultDir = ensureScenarioDir(SCENARIO, 'multi');

        await page.addInitScript((h) => {
            localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_device_id_v2', h);
        }, DEVICE_HASH);
        await page.goto('index.html');
        await page.waitForFunction(
            () => typeof (window as any).__crispIngestFile === 'function'
                && typeof (window as any).ImageVariants?.generate === 'function',
            null, { timeout: 15_000 },
        );

        await page.context().setOffline(true);

        // Capture + submit all fixtures while offline
        const cids: string[] = [];
        let submittedSoFar = 0;
        for (const fx of FIXTURES) {
            const fixtureBytes = fs.readFileSync(path.join(FIXTURES_DIR, fx.file));
            // Ingest + variants
            await page.evaluate(async ({ bytes, name }) => {
                const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
                const file = new File([blob], name, { type: 'image/jpeg' });
                await (window as any).__crispIngestFile(file);
                const deadline = Date.now() + 30_000;
                while (Date.now() < deadline) {
                    const s = (window as any).state;
                    if (s.photoVariants?.small && s.photoVariants?.medium && s.photoVariants?.original) return;
                    await new Promise(r => setTimeout(r, 250));
                }
            }, { bytes: Array.from(fixtureBytes), name: fx.file });

            await page.evaluate(({ lat, lng, desc, ans }) => {
                const s = (window as any).state;
                s.crisis_type = 'FLOOD';
                s.infrastructure_type = 'HOUSE';
                s.damage_classification = 'PARTIAL';
                s.severity = 'MODERATE';
                s.description = desc;
                s.location = { lat, lng, acc: 5 };
                s.locationName = 'Multi-offline test';
                s.crisisStockAnswers = ans;   // data-integrity: must NOT carry to the next offline report
            }, { lat: fx.lat, lng: fx.lng, desc: `Validation 06 — ${fx.name}`, ans: { test_q: `ans-${fx.name}` } });

            await page.evaluate(async () => { await (window as any).__crispSubmitReport(); });
            await page.waitForTimeout(500);  // let submitReport settle + clear capture state
            submittedSoFar++;

            // ── Reset-between-offline-submits invariant (the recurring-bug guard,
            // exercised under the offline queue path). After each submit the
            // capture state must be fully cleared AND the IDB queue must have
            // grown by exactly one — reset clears in-memory state + DOM but
            // NEVER drains the queue (UNDP must-have #3, offline-first).
            const probe = await page.evaluate((deviceHash) =>
                (window as any).__crispGetAllQueued().then((all: any[]) => {
                    const s = (window as any).state;
                    return {
                        depth: all.filter((q) => q.meta?.device_hash === deviceHash).length,
                        description: s.description,
                        audioBlobNull: s.audioBlob === null,
                        crisis_type: s.crisis_type,
                        stockAnswers: s.crisisStockAnswers,
                    };
                }), DEVICE_HASH);
            expect(probe.depth, `queue depth after offline submit #${submittedSoFar} must grow by exactly 1`).toBe(submittedSoFar);
            expect(probe.description, `description cleared after offline submit #${submittedSoFar}`).toBe('');
            expect(probe.audioBlobNull, `audioBlob cleared after offline submit #${submittedSoFar}`).toBe(true);
            expect(probe.crisis_type, `crisis_type cleared after offline submit #${submittedSoFar}`).toBeNull();
            expect(probe.stockAnswers, 'crisis-pack answers must NOT carry to the next offline report').toEqual({});

            // HC80 — reopen the sticky submit latch between reports, mirroring
            // the real UI's "Report another" → resetApp(). submitReport latches
            // `_submitCommitted=true` on success so duplicate taps of the SAME
            // capture are no-ops; capturing a genuinely NEW report in the UI
            // always routes through a reset that reopens it. Without this the
            // 2nd + 3rd programmatic submits are correctly deduped → only 1
            // report queues (the "got 1, expected 3" failure). This is a test-
            // harness reset, not a product change.
            await page.evaluate(() => (window as any).__crispOpenSubmitLatch && (window as any).__crispOpenSubmitLatch());

            // Note: state.photoVariants is cleared by _clearCaptureState after submit; need a fresh page evaluate cycle
        }

        // Read the queue — should have one item per fixture
        const queue = await page.evaluate(async (deviceHash) => {
            const all = await (window as any).__crispGetAllQueued();
            return all
                .filter((q: any) => q.meta?.device_hash === deviceHash)
                .sort((a: any, b: any) => (a.meta?.client_created_at || '').localeCompare(b.meta?.client_created_at || ''))
                .map((q: any) => ({
                    cid: q.client_report_id,
                    desc: q.meta?.description,
                    lat: q.meta?.location?.lat,
                    lng: q.meta?.location?.lng,
                }));
        }, DEVICE_HASH);
        writeArtifact(resultDir, '01_idb_offline.json', queue);
        expect(queue.length, `expected ${FIXTURES.length} IDB queue rows, got ${queue.length}`).toBe(FIXTURES.length);
        cids.push(...queue.map((q: any) => q.cid));

        // ── RECONNECT ─────────────────────────────────────────────────────
        const onlineAt = Date.now();
        await page.context().setOffline(false);
        await page.evaluate(() => {
            window.dispatchEvent(new Event('online'));
            if ((window as any).startRetryLoop) (window as any).startRetryLoop();
        });

        // Poll for all reaching SYNCED
        const finalStates = await pollUntil(
            () => cids.map(cid => pgReportTruth(cid)),
            (states) => states.every(t => t.report_id !== null
                && t.media.length >= 3
                && t.media.every(m => m.assembly_status === 'complete')
                && t.sync_status === 'SYNCED'),
            { timeoutMs: 120_000, intervalMs: 2000 },
        );
        const timeToAllSynced = Date.now() - onlineAt;
        writeArtifact(resultDir, '02_pg_final_all.json', { timeToAllSynced, finalStates });

        // Per-fixture assertions: cid order must match capture order; each
        // geotag must match its respective fixture (no cross-talk).
        for (let i = 0; i < FIXTURES.length; i++) {
            const fx = FIXTURES[i];
            const truth = finalStates[i];
            expect(truth.report_id, `${fx.name}: report row missing`).toBeTruthy();
            expect(truth.sync_status, `${fx.name}: not SYNCED`).toBe('SYNCED');
            expect(Math.abs(truth.location_lat! - fx.lat)).toBeLessThan(0.0001);
            expect(Math.abs(truth.location_lng! - fx.lng)).toBeLessThan(0.0001);
        }

        // No duplicates in DB
        for (const cid of cids) {
            const count = parseInt(
                execSync(`psql "${PG_DSN}" -A -t -c "SELECT COUNT(*) FROM reports WHERE client_report_id = '${cid}'"`, { encoding: 'utf8' }).trim(),
                10,
            );
            expect(count, `duplicate report for ${cid}`).toBe(1);
        }

        for (const cid of cids) cleanupReport(cid);
    });
});
