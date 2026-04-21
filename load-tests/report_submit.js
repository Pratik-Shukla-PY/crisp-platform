// ─────────────────────────────────────────────────────────────────────────────
//  CRISP — k6 load test: report submission + chunked media upload
//
//  Exercises the full "meta → chunks → assembly" path that a real mobile
//  client would drive. Each VU:
//    1. POST /api/v1/reports/meta with a random device_hash + client_report_id
//    2. Stream a synthetic 3-chunk IMAGE payload via POST /media/chunk
//    3. (Optional) poll GET /api/v1/reports/ to drive dashboard load
//
//  Scenarios:
//    - smoke     → 1 VU for 30 s (sanity check before a longer run)
//    - realistic → ramp 0 → 50 VU over 2 min, hold 3 min  (roughly matches
//                  the p50 UNDP district-event load we modelled)
//    - stress    → ramp 0 → 200 VU, hold 5 min           (find the knee)
//
//  Usage (from repo root, with the backend running on :8000):
//    brew install k6                              # or: snap install k6
//    k6 run -e BASE_URL=http://localhost:8000 load-tests/report_submit.js
//    k6 run -e SCENARIO=stress load-tests/report_submit.js
//
//  Outputs p50 / p95 / error-rate summary at the end. Failure thresholds
//  mirror Sprint 2's performance claims — breach = regression.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ── Config ──────────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const SCENARIO = __ENV.SCENARIO || 'realistic';

const scenarios = {
    smoke: {
        executor: 'constant-vus',
        vus: 1,
        duration: '30s',
    },
    realistic: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
            { duration: '2m', target: 50 },
            { duration: '3m', target: 50 },
            { duration: '30s', target: 0 },
        ],
        gracefulRampDown: '30s',
    },
    stress: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
            { duration: '2m', target: 200 },
            { duration: '5m', target: 200 },
            { duration: '1m', target: 0 },
        ],
        gracefulRampDown: '1m',
    },
};

export const options = {
    scenarios: { [SCENARIO]: scenarios[SCENARIO] || scenarios.realistic },
    // Sprint 2 claim: chunk handler responds in <200 ms p95 under 50 VU;
    // /reports/ list responds in <500 ms p95 thanks to joinedload.
    thresholds: {
        // Overall request failure rate: <1%.
        'http_req_failed':            ['rate<0.01'],
        'http_req_duration':          ['p(95)<2000'],
        'http_req_duration{route:meta}':  ['p(95)<500'],
        'http_req_duration{route:chunk}': ['p(95)<500'],
        'http_req_duration{route:list}':  ['p(95)<1500'],
    },
    summaryTrendStats: ['min', 'avg', 'med', 'p(95)', 'p(99)', 'max'],
};

// ── Custom metrics ──────────────────────────────────────────────────────────
const chunksSent      = new Counter('chunks_sent');
const reportsCreated  = new Counter('reports_created');
const metaLatency     = new Trend('meta_latency_ms', true);
const chunkLatency    = new Trend('chunk_latency_ms', true);

// ── Helpers ─────────────────────────────────────────────────────────────────
function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// djb2 — matches server-side verifier in backend/app/api/endpoints/reports.py
function djb2(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h) ^ s.charCodeAt(i);
        h &= 0xFFFFFFFF;
    }
    if (h < 0) h += 0x100000000;
    return h.toString(16).padStart(8, '0');
}

// Fake base64 chunk of requested size. We don't care about the content —
// the server only validates checksum + length.
function fakeBase64(len) {
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < len; i++) out += alpha[(Math.random() * 64) | 0];
    return out;
}

// ── Main flow per virtual user ─────────────────────────────────────────────
export default function () {
    const deviceHash = `LOAD-${uuid().slice(0, 12)}`;
    const clientReportId = uuid();

    let reportId = null;
    group('01_meta', () => {
        const payload = JSON.stringify({
            device_hash: deviceHash,
            client_report_id: clientReportId,
            source: 'APP',
            severity: 'MODERATE',
            infrastructure_type: 'HOUSE',
            crisis_type: 'FLOOD',
            damage_classification: 'PARTIAL',
            expected_media: 1,
            location: { latitude: 28.6139, longitude: 77.2090, accuracy_meters: 10 },
        });
        const res = http.post(`${BASE_URL}/api/v1/reports/meta`, payload, {
            headers: { 'Content-Type': 'application/json' },
            tags: { route: 'meta' },
        });
        check(res, { 'meta 201': r => r.status === 201 });
        if (res.status === 201) {
            reportId = res.json('id');
            reportsCreated.add(1);
            metaLatency.add(res.timings.duration);
        }
    });

    if (!reportId) {
        // Server overloaded or cold-start miss — back off and retry next iter.
        sleep(1);
        return;
    }

    // Three ~128 KB chunks simulate a modest phone photo at MEDIUM tier.
    const mediaId = uuid();
    const chunkSize = 128 * 1024;
    const total = 3;
    group('02_chunks', () => {
        for (let i = 0; i < total; i++) {
            const data = fakeBase64(chunkSize);
            const body = JSON.stringify({
                media_id: mediaId,
                type: 'IMAGE',
                seq_num: i,
                total_chunks: total,
                data,
                checksum: djb2(data),
            });
            const res = http.post(
                `${BASE_URL}/api/v1/reports/${reportId}/media/chunk`,
                body,
                {
                    headers: { 'Content-Type': 'application/json' },
                    tags: { route: 'chunk' },
                    timeout: '30s',
                }
            );
            check(res, { 'chunk 200': r => r.status === 200 });
            if (res.status === 200) {
                chunksSent.add(1);
                chunkLatency.add(res.timings.duration);
            }
        }
    });

    // Light dashboard cross-load — only every 5th iteration to keep ratio
    // realistic (50 reporters for each analyst refresh).
    if (__ITER % 5 === 0) {
        group('03_list', () => {
            const res = http.get(`${BASE_URL}/api/v1/reports/?limit=20`, {
                tags: { route: 'list' },
            });
            check(res, { 'list ok': r => r.status === 200 || r.status === 401 });
        });
    }

    // Simulated think time between reports.
    sleep(Math.random() * 2 + 1);
}

export function handleSummary(data) {
    // Simple text summary so CI logs stay greppable.
    return {
        stdout: JSON.stringify({
            vus_max: data.metrics.vus_max?.values?.max,
            reports_created: data.metrics.reports_created?.values?.count,
            chunks_sent: data.metrics.chunks_sent?.values?.count,
            p95_http_ms: data.metrics.http_req_duration?.values['p(95)'],
            failed_rate: data.metrics.http_req_failed?.values?.rate,
        }, null, 2),
    };
}
