from fastapi import APIRouter
from app.api.endpoints import reports, exports, auth, predictions, admin, integrations, analytics, modules, push, share, config, observability, appeals, devices, hot_regions, buildings

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(reports.router, prefix="/reports", tags=["reports"])
api_router.include_router(exports.router, prefix="/exports", tags=["exports"])
api_router.include_router(predictions.router, prefix="/predictions", tags=["predictions"])
# region auto-submit config.
# Public read at /api/v1/regions/enabled (cacheable, unauthenticated).
# Admin CRUD at /api/v1/admin/regions/* (JWT + require_admin).
api_router.include_router(admin.public_router, prefix="/regions", tags=["regions"])
api_router.include_router(admin.admin_router, prefix="/admin", tags=["admin"])
# UI v2.1 (W7) — UNDP RAPIDA integration stub. Server-to-server
# ingestion endpoint + JSON-Schema + field-mapping reference so UNOSAT
# / RAPIDA tooling can build adapters against a stable contract.
# ADMIN-gated; 300 events/min rate limit per auth subject.
api_router.include_router(integrations.router, prefix="/integrations", tags=["integrations"])
# UI v2.1 (W8) — precomputed analytics endpoints for the
# dashboard home tiles: top-10 crisis clusters in a lookback window
# + 24-bucket hourly damage-rate sparkline. Read-only, unauthenticated.
api_router.include_router(analytics.router, prefix="/analytics", tags=["analytics"])
# UI v2.1 (W6) — YAML-driven modular form framework. Operators
# drop a module file into `backend/app/modules/*.yaml` and capture
# clients render it without a code change. Public read; ADMIN endpoint
# for authoring can be added later.
api_router.include_router(modules.router, prefix="/modules", tags=["modules"])
# Web Push reporter feedback channel.
# Public: GET /api/v1/push/vapid-public (the VAPID public key, safe to expose).
# Public-ish: POST /api/v1/push/{subscribe,unsubscribe} — JWT optional,
# attaches user_id when present; anonymous reporters subscribe via
# device_hash only. The endpoint URL itself is the per-subscription
# secret (provider-issued, hard to guess).
api_router.include_router(push.router, prefix="/push", tags=["push"])
# Badge Studio share-page (Phase D.6 of swirling-forging-raccoon plan).
# Mints + serves signed share tokens used by LinkedIn's share dialog
# (which scrapes OG meta from a URL rather than accepting an image
# attachment). Public, no auth — the token signature is the only state.
api_router.include_router(share.router, prefix="", tags=["share"])
# Public deployment-config endpoint — small, cacheable, no auth.
# See backend/app/api/endpoints/config.py for what's exposed.
api_router.include_router(config.router, prefix="/config", tags=["config"])
# Admin observability for the Nearby Reports pipeline (Phase 2+).
# require_admin guard inside each endpoint. Phase 4 will add more.
api_router.include_router(observability.router,
                          prefix="/admin/observability",
                          tags=["observability"])
# Phase 4 (Nearby Pipeline §6.4) — admin moderation + appeal framework.
# CRISP hosts the core; deployment partners integrate via webhooks.
api_router.include_router(appeals.router,
                          prefix="/admin/appeals",
                          tags=["appeals"])
# Phase 5.1 (Nearby Pipeline §6.2) — auth-free device telemetry capture
# for real emulator fingerprinting. The Phase-5 scaffold detector
# falls back to its UA-substring check when no telemetry is posted.
api_router.include_router(devices.router,
                          prefix="/devices",
                          tags=["devices"])
# Phase 5.1 (Nearby Pipeline §9.5) — admin CRUD + refresh for
# materialised per-region /nearby snapshots. Read consumption is gated
# by CRISP_NEARBY_HOT_REGIONS=1; CRUD endpoints stay usable regardless
# so operators can seed regions before flipping the flag.
api_router.include_router(hot_regions.router,
                          prefix="/admin/nearby/hot-regions",
                          tags=["hot-regions"])
# Phase H.1.c (May 2026) — Building Intelligence & Response Coordination.
# First-class building entity (alembic 0028 + Building model + scoring
# hook in app/models/report.py). Read endpoints under /buildings/* serve
# the Building Intelligence Console; state-transition / monitor /
# responder / note / dossier / AI-summary endpoints land in H.2-H.6.
api_router.include_router(buildings.router,
                          prefix="/buildings",
                          tags=["buildings"])
