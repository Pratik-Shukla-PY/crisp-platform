"""
fraud_detector — synchronous abuse-signal detection for the Nearby
Reports pipeline.

Phase 3 (May 2026, docs/NEARBY_REPORTS_PIPELINE.md §6.2) implements
the THREE hot signals — the ones cheap enough to run inline with
every report submission:

  • GPS spoofing       — many distinct device hashes report identical
                         coords (≤ 5 m) within 60 s
  • Impossible movement — same device_hash reports from coords > 10 km
                         apart within 30 s
  • Rate-limit burst   — single device submits ≥ 5 reports in 60 s

Heavier signals (emulator fingerprinting, narrative-similarity
hashing, cross-device coordination) are deferred to Phase 5's async
batch worker — too expensive for the request-blocking hot path.

How it integrates:
  • Called from the report-submission endpoints (POST /reports/meta
    + report-update paths) right BEFORE the report is committed.
  • Bumps `devices.spam_score` and appends to `devices.spam_signals`
    when a signal fires. Doesn't BLOCK the request — the report is
    still accepted; the signal just downgrades the device's future
    contribution weight in `aggregate_nearby` (docs §6.1).
  • Hard signals (the "weight → 0" cases per §6.3) are NOT enforced
    here — they're enforced in the aggregator at read time so a
    later state change can reinstate a device without re-writing
    history.

All detection is best-effort: if the DB query fails or the signals
table is unreachable, the function logs + returns empty. A spam
detector must NEVER take down a real user's submission path.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.report import Device, Location, Report


log = logging.getLogger(__name__)


# ── Constants (Phase 3 — docs §6.2) ─────────────────────────────────

#: Two reports from DIFFERENT devices at coords within this many
#: METRES, within `GPS_SPOOF_WINDOW_SEC` seconds → GPS spoof
#: signal.
GPS_SPOOF_RADIUS_M = 5.0
GPS_SPOOF_WINDOW_SEC = 60
GPS_SPOOF_DISTINCT_DEVICES = 3

#: Same device reporting from coords > this many METRES apart within
#: `IMPOSSIBLE_MOVE_WINDOW_SEC` seconds → impossible movement.
#: 10 km in 30 s would require 1 200 km/h — faster than a passenger
#: jet — clear GPS-jitter or spoofing.
IMPOSSIBLE_MOVE_DISTANCE_M = 10_000.0
IMPOSSIBLE_MOVE_WINDOW_SEC = 30

#: Single device submits ≥ this many reports in `RATE_BURST_WINDOW_SEC`
#: seconds → rate-limit burst.
RATE_BURST_THRESHOLD = 5
RATE_BURST_WINDOW_SEC = 60

#: How much each hot signal adds to `devices.spam_score`. The
#: aggregator drops contribution to 0.0 once `spam_score >= 1.0`
#: (docs §6.1 — "suspicious"). One rate burst alone reaches the
#: threshold; impossible movement + GPS spoof get larger weights
#: to flag bot infrastructure faster.
SIGNAL_WEIGHTS = {
    "gps_spoof":          0.8,
    "impossible_movement": 1.0,
    "rate_burst":         1.0,
}

#: Signal weight above which the device is considered "suspicious"
#: by `device_trust_weight()` and drops to contribution = 0.0.
SUSPICIOUS_SCORE_FLOOR = 1.0


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Haversine in METRES — cheaper to keep separate from the km
    helper in nearby_aggregator."""
    import math
    R = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


# ── Detectors ───────────────────────────────────────────────────────

def _detect_gps_spoof(
    db: Session, *, lat: float, lng: float, ts: datetime,
    own_device_id: Optional[str] = None,
) -> bool:
    """Are there ≥ GPS_SPOOF_DISTINCT_DEVICES reports from DIFFERENT
    devices at this same (lat, lng) within GPS_SPOOF_WINDOW_SEC of
    `ts`? Suggestive of GPS spoofing or coordinated farming."""
    cutoff = ts - timedelta(seconds=GPS_SPOOF_WINDOW_SEC)
    # Loose bbox so the DB can use the (lat, lng) index, then
    # haversine-filter the candidates.
    delta_lat = GPS_SPOOF_RADIUS_M / 111_000.0  # ~9e-5 deg
    rows = (
        db.query(Report.device_id, Location.latitude, Location.longitude)
          .join(Location, Location.report_id == Report.id)
          .filter(Report.server_created_at >= cutoff)
          .filter(Report.server_created_at <= ts + timedelta(seconds=1))
          .filter(Location.latitude.between(lat - delta_lat, lat + delta_lat))
          .filter(Location.longitude.between(lng - delta_lat, lng + delta_lat))
          .all()
    )
    distinct_devices = {
        did for did, rlat, rlng in rows
        if did and did != own_device_id
        and _haversine_m(lat, lng, rlat, rlng) <= GPS_SPOOF_RADIUS_M
    }
    return len(distinct_devices) >= (GPS_SPOOF_DISTINCT_DEVICES - 1)


