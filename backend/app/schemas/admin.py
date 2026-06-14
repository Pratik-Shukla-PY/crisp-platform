"""
CRISP - Admin schemas.

Reviewer-workflow patches. Kept separate from `report.py` so the admin
surface doesn't leak into client-facing payloads.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


# ── Reviewer workflow ─────────────────────────────────────────────

class ReviewPatch(BaseModel):
    """Analyst's accept/reject verdict. action_taken required when REJECTED
    so the reviewer always records a reason - enforced at endpoint level."""
    verdict: str = Field(pattern=r"^(ACCEPTED|REJECTED|NOT_REVIEWED)$")
    action_taken: Optional[str] = Field(default=None, max_length=500)


class TimestampPatch(BaseModel):
    """Responder-timestamp updates. Either or both timestamps may be set in
    a single call; server stamps the current UTC time when the caller
    omits an explicit value (common case: admin clicks "Mark Dispatched")."""
    help_dispatched_at: Optional[datetime] = None
    help_arrived_at: Optional[datetime] = None
    stamp_dispatched_now: bool = False
    stamp_arrived_now: bool = False
