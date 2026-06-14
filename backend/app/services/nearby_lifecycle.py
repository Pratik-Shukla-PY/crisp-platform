"""
nearby_lifecycle - transition detector + event emitter for the
Nearby Reports pipeline.

Phase 2 (May 2026, docs §3.7) adds lifecycle tracking on top of the
Phase 1 aggregator. Each call to `/api/v1/reports/nearby` produces a
fresh aggregation; this module compares the fresh aggregation against
the prior cached aggregation for the same cache key and emits a
NearbyGroupEvent row for each transition observed:

  • promote   - group's tier moved up (weak → emerging → verified)
  • downgrade - group's tier moved down
  • acute_on  - group flipped is_acute=false → true
  • acute_off - group flipped is_acute=true → false
  • fading    - group's count dropped + no recent activity
  • resolved  - group reached kind='resolved_recent' (a closure)
  • created   - a new group_id appeared this poll
  • removed   - a previously-present group_id disappeared

Why diff-based detection instead of in-aggregation hooks: the
aggregator is a pure function and we want to keep it that way.
Persistence + side effects live in this module + are called from
the endpoint AFTER the response is computed.

The detector does NOT block the response - it's called from a
post-response hook so a slow DB write can't delay the user's
request. Phase 3 may move this into a background worker once trust
scoring (Phase 3) adds enough additional state.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable, List, Optional, Sequence

from sqlalchemy.orm import Session

from app.models.report import NearbyGroupEvent
from app.services.nearby_aggregator import NearbyGroup


log = logging.getLogger(__name__)


# ── Event-kind vocabulary ───────────────────────────────────────────

class GroupEventKind:
    CREATED   = "created"
    REMOVED   = "removed"
    PROMOTE   = "promote"
    DOWNGRADE = "downgrade"
    ACUTE_ON  = "acute_on"
    ACUTE_OFF = "acute_off"
    FADING    = "fading"
    RESOLVED  = "resolved"
    MERGE     = "merge"      # Phase 2.5+ - reserved
    SPLIT     = "split"      # Phase 2.5+ - reserved


_TIER_RANK = {"weak": 1, "emerging": 2, "verified": 3}


def _tier_diff(from_tier: Optional[str], to_tier: Optional[str]) -> int:
    """Return >0 if to is higher than from, <0 if lower, 0 if same/unknown."""
    if from_tier is None or to_tier is None:
        return 0
    return _TIER_RANK.get(to_tier, 0) - _TIER_RANK.get(from_tier, 0)


def diff_groups(
    *,
    prior: Sequence[NearbyGroup],
    current: Sequence[NearbyGroup],
) -> List[dict]:
    """Pure diff. Returns a list of {group_id, event_kind, from_*,
    to_*, payload} dicts ready to materialise as NearbyGroupEvent
    rows. Pure function - no DB, no side effects."""
    prior_by_id = {g.id: g for g in prior}
    current_by_id = {g.id: g for g in current}
    events: List[dict] = []

    # CREATED - groups that appeared this poll.
    for gid in current_by_id.keys() - prior_by_id.keys():
        g = current_by_id[gid]
        events.append({
            "group_id": gid,
            "event_kind": GroupEventKind.CREATED,
            "from_tier": None,
            "to_tier": g.tier,
            "from_count": None,
            "to_count": g.count,
            "payload": {"kind": g.kind, "is_acute": g.is_acute},
        })

    # REMOVED - groups that vanished this poll.
    for gid in prior_by_id.keys() - current_by_id.keys():
        g_prior = prior_by_id[gid]
        events.append({
            "group_id": gid,
            "event_kind": GroupEventKind.REMOVED,
            "from_tier": g_prior.tier,
            "to_tier": None,
            "from_count": g_prior.count,
            "to_count": None,
            "payload": {"kind": g_prior.kind},
        })

    # Transitions on groups present in BOTH polls.
    for gid in current_by_id.keys() & prior_by_id.keys():
        g_from = prior_by_id[gid]
        g_to = current_by_id[gid]

        # Tier moves
        delta = _tier_diff(g_from.tier, g_to.tier)
        if delta > 0:
            events.append({
                "group_id": gid,
                "event_kind": GroupEventKind.PROMOTE,
                "from_tier": g_from.tier, "to_tier": g_to.tier,
                "from_count": g_from.count, "to_count": g_to.count,
                "payload": {},
            })
        elif delta < 0:
            events.append({
                "group_id": gid,
                "event_kind": GroupEventKind.DOWNGRADE,
                "from_tier": g_from.tier, "to_tier": g_to.tier,
                "from_count": g_from.count, "to_count": g_to.count,
                "payload": {},
            })

        # Acute on/off
        if g_to.is_acute and not g_from.is_acute:
            events.append({
                "group_id": gid,
                "event_kind": GroupEventKind.ACUTE_ON,
                "from_tier": g_from.tier, "to_tier": g_to.tier,
                "from_count": g_from.count, "to_count": g_to.count,
                "payload": {"acute_grade": g_to.acute_grade},
            })
        elif g_from.is_acute and not g_to.is_acute:
            events.append({
                "group_id": gid,
                "event_kind": GroupEventKind.ACUTE_OFF,
                "from_tier": g_from.tier, "to_tier": g_to.tier,
                "from_count": g_from.count, "to_count": g_to.count,
                "payload": {},
            })

        # Resolved kind transition
        if g_to.kind == "resolved_recent" and g_from.kind != "resolved_recent":
            events.append({
                "group_id": gid,
                "event_kind": GroupEventKind.RESOLVED,
                "from_tier": g_from.tier, "to_tier": g_to.tier,
                "from_count": g_from.count, "to_count": g_to.count,
                "payload": {"prior_kind": g_from.kind},
            })

        # Fading - count dropped + no burst + not acute
        if (g_to.count < g_from.count and
                not g_to.is_burst and not g_to.is_acute):
            events.append({
                "group_id": gid,
                "event_kind": GroupEventKind.FADING,
                "from_tier": g_from.tier, "to_tier": g_to.tier,
                "from_count": g_from.count, "to_count": g_to.count,
                "payload": {},
            })

    return events


def persist_events(db: Session, events: Iterable[dict]) -> int:
    """Write events to the DB. Returns the number of rows inserted.

    Best-effort - errors are logged and swallowed so a DB write
    failure can never poison a user-facing nearby response.
    """
    n = 0
    try:
        now = datetime.now(timezone.utc)
        for e in events:
            db.add(NearbyGroupEvent(
                id=str(uuid.uuid4()),
                group_id=e["group_id"],
                event_kind=e["event_kind"],
                from_tier=e.get("from_tier"),
                to_tier=e.get("to_tier"),
                from_count=e.get("from_count"),
                to_count=e.get("to_count"),
                payload=e.get("payload") or {},
                occurred_at=now,
            ))
            n += 1
        if n:
            db.commit()
    except Exception:                            # pragma: no cover
        log.exception("[nearby_lifecycle] failed to persist events; rolling back")
        try:
            db.rollback()
        except Exception:
            pass
    return n


def detect_and_persist(
    db: Session,
    *,
    prior_groups: Sequence[NearbyGroup],
    current_groups: Sequence[NearbyGroup],
) -> int:
    """Diff + persist in one call. Convenience for the endpoint."""
    events = diff_groups(prior=prior_groups, current=current_groups)
    if not events:
        return 0
    return persist_events(db, events)
