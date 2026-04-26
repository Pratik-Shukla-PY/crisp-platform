from fastapi import APIRouter
from app.api.endpoints import reports, exports, auth, predictions, admin, integrations, analytics, modules, push

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(reports.router, prefix="/reports", tags=["reports"])
api_router.include_router(exports.router, prefix="/exports", tags=["exports"])
api_router.include_router(predictions.router, prefix="/predictions", tags=["predictions"])
# Phase 4 (Apr 2026) — region auto-submit config.
# Public read at /api/v1/regions/enabled (cacheable, unauthenticated).
# Admin CRUD at /api/v1/admin/regions/* (JWT + require_admin).
api_router.include_router(admin.public_router, prefix="/regions", tags=["regions"])
api_router.include_router(admin.admin_router, prefix="/admin", tags=["admin"])
# Apr 2026 UI v2.1 (W7) — UNDP RAPIDA integration stub. Server-to-server
# ingestion endpoint + JSON-Schema + field-mapping reference so UNOSAT
# / RAPIDA tooling can build adapters against a stable contract.
# ADMIN-gated; 300 events/min rate limit per auth subject.
api_router.include_router(integrations.router, prefix="/integrations", tags=["integrations"])
# Apr 2026 UI v2.1 (W8) — precomputed analytics endpoints for the
# dashboard home tiles: top-10 crisis clusters in a lookback window
# + 24-bucket hourly damage-rate sparkline. Read-only, unauthenticated.
api_router.include_router(analytics.router, prefix="/analytics", tags=["analytics"])
# Apr 2026 UI v2.1 (W6) — YAML-driven modular form framework. Operators
# drop a module file into `backend/app/modules/*.yaml` and capture
# clients render it without a code change. Public read; ADMIN endpoint
# for authoring can be added later.
api_router.include_router(modules.router, prefix="/modules", tags=["modules"])
# Apr 2026 — Web Push reporter feedback channel.
# Public: GET /api/v1/push/vapid-public (the VAPID public key, safe to expose).
# Public-ish: POST /api/v1/push/{subscribe,unsubscribe} — JWT optional,
# attaches user_id when present; anonymous reporters subscribe via
# device_hash only. The endpoint URL itself is the per-subscription
# secret (provider-issued, hard to guess).
api_router.include_router(push.router, prefix="/push", tags=["push"])
