# CRISP — Service Level Objectives (SLOs)

Operator-facing reliability targets for the production environment.
Measured against PROD (`https://undp.crisplabs.tech`) over rolling
28-day windows unless otherwise noted.

Each SLO has:
- A **target** (the steady-state goal we deploy against).
- An **error budget** (how much we're allowed to miss the target before
  treating it as a regression).
- A **signal** (what observability surface tells us where we are).
- An **alerting rule** (when an operator should be paged).
- A **recovery action** (the runbook the on-call follows).

Sprint 2C-4 (May 2026, post-HC91) — baseline. Numbers are deliberately
conservative for the first pilot deployment; ratchet them up after we
have ≥7 days of real telemetry from production.

---

## 1. Submit success rate

**Target:** ≥ 99.5% of `POST /api/v1/reports/meta` calls return 2xx
within their first 5 retry attempts (counting client-side
`sendWithRetry` retries).

**Why:** A report that never enters the backend is operationally
invisible. Submit success is the absolute bottom of the funnel; if
this dips, no other SLO matters.

**Error budget:** ≤ 0.5% failure rate over 28 days = at most
~ 1 failure per 200 attempts averaged. Burst tolerated (50% over 1h)
as long as the 28-day average holds.

**Signal:**
- Sentry `transaction:POST /reports/meta` → `result:success` ratio.
- Backend `app.api.endpoints.reports` access logs filtered by status.
- Dashboard `Reports → CSV export` includes `submitted_at` vs
  `created_at` — any non-NULL gap means client retries fired.

**Alert:** Sentry rule firing if ≥ 5 distinct 5xx responses on
`/reports/meta` within any 10-minute window.

**Recovery:**
1. Check backend health: `gh api repos/.../actions/runs?status=success`
   confirms the deploy that's live.
2. `docker logs --since 30m crisp-backend-1 | grep -i "5\d\d\|exception"`.
3. If backend is healthy, suspect upstream: AWS RDS connection pool,
   S3 PUT latency, or `_validate_required_env()` failure on a recent
   env edit.
4. Roll back the last deploy if regressions correlate with a known
   commit window.

---

## 2. p95 submit-to-dashboard latency

**Target:** ≤ 30 seconds from `POST /reports/meta` ack to the report
appearing on the dashboard `Reports` list endpoint (`GET /reports/`).

**Why:** The reporter waits to see "report sent" before closing the
app; the responder waits for "new report" badge. Both audiences are
served by the same pipeline.

**Error budget:** 30s p95 / 90s p99 on a 28-day rolling window.

**Signal:**
- Submit timestamp: `Report.created_at` (server clock at meta POST).
- First-visible timestamp: `Report.sync_status='SYNCED' OR 'PARTIAL'`
  on the first dashboard list-poll AFTER the submit.
- Delta = first_visible − created_at.

**Note for HC91:** rows that hit `assembler_wedged` count as
**failed**, not as a latency miss — failure mode is "we gave up,"
not "we took too long."

**Alert:** Sentry alert if median submit-to-visible delta crosses
60s over any 1-hour window.

---

## 3. Client-side PII blur applied rate

**Target:** ≥ 95% of photo uploads carry `clientBlurApplied=true`
on the variant's upload metadata.

**Why:** UNDP must-have §2.9. Server-side blur is the safety net, but
the client flag tells UNDP reviewers we actually shipped the PII
protection we documented. Pre-HC89 this was near-zero on networks
where `cdn.jsdelivr.net` was unreachable; post-HC89 (vendored TF.js +
BlazeFace) it should be > 99% in steady state.

**Error budget:** ≤ 5% with `clientBlurApplied=false` over 28 days.
Permissible failure modes:
- Browser doesn't support `OffscreenCanvas` (very old Chrome / iOS).
- `tf.js` vendored bundle fails integrity check (network corruption
  on install).
- Worker exceeded memory limit and threw before blur ran.

**Signal:**
- Backend: every chunk POST carries `X-Client-Blur-Applied: 0|1`
  header (added by `pii-blur.js::blurFaces` truthful-flag plumbing).
- Backend access log + `Media.client_blur_applied` column.

