from fastapi import APIRouter
from app.api.endpoints import reports, exports, auth, predictions

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(reports.router, prefix="/reports", tags=["reports"])
api_router.include_router(exports.router, prefix="/exports", tags=["exports"])
api_router.include_router(predictions.router, prefix="/predictions", tags=["predictions"])
