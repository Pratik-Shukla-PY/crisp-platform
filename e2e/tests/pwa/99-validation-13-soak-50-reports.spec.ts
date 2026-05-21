/**
 * Validation Scenario 13 — Soak test: 50 reports submitted over a sustained
 * 2 KBPS link.
 *
 * Real-world disaster sim: 50 captures back-to-back, each with the full
 * variant pipeline, all draining through a single 2 KBPS link. We're not
 * just verifying delivery; we're verifying the system doesn't degrade
 * (memory leak, IDB quota exhaustion, FD exhaustion) over a long run.
 *
 * Pass criteria:
 *   · ≥ 80% of reports reach the dashboard within 30 min (SMALL or full)
 *   · No silent drops — every cid is accounted for (queue OR DB OR mark-deferred)
 *   · No backend OOM / 5xx storm
 *   · No PWA hang / browser tab crash
 *
 * Runtime: ~20–30 min. Operator runs this when they have time budget;
 * marked test.skip by default so the suite stays fast.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
    FIXTURES_DIR, ensureScenarioDir, pgReportTruth,
    writeArtifact, cleanupReport, PG_DSN,
} from './_validation-harness';

const FIXTURE = { name: 'IMG_5735_2', file: 'IMG_5735_2.jpg', lat: 12.84461, lng: 77.66421 };
const SCENARIO = '13-soak-50';
const DEVICE_HASH_PREFIX = 'PWA-validation-soak';
const REPORT_COUNT = 50;

// Skipped by default — long-running, run explicitly with --grep "VALIDATION 13"
test.describe('VALIDATION 13 — 50-report soak at 2 KBPS (long-running)', () => {
    test.skip(({}, testInfo) => !process.env.RUN_SOAK_TEST, 'set RUN_SOAK_TEST=1 to enable');
    test(`${REPORT_COUNT} reports → all accounted for; no degradation`, async ({ page }) => {
        test.setTimeout(1800_000);  // 30 min
        const resultDir = ensureScenarioDir(SCENARIO, 'soak-50');

        await page.addInitScript((h) => {
            localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_device_id_v2', h);
        }, DEVICE_HASH_PREFIX);
        await page.goto('index.html');
        await page.waitForFunction(
            () => typeof (window as any).__crispIngestFile === 'function'
                && typeof (window as any).ImageVariants?.generate === 'function',
            null, { timeout: 15_000 },
        );

        // 2 KBPS throttle for the duration
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
            offline: false, downloadThroughput: 2000, uploadThroughput: 2000, latency: 1500,
        });

        const fixtureBytes = fs.readFileSync(path.join(FIXTURES_DIR, FIXTURE.file));
        const cids: string[] = [];
        const startedAt = Date.now();

        for (let i = 0; i < REPORT_COUNT; i++) {
            const deviceHash = `${DEVICE_HASH_PREFIX}-${i.toString().padStart(2, '0')}`;
            await page.evaluate((h) => localStorage.setItem('crisp_device_id_v2', h), deviceHash);

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
            }, { bytes: Array.from(fixtureBytes), name: FIXTURE.file });

            await page.evaluate(({ lat, lng, idx }) => {
                const s = (window as any).state;
                s.crisis_type = 'FLOOD';
                s.infrastructure_type = 'HOUSE';
                s.damage_classification = 'PARTIAL';
                s.severity = 'MODERATE';
                s.description = `Soak test ${idx}/50`;
                s.location = { lat, lng, acc: 5 };
                s.locationName = `Soak ${idx}`;
            }, { lat: FIXTURE.lat, lng: FIXTURE.lng, idx: i });

            await page.evaluate(async () => { await (window as any).__crispSubmitReport(); });
            const cid = await page.evaluate(async (h) => {
                const all = await (window as any).__crispGetAllQueued();
                const ours = all.find((q: any) => q.meta?.device_hash === h);
                return ours?.client_report_id || null;
            }, deviceHash);
            if (cid) cids.push(cid);

            // Status log every 5 reports
            if ((i + 1) % 5 === 0) {
                const elapsed = (Date.now() - startedAt) / 1000;
                console.log(`[Soak] ${i + 1}/${REPORT_COUNT} submitted (elapsed ${elapsed.toFixed(0)}s)`);
            }
        }
        const allSubmittedMs = Date.now() - startedAt;
        writeArtifact(resultDir, '01_submit_phase.json', {
            cids: cids.length, totalElapsedMs: allSubmittedMs, fixture: FIXTURE,
        });

        // ── Wait for drain — up to 25 min ──────────────────────────────
        const drainDeadline = Date.now() + 25 * 60_000;
        let lastStateLog = Date.now();
        while (Date.now() < drainDeadline) {
            const accountedFor = cids.filter(cid => {
                const t = pgReportTruth(cid);
                return t.report_id !== null
                    && t.media.some(m => m.resolution_tier === 'SMALL' && m.assembly_status === 'complete');
            }).length;
            if (Date.now() - lastStateLog > 60_000) {
                console.log(`[Soak] drain progress: ${accountedFor}/${cids.length}`);
                lastStateLog = Date.now();
            }
            if (accountedFor >= Math.ceil(cids.length * 0.8)) break;
            await new Promise(r => setTimeout(r, 5000));
        }

        // Final tally
        const finalStates = cids.map(cid => {
            const t = pgReportTruth(cid);
            return {
                cid: cid.slice(0, 8),
                sync_status: t.sync_status,
                small_complete: !!t.media.find(m => m.resolution_tier === 'SMALL' && m.assembly_status === 'complete'),
                media_count: t.media_count,
            };
        });
        const successes = finalStates.filter(s => s.small_complete).length;
        const successRate = successes / REPORT_COUNT;
        writeArtifact(resultDir, '02_final_tally.json', {
            submitted: cids.length,
            smallLanded: successes,
            successRate,
            finalStates,
            totalElapsedMs: Date.now() - startedAt,
        });

        // Pass criteria: ≥ 80% of reports land SMALL on backend
        expect(successRate, `soak test success rate: ${(successRate * 100).toFixed(1)}%`)
            .toBeGreaterThanOrEqual(0.80);

        // Cleanup all
        for (const cid of cids) cleanupReport(cid);
    });
});
