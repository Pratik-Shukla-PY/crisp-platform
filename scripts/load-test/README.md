# CRISP load testing

Per-sprint operator-runnable load tests. Output lands in
`k6-summary.json` for later comparison.

## Pre-requisites

- `brew install k6` (or `docker run grafana/k6 run ...`)
- Local backend running on `http://localhost:8000` (or override via
  `BACKEND_URL` env var)
- A non-PROD Postgres seatbelt — never run against `crisp` (prod-shaped
  DB name); the test creates ~100 reports/minute × N VUs.
  Conftest.py + `PYTEST_DATABASE_URL` rules apply — point at a `_test`
  DB.

## Burst submission test (Sprint 3A)

Simulates concurrent reporters all submitting at once — the worst-case
for a real disaster (everyone reports in the first 10 minutes).

```sh
# Default: 100 VUs, 5 min duration, 5 reports/VU/min = 500 reports/min
k6 run scripts/load-test/k6-submit-burst.js

# Stress: 200 VUs, 10 min, 5 reports/VU/min = 1000 reports/min
K6_VUS=200 K6_DURATION=10m k6 run scripts/load-test/k6-submit-burst.js

# Against staging instead of local
BACKEND_URL=https://staging.crisplabs.tech k6 run scripts/load-test/k6-submit-burst.js
```

Tunables (env vars):

| Var | Default | Effect |
|---|---|---|
| `K6_VUS` | 100 | concurrent virtual users |
| `K6_DURATION` | 5m | hold phase after ramp-up |
| `K6_RAMPUP` | 30s | ramp-up duration (0 → K6_VUS) |
| `K6_REPORTS_PER_MIN` | 5 | reports per VU per minute |
| `BACKEND_URL` | `http://localhost:8000` | target backend root |

Thresholds (test fails if breached):

- ≥ 99% submit success rate end-to-end
- p95 < 800ms for `/reports/meta` POST
- p95 < 800ms for `/reports/{id}/description` PATCH
- p95 < 2000ms for `/reports/.../chunk-bin` POST

## Interpreting results

`k6-summary.json` lands in the script directory. Key sections:

```json
{
  "metrics": {
    "http_req_duration": {
      "values": { "p(95)": 480, "p(99)": 920, "max": 2200, ... }
    },
    "crisp_submit_ok": {
      "values": { "rate": 0.998 }
    },
    "crisp_submit_err_total": {
      "values": { "count": 17 }
    }
  }
}
```

Pre-pilot baseline numbers (target — record actual when you first run
against staging):

| Metric | Target | Action if missed |
|---|---|---|
| `crisp_submit_ok.rate` | ≥ 0.99 | Investigate `crisp_submit_err_total` distribution by endpoint |
| `crisp_meta_latency_ms.p(95)` | ≤ 800 | Probably DB contention; check `pg_stat_activity` for long queries |
| `crisp_chunk_latency_ms.p(95)` | ≤ 2000 | Either S3 upload latency or PII-blur queue saturation |
| `crisp_chunk_latency_ms.max` | ≤ 10,000 | Anything > 10s indicates timeout or worker exhaustion |

## Out of scope (intentional)

- Authentication flow — submit is anonymous (UNDP must-have #9).
- Real photo content — chunks are synthetic noise (the backend's
  chunk handler doesn't decode the image; PII-blur runs on the
  ASSEMBLED file later, off the request thread). For end-to-end
  blur quality testing, use the Playwright spec
  `e2e/tests/pwa/120-pii-blur-vendored-offline.spec.ts`.
- Multi-region cold start — needs an actual multi-region deployment.
- Long-lived offline session + reconnect — use `e2e/tests/pwa/
  41-offline-strict.spec.ts` for that path.

## When to run

- Before any deploy that touches the chunk-handler / assembly path.
- Quarterly as part of the DR drill (so we have fresh latency
  numbers to compare against the live SLO).
- Ad-hoc when investigating a perf regression report.
