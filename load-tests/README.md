# CRISP Load Tests

Self-contained k6 scripts that exercise the chunked upload pipeline the way a
real client does — meta → chunks → (optional) dashboard read. Run these
before any deploy that touches the upload path, assembly thread pool, or
database layer.

## Install k6 once

```bash
# macOS
brew install k6

# Ubuntu/Debian
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

## Run against a local backend

```bash
# Boot the backend in another terminal:
cd backend && uvicorn app.main:app --host 0.0.0.0 --port 8000

# Smoke (1 VU, 30 s) — use while iterating.
k6 run load-tests/report_submit.js -e SCENARIO=smoke

# Realistic (50 VU ramp, ~5 min total) — the baseline we track.
k6 run load-tests/report_submit.js

# Stress (200 VU ramp, ~8 min total) — find the knee.
k6 run load-tests/report_submit.js -e SCENARIO=stress
```

## Point at another environment

```bash
k6 run -e BASE_URL=https://staging.crisp.undp.org load-tests/report_submit.js
```

## Thresholds (any breach = regression)

| Metric | Budget | Sprint 2 claim it validates |
|---|---|---|
| `http_req_failed` | `<1%` | Overall reliability floor |
| `http_req_duration p95` | `<2 s` | No silent stall paths |
| `meta p95` | `<500 ms` | `/reports/meta` idempotent insert + join |
| `chunk p95` | `<500 ms` | Chunk handler + rate limiter + DB insert |
| `list p95` | `<1.5 s` | P2.1 `joinedload` kills N+1 |

Exit code is non-zero when any threshold is violated, so k6 drops into CI or
a shell-guarded deploy step without extra plumbing.

## What it does, precisely

Each VU:

1. `POST /api/v1/reports/meta` with a fresh `device_hash` + UUID
   `client_report_id`. Loaded tag: `route=meta`.
2. Generates three ~128 KB fake-base64 chunks (checksummed with djb2, the
   same verifier the backend uses), POSTs them sequentially to
   `/api/v1/reports/{id}/media/chunk`. Tag: `route=chunk`.
3. Every fifth iteration, also fetches `/api/v1/reports/?limit=20` — simulates
   the analyst dashboard's polling cadence so we can spot read/write
   contention. Tag: `route=list`.
4. Sleeps 1–3 s between loops (realistic field-reporter cadence — users
   don't fire reports in a tight loop).

## Caveats

- The fake chunks don't assemble into a valid JPEG, so the server's assembly
  thread will decode-fail and mark the media as `failed`. That's fine for
  load purposes: we're measuring ingest, not end-to-end rendering. If you
  need end-to-end, replace `fakeBase64()` with a real base64'd photo.
- `list p95` covers the cold-join path; your dashboard will also do local
  filter/sort. That client-side cost isn't exercised here.
- PII blur and Whisper run on the AI pool and are inherently variable; they
  don't show up in these p95 numbers because they're async after the HTTP
  response returns. Watch `/metrics`' `crisp_ai_jobs_duration_seconds` +
  `crisp_assembly_queue_depth` during a run to see backend-side pressure.

---

## Guaranteed Image Delivery — progressive_image.js

The second scenario — `progressive_image.js` — validates the 3-variant photo
pipeline (SMALL → MEDIUM → LARGE). Each VU uploads all three variants for a
single captured photo, in tier order, sharing one `photo_group_id`.

```bash
# Realistic (50 VU ramp, ~4 min)
k6 run load-tests/progressive_image.js

# Slow-link emulation — 10 VU, per-chunk sleep, 5 min. Stress-tests resume.
k6 run load-tests/progressive_image.js -e SCENARIO=slow

# Stress (200 VU)
k6 run load-tests/progressive_image.js -e SCENARIO=stress
```

### Thresholds

| Metric                              | Budget    | What it validates                               |
|-------------------------------------|-----------|-------------------------------------------------|
| `variant_latency_ms{tier:LOW}` p95  | `<5 s`    | SMALL tier lands fast — the first-image SLI    |
| `variant_latency_ms{tier:MEDIUM}` p95 | `<15 s` | Progressive upgrade path keeps moving          |
| `variant_latency_ms{tier:HIGH}` p95 | `<60 s`   | Full-quality variant still lands in under a min |
| `first_image_ms` p95                | `<5 s`    | Wall-clock SLO: report → first complete image   |

Server-side equivalents (on `/metrics`):
`crisp_variant_uploads_total{tier,outcome}`,
`crisp_time_to_first_image_seconds`,
`crisp_time_to_full_image_seconds`.

### Manual end-to-end matrix

Use these in addition to the k6 run — they cover crash-and-resume paths that
synthetic load can't fully exercise.

| Scenario | Expected outcome |
|---|---|
| Offline capture → online after 2 min | Dashboard shows SMALL within ~3 s of connectivity, MEDIUM within ~10 s, LARGE within ~30 s on normal phone. |
| Capture on 64 kbps (DevTools throttle "Slow 3G") | SMALL lands in <15 s, MEDIUM in <60 s, LARGE when network allows. Dashboard auto-upgrades. |
| Kill app mid-MEDIUM upload | On reopen, SMALL is already LANDED; MEDIUM resumes from the last `extra_photos_progress` offset; LARGE queued but not started. |
| Kill backend mid-assembly | Startup recovery sweep (Sprint 1 P1.1) flips stuck `assembling` back to `pending`; next chunk retrigger completes it. Variants are per-Media-row so each recovers independently. |
| Crash at 3 of 3 extra photos, tier SMALL of photo #4 | Resume fills: SMALL#1–3 already LANDED, SMALL#4 resumes from last byte, then MEDIUM#1 → MEDIUM#4 → LARGE#1 → LARGE#4. |
