/**
 * Validation Scenario 04 — Wi-Fi flap mid-upload (resume from chunkProgress).
 *
 * Submit a report, let chunks start landing, then flip offline/online
 * repeatedly. Upload must resume from `chunkProgress` after each flap;
 * no duplicate Media rows; no duplicate Report rows; final SYNCED state.
 *
 * Pass criteria:
 *   · Report reaches SYNCED despite 3 offline/online flaps during upload
 *   · No duplicate Report row (uniq on client_report_id)
 *   · Each Media row gets exactly 1 row per tier (no dup Media)
 *   · Total elapsed time bounded (~3 min budget)
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
    FIXTURES_DIR, ensureScenarioDir, pgReportTruth, pollUntil,
    writeArtifact, cleanupReport, PG_DSN,
} from './_validation-harness';

const FIXTURE = { name: 'IMG_5718', file: 'IMG_5718.jpg', lat: 12.93488, lng: 77.61173 };
const SCENARIO = '04-wifi-flap';
const DEVICE_HASH = 'PWA-validation-wifi-flap-04';
const FLAP_COUNT = 3;
const FLAP_OFFLINE_MS = 6000;   // 6 s offline per flap
const FLAP_ONLINE_MS = 4000;    // 4 s online between flaps

test.describe('VALIDATION 04 — Wi-Fi flap mid-upload (resume + dedup)', () => {
    test(`${FIXTURE.name}: 3 flaps → resume → SYNCED + no duplicate rows`, async ({ page }) => {
        test.setTimeout(300_000);
        const resultDir = ensureScenarioDir(SCENARIO, FIXTURE.name);
        const fixturePath = path.join(FIXTURES_DIR, FIXTURE.file);

        const wireLog: Array<{ ts: number; url: string; status?: number }> = [];
        page.on('request', (req) => {
            if (req.url().includes('/api/v1/')) wireLog.push({ ts: Date.now(), url: req.url() });
        });
        page.on('response', (res) => {
            if (!res.url().includes('/api/v1/')) return;
            const idx = wireLog.findIndex(w => w.url === res.url() && w.status === undefined);
            if (idx >= 0) wireLog[idx].status = res.status();
        });

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

        const fixtureBytes = fs.readFileSync(fixturePath);
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

        await page.evaluate(({ lat, lng }) => {
            const s = (window as any).state;
            s.crisis_type = 'FLOOD';
            s.infrastructure_type = 'UTILITY';
            s.damage_classification = 'COMPLETE';
            s.severity = 'SEVERE';
            s.description = 'Validation 04 — wifi flap';
            s.location = { lat, lng, acc: 5 };
            s.locationName = 'Flap test point';
        }, { lat: FIXTURE.lat, lng: FIXTURE.lng });

        const submitStart = Date.now();
        await page.evaluate(async () => { await (window as any).__crispSubmitReport(); });

        const cid = await page.evaluate(async (deviceHash) => {
            const all = await (window as any).__crispGetAllQueued();
            const sorted = all.sort((a: any, b: any) => (b.meta?.client_created_at || '').localeCompare(a.meta?.client_created_at || ''));
            return sorted.find((q: any) => q.meta?.device_hash === deviceHash)?.client_report_id || null;
        }, DEVICE_HASH);
        expect(cid).toBeTruthy();
        writeArtifact(resultDir, '00_meta.json', { fixture: FIXTURE, clientReportId: cid });

        // ── Flap loop: offline/online cycles while upload is happening ────
        const flapEvents: Array<{ ts: number; state: 'offline' | 'online' }> = [];
        for (let i = 0; i < FLAP_COUNT; i++) {
            await page.waitForTimeout(FLAP_ONLINE_MS);
            await page.context().setOffline(true);
            flapEvents.push({ ts: Date.now(), state: 'offline' });
            await page.waitForTimeout(FLAP_OFFLINE_MS);
            await page.context().setOffline(false);
            flapEvents.push({ ts: Date.now(), state: 'online' });
            // Manually wake the retry loop after each reconnect
            await page.evaluate(() => {
                window.dispatchEvent(new Event('online'));
                if ((window as any).startRetryLoop) (window as any).startRetryLoop();
            });
        }
        writeArtifact(resultDir, '01_flap_events.json', flapEvents);

        // ── Wait for SYNCED state up to 2 min after last flap ─────────────
        const truthFinal = await pollUntil(
            () => pgReportTruth(cid!),
            (t) => t.report_id !== null
                && t.media_count >= 1
                && t.sync_status === 'SYNCED'
                && t.media.every(m => m.assembly_status === 'complete'),
            { timeoutMs: 120_000, intervalMs: 1500 },
        );
        const timeToSyncMs = Date.now() - submitStart;
        writeArtifact(resultDir, '02_truth_final.json', { truthFinal, timeToSyncMs });

        expect(truthFinal.report_id).toBeTruthy();
        expect(truthFinal.sync_status).toBe('SYNCED');

        // ── Dedup invariants — the heart of the flap test ──────────────────
        // 1. Exactly ONE Report row with this client_report_id
        const reportCount = parseInt(
            execSync(`psql "${PG_DSN}" -A -t -c "SELECT COUNT(*) FROM reports WHERE client_report_id = '${cid}'"`,
                { encoding: 'utf8' }).trim(), 10,
        );
        expect(reportCount, 'duplicate Report row created during flap').toBe(1);

        // 2. Each (report_id, resolution_tier, photo_group_id) appears at most once
        const dupMediaRaw = execSync(
            `psql "${PG_DSN}" -A -t -F'|' -c "` +
            `SELECT resolution_tier, COALESCE(photo_group_id, ''), COUNT(*) ` +
            `FROM media WHERE report_id = '${truthFinal.report_id}' ` +
            `GROUP BY resolution_tier, photo_group_id HAVING COUNT(*) > 1"`,
            { encoding: 'utf8' },
        ).trim();
        expect(dupMediaRaw, `duplicate Media rows during flap: ${dupMediaRaw}`).toBe('');

        writeArtifact(resultDir, '03_dedup_check.json', {
            reportCount, duplicateMediaRows: dupMediaRaw || 'none',
        });
        writeArtifact(resultDir, '04_L2_wire.json', wireLog);

        cleanupReport(cid!);
    });
});
