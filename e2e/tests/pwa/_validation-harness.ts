/**
 * Validation harness (May 2026) — captures L1-L7 state per test case.
 *
 *   L1  Client queue (PWA IDB)
 *   L2  Network (the wire) — caller hooks page.on('request')
 *   L3  Backend ingest (uvicorn log + Prometheus)
 *   L4  Postgres (truth)
 *   L5  Storage (file presence + bytes)
 *   L6  Dashboard API
 *   L7  Dashboard render
 *
 * Pass/fail bar lives in the spec; this module just collects facts.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Page } from '@playwright/test';

export const PG_DSN = process.env.VALIDATION_PG_DSN
    || 'postgresql://crisp:crisp@localhost:5432/crisp';
const PG_CMD = (sql: string) =>
    execSync(`psql "${PG_DSN}" -A -t -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' })
        .trim();

export const RESULTS_DIR = path.resolve(__dirname, '../../../validation/results');
export const FIXTURES_DIR = path.resolve(__dirname, '../../../validation/fixtures');

export function ensureScenarioDir(scenario: string, fixture: string): string {
    const dir = path.join(RESULTS_DIR, scenario, fixture);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export interface ReportTruth {
    report_id: string | null;
    sync_status: string | null;
    expected_media: number | null;
    received_media: number | null;
    media_count: number;
    media: Array<{
        id: string;
        resolution_tier: string;
        type: string;
        assembly_status: string;
        completion_pct: number;
        received_chunks: number;
        chunk_count: number;
        url: string | null;
        client_blur_applied: boolean | null;
        pii_blur_status: string | null;
        abandon_reason: string | null;
        photo_group_id: string | null;
    }>;
    location_lat: number | null;
    location_lng: number | null;
    submitted_anon_flag: boolean | null;
}

/** Authoritative truth — what the database says about this client_report_id. */
export function pgReportTruth(clientReportId: string): ReportTruth {
    // Location lives in its own table (1-to-1 with reports, FK by report_id).
    const reportRow = PG_CMD(
        `SELECT r.id, r.sync_status, r.expected_media, r.received_media, ` +
        `COALESCE(l.latitude::text, ''), COALESCE(l.longitude::text, ''), ` +
        `COALESCE(r.submitted_as_anonymous_due_to_expired_token::text, 'false') ` +
        `FROM reports r LEFT JOIN locations l ON l.report_id = r.id ` +
        `WHERE r.client_report_id = '${clientReportId}'`,
    );
    if (!reportRow) {
        return { report_id: null, sync_status: null, expected_media: null, received_media: null,
                 media_count: 0, media: [], location_lat: null, location_lng: null,
                 submitted_anon_flag: null };
    }
    const [report_id, sync_status, expected, received, lat, lng, anon] = reportRow.split('|');
    const mediaRowsRaw = PG_CMD(
        `SELECT id, resolution_tier, type, assembly_status, ` +
        `COALESCE(completion_pct, 0), COALESCE(received_chunks, 0), COALESCE(chunk_count, 0), ` +
        `COALESCE(url, ''), ` +
        `COALESCE(client_blur_applied::text, ''), ` +
        `COALESCE(pii_blur_status, ''), ` +
        `COALESCE(abandon_reason, ''), ` +
        `COALESCE(photo_group_id, '') ` +
        `FROM media WHERE report_id = '${report_id}' ORDER BY resolution_tier`,
    );
    const media = mediaRowsRaw
        ? mediaRowsRaw.split('\n').filter(Boolean).map((row: string) => {
            const cols = row.split('|');
            return {
                id: cols[0],
                resolution_tier: cols[1],
                type: cols[2],
                assembly_status: cols[3],
                completion_pct: parseFloat(cols[4]),
                received_chunks: parseInt(cols[5], 10),
                chunk_count: parseInt(cols[6], 10),
                url: cols[7] || null,
                // psql ::text cast on boolean returns 'true'/'false' (not 't'/'f').
                client_blur_applied: cols[8] === 'true' ? true : (cols[8] === 'false' ? false : null),
                pii_blur_status: cols[9] || null,
                abandon_reason: cols[10] || null,
                photo_group_id: cols[11] || null,
            };
        })
        : [];
    return {
        report_id,
        sync_status,
        expected_media: parseInt(expected, 10),
        received_media: parseInt(received, 10),
        media_count: media.length,
        media,
        location_lat: lat && lat.trim() ? parseFloat(lat) : null,
        location_lng: lng && lng.trim() ? parseFloat(lng) : null,
        submitted_anon_flag: anon === 'true',
    };
}

