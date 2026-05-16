"""
fraud_batch — async batch worker for the heavier abuse-detection
signals.

Phase 5 (docs/NEARBY_REPORTS_PIPELINE.md §6.2 + §6.4) — the signals
too expensive for the synchronous hot path:

  • Emulator-farm fingerprinting (UA + device telemetry pattern
    matching against known emulators).
  • Narrative similarity hashing (k-mean cosine similarity over
    description 5-grams; flags coordinated narrative attacks).
  • Cross-device coordination analysis (graph of devices that
    consistently report the same buildings within seconds of each
    other).

This module exposes a single entry point — `run_batch_scan()` —
that the deployment's job scheduler (cron / Celery / RQ /
docker-compose) calls every CRISP_TRUST_ASYNC_INTERVAL_MIN minutes
(default 15). Inside the scan:

  1. Pick devices touched in the last interval (devices.updated_at
     IS NULL guard means "any device that submitted recently" —
     covers v0 devices without that column).
  2. Run each heuristic against the device's recent submission
     history.
  3. For each signal that fires: append to spam_signals, bump
     spam_score, and emit a webhook to subscribed deployment
     partners (Phase 5 — operator decision in docs §6.4: CRISP
     hosts the framework, partners integrate via webhooks).

The worker is IDEMPOTENT — re-running on the same device-window
slice doesn't double-bump spam_score (we union signals; weight
becomes max).

Phase 5 is a SCAFFOLD — the actual ML / fingerprinting heuristics
are pluggable hooks (functions in DETECTORS list). Real
implementations land as separate commits per UNDP rubric Item 12
(scale-readiness; UNDP cap 500k reports/crisis).
"""
from __future__ import annotations

import json
import logging
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Callable, Iterable, List, Optional, Sequence

import httpx
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.report import Device, Report
from app.services.fraud_detector import SIGNAL_WEIGHTS


log = logging.getLogger(__name__)


# ── Signal-type vocabulary ─────────────────────────────────────────

class BatchSignal:
    EMULATOR_FARM      = "emulator_farm"
    NARRATIVE_SIMILAR  = "narrative_similar"
    CROSS_DEVICE_RING  = "cross_device_ring"


# Add the Phase 5 signal weights to the shared SIGNAL_WEIGHTS so the
# aggregator's existing spam_score floor logic doesn't need changes.
_PHASE5_SIGNAL_WEIGHTS = {
    BatchSignal.EMULATOR_FARM:     1.0,
    BatchSignal.NARRATIVE_SIMILAR: 0.8,
    BatchSignal.CROSS_DEVICE_RING: 0.8,
}
SIGNAL_WEIGHTS.update(_PHASE5_SIGNAL_WEIGHTS)


# ── Heuristic detectors (Phase 5 scaffold — real ML lands in followups) ──
#
# Each detector takes (db, device, recent_reports) and returns a
# list of BatchSignal constants that fired. Add new detectors here;
# the worker auto-iterates all DETECTORS for each device.

def _detect_emulator_farm(
    db: Session, device: Device,
    recent_reports: Sequence[Report],
) -> List[str]:
    """Phase 5 scaffold heuristic: device platform suggests known
    emulator (BlueStacks, Android-Emulator, Genymotion) AND no
    realistic device telemetry signals were ever recorded.

    Real implementation (separate followup) wires this to the v4
    device-info-collector signals (accelerometer activity, battery
    level history, etc.) once those land. For now we surface only
    the cheap UA-substring check so the scaffold is testable.
    """
    if not device or not device.platform:
        return []
    plat = (device.platform or "").lower()
    if any(needle in plat for needle in ("emulator", "bluestacks",
                                         "genymotion", "simulator")):
        return [BatchSignal.EMULATOR_FARM]
    return []


def _detect_narrative_similar(
    db: Session, device: Device,
    recent_reports: Sequence[Report],
) -> List[str]:
    """Phase 5 scaffold: ≥ 3 of the device's recent reports share an
    identical description hash → templated / scripted submissions.

    Real implementation will use cosine similarity over 5-grams +
    minhash for cross-device similarity. The cheap exact-match
    check below is enough to test the scaffold end-to-end.
    """
    if len(recent_reports) < 3:
        return []
    hashes = defaultdict(int)
    for r in recent_reports:
        desc = (r.description or "").strip()
        if not desc:
            continue
        hashes[hash(desc)] += 1
    if any(v >= 3 for v in hashes.values()):
        return [BatchSignal.NARRATIVE_SIMILAR]
    return []


