"""
CRISP — Observability plumbing (P3.7 + P3.8).

Three pieces:
  - Structured JSON logs via ``structlog`` so each record carries the request
    id, user id, and any contextual fields we add to the logger. Makes log
    aggregation (CloudWatch, Loki, Datadog) far more useful than the current
    plain-text format where fields are embedded in free-form strings.
  - Prometheus counters + histograms for the handful of SLIs we actually
    care about at this stage: request count by route/status, request latency,
    chunk uploads received, assembly worker queue depth, AI task duration.
  - Optional Sentry integration (enabled when ``SENTRY_DSN`` is set) so
    unhandled exceptions show up in a real error tracker instead of just
    the stderr of one container.

Both Prometheus and Sentry are optional — neither is required for the app to
boot. This file is safe to import before the FastAPI app instance exists.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from contextlib import contextmanager
from typing import Callable, Iterable

import structlog
from sqlalchemy import func as _sa_func
from prometheus_client import (
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
    CONTENT_TYPE_LATEST,
    REGISTRY,
)

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


# ── Structured logging ───────────────────────────────────────────────────────

_APP_ENV = os.getenv("APP_ENV", "production").lower()


def configure_structlog() -> None:
    """Set up structlog to emit JSON (prod) or human-friendly (dev) lines.

    structlog here wraps the stdlib ``logging`` module so every logger in
    the codebase gets the same formatting — no need to migrate callers.
    """
    shared_processors = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    renderer = (
        structlog.dev.ConsoleRenderer(colors=True)
        if _APP_ENV == "dev"
        else structlog.processors.JSONRenderer()
    )

    structlog.configure(
        processors=shared_processors + [renderer],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    # Re-route stdlib logging through the same renderer.
    formatter = structlog.stdlib.ProcessorFormatter(
        processor=renderer,
        foreign_pre_chain=shared_processors,
    )
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    root = logging.getLogger()
    # Avoid duplicating if already configured.
    if not any(isinstance(h, logging.StreamHandler) and getattr(h, "_crisp_struct", False) for h in root.handlers):
        handler._crisp_struct = True  # type: ignore[attr-defined]
        # Clear existing default stream handlers so we don't get duplicate lines.
        for h in list(root.handlers):
            if isinstance(h, logging.StreamHandler):
                root.removeHandler(h)
        root.addHandler(handler)
        root.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())


def get_logger(name: str | None = None) -> "structlog.stdlib.BoundLogger":
    return structlog.get_logger(name)


# ── Prometheus metrics ───────────────────────────────────────────────────────
#
# All metrics live on the default process-wide REGISTRY. `/metrics` exposes
# the current scrape-ready snapshot. Metric names follow Prometheus' own
# conventions (<subsystem>_<metric>_<unit>).

# HTTP
http_requests_total = Counter(
    "crisp_http_requests_total",
    "Count of HTTP requests, labelled by method, path template, status.",
    ["method", "path", "status"],
)
http_request_duration_seconds = Histogram(
    "crisp_http_request_duration_seconds",
    "Request latency in seconds.",
    ["method", "path"],
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
)

# Chunked upload pipeline
chunks_received_total = Counter(
    "crisp_chunks_received_total",
    "Media chunks received, labelled by media type.",
    ["type"],
)
chunks_rejected_total = Counter(
    "crisp_chunks_rejected_total",
    "Media chunks rejected (checksum mismatch, oversize, rate limit).",
    ["reason"],
)

# binary-chunk transport migration (Option A).
# Split by transport format so operators can watch the base64 → binary
# shift in real time and catch anomalous fall-back rates (binary → base64
# after a 404 on legacy backends). Intentionally a NEW counter rather than
# a new label on an existing one so no dashboard query breaks.
chunk_transport_total = Counter(
    "crisp_chunk_transport_total",
    "Chunk receive count labelled by transport format + outcome.",
    ["transport", "outcome"],  # transport ∈ {base64,binary}  outcome ∈ {accepted,rejected}
)

# server-side PII-blur visibility. Answers the operator
# question "are any reports reaching the dashboard with unblurred PII?"
# by surfacing the 'skipped' outcome separately from 'complete'. Skipped
# = both MediaPipe + easyocr unavailable on this deploy = images are
# on disk unblurred. Pairs with the GET /api/v1/health/pii endpoint.
pii_blur_runs_total = Counter(
    "crisp_pii_blur_runs_total",
    "Server-side PII blur runs labelled by outcome.",
    ["outcome"],  # outcome ∈ {complete, failed, skipped}
)
pii_blur_queue_depth = Gauge(
    "crisp_pii_blur_queue_depth",
    "Approximate depth of the _ai_executor's pending blur jobs.",
)

# Assembly + AI worker pools
assembly_jobs_total = Counter(
    "crisp_assembly_jobs_total",
    "Assembly jobs submitted.",
    ["type", "outcome"],
)
assembly_duration_seconds = Histogram(
    "crisp_assembly_duration_seconds",
    "End-to-end assembly time.",
    ["type"],
    buckets=(0.1, 0.5, 1, 2, 5, 10, 30, 60, 120),
)
ai_jobs_duration_seconds = Histogram(
    "crisp_ai_jobs_duration_seconds",
    "AI pipeline (PII blur / Whisper / vision) duration.",
    ["kind"],
    buckets=(0.5, 1, 2, 5, 10, 30, 60, 120, 300),
)
assembly_queue_depth = Gauge(
    "crisp_assembly_queue_depth",
    "Pending jobs in the assembly ThreadPoolExecutor (approximate).",
)

# Reports
reports_submitted_total = Counter(
    "crisp_reports_submitted_total",
    "Reports accepted by the backend, labelled by source channel.",
    ["source"],
)

# Guaranteed-delivery: per-variant upload + first-image SLIs.
# The SLO we promise operators is "responders see SOME image within 5 s on a
# 64 kbps link" — `crisp_time_to_first_image_seconds` is how we measure it.
# `crisp_time_to_full_image_seconds` tracks the time until LARGE lands, which
# is the quality-ceiling metric.
variant_uploads_total = Counter(
    "crisp_variant_uploads_total",
    "Photo variant deliveries, labelled by resolution tier + outcome.",
    ["tier", "outcome"],  # tier ∈ {LOW,MEDIUM,HIGH,ORIGINAL}, outcome ∈ {success,fail}
)
time_to_first_image_seconds = Histogram(
    "crisp_time_to_first_image_seconds",
    "Seconds from report creation → first complete photo variant of any tier.",
    buckets=(0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600),
)
time_to_full_image_seconds = Histogram(
    "crisp_time_to_full_image_seconds",
    "Seconds from report creation → LARGE variant complete.",
    buckets=(1, 5, 10, 30, 60, 120, 300, 600, 1800),
)
# Phase C.1 (May 2026) — whole-asset integrity. Counts assemblies that
# computed a djb2 over the concatenated file and found it different from
# the PWA-supplied checksum. Should always read 0 in steady state; any
# non-zero value indicates either (a) a real assembler regression
# (sort/decode/concat bug — the reason this metric exists) or (b) a
# storage-backend corruption between assembled bytes → persistent store.
media_asset_integrity_fail_total = Counter(
    "crisp_media_asset_integrity_fail_total",
    "Assemblies where the post-assembly djb2 didn't match the PWA-supplied "
    "whole-asset checksum. Should be 0 in healthy operation.",
    ["tier"],  # LOW | MEDIUM | HIGH | ORIGINAL — tier of the failed variant
)

# region auto-submit SLIs.
geofence_check_total = Counter(
    "crisp_geofence_check_total",
    "Result of a client-side geofence check at 'Start Report'.",
    ["result"],  # inside | outside | no_gps
)
auto_submit_count = Counter(
    "crisp_auto_submit_count",
    "Reports auto-submitted by the region timer, labelled by reason.",
    ["reason"],  # timeout | cancel | leave_zone
)

# reviewer verdict counter.
reports_reviewed_total = Counter(
    "crisp_reports_reviewed_total",
    "Reports moved through the analyst review flow.",
    ["verdict"],  # ACCEPTED | REJECTED
)


# ── Phase K K.6.c — submission-reliability SLIs ──────────────────────────────
#
# Four operator-facing gauges/counters that surface the failure modes
# the K.0 audit + K.5 dashboard chips made visible. Each metric has a
# corresponding chip in the dashboard's per-card chip row, so the
# alert rules in `monitoring/alerts.yml` should fire BEFORE the
# operator notices the chip pattern visually.
#
#   ① media_abandon_reason   — rate of media rows reaching the abandon
#       terminal state, labelled by reason. Drives the "20%+ of
#       uploads losing higher tiers" alert.
#   ② anon_due_expired_token — count of reports whose Bearer token
#       expired between capture + drain. Drives the "5%+ losing
#       attribution" alert. Confirms token TTL is appropriate for
#       field operations.
#   ③ partial_promote        — count of Action ④ idle-window
#       promotions. A sudden burst implies the network conditions
#       degraded (more soft-drained variants) — not a hot-path
#       failure, but visibility lets ops correlate with backlog.
#   ④ pii_blur_status        — count of Media rows by pii_blur_status,
#       sampled at ingest time. Distinct from `pii_blur_runs_total`
#       (which counts /run/ outcomes inside the AI executor); this
#       one is /persisted state/ via the /attach path. Operators
#       watch for an unexpected 'failed' bump.
media_abandon_reason_total = Counter(
    "crisp_media_abandon_reason_total",
    "Media rows entering the abandon terminal state, labelled by reason.",
    # reason ∈ {chunks_never_arrived, assembly_worker_lost,
    #           checksum_mismatch, bandwidth_tier_deferred,
    #           operator_manual}
    ["reason"],
)
report_submitted_anonymous_due_to_expired_token_total = Counter(
    "crisp_report_submitted_anonymous_due_to_expired_token_total",
    "Reports accepted with an expired Bearer token (anonymous downgrade). "
    "Operator burst signals reporter-side auth-TTL misconfig (K.2.e).",
)
partial_promote_total = Counter(
    "crisp_partial_promote_total",
    "Reports promoted PARTIAL → SYNCED by Action ④ of the assembly "
    "recovery sweep (bandwidth-tier soft-drain idle window).",
)
pii_blur_status_total = Counter(
    "crisp_pii_blur_status_total",
    "Per-Media-row pii_blur_status as set at /attach time. "
    "Distinct from `crisp_pii_blur_runs_total` which measures the "
    "AI-executor run outcome; this measures the persisted state.",
    # status ∈ {complete, failed, skipped, not_needed}
    ["status"],
)

# R2.c (May 2026) — recovery observability for the upload-recovery
# hardening (R1 + R2 + R3). Three signals:
#
#   ① media_recovery_total          — count of post-abandon recovery
#                                      outcomes. The success rate is
#                                      `succeeded / (succeeded + failed)`.
#   ② media_recovery_duration_      — wall-clock interval from
#      seconds                         abandoned_at to recovered_at.
#                                      Histogram buckets cover a few
#                                      minutes (typical reconnect)
#                                      through several days (long
#                                      offline gaps the operator wants
#                                      to honour).
#   ③ media_hard_deleted_total      — rows purged by daemon Action ⑥
#                                      past the hard-abandon retention
#                                      window. Operators alert on this
#                                      to track storage reclaim.
#
# Together with the existing `media_abandon_reason_total` the operator
# can compute the daemon's "false-abandon rate" — the fraction of
# rows the daemon abandoned that ended up recovered. A high
# false-abandon rate means the 30-minute deadline is too aggressive
# for the network conditions in the field.
media_recovery_total = Counter(
    "crisp_media_recovery_total",
    "Outcomes of post-abandon media recovery. R1 chunk-handler revival "
    "stamps recovered_at on the Media row when the assembly worker "
    "completes a previously-abandoned row.",
    # outcome ∈ {succeeded, failed}
    ["outcome"],
)
media_recovery_duration_seconds = Histogram(
    "crisp_media_recovery_duration_seconds",
    "Wall-clock interval from abandoned_at to recovered_at on a "
    "successfully-recovered Media row. Used to tune the daemon's "
    "30-minute soft-abandon deadline (_ABANDON_STALE_MIN).",
    buckets=(60.0, 300.0, 900.0, 1800.0, 3600.0, 14_400.0, 43_200.0,
             86_400.0, 172_800.0, 604_800.0),
)
media_hard_deleted_total = Counter(
    "crisp_media_hard_deleted_total",
    "Media rows purged by daemon Action ⑥ past CRISP_HARD_ABANDON_DAYS "
    "(default 30 days). Operators alert on a sustained non-zero rate "
    "to track storage reclaim against the abandoned-uploads backlog.",
    # reason ∈ {chunks_never_arrived, assembly_worker_lost,
    #           checksum_mismatch, bandwidth_tier_deferred, ...}
    ["reason"],
)
# R3.b — disk-orphan GC counter. See daemon Action ⑦.
disk_orphan_deleted_total = Counter(
    "crisp_disk_orphan_deleted_total",
    "Storage objects deleted by daemon Action ⑦ because no live "
    "Media.url references them and the object is older than the "
    "hard-abandon retention window.",
    # prefix ∈ {uploads, pre_blur, ...}
    ["prefix"],
)

# L5 (May 2026, blur-audit) — face-detection rejection counter.
# Increments each time a BlazeFace candidate box is rejected by the
# L1+L2+L4 stack before NMS / blur application. Operators watch this
# to:
#   - Verify the false-positive killer is firing (counter > 0 on
#     real-world traffic confirms FPs were being detected pre-fix)
#   - Calibrate the thresholds against ground-truth: if recall drops
#     after a tuning change, look for spikes here
#   - Spot a misconfigured field deployment (e.g. CRISP_MIN_FACE_FRAC
#     set too aggressively → mass rejections)
#
# Labels:
#   - layer ∈ {L1_confidence, L2_min_size, L4_skin_tone}
#   - tier  ∈ {SMALL, MEDIUM, ORIGINAL, UNKNOWN}
blur_candidate_rejected_total = Counter(
    "crisp_blur_candidate_rejected_total",
    "BlazeFace candidate boxes rejected before blur application, "
    "labelled by the gate layer that dropped them. Used by operators "
    "to verify the L1+L2+L4 false-positive killers are firing.",
    ["layer", "tier"],
)

# K.6.b — AI retry queue depth. Two gauges: total pending rows + a
# breakdown by status (pending|in_progress|complete|terminal_failed)
# so operators can see backlog trends without inspecting the DB.
ai_retry_queue_depth = Gauge(
    "crisp_ai_retry_queue_depth",
    "Rows in ai_retry_queue grouped by status (snapshot at scrape).",
    ["status"],
)


# ── Middleware wiring ────────────────────────────────────────────────────────


class PrometheusRequestMiddleware(BaseHTTPMiddleware):
    """Counts each HTTP request into `http_requests_total` and records
    latency in `http_request_duration_seconds`. Also stamps a `request_id`
    on structlog's context so every log line inside the request carries it.
    """

    async def dispatch(self, request: Request, call_next: Callable):  # type: ignore[override]
        start = time.perf_counter()
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            request_id=rid,
            method=request.method,
            path=request.url.path,
        )
        try:
            response = await call_next(request)
        except Exception:
            # Let the global handler finish formatting — but still record the
            # 500 in metrics.
            elapsed = time.perf_counter() - start
            path_template = _path_template(request)
            http_requests_total.labels(request.method, path_template, "500").inc()
            http_request_duration_seconds.labels(request.method, path_template).observe(elapsed)
            raise

        elapsed = time.perf_counter() - start
        path_template = _path_template(request)
        http_requests_total.labels(request.method, path_template, str(response.status_code)).inc()
        http_request_duration_seconds.labels(request.method, path_template).observe(elapsed)
        response.headers.setdefault("X-Request-ID", rid)
        return response


def _path_template(request: Request) -> str:
    """Return the matched route template (e.g. /reports/{id}/media/chunk)
    so metrics don't cardinality-explode on UUIDs. Falls back to raw path.
    """
    route = request.scope.get("route")
    if route is not None and getattr(route, "path", None):
        return route.path
    return request.url.path


def _sample_ai_retry_queue_gauge() -> None:
    """K.6.c — refresh the ai_retry_queue depth gauge from the DB
    at scrape time. Pulled into a try/except so a transient DB
    blip never breaks /metrics.

    Cheap query (indexed by status); even at 10K queue rows this
    is sub-millisecond on Postgres. Skipped during pytest because
    the test DB lifecycle wipes the table between runs.
    """
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    try:
        from app.db.session import SessionLocal
        from app.models.report import AiRetryQueueRow
        db = SessionLocal()
        try:
            rows = (
                db.query(AiRetryQueueRow.status, _sa_func.count())
                .group_by(AiRetryQueueRow.status)
                .all()
            )
            seen = set()
            for status_val, count in rows:
                ai_retry_queue_depth.labels(status=str(status_val)).set(float(count))
                seen.add(str(status_val))
            # Zero out any previously-non-empty status that no longer
            # has rows, so a transient backlog doesn't leave a stale
            # gauge reading after the rows complete + age out.
            for s in ("pending", "in_progress", "complete", "terminal_failed"):
                if s not in seen:
                    ai_retry_queue_depth.labels(status=s).set(0.0)
        finally:
            db.close()
    except Exception as e:
        logging.getLogger(__name__).debug(
            "ai_retry_queue gauge sample failed: %s", e,
        )


def metrics_response() -> Response:
    """Plain-text metrics suitable for a Prometheus scrape."""
    _sample_ai_retry_queue_gauge()
    data = generate_latest(REGISTRY)
    return Response(content=data, media_type=CONTENT_TYPE_LATEST)


# ── Sentry (P3.8) ────────────────────────────────────────────────────────────


def init_sentry() -> bool:
    """Initialise Sentry when SENTRY_DSN is set. Returns True if active."""
    dsn = os.getenv("SENTRY_DSN", "").strip()
    if not dsn:
        return False
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration

        sentry_sdk.init(
            dsn=dsn,
            environment=_APP_ENV,
            release=os.getenv("CRISP_RELEASE", "dev"),
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.05")),
            send_default_pii=False,    # crisis data — never forward PII
            max_breadcrumbs=30,
            integrations=[FastApiIntegration(), StarletteIntegration()],
        )
        return True
    except Exception as exc:  # noqa: BLE001 — sentry init must never crash the app
        logging.getLogger(__name__).warning("Sentry init failed: %s", exc)
        return False


@contextmanager
def timed(histogram: Histogram, **labels: str) -> Iterable[None]:
    """Helper — `with timed(ai_jobs_duration_seconds, kind='blur'): ...`."""
    start = time.perf_counter()
    try:
        yield
    finally:
        histogram.labels(**labels).observe(time.perf_counter() - start)