/** Wait until predicate(truth) returns true OR timeout expires. */
export async function pollUntil<T>(
    fetch: () => T,
    predicate: (v: T) => boolean,
    opts: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
    const interval = opts.intervalMs ?? 500;
    const deadline = Date.now() + opts.timeoutMs;
    let last: T | null = null;
    while (Date.now() < deadline) {
        last = fetch();
        if (predicate(last)) return last;
        await new Promise(r => setTimeout(r, interval));
    }
    return last as T;
}

/** L1 — PWA's view of its own queue, for this report. */
export async function pwaQueueState(page: Page, clientReportId: string) {
    return page.evaluate(async (cid) => {
        const all = await (window as any).__crispGetAllQueued();
        const item = all.find((q: any) => q.client_report_id === cid);
        if (!item) return { present: false };
        const variantsKey = (v: any) => v ? Object.fromEntries(
            ['small', 'medium', 'original'].map(k => [k, v[k] ? {
                mediaId: v[k].mediaId,
                complete: v[k].complete,
                deferred: v[k].deferred,
                chunkProgress: v[k].chunkProgress,
                deferredReason: v[k].deferredReason,
            } : null]),
        ) : null;
        return {
            present: true,
            stages: item.stages,
            serverId: item.serverId,
            photoVariants: variantsKey(item.photoVariants),
            extraVariantsCount: (item.extraPhotosVariants || []).length,
            meta: item.meta && { expected_media: item.meta.expected_media },
            _submissionLanded: item._submissionLanded,
            _deferredSince: item._deferredSince,
        };
    }, clientReportId);
}

/** L7 — sha256 + pHash of an image rendered on the dashboard via getMediaUrl. */
export function downloadAndHash(url: string, outPath: string): { size: number; sha256: string } {
    execSync(`curl -sL -o "${outPath}" "${url}"`, { encoding: 'utf8' });
    const size = fs.statSync(outPath).size;
    const sha = execSync(`shasum -a 256 "${outPath}" | awk '{print $1}'`).toString().trim().slice(0, 16);
    return { size, sha256: sha };
}

/** Backend Prometheus snapshot — totals before/after for delta-diff. */
export function prometheusSnapshot(): Record<string, number> {
    const out = execSync('curl -s http://localhost:8000/metrics', { encoding: 'utf8' });
    const want = [
        'crisp_variant_uploads_total',
        'crisp_chunks_received_total',
        'crisp_reports_synced_total',
        'crisp_media_abandon_reason_total',
        'crisp_pii_blur_status_total',
        'crisp_report_submitted_anonymous_due_to_expired_token_total',
    ];
    const result: Record<string, number> = {};
    for (const line of out.split('\n')) {
        if (line.startsWith('#')) continue;
        const m = line.match(/^(\w+)(?:\{[^}]*\})?\s+(\d+(?:\.\d+)?)/);
        if (m && want.some(w => m[1].startsWith(w))) {
            result[line.split(' ')[0]] = parseFloat(m[2]);
        }
    }
    return result;
}

/** Write JSON artifact next to a scenario. */
export function writeArtifact(dir: string, filename: string, data: unknown): void {
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

/** Cleanup: hard-delete a report by client_report_id so the test is rerunnable. */
export function cleanupReport(clientReportId: string): void {
    try {
        const reportId = PG_CMD(`SELECT id FROM reports WHERE client_report_id = '${clientReportId}'`);
        if (!reportId) return;
        // Order: child rows first (FK), then media, then report.
        PG_CMD(`DELETE FROM media_chunks WHERE media_id IN (SELECT id FROM media WHERE report_id = '${reportId}')`);
        PG_CMD(`DELETE FROM media WHERE report_id = '${reportId}'`);
        PG_CMD(`DELETE FROM reports WHERE id = '${reportId}'`);
    } catch (e) {
        // Best-effort cleanup; don't fail the test.
        console.warn(`[harness] cleanup failed for ${clientReportId}:`, e);
    }
}