**Recovery:** if dip > 5%, check Lighthouse `total-byte-weight`
budget warnings. A jsdelivr outage (CDN fallback path) won't show
here post-HC89; a vendored-bundle corruption WILL.

---

## 4. Assembly recovery — abandon-reason distribution

**Target:** ≤ 1% of `Media` rows reach a non-`complete` terminal
state (`assembly_status='failed' AND abandoned_at IS NOT NULL`) over
28 days.

**Breakdown (sub-target sums to 1%):**
- `chunks_never_arrived`  — ≤ 0.7% (mostly client-side: tab closed
  mid-upload, network timeout)
- `assembly_worker_lost`  — ≤ 0.2% (server-side: worker OOM /
  container restart)
- `assembler_wedged`      — ≤ 0.1% (HC91, post-Sprint 2B: should be
  very rare — a row past 60 min of repeated revival failure)

**Signal:**
- Prometheus / observability: `media_abandon_reason_total{reason="..."}`
  counter per-reason (already wired in `_run_assembly_recovery_sweep`
  for `assembly_worker_lost`, `chunks_never_arrived`, and now
  `assembler_wedged`).

**Alert:** Spike alert if `assembler_wedged` rate jumps ≥ 5×
its 7-day rolling baseline within a 1h window. Indicates a
pathological media id or a permanently-wedged assembly path that
needs operator triage.

---

## 5. Map tile error budget

**Target:** ≤ 5% map tile fetch errors over 7-day rolling window.

**Why:** The dashboard map (`web-dashboard/src/app.js:8469-8477`)
uses Carto's free tier (~75k tiles/day/IP). The PWA capture-flow map
uses OSM directly (~2 req/s rate limit). Hitting either limit makes
the map look broken to UNDP reviewers.

**Signal:**
- Browser-side: `fetch('https://basemaps.cartocdn.com/...')` non-2xx
  responses logged via Sentry breadcrumbs.
- Operator HAR captures (e.g. May 2026 HAR showed 41 × 400 on Carto).

**Recovery options (in priority order):**
1. Server-side tile proxy with in-memory LRU cache (largest impact;
   smooths the per-IP quota).
2. Paid Carto / MapTiler key (DSN in GH Secrets, injected via env).
3. Switch to Stadia Maps free tier (50k requests/day).

Not implemented in Sprint 2 — flagged as a Sprint 2C-3 follow-up.

---

## 6. Lighthouse PWA score floor

**Target:** keep the live thresholds in `lhci.config.cjs`:
- performance ≥ 0.45
- accessibility ≥ 0.90
- best-practices ≥ 0.85
- PWA ≥ 0.80
- CLS ≤ 0.25
- LCP ≤ 12,000 ms (Slow 4G mobile profile)
- TBT ≤ 1,500 ms
- (Sprint 1B-1) resource-summary:script:size ≤ 1.6 MB (warn — catches
  TF.js leaking into home-stage critical paint)

**Why:** UNDP rubric weights accessibility heavily; the performance
floor protects the 2 Kbps field-test scenario. Each floor was
ratcheted up after we'd been stable above it for ≥ 3 deploys.

**Signal:** every PR + every `workflow_dispatch` run of Lighthouse QA
publishes the 3-run median scores to `.lighthouseci/output/`.

**Recovery:** lighthouse-pr-comment.mjs threads the failure into the
PR comment with a diff against the lighthouse-history baseline.

---

## Out of scope (intentionally — not SLOs yet)

- p95 satellite verification turnaround (operator-tuned manually
  for now; no automation).
- Concurrent active reporters (no traffic in pilot to baseline).
- Per-region report volume (single-region pilot — no per-region
  variance to bound yet).

Revisit these once we have 2+ pilot locations live.

---

## SLO ratcheting policy

After each deploy + 7-day soak:
1. If the SLO has been comfortably met (≥ 1.5× target margin), the
   on-call may PROPOSE tightening it in a docs-only PR.
2. PR must cite the 28-day measured-vs-target ratio + the proposed
   new target.
3. Operator sign-off required before merge — never auto-ratchet.
4. Loosening is also allowed (e.g. if a new external dep adds latency
   we can't control), but requires a docs note explaining what
   changed in the system.
