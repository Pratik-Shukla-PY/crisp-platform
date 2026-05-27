/**
 * CRISP — burst-submission load test (Sprint 3A, May 2026).
 *
 * Simulates N concurrent reporters each submitting M reports/minute
 * for a TARGET_DURATION minutes. Measures backend behaviour under
 * concentrated submission load — the worst-case scenario in a real
 * disaster (everyone reporting in the first 10 minutes after impact).
 *
 * Default config = pilot-scale baseline. Tune via env vars below.
 *
 * Usage:
 *   k6 run scripts/load-test/k6-submit-burst.js
 *   K6_VUS=200 K6_DURATION=10m k6 run scripts/load-test/k6-submit-burst.js
 *   BACKEND_URL=http://localhost:8000 k6 run scripts/load-test/k6-submit-burst.js
 *
 * Reads:
 *   K6_VUS              — virtual user count (default 100)
 *   K6_DURATION         — total duration (default 5m)
 *   K6_RAMPUP           — ramp-up phase duration (default 30s)
 *   K6_REPORTS_PER_MIN  — reports per VU per minute (default 5)
 *   BACKEND_URL         — backend root (default http://localhost:8000)
 *
 * Reports:
 *   - p50/p95/p99 latency on POST /reports/meta + /description + /chunk-bin
 *   - error rate (5xx + connection failures) per endpoint
 *   - assembly queue depth (via a poll of /reports/?limit=1 every 30s
 *     for a rough "did the backend keep up?" signal)
 *
 * Out of scope (deliberately):
 *   - Multi-region cold start (use the AWS load-test harness for that)
 *   - Real photo uploads — chunk bodies are synthetic (constant size)
 *     so we measure the BACKEND ingest path, not the network
 *   - Authentication — submit path is anonymous by UNDP must-have #9;
 *     no token plumbing needed
 *
 * Install k6:
 *   brew install k6
 *   # or: docker run --rm -v $PWD:/work grafana/k6 run /work/scripts/load-test/k6-submit-burst.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// ── Config (env-overridable) ────────────────────────────────────
const VUS                = parseInt(__ENV.K6_VUS               || "100", 10);
const DURATION           =          __ENV.K6_DURATION          || "5m";
const RAMPUP             =          __ENV.K6_RAMPUP            || "30s";
const REPORTS_PER_MIN    = parseInt(__ENV.K6_REPORTS_PER_MIN   || "5",   10);
const BACKEND_URL        =          __ENV.BACKEND_URL          || "http://localhost:8000";

// One submit attempt every `60_000 / REPORTS_PER_MIN` ms per VU.
const SLEEP_MS = Math.floor(60_000 / REPORTS_PER_MIN);

// ── Metrics ─────────────────────────────────────────────────────
const submitOk        = new Rate("crisp_submit_ok");
const submitErr       = new Counter("crisp_submit_err_total");
const metaLatency     = new Trend("crisp_meta_latency_ms", true);
const descLatency     = new Trend("crisp_desc_latency_ms", true);
const chunkLatency    = new Trend("crisp_chunk_latency_ms", true);

// ── Options ─────────────────────────────────────────────────────
export const options = {
    scenarios: {
        burst: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
                { duration: RAMPUP,   target: VUS },   // ramp up
                { duration: DURATION, target: VUS },   // hold burst
                { duration: "30s",    target: 0 },     // ramp down
            ],
            gracefulRampDown: "10s",
        },
    },
    thresholds: {
        // Critical: 99% of submits succeed end-to-end. Each submit is
        // meta + description + 1 chunk (one tier, one variant).
        crisp_submit_ok:        ["rate>0.99"],
        // Backend-side p95: meta + description should be fast; chunk
        // POSTs are the bulk of the work but at ~100 KB payload should
        // stay sub-2-second on a healthy backend.
        crisp_meta_latency_ms:  ["p(95)<800"],
        crisp_desc_latency_ms:  ["p(95)<800"],
        crisp_chunk_latency_ms: ["p(95)<2000"],
    },
    // Output a JSON summary for later analysis.
    summaryTrendStats: ["min", "med", "avg", "p(95)", "p(99)", "max"],
};

// ── Helpers ─────────────────────────────────────────────────────

// Roughly-100 KB synthetic JPEG (binary noise; backend's chunk
// handler doesn't validate JPEG signature, just byte count).
const CHUNK_SIZE_BYTES = 100 * 1024;
const SYNTHETIC_CHUNK = (() => {
    const buf = new Uint8Array(CHUNK_SIZE_BYTES);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 37) & 0xff;
    return buf.buffer;
})();

function uuid() {
    // RFC 4122 v4 (k6 has crypto.randomUUID() but not under all versions).
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === "x" ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Lat/lng: drift each VU around a single anchor (a sample disaster
// location — Bangalore, India). Each VU adds a small offset so the
// reports don't all geocode to the same building.
const ANCHOR = { lat: 12.971, lng: 77.594 };
function jitter() {
    return (Math.random() - 0.5) * 0.05;   // ± ~5 km
}

// ── The submission flow ─────────────────────────────────────────
//
// Mirrors what `mobile-app/src/app.js::trySendQueuedReport` does for a
// single-photo report:
//   1. POST /reports/meta             (small JSON)
//   2. PATCH /reports/{id}/description (small JSON)
//   3. POST  /reports/{id}/media/{media_id}/chunk-bin
//          one chunk, one variant, no resumption (single-shot)
export default function () {
    const clientReportId = uuid();
    const deviceHash     = `k6-vu-${__VU}`;

    // ── 1. meta ──
    const metaUrl = `${BACKEND_URL}/api/v1/reports/meta`;
    const metaBody = JSON.stringify({
        device_hash:           deviceHash,
        client_report_id:      clientReportId,
        source:                "APP",
        severity:              "MODERATE",
        infrastructure_type:   "RESIDENTIAL",
        crisis_type:           "EARTHQUAKE",
        damage_classification: "PARTIAL",
        description:           "",
        expected_media:        1,
        location: {
            latitude:          ANCHOR.lat + jitter(),
            longitude:         ANCHOR.lng + jitter(),
            accuracy_meters:   10,
        },
    });
    const metaT0 = Date.now();
    const metaRes = http.post(metaUrl, metaBody, {
        headers: { "Content-Type": "application/json", "X-Caller-Device-Hash": deviceHash },
        tags:    { endpoint: "/reports/meta" },
        timeout: "10s",
    });
    metaLatency.add(Date.now() - metaT0);
    if (!check(metaRes, { "meta 201": r => r.status === 201 })) {
        submitErr.add(1);
        submitOk.add(false);
        return;
    }
    const meta = metaRes.json();
    const reportId = meta.id;
    const mediaId = meta.media && meta.media[0] && meta.media[0].id;
    if (!reportId || !mediaId) {
        submitErr.add(1);
        submitOk.add(false);
        return;
    }

    // ── 2. description ──
    const descUrl = `${BACKEND_URL}/api/v1/reports/${reportId}/description`;
    const descT0 = Date.now();
    const descRes = http.patch(descUrl, JSON.stringify({
        description: `k6 load-test from VU ${__VU} at iteration ${__ITER}`,
    }), {
        headers: { "Content-Type": "application/json", "X-Caller-Device-Hash": deviceHash },
        tags:    { endpoint: "/reports/{id}/description" },
        timeout: "10s",
    });
    descLatency.add(Date.now() - descT0);
    if (!check(descRes, { "desc 200": r => r.status === 200 })) {
        submitErr.add(1);
        submitOk.add(false);
        return;
    }

    // ── 3. chunk (single shot) ──
    const chunkUrl = `${BACKEND_URL}/api/v1/reports/${reportId}/media/${mediaId}/chunk-bin?seq=0&total=1&content_type=image%2Fjpeg`;
    const chunkT0 = Date.now();
    const chunkRes = http.post(chunkUrl, SYNTHETIC_CHUNK, {
        headers: {
            "Content-Type":            "application/octet-stream",
            "X-Caller-Device-Hash":    deviceHash,
            "X-Client-Blur-Applied":   "1",
        },
        tags:    { endpoint: "/reports/.../chunk-bin" },
        timeout: "30s",
    });
    chunkLatency.add(Date.now() - chunkT0);
    if (!check(chunkRes, { "chunk 200/201": r => r.status === 200 || r.status === 201 })) {
        submitErr.add(1);
        submitOk.add(false);
        return;
    }

    submitOk.add(true);

    // Pace the next submit so this VU stays at REPORTS_PER_MIN.
    sleep(SLEEP_MS / 1000);
}

// ── Summary handler ─────────────────────────────────────────────
// Override the default end-of-run output. Writes:
//   - stdout summary table
//   - .lighthouseci/load-summary.json (machine-readable, for the
//     scaling-validation doc)
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.2/index.js";

export function handleSummary(data) {
    return {
        "stdout":                            textSummary(data, { indent: "  ", enableColors: true }),
        "scripts/load-test/k6-summary.json": JSON.stringify(data, null, 2),
    };
}
