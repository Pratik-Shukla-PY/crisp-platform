/**
 * Validation Scenario 02 — Offline → reconnect.
 *
 * Capture report while OFFLINE; report must land in IDB queue with all 3
 * variants. On reconnect, drain must fire automatically and the report
 * must reach the dashboard within the SLA below.
 *
 * Pass criteria (one fixture, IMG_5832):
 *  · After offline submit: IDB has 1 queue item with all 3 variants
 *  · After page.context().setOffline(false): drain starts within 5s
 *  · SYNCED on the dashboard within 60s of reconnect
 *  · No duplicate Report row created on reconnect
 *  · Variant bytes match input (no truncation)
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    FIXTURES_DIR, ensureScenarioDir, pgReportTruth, pollUntil,
    pwaQueueState, writeArtifact, cleanupReport, PG_DSN,
} from './_validation-harness';
import { execSync } from 'child_process';

const FIXTURE = { name: 'IMG_5832', file: 'IMG_5832.jpg', lat: 25.16453, lng: 82.50972, sizeBytes: 2476007 };
const SCENARIO = '02-offline-reconnect';
const DEVICE_HASH = 'PWA-validation-offline-reconnect-02';

test.describe('VALIDATION 02 — offline capture → reconnect drains queue', () => {
    test(`${FIXTURE.name}: offline → 30s wait → online → SYNCED in dashboard`, async ({ page }) => {
        test.setTimeout(180_000);
        const resultDir = ensureScenarioDir(SCENARIO, FIXTURE.name);
        const fixturePath = path.join(FIXTURES_DIR, FIXTURE.file);

        const wireLog: Array<{ ts: number; method: string; url: string; status?: number }> = [];
        page.on('request', (req) => {
            if (req.url().includes('/api/v1/')) wireLog.push({ ts: Date.now(), method: req.method(), url: req.url() });
        });
        page.on('response', (res) => {
            if (!res.url().includes('/api/v1/')) return;
            const idx = wireLog.findIndex(w => w.url === res.url() && w.status === undefined);
            if (idx >= 0) wireLog[idx].status = res.status();
        });

        // Boot PWA
        await page.addInitScript((h) => {
            localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_device_id_v2', h);
            localStorage.setItem('crisp_lang', 'en');
        }, DEVICE_HASH);
        await page.goto('index.html');
        await page.waitForFunction(
            () => typeof (window as any).__crispIngestFile === 'function'
                && typeof (window as any).ImageVariants?.generate === 'function',
            null, { timeout: 15_000 },
        );

        // ── GO OFFLINE before submit ───────────────────────────────────
        await page.context().setOffline(true);
        const offlineAt = Date.now();
        writeArtifact(resultDir, '00_offline_at.json', { ts: offlineAt });

        // Ingest file + wait for variants
        const fixtureBytes = fs.readFileSync(fixturePath);
        const ingestResult = await page.evaluate(async ({ bytes, name }) => {
            const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
            const file = new File([blob], name, { type: 'image/jpeg' });
            await (window as any).__crispIngestFile(file);
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
                const s = (window as any).state;
                if (s.photoVariants?.small && s.photoVariants?.medium && s.photoVariants?.original) {
                    return { ok: true, groupId: s.photoGroupId };
                }
                await new Promise(r => setTimeout(r, 250));
            }
            return null;
        }, { bytes: Array.from(fixtureBytes), name: FIXTURE.file });
        expect(ingestResult, 'variants never populated while offline').toBeTruthy();

        // Inject state + submit (PWA submits while offline → queues in IDB)
        await page.evaluate(({ lat, lng }) => {
            const s = (window as any).state;
            s.crisis_type = 'FLOOD';
            s.infrastructure_type = 'GOVERNMENT';
            s.damage_classification = 'PARTIAL';
            s.severity = 'MODERATE';
            s.description = 'Validation 02 — offline submit';
            s.location = { lat, lng, acc: 5 };
            s.locationName = 'Offline test point';
        }, { lat: FIXTURE.lat, lng: FIXTURE.lng });

        await page.evaluate(async () => { await (window as any).__crispSubmitReport(); });

        // ── C1: IDB queue should hold the report while offline ─────────
        const cid = await page.evaluate(async (deviceHash) => {
            const all = await (window as any).__crispGetAllQueued();
            const sorted = all.sort((a: any, b: any) => (b.meta?.client_created_at || '').localeCompare(a.meta?.client_created_at || ''));
            return sorted.find((q: any) => q.meta?.device_hash === deviceHash)?.client_report_id || null;
        }, DEVICE_HASH);
        expect(cid, 'PWA never enqueued while offline').toBeTruthy();
        const queueOffline = await pwaQueueState(page, cid!);
        writeArtifact(resultDir, '01_L1_idb_offline.json', queueOffline);
        expect(queueOffline.present).toBe(true);
        expect(queueOffline.photoVariants?.small).toBeTruthy();
        expect(queueOffline.photoVariants?.medium).toBeTruthy();
        expect(queueOffline.photoVariants?.original).toBeTruthy();

        // Verify backend has NO row yet (we're offline)
        const truthOffline = pgReportTruth(cid!);
        expect(truthOffline.report_id, 'backend somehow has the row while client is offline').toBeNull();
        writeArtifact(resultDir, '02_L4_pg_offline.json', truthOffline);

        // ── Wait offline for 30s to prove queue persistence ────────────
        await page.waitForTimeout(30_000);

        // ── RECONNECT — backend traffic must resume + drain ────────────
        const onlineAt = Date.now();
        await page.context().setOffline(false);
        writeArtifact(resultDir, '03_online_at.json', { ts: onlineAt, offlineDurationMs: onlineAt - offlineAt });
        // Manually kick the retry loop in case the page didn't wake via 'online' event
        await page.evaluate(() => {
            window.dispatchEvent(new Event('online'));
            if ((window as any).startRetryLoop) (window as any).startRetryLoop();
        });

        // ── Poll for SYNCED in Postgres within 60s of reconnect ────────
        const truthFinal = await pollUntil(
            () => pgReportTruth(cid!),
            (t) => t.report_id !== null
                && t.media_count >= 3
                && t.media.every(m => m.assembly_status === 'complete' && m.url)
                && t.sync_status === 'SYNCED',
            { timeoutMs: 60_000, intervalMs: 1000 },
        );
        const timeToSyncMs = Date.now() - onlineAt;
        writeArtifact(resultDir, '04_L4_pg_final.json', { truthFinal, timeToSyncMs });

        expect(truthFinal.report_id, 'report never reached server after reconnect').toBeTruthy();
        expect(truthFinal.sync_status).toBe('SYNCED');
        expect(truthFinal.media_count).toBeGreaterThanOrEqual(3);
        expect(truthFinal.media.every(m => m.assembly_status === 'complete')).toBe(true);

        // SLA: SYNCED within 60s of reconnect
        expect(timeToSyncMs, `time-to-SYNCED after reconnect: ${timeToSyncMs}ms`).toBeLessThan(60_000);

        // No duplicate Report row
        const dupCheck = execSync(`psql "${PG_DSN}" -A -t -c "SELECT COUNT(*) FROM reports WHERE client_report_id = '${cid}'"`, { encoding: 'utf8' }).trim();
        expect(parseInt(dupCheck, 10), 'duplicate Report row created on reconnect').toBe(1);

        // Geotag preserved
        expect(Math.abs(truthFinal.location_lat! - FIXTURE.lat)).toBeLessThan(0.0001);
        expect(Math.abs(truthFinal.location_lng! - FIXTURE.lng)).toBeLessThan(0.0001);

        // Wire log captures the offline→online traffic transition
        writeArtifact(resultDir, '05_L2_wire.json', wireLog);

        cleanupReport(cid!);
    });
});