def _detect_impossible_movement(
    db: Session, *, device_id: str, lat: float, lng: float, ts: datetime,
) -> bool:
    """Has this device reported from coords > 10 km away in the past
    30 s? Physically impossible → spoof / emulator."""
    cutoff = ts - timedelta(seconds=IMPOSSIBLE_MOVE_WINDOW_SEC)
    rows = (
        db.query(Location.latitude, Location.longitude, Report.server_created_at)
          .join(Report, Report.id == Location.report_id)
          .filter(Report.device_id == device_id)
          .filter(Report.server_created_at >= cutoff)
          .filter(Report.server_created_at <= ts)
          .all()
    )
    for rlat, rlng, _ in rows:
        if _haversine_m(lat, lng, rlat, rlng) > IMPOSSIBLE_MOVE_DISTANCE_M:
            return True
    return False


def _detect_rate_burst(
    db: Session, *, device_id: str, ts: datetime,
) -> bool:
    """Did this device submit ≥ RATE_BURST_THRESHOLD reports in the
    past RATE_BURST_WINDOW_SEC seconds?"""
    cutoff = ts - timedelta(seconds=RATE_BURST_WINDOW_SEC)
    count = (
        db.query(Report.id)
          .filter(Report.device_id == device_id)
          .filter(Report.server_created_at >= cutoff)
          .filter(Report.server_created_at <= ts)
          .count()
    )
    return count >= RATE_BURST_THRESHOLD


# ── Public entry point ──────────────────────────────────────────────

def evaluate_submission(
    db: Session, *, device_id: Optional[str],
    lat: float, lng: float,
    ts: Optional[datetime] = None,
) -> List[str]:
    """Run all 3 hot signals against an incoming submission and bump
    the device's spam_score + spam_signals accordingly.

    Returns the list of signal-type strings that fired (for logging /
    return-to-caller). Never raises.

    The report itself is NOT blocked here — the aggregator handles
    the privacy-protected suppression at READ time, so a late
    reinstatement (admin clears spam_score) takes effect on the
    next poll without rewriting history.
    """
    if not device_id:
        return []
    try:
        ts = ts or datetime.now(timezone.utc)
        fired: List[str] = []
        if _detect_gps_spoof(db, lat=lat, lng=lng, ts=ts, own_device_id=device_id):
            fired.append("gps_spoof")
        if _detect_impossible_movement(db, device_id=device_id, lat=lat, lng=lng, ts=ts):
            fired.append("impossible_movement")
        if _detect_rate_burst(db, device_id=device_id, ts=ts):
            fired.append("rate_burst")

        if fired:
            dev = db.query(Device).filter(Device.id == device_id).first()
            if dev is not None:
                # Bump spam_score by the union of signal weights;
                # union (max), not sum, so two distinct hot signals
                # don't double-penalise.
                bump = max(SIGNAL_WEIGHTS.get(s, 0.0) for s in fired)
                dev.spam_score = float(dev.spam_score or 0.0) + bump
                existing_signals = list(dev.spam_signals or [])
                for s in fired:
                    if s not in existing_signals:
                        existing_signals.append(s)
                dev.spam_signals = existing_signals
                db.flush()
        return fired
    except Exception:                              # pragma: no cover
        log.exception("[fraud_detector] failed; signals not applied")
        return []


def increment_reports_count(db: Session, device_id: Optional[str]) -> None:
    """Bump devices.reports_count by 1. Called sync from the report-
    insert path so the "trusted anonymous" tier (reports_count ≥ 5,
    spam_score == 0) is always fresh.

    Best-effort; errors are logged + swallowed so a report can never
    fail because the trust counter update failed."""
    if not device_id:
        return
    try:
        dev = db.query(Device).filter(Device.id == device_id).first()
        if dev is not None:
            dev.reports_count = (dev.reports_count or 0) + 1
            db.flush()
    except Exception:                              # pragma: no cover
        log.exception("[fraud_detector] reports_count bump failed")


# ── Aggregator-side lookup ──────────────────────────────────────────

def device_trust_weight(device: Optional[Device]) -> float:
    """Return the contribution-weight for a device given its trust
    columns. Used by `aggregate_nearby` to weight the per-device
    contribution to a group's effective sort-score (docs §6.1).

    Tier weights:
      • Suspicious (spam_score >= 1.0)         → 0.0  (drop)
      • Trusted anonymous (clean + ≥ 5 prior)  → 1.2
      • New device or unauthenticated          → 1.0

    The "verified responder" (3.0) and "account-linked civilian"
    (1.5) tiers from docs §6.1 are driven by JWT context, NOT the
    device row — they're applied in the aggregator's caller, not
    here. This helper covers the DEVICE-only tiers.
    """
    if device is None:
        return 1.0
    if float(device.spam_score or 0.0) >= SUSPICIOUS_SCORE_FLOOR:
        return 0.0
    if (device.reports_count or 0) >= 5 and float(device.spam_score or 0.0) == 0.0:
        return 1.2
    return 1.0