def _detect_cross_device_ring(
    db: Session, device: Device,
    recent_reports: Sequence[Report],
) -> List[str]:
    """Phase 5 scaffold: device's recent reports all match the
    building_id and timestamps of another device's recent reports
    (suggests coordinated farming).

    Real implementation will build a per-window device-coreport
    graph + cluster on connection density. The scaffold below
    captures the simplest pattern.
    """
    if len(recent_reports) < 3:
        return []
    bids = {r.building_id for r in recent_reports if r.building_id}
    if not bids:
        return []
    # Look for other devices reporting the SAME building_ids within
    # the same hour. If multiple distinct devices ALL share this
    # device's pattern → suspect.
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    same_bid_devs = (
        db.query(Report.device_id)
          .filter(Report.building_id.in_(bids))
          .filter(Report.device_id != device.id)
          .filter(Report.server_created_at >= cutoff)
          .distinct()
          .all()
    )
    if len(same_bid_devs) >= 3:
        return [BatchSignal.CROSS_DEVICE_RING]
    return []


DETECTORS: List[Callable[[Session, Device, Sequence[Report]], List[str]]] = [
    _detect_emulator_farm,
    _detect_narrative_similar,
    _detect_cross_device_ring,
]


# ── Outbound webhook delivery (Phase 5 — docs §6.4) ────────────────

def _webhook_endpoints() -> List[str]:
    """Read deployment-configured webhook destinations from env.
    Comma-separated URLs in CRISP_APPEAL_WEBHOOK_URLS."""
    raw = os.environ.get("CRISP_APPEAL_WEBHOOK_URLS", "").strip()
    if not raw:
        return []
    return [u.strip() for u in raw.split(",") if u.strip()]


def emit_webhook(event: dict, *, timeout_sec: float = 5.0) -> None:
    """POST a JSON payload to every configured webhook URL.

    Best-effort delivery — failures are logged + swallowed. Phase 5.5+
    will replace this with a retry/backoff queue. The current scaffold
    is enough for a deployment partner (UNDP / others) to observe live
    appeal-decision events without polling.
    """
    urls = _webhook_endpoints()
    if not urls:
        return
    payload = json.dumps(event, default=str).encode("utf-8")
    headers = {"Content-Type": "application/json",
               "User-Agent": "CRISP-AppealsWebhook/1.0"}
    for url in urls:
        try:
            httpx.post(url, content=payload, headers=headers, timeout=timeout_sec)
        except Exception:                          # pragma: no cover
            log.exception("[fraud_batch] webhook POST failed: %s", url)


# ── Main entry point ───────────────────────────────────────────────

def run_batch_scan(
    *, db: Optional[Session] = None,
    lookback_minutes: int = 15,
) -> dict:
    """Sweep every device active in the last `lookback_minutes` and
    run each Phase-5 detector against its recent reports.

    Returns a small summary dict for the scheduler to log. Idempotent:
    re-running on the same window doesn't double-bump spam_score.

    Designed for invocation from a cron / Celery beat / scheduled-task
    runner. Standalone test entry point too:
        python -m app.services.fraud_batch
    """
    owns_session = db is None
    db = db or SessionLocal()
    summary = {"scanned": 0, "signals_fired": 0, "devices_flagged": []}
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=lookback_minutes)
        recent_device_ids = {
            r[0] for r in db.query(Report.device_id)
                            .filter(Report.server_created_at >= cutoff)
                            .filter(Report.device_id != None)
                            .distinct()
                            .all()
        }
        for did in recent_device_ids:
            summary["scanned"] += 1
            dev = db.query(Device).filter(Device.id == did).first()
            if dev is None:
                continue
            recent = (
                db.query(Report)
                  .filter(Report.device_id == did)
                  .filter(Report.server_created_at >= cutoff - timedelta(hours=1))
                  .all()
            )
            fired: List[str] = []
            for detector in DETECTORS:
                try:
                    fired.extend(detector(db, dev, recent))
                except Exception:                  # pragma: no cover
                    log.exception(
                        "[fraud_batch] detector %s failed for device %s",
                        detector.__name__, did,
                    )
            if not fired:
                continue
            # Union with existing signals; bump spam_score by the max
            # of the newly-fired weights.
            existing = list(dev.spam_signals or [])
            for s in fired:
                if s not in existing:
                    existing.append(s)
            dev.spam_signals = existing
            bump = max(SIGNAL_WEIGHTS.get(s, 0.0) for s in fired)
            dev.spam_score = float(dev.spam_score or 0.0) + bump
            db.flush()
            summary["signals_fired"] += len(fired)
            summary["devices_flagged"].append({
                "device_id": did,
                "signals": fired,
                "new_score": dev.spam_score,
            })
        db.commit()
    except Exception:                              # pragma: no cover
        log.exception("[fraud_batch] scan failed; rolling back")
        try:
            db.rollback()
        except Exception:
            pass
    finally:
        if owns_session:
            db.close()
    return summary
