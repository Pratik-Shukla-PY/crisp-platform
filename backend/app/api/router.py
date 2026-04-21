from fastapi import APIRouter
from app.api.endpoints import reports, exports, auth, predictions, admin

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
